// In-memory repositories (CAP-17): the cap contract suite, plus the album/scan/exchange fakes used by api:local.
import { describe, expect, it } from 'vitest';

import { BadRequest, Conflict } from '../../src/lib/errors.js';
import { newId } from '../../src/lib/ids.js';
import { InMemoryCapRepository, MemoryTable, createMemoryRepositories } from '../../src/lib/repo/memory.js';
import { makeCap, makeHistory, nextTs, uniq } from '../support/fixtures.js';
import { runCapRepositoryContract } from './cap-contract.js';

describe('in-memory repositories', () => {
  it('[T-api-003] InMemoryCapRepository passes the CapRepository contract suite', async () => {
    await runCapRepositoryContract(new InMemoryCapRepository());
  });

  it('[T-api-008] memory table: transactions are all-or-nothing and stored items are copies', async () => {
    const table = new MemoryTable();
    const repo = new InMemoryCapRepository(table);
    const uid = uniq('u');
    const cap = makeCap({ location: undefined });
    await repo.put(uid, { cap, history: makeHistory(cap.capId, 'created') });
    // Mutating what get() returned does not change the store.
    const got = (await repo.get(uid, cap.capId))!;
    got.brand = 'Changed';
    expect((await repo.get(uid, cap.capId))!.brand).toBe(cap.brand);
    // A history collision fails the whole patch: the cap keeps its previous state.
    const ts = nextTs();
    await repo.patch(uid, { cap }, { cap: { ...cap, updatedAt: ts }, history: makeHistory(cap.capId, 'updated', ts) });
    const now = (await repo.get(uid, cap.capId))!;
    await expect(
      repo.patch(
        uid,
        { cap: now },
        { cap: { ...now, brand: 'X', updatedAt: nextTs() }, history: makeHistory(cap.capId, 'updated', ts) },
      ),
    ).rejects.toBeInstanceOf(Conflict);
    expect((await repo.get(uid, cap.capId))!.brand).toBe(cap.brand);
    // Programming errors are not conflicts.
    await expect(repo.put(uid, { cap: makeCap(), history: makeHistory(cap.capId, 'created') })).rejects.toThrow(
      'history entry belongs to another cap',
    );
    await expect(repo.put(uid, { cap: makeCap(), history: makeHistory(newId(), 'created') })).rejects.toThrow();
    const located = makeCap();
    await expect(repo.put(uid, { cap: located, history: makeHistory(located.capId, 'created') })).rejects.toThrow(
      'albumId is required',
    );
    await expect(
      repo.patch(uid, { cap }, { cap: { ...cap, capId: newId() }, history: makeHistory(cap.capId, 'updated') }),
    ).rejects.toThrow();
  });

  it('[T-api-009] album, scan and exchange fakes: put/get/list per user, scans newest first with cursor', async () => {
    const repos = createMemoryRepositories();
    const uid = uniq('u');
    const t = nextTs();

    const album = {
      albumId: newId(),
      letter: 'A',
      name: 'Leuchtturm GRANDE 1',
      kind: 'album' as const,
      sheets: 10,
      cols: 6,
      rows: 7,
      createdAt: t,
      updatedAt: t,
    };
    await repos.albums.put(uid, album);
    expect(await repos.albums.get(uid, album.albumId)).toEqual(album);
    expect(await repos.albums.byLetter(uid, 'A')).toEqual(album);
    expect(await repos.albums.byLetter(uid, 'Z')).toBeUndefined();
    expect(await repos.albums.list(uniq('other'))).toEqual([]);

    const scans = [0, 1, 2].map(() => ({
      scanId: newId(),
      ts: nextTs(),
      dhash: '00000000000000ff',
      outcome: 'unidentified' as const,
      threshold: 8,
      aiCalled: false,
    }));
    for (const s of scans) await repos.scans.put(uid, s);
    expect(await repos.scans.get(uid, scans[1]!.scanId)).toEqual(scans[1]);
    expect(await repos.scans.get(uid, newId())).toBeUndefined();
    const p1 = await repos.scans.list(uid, { limit: 2 });
    expect(p1.items.map((s) => s.scanId)).toEqual([scans[2]!.scanId, scans[1]!.scanId]);
    const p2 = await repos.scans.list(uid, { limit: 2, cursor: p1.cursor! });
    expect(p2.items.map((s) => s.scanId)).toEqual([scans[0]!.scanId]);
    expect(p2.cursor).toBeUndefined();
    expect((await repos.scans.list(uid)).items).toHaveLength(3);
    await expect(repos.scans.list(uid, { cursor: p1.cursor!.slice(2) })).rejects.toBeInstanceOf(BadRequest);

    const req = { requestId: newId(), createdAt: t, status: 'waiting' as const, dhash: '00000000000000ff' };
    await repos.exchange.put(uid, req);
    expect(await repos.exchange.get(uid, req.requestId)).toEqual(req);
    await repos.exchange.put(uid, { ...req, status: 'answered' });
    expect((await repos.exchange.list(uid)).map((r) => r.status)).toEqual(['answered']);
  });
});
