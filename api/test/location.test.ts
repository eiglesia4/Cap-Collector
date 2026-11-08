// Cap location API (CAP-50) over the in-memory repositories: PUT /caps/{capId}/location into a pocket, box or frame,
// 409 naming the occupant, swap in one transaction, DELETE to clear, and location accepted on POST /caps.
// Spec: ADR-005, ADR-006; physical-link.md § Location code / § Keeping them in sync; openapi.yaml
// /caps/{capId}/location; data-model.md § Invariants (LOCK#<albumId>#<sheet>#<pocket>, GSI1).
import {
  type Album,
  type AlbumLocation,
  Cap,
  type CapHistory,
  type Location,
  Problem,
  lockSk,
  userPk,
} from '@capcollector/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handler as createH } from '../src/handlers/caps-create.js';
import { handler as historyH } from '../src/handlers/caps-history.js';
import { handler as delH } from '../src/handlers/caps-location-delete.js';
import { handler as putH } from '../src/handlers/caps-location-put.js';
import { newId } from '../src/lib/ids.js';
import { setRepositories } from '../src/lib/repo/index.js';
import { type InMemoryCapRepository, createMemoryRepositories } from '../src/lib/repo/memory.js';
import type { Repositories } from '../src/lib/repo/types.js';
import { useAwsTestEnv } from './support/aws-env.js';
import { FIXTURE_CAP, apiEvent, makeCap, makeHistory, pocket } from './support/fixtures.js';

const UID = 'apple-sub-1';
const IMAGES = { top: { key: 'u/x/top.webp', width: 800, height: 800 } };

let repos: Repositories;
let album: Album;
let box: Album;
useAwsTestEnv();
beforeEach(async () => {
  repos = createMemoryRepositories();
  setRepositories(repos);
  const t = FIXTURE_CAP.createdAt;
  album = {
    albumId: newId(),
    letter: 'A',
    name: 'GRANDE',
    kind: 'album',
    sheets: 2,
    cols: 6,
    rows: 7,
    createdAt: t,
    updatedAt: t,
  };
  box = { albumId: newId(), letter: 'B', name: 'Trade box', kind: 'box', createdAt: t, updatedAt: t };
  await repos.albums.put(UID, album);
  await repos.albums.put(UID, box);
});
afterEach(() => setRepositories(undefined));

const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;
const put = (capId: string, b: Record<string, unknown>) =>
  putH(apiEvent({ uid: UID, pathParameters: { capId }, body: JSON.stringify(b) }));
const del = (capId: string) => delH(apiEvent({ uid: UID, pathParameters: { capId } }));
const history = async (capId: string) =>
  json<CapHistory[]>(await historyH(apiEvent({ uid: UID, pathParameters: { capId } })));
const table = () => (repos.caps as InMemoryCapRepository).table;
const lockOf = (sheet: number, p: number) =>
  table().get({ pk: userPk(UID), sk: lockSk(album.albumId, pocket(sheet, p) as AlbumLocation) })?.capId;
const sheet = async (n: number) => (await repos.caps.listGsi1(album.albumId, n)).map((e) => [e.pocket, e.capId]);
const stored = async (capId: string) => (await repos.caps.get(UID, capId))!;

/** A live cap with no location. */
async function loose(brand = 'Mahou'): Promise<Cap> {
  const cap = makeCap({ brand, location: undefined });
  await repos.caps.put(UID, { cap, history: makeHistory(cap.capId, 'created') });
  return cap;
}

const A = (s: number, p: number): Location => pocket(s, p);
const withId = (loc: Location, a: Album = album) => ({ ...loc, albumId: a.albumId });

