// Tests for the Stats tab (CAP-58; features.md § Phase 2 "Stats tab"): aggregation over a fixture collection, the
// screen's bars and their Collection links, and the in-memory cache with refresh.
import { Cap } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { renderApp, type AppHandle } from '../src/app';
import { collectionFilterPath, DEFAULT_QUERY, queryFromRoute } from '../src/collection/query';
import { countryName } from '../src/i18n/countries';
import { t } from '../src/i18n/i18n';
import { collectionStats, MAX_YEAR_BARS, OTHERS, TOP_COUNTRIES, UNKNOWN } from '../src/stats/aggregate';
import { wireCap, wirePage } from './support/caps';
import { fakeApi, shellContext } from './support/fakes';

const NOW = new Date('2026-11-10T12:00:00.000Z');
const cap = (n: number, fields: Record<string, unknown> = {}) => Cap.parse(wireCap(n, fields));
const COUNTRIES = [
  'ES',
  'FR',
  'DE',
  'IT',
  'PT',
  'BE',
  'NL',
  'GB',
  'IE',
  'US',
  'MX',
  'JP',
  'CN',
  'BR',
  'AR',
  'CL',
  'PE',
];

describe('stats aggregation', () => {
  it('[T-app-117] counts totals and buckets by country (top 15 + others), type, year / decade, status and month', () => {
    // 17 countries: ES ×5, FR ×4, DE ×3, then one each; plus two caps without a country.
    const caps: Cap[] = [];
    let n = 0;
    const add = (fields: Record<string, unknown>) => caps.push(cap(++n, fields));
    for (const [i, country] of COUNTRIES.entries()) {
      const copies = i === 0 ? 5 : i === 1 ? 4 : i === 2 ? 3 : 1;
      for (let c = 0; c < copies; c++) add({ country, brand: `Brand ${country}` });
    }
    add({ brand: 'mahou' });
    add({ brand: 'Mahou ', type: 'beer', status: 'needsReview', year: 1998 });
    add({ brand: 'Gone', deletedAt: '2026-11-02T10:00:00.000Z' }); // tombstones never count
    caps[0] = cap(1, {
      country: 'ES',
      brand: 'Brand ES',
      type: 'beer',
      year: 1999,
      location: { kind: 'album', album: 'A', sheet: 1, pocket: 1 },
      createdAt: '2026-11-03T10:00:00.000Z',
    });
    caps[1] = cap(2, {
      country: 'ES',
      brand: 'Brand ES',
      type: 'soft drink',
      year: 2004,
      status: 'unidentified',
      location: { kind: 'box', album: 'B' },
      createdAt: '2025-12-31T23:00:00.000Z',
    });
    caps[2] = cap(3, {
      country: 'ES',
      brand: 'Brand ES',
      location: { kind: 'frame', album: 'C' },
      createdAt: '2025-11-30T10:00:00.000Z',
    });

    const stats = collectionStats(caps, NOW);
    expect(stats.totals).toEqual({
      caps: 28,
      brands: COUNTRIES.length + 1, // "mahou" and "Mahou " are one brand
      countries: COUNTRIES.length,
      inAlbum: 1,
      loose: 2,
      unplaced: 25,
    });
    // Top 15 by count (ties A–Z), the remaining two summed, unknown last.
    expect(stats.byCountry).toHaveLength(TOP_COUNTRIES + 2);
    expect(stats.byCountry.slice(0, 4)).toEqual([
      { key: 'ES', count: 5 },
      { key: 'FR', count: 4 },
      { key: 'DE', count: 3 },
      { key: 'AR', count: 1 },
    ]);
    expect(stats.byCountry.at(-2)).toEqual({ key: OTHERS, count: 2 });
    expect(stats.byCountry.at(-1)).toEqual({ key: UNKNOWN, count: 2 });
    expect(stats.byType).toEqual([
      { key: 'beer', count: 2 },
      { key: 'soft drink', count: 1 },
      { key: UNKNOWN, count: 25 },
    ]);
    // Three distinct years → single years, ascending.
    expect(stats.byYear).toEqual({
      unit: 'year',
      bars: [
        { key: '1998', count: 1 },
        { key: '1999', count: 1 },
        { key: '2004', count: 1 },
        { key: UNKNOWN, count: 25 },
      ],
    });
    expect(stats.byStatus).toEqual([
      { key: 'complete', count: 26 },
      { key: 'needsReview', count: 1 },
      { key: 'unidentified', count: 1 },
    ]);
    // The 12 months ending November 2026 (UTC); November 2025 falls outside, December 2025 is the first.
    expect(stats.perMonth.map((b) => b.key)).toEqual([
      '2025-12',
      '2026-01',
      '2026-02',
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
      '2026-11',
    ]);
    expect(stats.perMonth[0]).toEqual({ key: '2025-12', count: 1 });
    expect(stats.perMonth.at(-1)).toEqual({ key: '2026-11', count: 26 });

    // Years spread over more than MAX_YEAR_BARS distinct values → decades.
    const spread = Array.from({ length: MAX_YEAR_BARS + 1 }, (_, i) => cap(100 + i, { year: 1960 + i * 3 }));
    expect(collectionStats(spread, NOW).byYear).toEqual({
      unit: 'decade',
      bars: [
        { key: '1960', count: 4 },
        { key: '1970', count: 3 },
        { key: '1980', count: 3 },
        { key: '1990', count: 3 },
      ],
    });
    expect(collectionStats([], NOW).totals.caps).toBe(0);
  });
});

