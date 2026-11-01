// CollectorsApi stack (CAP-15): route manifest ⟷ openapi.yaml, handler wiring and stubs, authorizer, IAM, settings.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { App } from 'aws-cdk-lib';
import { Annotations, Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { buildApp } from '../lib/app.js';
import {
  CollectorsApiStack,
  FUNCTION_MEMORY_MB,
  FUNCTION_TIMEOUT_SECONDS,
  missingHandlers,
  REPO_ROOT,
  THROTTLE,
} from '../lib/collectors-api-stack.js';
import { CollectorsDataStack, settingParameterName, UNSET_PARAMETER_VALUE } from '../lib/collectors-data-stack.js';
import type { Deployment, InstallationConfig } from '../lib/config.js';
import { type Route, ROUTES, SECRET_ENV } from '../lib/routes.js';
import { handler as denyAll } from '../lib/stubs/authorizer-deny.js';
import { handler as notImplemented } from '../lib/stubs/not-implemented.js';

const ENV_KEYS = ['CDK_DEFAULT_ACCOUNT', 'CAP_ACCOUNT_NAEVA_DEV', 'CAP_INSTALLATION', 'CAP_STAGE'];
const saved: Record<string, string | undefined> = {};
beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const deployment: Deployment = { installation: 'naeva', stage: 'dev' };
const config: InstallationConfig = {
  config_version: 'test',
  region: 'test-region-1',
  app_origins: ['capacitor://localhost', 'http://localhost:5173'],
};
/** Unit tests never run esbuild: the stack is checked, not the bundles (CI `npm run synth` bundles for real). */
const NO_BUNDLING = { 'aws:cdk:bundling-stacks': [] };

// esbuild wants entries under the project root, so fixtures live in the git-ignored infra/cdk.out/.
const FIXTURES = join(REPO_ROOT, 'infra', 'cdk.out', 'test-fixtures');
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));

/** An api/src tree in a temp dir with only the given handler files (and optionally the real authorizer). */
function fakeApiSrc(handlers: readonly string[], withAuthorizer = false): string {
  mkdirSync(FIXTURES, { recursive: true });
  const src = mkdtempSync(join(FIXTURES, 'api-src-'));
  mkdirSync(join(src, 'handlers'));
  for (const h of handlers) writeFileSync(join(src, 'handlers', `${h}.ts`), 'export const handler = () => 0;\n');
  if (withAuthorizer) {
    mkdirSync(join(src, 'auth'));
    writeFileSync(join(src, 'auth', 'authorizer.ts'), 'export const handler = () => 0;\n');
  }
  return src;
}

function apiStack(opts: { apiSrcDir?: string; routes?: readonly Route[]; context?: Record<string, unknown> } = {}) {
  const app = new App({ context: { ...NO_BUNDLING, ...opts.context } });
  const data = new CollectorsDataStack(app, 'CollectorsData', { deployment, config });
  const api = new CollectorsApiStack(app, 'CollectorsApi', {
    deployment,
    config,
    table: data.table,
    imagesBucket: data.imagesBucket,
    ...(opts.apiSrcDir !== undefined && { apiSrcDir: opts.apiSrcDir }),
    ...(opts.routes !== undefined && { routes: opts.routes }),
  });
  return { data, api, template: Template.fromStack(api) };
}

type Resources = Record<string, { Type: string; Properties: Record<string, unknown> }>;
const stripHash = (logicalId: string) => logicalId.replace(/[0-9A-F]{8}$/, '');

/** A readable, hash-free view of the stack: route → function + auth, function sizing/env, IAM actions per function. */
function summarise(template: Template) {
  const res = template.toJSON().Resources as Resources;
  const ofType = (t: string) => Object.entries(res).filter(([, r]) => r.Type === t);
  const integrationTarget = new Map(
    ofType('AWS::ApiGatewayV2::Integration').map(([id, r]) => {
      const uri = r.Properties.IntegrationUri as { 'Fn::GetAtt': [string, string] };
      return [id, stripHash(uri['Fn::GetAtt'][0])];
    }),
  );
  const routes = Object.fromEntries(
    ofType('AWS::ApiGatewayV2::Route')
      .map(([, r]) => {
        const target = r.Properties.Target as { 'Fn::Join': [string, [string, { Ref: string }]] };
        const integration = target['Fn::Join'][1][1].Ref;
        return [
          r.Properties.RouteKey as string,
          `${integrationTarget.get(integration)} ${String(r.Properties.AuthorizationType)}`,
        ];
      })
      .sort(([a], [b]) => String(a).localeCompare(String(b))),
  );
  const functions = Object.fromEntries(
    ofType('AWS::Lambda::Function')
      .filter(([, r]) => r.Properties.Runtime === 'nodejs22.x')
      .map(([id, r]) => {
        const p = r.Properties as {
          MemorySize: number;
          Timeout: number;
          Architectures: string[];
          LoggingConfig: { LogFormat: string };
          Environment: { Variables: Record<string, unknown> };
        };
        return [
          stripHash(id),
          {
            memory: p.MemorySize,
            timeout: p.Timeout,
            arch: p.Architectures.join(','),
            logs: p.LoggingConfig.LogFormat,
            env: Object.keys(p.Environment.Variables).sort(),
          },
        ];
      }),
  );
  const policies = Object.fromEntries(
    ofType('AWS::IAM::Policy').map(([, r]) => {
      const roles = r.Properties.Roles as { Ref: string }[];
      const doc = r.Properties.PolicyDocument as { Statement: { Action: string | string[] }[] };
      const actions = doc.Statement.flatMap((s) => (Array.isArray(s.Action) ? s.Action : [s.Action])).sort();
      return [stripHash(roles[0]?.Ref ?? ''), actions];
    }),
  );
  return { routes, functions, policies };
}

