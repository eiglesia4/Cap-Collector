// DynamoDB repositories for the deployed Lambdas (data-model.md: single table, GSI1 location, GSI2 brand). Writes are
// the items.ts plan sent as one TransactWriteItems (cap + HIST# + LOCK#, ADR-006); keys come only from shared/keys.ts;
// cursors are base64url(LastEvaluatedKey). Albums, scans and exchange are stubs until their stories (CAP-17 scope).
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  type QueryCommandInput,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import {
  type Album,
  type Cap,
  type CapHistory,
  type ExchangeRequestItem,
  INDEXES,
  type Scan,
  SK_PREFIX,
  capPk,
  capSk,
  userPk,
} from '@capcollector/shared';

import { refreshKey } from '../../auth/keys.js';
import type { Config } from '../config.js';
import { Conflict, NotImplemented } from '../errors.js';
import {
  type Item,
  type Op,
  decodeCursor,
  encodeCursor,
  gsi1Pk,
  gsi2Pk,
  gsi2VariantPrefix,
  pageSize,
  planCreate,
  planPatch,
  pocketFromGsi1Sk,
  stripKeys,
  toIndexEntry,
  tombstone,
} from './items.js';
import {
  type AlbumRepository,
  type CapHashes,
  type CapIndexEntry,
  type CapListOptions,
  type CapPrevious,
  type CapRepository,
  type CapWrite,
  DEFAULT_PAGE_SIZE,
  type ExchangeRepository,
  MAX_PAGE_SIZE,
  type Page,
  type RefreshTokenItem,
  type RefreshTokenRepository,
  type Repositories,
  type ScanRepository,
  type SheetEntry,
} from './types.js';

/** The slice of the document client the repositories use (aws-sdk-client-mock or a fake can stand in). */
export interface DocSender {
  send(command: GetCommand | QueryCommand | TransactWriteCommand): Promise<unknown>;
}

export function createDocumentClient(config: Pick<Config, 'dynamodbEndpoint'>): DynamoDBDocumentClient {
  const client = new DynamoDBClient(config.dynamodbEndpoint ? { endpoint: config.dynamodbEndpoint } : {});
  return DynamoDBDocumentClient.from(client, { marshallOptions: { removeUndefinedValues: true } });
}

type TransactItem = NonNullable<TransactWriteCommandInput['TransactItems']>[number];

/** items.ts plan → TransactItems with the matching ConditionExpressions. */
export function toTransactItems(tableName: string, ops: Op[]): TransactItem[] {
  return ops.map((o): TransactItem => {
    if (o.op === 'delete') {
      return {
        Delete: {
          TableName: tableName,
          Key: o.key,
          ConditionExpression: 'capId = :capId',
          ExpressionAttributeValues: { ':capId': o.ifCapId },
        },
      };
    }
    if ('ifNotExists' in o) {
      return { Put: { TableName: tableName, Item: o.item, ConditionExpression: 'attribute_not_exists(pk)' } };
    }
    return {
      Put: {
        TableName: tableName,
        Item: o.item,
        ConditionExpression: 'updatedAt = :prevUpdatedAt',
        ExpressionAttributeValues: { ':prevUpdatedAt': o.ifUpdatedAt },
      },
    };
  });
}

const errorName = (e: unknown) => (typeof e === 'object' && e !== null && 'name' in e ? String(e.name) : '');

interface QueryOut {
  Items?: Record<string, unknown>[];
  LastEvaluatedKey?: Record<string, unknown>;
}

export class DynamoCapRepository implements CapRepository {
  constructor(
    private readonly doc: DocSender,
    private readonly tableName: string,
  ) {}

