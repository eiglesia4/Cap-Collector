// Batch mode, part 3 (CAP-84; SCREENS.md § Batch mode "Batch run", "Resume", "Summary"; ADR-009 §3–5; ADR-003;
// ADR-004): the runner (order, current + 2 in flight, one analyse per cap with its own scanId and dHash, the
// intra-batch dHash guard, 503 → manual entry, failed → Retry, resume without re-analysing), the hub routing each
// outcome to screens 3/4/5 with the strip, Save / Discard advancing to the next item (no Detail, no location when
// "Propose next free pocket" is off), Skip / Stop, the banner's Abandon, and the summary with Plan albums.
import { AnalyseResponse, type AnalyseRequest, type ImageRef } from '@capcollector/shared';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { ProblemError } from '../src/api/errors';
import { memoryBatchStore, type Batch, type BatchItem, type BatchStore } from '../src/batch/store';
import { BATCH_DHASH_GUARD, createBatchRunner, PREFETCH, type BatchRunDeps } from '../src/capture/batch';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import { matchRoute } from '../src/router/routes';
import { BatchView } from '../src/screens/batch-screen';
import { batchCounts, BatchSummaryScreen } from '../src/screens/batch-summary-screen';
import { ScanReviewScreen } from '../src/screens/cap-form-screen';
import { CollectionScreen } from '../src/screens/collection-screen';
import { ScanDuplicateScreen } from '../src/screens/scan-duplicate-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const BATCH_ID = ulid(8400);
const NOW = '2026-11-21T21:00:00.000Z';
/** Distinct hashes (pairwise ≥ 16 bits apart) and one near-duplicate of H0. */
const H0 = '0000000000000000';
const NEAR_H0 = '0000000000000007'; // 3 bits from H0
const DISTINCT = ['ffffffffffffffff', '0f0f0f0f0f0f0f0f', 'f0f0f0f0f0f0f0f0', '00ff00ff00ff00ff', 'ff00ff00ff00ff00'];

const settle = async (n = 12) => {
  for (let i = 0; i < n; i++) await flush();
};

function item(index: number, dhash: string, extra: Partial<BatchItem> = {}): BatchItem {
  return {
    index,
    photo: new Blob([new Uint8Array(50)], { type: 'image/webp' }),
    dhash,
    width: 300,
    height: 300,
    state: 'waiting',
    ...extra,
  };
}

const batchOf = (items: BatchItem[], placeAsYouGo = false): Batch => ({
  batchId: BATCH_ID,
  createdAt: NOW,
  placeAsYouGo,
  items,
});

const ref = (scanId: string): ImageRef => ({ key: `u1/${scanId}/top.webp`, width: 300, height: 300 });

const answer = (scanId: string, outcome: AnalyseResponse['outcome'], extra: Partial<AnalyseResponse> = {}) =>
  AnalyseResponse.parse({ scanId, outcome, suggestions: [], ...extra });

/** Runner deps whose analyses wait until the test answers them. */
function controlledDeps(store: BatchStore = memoryBatchStore()) {
  let id = 0;
  const pending = new Map<string, { resolve: (r: AnalyseResponse) => void; reject: (e: unknown) => void }>();
  let inFlight = 0;
  let maxInFlight = 0;
  const analyse = vi.fn(
    (body: AnalyseRequest) =>
      new Promise<AnalyseResponse>((resolve, reject) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        const done =
          <T>(fn: (v: T) => void) =>
          (v: T) => {
            inFlight--;
            fn(v);
          };
        pending.set(body.scanId, { resolve: done(resolve), reject: done(reject) });
      }),
  );
  const deps: BatchRunDeps = {
    store,
    upload: vi.fn(async () => ref(`u${String(id)}`)),
    analyse,
    useAi: vi.fn(async () => true),
    newId: () => ulid(100 + id++),
  };
  /** Answer the analysis of item `index` of `runner`. */
  const reply = (
    scanId: string,
    outcome: AnalyseResponse['outcome'] | Error = 'identified',
    extra: Partial<AnalyseResponse> = {},
  ) => {
    const p = pending.get(scanId);
    if (!p) throw new Error(`no analysis pending for ${scanId}`);
    pending.delete(scanId);
    if (outcome instanceof Error) p.reject(outcome);
    else p.resolve(answer(scanId, outcome, outcome === 'identified' ? { fields: { brand: 'Mahou' } } : extra));
  };
  return { deps, analyse, reply, maxInFlight: () => maxInFlight, store };
}

