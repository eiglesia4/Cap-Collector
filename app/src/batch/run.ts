// Glue between the batch runner (capture/batch.ts) and the screens (CAP-84): the runner of the stored batch (built
// once, rebuilt from the store after a restart), and the end of a review in batch mode — the item is resolved and the
// batch hub opens the next one instead of the cap's Detail.
import { AnalyseResponse } from '@capcollector/shared';

import { readUseAi } from '../capture/ai-setting.js';
import { createBatchRunner, type BatchRunner } from '../capture/batch.js';
import type { CaptureSession } from '../capture/context.js';
import { newUlid } from '../capture/ulid.js';
import type { AppContext } from '../context.js';
import { uploadImage, type PutFn } from '../images/upload.js';
import { pathFor } from '../router/routes.js';
import type { BatchResolution } from './store.js';

export interface RunnerOptions {
  /** Presigned PUT; tests inject a fake. */
  readonly put?: PutFn;
  readonly newId?: () => string;
}

/** The runner of the unfinished batch, or null when there is none. */
export async function batchRunner(ctx: AppContext, options: RunnerOptions = {}): Promise<BatchRunner | null> {
  const stored = await ctx.batch.store.current();
  if (stored === null) {
    ctx.batch.runner = null;
    return null;
  }
  const running = ctx.batch.runner;
  if (running?.batch().batchId === stored.batchId) return running;
  const runner = createBatchRunner(stored, {
    store: ctx.batch.store,
    upload: (photo) => uploadImage(ctx.api, 'top', photo, options.put),
    analyse: (body) => ctx.api.request('/scans/analyse', { method: 'POST', body, schema: AnalyseResponse }),
    useAi: () => readUseAi(ctx.platform.store),
    newId: options.newId ?? (() => newUlid()),
  });
  ctx.batch.runner = runner;
  return runner;
}

/**
 * End of a review screen. For a batch item: resolve it, close the scan context and open the batch hub (true). For a
 * single capture: nothing (false), the screen goes on as before.
 */
export async function finishBatchItem(
  ctx: AppContext,
  session: CaptureSession | null | undefined,
  resolution: BatchResolution,
  unplaced: boolean,
): Promise<boolean> {
  const item = session?.batch;
  if (!item) return false;
  const runner = await batchRunner(ctx);
  await runner?.resolve(item.index, resolution, unplaced);
  ctx.capture.clear();
  ctx.navigate(pathFor('scanBatch'));
  return true;
}

/** Abandon (confirmed by the caller): the local crops go; saved caps stay saved. */
export async function abandonBatch(ctx: AppContext): Promise<void> {
  await ctx.batch.runner?.idle();
  ctx.batch.runner = null;
  await ctx.batch.store.discard();
}
