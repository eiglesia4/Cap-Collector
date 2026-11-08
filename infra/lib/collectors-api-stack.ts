/**
 * CollectorsApi (ADR-002, CAP-15): API Gateway HTTP API with one Lambda per handler of api/src/handlers/, routed by the
 * manifest in routes.ts (kept identical to doc/spec/openapi.yaml by T-infra-016), behind a Lambda authorizer.
 *
 * - A route whose handler file does not exist yet is served by one shared 501 stub, so the whole contract is routable
 *   (and protected) from day one; context `requireAllHandlers=true` turns a missing handler into a synth error.
 * - The authorizer is api/src/auth/authorizer.ts once dev-api merges it (CAP-19); until then a deny-all stub.
 * - Least privilege per function from the manifest's `grants`; SSM-backed settings only where `secrets` says so.
 * - CORS allows `app_origins` from config/ plus the web origin. With `domains` in config (CAP-29) that origin is
 *   `https://<domains.web>` taken from config, with no import: CloudFormation refuses to change an export another
 *   stack imports, and CAP-29 changes `WebUrl`. Without `domains`, it is the CloudFront URL imported from the
 *   CollectorsData `WebUrl` output (CAP-27).
 * - Custom domain (CAP-29): with `domains.api`, a regional API Gateway domain name (ACM certificate ARN from SSM)
 *   mapped to the default stage; DNS is a GoDaddy CNAME to the `ApiDomainTarget` output.
 * - Bedrock (CAP-40, ADR-008 §7): only scans-analyse may invoke the model of config `ai.modelId`; a daily
 *   invocation alarm notifies the alerts topic (cost guard; e-mail from SSM, none while `unset`).
 * No VPC, no NAT, no always-on compute (CONVENTIONS § Cost rules); arm64, 256 MB, 10 s, JSON logs kept 30 days.
 */
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Annotations, CfnCondition, CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import {
  ApiMapping,
  type CfnStage,
  CorsHttpMethod,
  DomainName,
  HttpApi,
  HttpMethod,
  type IHttpRouteAuthorizer,
} from 'aws-cdk-lib/aws-apigatewayv2';
import { Certificate } from 'aws-cdk-lib/aws-certificatemanager';
import { HttpLambdaAuthorizer, HttpLambdaResponseType } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { Table } from 'aws-cdk-lib/aws-dynamodb';
import { Alarm, ComparisonOperator, Metric, TreatMissingData } from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Architecture, LoggingFormat, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import { LogGroup, RetentionDays } from 'aws-cdk-lib/aws-logs';
import type { Bucket } from 'aws-cdk-lib/aws-s3';
import { CfnSubscription, SubscriptionProtocol, Topic } from 'aws-cdk-lib/aws-sns';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

import {
  dataExportName,
  isDisposableStage,
  settingParameterName,
  UNSET_PARAMETER_VALUE,
} from './collectors-data-stack.js';
import {
  type Deployment,
  foundationModelId,
  type InstallationConfig,
  isInferenceProfile,
  resourceName,
} from './config.js';
import {
  AI_ENV,
  type AiEnvName,
  AUTHORIZER_SECRETS,
  type Route,
  ROUTES,
  SECRET_ENV,
  type SecretName,
} from './routes.js';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Repository root: the esbuild project root and the home of the single lockfile. */
export const REPO_ROOT = join(HERE, '..', '..');
const STUBS_DIR = join(HERE, 'stubs');

/** Per-function sizing (story CAP-15). */
export const FUNCTION_MEMORY_MB = 256;
export const FUNCTION_TIMEOUT_SECONDS = 10;
/** Cost guard for a one-user API: well above what two devices produce, low enough to cap a runaway client. */
export const THROTTLE = { rateLimit: 10, burstLimit: 20 } as const;
/** Cost guard (CAP-40): more Bedrock invocations than this in one day raises the alarm. */
export const BEDROCK_DAILY_INVOCATIONS_ALARM = 300;

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

