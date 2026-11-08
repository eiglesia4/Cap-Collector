// Scans API (CAP-37) over the in-memory repositories: ADR-004 step 1 (dHash near-match → duplicate, AI never called),
// step 2 (vision adapter; the CAP-37 stub → 503 with the Scan still stored), step 3 (brand + variant re-check),
// useAi=false, re-identify, GET /scans paging. Spec: openapi.yaml /scans/analyse, /scans; data-model.md § Scan.
import { AnalyseResponse, type Cap, Problem, Scan } from '@capcollector/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handler as analyseH } from '../src/handlers/scans-analyse.js';
import { handler as listH } from '../src/handlers/scans-list.js';
import { newId } from '../src/lib/ids.js';
import { setRepositories } from '../src/lib/repo/index.js';
import { createMemoryRepositories } from '../src/lib/repo/memory.js';
import type { Repositories } from '../src/lib/repo/types.js';
import { hammingDistance, nearestByHash } from '../src/lib/scans.js';
import {
  type IdentifyResult,
  StubVisionAdapter,
  type VisionAdapter,
  getVisionAdapter,
  setVisionAdapter,
} from '../src/lib/vision/adapter.js';
import { useAwsTestEnv } from './support/aws-env.js';
import { apiEvent, makeCap, makeHistory } from './support/fixtures.js';

const UID = 'apple-sub-1';
const TOP = 'a3f0c81e7b2d9f44';
/** `TOP` with the lowest `n` bits flipped: Hamming distance exactly `n`. */
const flip = (hash: string, n: number) =>
  (BigInt(`0x${hash}`) ^ ((1n << BigInt(n)) - 1n)).toString(16).padStart(16, '0');

let repos: Repositories;
useAwsTestEnv();
beforeEach(() => {
  repos = createMemoryRepositories();
  setRepositories(repos);
});
afterEach(() => {
  setRepositories(undefined);
  setVisionAdapter(undefined);
});

/** A spy adapter answering `result`; the tests assert whether it was called. */
function fakeVision(result: IdentifyResult = { status: 'unavailable', reason: 'test' }) {
  const identify = vi.fn<VisionAdapter['identify']>(async () => result);
  setVisionAdapter({ identify });
  return identify;
}

async function storeCap(over: Partial<Cap> = {}): Promise<Cap> {
  const cap = makeCap({ location: undefined, ...over });
  await repos.caps.put(UID, { cap, history: makeHistory(cap.capId, 'created', cap.createdAt) });
  return cap;
}

const keys = (uid = UID) => ({ top: `${uid}/${newId()}/top.webp` });
const body = (over: Record<string, unknown> = {}) => ({ scanId: newId(), dhash: TOP, imageKeys: keys(), ...over });
const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;
const call = (b: Record<string, unknown>, uid = UID) => analyseH(apiEvent({ uid, body: JSON.stringify(b) }));
const scans = async () => (await repos.scans.list(UID, { limit: 200 })).items;

