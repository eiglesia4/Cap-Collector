// Infra for scans (CAP-40): Bedrock grant on the configured model only, ai config as env, scans-analyse sizing,
// ai config validation, and the Bedrock cost alarm on the alerts topic (ADR-002, ADR-004, ADR-008 §7).
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ROUTES as CONTRACT_ROUTES } from '@capcollector/shared';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, it } from 'vitest';

import {
  BEDROCK_DAILY_INVOCATIONS_ALARM,
  CollectorsApiStack,
  FUNCTION_MEMORY_MB,
  FUNCTION_TIMEOUT_SECONDS,
  REPO_ROOT,
} from '../lib/collectors-api-stack.js';
import { CollectorsDataStack, UNSET_PARAMETER_VALUE } from '../lib/collectors-data-stack.js';
import {
  foundationModelId,
  type InstallationConfig,
  isInferenceProfile,
  loadInstallationConfig,
} from '../lib/config.js';
import { AI_ENV } from '../lib/routes.js';

const deployment = { installation: 'naeva', stage: 'dev' };
const NO_BUNDLING = { 'aws:cdk:bundling-stacks': [] };
const PLAIN_MODEL = 'anthropic.claude-haiku-test-v1:0';
const PROFILE_MODEL = `eu.${PLAIN_MODEL}`;

const configWith = (modelId: string): InstallationConfig => ({
  config_version: 'test',
  region: 'test-region-1',
  app_origins: [],
  ai: { modelId, dhashThreshold: 10 },
  ops: { budgetEur: 10, logRetentionDays: 30, backupRetentionDays: 35 },
});

// esbuild wants entries under the project root, so fixtures live in the git-ignored infra/cdk.out/ — in a directory
// of their own: api-stack.test.ts removes `test-fixtures/` in its afterAll while this file may still be running.
const FIXTURES = join(REPO_ROOT, 'infra', 'cdk.out', 'test-fixtures-scans');
afterAll(() => rmSync(FIXTURES, { recursive: true, force: true }));

/** An api/src tree with a file for every contract handler, so every route gets its own function and grants. */
function fullApiSrc(): string {
  mkdirSync(FIXTURES, { recursive: true });
  const src = mkdtempSync(join(FIXTURES, 'scans-src-'));
  mkdirSync(join(src, 'handlers'));
  for (const { handler } of CONTRACT_ROUTES) {
    writeFileSync(join(src, 'handlers', `${handler}.ts`), 'export const handler = () => 0;\n');
  }
  return src;
}

function synth(modelId: string = PLAIN_MODEL) {
  const app = new App({ context: NO_BUNDLING });
  const config = configWith(modelId);
  const env = { region: config.region };
  const data = new CollectorsDataStack(app, 'CollectorsData', { env, deployment, config });
  const api = new CollectorsApiStack(app, 'CollectorsApi', {
    env,
    deployment,
    config,
    table: data.table,
    imagesBucket: data.imagesBucket,
    apiSrcDir: fullApiSrc(),
  });
  return { data: Template.fromStack(data), api: Template.fromStack(api) };
}

type Statement = { Action: string | string[]; Resource: unknown };
/** Bedrock statements per role logical id (`<Function>ServiceRole…`). */
function bedrockStatements(api: Template): Map<string, Statement[]> {
  const out = new Map<string, Statement[]>();
  for (const policy of Object.values(api.findResources('AWS::IAM::Policy'))) {
    const props = policy.Properties as { Roles: { Ref: string }[]; PolicyDocument: { Statement: Statement[] } };
    const bedrock = props.PolicyDocument.Statement.filter((s) =>
      [s.Action].flat().some((a) => a.startsWith('bedrock:')),
    );
    if (bedrock.length > 0) out.set(props.Roles[0]?.Ref ?? '', bedrock);
  }
  return out;
}

