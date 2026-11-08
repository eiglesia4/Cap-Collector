// DynamoDB repositories for the deployed Lambdas (data-model.md: single table, GSI1 location, GSI2 brand). Writes are
// the items.ts plan sent as one TransactWriteItems (cap + HIST# + LOCK#, ADR-006); keys come only from shared/keys.ts;
// cursors are base64url(LastEvaluatedKey). Scans are real since CAP-37, exchange since CAP-44, albums since CAP-49.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
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
  albumSk,
  capPk,
  capSk,
  exchangeSk,
  lockSk,
  scanSk,
  userPk,
} from '@capcollector/shared';

import { refreshKey } from '../../auth/keys.js';
import type { Config } from '../config.js';
import { Conflict } from '../errors.js';
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
  planSwap,
  pocketFromGsi1Sk,
  stripKeys,
  toExchangeItem,
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
  type PageOptions,
  SCAN_MAX_PAGE_SIZE,
  type RefreshTokenItem,
  type RefreshTokenRepository,
  type Repositories,
  type ScanRepository,
  type SheetEntry,
  type SwapSide,
} from './types.js';

/** The slice of the document client the repositories use (aws-sdk-client-mock or a fake can stand in). */
export interface DocSender {
  send(command: GetCommand | PutCommand | QueryCommand | TransactWriteCommand): Promise<unknown>;
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
    if ('ifCapId' in o) {
      return {
        Put: {
          TableName: tableName,
          Item: o.item,
          ConditionExpression: 'capId = :capId',
          ExpressionAttributeValues: { ':capId': o.ifCapId },
        },
      };
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

  async swap(uid: string, a: SwapSide, b: SwapSide): Promise<void> {
    await this.transact(planSwap(uid, a, b));
  }

  async occupant(uid: string, albumId: string, sheet: number, pocket: number): Promise<string | undefined> {
    const key = { pk: userPk(uid), sk: lockSk(albumId, { kind: 'album', album: 'A', sheet, pocket }) };
    const r = (await this.doc.send(new GetCommand({ TableName: this.tableName, Key: key }))) as { Item?: Item };
    return typeof r.Item?.capId === 'string' ? r.Item.capId : undefined;
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

  async listAll(uid: string, opts: { includeDeleted?: boolean } = {}): Promise<Cap[]> {
    const items = await this.queryAll({
      KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
      ExpressionAttributeValues: { ':pk': userPk(uid), ':prefix': SK_PREFIX.cap },
      ...(opts.includeDeleted ? {} : { FilterExpression: 'attribute_not_exists(deletedAt)' }),
    });
    return items.map((i) => stripKeys<Cap>(i));
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
    return items
      .filter((i) => i.deletedAt === undefined)
      .map((i) => ({ ...toIndexEntry(i), pocket: pocketFromGsi1Sk(String(i.gsi1sk)) }));
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

/** Albums under the user partition, `ALBUM#<albumId>` (data-model.md; CAP-49). A handful per user: list reads them all. */
export class DynamoAlbumRepository implements AlbumRepository {
  constructor(
    private readonly doc: DocSender,
    private readonly tableName: string,
  ) {}

  async get(uid: string, albumId: string): Promise<Album | undefined> {
    const r = (await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: userPk(uid), sk: albumSk(albumId) } }),
    )) as { Item?: Item };
    return r.Item && stripKeys<Album>(r.Item);
  }

  async byLetter(uid: string, letter: string): Promise<Album | undefined> {
    return (await this.list(uid)).find((a) => a.letter === letter);
  }

  async list(uid: string): Promise<Album[]> {
    const out: Album[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = (await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': userPk(uid), ':prefix': SK_PREFIX.album },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      )) as QueryOut;
      out.push(...(r.Items ?? []).map((i) => stripKeys<Album>(i)));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  }

  async put(uid: string, album: Album): Promise<void> {
    await this.doc.send(new PutCommand({ TableName: this.tableName, Item: this.item(uid, album) }));
  }

  // SPEC-GAP CAP-49: the story asks for a put conditional on the letter, but data-model.md has no letter key (and keys
  // are never invented), so uniqueness is byLetter + a put conditional on the new id. Two concurrent creates of the
  // same letter could both pass; acceptable for the single allowed user, and the architect may add a key later.
  async create(uid: string, album: Album): Promise<void> {
    if (await this.byLetter(uid, album.letter)) throw new Conflict(`album letter ${album.letter} is already used`);
    await this.conditionalPut(this.item(uid, album), 'attribute_not_exists(pk)', {});
  }

  async update(uid: string, album: Album, prevUpdatedAt: string): Promise<void> {
    const other = await this.byLetter(uid, album.letter);
    if (other && other.albumId !== album.albumId) throw new Conflict(`album letter ${album.letter} is already used`);
    await this.conditionalPut(this.item(uid, album), 'updatedAt = :prev', { ':prev': prevUpdatedAt });
  }

  private item(uid: string, album: Album): Item {
    return { ...album, pk: userPk(uid), sk: albumSk(album.albumId) };
  }

  private async conditionalPut(item: Item, condition: string, values: Record<string, unknown>): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression: condition,
          ...(Object.keys(values).length > 0 ? { ExpressionAttributeValues: values } : {}),
        }),
      );
    } catch (e) {
      if (errorName(e) === 'ConditionalCheckFailedException') throw new Conflict('The album changed or already exists');
      throw e;
    }
  }
}

