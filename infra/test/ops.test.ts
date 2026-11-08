// Operations (CAP-51, EP-09): log retention on every function, alarms on the alerts topic, the monthly AWS Budget and
// tag completeness across both stacks (ADR-002, CONVENTIONS § Cost rules / § AWS tagging).
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { LOG_RETENTION_DAYS, loadInstallationConfig, PROJECT_TAG_VALUE, USER_NAME_TAG_VALUE } from '../lib/config.js';
import { BUDGET_NOTIFICATIONS, BUDGET_TAG_FILTER, LAMBDA_ERRORS_PER_ALARM, OPS_ALARMS } from '../lib/ops.js';

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

const deployment = { installation: 'naeva', stage: 'dev' };
/** The committed naeva.dev target with the real api/src handlers, without running esbuild. */
const CONTEXT = { ...deployment, 'aws:cdk:bundling-stacks': [] };
const config = loadInstallationConfig(deployment);

let cached: { data: Template; api: Template } | undefined;
function templates() {
  if (!cached) {
    const built = buildApp(new App({ context: CONTEXT }));
    cached = { data: Template.fromStack(built.data), api: Template.fromStack(built.api) };
  }
  return cached;
}

type Resource = { Type: string; Properties?: Record<string, unknown> };
const resources = (t: Template) => Object.entries(t.toJSON().Resources as Record<string, Resource>);
const ref = (id: string) => ({ Ref: id });

