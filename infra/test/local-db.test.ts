// Local table creation for DynamoDB Local (CAP-13): idempotent, same definition as CDK, never an AWS endpoint.
import {
  CreateTableCommand,
  type CreateTableCommandInput,
  DescribeTableCommand,
  DescribeTimeToLiveCommand,
  UpdateTimeToLiveCommand,
} from '@aws-sdk/client-dynamodb';
import { INDEXES } from '@capcollector/shared';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_LOCAL_ENDPOINT,
  DEFAULT_LOCAL_TABLE,
  type DynamoSender,
  ensureLocalTable,
  localDbConfig,
} from '../lib/local-db.js';
import { TABLE_DEFINITION, toCreateTableInput } from '../lib/table-definition.js';

const awsError = (name: string) => Object.assign(new Error(name), { name });

/** In-memory stand-in for DynamoDB Local: enough of DescribeTable / CreateTable / TTL to exercise the script. */
class FakeDynamo implements DynamoSender {
  readonly tables = new Map<string, { input: CreateTableCommandInput; ttl?: string | undefined }>();
  readonly calls: string[] = [];
  createError: Error | undefined;

  send(command: unknown): Promise<unknown> {
    if (command instanceof DescribeTableCommand) {
      this.calls.push('DescribeTable');
      const t = this.tables.get(command.input.TableName ?? '');
      if (!t) return Promise.reject(awsError('ResourceNotFoundException'));
      return Promise.resolve({ Table: { GlobalSecondaryIndexes: t.input.GlobalSecondaryIndexes } });
    }
    if (command instanceof CreateTableCommand) {
      this.calls.push('CreateTable');
      if (this.createError) return Promise.reject(this.createError);
      this.tables.set(command.input.TableName ?? '', { input: command.input });
      return Promise.resolve({});
    }
    if (command instanceof DescribeTimeToLiveCommand) {
      this.calls.push('DescribeTimeToLive');
      const ttl = this.tables.get(command.input.TableName ?? '')?.ttl;
      return Promise.resolve({
        TimeToLiveDescription: ttl
          ? { TimeToLiveStatus: 'ENABLED', AttributeName: ttl }
          : { TimeToLiveStatus: 'DISABLED' },
      });
    }
    if (command instanceof UpdateTimeToLiveCommand) {
      this.calls.push('UpdateTimeToLive');
      const t = this.tables.get(command.input.TableName ?? '');
      if (t) t.ttl = command.input.TimeToLiveSpecification?.AttributeName;
      return Promise.resolve({});
    }
    return Promise.reject(new Error('unexpected command'));
  }
}

describe('db:create (local table)', () => {
  it('[T-infra-009] local table creation is idempotent and uses the same definition as the CDK table', async () => {
    const db = new FakeDynamo();

    expect(await ensureLocalTable(db, 'cap-local-table')).toBe('created');
    expect(db.calls).toEqual(['DescribeTable', 'CreateTable', 'DescribeTimeToLive', 'UpdateTimeToLive']);
    const created = db.tables.get('cap-local-table');
    expect(created?.input).toEqual(toCreateTableInput('cap-local-table'));
    expect(created?.input.GlobalSecondaryIndexes?.map((g) => g.IndexName)).toEqual([INDEXES.location, INDEXES.brand]);
    expect(created?.input.BillingMode).toBe('PAY_PER_REQUEST');
    expect(created?.ttl).toBe(TABLE_DEFINITION.timeToLiveAttribute);

    // Second run: nothing created, TTL left alone.
    db.calls.length = 0;
    expect(await ensureLocalTable(db, 'cap-local-table')).toBe('exists');
    expect(db.calls).toEqual(['DescribeTable', 'DescribeTimeToLive']);
    expect(db.tables.size).toBe(1);

    // Two runs racing: CreateTable loses with ResourceInUseException → treated as "exists".
    const racing = new FakeDynamo();
    racing.createError = awsError('ResourceInUseException');
    expect(await ensureLocalTable(racing, 't-race')).toBe('exists');

    // Any other failure surfaces.
    const broken = new FakeDynamo();
    broken.createError = awsError('ValidationException');
    await expect(ensureLocalTable(broken, 't-broken')).rejects.toThrow('ValidationException');
    const down = { send: () => Promise.reject(new Error('connect ECONNREFUSED')) };
    await expect(ensureLocalTable(down, 't-down')).rejects.toThrow('ECONNREFUSED');

    // A stale table without the GSIs is refused, not patched.
    const stale = new FakeDynamo();
    stale.tables.set('t-stale', { input: { ...toCreateTableInput('t-stale'), GlobalSecondaryIndexes: [] } });
    await expect(ensureLocalTable(stale, 't-stale')).rejects.toThrow(/without GSI1, GSI2/);
  });

  it('[T-infra-013] db:create config defaults to the compose container and refuses AWS endpoints', () => {
    expect(localDbConfig({})).toEqual({ endpoint: DEFAULT_LOCAL_ENDPOINT, tableName: DEFAULT_LOCAL_TABLE });
    expect(localDbConfig({ CAP_DYNAMODB_ENDPOINT: 'http://dynamodb:8000', CAP_TABLE_NAME: 'my_table' })).toEqual({
      endpoint: 'http://dynamodb:8000',
      tableName: 'my_table',
    });
    expect(() => localDbConfig({ CAP_DYNAMODB_ENDPOINT: 'https://dynamodb.test-region-1.amazonaws.com' })).toThrow(
      /local only/,
    );
    expect(() => localDbConfig({ CAP_DYNAMODB_ENDPOINT: 'not a url' })).toThrow(/is not a URL/);
    expect(() => localDbConfig({ CAP_TABLE_NAME: 'a' })).toThrow(/not a valid DynamoDB table name/);
  });
});
