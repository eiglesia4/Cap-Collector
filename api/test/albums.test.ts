// Albums API (CAP-49) over the in-memory repositories: create/list with GRANDE defaults and unique letters, PATCH with
// partial semantics and its 409 guards, the GSI1 sheet view and the row-major next free pocket.
// Spec: ADR-005; physical-link.md § The album / § Location code; openapi.yaml /albums*; data-model.md ALBUM#, GSI1.
import { Album, NextFree, Problem, SheetView } from '@capcollector/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handler as createH } from '../src/handlers/albums-create.js';
import { handler as listH } from '../src/handlers/albums-list.js';
import { handler as nextFreeH } from '../src/handlers/albums-next-free.js';
import { handler as patchH } from '../src/handlers/albums-patch.js';
import { handler as sheetH } from '../src/handlers/albums-sheet.js';
import { newId } from '../src/lib/ids.js';
import { setRepositories } from '../src/lib/repo/index.js';
import { capItem } from '../src/lib/repo/items.js';
import { type InMemoryCapRepository, createMemoryRepositories } from '../src/lib/repo/memory.js';
import type { Repositories } from '../src/lib/repo/types.js';
import { useAwsTestEnv } from './support/aws-env.js';
import { apiEvent, makeCap, makeHistory, pocket } from './support/fixtures.js';

const UID = 'apple-sub-1';

let repos: Repositories;
useAwsTestEnv();
beforeEach(() => {
  repos = createMemoryRepositories();
  setRepositories(repos);
});
afterEach(() => {
  setRepositories(undefined);
  vi.restoreAllMocks();
});

const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;
const create = (b: Record<string, unknown>) => createH(apiEvent({ uid: UID, body: JSON.stringify(b) }));
const patch = (albumId: string, b: Record<string, unknown>) =>
  patchH(apiEvent({ uid: UID, pathParameters: { albumId }, body: JSON.stringify(b) }));
const sheet = (albumId: string, n: number | string) =>
  sheetH(apiEvent({ uid: UID, pathParameters: { albumId, sheet: String(n) } }));
const nextFree = (albumId: string) => nextFreeH(apiEvent({ uid: UID, pathParameters: { albumId } }));

async function mkAlbum(over: Record<string, unknown> = {}): Promise<Album> {
  const res = await create({ letter: 'A', name: 'Leuchtturm GRANDE 1', kind: 'album', sheets: 3, ...over });
  expect(res.statusCode).toBe(201);
  return Album.parse(json(res));
}

/** Places a live cap in a pocket straight through the repository (the location API is CAP-50). */
async function place(album: Album, sheetNo: number, pocketNo: number, brand = 'Mahou') {
  const cap = makeCap({ brand, location: pocket(sheetNo, pocketNo, album.letter) });
  await repos.caps.put(UID, { cap, albumId: album.albumId, history: makeHistory(cap.capId, 'created') });
  return cap;
}

/** Fills pockets 1..n of a sheet. */
async function fill(album: Album, sheetNo: number, n: number) {
  for (let p = 1; p <= n; p++) await place(album, sheetNo, p);
}

describe('albums create / list', () => {
  it('[T-api-065] create → 201 with GRANDE 6×7 defaults → list by letter; duplicate letter → 409; box keeps no geometry; album without sheets → 422', async () => {
    const b = await mkAlbum({ letter: 'B', name: 'Second binder' });
    expect(b).toMatchObject({ letter: 'B', kind: 'album', sheets: 3, cols: 6, rows: 7 });
    expect(b.createdAt).toBe(b.updatedAt);
    const a = await mkAlbum({ letter: 'A', sheets: 10, pocketMm: 34, pitchMm: 38 });

    const box = await create({ letter: 'T', name: 'Trade box', kind: 'box', sheets: 4 });
    expect(box.statusCode).toBe(201);
    const boxed = Album.parse(json(box));
    expect(boxed.sheets).toBeUndefined();
    expect(boxed.cols).toBeUndefined();
    expect(boxed.rows).toBeUndefined();

    const list = await listH(apiEvent({ uid: UID }));
    expect(list.statusCode).toBe(200);
    expect(json<Album[]>(list).map((x) => x.letter)).toEqual(['A', 'B', 'T']);
    expect(json<Album[]>(list)[0]).toEqual(a);
    expect(json<Album[]>(await listH(apiEvent({ uid: 'someone-else' })))).toEqual([]);

    const dup = await create({ letter: 'A', name: 'Another A', kind: 'frame' });
    expect(dup.statusCode).toBe(409);
    expect(Problem.parse(json(dup)).detail).toContain('A');

    const noSheets = await create({ letter: 'C', name: 'No sheets', kind: 'album' });
    expect(noSheets.statusCode).toBe(422);
    expect(Problem.parse(json(noSheets)).errors?.[0]?.path).toBe('body.kind');

    const bad = await create({ letter: 'c', name: 'x', kind: 'album', sheets: 1 });
    expect(bad.statusCode).toBe(422);
    expect((await repos.albums.list(UID)).length).toBe(3);
  });
});