/**
 * The web build's origin for API CORS: from config when `domains` is set (no `Fn::ImportValue`, so CollectorsData may
 * change its `WebUrl` export — decided in CAP-27 review, 2026-11-07), else imported from CollectorsData (CAP-27).
 */
export function webOrigin(deployment: Deployment, config: InstallationConfig): string {
  return config.domains ? `https://${config.domains.web}` : Fn.importValue(dataExportName(deployment, 'WebUrl'));
}

/**
 * ARNs `bedrock:InvokeModel` needs for a model id (CAP-40), built with formatArn (no literal ARN, account or region).
 * A plain model id → the foundation model in this stack's region. An inference profile id (`eu.…`) → the profile in
 * this account and region, plus the foundation model in every region the profile may route to (`*`).
 */
export function bedrockResources(stack: Stack, modelId: string): string[] {
  const model = (region: string) =>
    stack.formatArn({
      service: 'bedrock',
      region,
      account: '',
      resource: 'foundation-model',
      resourceName: foundationModelId(modelId),
    });
  if (!isInferenceProfile(modelId)) return [model(stack.region)];
  return [stack.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: modelId }), model('*')];
}

const pascal = (kebab: string) => kebab.replace(/(^|-)([a-z0-9])/g, (_m, _d: string, c: string) => c.toUpperCase());

export class CollectorsApiStack extends Stack {
  readonly api: HttpApi;
  /** Lambda per handler name (`not-implemented` and `authorizer` included when present). */
  readonly functions: ReadonlyMap<string, NodejsFunction>;
  /** The file bundled as the authorizer: api/src/auth/authorizer.ts when it exists, else the deny-all stub. */
  readonly authorizerEntry: string;
  /** `cap-<inst>-<stage>-alerts`: cost alarms (CAP-40). */
  readonly alertsTopic: Topic;
  /** API Gateway custom domain, only when config declares `domains.api` (CAP-29). */
  readonly domainName?: DomainName;

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

    // Config values a route asks for (CAP-40): plain env vars, synthesised from infra/config/*.json.
    const aiValues: Record<AiEnvName, string> = {
      bedrockModelId: config.ai.modelId,
      dhashThreshold: String(config.ai.dhashThreshold),
    };
    const configEnv = (names: readonly AiEnvName[] = []) =>
      Object.fromEntries(names.map((n) => [AI_ENV[n], aiValues[n]]));

