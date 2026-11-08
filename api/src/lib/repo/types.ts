// Repository interfaces (CLAUDE.md § api: "DynamoDB detrás de un repositorio con interfaz"). Handlers depend on these;
// `memory.ts` backs unit tests and `api:local`, `dynamo.ts` the deployed Lambdas. Entities are the shared zod types;
// storage keys never leak out of the Dynamo implementation (data-model.md, keys only from shared/keys.ts).
import type { Album, Cap, CapHistory, CapStatus, ExchangeRequestItem, Scan } from '@capcollector/shared';

export interface Page<T> {
  items: T[];
  /** Opaque continuation; absent on the last page. Dynamo: base64url of `LastEvaluatedKey`. */
  cursor?: string;
}

export interface PageOptions {
  /** Page size, 1–100 (default 50). */
  limit?: number;
  cursor?: string;
}

export const DEFAULT_PAGE_SIZE = 50;
export const MAX_PAGE_SIZE = 100;
/** GET /scans allows up to 200 per page (openapi.yaml /scans `limit` maximum, CAP-37). */
export const SCAN_MAX_PAGE_SIZE = 200;

/**
 * One cap write: the full next state of the record, the `albumId` its album-kind location resolves to (the record
 * stores only the album letter; keys need the id — data-model.md § Indexes), and the history entry written in the
 * same transaction (ADR-006).
 */
export interface CapWrite {
  cap: Cap;
  /** Required when `cap.location.kind === 'album'` and the cap is live; ignored otherwise. */
  albumId?: string;
  history: CapHistory;
}

/** The state the caller read before patching; `updatedAt` is the optimistic-concurrency token. */
export interface CapPrevious {
  cap: Cap;
  albumId?: string;
}

/** One side of a swap (CAP-50): the state read and the state to write. */
export interface SwapSide {
  prev: CapPrevious;
  write: CapWrite;
}

/** A GSI row: only the projected attributes (data-model.md § Indexes: keys + capId, brand, variant, images, status, deletedAt). */
export interface CapIndexEntry {
  capId: string;
  brand: string;
  variant?: string;
  images: Cap['images'];
  status: CapStatus;
}

/** GSI1 row plus the pocket it occupies. */
export interface SheetEntry extends CapIndexEntry {
  pocket: number;
}

/** What the dHash comparison needs (data-model.md § dHash comparison). */
export interface CapHashes {
  capId: string;
  dhash?: string;
  dhashUnderside?: string;
}

export interface CapListOptions extends PageOptions {
  /** Include tombstoned caps (default false). */
  includeDeleted?: boolean;
}

export interface CapRepository {
  /** The record as stored, tombstoned or not; `undefined` when it never existed. */
  get(uid: string, capId: string): Promise<Cap | undefined>;
  /** Creates a cap + its history entry (+ pocket lock). Conflict if the id exists, the pocket is taken or the history ts collides. */
  put(uid: string, write: CapWrite): Promise<void>;
  /**
   * Replaces the record with `write.cap` and appends `write.history`, atomically; moves the pocket lock and GSI
   * attributes. Conflict when the stored `updatedAt` is no longer `prev.cap.updatedAt` or the new pocket is taken.
   */
  patch(uid: string, prev: CapPrevious, write: CapWrite): Promise<void>;
  /**
   * Swap (CAP-50): `a` takes the pocket `b` occupies and `b` takes `a`'s previous location, both caps, both history
   * entries and both `LOCK#` markers in one transaction. Conflict when either cap changed or a marker moved meanwhile.
   */
  swap(uid: string, a: SwapSide, b: SwapSide): Promise<void>;
  /** The capId holding pocket `sheet`/`pocket` of `albumId` (its `LOCK#` marker), or undefined when it is free. */
  occupant(uid: string, albumId: string, sheet: number, pocket: number): Promise<string | undefined>;
  /** Tombstone (ADR-006): `patch` with `deletedAt` set; frees the pocket and drops GSI attributes. */
  softDelete(uid: string, prev: CapPrevious, history: CapHistory): Promise<Cap>;
  list(uid: string, opts?: CapListOptions): Promise<Page<Cap>>;
  /**
   * Every cap of the user in one call (follows all pages): the list endpoint filters and sorts in memory, acceptable
   * at a personal collection's size (data-model.md § dHash comparison rationale; CAP-18).
   */
  listAll(uid: string, opts?: { includeDeleted?: boolean }): Promise<Cap[]>;
  /** History of one cap, oldest first. */
  history(capId: string): Promise<CapHistory[]>;
  /** GSI1: live caps on one sheet, by pocket (tombstoned rows are dropped even if a stale GSI1 key survived). */
  listGsi1(albumId: string, sheet: number): Promise<SheetEntry[]>;
  /** GSI2: live caps of a brand (normalised), optionally narrowed to one variant. */
  listGsi2(brand: string, variant?: string): Promise<CapIndexEntry[]>;
  /** dHashes of every live cap of the user. */
  hashes(uid: string): Promise<CapHashes[]>;
}

