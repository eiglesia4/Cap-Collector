/**
 * Composition of the CDK app, separate from bin/app.ts so tests synthesize exactly what the CLI does.
 * Order: resolve deployment → require its config file → account guard → stacks → app-level tags.
 */
import { App, Tags } from 'aws-cdk-lib';

import {
  assertAccountMatchesDeployment,
  type Deployment,
  loadInstallationConfig,
  PROJECT_TAG_VALUE,
  resolveDeployment,
  resourceName,
  TAG_KEYS,
  USER_NAME_TAG_VALUE,
} from './config.js';
import { CollectorsDataStack } from './collectors-data-stack.js';
import { CollectorsApiStack } from './stacks.js';

export interface BuiltApp {
  readonly app: App;
  readonly deployment: Deployment;
  readonly data: CollectorsDataStack;
  readonly api: CollectorsApiStack;
}

export function buildApp(app: App = new App(), configDir?: string): BuiltApp {
  const deployment = resolveDeployment(app);
  const config = loadInstallationConfig(deployment, configDir);
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
  });
  api.addStackDependency(data);

  // AWS tagging (CONVENTIONS.md § AWS tagging): once, at app level, so every current and future stack and every
  // taggable construct inherits the tags — never per construct.
  Tags.of(app).add(TAG_KEYS.project, PROJECT_TAG_VALUE);
  Tags.of(app).add(TAG_KEYS.userName, USER_NAME_TAG_VALUE);
  Tags.of(app).add(TAG_KEYS.installation, deployment.installation);
  Tags.of(app).add(TAG_KEYS.stage, deployment.stage);
  Tags.of(app).add(TAG_KEYS.configVersion, config.config_version);
  return { app, deployment, data, api };
}
