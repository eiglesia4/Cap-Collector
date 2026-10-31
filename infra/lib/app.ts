/**
 * Composition of the CDK app, separate from bin/app.ts so tests synthesize exactly what the CLI does.
 * Order: resolve deployment → require its config file → account guard → stacks.
 */
import { App } from 'aws-cdk-lib';

import {
  applyGlobalTags,
  assertAccountMatchesDeployment,
  type Deployment,
  loadInstallationConfig,
  resolveDeployment,
  resourceName,
} from './config.js';
import { CollectorsApiStack, CollectorsDataStack } from './stacks.js';

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
  });
  const api = new CollectorsApiStack(app, 'CollectorsApi', {
    stackName: resourceName(deployment, 'api'),
    description: 'CapCollector — API: Lambda handlers, HTTP API, auth',
    env,
    deployment,
  });
  api.addStackDependency(data);

  applyGlobalTags(app, deployment, config);
  return { app, deployment, data, api };
}