/** Lambda functions keyed by logical id prefix (`ScansAnalyse`, `CapsGet`…). */
function functions(api: Template): Map<string, { MemorySize: number; Timeout: number; env: Record<string, unknown> }> {
  const out = new Map<string, { MemorySize: number; Timeout: number; env: Record<string, unknown> }>();
  for (const [id, fn] of Object.entries(api.findResources('AWS::Lambda::Function'))) {
    const p = fn.Properties as {
      MemorySize: number;
      Timeout: number;
      Environment?: { Variables?: Record<string, unknown> };
    };
    out.set(id.replace(/[0-9A-F]{8}$/, ''), {
      MemorySize: p.MemorySize,
      Timeout: p.Timeout,
      env: p.Environment?.Variables ?? {},
    });
  }
  return out;
}

describe('scans infra (CAP-40)', () => {
  it('[T-infra-028] only scans-analyse may call Bedrock, and only InvokeModel on the configured model', () => {
    // Plain model id: the foundation model in the stack's region, nothing else.
    const plain = bedrockStatements(synth(PLAIN_MODEL).api);
    expect([...plain.keys()].map((role) => role.replace(/ServiceRole.*$/, ''))).toEqual(['ScansAnalyse']);
    const [plainStatement] = [...plain.values()][0] ?? [];
    expect(plainStatement?.Action).toBe('bedrock:InvokeModel');
    const plainArn = JSON.stringify(plainStatement?.Resource);
    expect(plainArn).toContain(`:bedrock:test-region-1::foundation-model/${PLAIN_MODEL}`);
    expect(plainArn).not.toContain('inference-profile');

    // Inference profile id: the profile in this account/region plus the routed foundation model in any region.
    const profile = bedrockStatements(synth(PROFILE_MODEL).api);
    expect(profile.size).toBe(1);
    const [profileStatement] = [...profile.values()][0] ?? [];
    expect(profileStatement?.Action).toBe('bedrock:InvokeModel');
    const resources = JSON.stringify(profileStatement?.Resource);
    expect(resources).toContain(`:bedrock:test-region-1:`);
    expect(resources).toContain(`:inference-profile/${PROFILE_MODEL}`);
    expect(resources).toContain(`:bedrock:*::foundation-model/${PLAIN_MODEL}`);
    // Never a literal account: the profile ARN uses the AWS::AccountId pseudo parameter.
    expect(resources).toContain('AWS::AccountId');

    expect(isInferenceProfile(PROFILE_MODEL)).toBe(true);
    expect(isInferenceProfile(PLAIN_MODEL)).toBe(false);
    expect(foundationModelId(PROFILE_MODEL)).toBe(PLAIN_MODEL);
  });

  it('[T-infra-029] scans-analyse gets the ai config as env and 1024 MB / 20 s; other functions keep the defaults', () => {
    const fns = functions(synth().api);
    const scans = fns.get('ScansAnalyse');
    expect(scans).toMatchObject({ MemorySize: 1024, Timeout: 20 });
    expect(scans?.env).toMatchObject({
      [AI_ENV.bedrockModelId]: PLAIN_MODEL,
      [AI_ENV.dhashThreshold]: '10',
    });
    // scans-analyse also reads the photos (images-get) and the stored hashes (table).
    expect(scans?.env).toHaveProperty('CAP_IMAGES_BUCKET');

    for (const [name, fn] of fns) {
      if (name === 'ScansAnalyse') continue;
      expect(fn, name).toMatchObject({ MemorySize: FUNCTION_MEMORY_MB, Timeout: FUNCTION_TIMEOUT_SECONDS });
      expect(Object.keys(fn.env), name).not.toContain(AI_ENV.bedrockModelId);
      expect(Object.keys(fn.env), name).not.toContain(AI_ENV.dhashThreshold);
    }
  });

  it('[T-infra-030] config: ai is required, modelId a bare model or profile id (never an ARN), threshold 0..64', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-ai-'));
    const load = (ai?: unknown) => {
      writeFileSync(
        join(dir, 'naeva.dev.json'),
        JSON.stringify({
          config_version: 'v',
          region: 'r',
          ops: { budgetEur: 1, logRetentionDays: 1, backupRetentionDays: 1 },
          ...(ai !== undefined && { ai }),
        }),
      );
      return loadInstallationConfig(deployment, dir);
    };
    expect(load({ modelId: PROFILE_MODEL, dhashThreshold: 10 }).ai).toEqual({
      modelId: PROFILE_MODEL,
      dhashThreshold: 10,
    });
    expect(load({ modelId: PLAIN_MODEL, dhashThreshold: 0 }).ai.dhashThreshold).toBe(0);
    expect(load({ modelId: PLAIN_MODEL, dhashThreshold: 64 }).ai.dhashThreshold).toBe(64);

    expect(() => load()).toThrow(/"ai" is required/);
    expect(() => load('haiku')).toThrow(/"ai" is required/);
    for (const modelId of [
      undefined,
      '',
      'haiku',
      'arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-test-v1:0',
      'Anthropic.Claude',
    ]) {
      expect(() => load({ modelId, dhashThreshold: 10 }), String(modelId)).toThrow(/"ai\.modelId" must be/);
    }
    for (const dhashThreshold of [undefined, -1, 65, 2.5, '10']) {
      expect(() => load({ modelId: PLAIN_MODEL, dhashThreshold }), String(dhashThreshold)).toThrow(
        /"ai\.dhashThreshold" must be an integer from 0 to 64/,
      );
    }

    // The committed naeva.dev target: an EU inference profile of a Haiku-class model, threshold 10 (ADR-004).
    const committed = loadInstallationConfig(deployment).ai;
    expect(committed.dhashThreshold).toBe(10);
    expect(committed.modelId).toMatch(/^eu\.anthropic\.claude-.*haiku/);
  });

  it('[T-infra-031] cost guard: daily Bedrock invocations alarm → alerts topic; e-mail subscribed only when set', () => {
    const { data, api } = synth();

    api.hasResourceProperties('AWS::SNS::Topic', { TopicName: 'cap-naeva-dev-alerts' });
    const topicId = Object.keys(api.findResources('AWS::SNS::Topic'))[0];
    api.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'cap-naeva-dev-bedrock-invocations',
      Namespace: 'AWS/Bedrock',
      MetricName: 'Invocations',
      Dimensions: [{ Name: 'ModelId', Value: PLAIN_MODEL }],
      Statistic: 'Sum',
      Period: 86400,
      EvaluationPeriods: 1,
      Threshold: BEDROCK_DAILY_INVOCATIONS_ALARM,
      ComparisonOperator: 'GreaterThanThreshold',
      TreatMissingData: 'notBreaching',
      AlarmActions: [{ Ref: topicId }],
    });
    expect(BEDROCK_DAILY_INVOCATIONS_ALARM).toBe(300);

    // The e-mail lives in SSM (created `unset` by CollectorsData) and is resolved at deploy time; the subscription
    // exists only under the condition "value ≠ unset" — i.e. without an e-mail, topic and alarm but no subscription.
    data.hasResourceProperties('AWS::SSM::Parameter', {
      Name: '/cap/naeva/dev/alert-email',
      Value: UNSET_PARAMETER_VALUE,
    });
    const params = api.toJSON().Parameters as Record<string, { Default?: string }>;
    const emailParam = Object.keys(params).find((k) => params[k]?.Default === '/cap/naeva/dev/alert-email');
    expect(emailParam).toBeDefined();
    api.hasCondition('HasAlertEmail', {
      'Fn::Not': [{ 'Fn::Equals': [{ Ref: emailParam }, UNSET_PARAMETER_VALUE] }],
    });
    const subs = api.findResources('AWS::SNS::Subscription');
    expect(Object.values(subs)).toHaveLength(1);
    expect(Object.values(subs)[0]).toMatchObject({
      Condition: 'HasAlertEmail',
      Properties: { Protocol: 'email', Endpoint: { Ref: emailParam }, TopicArn: { Ref: topicId } },
    });

    // No function receives the e-mail.
    for (const [name, fn] of functions(api)) {
      expect(JSON.stringify(fn.env), name).not.toContain(String(emailParam));
    }
  });
});
