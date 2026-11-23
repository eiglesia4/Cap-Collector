// The batch run (CAP-84; ADR-009 §3–5; SCREENS.md § Batch mode "Batch run", "Resume"): each crop of a tray becomes an
// ordinary scan — upload top → `POST /scans/analyse` with its own `scanId` and dHash (ADR-004: the hash check before
// any AI, per cap; never one call per tray) — and is reviewed on screens 3/4/5 one after the other. No underside prompt
// (the review keeps "Add underside photo"). Pure orchestration over injected effects, like flow.ts.
//
// - Prefetch: while the user reviews the current item, up to PREFETCH items after it are analysed (≤ 3 in flight).
// - Intra-batch guard (ADR-009 §4): an item is not analysed while an **earlier, unresolved** item of the batch is within
//   Hamming BATCH_DHASH_GUARD of it. The server cannot know that earlier cap yet (it is not saved), so analysing early
//   would spend an AI call and miss "Already in collection"; once the earlier item is resolved, the item is analysed
//   and the server answers Already by itself. The guard is 12, wider than the server's default threshold of 10 on
//   purpose: a false hold only costs a little waiting, a miss costs an AI call and a duplicate. "Unresolved" means
//   waiting, analysing, ready or failed; a skipped item does not hold the others (the user put it aside).
// - A 503 (AI unavailable) → the item is `ready` for Manual entry, as in a single capture; an upload or analyse error
//   → `failed`, with Retry on that item; the batch goes on.
// - Every change is written to the BatchStore, so a restart resumes at the first unresolved item; `ready` items keep
//   their scan and answer and are never analysed again. An item interrupted while `analysing` is analysed again.
// - "Review skipped" (CAP-85): an item skipped after its analysis comes back `ready` with its answer, unless a cap of
//   this batch saved meanwhile (`saved` / `manual`) is within the guard distance of it — the skipped item does not
//   hold the guard, so a near-duplicate may have been saved after it. Then it is analysed again (same scanId, same
//   upload) and the server answers Already in collection from the dHash, without an AI call.
import type { AnalyseRequest, AnalyseResponse, ImageRef } from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import type { Batch, BatchItem, BatchResolution, BatchStore } from '../batch/store.js';
import { hammingDistance } from '../images/dhash.js';
import type { CapPhoto } from '../images/resize.js';
import type { CaptureSession } from './context.js';
import { manualEntryPath, routeFor } from './flow.js';
import { language } from '../i18n/i18n.js';

/** Client-side intra-batch duplicate guard (ADR-009 §4): wider than the server's default threshold (10). */
export const BATCH_DHASH_GUARD = 12;
/** Items analysed ahead of the current one (ADR-009 §4: "up to the next 2"). */
export const PREFETCH = 2;

export interface BatchRunDeps {
  readonly store: BatchStore;
  upload(photo: CapPhoto): Promise<ImageRef>;
  analyse(body: AnalyseRequest): Promise<AnalyseResponse>;
  useAi(): Promise<boolean>;
  newId(): string;
}

export interface BatchRunner {
  batch(): Batch;
  /** Index of the item to review now (first neither resolved nor skipped); null when every item is done. */
  current(): number | null;
  /** Start every analysis the window and the guard allow. */
  pump(): void;
  subscribe(listener: (batch: Batch) => void): () => void;
  /** The scan context of a `ready` item, for screens 3/4/5. */
  session(index: number): CaptureSession | null;
  /** Where a `ready` item is reviewed (Already / AI review / Manual entry). */
  routeOf(index: number): string | null;
  resolve(index: number, resolution: BatchResolution, unplaced: boolean): Promise<void>;
  skip(index: number): Promise<void>;
  retry(index: number): Promise<void>;
  /** "Review skipped": skipped items wait again, in order. */
  reviewSkipped(): Promise<void>;
  /** Resolves when pending writes and analyses have settled (tests, Stop). */
  idle(): Promise<void>;
}

const DONE: readonly BatchItem['state'][] = ['resolved', 'skipped'];

function unavailable(error: unknown): boolean {
  return (error instanceof ProblemError || error instanceof HttpError) && error.status === 503;
}