/** Scans under the user partition, `SCAN#<ts>#<scanId>` (data-model.md; CAP-37). Append-only: one item per analyse. */
export class DynamoScanRepository implements ScanRepository {
  constructor(
    private readonly doc: DocSender,
    private readonly tableName: string,
  ) {}

  async put(uid: string, scan: Scan): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { ...scan, pk: userPk(uid), sk: scanSk(scan.ts, scan.scanId) },
      }),
    );
  }

  /** The sort key starts with the timestamp, so a lookup by id walks the user's scans with a filter. */
  async get(uid: string, scanId: string): Promise<Scan | undefined> {
    let start: Record<string, unknown> | undefined;
    do {
      const r = (await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          FilterExpression: 'scanId = :scanId',
          ExpressionAttributeValues: { ':pk': userPk(uid), ':prefix': SK_PREFIX.scan, ':scanId': scanId },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      )) as QueryOut;
      const hit = r.Items?.[0];
      if (hit) return stripKeys<Scan>(hit);
      start = r.LastEvaluatedKey;
    } while (start);
    return undefined;
  }

  async list(uid: string, opts: PageOptions = {}): Promise<Page<Scan>> {
    const pk = userPk(uid);
    const r = (await this.doc.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
        ExpressionAttributeValues: { ':pk': pk, ':prefix': SK_PREFIX.scan },
        ScanIndexForward: false,
        Limit: pageSize(opts.limit, DEFAULT_PAGE_SIZE, SCAN_MAX_PAGE_SIZE),
        ...(opts.cursor ? { ExclusiveStartKey: decodeCursor(opts.cursor, pk) } : {}),
      }),
    )) as QueryOut;
    return {
      items: (r.Items ?? []).map((i) => stripKeys<Scan>(i)),
      ...(r.LastEvaluatedKey ? { cursor: encodeCursor(r.LastEvaluatedKey) } : {}),
    };
  }
}

/** Exchange requests under the user partition, `EXCHANGE#<requestId>` with `ttl` (data-model.md; CAP-44). */
export class DynamoExchangeRepository implements ExchangeRepository {
  constructor(
    private readonly doc: DocSender,
    private readonly tableName: string,
  ) {}

  /** One transaction: the new item (must not exist) + `SET exchangeRequestId` on the scan (must exist). */
  async create(uid: string, item: ExchangeRequestItem, linkScan?: Scan): Promise<void> {
    const pk = userPk(uid);
    const items: TransactItem[] = [
      {
        Put: {
          TableName: this.tableName,
          Item: { ...item, pk, sk: exchangeSk(item.requestId) },
          ConditionExpression: 'attribute_not_exists(pk)',
        },
      },
    ];
    if (linkScan) {
      items.push({
        Update: {
          TableName: this.tableName,
          Key: { pk, sk: scanSk(linkScan.ts, linkScan.scanId) },
          UpdateExpression: 'SET exchangeRequestId = :rid',
          ConditionExpression: 'attribute_exists(pk)',
          ExpressionAttributeValues: { ':rid': item.requestId },
        },
      });
    }
    try {
      await this.doc.send(new TransactWriteCommand({ TransactItems: items }));
    } catch (e) {
      if (errorName(e) === 'TransactionCanceledException') throw new Conflict('The exchange request already exists');
      throw e;
    }
  }

  async get(uid: string, requestId: string): Promise<ExchangeRequestItem | undefined> {
    const r = (await this.doc.send(
      new GetCommand({ TableName: this.tableName, Key: { pk: userPk(uid), sk: exchangeSk(requestId) } }),
    )) as { Item?: Record<string, unknown> };
    return r.Item && toExchangeItem(r.Item);
  }

  async update(uid: string, item: ExchangeRequestItem, prevStatus: ExchangeRequestItem['status']): Promise<void> {
    try {
      await this.doc.send(
        new PutCommand({
          TableName: this.tableName,
          Item: { ...item, pk: userPk(uid), sk: exchangeSk(item.requestId) },
          ConditionExpression: '#status = :prev',
          ExpressionAttributeNames: { '#status': 'status' },
          ExpressionAttributeValues: { ':prev': prevStatus },
        }),
      );
    } catch (e) {
      if (errorName(e) === 'ConditionalCheckFailedException') throw new Conflict('The exchange request changed');
      throw e;
    }
  }

  async list(uid: string): Promise<ExchangeRequestItem[]> {
    const out: ExchangeRequestItem[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = (await this.doc.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
          ExpressionAttributeValues: { ':pk': userPk(uid), ':prefix': SK_PREFIX.exchange },
          ...(start ? { ExclusiveStartKey: start } : {}),
        }),
      )) as QueryOut;
      out.push(...(r.Items ?? []).map((i) => toExchangeItem(i)));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
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
    albums: new DynamoAlbumRepository(doc, tableName),
    scans: new DynamoScanRepository(doc, tableName),
    exchange: new DynamoExchangeRepository(doc, tableName),
    refreshTokens: new DynamoRefreshTokenRepository(doc, tableName),
  };
}