describe('CollectorsApi stack', () => {
  it('[T-infra-016] route manifest equals openapi.yaml: same paths, methods and auth (public = /auth/* and /healthz)', () => {
    const spec = parse(readFileSync(join(REPO_ROOT, 'doc', 'spec', 'openapi.yaml'), 'utf8')) as {
      security?: unknown[];
      paths: Record<string, Record<string, { security?: unknown[] }>>;
    };
    const methods = new Set(['get', 'post', 'put', 'patch', 'delete']);
    const isPublic = (path: string) => path === '/healthz' || path.startsWith('/auth/');
    const fromSpec = Object.entries(spec.paths).flatMap(([path, item]) =>
      Object.entries(item)
        .filter(([m]) => methods.has(m))
        // An operation-level `security` wins; otherwise the rule stated in info.description.
        .map(
          ([m, op]) =>
            `${m.toUpperCase()} ${path} auth=${String(op.security ? op.security.length > 0 : !isPublic(path))}`,
        ),
    );
    const fromManifest = ROUTES.map((r) => `${r.method} ${r.path} auth=${String(r.auth)}`);
    expect([...fromManifest].sort()).toEqual([...fromSpec].sort());
    expect(spec.security).toEqual([{ bearer: [] }]);

    // Handler names are unique (one Lambda each) and kebab-case file names.
    const handlers = ROUTES.map((r) => r.handler);
    expect(new Set(handlers).size).toBe(handlers.length);
    for (const h of handlers) expect(h).toMatch(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/);
  });

  it('[T-infra-017] a manifest handler without a file is served by the 501 stub, or fails synth in strict mode', () => {
    const routes: Route[] = [
      { method: 'GET', path: '/healthz', handler: 'healthz', auth: false, grants: [] },
      { method: 'GET', path: '/caps', handler: 'caps-list', auth: true, grants: ['table'] },
      { method: 'POST', path: '/caps', handler: 'caps-create', auth: true, grants: ['table'] },
    ];
    const src = fakeApiSrc(['healthz', 'orphan-handler']);
    expect(missingHandlers(routes, src)).toEqual(['caps-list', 'caps-create']);

    // Strict mode (context requireAllHandlers=true): a clear synth error naming every missing file.
    expect(() => apiStack({ apiSrcDir: src, routes, context: { requireAllHandlers: 'true' } })).toThrow(
      /handlers without a file in api\/src\/handlers\/: caps-list, caps-create/,
    );

    // Default: both missing routes share ONE stub function; the stub gets no IAM grants; orphans are warned about.
    const { api, template } = apiStack({ apiSrcDir: src, routes });
    const s = summarise(template);
    expect(s.routes).toEqual({
      'GET /caps': 'NotImplemented CUSTOM',
      'GET /healthz': 'Healthz NONE',
      'POST /caps': 'NotImplemented CUSTOM',
    });
    expect([...api.functions.keys()].sort()).toEqual(['authorizer', 'healthz', 'not-implemented']);
    expect(Object.keys(s.policies)).not.toContain('NotImplementedServiceRole');
    Annotations.fromStack(api).hasWarning('*', Match.stringLikeRegexp('orphan-handler.ts has no route'));

    // The real authorizer replaces the deny-all stub as soon as api/src/auth/authorizer.ts exists.
    expect(api.authorizerEntry).toMatch(/infra\/lib\/stubs\/authorizer-deny\.ts$/);
    const withAuth = apiStack({ apiSrcDir: fakeApiSrc(['healthz'], true), routes: routes.slice(0, 1) });
    expect(withAuth.api.authorizerEntry).toMatch(/auth\/authorizer\.ts$/);

    // In the repo today: only healthz exists, so every other route is the stub — and strict mode would say so.
    const real = missingHandlers(ROUTES, join(REPO_ROOT, 'api', 'src'));
    expect(real).not.toContain('healthz');
    expect(real.length + 1).toBeLessThanOrEqual(ROUTES.length);
  });

  it('[T-infra-018] snapshot: functions sized and logged as specified, authorizer on every protected route, IAM scoped', () => {
    // A fixture with one handler per kind of grant, so the IAM shape is visible before dev-api merges them.
    const src = fakeApiSrc(['healthz', 'auth-apple', 'caps-get', 'caps-patch', 'uploads-create']);
    const { api, template } = apiStack({ apiSrcDir: src });
    const s = summarise(template);
    expect(s).toMatchSnapshot();

    // Every auth: true route carries the Lambda authorizer; public routes none.
    for (const route of ROUTES) {
      const key = `${route.method} ${route.path}`;
      expect(s.routes[key]?.endsWith(route.auth ? ' CUSTOM' : ' NONE')).toBe(true);
    }
    template.hasResourceProperties('AWS::ApiGatewayV2::Authorizer', {
      AuthorizerType: 'REQUEST',
      EnableSimpleResponses: true,
      IdentitySource: ['$request.header.Authorization'],
      AuthorizerResultTtlInSeconds: 300,
    });
    for (const fn of Object.values(s.functions)) {
      expect(fn).toMatchObject({
        memory: FUNCTION_MEMORY_MB,
        timeout: FUNCTION_TIMEOUT_SECONDS,
        arch: 'arm64',
        logs: 'JSON',
      });
    }
    template.allResourcesProperties('AWS::Logs::LogGroup', { RetentionInDays: 30 });

    // IAM: healthz nothing; uploads only s3:PutObject; caps-get table + s3:GetObject; caps-patch table, no S3.
    expect(s.policies).not.toHaveProperty('HealthzServiceRole');
    expect(s.policies.UploadsCreateServiceRole).toEqual(['s3:PutObject']);
    expect(s.policies.CapsGetServiceRole).toContain('s3:GetObject');
    expect(s.policies.CapsGetServiceRole).toContain('dynamodb:Query');
    expect(s.policies.CapsPatchServiceRole?.some((a) => a.startsWith('s3:'))).toBe(false);

    // Settings only where the manifest says so.
    expect(s.functions.AuthApple?.env).toEqual(expect.arrayContaining(Object.values(SECRET_ENV)));
    expect(s.functions.CapsGet?.env).not.toContain(SECRET_ENV.sessionSecret);
    expect(s.functions.Authorizer?.env).toContain(SECRET_ENV.sessionSecret);
    expect(s.functions.Authorizer?.env).not.toContain(SECRET_ENV.allowedAppleSubs);

    // CORS from app_origins, throttling, outputs.
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'HTTP',
      CorsConfiguration: Match.objectLike({ AllowOrigins: config.app_origins }),
    });
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      DefaultRouteSettings: { ThrottlingRateLimit: THROTTLE.rateLimit, ThrottlingBurstLimit: THROTTLE.burstLimit },
    });
    for (const key of ['ApiUrl', 'ApiId']) template.hasOutput(key, { Export: { Name: `cap-naeva-dev-api-${key}` } });
    // healthz, auth-apple, caps-get, caps-patch, uploads-create + authorizer + the 501 stub for everything else.
    expect(api.functions.size).toBe(7);
  });

  it('[T-infra-021] stubs: the placeholder answers 501 problem+json and the stub authorizer denies everything', async () => {
    const res = await notImplemented();
    expect(res.statusCode).toBe(501);
    expect(res.headers['content-type']).toBe('application/problem+json');
    expect(JSON.parse(res.body)).toMatchObject({ status: 501, title: 'Not Implemented' });
    expect(await denyAll()).toEqual({ isAuthorized: false });
  });

  it('[T-infra-022] settings: CollectorsData creates unset SSM parameters; the API reads them by name at deploy', () => {
    const { data, template } = apiStack({ apiSrcDir: fakeApiSrc(['healthz', 'auth-apple']) });
    const dataTemplate = Template.fromStack(data);
    for (const name of ['allowedAppleSubs', 'appleClientIds', 'sessionSecret'] as const) {
      dataTemplate.hasResourceProperties('AWS::SSM::Parameter', {
        Name: settingParameterName(deployment, name),
        Type: 'String',
        Value: UNSET_PARAMETER_VALUE,
      });
    }
    expect(settingParameterName(deployment, 'allowedAppleSubs')).toBe('/cap/naeva/dev/allowed-apple-subs');

    // The API stack takes them as SSM-typed CloudFormation parameters (re-resolved on every deploy).
    const params = template.toJSON().Parameters as Record<string, { Type: string; Default: string }>;
    const ssm = Object.values(params).filter(
      (p) => p.Type === 'AWS::SSM::Parameter::Value<String>' && p.Default.startsWith('/cap/'),
    );
    expect(ssm.map((p) => p.Default).sort()).toEqual(
      ['allowedAppleSubs', 'appleClientIds', 'sessionSecret']
        .map((n) => `/cap/naeva/dev/${n.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`)
        .sort(),
    );

    // The real app wires it the same way and deploys data first.
    const built = buildApp(new App({ context: { ...NO_BUNDLING, installation: 'naeva', stage: 'dev' } }));
    expect(built.api.dependencies).toContain(built.data);
  });
});