export function createBatchRunner(initial: Batch, deps: BatchRunDeps): BatchRunner {
  // An item cut off while analysing (app closed) is analysed again; `ready` ones keep their answer.
  let batch: Batch = {
    ...initial,
    items: initial.items.map((item) => (item.state === 'analysing' ? { ...item, state: 'waiting' as const } : item)),
  };
  const listeners = new Set<(batch: Batch) => void>();
  const inFlight = new Map<number, Promise<void>>();
  let writes: Promise<void> = Promise.resolve();

  function update(index: number, change: Partial<BatchItem> | ((item: BatchItem) => BatchItem)): void {
    const apply = typeof change === 'function' ? change : (item: BatchItem) => ({ ...item, ...change });
    batch = { ...batch, items: batch.items.map((item) => (item.index === index ? apply(item) : item)) };
    const snapshot = batch;
    writes = writes.then(() => deps.store.save(snapshot)).catch(() => undefined);
    for (const listener of listeners) listener(batch);
  }

  const item = (index: number) => batch.items.find((i) => i.index === index);

  function current(): number | null {
    return batch.items.find((i) => !DONE.includes(i.state))?.index ?? null;
  }

  /** An earlier item, not yet resolved or skipped, whose photo is a near-duplicate of `it`. */
  function held(it: BatchItem): boolean {
    return batch.items.some(
      (other) =>
        other.index < it.index &&
        !DONE.includes(other.state) &&
        hammingDistance(other.dhash, it.dhash) <= BATCH_DHASH_GUARD,
    );
  }

  /** The analysis outcome; the state moves on only if the item is still being analysed (Skip may have come first). */
  const settle = (index: number, change: Partial<BatchItem>, state: BatchItem['state']) =>
    update(index, item(index)?.state === 'analysing' ? { ...change, state } : change);

  async function analyse(index: number): Promise<void> {
    const start = item(index);
    if (!start) return;
    const scanId = start.scanId ?? deps.newId();
    update(index, { state: 'analysing', scanId });
    try {
      const photo: CapPhoto = { blob: start.photo, width: start.width, height: start.height, dhash: start.dhash };
      const ref = start.ref ?? (await deps.upload(photo));
      update(index, { ref });
      const body: AnalyseRequest = {
        scanId,
        dhash: start.dhash,
        imageKeys: { top: ref.key },
        useAi: await deps.useAi(),
        language: language(),
      };
      try {
        const response = await deps.analyse(body);
        settle(index, { response }, 'ready');
      } catch (error) {
        if (!unavailable(error)) throw error;
        settle(index, { unavailable: true }, 'ready');
      }
    } catch {
      settle(index, {}, 'failed');
    }
  }

  function pump(): void {
    const at = current();
    if (at === null) return;
    const window = batch.items.filter((i) => i.index >= at && !DONE.includes(i.state)).slice(0, PREFETCH + 1);
    for (const it of window) {
      if (it.state !== 'waiting' || inFlight.has(it.index) || held(it)) continue;
      const run = analyse(it.index).finally(() => {
        inFlight.delete(it.index);
        pump();
      });
      inFlight.set(it.index, run);
    }
  }

  return {
    batch: () => batch,
    current,
    pump,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    session(index) {
      const it = item(index);
      if (!it || it.state !== 'ready' || it.scanId === undefined || it.ref === undefined) return null;
      return {
        scanId: it.scanId,
        useAi: !it.unavailable,
        top: {
          photo: { blob: it.photo, width: it.width, height: it.height, dhash: it.dhash },
          ref: it.ref,
        },
        ...(it.response ? { response: it.response } : {}),
        batch: { batchId: batch.batchId, index, placeAsYouGo: batch.placeAsYouGo },
      };
    },
    routeOf(index) {
      const it = item(index);
      if (!it || it.state !== 'ready' || it.scanId === undefined) return null;
      return it.response && !it.unavailable ? routeFor(it.response) : manualEntryPath(it.scanId);
    },
    async resolve(index, resolution, unplaced) {
      update(index, { state: 'resolved', resolution, ...(unplaced ? { unplaced: true as const } : {}) });
      pump();
      await writes;
    },
    async skip(index) {
      update(index, { state: 'skipped' });
      pump();
      await writes;
    },
    async retry(index) {
      if (item(index)?.state !== 'failed') return;
      update(index, { state: 'waiting' });
      pump();
      await writes;
    },
    async reviewSkipped() {
      // An item skipped after its analysis keeps its scan and answer: it is ready again, not re-analysed — unless a
      // near-duplicate was saved since (CAP-85): then its answer is stale and it is analysed again.
      const saved = batch.items.filter(
        (o) => o.state === 'resolved' && (o.resolution === 'saved' || o.resolution === 'manual'),
      );
      for (const it of batch.items) {
        if (it.state !== 'skipped') continue;
        const analysed =
          it.scanId !== undefined && it.ref !== undefined && (it.response !== undefined || it.unavailable);
        const stale = analysed && saved.some((o) => hammingDistance(o.dhash, it.dhash) <= BATCH_DHASH_GUARD);
        if (stale) {
          // Keep scanId and ref (no second upload); drop the old answer.
          update(it.index, ({ response: _old, unavailable: _was, ...rest }) => ({ ...rest, state: 'waiting' }));
        } else {
          update(it.index, { state: analysed ? 'ready' : 'waiting' });
        }
      }
      pump();
      await writes;
    },
    async idle() {
      while (inFlight.size > 0) await Promise.all([...inFlight.values()]);
      await writes;
    },
  };
}
