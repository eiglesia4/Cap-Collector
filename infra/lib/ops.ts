/**
 * Operations (CAP-51, EP-09; ADR-002 ≈ 2–5 €/month, CONVENTIONS § Cost rules / § AWS tagging): the alarms that tell
 * Edu something is wrong, the monthly AWS Budget, and the two gaps CDK leaves in its own helper Lambdas — log groups
 * that never expire and no tags.
 *
 * Everything notifies the `cap-<inst>-<stage>-alerts` topic of CAP-40 (alarms) or the same e-mail (budget), and stays
 * silent while `/cap/<inst>/<stage>/alert-email` is `unset`. Thresholds live here, not in config: they describe a
 * one-user app, not a deployment. README § Operations has the "what fires when" table.
 */
import {
  Aws,
  type CfnCondition,
  CfnResource,
  CustomResourceProviderBase,
  Duration,
  Fn,
  type IAspect,
  type RemovalPolicy,
  type Stack,
} from 'aws-cdk-lib';
import type { HttpApi } from 'aws-cdk-lib/aws-apigatewayv2';
import { CfnBudget } from 'aws-cdk-lib/aws-budgets';
import { Alarm, ComparisonOperator, type IMetric, MathExpression, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import { LogRetention, type RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { ITopic } from 'aws-cdk-lib/aws-sns';
import type { IConstruct } from 'constructs';

import { type Deployment, PROJECT_TAG_VALUE, resourceName, TAG_KEYS } from './config.js';

/** Alarm thresholds (story CAP-51), all over a 5-minute window, `≥` the value. */
export const OPS_ALARMS = {
  periodMinutes: 5,
  /** API Gateway `5xx` sum. */
  api5xx: 5,
  /** `Errors` of any single function. */
  lambdaErrors: 3,
  /** DynamoDB read + write throttle events on the table. */
  dynamoThrottles: 1,
  /** `Throttles` of the authorizer function (every protected request goes through it). */
  authorizerThrottles: 1,
} as const;

/**
 * Lambda `Errors` are watched by metric-math alarms, `MAX(METRICS())` over at most this many functions each: a
 * metric-math alarm holds at most 10 metrics, and 9 keeps clear of that limit whether or not the expression counts.
 * Fewer alarms than one per function (story: "pick the cheaper in alarm count"); CloudWatch bills per metric either
 * way, and the alarm description lists the functions it covers.
 */
export const LAMBDA_ERRORS_PER_ALARM = 9;

/** Budget notifications (story CAP-51): 80 % of actual spend, 100 % of forecast spend. */
export const BUDGET_NOTIFICATIONS = [
  { notificationType: 'ACTUAL', threshold: 80 },
  { notificationType: 'FORECASTED', threshold: 100 },
] as const;

/** Cost-allocation tag filter of the budget: `user:project$EIM_CAP` (the tag must be activated in Billing once). */
export const BUDGET_TAG_FILTER = `user:${TAG_KEYS.project}$${PROJECT_TAG_VALUE}`;

const period = () => Duration.minutes(OPS_ALARMS.periodMinutes);

export interface OpsAlarmsProps {
  readonly deployment: Deployment;
  readonly topic: ITopic;
  readonly api: HttpApi;
  readonly table: Table;
  /** Every function of the stack, by handler name (authorizer included). */
  readonly functions: ReadonlyMap<string, IFunction>;
  readonly authorizer: IFunction;
}

/** The CAP-51 alarms, every one with `notBreaching` for missing data and the alerts topic as its action. */
export function addOpsAlarms(stack: Stack, props: OpsAlarmsProps): Alarm[] {
  const { deployment, topic } = props;
  const action = new SnsAction(topic);
  const alarm = (id: string, name: string, description: string, metric: IMetric, threshold: number) => {
    const a = new Alarm(stack, id, {
      alarmName: resourceName(deployment, name),
      alarmDescription: `${description} (CAP-51, README § Operations)`,
      metric,
      threshold,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
    a.addAlarmAction(action);
    return a;
  };

  const alarms = [
    alarm(
      'Api5xxAlarm',
      'api-5xx',
      `HTTP API answered ${OPS_ALARMS.api5xx}+ 5xx in ${OPS_ALARMS.periodMinutes} min`,
      props.api.metricServerError({ period: period(), statistic: 'Sum' }),
      OPS_ALARMS.api5xx,
    ),
    alarm(
      'AuthorizerThrottlesAlarm',
      'authorizer-throttles',
      `The authorizer was throttled in the last ${OPS_ALARMS.periodMinutes} min`,
      props.authorizer.metricThrottles({ period: period(), statistic: 'Sum' }),
      OPS_ALARMS.authorizerThrottles,
    ),
    alarm(
      'DynamoThrottlesAlarm',
      'dynamodb-throttles',
      `DynamoDB throttled reads or writes on the table in the last ${OPS_ALARMS.periodMinutes} min`,
      new MathExpression({
        expression: 'FILL(r, 0) + FILL(w, 0)',
        usingMetrics: {
          r: props.table.metric('ReadThrottleEvents', { statistic: 'Sum' }),
          w: props.table.metric('WriteThrottleEvents', { statistic: 'Sum' }),
        },
        period: period(),
        label: 'Read + write throttle events',
      }),
      OPS_ALARMS.dynamoThrottles,
    ),
  ];

  const names = [...props.functions.keys()].sort();
  for (let i = 0; i < names.length; i += LAMBDA_ERRORS_PER_ALARM) {
    const chunk = names.slice(i, i + LAMBDA_ERRORS_PER_ALARM);
    const group = i / LAMBDA_ERRORS_PER_ALARM + 1;
    const usingMetrics = Object.fromEntries(
      chunk.map((name, j) => [
        `e${j}`,
        // Present by construction: names come from the map's own keys.
        (props.functions.get(name) as IFunction).metricErrors({ statistic: 'Sum' }),
      ]),
    );
    alarms.push(
      alarm(
        `LambdaErrorsAlarm${group}`,
        `lambda-errors-${group}`,
        `A function had ${OPS_ALARMS.lambdaErrors}+ errors in ${OPS_ALARMS.periodMinutes} min: ${chunk.join(', ')}`,
        new MathExpression({
          expression: 'MAX(METRICS())',
          usingMetrics,
          period: period(),
          label: 'Errors of the busiest function',
        }),
        OPS_ALARMS.lambdaErrors,
      ),
    );
  }
  return alarms;
}

export interface MonthlyBudgetProps {
  readonly deployment: Deployment;
  /** `ops.budgetEur` from config; the Budgets API only takes USD (config README: 1 EUR ≈ 1 USD on purpose). */
  readonly budgetEur: number;
  /** `/cap/<inst>/<stage>/alert-email`, resolved at deploy time. */
  readonly alertEmail: string;
  /** CAP-40's `HasAlertEmail`: the notifications exist only when the e-mail is not `unset`. */
  readonly hasAlertEmail: CfnCondition;
  /** The mandatory tags (CONVENTIONS § AWS tagging): `CfnBudget` is not taggable by `Tags.of`, so they go in here. */
  readonly tags: Readonly<Record<string, string>>;
}

/** Monthly cost budget filtered by `project=EIM_CAP`, e-mail at 80 % actual / 100 % forecast. */
export function addMonthlyBudget(stack: Stack, props: MonthlyBudgetProps): CfnBudget {
  // Raw CloudFormation casing: values inside Fn.conditionIf are not converted by the L1 (synth validation catches it).
  const notifications = BUDGET_NOTIFICATIONS.map(({ notificationType, threshold }) => ({
    Notification: {
      NotificationType: notificationType,
      ComparisonOperator: 'GREATER_THAN',
      Threshold: threshold,
      ThresholdType: 'PERCENTAGE',
    },
    Subscribers: [{ SubscriptionType: 'EMAIL', Address: props.alertEmail }],
  }));
  return new CfnBudget(stack, 'MonthlyBudget', {
    budget: {
      budgetName: resourceName(props.deployment, 'monthly'),
      budgetType: 'COST',
      timeUnit: 'MONTHLY',
      budgetLimit: { amount: props.budgetEur, unit: 'USD' },
      costFilters: { TagKeyValue: [BUDGET_TAG_FILTER] },
    },
    // Same pattern as the alerts subscription (SPEC-GAP CAP-40): one template, decided at deploy time.
    notificationsWithSubscribers: Fn.conditionIf(props.hasAlertEmail.logicalId, notifications, Aws.NO_VALUE),
    resourceTags: Object.entries(props.tags).map(([key, value]) => ({ key, value })),
  });
}

/** The raw `Handler` and `Role` resources of a CDK custom-resource provider (e.g. S3 auto-delete on `dev`). */
function providerResources(provider: CustomResourceProviderBase): CfnResource[] {
  return provider.node.children.filter(
    (c): c is CfnResource =>
      CfnResource.isCfnResource(c) && ['AWS::Lambda::Function', 'AWS::IAM::Role'].includes(c.cfnResourceType),
  );
}

/**
 * Log retention for the Lambdas CDK creates itself (custom-resource providers), whose `/aws/lambda/<name>` group is
 * otherwise created on first run with no expiry. A `LogRetention` resource, not a `LogGroup`: on a stack already
 * deployed the group exists, and CloudFormation cannot create it again. Call at the end of a stack's constructor.
 */
export function retainProviderLogs(stack: Stack, retention: RetentionDays, removalPolicy: RemovalPolicy): void {
  const providers = stack.node.findAll().filter((c) => c instanceof CustomResourceProviderBase);
  for (const provider of providers) {
    const handler = providerResources(provider).find((r) => r.cfnResourceType === 'AWS::Lambda::Function');
    if (!handler) continue;
    new LogRetention(stack, `${provider.node.id}LogRetention`, {
      logGroupName: Fn.join('', ['/aws/lambda/', handler.ref]),
      retention,
      removalPolicy,
    });
  }
}

/**
 * Tags on the provider resources (CONVENTIONS § AWS tagging): they are raw `CfnResource`s, which `Tags.of(app)` does
 * not reach. Added in app.ts next to the app-level tags, with the same values.
 */
export class TagCdkProviders implements IAspect {
  constructor(private readonly tags: Readonly<Record<string, string>>) {}

  visit(node: IConstruct): void {
    if (!(node instanceof CustomResourceProviderBase)) return;
    const tags = Object.entries(this.tags).map(([Key, Value]) => ({ Key, Value }));
    for (const resource of providerResources(node)) resource.addPropertyOverride('Tags', tags);
  }
}
