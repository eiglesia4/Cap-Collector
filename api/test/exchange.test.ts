// Exchange requests API (CAP-44) over the in-memory repositories: register a downloaded bundle, list newest first with
// a status filter, the waiting → answered → reviewed machine, expiry computed on read, and the scan link.
// Spec: ADR-007; exchange.md § Pending requests; openapi.yaml /exchange/requests; data-model.md `EXCHANGE#` (ttl 30 d).
import { EXCHANGE_TTL_SECONDS, ExchangeRequestItem, Problem, type Scan } from '@capcollector/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handler as createH } from '../src/handlers/exchange-requests-create.js';
import { handler as listH } from '../src/handlers/exchange-requests-list.js';
import { handler as patchH } from '../src/handlers/exchange-requests-patch.js';
import { newId } from '../src/lib/ids.js';
import { setRepositories } from '../src/lib/repo/index.js';
import { createMemoryRepositories } from '../src/lib/repo/memory.js';
import type { Repositories } from '../src/lib/repo/types.js';
import { useAwsTestEnv } from './support/aws-env.js';
import { apiEvent } from './support/fixtures.js';

const UID = 'apple-sub-1';
const DHASH = 'a3f0c81e7b2d9f44';
const DAY = 24 * 3600;

let repos: Repositories;
useAwsTestEnv();
beforeEach(() => {
  repos = createMemoryRepositories();
  setRepositories(repos);
});
afterEach(() => setRepositories(undefined));

const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;
const create = (b: Record<string, unknown>, uid = UID) => createH(apiEvent({ uid, body: JSON.stringify(b) }));
const list = async (status?: string) => {
  const res = await listH(apiEvent({ uid: UID, ...(status ? { queryStringParameters: { status } } : {}) }));
  expect(res.statusCode).toBe(200);
  return json<ExchangeRequestItem[]>(res).map((i) => ExchangeRequestItem.parse(i));
};
const patch = (requestId: string, b: Record<string, unknown>) =>
  patchH(apiEvent({ uid: UID, pathParameters: { requestId }, body: JSON.stringify(b) }));

/** A stored item created `daysAgo` days ago, bypassing the handler so the clock can be in the past. */
async function storeAged(daysAgo: number, status: ExchangeRequestItem['status'] = 'waiting') {
  const createdMs = Date.now() - daysAgo * DAY * 1000;
  const item = ExchangeRequestItem.parse({
    requestId: newId(),
    createdAt: new Date(createdMs).toISOString(),
    status,
    dhash: DHASH,
    ttl: Math.floor(createdMs / 1000) + EXCHANGE_TTL_SECONDS,
  });
  await repos.exchange.create(UID, item);
  return item;
}

describe('exchange: POST/GET /exchange/requests', () => {
  it('[T-api-052] create → 201 waiting with createdAt and ttl = now + 30 d; GET lists it newest first, status filter applies', async () => {
    const before = Math.floor(Date.now() / 1000);
    const capId = newId();
    const res = await create({ requestId: newId(), dhash: DHASH, capId });
    const after = Math.floor(Date.now() / 1000);
    expect(res.statusCode).toBe(201);
    const item = ExchangeRequestItem.parse(json(res));
    expect(item).toMatchObject({ status: 'waiting', dhash: DHASH, capId });
    expect(item.provider).toBeUndefined();
    expect(item.ttl).toBeGreaterThanOrEqual(before + 30 * DAY);
    expect(item.ttl).toBeLessThanOrEqual(after + 30 * DAY);
    expect(Math.abs(Date.parse(item.createdAt) / 1000 - before)).toBeLessThan(5);

    const older = await storeAged(2);
    expect((await list()).map((i) => i.requestId)).toEqual([item.requestId, older.requestId]);
    expect(await list('waiting')).toHaveLength(2);
    expect(await list('answered')).toEqual([]);
    expect(await repos.exchange.get(UID, item.requestId)).toEqual(item);

    // Another user sees nothing; bad bodies and filters are 422 Problems.
    expect(await repos.exchange.list('someone-else')).toEqual([]);
    const bad = await create({ requestId: 'not-a-ulid', dhash: 'xyz' });
    expect(bad.statusCode).toBe(422);
    expect(
      Problem.parse(json(bad))
        .errors?.map((e) => e.path)
        .sort(),
    ).toEqual(['body.dhash', 'body.requestId']);
    expect((await listH(apiEvent({ uid: UID, queryStringParameters: { status: 'lost' } }))).statusCode).toBe(422);
    expect((await listH(apiEvent({}))).statusCode).toBe(401);
  });

  it('[T-api-053] a requestId that already exists → 409 Problem and the stored item is untouched', async () => {
    const requestId = newId();
    expect((await create({ requestId, dhash: DHASH })).statusCode).toBe(201);
    const stored = await repos.exchange.get(UID, requestId);
    const again = await create({ requestId, dhash: 'ffffffffffffffff', capId: newId() });
    expect(again.statusCode).toBe(409);
    expect(Problem.parse(json(again))).toMatchObject({ status: 409, title: 'Conflict' });
    expect(json<Problem>(again).detail).toContain(requestId);
    expect(await repos.exchange.get(UID, requestId)).toEqual(stored);
  });

  it('[T-api-056] scanId given → the scan gets exchangeRequestId (same transaction); an unknown scanId still registers, without a link', async () => {
    const scan: Scan = {
      scanId: newId(),
      ts: new Date().toISOString(),
      dhash: DHASH,
      outcome: 'unidentified',
      threshold: 10,
      aiCalled: false,
    };
    await repos.scans.put(UID, scan);
    const requestId = newId();
    const res = await create({ requestId, dhash: DHASH, scanId: scan.scanId });
    expect(res.statusCode).toBe(201);
    expect(json<ExchangeRequestItem>(res).scanId).toBe(scan.scanId);
    expect(await repos.scans.get(UID, scan.scanId)).toEqual({ ...scan, exchangeRequestId: requestId });

    const ghost = newId();
    const orphan = await create({ requestId: newId(), dhash: DHASH, scanId: ghost });
    expect(orphan.statusCode).toBe(201);
    expect(json<ExchangeRequestItem>(orphan).scanId).toBe(ghost);
    expect(await repos.scans.get(UID, ghost)).toBeUndefined();

    // Another user's scan id is not linked either (scans are looked up under the caller's partition).
    await repos.scans.put('someone-else', { ...scan, scanId: newId() });
    const theirs = (await repos.scans.list('someone-else')).items[0]!;
    expect((await create({ requestId: newId(), dhash: DHASH, scanId: theirs.scanId })).statusCode).toBe(201);
    expect((await repos.scans.get('someone-else', theirs.scanId))?.exchangeRequestId).toBeUndefined();
  });
});