const scanIdOf = (runnerBatch: Batch, index: number) => runnerBatch.items[index]?.scanId ?? '';
const states = (b: Batch) => b.items.map((i) => i.state);

describe('batch runner', () => {
  it('[T-app-150] analyses in order, at most the current item + 2 in flight, each with its own scanId and dHash', async () => {
    const { deps, analyse, reply, maxInFlight } = controlledDeps();
    const runner = createBatchRunner(batchOf([H0, ...DISTINCT].map((h, i) => item(i, h))), deps);
    expect(PREFETCH).toBe(2);
    runner.pump();
    await settle();
    expect(analyse).toHaveBeenCalledTimes(3);
    const bodies = analyse.mock.calls.map(([body]) => body);
    expect(bodies.map((b) => b.dhash)).toEqual([H0, DISTINCT[0], DISTINCT[1]]);
    expect(new Set(bodies.map((b) => b.scanId)).size).toBe(3);
    for (const [i, body] of bodies.entries()) {
      expect(body).toEqual({
        scanId: runner.batch().items[i]?.scanId,
        dhash: runner.batch().items[i]?.dhash,
        imageKeys: { top: expect.stringMatching(/^u1\/u\d+\/top\.webp$/) },
        useAi: true,
        language: 'en',
      });
    }
    // The answers arrive; nothing more starts until the current item is resolved.
    for (const i of [0, 1, 2]) reply(scanIdOf(runner.batch(), i));
    await settle();
    expect(states(runner.batch()).slice(0, 4)).toEqual(['ready', 'ready', 'ready', 'waiting']);
    expect(analyse).toHaveBeenCalledTimes(3);
    await runner.resolve(0, 'saved', true);
    await settle();
    expect(analyse).toHaveBeenCalledTimes(4);
    expect(analyse.mock.calls[3]?.[0].dhash).toBe(DISTINCT[2]);
    expect(runner.current()).toBe(1);
    expect(maxInFlight()).toBe(3);
  });

  it('[T-app-151] intra-batch guard: a near-duplicate of an earlier unresolved item waits for it, then gets its own analyse; others are not held', async () => {
    expect(BATCH_DHASH_GUARD).toBe(12);
    const { deps, analyse, reply } = controlledDeps();
    const runner = createBatchRunner(
      batchOf([item(0, H0), item(1, NEAR_H0), item(2, DISTINCT[0]!), item(3, DISTINCT[1]!)]),
      deps,
    );
    runner.pump();
    await settle();
    // Item 1 is within 12 bits of item 0 (unresolved): held. Item 2 is unrelated: analysed.
    expect(analyse.mock.calls.map(([b]) => b.dhash)).toEqual([H0, DISTINCT[0]]);
    expect(states(runner.batch())).toEqual(['analysing', 'waiting', 'analysing', 'waiting']);
    reply(scanIdOf(runner.batch(), 0));
    await settle();
    // Ready is not resolved: still held.
    expect(analyse).toHaveBeenCalledTimes(2);
    await runner.resolve(0, 'saved', false);
    await settle();
    const third = analyse.mock.calls[2]?.[0];
    expect(third?.dhash).toBe(NEAR_H0);
    expect(third?.scanId).not.toBe(scanIdOf(runner.batch(), 0));
    // A skipped earlier item does not hold the others.
    const second = controlledDeps();
    const skipping = createBatchRunner(batchOf([item(0, H0), item(1, NEAR_H0)]), second.deps);
    await skipping.skip(0);
    await settle();
    expect(second.analyse.mock.calls.map(([b]) => b.dhash)).toEqual([NEAR_H0]);
  });

  it('[T-app-155] a 503 sends that item to Manual entry; an error fails only that item (Retry re-analyses, reusing its upload)', async () => {
    const { deps, analyse, reply } = controlledDeps();
    const runner = createBatchRunner(batchOf([item(0, H0), item(1, DISTINCT[0]!), item(2, DISTINCT[1]!)]), deps);
    runner.pump();
    await settle();
    reply(scanIdOf(runner.batch(), 0), new ProblemError({ type: 'about:blank', title: 'AI unavailable', status: 503 }));
    reply(scanIdOf(runner.batch(), 1), new Error('network'));
    reply(scanIdOf(runner.batch(), 2), 'identified');
    await settle();
    expect(states(runner.batch())).toEqual(['ready', 'failed', 'ready']);
    const first = scanIdOf(runner.batch(), 0);
    expect(runner.routeOf(0)).toBe(`/new?scanId=${first}`);
    expect(runner.session(0)).toMatchObject({ scanId: first, useAi: false, batch: { index: 0, placeAsYouGo: false } });
    expect(runner.routeOf(2)).toBe('/scan/review');
    expect(runner.session(1)).toBeNull();
    expect(runner.routeOf(1)).toBeNull();

    // Retry the failed one: same scan id, no second upload.
    const failedId = scanIdOf(runner.batch(), 1);
    await runner.retry(1);
    await runner.retry(2); // not failed: nothing
    await settle();
    expect(analyse).toHaveBeenCalledTimes(4);
    expect(analyse.mock.calls[3]?.[0].scanId).toBe(failedId);
    expect(deps.upload).toHaveBeenCalledTimes(3);
    // An upload failure fails the item too.
    const up = controlledDeps();
    vi.mocked(up.deps.upload).mockRejectedValueOnce(new Error('s3'));
    const uploading = createBatchRunner(batchOf([item(0, H0)]), up.deps);
    uploading.pump();
    await uploading.idle();
    expect(states(uploading.batch())).toEqual(['failed']);
  });

  it('[T-app-156] resume after a restart: a new runner over the stored batch continues at the first unresolved item without re-analysing ready ones', async () => {
    const store = memoryBatchStore();
    const first = controlledDeps(store);
    const runner = createBatchRunner(batchOf([H0, ...DISTINCT.slice(0, 3)].map((h, i) => item(i, h))), first.deps);
    runner.pump();
    await settle();
    first.reply(scanIdOf(runner.batch(), 0));
    first.reply(scanIdOf(runner.batch(), 1));
    await settle();
    await runner.resolve(0, 'saved', true);
    await settle();
    // Item 2 was analysing and item 3 just started when the app closed.
    expect(states(runner.batch())).toEqual(['resolved', 'ready', 'analysing', 'analysing']);
    const stored = await store.current();
    expect(states(stored!)).toEqual(['resolved', 'ready', 'analysing', 'analysing']);

    const second = controlledDeps(store);
    const resumed = createBatchRunner(stored!, second.deps);
    expect(resumed.current()).toBe(1);
    expect(resumed.routeOf(1)).toBe('/scan/review');
    resumed.pump();
    await settle();
    // Item 1 is ready: never analysed again; items 2–3 are analysed again with their own scan ids.
    expect(second.analyse.mock.calls.map(([b]) => b.scanId)).toEqual([scanIdOf(stored!, 2), scanIdOf(stored!, 3)]);
    // Skip: an answer arriving after the skip is kept, but the item stays skipped.
    await resumed.skip(1);
    second.reply(scanIdOf(stored!, 2));
    await settle();
    await resumed.skip(2);
    await resumed.skip(3);
    second.reply(scanIdOf(stored!, 3));
    await resumed.idle();
    expect(states(resumed.batch())).toEqual(['resolved', 'skipped', 'skipped', 'skipped']);
    expect(resumed.current()).toBeNull();
    // Review skipped: analysed items come back ready, without another analysis.
    await resumed.reviewSkipped();
    expect(states(resumed.batch()).slice(1)).toEqual(['ready', 'ready', 'ready']);
    expect(second.analyse).toHaveBeenCalledTimes(2);
    // An item skipped before any analysis waits again and is analysed then.
    const third = controlledDeps();
    const fresh = createBatchRunner(batchOf([item(0, H0)]), third.deps);
    await fresh.skip(0);
    await fresh.reviewSkipped();
    expect(states(fresh.batch())).toEqual(['analysing']);
  });

  it('[T-app-159] Review skipped re-analyses a skipped item whose near-duplicate was saved meanwhile (same scanId, no new upload); others come back as they were', async () => {
    const { deps, analyse, reply } = controlledDeps();
    const runner = createBatchRunner(
      batchOf([item(0, H0), item(1, DISTINCT[0]!), item(2, NEAR_H0), item(3, DISTINCT[1]!)]),
      deps,
    );
    runner.pump();
    await settle();
    // Item 2 is held by item 0 (near-duplicate); 0 and 1 are analysed and answered "identified".
    reply(scanIdOf(runner.batch(), 0));
    reply(scanIdOf(runner.batch(), 1));
    await settle();
    // Skip 0 (after its analysis) → 2 is no longer held; skip 1 (unrelated); 2 is analysed and saved.
    await runner.skip(0);
    await runner.skip(1);
    await settle();
    reply(scanIdOf(runner.batch(), 2));
    reply(scanIdOf(runner.batch(), 3));
    await settle();
    await runner.resolve(2, 'saved', true);
    await runner.resolve(3, 'discarded', false);
    await runner.idle();
    expect(runner.current()).toBeNull();
    expect(analyse).toHaveBeenCalledTimes(4);
    expect(deps.upload).toHaveBeenCalledTimes(4);

    await runner.reviewSkipped();
    await settle();
    // Item 0: analysed again with its own scanId and its first upload; item 1 (nothing similar saved) is ready as it was.
    const first = scanIdOf(runner.batch(), 0);
    expect(analyse).toHaveBeenCalledTimes(5);
    expect(analyse.mock.calls[4]?.[0]).toMatchObject({ scanId: first, dhash: H0 });
    expect(deps.upload).toHaveBeenCalledTimes(4);
    expect(states(runner.batch())).toEqual(['analysing', 'ready', 'resolved', 'resolved']);
    expect(runner.batch().items[0]).not.toHaveProperty('response');
    // The server finds the saved near-duplicate by dHash → Already in collection.
    reply(first, 'duplicate', { match: { capId: ulid(7), hammingDistance: 3, by: 'dhash' } });
    await settle();
    expect(runner.routeOf(0)).toBe('/scan/duplicate');
    expect(runner.current()).toBe(0);
    expect(runner.routeOf(1)).toBe('/scan/review');
  });
});