describe('scans: POST /scans/analyse', () => {
  it('[T-api-042] dHash within the threshold → duplicate by dhash and the vision adapter is NOT called; distance 11 is not a duplicate', async () => {
    expect(hammingDistance(TOP, TOP)).toBe(0);
    expect(hammingDistance(TOP, flip(TOP, 10))).toBe(10);
    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);

    const near = await storeCap({ dhash: flip(TOP, 10) });
    await storeCap({ dhash: flip(TOP, 30) });
    await storeCap({ dhash: undefined, dhashUnderside: undefined });
    const identify = fakeVision();

    const res = await call(body());
    expect(res.statusCode).toBe(200);
    const out = AnalyseResponse.parse(json(res));
    expect(out).toMatchObject({ outcome: 'duplicate', match: { capId: near.capId, hammingDistance: 10, by: 'dhash' } });
    expect(identify).not.toHaveBeenCalled();
    expect(await scans()).toEqual([
      expect.objectContaining({ outcome: 'duplicate', bestDistance: 10, threshold: 10, aiCalled: false }),
    ]);

    // Underside near-match counts too (both sides hashed), and the closer side wins.
    expect(nearestByHash([{ capId: 'x', dhash: flip(TOP, 40), dhashUnderside: TOP }], TOP, TOP)).toEqual({
      capId: 'x',
      distance: 0,
    });
    expect(nearestByHash([{ capId: 'x', dhashUnderside: TOP }], TOP, undefined)).toBeUndefined();

    // Tombstoned caps are not candidates, and distance threshold + 1 is not a duplicate.
    setRepositories((repos = createMemoryRepositories()));
    const gone = await storeCap({ dhash: TOP });
    await repos.caps.softDelete(UID, { cap: gone }, makeHistory(gone.capId, 'deleted'));
    await storeCap({ dhash: flip(TOP, 11) });
    const far = await call(body({ useAi: false }));
    expect(json<{ outcome: string }>(far).outcome).toBe('unidentified');
    expect(identify).not.toHaveBeenCalled();
  });

  it('[T-api-043] no near-match + CAP_VISION=off (stub adapter) → 503 Problem; the Scan is stored with aiCalled, no aiModel, unidentified; nothing else written', async () => {
    process.env.CAP_VISION = 'off';
    expect(getVisionAdapter()).toBeInstanceOf(StubVisionAdapter);
    await storeCap({ dhash: flip(TOP, 40) });
    const before = await repos.caps.listAll(UID, { includeDeleted: true });

    const b = body();
    const res = await call(b);
    expect(res.statusCode).toBe(503);
    expect(res.headers?.['content-type']).toBe('application/problem+json');
    expect(Problem.parse(json(res))).toMatchObject({ status: 503, title: 'Service unavailable' });

    const [scan] = await scans();
    expect(Scan.parse(scan)).toMatchObject({
      scanId: b.scanId,
      outcome: 'unidentified',
      aiCalled: true,
      bestDistance: 40,
      threshold: 10,
      dhash: TOP,
    });
    expect(scan).not.toHaveProperty('aiModel');
    expect(scan).not.toHaveProperty('match');
    expect(await repos.caps.listAll(UID, { includeDeleted: true })).toEqual(before);
  });

  it('[T-api-044] useAi=false → unidentified with empty suggestions, adapter not called; foreign image keys → 422 with nothing stored', async () => {
    const identify = fakeVision();
    const res = await call(body({ useAi: false, dhashUnderside: flip(TOP, 3) }));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toMatchObject({ outcome: 'unidentified', suggestions: [] });
    expect(identify).not.toHaveBeenCalled();
    const [scan] = await scans();
    expect(scan).toMatchObject({ outcome: 'unidentified', aiCalled: false, dhashUnderside: flip(TOP, 3) });
    expect(scan).not.toHaveProperty('bestDistance');

    const bad = await call(body({ imageKeys: { top: keys('mallory').top, underside: 'x/y.webp' } }));
    expect(bad.statusCode).toBe(422);
    expect(json<Problem>(bad).errors?.map((e) => e.path)).toEqual(['body.imageKeys.top', 'body.imageKeys.underside']);
    expect((await call({ ...body(), dhash: 'XYZ' })).statusCode).toBe(422);
    expect(await scans()).toHaveLength(1);
    expect(identify).not.toHaveBeenCalled();
  });

  it('[T-api-045] re-identify skips its own capId: a cap with the same hash is not its own duplicate', async () => {
    const self = await storeCap({ dhash: TOP });
    const identify = fakeVision({ status: 'unidentified', aiModel: 'fake-model', suggestions: ['Mahou'] });

    const res = await call(body({ capId: self.capId, known: { brand: 'Mahou' } }));
    expect(json(res)).toMatchObject({ outcome: 'unidentified', aiModel: 'fake-model', suggestions: ['Mahou'] });
    expect(identify).toHaveBeenCalledWith(expect.objectContaining({ known: { brand: 'Mahou' } }));
    // The same request without capId finds it.
    expect(json(await call(body()))).toMatchObject({ outcome: 'duplicate', match: { capId: self.capId } });
    expect(identify).toHaveBeenCalledTimes(1);
  });

  it('[T-api-046] brand re-check: an identified brand+variant already in the collection → duplicate by brand; a new one → identified with tokens and cost stored', async () => {
    const mahou = await storeCap({ brand: 'Mahou', variant: 'Clásica', dhash: flip(TOP, 20) });
    await storeCap({ brand: 'Mahou', variant: 'Sin', dhash: undefined });
    const usage = { inputTokens: 1200, outputTokens: 80, costEstimateUsd: 0.0004 };
    const identify = fakeVision({
      status: 'identified',
      aiModel: 'fake-model',
      fields: { brand: 'MAHOU', variant: 'clasica', country: 'ES' },
      confidence: { brand: 0.9 },
      aiConfidence: 0.9,
      usage,
    });
    const dup = json<AnalyseResponse>(await call(body()));
    expect(dup).toMatchObject({
      outcome: 'duplicate',
      match: { capId: mahou.capId, hammingDistance: 20, by: 'brand' },
      fields: { brand: 'MAHOU', variant: 'clasica' },
      aiModel: 'fake-model',
      confidence: { brand: 0.9 },
    });
    expect(identify).toHaveBeenCalledTimes(1);

    // Same brand, a variant not in the collection (and no variant at all) → identified.
    identify.mockResolvedValue({ status: 'identified', aiModel: 'fake-model', fields: { brand: 'Mahou' }, usage });
    const fresh = json<AnalyseResponse>(await call(body()));
    expect(fresh).toMatchObject({ outcome: 'identified', fields: { brand: 'Mahou' } });
    expect(fresh).not.toHaveProperty('match');

    // A brand match on a cap without a stored hash reports the maximal distance.
    identify.mockResolvedValue({
      status: 'identified',
      aiModel: 'fake-model',
      fields: { brand: 'Mahou', variant: 'Sin' },
    });
    expect(json<AnalyseResponse>(await call(body())).match).toMatchObject({ hammingDistance: 64, by: 'brand' });

    const stored = await scans();
    expect(stored.map((s) => s.outcome)).toEqual(['duplicate', 'identified', 'duplicate']);
    // Newest first: [3rd brand dup, 2nd identified, 1st brand dup].
    expect(stored[2]).toMatchObject({
      aiCalled: true,
      aiModel: 'fake-model',
      aiConfidence: 0.9,
      ...usage,
      match: { by: 'brand' },
    });
    expect(stored[1]).toMatchObject({ aiCalled: true, aiModel: 'fake-model', ...usage });
    expect(stored[0]).toMatchObject({ aiCalled: true, match: { capId: expect.any(String), by: 'brand' } });
    expect(stored[0]).not.toHaveProperty('inputTokens');
  });
});

