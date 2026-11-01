/**
 * CollectorsApi (ADR-002, CAP-15): API Gateway HTTP API with one Lambda per handler of api/src/handlers/, routed by the
 * manifest in routes.ts (kept identical to doc/spec/openapi.yaml by T-infra-016), behind a Lambda authorizer.
 *
 * - A route whose handler file does not exist yet is served by one shared 501 stub, so the whole contract is routable
 *   (and protected) from day one; context `requireAllHandlers=true` turns a missing handler into a synth error.
 * - The authorizer is api/src/auth/authorizer.ts once dev-api merges it (CAP-19); until then a deny-all stub.
 * - Least privilege per function from the manifest's `grants`; SSM-backed settings only where `secrets` says so.
 * No VPC, no NAT, no always-on compute (CONVENTIONS § Cost rules); arm64, 256 MB, 10 s, JSON logs kept 30 days.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Annotations, CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  type CfnStage,
  CorsHttpMethod,
  HttpApi,
  HttpMethod,
  type IHttpRouteAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, LoggingFormat, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import { isDisposableStage, settingParameterName } from './collectors-data-stack.js';
import { type Deployment, type InstallationConfig, resourceName } from './config.js';
import { AUTHORIZER_SECRETS, type Route, ROUTES, SECRET_ENV, type SecretName } from './routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root: the esbuild project root and the home of the single lockfile. */
export const REPO_ROOT = join(HERE, '..', '..');
const STUBS_DIR = join(HERE, 'stubs');

/** Per-function sizing (story CAP-15). */
export const FUNCTION_MEMORY_MB = 256;
export const FUNCTION_TIMEOUT_SECONDS = 10;
/** Cost guard for a one-user API: well above what two devices produce, low enough to cap a runaway client. */
export const THROTTLE = { rateLimit: 10, burstLimit: 20 } as const;

export type CollectorsApiStackProps = StackProps & {
  readonly deployment: Deployment;
  readonly config: InstallationConfig;
  readonly table: Table;
  readonly imagesBucket: Bucket;
  /** Where the API sources live; tests point it at a fixture. Defaults to `<repo>/api/src`. */
  readonly apiSrcDir?: string;
  /** Defaults to ROUTES; tests pass smaller manifests. */
  readonly routes?: readonly Route[];
};

/** Handler files the manifest names but api/src/handlers/ does not have yet. */
export function missingHandlers(routes: readonly Route[], apiSrcDir: string): string[] {
  return routes.map((r) => r.handler).filter((h) => !existsSync(join(apiSrcDir, 'handlers', `${h}.ts`)));
}

/** Handler files in api/src/handlers/ that no route points to (they would never be deployed). */
export function orphanHandlers(routes: readonly Route[], apiSrcDir: string): string[] {
  const dir = join(apiSrcDir, 'handlers');
  if (!existsSync(dir)) return [];
  const known = new Set(routes.map((r) => r.handler));
  return readdirSync(dir)
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts') && !f.endsWith('.test.ts'))
    .map((f) => f.slice(0, -'.ts'.length))
    .filter((h) => !known.has(h));
}

const pascal = (kebab: string) => kebab.replace(/(^|-)([a-z0-9])/g, (_m, _d: string, c: string) => c.toUpperCase());

export class CollectorsApiStack extends Stack {
  readonly api: HttpApi;
  /** Lambda per handler name (`not-implemented` and `authorizer` included when present). */
  readonly functions: ReadonlyMap<string, NodejsFunction>;
  /** The file bundled as the authorizer: api/src/auth/authorizer.ts when it exists, else the deny-all stub. */
  readonly authorizerEntry: string;

