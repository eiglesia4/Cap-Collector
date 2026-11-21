// The batch queue on the device (CAP-83; ADR-009 §5; SCREENS.md § Batch mode): one unfinished batch at a time, its
// crops (WebP blobs + dHash) and the per-cap state, kept locally until the batch ends so closing the app and coming
// back continues it. The tray photo itself is never stored (ADR-009 §2). Behind a small interface: IndexedDB in the
// app (works in WKWebView and in browsers, and stores Blobs), in memory in tests. CAP-84 extends the item with the
// batch run's state.
import type { AnalyseResponse, ImageRef } from '@capcollector/shared';

/**
 * waiting → analysing → ready (an outcome to review) → resolved | skipped; failed (upload or analyse error, Retry).
 * CAP-84 (architect review of CAP-83): the per-item scan id, upload and answer are stored so a resume reuses them.
 */
export type BatchItemState = 'waiting' | 'analysing' | 'ready' | 'resolved' | 'skipped' | 'failed';

/** How a reviewed item ended: AI review saved, Already updated or discarded, saved from Manual entry. */
export type BatchResolution = 'saved' | 'updated' | 'discarded' | 'manual';

export interface BatchItem {
  /** 0-based position in reading order. */
  readonly index: number;
  /** The cropped, masked WebP (the same `CapPhoto` blob a single capture uploads). */
  readonly photo: Blob;
  readonly dhash: string;
  readonly width: number;
  readonly height: number;
  readonly state: BatchItemState;
  /** ULID of this item's scan (one `POST /scans/analyse` per cap), set when it is first analysed. */
  readonly scanId?: string;
  /** The uploaded top photo. */
  readonly ref?: ImageRef;
  /** `/scans/analyse` answer (state `ready` and after). */
  readonly response?: AnalyseResponse;
  /** The AI was unavailable (503): the item goes to Manual entry. */
  readonly unavailable?: true;
  readonly resolution?: BatchResolution;
  /** The saved / updated cap has no location (for Plan albums). */
  readonly unplaced?: true;
}

export interface Batch {
  /** ULID. */
  readonly batchId: string;
  readonly createdAt: string;
  /** "Propose next free pocket" (off by default: caps are saved without a location, § Initial layout). */
  readonly placeAsYouGo: boolean;
  readonly items: readonly BatchItem[];
}

export interface BatchStore {
  /** The unfinished batch, if any. */
  current(): Promise<Batch | null>;
  /** Store `batch` as the unfinished one, replacing any other (the caller asks first, CAP-83). */
  save(batch: Batch): Promise<void>;
  /** Forget the unfinished batch and its crops. */
  discard(): Promise<void>;
}

export function memoryBatchStore(initial: Batch | null = null): BatchStore {
  let batch = initial;
  return {
    current: () => Promise.resolve(batch),
    save: (next) => {
      batch = next;
      return Promise.resolve();
    },
    discard: () => {
      batch = null;
      return Promise.resolve();
    },
  };
}

const DB_NAME = 'capcollector';
const DB_VERSION = 1;
const STORE = 'batch';
/** The single record's key: there is at most one unfinished batch. */
const KEY = 'current';

function request<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB request failed'));
  });
}

/** IndexedDB-backed store (database `capcollector`, object store `batch`, one record). */
export function indexedDbBatchStore(factory: IDBFactory = indexedDB): BatchStore {
  let db: Promise<IDBDatabase> | null = null;
  const open = (): Promise<IDBDatabase> => {
    db ??= new Promise((resolve, reject) => {
      const req = factory.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('IndexedDB open failed'));
    });
    return db;
  };
  const tx = async (mode: IDBTransactionMode) => (await open()).transaction(STORE, mode).objectStore(STORE);
  return {
    current: async () => ((await request((await tx('readonly')).get(KEY))) as Batch | undefined) ?? null,
    save: async (batch) => void (await request((await tx('readwrite')).put(batch, KEY))),
    discard: async () => void (await request((await tx('readwrite')).delete(KEY))),
  };
}