describe('PUT /caps/{capId}/location', () => {
  it('[T-api-072] into an empty pocket → cap with albumId, LOCK#, GSI1 and a `located` entry; a move frees the old pocket (`moved`)', async () => {
    const cap = await loose();
    const res = await put(cap.capId, { location: A(1, 1) });
    expect(res.statusCode).toBe(200);
    const body = json<{ cap: Cap; swapped?: Cap }>(res);
    expect(body.swapped).toBeUndefined();
    expect(Cap.parse(body.cap).location).toEqual(withId(A(1, 1)));
    expect(body.cap.imageUrls?.top).toMatch(/^https:/);
    expect(body.cap.updatedAt > cap.updatedAt).toBe(true);
    expect((await stored(cap.capId)).location).toEqual(withId(A(1, 1)));
    expect(lockOf(1, 1)).toBe(cap.capId);
    expect(await sheet(1)).toEqual([[1, cap.capId]]);

    expect((await put(cap.capId, { location: A(2, 42) })).statusCode).toBe(200);
    expect(lockOf(1, 1)).toBeUndefined();
    expect(lockOf(2, 42)).toBe(cap.capId);
    expect(await sheet(1)).toEqual([]);
    expect(await sheet(2)).toEqual([[42, cap.capId]]);

    const [moved, located] = await history(cap.capId);
    expect(located).toMatchObject({
      action: 'located',
      source: 'manual',
      changes: [{ field: 'location', to: withId(A(1, 1)) }],
    });
    expect(located!.changes[0]).not.toHaveProperty('from');
    expect(moved).toMatchObject({
      action: 'moved',
      changes: [{ field: 'location', from: withId(A(1, 1)), to: withId(A(2, 42)) }],
    });

    // The same location again is a no-op: no write, no history entry.
    const again = await put(cap.capId, { location: A(2, 42) });
    expect(again.statusCode).toBe(200);
    expect(json<{ cap: Cap }>(again).cap.updatedAt).toBe((await stored(cap.capId)).updatedAt);
    expect((await history(cap.capId)).length).toBe(3);
  });

  it('[T-api-073] occupied pocket without swap → 409 naming the occupant in errors[]; nothing written', async () => {
    const holder = await loose('Alhambra');
    const mover = await loose('Mahou');
    await put(holder.capId, { location: A(1, 1) });
    const before = await stored(mover.capId);

    for (const body of [{ location: A(1, 1) }, { location: A(1, 1), swap: false }]) {
      const res = await put(mover.capId, body);
      expect(res.statusCode).toBe(409);
      const p = Problem.parse(json(res));
      expect(p.detail).toBe('pocket A·1·1 is occupied');
      expect(p.errors).toEqual([{ path: 'body.location', message: `occupied by cap ${holder.capId}` }]);
    }
    expect(await stored(mover.capId)).toEqual(before);
    expect(lockOf(1, 1)).toBe(holder.capId);
    expect((await history(mover.capId)).length).toBe(1);
  });

  it('[T-api-074] swap → both caps moved in one call, both markers rewritten, two `swapped` entries; an unplaced mover leaves the occupant without location', async () => {
    const x = await loose('Alhambra');
    const y = await loose('Mahou');
    await put(x.capId, { location: A(1, 1) });
    await put(y.capId, { location: A(1, 2) });

    const res = await put(y.capId, { location: A(1, 1), swap: true });
    expect(res.statusCode).toBe(200);
    const body = json<{ cap: Cap; swapped: Cap }>(res);
    expect(body.cap).toMatchObject({ capId: y.capId, location: withId(A(1, 1)) });
    expect(body.swapped).toMatchObject({ capId: x.capId, location: withId(A(1, 2)) });
    expect(body.swapped.imageUrls?.top).toMatch(/^https:/);
    expect(lockOf(1, 1)).toBe(y.capId);
    expect(lockOf(1, 2)).toBe(x.capId);
    expect(await sheet(1)).toEqual([
      [1, y.capId],
      [2, x.capId],
    ]);
    expect((await history(y.capId))[0]).toMatchObject({
      action: 'swapped',
      changes: [{ field: 'location', from: withId(A(1, 2)), to: withId(A(1, 1)) }],
    });
    expect((await history(x.capId))[0]).toMatchObject({
      action: 'swapped',
      changes: [{ field: 'location', from: withId(A(1, 1)), to: withId(A(1, 2)) }],
    });

    // A mover with no location: the occupant ends with none, its pocket goes to the mover.
    const z = await loose('Estrella');
    const swap2 = json<{ cap: Cap; swapped: Cap }>(await put(z.capId, { location: A(1, 2), swap: true }));
    expect(swap2.swapped.capId).toBe(x.capId);
    expect(swap2.swapped.location).toBeUndefined();
    expect((await stored(x.capId)).location).toBeUndefined();
    expect(lockOf(1, 2)).toBe(z.capId);
    expect((await history(x.capId))[0]!.changes).toEqual([{ field: 'location', from: withId(A(1, 2)) }]);

    // A mover in a box: the occupant goes to that box (no lock for it); swap into a free pocket is a plain move.
    await put(x.capId, { location: { kind: 'box', album: 'B' } });
    const swap3 = json<{ cap: Cap; swapped: Cap }>(await put(x.capId, { location: A(1, 1), swap: true }));
    expect(swap3.swapped).toMatchObject({ capId: y.capId, location: withId({ kind: 'box', album: 'B' }, box) });
    expect(lockOf(1, 1)).toBe(x.capId);
    const free = json<{ cap: Cap; swapped?: Cap }>(await put(y.capId, { location: A(2, 5), swap: true }));
    expect(free.swapped).toBeUndefined();
    expect((await history(y.capId))[0]!.action).toBe('moved');
  });

  it('[T-api-075] box / frame location: stored with albumId, no LOCK# and no GSI1; leaving a pocket for a box frees it', async () => {
    const cap = await loose();
    await put(cap.capId, { location: A(1, 7) });
    const res = await put(cap.capId, { location: { kind: 'box', album: 'B' } });
    expect(res.statusCode).toBe(200);
    expect(json<{ cap: Cap }>(res).cap.location).toEqual({ kind: 'box', album: 'B', albumId: box.albumId });
    expect(lockOf(1, 7)).toBeUndefined();
    expect(await sheet(1)).toEqual([]);
    const item = table().get({ pk: userPk(UID), sk: `CAP#${cap.capId}` })!;
    expect(item).not.toHaveProperty('gsi1pk');
    expect(item).not.toHaveProperty('gsi1sk');
    // No LOCK# item of any kind for the box.
    const locks = table().query(userPk(UID), 'LOCK#').items;
    expect(locks).toEqual([]);
  });

  it('[T-api-076] geometry beyond the album → 422; kind not matching the record → 422; unknown letter or cap → 404; bad body → 422', async () => {
    const cap = await loose();
    const paths = async (b: Record<string, unknown>) => {
      const res = await put(cap.capId, b);
      expect(res.statusCode).toBe(422);
      return Problem.parse(json(res)).errors?.map((e) => e.path);
    };
    expect(await paths({ location: A(3, 1) })).toEqual(['body.location.sheet']);
    expect(await paths({ location: A(1, 43) })).toEqual(['body.location.pocket']);
    expect(await paths({ location: { kind: 'frame', album: 'A' } })).toEqual(['body.location.kind']);
    expect(await paths({ location: pocket(1, 1, 'B') })).toEqual(['body.location.kind']);
    expect(await paths({ location: A(1, 1), extra: true })).toEqual(['body']);
    expect((await put(cap.capId, { location: pocket(1, 1, 'Z') })).statusCode).toBe(404);
    expect((await put(newId(), { location: A(1, 1) })).statusCode).toBe(404);
    expect((await stored(cap.capId)).location).toBeUndefined();
  });
});