describe('exchange: PATCH /exchange/requests/{requestId}', () => {
  it('[T-api-054] waiting → answered (provider required, stored as given) → reviewed; every other move is 409 naming the current status', async () => {
    const { requestId } = await storeAged(0);

    const noProvider = await patch(requestId, { status: 'answered' });
    expect(noProvider.statusCode).toBe(422);
    expect(Problem.parse(json(noProvider)).errors).toEqual([
      { path: 'body.provider', message: 'provider is required to mark answered' },
    ]);
    expect((await patch(requestId, { status: 'answered', provider: '  ' })).statusCode).toBe(422);
    expect((await patch(requestId, { status: 'reviewed', provider: 'gemini' })).statusCode).toBe(422);
    expect((await patch(requestId, { status: 'done' })).statusCode).toBe(422);

    for (const status of ['waiting', 'reviewed', 'expired']) {
      const res = await patch(requestId, { status });
      expect(res.statusCode).toBe(409);
      expect(json<Problem>(res).detail).toBe(`Exchange request is waiting; it cannot move to ${status}`);
    }

    const answered = await patch(requestId, { status: 'answered', provider: 'chatgpt' });
    expect(answered.statusCode).toBe(200);
    const a = ExchangeRequestItem.parse(json(answered));
    expect(a).toMatchObject({ status: 'answered', provider: 'chatgpt' });
    expect(a.answeredAt).toBeDefined();
    expect(await repos.exchange.get(UID, requestId)).toEqual(a);
    expect((await patch(requestId, { status: 'answered', provider: 'gemini' })).statusCode).toBe(409);

    const reviewed = await patch(requestId, { status: 'reviewed' });
    expect(reviewed.statusCode).toBe(200);
    expect(json<ExchangeRequestItem>(reviewed)).toMatchObject({
      status: 'reviewed',
      provider: 'chatgpt',
      answeredAt: a.answeredAt,
    });

    // `reviewed` is terminal.
    for (const status of ['waiting', 'answered', 'reviewed', 'expired']) {
      const res = await patch(requestId, status === 'answered' ? { status, provider: 'x' } : { status });
      expect(res.statusCode).toBe(409);
      expect(json<Problem>(res).detail).toContain('is reviewed');
    }

    expect((await patch(newId(), { status: 'reviewed' })).statusCode).toBe(404);
    expect((await patch('nope', { status: 'reviewed' })).statusCode).toBe(422);
  });

  it('[T-api-055] past ttl but not yet deleted by DynamoDB → reported as expired on read, filtered as expired, and PATCH answers 409', async () => {
    const fresh = await storeAged(29);
    const stale = await storeAged(31);
    const staleAnswered = await storeAged(45, 'answered');

    const all = await list();
    expect(all.map((i) => [i.requestId, i.status])).toEqual([
      [fresh.requestId, 'waiting'],
      [stale.requestId, 'expired'],
      [staleAnswered.requestId, 'expired'],
    ]);
    expect((await list('expired')).map((i) => i.requestId)).toEqual([stale.requestId, staleAnswered.requestId]);
    expect((await list('waiting')).map((i) => i.requestId)).toEqual([fresh.requestId]);
    expect(await list('answered')).toEqual([]);
    // Computed on read: the stored status is unchanged.
    expect((await repos.exchange.get(UID, stale.requestId))?.status).toBe('waiting');

    const res = await patch(stale.requestId, { status: 'answered', provider: 'chatgpt' });
    expect(res.statusCode).toBe(409);
    expect(json<Problem>(res).detail).toBe('Exchange request is expired; it cannot move to answered');
    expect((await patch(staleAnswered.requestId, { status: 'reviewed' })).statusCode).toBe(409);
  });
});
