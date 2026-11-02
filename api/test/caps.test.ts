// Caps API handlers (CAP-18) over the in-memory repositories: CRUD round trip, history, strict input, PATCH semantics,
// list filters / search / sort / cursor. Spec: openapi.yaml /caps*, ADR-006, data-model.md.
import type { Cap, CapHistory } from '@capcollector/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handler as createH } from '../src/handlers/caps-create.js';
import { handler as deleteH } from '../src/handlers/caps-delete.js';
import { handler as getH } from '../src/handlers/caps-get.js';
import { handler as historyH } from '../src/handlers/caps-history.js';
import { handler as listH } from '../src/handlers/caps-list.js';
import { handler as patchH } from '../src/handlers/caps-patch.js';
import { CapListQuery, TOTAL_LIMIT, encodeListCursor, listCaps, matchesQuery } from '../src/lib/caps.js';
import { newId } from '../src/lib/ids.js';
import { setRepositories } from '../src/lib/repo/index.js';
import { createMemoryRepositories } from '../src/lib/repo/memory.js';
import type { Repositories } from '../src/lib/repo/types.js';
import { after } from '../src/lib/time.js';
import { FIXTURE_CAP, apiEvent, makeCap, makeHistory, pocket } from './support/fixtures.js';

const UID = 'apple-sub-1';
let repos: Repositories;

beforeEach(() => {
  repos = createMemoryRepositories();
  setRepositories(repos);
});
afterEach(() => setRepositories(undefined));

/** A repository-written cap with nothing but brand + location (no fixture country/type/year/tags/trade). */
function bare(over: Parameters<typeof makeCap>[0]): Cap {
  const c: Cap = { ...makeCap(over), tags: [], quantity: 1, forTrade: 0 };
  for (const k of ['variant', 'producer', 'country', 'type', 'year', 'textOnCap', 'description'] as const) delete c[k];
  return c;
}

const IMAGES = { top: { key: 'u/x/top.webp', width: 800, height: 800 } };
const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;

const create = (body: Record<string, unknown>, uid = UID) =>
  createH(apiEvent({ uid, routeKey: 'POST /caps', body: JSON.stringify({ images: IMAGES, ...body }) }));
const get = (capId: string, uid = UID) => getH(apiEvent({ uid, pathParameters: { capId } }));
const patch = (capId: string, body: Record<string, unknown>, uid = UID) =>
  patchH(apiEvent({ uid, pathParameters: { capId }, body: JSON.stringify(body) }));
const del = (capId: string, uid = UID) => deleteH(apiEvent({ uid, pathParameters: { capId } }));
const history = (capId: string, uid = UID) => historyH(apiEvent({ uid, pathParameters: { capId } }));
const list = (query: Record<string, string> = {}, uid = UID) => listH(apiEvent({ uid, queryStringParameters: query }));