describe('Operations', () => {
  it('[T-infra-032] every function keeps its logs ops.logRetentionDays (never "never expire"); ops is validated', () => {
    const days = config.ops.logRetentionDays;
    expect(days).toBe(30);
    for (const t of Object.values(templates())) {
      const all = resources(t);
      const logGroups = new Map(all.filter(([, r]) => r.Type === 'AWS::Logs::LogGroup'));
      const retained = all.filter(([, r]) => r.Type === 'Custom::LogRetention');
      for (const [id, fn] of all.filter(([, r]) => r.Type === 'AWS::Lambda::Function')) {
        // CDK's LogRetention handler sets its own log group to 1 day itself; it is the only exception.
        if (id.startsWith('LogRetention')) continue;
        const own = (fn.Properties?.LoggingConfig as { LogGroup?: { Ref: string } } | undefined)?.LogGroup?.Ref;
        if (own) {
          expect(logGroups.get(own)?.Properties?.RetentionInDays, id).toBe(days);
        } else {
          // A CDK provider Lambda: covered by a LogRetention on /aws/lambda/<its name>.
          const cover = retained.find(([, r]) => JSON.stringify(r.Properties?.LogGroupName).includes(`"Ref":"${id}"`));
          expect(cover?.[1].Properties?.RetentionInDays, id).toBe(days);
        }
      }
    }
    // The S3 auto-delete provider of dev is one of those covered Lambdas.
    expect(resources(templates().data).some(([, r]) => r.Type === 'Custom::LogRetention')).toBe(true);

    // Validation: required, positive budget, a retention CloudWatch accepts (never 9999 = INFINITE).
    expect(LOG_RETENTION_DAYS).toContain(30);
    expect(LOG_RETENTION_DAYS).not.toContain(9999);
    const dir = mkdtempSync(join(tmpdir(), 'cap-ops-'));
    const load = (ops?: unknown) => {
      writeFileSync(
        join(dir, 'naeva.dev.json'),
        JSON.stringify({ config_version: 'v', region: 'r', ai: config.ai, ...(ops !== undefined && { ops }) }),
      );
      return loadInstallationConfig(deployment, dir);
    };
    expect(load({ budgetEur: 7.5, logRetentionDays: 14, backupRetentionDays: 7 }).ops).toEqual({
      budgetEur: 7.5,
      logRetentionDays: 14,
      backupRetentionDays: 7,
    });
    expect(() => load()).toThrow(/"ops" is required/);
    for (const budgetEur of [0, -1, '10', Number.NaN]) {
      expect(() => load({ budgetEur, logRetentionDays: 30, backupRetentionDays: 35 }), String(budgetEur)).toThrow(
        /"ops\.budgetEur"/,
      );
    }
    for (const logRetentionDays of [0, 31, 9999, '30']) {
      expect(
        () => load({ budgetEur: 10, logRetentionDays, backupRetentionDays: 35 }),
        String(logRetentionDays),
      ).toThrow(/"ops\.logRetentionDays"/);
    }
  });

  it('[T-infra-033] alarms: API 5xx, Lambda errors, DynamoDB and authorizer throttles, thresholds as configured, all on the alerts topic', () => {
    const { api } = templates();
    const all = resources(api);
    const alarms = new Map(all.filter(([, r]) => r.Type === 'AWS::CloudWatch::Alarm'));
    const topic = all.find(([, r]) => r.Type === 'AWS::SNS::Topic')?.[0] ?? '';
    for (const [id, alarm] of alarms) {
      expect(alarm.Properties?.AlarmActions, id).toEqual([ref(topic)]);
      expect(alarm.Properties?.TreatMissingData, id).toBe('notBreaching');
    }
    const byPrefix = (prefix: string) => [...alarms].filter(([id]) => id.startsWith(prefix)).map(([, a]) => a);
    const one = (prefix: string) => {
      const found = byPrefix(prefix);
      expect(found, prefix).toHaveLength(1);
      return found[0]?.Properties ?? {};
    };
    const fiveMinutes = OPS_ALARMS.periodMinutes * 60;
    const gte = 'GreaterThanOrEqualToThreshold';

    const api5xx = one('Api5xxAlarm');
    expect(api5xx).toMatchObject({ Threshold: OPS_ALARMS.api5xx, ComparisonOperator: gte, MetricName: '5xx' });
    expect(api5xx).toMatchObject({ Namespace: 'AWS/ApiGateway', Statistic: 'Sum', Period: fiveMinutes });

    const authorizer = one('AuthorizerThrottlesAlarm');
    expect(authorizer).toMatchObject({ Threshold: OPS_ALARMS.authorizerThrottles, MetricName: 'Throttles' });
    expect(JSON.stringify(authorizer.Dimensions)).toMatch(/"Ref":"Authorizer[0-9A-F]{8}"/);

    const dynamo = one('DynamoThrottlesAlarm');
    expect(dynamo).toMatchObject({ Threshold: OPS_ALARMS.dynamoThrottles, ComparisonOperator: gte });
    const dynamoMetrics = JSON.stringify(dynamo.Metrics);
    for (const m of ['ReadThrottleEvents', 'WriteThrottleEvents']) expect(dynamoMetrics).toContain(`"${m}"`);

    // Lambda errors: every function is in exactly one alarm, at most LAMBDA_ERRORS_PER_ALARM per alarm.
    const fnIds = all.filter(([, r]) => r.Type === 'AWS::Lambda::Function').map(([id]) => id);
    const errorAlarms = byPrefix('LambdaErrorsAlarm');
    expect(errorAlarms).toHaveLength(Math.ceil(fnIds.length / LAMBDA_ERRORS_PER_ALARM));
    const covered: string[] = [];
    for (const a of errorAlarms) {
      expect(a.Properties).toMatchObject({ Threshold: OPS_ALARMS.lambdaErrors, ComparisonOperator: gte });
      const metrics = a.Properties?.Metrics as { Expression?: string; MetricStat?: unknown; ReturnData?: boolean }[];
      expect(metrics.find((m) => m.ReturnData !== false)?.Expression).toBe('MAX(METRICS())');
      const stats = metrics.filter((m) => m.MetricStat);
      expect(stats.length).toBeLessThanOrEqual(LAMBDA_ERRORS_PER_ALARM);
      for (const m of stats) {
        expect(JSON.stringify(m.MetricStat)).toContain('"MetricName":"Errors"');
        covered.push(...[...JSON.stringify(m.MetricStat).matchAll(/"Ref":"([A-Za-z0-9]+)"/g)].map((x) => x[1] ?? ''));
      }
    }
    expect(covered.sort()).toEqual([...fnIds].sort());
  });

  it('[T-infra-034] monthly budget: ops.budgetEur filtered by project=EIM_CAP, 80 % actual / 100 % forecast to the alert e-mail under HasAlertEmail', () => {
    const { api } = templates();
    const budgets = resources(api).filter(([, r]) => r.Type === 'AWS::Budgets::Budget');
    expect(budgets).toHaveLength(1);
    const props = budgets[0]?.[1].Properties ?? {};
    expect(props.Budget).toEqual({
      BudgetName: 'cap-naeva-dev-monthly',
      BudgetType: 'COST',
      TimeUnit: 'MONTHLY',
      BudgetLimit: { Amount: config.ops.budgetEur, Unit: 'USD' },
      CostFilters: { TagKeyValue: [BUDGET_TAG_FILTER] },
    });
    expect(BUDGET_TAG_FILTER).toBe('user:project$EIM_CAP');

    // Notifications exist only when the e-mail parameter is not `unset` (same condition as the alerts subscription).
    const conditional = props.NotificationsWithSubscribers as { 'Fn::If': [string, unknown[], unknown] };
    expect(conditional['Fn::If'][0]).toBe('HasAlertEmail');
    expect(conditional['Fn::If'][2]).toEqual(ref('AWS::NoValue'));
    expect(api.toJSON().Conditions).toHaveProperty('HasAlertEmail');
    const email = JSON.stringify(api.toJSON().Resources.AlertEmailSubscription.Properties.Endpoint);
    expect(conditional['Fn::If'][1]).toEqual(
      BUDGET_NOTIFICATIONS.map(({ notificationType, threshold }) => ({
        Notification: {
          NotificationType: notificationType,
          ComparisonOperator: 'GREATER_THAN',
          Threshold: threshold,
          ThresholdType: 'PERCENTAGE',
        },
        Subscribers: [{ SubscriptionType: 'EMAIL', Address: JSON.parse(email) as unknown }],
      })),
    );
    expect(BUDGET_NOTIFICATIONS).toEqual([
      { notificationType: 'ACTUAL', threshold: 80 },
      { notificationType: 'FORECASTED', threshold: 100 },
    ]);
  });

  it('[T-infra-035] tags: every taggable resource in both stacks carries project, UserName, installation, stage', () => {
    // CloudFormation types without a Tags property; anything else must carry the four tags.
    const NOT_TAGGABLE = new Set([
      'AWS::CDK::Metadata',
      'AWS::ApiGatewayV2::ApiMapping',
      'AWS::ApiGatewayV2::Authorizer',
      'AWS::ApiGatewayV2::Integration',
      'AWS::ApiGatewayV2::Route',
      'AWS::Backup::BackupSelection',
      'AWS::CloudFront::OriginAccessControl',
      'AWS::IAM::Policy',
      'AWS::Lambda::Permission',
      'AWS::S3::BucketPolicy',
      'AWS::SNS::Subscription',
    ]);
    const expected = {
      project: PROJECT_TAG_VALUE,
      UserName: USER_NAME_TAG_VALUE,
      installation: deployment.installation,
      stage: deployment.stage,
    };
    /**
     * Tags as a map, whatever the shape: `[{Key, Value}]`, `{key: value}` (SSM, API Gateway), Budget ResourceTags or
     * the Backup vault / plan's own property names (CAP-57).
     */
    const tagsOf = (r: Resource): Record<string, unknown> => {
      const p = r.Properties;
      const raw = p?.Tags ?? p?.ResourceTags ?? p?.BackupVaultTags ?? p?.BackupPlanTags;
      if (Array.isArray(raw)) {
        return Object.fromEntries(
          (raw as Record<string, unknown>[]).map((t) => [t.Key ?? t.key, t.Value ?? t.value] as const),
        );
      }
      return (raw ?? {}) as Record<string, unknown>;
    };
    let checked = 0;
    for (const t of Object.values(templates())) {
      for (const [id, r] of resources(t)) {
        if (NOT_TAGGABLE.has(r.Type) || r.Type.startsWith('Custom::')) continue;
        expect(tagsOf(r), `${r.Type} ${id}`).toMatchObject(expected);
        checked++;
      }
    }
    // Including the raw provider resources Tags.of does not reach (S3 auto-delete Handler + Role on dev).
    const providers = resources(templates().data).filter(
      ([id, r]) => id.startsWith('CustomS3AutoDeleteObjects') && !r.Type.startsWith('Custom::'),
    );
    expect(providers.map(([, r]) => r.Type).sort()).toEqual(['AWS::IAM::Role', 'AWS::Lambda::Function']);
    expect(checked).toBeGreaterThan(50);
  });
});