  constructor(scope: Construct, id: string, props: CollectorsApiStackProps) {
    super(scope, id, props);
    const { deployment, config, table, imagesBucket } = props;
    const routes = props.routes ?? ROUTES;
    const apiSrcDir = props.apiSrcDir ?? join(REPO_ROOT, 'api', 'src');
    const removalPolicy = isDisposableStage(deployment) ? RemovalPolicy.DESTROY : RemovalPolicy.RETAIN;
    const functions = new Map<string, NodejsFunction>();

    const missing = missingHandlers(routes, apiSrcDir);
    const strict: unknown = this.node.tryGetContext('requireAllHandlers');
    if (missing.length > 0 && (strict === true || strict === 'true')) {
      throw new Error(
        `CollectorsApi: routes.ts names handlers without a file in api/src/handlers/: ${missing.join(', ')}. ` +
          'Merge the handler or remove the route (openapi.yaml decides which).',
      );
    }
    if (missing.length > 0) {
      Annotations.of(this).addInfo(`Served by the 501 stub until merged: ${missing.join(', ')}`);
    }
    for (const orphan of orphanHandlers(routes, apiSrcDir)) {
      Annotations.of(this).addWarning(`api/src/handlers/${orphan}.ts has no route in infra/lib/routes.ts`);
    }

    const baseEnv = {
      CAP_STAGE: deployment.stage,
      CAP_TABLE_NAME: table.tableName,
      CAP_IMAGES_BUCKET: imagesBucket.bucketName,
    };
    // Resolved by CloudFormation on every deploy from the parameters CollectorsData created (Edu fills them).
    const secretEnv = (names: readonly SecretName[] = []) =>
      Object.fromEntries(
        names.map((n) => [
          SECRET_ENV[n],
          StringParameter.valueForStringParameter(this, settingParameterName(deployment, n)),
        ]),
      );

    const lambda = (name: string, entry: string, env: Record<string, string>) => {
      const logGroup = new LogGroup(this, `${pascal(name)}Logs`, {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy,
      });
      const fn = new NodejsFunction(this, pascal(name), {
        entry,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: FUNCTION_MEMORY_MB,
        timeout: Duration.seconds(FUNCTION_TIMEOUT_SECONDS),
        loggingFormat: LoggingFormat.JSON,
        logGroup,
        projectRoot: REPO_ROOT,
        depsLockFilePath: join(REPO_ROOT, 'package-lock.json'),
        environment: { ...baseEnv, ...env, NODE_OPTIONS: '--enable-source-maps' },
        bundling: {
          format: OutputFormat.ESM,
          target: 'node22',
          mainFields: ['module', 'main'],
          // Bundle the AWS SDK too: the version in package-lock.json is the one that runs (`@capcollector/shared` too).
          externalModules: [],
          minify: true,
          sourceMap: true,
          banner: "import { createRequire } from 'module'; const require = createRequire(import.meta.url);",
        },
      });
      functions.set(name, fn);
      return fn;
    };

    // Authorizer (simple response). Identity source = Authorization header with caching on: API Gateway answers 401
    // itself when the header is missing, without invoking the function.
    const realAuthorizer = join(apiSrcDir, 'auth', 'authorizer.ts');
    this.authorizerEntry = existsSync(realAuthorizer) ? realAuthorizer : join(STUBS_DIR, 'authorizer-deny.ts');
    const authorizerFn = lambda('authorizer', this.authorizerEntry, secretEnv(AUTHORIZER_SECRETS));
    const authorizer: IHttpRouteAuthorizer = new HttpLambdaAuthorizer('SessionAuthorizer', authorizerFn, {
      responseTypes: [HttpLambdaResponseType.SIMPLE],
      identitySource: ['$request.header.Authorization'],
      resultsCacheTtl: Duration.minutes(5),
    });

    this.api = new HttpApi(this, 'HttpApi', {
      apiName: resourceName(deployment, 'api'),
      description: 'CapCollector HTTP API (doc/spec/openapi.yaml)',
      ...(config.app_origins.length > 0 && {
        corsPreflight: {
          allowOrigins: [...config.app_origins],
          allowMethods: [
            CorsHttpMethod.GET,
            CorsHttpMethod.POST,
            CorsHttpMethod.PUT,
            CorsHttpMethod.PATCH,
            CorsHttpMethod.DELETE,
          ],
          allowHeaders: ['authorization', 'content-type'],
          maxAge: Duration.days(1),
        },
      }),
    });
    const stage = this.api.defaultStage?.node.defaultChild as CfnStage | undefined;
    stage?.addPropertyOverride('DefaultRouteSettings', {
      ThrottlingRateLimit: THROTTLE.rateLimit,
      ThrottlingBurstLimit: THROTTLE.burstLimit,
    });

    let notImplemented: NodejsFunction | undefined;
    for (const route of routes) {
      let fn: NodejsFunction;
      if (missing.includes(route.handler)) {
        notImplemented ??= lambda('not-implemented', join(STUBS_DIR, 'not-implemented.ts'), {});
        fn = notImplemented;
      } else {
        fn = lambda(route.handler, join(apiSrcDir, 'handlers', `${route.handler}.ts`), secretEnv(route.secrets));
        this.grant(fn, route, table, imagesBucket);
      }
      this.api.addRoutes({
        path: route.path,
        methods: [HttpMethod[route.method]],
        integration: new HttpLambdaIntegration(`${pascal(route.handler)}Integration`, fn),
        ...(route.auth && { authorizer }),
      });
    }
    this.functions = functions;

    const out = (key: string, value: string, description: string) =>
      new CfnOutput(this, key, { value, description, exportName: `${resourceName(deployment, 'api')}-${key}` });
    out('ApiUrl', this.api.apiEndpoint, 'HTTP API base URL (VITE_API_URL for the app)');
    out('ApiId', this.api.apiId, 'HTTP API id');
  }

  private grant(fn: NodejsFunction, route: Route, table: Table, imagesBucket: Bucket): void {
    for (const g of route.grants) {
      if (g === 'table') table.grantReadWriteData(fn);
      else {
        const action = g === 'images-put' ? 's3:PutObject' : 's3:GetObject';
        fn.addToRolePolicy(new PolicyStatement({ actions: [action], resources: [imagesBucket.arnForObjects('*')] }));
      }
    }
  }
}
