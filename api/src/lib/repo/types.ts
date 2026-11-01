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
  /** Tombstone (ADR-006): `patch` with `deletedAt` set; frees the pocket and drops GSI attributes. */
  softDelete(uid: string, prev: CapPrevious, history: CapHistory): Promise<Cap>;
  list(uid: string, opts?: CapListOptions): Promise<Page<Cap>>;
  /** History of one cap, oldest first. */
  history(capId: string): Promise<CapHistory[]>;
  /** GSI1: live caps on one sheet, by pocket. */
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
  /** Create or replace. */
  put(uid: string, album: Album): Promise<void>;
}

export interface ScanRepository {
  put(uid: string, scan: Scan): Promise<void>;
  get(uid: string, scanId: string): Promise<Scan | undefined>;
  /** Newest first. */
  list(uid: string, opts?: PageOptions): Promise<Page<Scan>>;
}

export interface ExchangeRepository {
  /** Create or replace. */
  put(uid: string, item: ExchangeRequestItem): Promise<void>;
  get(uid: string, requestId: string): Promise<ExchangeRequestItem | undefined>;
  list(uid: string): Promise<ExchangeRequestItem[]>;
}

export interface Repositories {
  caps: CapRepository;
  albums: AlbumRepository;
  scans: ScanRepository;
  exchange: ExchangeRepository;
}