// ── screens ──

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** A context whose API answers uploads, `/scans/analyse` from `outcomes` (by order), `POST /caps`, the cap and albums. */
async function batchContext(batch: Batch, outcomes: (AnalyseResponse['outcome'] | 'unavailable')[]) {
  const calls: Call[] = [];
  let n = 0;
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    let value: unknown;
    if (path === '/uploads') {
      value = { key: `u1/k${String(n)}/top.webp`, url: 'https://s3.test/put', expiresAt: '2030-01-01T00:00:00.000Z' };
    } else if (path === '/scans/analyse') {
      const body = opts.body as AnalyseRequest;
      const outcome = outcomes[n++] ?? 'identified';
      if (outcome === 'unavailable') throw new ProblemError({ type: 'about:blank', title: 'AI', status: 503 });
      value = {
        scanId: body.scanId,
        outcome,
        suggestions: [],
        ...(outcome === 'identified' ? { fields: { brand: 'Mahou' }, aiModel: 'haiku' } : {}),
        ...(outcome === 'duplicate' ? { match: { capId: ulid(7), hammingDistance: 2, by: 'dhash' } } : {}),
      };
    } else if (path === '/caps' && method === 'POST') {
      value = wireCap(500 + calls.length, { ...(opts.body as object) });
    } else if (path === `/caps/${ulid(7)}`) {
      value = wireCap(7, { brand: 'Mahou' });
    } else if (path.startsWith('/caps?')) {
      value = wirePage([]);
    } else if (path === '/albums') {
      value = [];
    }
    const parsed = opts.schema.safeParse(value);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const ctx: AppContext = {
    ...(await shellContext({
      api: fakeApi({ request: request as ApiClient['request'] }),
      platform: fakePlatform('native'),
    })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  await ctx.batch.store.save(batch);
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const hub = () => {
    const el = BatchView(ctx, { put });
    document.body.replaceChildren(el);
    return el;
  };
  return { ctx, calls, hub, put };
}

const lastNav = (ctx: AppContext) => vi.mocked(ctx.navigate).mock.calls.at(-1)?.[0];
const submit = (el: Element) => el.querySelector('form')!.dispatchEvent(new Event('submit', { cancelable: true }));

describe('batch run screens', () => {
  it('[T-app-152] each outcome opens its screen with the strip; Save and Discard go to the next item, never to Detail', async () => {
    const { ctx, calls, hub } = await batchContext(
      batchOf([item(0, H0), item(1, DISTINCT[0]!), item(2, DISTINCT[1]!)]),
      ['identified', 'duplicate', 'unavailable'],
    );
    hub();
    await settle();
    // One analyse per cap, never one per tray (the first three are prefetched).
    const analyses = calls.filter((c) => c.path === '/scans/analyse').map((c) => c.body as AnalyseRequest);
    expect(analyses.map((b) => b.dhash)).toEqual([H0, DISTINCT[0], DISTINCT[1]]);
    expect(new Set(analyses.map((b) => b.scanId)).size).toBe(3);
    // Item 1 → AI review, with the strip.
    expect(lastNav(ctx)).toBe('/scan/review');
    expect(ctx.capture.current()?.batch).toEqual({ batchId: BATCH_ID, index: 0, placeAsYouGo: false });
    const review = ScanReviewScreen(ctx, matchRoute('/scan/review')!);
    document.body.replaceChildren(review);
    expect(review.querySelector('[data-batch-count]')?.textContent).toBe(t('batch.position', { at: 1, total: 3 }));
    expect([...review.querySelectorAll('.batch-dot')].map((d) => (d as HTMLElement).dataset.state)).toEqual([
      'ready',
      'ready',
      'ready',
    ]);
    submit(review);
    await settle();
    // Saved without a location and without the next-free proposal (no /albums call); back to the hub, not Detail.
    const post = calls.find((c) => c.path === '/caps' && c.method === 'POST');
    expect(post?.body).not.toHaveProperty('location');
    expect(post?.body).toMatchObject({ brand: 'Mahou', dhash: H0 });
    expect(calls.some((c) => c.path === '/albums')).toBe(false);
    expect(vi.mocked(ctx.navigate).mock.calls.map(([p]) => p)).not.toContainEqual(expect.stringMatching(/^\/cap\//));
    expect(lastNav(ctx)).toBe('/scan/batch');
    expect((await ctx.batch.store.current())?.items[0]).toMatchObject({
      state: 'resolved',
      resolution: 'saved',
      unplaced: true,
    });

    // Item 2 → Already in collection, with the strip; Discard → next item.
    hub();
    await settle();
    expect(lastNav(ctx)).toBe('/scan/duplicate');
    const duplicate = ScanDuplicateScreen(ctx, matchRoute('/scan/duplicate')!);
    document.body.replaceChildren(duplicate);
    await settle();
    expect(duplicate.querySelector('[data-batch-count]')?.textContent).toBe(t('batch.position', { at: 2, total: 3 }));
    duplicate.querySelector<HTMLAnchorElement>('[data-action="discard"]')?.click();
    await settle();
    expect(lastNav(ctx)).toBe('/scan/batch');
    expect((await ctx.batch.store.current())?.items[1]).toMatchObject({ state: 'resolved', resolution: 'discarded' });

    // Item 3: the AI was unavailable (503) → Manual entry for that item; the batch went on.
    hub();
    await settle();
    expect(lastNav(ctx)).toBe(`/new?scanId=${(await ctx.batch.store.current())?.items[2]?.scanId ?? ''}`);
  });

  it('[T-app-153] with "Propose next free pocket" on, Save proposes the next free pocket as in a single capture', async () => {
    const { ctx, calls, hub } = await batchContext(batchOf([item(0, H0)], true), ['identified']);
    hub();
    await settle();
    const review = ScanReviewScreen(ctx, matchRoute('/scan/review')!);
    document.body.replaceChildren(review);
    submit(review);
    await settle();
    // The proposal looks for the default album (none here → saved without a location, as in a single capture).
    expect(calls.some((c) => c.path === '/albums')).toBe(true);
    expect(calls.some((c) => c.path === '/caps' && c.method === 'POST')).toBe(true);
    expect(lastNav(ctx)).toBe('/scan/batch');
  });

  it('[T-app-154] Skip keeps an item for later, Stop leaves the batch unfinished, Retry runs a failed item again', async () => {
    const { ctx, hub } = await batchContext(batchOf([item(0, H0), item(1, DISTINCT[0]!)]), ['identified']);
    // Item 0 identified; item 1's analyse fails once (a 500), then succeeds.
    let failOnce = true;
    const request = vi.mocked(ctx.api.request);
    const original = request.getMockImplementation()!;
    request.mockImplementation(async (path, opts) => {
      if (path === '/scans/analyse' && (opts.body as AnalyseRequest).dhash === DISTINCT[0] && failOnce) {
        failOnce = false;
        throw new ProblemError({ type: 'about:blank', title: 'Boom', status: 500 });
      }
      return original(path, opts);
    });
    hub();
    await settle();
    const review = ScanReviewScreen(ctx, matchRoute('/scan/review')!);
    document.body.replaceChildren(review);
    // Stop: back to Scan, the batch stays.
    review.querySelector<HTMLButtonElement>('[data-action="batch-stop"]')?.click();
    expect(lastNav(ctx)).toBe('/scan');
    expect(ctx.capture.current()).toBeNull();
    expect(await ctx.batch.store.current()).not.toBeNull();
    // Continue: item 0 again; Skip it.
    hub();
    await settle();
    const again = ScanReviewScreen(ctx, matchRoute('/scan/review')!);
    document.body.replaceChildren(again);
    again.querySelector<HTMLButtonElement>('[data-action="batch-skip"]')?.click();
    await settle();
    expect((await ctx.batch.store.current())?.items[0]?.state).toBe('skipped');
    // Item 1 failed: the hub says so with Retry.
    const el = hub();
    await settle();
    expect(el.querySelector('[data-failed="1"]')?.textContent).toBe(t('batch.itemFailed', { n: 2 }));
    el.querySelector<HTMLButtonElement>('[data-action="batch-retry"]')?.click();
    await settle();
    expect(lastNav(ctx)).toBe('/scan/review');
  });

  it('[T-app-157] the banner on Collection: Abandon (confirmed) deletes the local batch; saved caps stay', async () => {
    const { ctx, calls } = await batchContext(
      batchOf([item(0, H0, { state: 'resolved', resolution: 'saved' }), item(1, DISTINCT[0]!)]),
      [],
    );
    const el = CollectionScreen(ctx, matchRoute('/')!);
    document.body.replaceChildren(el);
    await settle();
    expect(el.querySelector('[data-batch-banner]')?.textContent).toContain(t('batch.banner', { at: 2, total: 2 }));
    el.querySelector<HTMLButtonElement>('[data-action="discard-batch"]')?.click();
    await settle();
    el.querySelector<HTMLButtonElement>('.sheet .button--danger')?.click();
    await settle();
    expect(await ctx.batch.store.current()).toBeNull();
    expect(ctx.batch.runner).toBeNull();
    expect(el.querySelector<HTMLElement>('[data-batch-banner]')?.hidden).toBe(true);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('[T-app-158] the summary counts each ending; Review skipped re-runs those; Plan albums only with unplaced caps; finishing deletes the batch', async () => {
    const dup = answer(ulid(1), 'duplicate', { match: { capId: ulid(7), hammingDistance: 2, by: 'dhash' } });
    const done: BatchItem[] = [
      item(0, H0, { state: 'resolved', resolution: 'saved', unplaced: true }),
      item(1, DISTINCT[0]!, { state: 'resolved', resolution: 'updated', response: dup }),
      item(2, DISTINCT[1]!, { state: 'resolved', resolution: 'discarded', response: dup }),
      item(3, DISTINCT[2]!, { state: 'resolved', resolution: 'manual' }),
      item(4, DISTINCT[3]!, { state: 'resolved', resolution: 'discarded' }),
      item(5, DISTINCT[4]!, { state: 'skipped' }),
    ];
    expect(batchCounts(batchOf(done))).toEqual({
      added: 1,
      updated: 1,
      alreadyDiscarded: 1,
      manual: 1,
      discarded: 1,
      skipped: 1,
      failed: 0,
      unplaced: 1,
    });
    const { ctx, hub } = await batchContext(batchOf(done), []);
    // The hub sends a finished batch to the summary.
    hub();
    await settle();
    expect(lastNav(ctx)).toBe('/scan/batch/summary');
    const summary = BatchSummaryScreen(ctx, matchRoute('/scan/batch/summary')!);
    document.body.replaceChildren(summary);
    await settle();
    const count = (key: string) => summary.querySelector(`[data-count="${key}"] dd`)?.textContent;
    expect([count('added'), count('already'), count('manual'), count('discarded'), count('skipped')]).toEqual([
      '1',
      '2',
      '1',
      '1',
      '1',
    ]);
    expect(summary.querySelector('[data-count="already-split"]')?.textContent).toBe(
      t('batch.alreadySplit', { updated: 1, discarded: 1 }),
    );
    // Review skipped: item 5 waits again and the hub opens.
    summary.querySelector<HTMLButtonElement>('[data-action="review-skipped"]')?.click();
    await settle();
    expect(lastNav(ctx)).toBe('/scan/batch');
    expect((await ctx.batch.store.current())?.items[5]?.state).not.toBe('skipped');

    // Plan albums → the initial layout, and the batch is deleted.
    await ctx.batch.store.save(batchOf(done));
    ctx.batch.runner = null;
    const again = BatchSummaryScreen(ctx, matchRoute('/scan/batch/summary')!);
    await settle();
    again.querySelector<HTMLButtonElement>('[data-action="plan-albums"]')?.click();
    await settle();
    expect(lastNav(ctx)).toBe('/albums/layout');
    expect(await ctx.batch.store.current()).toBeNull();

    // Every cap placed: no Plan albums; Done → Collection.
    await ctx.batch.store.save(batchOf([item(0, H0, { state: 'resolved', resolution: 'saved' })]));
    const placed = BatchSummaryScreen(ctx, matchRoute('/scan/batch/summary')!);
    await settle();
    expect(placed.querySelector('[data-action="plan-albums"]')).toBeNull();
    expect(placed.querySelector('[data-action="review-skipped"]')).toBeNull();
    placed.querySelector<HTMLButtonElement>('[data-action="batch-done"]')?.click();
    await settle();
    expect(lastNav(ctx)).toBe('/');
    expect(await ctx.batch.store.current()).toBeNull();
    // Without a batch, the summary and the hub say so.
    const none = BatchSummaryScreen(ctx, matchRoute('/scan/batch/summary')!);
    const noHub = hub();
    await settle();
    expect(none.textContent).toContain(t('batch.none'));
    expect(noHub.textContent).toContain(t('batch.none'));
  });
});