  private async transact(ops: Op[]): Promise<void> {
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: toTransactItems(this.tableName, ops) }));
    } catch (e) {
      const n = errorName(e);
      if (n === 'TransactionCanceledException' || n === 'ConditionalCheckFailedException') {
        throw new Conflict('The record changed or the target is taken');
      }
      throw e;
    }
  }

  private async query(input: Omit<QueryCommandInput, 'TableName'>): Promise<QueryOut> {
    return (await this.doc.send(new QueryCommand({ TableName: this.tableName, ...input }))) as QueryOut;
  }

  /** Follows LastEvaluatedKey to the end (sheets ≤ 42 pockets, brands and hashes are small). */
  private async queryAll(input: Omit<QueryCommandInput, 'TableName'>): Promise<Record<string, unknown>[]> {
    const out: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await this.query({ ...input, ...(start ? { ExclusiveStartKey: start } : {}) });
      out.push(...(r.Items ?? []));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async get(uid: string, capId: string): Promise<Cap | undefined> {
    const r = (await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: userPk(uid), sk: capSk(capId) } }),
    )) as { Item?: Item };
    return r.Item && stripKeys<Cap>(r.Item);
  }

  async put(uid: string, write: CapWrite): Promise<void> {
    await this.transact(planCreate(uid, write));
  }

  async patch(uid: string, prev: CapPrevious, write: CapWrite): Promise<void> {
    await this.transact(planPatch(uid, prev, write));
  }

  async softDelete(uid: string, prev: CapPrevious, history: CapHistory): Promise<Cap> {
    const cap = tombstone(prev.cap, history);
    await this.patch(uid, prev, { cap, history });
    return cap;
  }

  async list(uid: string, opts: CapListOptions = {}): Promise<Page<Cap>> {
    const pk = userPk(uid);
    const r = await this.query({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': pk, ':prefix': SK_PREFIX.cap },
      Limit: pageSize(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      ...(opts.includeDeleted ? {} : { FilterExpression: 'attribute_not_exists(deletedAt)' }),
      ...(opts.cursor ? { ExclusiveStartKey: decodeCursor(opts.cursor, pk) } : {}),
    });
    return {
      items: (r.Items ?? []).map((i) => stripKeys<Cap>(i)),
      ...(r.LastEvaluatedKey ? { cursor: encodeCursor(r.LastEvaluatedKey) } : {}),
    };
  }

  async history(capId: string): Promise<CapHistory[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk',
      ExpressionAttributeValues: { ':pk': capPk(capId) },
    });
    return items.map((i) => stripKeys<CapHistory>(i));
  }

  async listGsi1(albumId: string, sheet: number): Promise<SheetEntry[]> {
    const items = await this.queryAll({
      IndexName: INDEXES.location,
      KeyConditionExpression: 'gsi1pk = :pk',
      ExpressionAttributeValues: { ':pk': gsi1Pk(albumId, sheet) },
    });
    return items.map((i) => ({ ...toIndexEntry(i), pocket: pocketFromGsi1Sk(String(i.gsi1sk)) }));
  }

  async listGsi2(brand: string, variant?: string): Promise<CapIndexEntry[]> {
    const items = await this.queryAll({
      IndexName: INDEXES.brand,
      ...(variant === undefined
        ? { KeyConditionExpression: 'gsi2pk = :pk', ExpressionAttributeValues: { ':pk': gsi2Pk(brand) } }
        : {
            KeyConditionExpression: 'gsi2pk = :pk AND begins_with(gsi2sk, :prefix)',
            ExpressionAttributeValues: { ':pk': gsi2Pk(brand), ':prefix': gsi2VariantPrefix(brand, variant) },
          }),
    });
    return items.map(toIndexEntry);
  }

  async hashes(uid: string): Promise<CapHashes[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(uid), ':prefix': SK_PREFIX.cap },
      FilterExpression: 'attribute_not_exists(deletedAt)',
      ProjectionExpression: 'capId, dhash, dhashUnderside',
    });
    return items.map((i) => i as unknown as CapHashes);
  }
}

/** Rejects like any failed repository call (never throws synchronously). */
const notYet = (what: string): Promise<never> => Promise.reject(new NotImplemented(`${what} lands with its own story`));

/** Stub until the albums story (EP-03). */
export class DynamoAlbumRepository implements AlbumRepository {
  get(_uid: string, _albumId: string): Promise<Album | undefined> {
    return notYet('DynamoAlbumRepository.get');
  }
  byLetter(_uid: string, _letter: string): Promise<Album | undefined> {
    return notYet('DynamoAlbumRepository.byLetter');
  }
  list(_uid: string): Promise<Album[]> {
    return notYet('DynamoAlbumRepository.list');
  }
  put(_uid: string, _album: Album): Promise<void> {
    return notYet('DynamoAlbumRepository.put');
  }
}

/** Stub until the scans story (EP-05). */
export class DynamoScanRepository implements ScanRepository {
  put(_uid: string, _scan: Scan): Promise<void> {
    return notYet('DynamoScanRepository.put');
  }
  get(_uid: string, _scanId: string): Promise<Scan | undefined> {
    return notYet('DynamoScanRepository.get');
  }
  list(_uid: string): Promise<Page<Scan>> {
    return notYet('DynamoScanRepository.list');
  }
}

/** Stub until the exchange story (EP-07). */
export class DynamoExchangeRepository implements ExchangeRepository {
  put(_uid: string, _item: ExchangeRequestItem): Promise<void> {
    return notYet('DynamoExchangeRepository.put');
  }
  get(_uid: string, _requestId: string): Promise<ExchangeRequestItem | undefined> {
    return notYet('DynamoExchangeRepository.get');
  }
  list(_uid: string): Promise<ExchangeRequestItem[]> {
    return notYet('DynamoExchangeRepository.list');
  }
}

export class DynamoRefreshTokenRepository implements RefreshTokenRepository {
  constructor(
    private readonly doc: DocSender,
    private readonly tableName: string,
  ) {}

  async create(uid: string, item: RefreshTokenItem): Promise<void> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: { ...refreshKey(uid, item.tokenHash), ...item },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
    } catch (e) {
      if (errorName(e) === 'TransactionCanceledException') throw new Conflict('refresh token collision');
      throw e;
    }
  }

  async rotate(uid: string, oldHash: string, next: RefreshTokenItem, nowEpoch: number): Promise<boolean> {
    try {
      await this.doc.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              // TTL deletion is lazy (up to days): an expired item may still exist, so the condition checks `ttl`.
              Delete: {
                TableName: this.tableName,
                Key: refreshKey(uid, oldHash),
                ConditionExpression: 'attribute_exists(pk) AND #ttl > :now',
                ExpressionAttributeNames: { '#ttl': 'ttl' },
                ExpressionAttributeValues: { ':now': nowEpoch },
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: { ...refreshKey(uid, next.tokenHash), ...next },
                ConditionExpression: 'attribute_not_exists(pk)',
              },
            },
          ],
        }),
      );
      return true;
    } catch (e) {
      if (errorName(e) === 'TransactionCanceledException') return false;
      throw e;
    }
  }
}

export function createDynamoRepositories(doc: DocSender, tableName: string): Repositories {
  return {
    caps: new DynamoCapRepository(doc, tableName),
    albums: new DynamoAlbumRepository(),
    scans: new DynamoScanRepository(),
    exchange: new DynamoExchangeRepository(),
    refreshTokens: new DynamoRefreshTokenRepository(doc, tableName),
  };
}
