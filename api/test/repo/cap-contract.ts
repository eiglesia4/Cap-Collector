// The CapRepository contract (CAP-17): one scenario list every implementation must pass — in memory (T-api-003) and
// DynamoDB Local (T-api-005). Uses unique uids, brands and album ids so runs can share one local table.
import { expect } from 'vitest';

import { BadRequest, Conflict } from '../../src/lib/errors.js';
import { encodeCursor } from '../../src/lib/repo/items.js';
import type { CapRepository } from '../../src/lib/repo/types.js';
import { makeCap, makeHistory, nextTs, pocket, uniq } from '../support/fixtures.js';

export async function runCapRepositoryContract(repo: CapRepository): Promise<void> {
  const uid = uniq('user');
  const brand = uniq('Brand Ñ'); // accents + spaces exercise normaliseBrand in GSI2
  const albumId = uniq('ALBUM');

  // 1. create + get round-trips the record; history has the `created` entry.
  const a = makeCap({ brand, variant: 'Clásica', location: pocket(3, 17), dhash: '0000000000000001' });
  await repo.put(uid, { cap: a, albumId, history: makeHistory(a.capId, 'created', a.createdAt) });
  expect(await repo.get(uid, a.capId)).toEqual(a);
  expect(await repo.get(uniq('other'), a.capId)).toBeUndefined();
  expect((await repo.history(a.capId)).map((h) => h.action)).toEqual(['created']);

  // 2. same id again → Conflict.
  await expect(repo.put(uid, { cap: a, albumId, history: makeHistory(a.capId, 'created') })).rejects.toBeInstanceOf(
    Conflict,
  );

  // 3. one cap per pocket: a second cap in A·3·17 is refused and nothing of it is written.
  const b = makeCap({ brand, variant: 'Sin', location: pocket(3, 17) });
  await expect(repo.put(uid, { cap: b, albumId, history: makeHistory(b.capId, 'created') })).rejects.toBeInstanceOf(
    Conflict,
  );
  expect(await repo.get(uid, b.capId)).toBeUndefined();
  expect(await repo.history(b.capId)).toEqual([]);

  // 4. GSI1 sheet view and GSI2 brand/variant lists.
  await repo.put(uid, {
    cap: { ...b, location: pocket(3, 2) },
    albumId,
    history: makeHistory(b.capId, 'created'),
  });
  const sheet = await repo.listGsi1(albumId, 3);
  expect(sheet.map((s) => [s.pocket, s.capId])).toEqual([
    [2, b.capId],
    [17, a.capId],
  ]);
  expect(sheet[1]).toEqual({
    capId: a.capId,
    brand,
    variant: 'Clásica',
    images: a.images,
    status: a.status,
    pocket: 17,
  });
  expect((await repo.listGsi2(brand.toUpperCase())).map((e) => e.capId).sort()).toEqual([a.capId, b.capId].sort());
  expect((await repo.listGsi2(brand, 'clasica')).map((e) => e.capId)).toEqual([a.capId]);

  // 5. patch with a stale updatedAt → Conflict; a fresh one moves the pocket and frees the old one.
  const moved = { ...a, location: pocket(4, 1), updatedAt: nextTs() };
  await expect(
    repo.patch(
      uid,
      { cap: { ...a, updatedAt: '2020-01-01T00:00:00.000Z' }, albumId },
      { cap: moved, albumId, history: makeHistory(a.capId, 'moved') },
    ),
  ).rejects.toBeInstanceOf(Conflict);
  await repo.patch(uid, { cap: a, albumId }, { cap: moved, albumId, history: makeHistory(a.capId, 'moved') });
  expect(await repo.get(uid, a.capId)).toEqual(moved);
  expect((await repo.listGsi1(albumId, 3)).map((s) => s.capId)).toEqual([b.capId]);
  expect((await repo.listGsi1(albumId, 4)).map((s) => s.pocket)).toEqual([1]);
  // The freed pocket A·3·17 can be taken again; the occupied A·4·1 cannot.
  await expect(
    repo.patch(
      uid,
      { cap: (await repo.get(uid, b.capId))!, albumId },
      { cap: { ...b, location: pocket(4, 1), updatedAt: nextTs() }, albumId, history: makeHistory(b.capId, 'moved') },
    ),
  ).rejects.toBeInstanceOf(Conflict);
  const bNow = (await repo.get(uid, b.capId))!;
  const bMoved = { ...bNow, location: pocket(3, 17), updatedAt: nextTs() };
  await repo.patch(uid, { cap: bNow, albumId }, { cap: bMoved, albumId, history: makeHistory(b.capId, 'moved') });
  // A box location carries no pocket: lock released, GSI1 cleared.
  const boxed = { ...bMoved, location: { kind: 'box' as const, album: 'B' }, updatedAt: nextTs() };
  await repo.patch(uid, { cap: bMoved, albumId }, { cap: boxed, history: makeHistory(b.capId, 'updated') });
  expect(await repo.listGsi1(albumId, 3)).toEqual([]);

  // 6. hashes: every live cap with its dHashes.
  const hashes = await repo.hashes(uid);
  expect(hashes).toEqual(
    expect.arrayContaining([
      { capId: a.capId, dhash: '0000000000000001' },
      expect.objectContaining({ capId: b.capId }),
    ]),
  );
  expect(hashes).toHaveLength(2);

  // 7. softDelete = tombstone: kept for get/includeDeleted, gone from lists, GSIs and hashes; pocket freed.
  const deleted = await repo.softDelete(uid, { cap: moved, albumId }, makeHistory(a.capId, 'deleted'));
  expect(deleted.deletedAt).toBeDefined();
  expect(await repo.get(uid, a.capId)).toEqual(deleted);
  expect((await repo.list(uid)).items.map((c) => c.capId)).toEqual([b.capId]);
  expect((await repo.list(uid, { includeDeleted: true })).items).toHaveLength(2);
  expect(await repo.listGsi1(albumId, 4)).toEqual([]);
  expect((await repo.listGsi2(brand)).map((e) => e.capId)).toEqual([b.capId]);
  expect((await repo.hashes(uid)).map((h) => h.capId)).toEqual([b.capId]);
  expect((await repo.history(a.capId)).map((h) => h.action)).toEqual(['created', 'moved', 'deleted']);
  const c = makeCap({ brand, location: pocket(4, 1) });
  await repo.put(uid, { cap: c, albumId, history: makeHistory(c.capId, 'created') });

  // 8. pagination: opaque cursor walks the whole partition once, in capId (ULID) order.
  const pager = uniq('pager');
  const ids: string[] = [];
  for (let i = 0; i < 5; i++) {
    const cap = makeCap({ brand: uniq('page'), location: undefined });
    ids.push(cap.capId);
    await repo.put(pager, { cap, history: makeHistory(cap.capId, 'created') });
  }
  const first = await repo.list(pager, { limit: 2 });
  expect(first.items).toHaveLength(2);
  const seen = first.items.map((x) => x.capId);
  let cursor = first.cursor;
  while (cursor) {
    const page = await repo.list(pager, { limit: 2, cursor });
    seen.push(...page.items.map((x) => x.capId));
    cursor = page.cursor;
  }
  expect(seen).toEqual([...ids].sort());

  // 9. cursors are validated: garbage or another user's cursor → BadRequest; bad limits too.
  await expect(repo.list(pager, { cursor: 'not-a-cursor' })).rejects.toBeInstanceOf(BadRequest);
  await expect(
    repo.list(pager, { cursor: encodeCursor({ pk: 'USER#someone-else', sk: 'CAP#x' }) }),
  ).rejects.toBeInstanceOf(BadRequest);
  await expect(repo.list(pager, { limit: 0 })).rejects.toBeInstanceOf(BadRequest);
  await expect(repo.list(pager, { limit: 101 })).rejects.toBeInstanceOf(BadRequest);
}