describe('albums patch', () => {
  it('[T-api-066] PATCH keeps absent fields (no cols/rows defaults), renames the letter of an empty album, 409 when it holds caps or the letter is taken, 404 unknown', async () => {
    const a = await mkAlbum({ cols: 5, rows: 8 });
    const res = await patch(a.albumId, { name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    const renamed = Album.parse(json(res));
    expect(renamed).toMatchObject({ name: 'Renamed', letter: 'A', sheets: 3, cols: 5, rows: 8 });
    expect(renamed.updatedAt > a.updatedAt).toBe(true);
    expect(await repos.albums.get(UID, a.albumId)).toEqual(renamed);

    const relettered = await patch(a.albumId, { letter: 'Q' });
    expect(relettered.statusCode).toBe(200);
    expect(Album.parse(json(relettered)).letter).toBe('Q');

    await mkAlbum({ letter: 'R' });
    expect((await patch(a.albumId, { letter: 'R' })).statusCode).toBe(409);

    const q = (await repos.albums.get(UID, a.albumId))!;
    await place(q, 1, 1);
    const withCaps = await patch(a.albumId, { letter: 'S' });
    expect(withCaps.statusCode).toBe(409);
    expect(Problem.parse(json(withCaps)).detail).toContain('holds caps');
    expect((await patch(a.albumId, { kind: 'box' })).statusCode).toBe(409);
    expect((await repos.albums.get(UID, a.albumId))!.letter).toBe('Q');

    // A box holding caps (letter only, no pocket) is guarded the same way.
    const box = Album.parse(json(await create({ letter: 'T', name: 'Trade box', kind: 'box' })));
    const loose = makeCap({ location: { kind: 'box', album: 'T' } });
    await repos.caps.put(UID, { cap: loose, history: makeHistory(loose.capId, 'created') });
    expect((await patch(box.albumId, { letter: 'U' })).statusCode).toBe(409);
    // Box → album without sheets breaks the Album refine; with sheets it takes the GRANDE defaults.
    const empty = Album.parse(json(await create({ letter: 'V', name: 'Frame', kind: 'frame' })));
    expect((await patch(empty.albumId, { kind: 'album' })).statusCode).toBe(422);
    const grown = await patch(empty.albumId, { kind: 'album', sheets: 2 });
    expect(Album.parse(json(grown))).toMatchObject({ kind: 'album', sheets: 2, cols: 6, rows: 7 });
    const back = await patch(empty.albumId, { kind: 'frame' });
    expect(Album.parse(json(back)).sheets).toBeUndefined();

    expect((await patch(newId(), { name: 'x' })).statusCode).toBe(404);
    expect((await patch(a.albumId, { cols: 7, extra: 1 })).statusCode).toBe(422);
  });

  it('[T-api-067] shrinking sheets/cols/rows below an occupied pocket → 409; shrinking over empty pockets and growing → 200', async () => {
    const a = await mkAlbum({ sheets: 4 });
    await place(a, 2, 30);
    await place(a, 3, 5);

    const fewerSheets = await patch(a.albumId, { sheets: 2 });
    expect(fewerSheets.statusCode).toBe(409);
    expect(Problem.parse(json(fewerSheets)).detail).toContain('A·3·5');
    const fewerRows = await patch(a.albumId, { rows: 4 }); // 24 pockets per sheet cuts A·2·30
    expect(fewerRows.statusCode).toBe(409);
    expect(Problem.parse(json(fewerRows)).detail).toContain('A·2·30');
    expect((await patch(a.albumId, { cols: 4 })).statusCode).toBe(409); // 28 < 30

    const ok = await patch(a.albumId, { sheets: 3, rows: 5 }); // 30 pockets: A·2·30 still fits, sheet 4 is empty
    expect(ok.statusCode).toBe(200);
    expect(Album.parse(json(ok))).toMatchObject({ sheets: 3, cols: 6, rows: 5 });
    expect((await patch(a.albumId, { sheets: 12, cols: 7, rows: 7 })).statusCode).toBe(200);

    // Only the sheets that can lose pockets are queried: dropping sheets 4..12 with the same grid reads those nine.
    const spy = vi.spyOn(repos.caps, 'listGsi1');
    expect((await patch(a.albumId, { sheets: 3 })).statusCode).toBe(200);
    expect(spy.mock.calls.map((c) => c[1])).toEqual([4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });
});

describe('sheet view and next free', () => {
  it('[T-api-068] sheet view from GSI1: 6×7 geometry, occupied pockets by pocket with thumbKey, tombstoned excluded; 404 beyond sheets, for a box and unknown album', async () => {
    const a = await mkAlbum();
    const later = await place(a, 1, 17, 'Alhambra');
    const first = await place(a, 1, 3, 'Mahou');
    await place(a, 2, 1, 'Estrella Galicia');
    // A tombstoned cap whose stale GSI1 keys survived must not show (data-model.md: tombstones leave the index).
    const gone = makeCap({ brand: 'Aguila', location: pocket(1, 5) });
    (repos.caps as InMemoryCapRepository).table.put({
      ...capItem(UID, gone, a.albumId),
      deletedAt: '2026-11-08T10:00:00.000Z',
    });

    const res = await sheet(a.albumId, 1);
    expect(res.statusCode).toBe(200);
    const view = SheetView.parse(json(res));
    expect(view).toMatchObject({ albumId: a.albumId, letter: 'A', sheet: 1, cols: 6, rows: 7 });
    expect(view.cols * view.rows).toBe(42);
    expect(view.pockets).toEqual([
      { pocket: 3, capId: first.capId, brand: 'Mahou', variant: 'Clásica', thumbKey: first.images.top.key },
      { pocket: 17, capId: later.capId, brand: 'Alhambra', variant: 'Clásica', thumbKey: later.images.top.key },
    ]);
    expect(SheetView.parse(json(await sheet(a.albumId, 3))).pockets).toEqual([]);

    expect((await sheet(a.albumId, 4)).statusCode).toBe(404);
    expect((await sheet(a.albumId, 0)).statusCode).toBe(422);
    expect((await sheet(newId(), 1)).statusCode).toBe(404);
    const box = Album.parse(json(await create({ letter: 'T', name: 'Trade box', kind: 'box' })));
    expect((await sheet(box.albumId, 1)).statusCode).toBe(404);
    expect((await nextFree(box.albumId)).statusCode).toBe(404);
  });

  it('[T-api-069] next-free: empty album → A·1·1; first gap in row-major order; full sheet → next sheet, stopping there; full album → nulls', async () => {
    const a = await mkAlbum({ sheets: 2, cols: 2, rows: 2 });
    const free = async () => {
      const res = await nextFree(a.albumId);
      expect(res.statusCode).toBe(200);
      return NextFree.parse(json(res));
    };
    expect(await free()).toEqual({
      albumId: a.albumId,
      location: { kind: 'album', album: 'A', sheet: 1, pocket: 1 },
      code: 'A·1·1',
    });

    await place(a, 1, 1);
    await place(a, 1, 2);
    await place(a, 1, 4);
    expect((await free()).code).toBe('A·1·3');

    await place(a, 1, 3);
    const spy = vi.spyOn(repos.caps, 'listGsi1');
    expect((await free()).code).toBe('A·2·1');
    expect(spy.mock.calls.map((c) => c[1])).toEqual([1, 2]);

    await fill(a, 2, 4);
    expect(await free()).toEqual({ albumId: a.albumId, location: null, code: null });
    expect((await nextFree(newId())).statusCode).toBe(404);
  });

  it('[T-api-070] Edu’s album A: GRANDE sheet 1 has 42 pockets and next-free proposes the first empty one after placed caps', async () => {
    const a = await mkAlbum({ sheets: 10 });
    await fill(a, 1, 16);
    await place(a, 1, 18);
    const view = SheetView.parse(json(await sheet(a.albumId, 1)));
    expect(view.cols * view.rows).toBe(42);
    expect(view.pockets.map((p) => p.pocket)).toEqual([...Array.from({ length: 16 }, (_, i) => i + 1), 18]);
    expect(NextFree.parse(json(await nextFree(a.albumId))).code).toBe('A·1·17');
  });
});
