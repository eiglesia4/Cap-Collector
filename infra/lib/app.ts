/**
 * Composition of the CDK app, separate from bin/app.ts so tests synthesize exactly what the CLI does.
 * Order: resolve deployment → require its config file (+ domains switch) → account guard → stacks → app-level tags.
 */
import { App, Aspects, Tags } from 'aws-cdk-lib';

import {
  applyDomainsSwitch,
  assertAccountMatchesDeployment,
  type Deployment,
  deploymentTags,
  loadInstallationConfig,
  resolveDeployment,
  resourceName,
} from './config.js';
import { CollectorsDataStack } from './collectors-data-stack.js';
import { CollectorsApiStack } from './collectors-api-stack.js';
import { TagCdkProviders } from './ops.js';

export interface BuiltApp {
  readonly app: App;
  readonly deployment: Deployment;
  readonly data: CollectorsDataStack;
  readonly api: CollectorsApiStack;
}

export function buildApp(app: App = new App(), configDir?: string): BuiltApp {
  const deployment = resolveDeployment(app);
  // `--context domains=off` only for the first rollout of custom domains (CAP-29, README § Custom domains).
  const config = applyDomainsSwitch(app, loadInstallationConfig(deployment, configDir));
  assertAccountMatchesDeployment(deployment);

  const account = process.env.CDK_DEFAULT_ACCOUNT;
  const env = account ? { account, region: config.region } : { region: config.region };
  const data = new CollectorsDataStack(app, 'CollectorsData', {
    stackName: resourceName(deployment, 'data'),
    description: 'CapCollector — data: S3 images/web and the DynamoDB single table',
    env,
    deployment,
    config,
  });
  const api = new CollectorsApiStack(app, 'CollectorsApi', {
    stackName: resourceName(deployment, 'api'),
    description: 'CapCollector — API: Lambda handlers, HTTP API, auth',
    env,
    deployment,
    config,
    table: data.table,
    imagesBucket: data.imagesBucket,
  });
  // The API imports CollectorsData outputs (table, buckets, WebUrl), so data must be deployed first.
  api.addStackDependency(data);

  // AWS tagging (CONVENTIONS.md § AWS tagging): once, at app level, so every current and future stack and every
  // taggable construct inherits the tags — never per construct. CDK's own provider Lambdas are raw resources that
  // Tags.of does not reach; the aspect gives them the same tags (CAP-51, T-infra-035).
  const tags = deploymentTags(deployment, config.config_version);
  for (const [key, value] of Object.entries(tags)) Tags.of(app).add(key, value);
  Aspects.of(app).add(new TagCdkProviders(tags));
  return { app, deployment, data, api };
}