describe('DELETE /caps/{capId}/location and POST /caps with location', () => {
  it('[T-api-077] delete clears location, LOCK# and GSI1 with a `moved` entry (from only); 204 again without a new entry; 404 unknown', async () => {
    const cap = await loose();
    await put(cap.capId, { location: A(1, 3) });
    expect((await del(cap.capId)).statusCode).toBe(204);
    expect((await stored(cap.capId)).location).toBeUndefined();
    expect(lockOf(1, 3)).toBeUndefined();
    expect(await sheet(1)).toEqual([]);
    const h = await history(cap.capId);
    expect(h[0]).toMatchObject({ action: 'moved', changes: [{ field: 'location', from: withId(A(1, 3)) }] });
    expect(h[0]!.changes[0]).not.toHaveProperty('to');

    expect((await del(cap.capId)).statusCode).toBe(204);
    expect((await history(cap.capId)).length).toBe(h.length);
    expect((await del(newId())).statusCode).toBe(404);
  });

  it('[T-api-078] POST /caps with a location lands in the pocket (LOCK#, GSI1, albumId); occupied → 409 naming the occupant, nothing written; unknown letter → 404', async () => {
    const create = (b: Record<string, unknown>) =>
      createH(apiEvent({ uid: UID, body: JSON.stringify({ brand: 'Mahou', images: IMAGES, ...b }) }));
    const res = await create({ location: A(2, 17) });
    expect(res.statusCode).toBe(201);
    const cap = Cap.parse(json(res));
    expect(cap.location).toEqual(withId(A(2, 17)));
    expect(lockOf(2, 17)).toBe(cap.capId);
    expect(await sheet(2)).toEqual([[17, cap.capId]]);
    expect((await history(cap.capId)).map((x) => x.action)).toEqual(['created']);

    const taken = await create({ brand: 'Alhambra', location: A(2, 17) });
    expect(taken.statusCode).toBe(409);
    expect(Problem.parse(json(taken)).errors?.[0]?.message).toBe(`occupied by cap ${cap.capId}`);
    expect((await repos.caps.listAll(UID)).length).toBe(1);

    const boxed = Cap.parse(json(await create({ location: { kind: 'box', album: 'B' } })));
    expect(boxed.location).toEqual({ kind: 'box', album: 'B', albumId: box.albumId });
    expect((await create({ location: pocket(1, 1, 'Q') })).statusCode).toBe(404);
    expect((await create({ location: A(9, 1) })).statusCode).toBe(422);
  });
});