describe('stats screen', () => {
  let handle: AppHandle | undefined;
  afterEach(() => handle?.destroy());

  it('[T-app-118] renders totals and bars, a country bar opens the filtered Collection, Refresh fetches again', async () => {
    let pages = 0;
    const caps = [
      wireCap(1, { country: 'ES', type: 'beer', year: 1990 }),
      wireCap(2, { country: 'ES', status: 'needsReview' }),
      wireCap(3, { country: 'FR' }),
    ];
    const paths: string[] = [];
    const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
      paths.push(path);
      let answer: unknown = wirePage([]);
      if (path.includes('limit=200')) {
        pages += 1;
        // Two pages: the cursor is followed.
        answer = path.includes('cursor=') ? wirePage(caps.slice(2)) : wirePage(caps.slice(0, 2), { cursor: 'next' });
      }
      const parsed = opts.schema.safeParse(answer);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
    const ctx = await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }) });
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    window.history.replaceState(null, '', '/stats');
    handle = renderApp(root, ctx);
    await vi.waitFor(() => expect(root.querySelector('.stats-totals')).not.toBeNull());
    expect(pages).toBe(2);

    const total = (key: string) => root.querySelector(`[data-total="${key}"] dd`)?.textContent;
    expect([total('caps'), total('brands'), total('countries'), total('unplaced')]).toEqual(['3', '3', '2', '3']);
    const es = root.querySelector<HTMLAnchorElement>('.stats-bar--link[data-key="ES"]');
    expect(es?.querySelector('.stats-bar__label')?.textContent).toBe(countryName('ES'));
    expect(es?.querySelector('.stats-bar__count')?.textContent).toBe('2');
    expect(es?.querySelector<HTMLElement>('.stats-bar__fill')?.style.width).toBe('100%');
    expect(root.querySelector<HTMLElement>('[data-key="FR"] .stats-bar__fill')?.style.width).toBe('50%');
    expect(es?.getAttribute('href')).toBe('/?country=ES');
    expect(root.querySelector('a[data-key="beer"]')?.getAttribute('href')).toBe('/?type=beer');
    expect(root.querySelector('a[data-key="needsReview"]')?.getAttribute('href')).toBe('/?status=needsReview');
    // Years, months, "not set" and empty bars are not links (Collection cannot filter by them).
    expect(root.querySelector('a[data-key="1990"]')).toBeNull();
    expect(root.querySelector('a[data-key="unknown"]')).toBeNull();
    expect(root.querySelector('a[data-key="unidentified"]')).toBeNull();
    expect(root.querySelector('a[data-key="2026-11"]')).toBeNull();
    expect([...root.querySelectorAll('.stats-section__title')].map((e) => e.textContent)).toEqual([
      t('stats.byCountry'),
      t('stats.byType'),
      t('stats.byYear'),
      t('stats.byStatus'),
      t('stats.perMonth'),
    ]);

    // Leaving and coming back uses the cache; Refresh fetches again.
    handle.router.navigate('/settings');
    handle.router.navigate('/stats');
    await vi.waitFor(() => expect(root.querySelector('.stats-totals')).not.toBeNull());
    expect(pages).toBe(2);
    root.querySelector<HTMLButtonElement>('[data-action="refresh"]')?.click();
    await vi.waitFor(() => expect(pages).toBe(4));

    // The country bar lands on Collection filtered by that country.
    paths.length = 0;
    root.querySelector<HTMLAnchorElement>('.stats-bar--link[data-key="ES"]')?.click();
    await vi.waitFor(() => expect(paths.some((p) => p.startsWith('/caps?') && p.includes('country=ES'))).toBe(true));
    expect(window.location.pathname + window.location.search).toBe('/?country=ES');
    expect(root.querySelector('h1')?.textContent).toBe(t('collection.title'));
  });

  it('[T-app-119] a linked filter (`/?country=…`, `?type=`, `?status=needsReview`) replaces the Collection query; junk is ignored', async () => {
    expect(queryFromRoute({ country: 'ES' })).toEqual({ ...DEFAULT_QUERY, country: 'ES' });
    expect(queryFromRoute({ type: 'soft drink' })).toEqual({ ...DEFAULT_QUERY, type: 'soft drink' });
    expect(queryFromRoute({ status: 'needsReview' })).toEqual({ ...DEFAULT_QUERY, needsReview: true });
    expect(queryFromRoute({ country: 'es', type: 'juice', status: 'complete' })).toBeNull();
    expect(queryFromRoute({})).toBeNull();
    expect(collectionFilterPath({ type: 'soft drink' })).toBe('/?type=soft+drink');
    expect(collectionFilterPath({})).toBe('/');

    const paths: string[] = [];
    const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
      paths.push(path);
      const parsed = opts.schema.safeParse(wirePage([wireCap(1, { type: 'beer' })]));
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
    const ctx = await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }) });
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    window.history.replaceState(null, '', '/?type=beer');
    handle = renderApp(root, ctx);
    await vi.waitFor(() => expect(paths.some((p) => p.includes('type=beer') && p.includes('limit=60'))).toBe(true));
    const selected = [...root.querySelectorAll('[aria-pressed="true"]')].map((e) => e.textContent);
    expect(selected).toContain(t('capType.beer'));
  });
});