export interface AlbumRepository {
  get(uid: string, albumId: string): Promise<Album | undefined>;
  byLetter(uid: string, letter: string): Promise<Album | undefined>;
  list(uid: string): Promise<Album[]>;
  /** Create or replace, unconditionally (seeding and tests; the API writes through `create` / `update`). */
  put(uid: string, album: Album): Promise<void>;
  /**
   * Stores a new album (CAP-49). Conflict when another album of the user already uses its letter or the id exists.
   * The letter has no key of its own in data-model.md, so uniqueness is a read-then-conditional-put.
   */
  create(uid: string, album: Album): Promise<void>;
  /**
   * Replaces the album (CAP-49). Conflict when the stored `updatedAt` is no longer `prevUpdatedAt` (a concurrent
   * edit won) or when the album's letter now belongs to another album.
   */
  update(uid: string, album: Album, prevUpdatedAt: string): Promise<void>;
}

export interface ScanRepository {
  put(uid: string, scan: Scan): Promise<void>;
  get(uid: string, scanId: string): Promise<Scan | undefined>;
  /** Newest first. */
  list(uid: string, opts?: PageOptions): Promise<Page<Scan>>;
}

/** Exchange requests `EXCHANGE#<requestId>` (exchange.md § Pending requests, CAP-44). */
export interface ExchangeRepository {
  /**
   * Stores a new request; Conflict when `requestId` already exists. With `linkScan`, sets that scan's
   * `exchangeRequestId` in the same transaction (the scan must still exist, else Conflict and nothing is written).
   */
  create(uid: string, item: ExchangeRequestItem, linkScan?: Scan): Promise<void>;
  get(uid: string, requestId: string): Promise<ExchangeRequestItem | undefined>;
  /** Replaces the item; Conflict when the stored status is no longer `prevStatus` (a concurrent transition won). */
  update(uid: string, item: ExchangeRequestItem, prevStatus: ExchangeRequestItem['status']): Promise<void>;
  /** Every request of the user (all pages), in key order; callers sort. */
  list(uid: string): Promise<ExchangeRequestItem[]>;
}

/** A stored refresh token: only its SHA-256 hash is kept (CAP-19, ADR-008 §4). */
export interface RefreshTokenItem {
  tokenHash: string;
  createdAt: string;
  /** Expiry, epoch seconds (DynamoDB TTL attribute). */
  ttl: number;
}

export interface RefreshTokenRepository {
  create(uid: string, item: RefreshTokenItem): Promise<void>;
  /**
   * Atomically deletes `oldHash` and stores `next`; false when the old token is unknown, already used or expired at
   * `nowEpoch` (replay → the caller answers 401).
   */
  rotate(uid: string, oldHash: string, next: RefreshTokenItem, nowEpoch: number): Promise<boolean>;
}

export interface Repositories {
  caps: CapRepository;
  albums: AlbumRepository;
  scans: ScanRepository;
  exchange: ExchangeRepository;
  refreshTokens: RefreshTokenRepository;
}
