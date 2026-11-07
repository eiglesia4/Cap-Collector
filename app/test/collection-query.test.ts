// Collection query building, page schema and cursor paging (CAP-23; openapi.yaml § GET /caps, § CapPage).
import { Cap } from '@capcollector/shared';
import { describe, expect, it, vi } from 'vitest';

import { CapPageSchema, type CapPage } from '../src/collection/cap-page';
import { createPager } from '../src/collection/pager';
import { capsPath, DEFAULT_QUERY, isFiltered, PAGE_SIZE, topCountries } from '../src/collection/query';
import { wireCap, wirePage } from './support/caps';

const params = (path: string) => Object.fromEntries(new URL(path, 'https://x').searchParams);
const caps = (...n: number[]) => n.map((i) => Cap.parse(wireCap(i)));

describe('collection query', () => {
  it('[T-app-030] builds GET /caps query params from search, chips and sort (1:1, AND across dimensions)', () => {
    expect(capsPath(DEFAULT_QUERY)).toBe(`/caps?sort=brand&limit=${String(PAGE_SIZE)}`);
    expect(isFiltered(DEFAULT_QUERY)).toBe(false);

    const q = { q: '  Mahou ', type: 'beer' as const, country: 'ES', needsReview: true, sort: 'year' as const };
    expect(params(capsPath(q, { cursor: 'abc', limit: 3 }))).toEqual({
      q: 'Mahou',
      type: 'beer',
      country: 'ES',
      status: 'needsReview',
      sort: 'year',
      limit: '3',
      cursor: 'abc',
    });
    expect(isFiltered(q)).toBe(true);
    // A location code is passed as typed; whitespace-only search is no search.
    expect(params(capsPath({ ...DEFAULT_QUERY, q: 'A·3·17' })).q).toBe('A·3·17');
    expect(isFiltered({ ...DEFAULT_QUERY, q: '   ' })).toBe(false);
    expect(params(capsPath({ ...DEFAULT_QUERY, type: 'soft drink' })).type).toBe('soft drink');
    expect(params(capsPath(DEFAULT_QUERY, { cursor: null }))).not.toHaveProperty('cursor');

    // Country chips: most frequent first, ties A–Z, at most n, and the selected country always kept.
    const loaded = ['ES', 'BE', 'ES', 'DE', 'BE', 'ES', 'FR', undefined].map((country, i) =>
      Cap.parse(wireCap(i, country ? { country } : {})),
    );
    expect(topCountries(loaded, null, 3)).toEqual(['ES', 'BE', 'DE']);
    expect(topCountries(loaded, 'IT', 2)).toEqual(['ES', 'BE', 'IT']);
    expect(topCountries(loaded, 'BE', 2)).toEqual(['ES', 'BE']);
  });

  it('[T-app-035] parses a CapPage with the shared Cap schema and rejects malformed pages', () => {
    const ok = CapPageSchema.safeParse(wirePage([wireCap(1)], { cursor: 'next', total: 7 }));
    expect(ok.success && ok.data).toMatchObject({ cursor: 'next', total: 7, items: [{ brand: 'Brand 1' }] });
    const last = CapPageSchema.safeParse(wirePage([], { cursor: '' }));
    expect(last.success && last.data).toEqual({ items: [] });

    for (const bad of [
      null,
      [],
      { items: 'x' },
      { items: [{ brand: 'no id' }] },
      { items: [], cursor: 3 },
      { items: [], total: -1 },
      { items: [], total: 1.5 },
    ]) {
      expect(CapPageSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('[T-app-032] cursor paging appends pages without duplicates, stops on the last page and drops stale answers', async () => {
    const changes = vi.fn();
    const pager = createPager(changes);
    await pager.loadMore(); // before any reset: no source, nothing happens
    expect(pager.state().items).toEqual([]);

    const pages: Record<string, CapPage> = {
      first: { items: caps(1, 2, 3), cursor: 'c2', total: 5 },
      c2: { items: caps(3, 4), cursor: 'c3' },
      c3: { items: caps(5) },
    };
    const fetchPage = vi.fn(async (cursor: string | null) => pages[cursor ?? 'first'] ?? { items: [] });
    await pager.reset(fetchPage);
    await pager.loadMore();
    await pager.loadMore();
    expect(fetchPage.mock.calls.map(([c]) => c)).toEqual([null, 'c2', 'c3']);
    expect(pager.state().items.map((c) => c.brand)).toEqual(['Brand 1', 'Brand 2', 'Brand 3', 'Brand 4', 'Brand 5']);
    expect(pager.state()).toMatchObject({ done: true, cursor: null, total: 5, loading: false, error: null });
    await pager.loadMore(); // done: no extra call
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(changes).toHaveBeenCalled();

    // A reset while the old query is in flight: the late answer is ignored.
    let release: (p: CapPage) => void = () => undefined;
    const slow = vi.fn(() => new Promise<CapPage>((resolve) => (release = resolve)));
    const pending = pager.reset(slow);
    expect(pager.state()).toMatchObject({ items: [], loading: true });
    void pager.loadMore(); // while loading: ignored
    expect(slow).toHaveBeenCalledTimes(1);
    const fresh = pager.reset(async () => ({ items: caps(9) }));
    release({ items: caps(8) });
    await Promise.all([pending, fresh]);
    expect(pager.state().items.map((c) => c.brand)).toEqual(['Brand 9']);

    // Errors are kept in the state; a stale error is ignored as well.
    await pager.reset(async () => Promise.reject(new Error('offline')));
    expect(pager.state()).toMatchObject({ loading: false, done: false });
    expect(pager.state().error).toBeInstanceOf(Error);
    let fail: (e: Error) => void = () => undefined;
    const stale = pager.reset(() => new Promise<CapPage>((_, reject) => (fail = reject)));
    const ok = pager.reset(async () => ({ items: caps(1) }));
    fail(new Error('late'));
    await Promise.all([stale, ok]);
    expect(pager.state().error).toBeNull();
  });
});