describe('caps API', () => {
  it('[T-api-017] create → get → patch → delete round trip with history entries; 404 after delete', async () => {
    const res = await create({ brand: 'Mahou', variant: 'Clásica', country: 'ES', quantity: 3, forTrade: 1 });
    expect(res.statusCode).toBe(201);
    const cap = json<Cap>(res);
    expect(cap.capId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(cap).toMatchObject({ status: 'complete', source: 'manual', brand: 'Mahou', tags: [], quantity: 3 });
    expect(cap.createdAt).toBe(cap.updatedAt);
    expect(json<Cap>(await get(cap.capId))).toEqual(cap);

    const flagged = json<Cap>(await create({ brand: 'Estrella', status: 'needsReview', source: 'external:chatgpt' }));
    expect(flagged).toMatchObject({ status: 'needsReview', source: 'external:chatgpt' });

    const p = await patch(cap.capId, { variant: 'Sin', year: 2024, source: 'bedrock:anthropic.claude-haiku' });
    expect(p.statusCode).toBe(200);
    const patched = json<Cap>(p);
    expect(patched).toMatchObject({ variant: 'Sin', year: 2024, quantity: 3, forTrade: 1, source: 'manual' });
    expect(Date.parse(patched.updatedAt)).toBeGreaterThan(Date.parse(cap.updatedAt));

    expect((await del(cap.capId)).statusCode).toBe(204);
    expect((await get(cap.capId)).statusCode).toBe(404);
    expect((await patch(cap.capId, { variant: 'X' })).statusCode).toBe(404);
    // Idempotent delete: 204 again, no second history entry.
    expect((await del(cap.capId)).statusCode).toBe(204);

    const h = json<CapHistory[]>(await history(cap.capId));
    expect(h.map((e) => e.action)).toEqual(['deleted', 'updated', 'created']); // newest first
    expect(h[1]).toMatchObject({
      source: 'bedrock:anthropic.claude-haiku',
      changes: [
        { field: 'variant', from: 'Clásica', to: 'Sin' },
        { field: 'year', to: 2024 },
      ],
    });
    expect(h[0]?.changes).toEqual([{ field: 'deletedAt', to: h[0]?.ts }]);
    expect(h[2]).toMatchObject({ action: 'created', source: 'manual', ts: cap.createdAt });

    // Unknown ids and other users' caps are 404 everywhere.
    const unknown = newId();
    for (const r of [
      await get(unknown),
      await del(unknown),
      await history(unknown),
      await get(flagged.capId, 'other'),
    ]) {
      expect(r.statusCode).toBe(404);
    }
    expect((await history(cap.capId, 'other')).statusCode).toBe(404);
    expect((await get('not-a-ulid')).statusCode).toBe(422);
  });

  it('[T-api-018] list: filters, accent-insensitive q, location-code search, sort orders, cursor continuity, total', async () => {
    const mk = async (body: Record<string, unknown>) => json<Cap>(await create(body));
    const mahou = await mk({
      brand: 'Mahou',
      variant: 'Clásica',
      country: 'ES',
      type: 'beer',
      year: 2020,
      tags: ['Lager'],
    });
    const estrella = await mk({
      brand: 'Estrella Galicia',
      country: 'ES',
      type: 'beer',
      year: 1995,
      forTrade: 1,
      quantity: 2,
    });
    const coke = await mk({ brand: 'Coca-Cola', country: 'US', type: 'soft drink', textOnCap: 'Drink Coca·Cola' });
    const kronen = await mk({ brand: 'Kronenbourg', producer: 'Brasseries Kronenbourg', status: 'needsReview' });
    const gone = await mk({ brand: 'Aguila' });
    await del(gone.capId);
    // A located cap (V3 path) written straight through the repository, to exercise the location-code search.
    const albumId = newId();
    await repos.albums.put(UID, {
      albumId,
      letter: 'A',
      name: 'GRANDE',
      kind: 'album',
      sheets: 10,
      cols: 6,
      rows: 7,
      createdAt: FIXTURE_CAP.createdAt,
      updatedAt: FIXTURE_CAP.createdAt,
    });
    const placed = bare({ brand: 'Alhambra', location: pocket(3, 17) });
    await repos.caps.put(UID, { cap: placed, albumId, history: makeHistory(placed.capId, 'created') });
    const boxed = bare({ brand: 'San Miguel', location: { kind: 'box', album: 'B' } });
    await repos.caps.put(UID, { cap: boxed, history: makeHistory(boxed.capId, 'created') });

    const ids = async (q: Record<string, string>) => json<{ items: Cap[] }>(await list(q)).items.map((c) => c.capId);

    // Default sort: brand A→Z, accent/case-insensitive; tombstones excluded unless asked.
    const all = json<{ items: Cap[]; total: number }>(await list());
    expect(all.items.map((c) => c.brand)).toEqual([
      'Alhambra',
      'Coca-Cola',
      'Estrella Galicia',
      'Kronenbourg',
      'Mahou',
      'San Miguel',
    ]);
    expect(all.total).toBe(6);
    expect(await ids({ includeDeleted: 'true', q: 'aguila' })).toEqual([gone.capId]);

    expect(await ids({ status: 'needsReview' })).toEqual([kronen.capId]);
    expect(await ids({ country: 'ES', sort: 'brand' })).toEqual([estrella.capId, mahou.capId]);
    expect(await ids({ type: 'soft drink' })).toEqual([coke.capId]);
    expect(await ids({ tag: 'lager' })).toEqual([mahou.capId]);
    expect(await ids({ forTrade: 'true' })).toEqual([estrella.capId]);
    expect((await ids({ forTrade: 'false' })).length).toBe(5);

    // q: brand/variant/producer/textOnCap/tags, accents and case ignored on both sides.
    expect(await ids({ q: 'CLASICA' })).toEqual([mahou.capId]);
    expect(await ids({ q: 'brasseries' })).toEqual([kronen.capId]);
    expect(await ids({ q: 'cocacola' })).toEqual([coke.capId]);
    expect(await ids({ q: 'estrella gal' })).toEqual([estrella.capId]);
    expect(await ids({ q: 'LAGER' })).toEqual([mahou.capId]);
    expect(await ids({ q: 'A·3·17' })).toEqual([placed.capId]);
    expect(await ids({ q: 'a.3.17' })).toEqual([placed.capId]);
    // A bare letter is both a box code and free text: San Miguel (no "b" in its text) matches only as box B.
    expect(await ids({ q: 'B' })).toContain(boxed.capId);
    expect(matchesQuery(boxed, 'C')).toBe(false);
    expect(await ids({ q: '·' })).toEqual([]);
    expect(matchesQuery(placed, 'A·3·18')).toBe(false);

    // Sorts.
    expect(
      json<{ items: Cap[] }>(await list({ sort: 'newest' }))
        .items.slice(0, 2)
        .map((c) => c.capId),
    ).toEqual([kronen.capId, coke.capId]);
    const byYear = json<{ items: Cap[] }>(await list({ sort: 'year' })).items.map((c) => c.year ?? null);
    expect(byYear.slice(0, 2)).toEqual([1995, 2020]);
    expect(byYear.slice(2).every((y) => y === null)).toBe(true);
    const byCountry = json<{ items: Cap[] }>(await list({ sort: 'country' })).items.map((c) => c.country ?? '-');
    expect(byCountry).toEqual(['ES', 'ES', 'US', '-', '-', '-']);

    // Cursor continuity: pages of 2 for every sort walk the same items once, in the same order as one big page.
    for (const sort of ['brand', 'newest', 'country', 'year']) {
      const whole = await ids({ sort, limit: '200' });
      const walked: string[] = [];
      let cursor: string | undefined;
      do {
        const page = json<{ items: Cap[]; cursor?: string }>(
          await list({ sort, limit: '2', ...(cursor ? { cursor } : {}) }),
        );
        expect(page.items.length).toBeLessThanOrEqual(2);
        walked.push(...page.items.map((c) => c.capId));
        cursor = page.cursor;
      } while (cursor);
      expect(walked).toEqual(whole);
    }
    // A cursor survives the deletion of the item it points at.
    const first = json<{ items: Cap[]; cursor: string }>(await list({ limit: '2' }));
    await del(first.items[1]!.capId);
    const next = json<{ items: Cap[] }>(await list({ limit: '2', cursor: first.cursor }));
    expect(next.items.map((c) => c.brand)).toEqual(['Estrella Galicia', 'Kronenbourg']);

    // Bad cursors, sort mismatch and limits.
    expect((await list({ cursor: 'garbage' })).statusCode).toBe(400);
    expect((await list({ cursor: Buffer.from('{"s":"brand"}').toString('base64url') })).statusCode).toBe(400);
    expect((await list({ sort: 'year', cursor: encodeListCursor('brand', mahou) })).statusCode).toBe(400);
    expect((await list({ limit: '201' })).statusCode).toBe(422);
    expect((await list({ limit: '0' })).statusCode).toBe(422);
    expect((await list({ forTrade: 'yes' })).statusCode).toBe(422);
    expect((await list({ sort: 'price' })).statusCode).toBe(422);
    expect((await list({}, '')).statusCode).toBe(401);
  });

  it('[T-api-019] strict input: unknown field, location in V1 and forTrade > quantity → 422 Problem; nothing written', async () => {
    const problems = [
      await create({ brand: 'Mahou', colour: 'red' }),
      await create({ brand: 'Mahou', location: { kind: 'album', album: 'A', sheet: 1, pocket: 1 } }),
      await create({ brand: 'Mahou', quantity: 1, forTrade: 2 }),
      await create({ brand: '' }),
      await createH(apiEvent({ uid: UID, body: JSON.stringify({ brand: 'NoImages' }) })),
    ];
    for (const p of problems) {
      expect(p.statusCode).toBe(422);
      expect(p.headers?.['content-type']).toBe('application/problem+json');
    }
    expect(json<{ errors: { path: string }[] }>(problems[1]!).errors.map((e) => e.path)).toEqual(['body.location']);
    expect(json<{ errors: { path: string }[] }>(problems[2]!).errors.map((e) => e.path)).toEqual(['body.forTrade']);
    expect(json<{ total: number }>(await list()).total).toBe(0);

    const cap = json<Cap>(await create({ brand: 'Mahou', quantity: 2, forTrade: 1 }));
    expect((await patch(cap.capId, { colour: 'red' })).statusCode).toBe(422);
    expect((await patch(cap.capId, { location: { kind: 'box', album: 'B' } })).statusCode).toBe(422);
    const over = await patch(cap.capId, { forTrade: 3 });
    expect(over.statusCode).toBe(422);
    expect(json<{ errors: { path: string }[] }>(over).errors.map((e) => e.path)).toEqual(['body.forTrade']);
    expect((await patch(cap.capId, { variantOf: cap.capId })).statusCode).toBe(422);
    expect((await patch(cap.capId, { capId: newId() })).statusCode).toBe(422);
    expect(json<Cap>(await get(cap.capId))).toEqual(cap);
    expect(json<CapHistory[]>(await history(cap.capId))).toHaveLength(1);
  });

  it('[T-api-022] PATCH changes only the fields sent (zod defaults never overwrite); a no-op patch writes nothing', async () => {
    const cap = json<Cap>(
      await create({ brand: 'Mahou', tags: ['spain', 'lager'], quantity: 4, forTrade: 2, source: 'external:claude' }),
    );
    const p = json<Cap>(await patch(cap.capId, { brand: 'Mahou Cinco Estrellas' }));
    // CapPatch.parse would have injected tags: [], quantity: 1, forTrade: 0, source: 'manual'.
    expect(p).toMatchObject({ tags: ['spain', 'lager'], quantity: 4, forTrade: 2, source: 'external:claude' });
    const h = json<CapHistory[]>(await history(cap.capId));
    expect(h[0]).toMatchObject({
      source: 'manual',
      changes: [{ field: 'brand', from: 'Mahou', to: 'Mahou Cinco Estrellas' }],
    });

    // Explicitly sent defaults do apply.
    const t = json<Cap>(await patch(cap.capId, { tags: [], forTrade: 0 }));
    expect(t).toMatchObject({ tags: [], forTrade: 0, quantity: 4 });

    // Same values again → 200 with the record unchanged and no history entry.
    const same = await patch(cap.capId, { tags: [], brand: 'Mahou Cinco Estrellas' });
    expect(same.statusCode).toBe(200);
    expect(json<Cap>(same).updatedAt).toBe(t.updatedAt);
    expect(json<CapHistory[]>(await history(cap.capId))).toHaveLength(3);

    // GSI2 follows brand changes (data-model.md § Indexes).
    expect(await repos.caps.listGsi2('Mahou Cinco Estrellas')).toHaveLength(1);
    expect(await repos.caps.listGsi2('Mahou')).toHaveLength(0);
    await del(cap.capId);
    expect(await repos.caps.listGsi2('Mahou Cinco Estrellas')).toHaveLength(0);
  });

  it('[T-api-023] patch/delete of a located cap keep its pocket lock in step; writes never reuse an instant', async () => {
    const albumId = newId();
    const t0 = FIXTURE_CAP.createdAt;
    await repos.albums.put(UID, {
      albumId,
      letter: 'A',
      name: 'G',
      kind: 'album',
      sheets: 5,
      cols: 6,
      rows: 7,
      createdAt: t0,
      updatedAt: t0,
    });
    const placed = makeCap({ brand: 'Alhambra', location: pocket(1, 1) });
    await repos.caps.put(UID, { cap: placed, albumId, history: makeHistory(placed.capId, 'created') });
    expect((await patch(placed.capId, { variant: 'Reserva' })).statusCode).toBe(200);
    expect((await repos.caps.listGsi1(albumId, 1)).map((s) => s.variant)).toEqual(['Reserva']);
    expect((await del(placed.capId)).statusCode).toBe(204);
    expect(await repos.caps.listGsi1(albumId, 1)).toEqual([]);
    // Pocket A·1·1 is free again.
    const next = makeCap({ location: pocket(1, 1) });
    await repos.caps.put(UID, { cap: next, albumId, history: makeHistory(next.capId, 'created') });

    // A cap pointing at an album that does not exist is a server error, not a silent write.
    const orphan = makeCap({ location: pocket(1, 2, 'Z') });
    await repos.caps.put(UID, { cap: orphan, albumId: newId(), history: makeHistory(orphan.capId, 'created') });
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const res = await patch(orphan.capId, { variant: 'X' });
    log.mockRestore();
    expect(res.statusCode).toBe(500);

    // after(): strictly later than the previous instant even when the clock is behind.
    expect(after('2026-11-01T10:00:00.000Z', () => Date.parse('2026-11-01T09:00:00.000Z'))).toBe(
      '2026-11-01T10:00:00.001Z',
    );
    expect(after('2026-11-01T10:00:00.000+02:00', () => Date.parse('2026-11-01T12:00:00.000Z'))).toBe(
      '2026-11-01T12:00:00.000Z',
    );

    // `total` only while the whole collection fits one scan (≤ 5 000 caps).
    const many = Array.from({ length: TOTAL_LIMIT + 1 }, () => bare({ brand: 'Bulk', location: undefined }));
    const big = { ...repos, caps: { ...repos.caps, listAll: async () => many } } as unknown as Repositories;
    const page = await listCaps(big, UID, CapListQuery.parse({ limit: '10' }));
    expect(page.items).toHaveLength(10);
    expect(page).not.toHaveProperty('total');
    expect(page.cursor).toBeDefined();
    const small = await listCaps(
      { ...big, caps: { ...repos.caps, listAll: async () => many.slice(0, TOTAL_LIMIT) } } as unknown as Repositories,
      UID,
      CapListQuery.parse({ q: 'nothing' }),
    );
    expect(small).toEqual({ items: [], total: 0 });
  });
});
