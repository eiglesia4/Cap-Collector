/**
 * Local DynamoDB table for tests and dev (method.md § Tests: "No cloud in tests: DynamoDB Local + S3 mock").
 * `npm run db:create` calls `ensureLocalTable` against the DynamoDB Local container of deploy/docker-compose.yaml.
 * Idempotent (T-infra-009): a second run finds the table and only makes sure TTL is on. Refuses AWS endpoints so the
 * script can never create or touch a table in the cloud — the real table is CDK's (collectors-data-stack.ts).
 */
import {
  CreateTableCommand,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  type DescribeTableCommandOutput,
  type DescribeTimeToLiveCommandOutput,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';

import { TABLE_DEFINITION, type TableDefinition, toCreateTableInput } from './table-definition.js';

export const DEFAULT_LOCAL_ENDPOINT = 'http://localhost:8000';
export const DEFAULT_LOCAL_TABLE = 'cap-local-table';
const TABLE_NAME_RE = /^[a-zA-Z0-9_.-]{3,255}$/;

export interface LocalDbConfig {
  readonly endpoint: string;
  readonly tableName: string;
}

/** Reads CAP_DYNAMODB_ENDPOINT / CAP_TABLE_NAME (defaults: the compose container and `cap-local-table`). */
export function localDbConfig(env: NodeJS.ProcessEnv = process.env): LocalDbConfig {
  const endpoint = env.CAP_DYNAMODB_ENDPOINT || DEFAULT_LOCAL_ENDPOINT;
  const tableName = env.CAP_TABLE_NAME || DEFAULT_LOCAL_TABLE;
  let host: string;
  try {
    host = new URL(endpoint).hostname;
  } catch {
    throw new Error(`CAP_DYNAMODB_ENDPOINT "${endpoint}" is not a URL`);
  }
  if (host.endsWith('amazonaws.com') || host.endsWith('amazonaws.com.cn')) {
    throw new Error(`db:create is local only: refusing AWS endpoint ${endpoint} (the cloud table is CDK's)`);
  }
  if (!TABLE_NAME_RE.test(tableName)) {
    throw new Error(`CAP_TABLE_NAME "${tableName}" is not a valid DynamoDB table name`);
  }
  return { endpoint, tableName };
}

type LocalDbCommand = DescribeTableCommand | CreateTableCommand | DescribeTimeToLiveCommand | UpdateTimeToLiveCommand;

/** The slice of DynamoDBClient used here, so tests can pass an in-memory fake. */
export interface DynamoSender {
  send(command: LocalDbCommand): Promise<unknown>;
}

export type EnsureResult = 'created' | 'exists';

const errorName = (e: unknown): string | undefined =>
  typeof e === 'object' && e !== null && 'name' in e ? String((e as { name: unknown }).name) : undefined;

async function describeTable(client: DynamoSender, tableName: string) {
  try {
    const out = (await client.send(new DescribeTableCommand({ TableName: tableName }))) as DescribeTableCommandOutput;
    return out.Table;
  } catch (e) {
    if (errorName(e) === 'ResourceNotFoundException') return undefined;
    throw e;
  }
}

async function ensureTtl(client: DynamoSender, tableName: string, attribute: string): Promise<void> {
  const out = (await client.send(
    new DescribeTimeToLiveCommand({ TableName: tableName }),
  )) as DescribeTimeToLiveCommandOutput;
  const ttl = out.TimeToLiveDescription;
  const on = ttl?.TimeToLiveStatus === 'ENABLED' || ttl?.TimeToLiveStatus === 'ENABLING';
  if (on && ttl?.AttributeName === attribute) return;
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: tableName,
      TimeToLiveSpecification: { AttributeName: attribute, Enabled: true },
    }),
  );
}

/**
 * Creates the table with the shared definition if it does not exist, then makes sure TTL is enabled.
 * An existing table missing one of the GSIs is an error, not something to patch: drop it and run again.
 */
export async function ensureLocalTable(
  client: DynamoSender,
  tableName: string,
  def: TableDefinition = TABLE_DEFINITION,
): Promise<EnsureResult> {
  let result: EnsureResult = 'exists';
  const existing = await describeTable(client, tableName);
  if (existing) {
    const present = new Set((existing.GlobalSecondaryIndexes ?? []).map((g) => g.IndexName));
    const missing = def.globalSecondaryIndexes.map((g) => g.indexName).filter((n) => !present.has(n));
    if (missing.length > 0) {
      throw new Error(
        `Local table ${tableName} exists without ${missing.join(', ')}: ` +
          'recreate it (docker compose -f deploy/docker-compose.yaml down, then up and npm run db:create)',
      );
    }
  } else {
    try {
      await client.send(new CreateTableCommand(toCreateTableInput(tableName, def)));
      result = 'created';
    } catch (e) {
      // Two runs racing: the other one created it.
      if (errorName(e) !== 'ResourceInUseException') throw e;
    }
  }
  await ensureTtl(client, tableName, def.timeToLiveAttribute);
  return result;
}
