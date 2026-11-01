// Repository wiring for handlers (CAP-17): Lambdas get DynamoDB repositories built from the validated config once per
// cold start; `npm run api:local` and tests swap in the in-memory ones with `setRepositories`.
import { getConfig } from '../config.js';
import { createDocumentClient, createDynamoRepositories } from './dynamo.js';
import type { Repositories } from './types.js';

let current: Repositories | undefined;

/** The repositories of this Lambda instance; DynamoDB (or DynamoDB Local when CAP_DYNAMODB_ENDPOINT is set). */
export function getRepositories(): Repositories {
  if (!current) {
    const config = getConfig();
    current = createDynamoRepositories(createDocumentClient(config), config.tableName);
  }
  return current;
}

/** Override (local server, tests); `undefined` goes back to the config-built default. */
export function setRepositories(repos: Repositories | undefined): void {
  current = repos;
}

export type * from './types.js';
