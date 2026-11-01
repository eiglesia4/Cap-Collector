// In-memory repositories for unit tests and `npm run api:local` (CAP-17). A tiny single-table emulator: same items,
// same keys (shared/keys.ts), same transactional conditions (items.ts plan) and same cursor format as the DynamoDB
// implementation, so both pass one contract suite (T-api-003). Never used in a deployed Lambda.
import {
  type Album,
  type Cap,
  type CapHistory,
  type ExchangeRequestItem,
  type Scan,
  SK_PREFIX,
  albumSk,
  capPk,
  capSk,
  exchangeSk,
  scanSk,
  userPk,
} from '@capcollector/shared';

import { refreshKey } from '../../auth/keys.js';
import { Conflict } from '../errors.js';
import {
  type Item,
  type Key,
  type Op,
  decodeCursor,
  encodeCursor,
  gsi1Pk,
  toIndexEntry,
  gsi2Pk,
  gsi2VariantPrefix,
  planCreate,
  planPatch,
  pageSize,
  pocketFromGsi1Sk,
  stripKeys,
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
  type RefreshTokenItem,
  type RefreshTokenRepository,
  type Repositories,
  type ScanRepository,
  type SheetEntry,
} from './types.js';

const id = (k: Key) => `${k.pk}\u0000${k.sk}`;
const clone = <T>(v: T): T => structuredClone(v);

interface QueryOptions {
  forward?: boolean;
  limit?: number;
  startKey?: Key;
}

/** Items in a Map keyed by pk+sk; queries sort by sk (or the GSI sk) like DynamoDB's string ordering. */
export class MemoryTable {
  private readonly items = new Map<string, Item>();

  get(key: Key): Item | undefined {
    const it = this.items.get(id(key));
    return it && clone(it);
  }

  put(item: Item): void {
    this.items.set(id(item), clone(item));
  }

  delete(key: Key): void {
    this.items.delete(id(key));
  }

  /** All-or-nothing: every condition is checked before any write (TransactWriteItems semantics). */
  transact(ops: Op[]): void {
    for (const o of ops) {
      const key = o.op === 'delete' ? o.key : o.item;
      const cur = this.items.get(id(key));
      const ok =
        o.op === 'delete'
          ? cur?.capId === o.ifCapId
          : 'ifNotExists' in o
            ? cur === undefined
            : cur?.updatedAt === o.ifUpdatedAt;
      if (!ok) throw new Conflict('The record changed or the target is taken');
    }
    for (const o of ops) {
      if (o.op === 'delete') this.items.delete(id(o.key));
      else this.items.set(id(o.item), clone(o.item));
    }
  }

  query(pk: string, skPrefix: string, opts: QueryOptions = {}): { items: Item[]; lastKey?: Key } {
    const all = [...this.items.values()]
      .filter((i) => i.pk === pk && i.sk.startsWith(skPrefix))
      .sort((a, b) => (a.sk < b.sk ? -1 : a.sk > b.sk ? 1 : 0));
    if (opts.forward === false) all.reverse();
    // Like ExclusiveStartKey: resume strictly after the key, whether or not that item still exists.
    const after = opts.startKey?.sk;
    const forward = opts.forward !== false;
    const found = after === undefined ? 0 : all.findIndex((i) => (forward ? i.sk > after : i.sk < after));
    const start = found === -1 ? all.length : found;
    const slice = opts.limit === undefined ? all.slice(start) : all.slice(start, start + opts.limit);
    const last = slice.at(-1);
    const more = start + slice.length < all.length;
    return { items: slice.map(clone), ...(more && last ? { lastKey: { pk: last.pk, sk: last.sk } } : {}) };
  }

  queryIndex(index: 'gsi1' | 'gsi2', pk: string, skPrefix = ''): Item[] {
    const pkA = `${index}pk`;
    const skA = `${index}sk`;
    return [...this.items.values()]
      .filter((i) => i[pkA] === pk && String(i[skA]).startsWith(skPrefix))
      .sort((a, b) => (String(a[skA]) < String(b[skA]) ? -1 : 1))
      .map(clone);
  }
}

export class InMemoryCapRepository implements CapRepository {
  constructor(readonly table: MemoryTable = new MemoryTable()) {}

  async get(uid: string, capId: string): Promise<Cap | undefined> {
    const it = this.table.get({ pk: userPk(uid), sk: capSk(capId) });
    return it && stripKeys<Cap>(it);
  }

  async put(uid: string, write: CapWrite): Promise<void> {
    this.table.transact(planCreate(uid, write));
  }

  async patch(uid: string, prev: CapPrevious, write: CapWrite): Promise<void> {
    this.table.transact(planPatch(uid, prev, write));
  }

  async softDelete(uid: string, prev: CapPrevious, history: CapHistory): Promise<Cap> {
    const cap = tombstone(prev.cap, history);
    await this.patch(uid, prev, { cap, history });
    return cap;
  }