describe('scans: GET /scans', () => {
  it('[T-api-047] newest first, limit ≤ 200, cursor continues without gaps; another user sees nothing', async () => {
    fakeVision();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const b = body({ useAi: false });
      ids.push(b.scanId);
      await call(b);
    }
    const page = (q: Record<string, string>, uid = UID) =>
      listH(apiEvent({ uid, queryStringParameters: q })).then((r) => ({
        status: r.statusCode,
        ...json<{ items: Scan[]; cursor?: string }>(r),
      }));

    const first = await page({ limit: '2' });
    expect(first.items.map((s) => s.scanId)).toEqual([ids[4], ids[3]]);
    const second = await page({ limit: '2', cursor: first.cursor! });
    const third = await page({ limit: '2', cursor: second.cursor! });
    expect([...second.items, ...third.items].map((s) => s.scanId)).toEqual([ids[2], ids[1], ids[0]]);
    expect(third.cursor).toBeUndefined();
    for (const s of first.items) expect(Scan.safeParse(s).success).toBe(true);

    expect((await page({})).items).toHaveLength(5);
    expect((await page({ limit: '200' })).status).toBe(200);
    expect((await page({ limit: '201' })).status).toBe(422);
    expect((await page({ cursor: 'garbage' })).status).toBe(400);
    expect((await page({}, 'someone-else')).items).toEqual([]);
  });
});