    const lambda = (
      name: string,
      entry: string,
      env: Record<string, string>,
      sizing: { memoryMb?: number | undefined; timeoutSeconds?: number | undefined } = {},
    ) => {
      const logGroup = new LogGroup(this, `${pascal(name)}Logs`, {
        retention: RetentionDays.ONE_MONTH,
        removalPolicy,
      });
      const fn = new NodejsFunction(this, pascal(name), {
        entry,
        handler: 'handler',
        runtime: Runtime.NODEJS_22_X,
        architecture: Architecture.ARM_64,
        memorySize: sizing.memoryMb ?? FUNCTION_MEMORY_MB,
        timeout: Duration.seconds(sizing.timeoutSeconds ?? FUNCTION_TIMEOUT_SECONDS),
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
      corsPreflight: {
        allowOrigins: [...config.app_origins, webOrigin(deployment, config)],
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
        fn = lambda(
          route.handler,
          join(apiSrcDir, 'handlers', `${route.handler}.ts`),
          { ...secretEnv(route.secrets), ...configEnv(route.config) },
          { memoryMb: route.memoryMb, timeoutSeconds: route.timeoutSeconds },
        );
        this.grant(fn, route, table, imagesBucket, config.ai.modelId);
      }
      this.api.addRoutes({
        path: route.path,
        methods: [HttpMethod[route.method]],
        integration: new HttpLambdaIntegration(`${pascal(route.handler)}Integration`, fn),
        ...(route.auth && { authorizer }),
      });
    }
    this.functions = functions;

    // Custom domain (CAP-29): regional endpoint with the ACM certificate (same region as this stack) from SSM.
    const apiDomain = config.domains?.api;
    if (apiDomain) {
      const certificateArn = StringParameter.valueForStringParameter(
        this,
        settingParameterName(deployment, 'apiCertificateArn'),
      );
      this.domainName = new DomainName(this, 'ApiDomain', {
        domainName: apiDomain,
        certificate: Certificate.fromCertificateArn(this, 'ApiCertificate', certificateArn),
      });
      const defaultStage = this.api.defaultStage;
      if (!defaultStage) throw new Error('CollectorsApi: the HTTP API has no default stage to map the domain to');
      new ApiMapping(this, 'ApiMapping', { api: this.api, domainName: this.domainName, stage: defaultStage });
    }

    // Cost guard (CAP-40, EP-09 brought forward): Bedrock is the only variable cost (ADR-002), so a day with more
    // invocations than expected for one collector raises an alarm on the alerts topic.
    this.alertsTopic = new Topic(this, 'AlertsTopic', {
      topicName: resourceName(deployment, 'alerts'),
      displayName: `CapCollector ${deployment.installation}/${deployment.stage} alerts`,
    });
    // SPEC-GAP CAP-40: the story asks for "subscription only when the e-mail parameter is set (two synths)", but synth
    // cannot see an SSM value without credentials. The e-mail is resolved at deploy time instead and the subscription
    // carries a CloudFormation condition (value ≠ `unset`), so one template covers both cases.
    const alertEmail = StringParameter.valueForStringParameter(this, settingParameterName(deployment, 'alertEmail'));
    const hasAlertEmail = new CfnCondition(this, 'HasAlertEmail', {
      expression: Fn.conditionNot(Fn.conditionEquals(alertEmail, UNSET_PARAMETER_VALUE)),
    });
    const subscription = new CfnSubscription(this, 'AlertEmailSubscription', {
      topicArn: this.alertsTopic.topicArn,
      protocol: SubscriptionProtocol.EMAIL,
      endpoint: alertEmail,
    });
    subscription.cfnOptions.condition = hasAlertEmail;

    new Alarm(this, 'BedrockInvocationsAlarm', {
      alarmName: resourceName(deployment, 'bedrock-invocations'),
      alarmDescription:
        `More than ${BEDROCK_DAILY_INVOCATIONS_ALARM} Bedrock invocations of ${config.ai.modelId} in a day ` +
        '(cost guard, CAP-40)',
      metric: new Metric({
        namespace: 'AWS/Bedrock',
        metricName: 'Invocations',
        dimensionsMap: { ModelId: config.ai.modelId },
        statistic: 'Sum',
        period: Duration.days(1),
      }),
      threshold: BEDROCK_DAILY_INVOCATIONS_ALARM,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    }).addAlarmAction(new SnsAction(this.alertsTopic));

    const out = (key: string, value: string, description: string) =>
      new CfnOutput(this, key, { value, description, exportName: `${resourceName(deployment, 'api')}-${key}` });
    out(
      'ApiUrl',
      apiDomain ? `https://${apiDomain}` : this.api.apiEndpoint,
      'HTTP API base URL (VITE_API_URL for the app)',
    );
    out('ApiId', this.api.apiId, 'HTTP API id');
    if (apiDomain && this.domainName) {
      new CfnOutput(this, 'ApiDomainTarget', {
        value: this.domainName.regionalDomainName,
        description: `GoDaddy CNAME value for ${apiDomain}`,
      });
    }
  }

  private grant(fn: NodejsFunction, route: Route, table: Table, imagesBucket: Bucket, modelId: string): void {
    for (const g of route.grants) {
      if (g === 'table') table.grantReadWriteData(fn);
      else if (g === 'bedrock') {
        fn.addToRolePolicy(
          new PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: bedrockResources(this, modelId) }),
        );
      } else {
        const action = g === 'images-put' ? 's3:PutObject' : 's3:GetObject';
        fn.addToRolePolicy(new PolicyStatement({ actions: [action], resources: [imagesBucket.arnForObjects('*')] }));
      }
    }
  }
}