  async list(uid: string, opts: CapListOptions = {}): Promise<Page<Cap>> {
    const pk = userPk(uid);
    const limit = pageSize(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
    const r = this.table.query(pk, SK_PREFIX.cap, {
      limit,
      ...(opts.cursor ? { startKey: decodeCursor(opts.cursor, pk) } : {}),
    });
    const items = r.items.filter((i) => opts.includeDeleted || i.deletedAt === undefined).map((i) => stripKeys<Cap>(i));
    return { items, ...(r.lastKey ? { cursor: encodeCursor(r.lastKey) } : {}) };
  }

  async history(capId: string): Promise<CapHistory[]> {
    return this.table.query(capPk(capId), '').items.map((i) => stripKeys<CapHistory>(i));
  }

  async listGsi1(albumId: string, sheet: number): Promise<SheetEntry[]> {
    return this.table
      .queryIndex('gsi1', gsi1Pk(albumId, sheet))
      .map((i) => ({ ...toIndexEntry(i), pocket: pocketFromGsi1Sk(String(i.gsi1sk)) }));
  }

  async listGsi2(brand: string, variant?: string): Promise<CapIndexEntry[]> {
    const prefix = variant === undefined ? '' : gsi2VariantPrefix(brand, variant);
    return this.table.queryIndex('gsi2', gsi2Pk(brand), prefix).map(toIndexEntry);
  }

  async hashes(uid: string): Promise<CapHashes[]> {
    return this.table
      .query(userPk(uid), SK_PREFIX.cap)
      .items.filter((i) => i.deletedAt === undefined)
      .map((i) => {
        const c = i as unknown as Cap;
        return {
          capId: c.capId,
          ...(c.dhash ? { dhash: c.dhash } : {}),
          ...(c.dhashUnderside ? { dhashUnderside: c.dhashUnderside } : {}),
        };
      });
  }
}

export class InMemoryAlbumRepository implements AlbumRepository {
  constructor(readonly table: MemoryTable = new MemoryTable()) {}

  async get(uid: string, albumId: string): Promise<Album | undefined> {
    const it = this.table.get({ pk: userPk(uid), sk: albumSk(albumId) });
    return it && stripKeys<Album>(it);
  }

  async byLetter(uid: string, letter: string): Promise<Album | undefined> {
    return (await this.list(uid)).find((a) => a.letter === letter);
  }

  async list(uid: string): Promise<Album[]> {
    return this.table.query(userPk(uid), SK_PREFIX.album).items.map((i) => stripKeys<Album>(i));
  }

  async put(uid: string, album: Album): Promise<void> {
    this.table.put({ ...album, pk: userPk(uid), sk: albumSk(album.albumId) });
  }
}

export class InMemoryScanRepository implements ScanRepository {
  constructor(readonly table: MemoryTable = new MemoryTable()) {}

  async put(uid: string, scan: Scan): Promise<void> {
    this.table.put({ ...scan, pk: userPk(uid), sk: scanSk(scan.ts, scan.scanId) });
  }

  async get(uid: string, scanId: string): Promise<Scan | undefined> {
    const it = this.table.query(userPk(uid), SK_PREFIX.scan).items.find((i) => i.scanId === scanId);
    return it && stripKeys<Scan>(it);
  }

  async list(uid: string, opts: PageOptions = {}): Promise<Page<Scan>> {
    const pk = userPk(uid);
    const r = this.table.query(pk, SK_PREFIX.scan, {
      forward: false,
      limit: pageSize(opts.limit, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE),
      ...(opts.cursor ? { startKey: decodeCursor(opts.cursor, pk) } : {}),
    });
    return { items: r.items.map((i) => stripKeys<Scan>(i)), ...(r.lastKey ? { cursor: encodeCursor(r.lastKey) } : {}) };
  }
}

export class InMemoryExchangeRepository implements ExchangeRepository {
  constructor(readonly table: MemoryTable = new MemoryTable()) {}

  async put(uid: string, item: ExchangeRequestItem): Promise<void> {
    this.table.put({ ...item, pk: userPk(uid), sk: exchangeSk(item.requestId) });
  }

  async get(uid: string, requestId: string): Promise<ExchangeRequestItem | undefined> {
    const it = this.table.get({ pk: userPk(uid), sk: exchangeSk(requestId) });
    return it && stripKeys<ExchangeRequestItem>(it);
  }

  async list(uid: string): Promise<ExchangeRequestItem[]> {
    return this.table.query(userPk(uid), SK_PREFIX.exchange).items.map((i) => stripKeys<ExchangeRequestItem>(i));
  }
}

export class InMemoryRefreshTokenRepository implements RefreshTokenRepository {
  constructor(readonly table: MemoryTable = new MemoryTable()) {}

  async create(uid: string, item: RefreshTokenItem): Promise<void> {
    const key = refreshKey(uid, item.tokenHash);
    if (this.table.get(key)) throw new Conflict('refresh token collision');
    this.table.put({ ...key, ...item });
  }

  async rotate(uid: string, oldHash: string, next: RefreshTokenItem, nowEpoch: number): Promise<boolean> {
    const oldKey = refreshKey(uid, oldHash);
    const old = this.table.get(oldKey);
    if (!old || Number(old.ttl) <= nowEpoch) return false;
    if (this.table.get(refreshKey(uid, next.tokenHash))) return false;
    this.table.delete(oldKey);
    this.table.put({ ...refreshKey(uid, next.tokenHash), ...next });
    return true;
  }
}

/** Every repository over one shared in-memory table (as in DynamoDB, one table holds all entities). */
export function createMemoryRepositories(table: MemoryTable = new MemoryTable()): Repositories {
  return {
    caps: new InMemoryCapRepository(table),
    albums: new InMemoryAlbumRepository(table),
    scans: new InMemoryScanRepository(table),
    exchange: new InMemoryExchangeRepository(table),
    refreshTokens: new InMemoryRefreshTokenRepository(table),
  };
}
