// Collection screen (CAP-23, SCREENS.md #1): grid rendering, empty state, search/chips/sort wiring, recently added,
// infinite scroll, pull-to-refresh and state kept across navigation.
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { brandHue } from '../src/components/cap-tile';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import { matchRoute } from '../src/router/routes';
import { CollectionScreen, countLabel, SEARCH_DEBOUNCE_MS } from '../src/screens/collection-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { fakeApi, flush, shellContext } from './support/fakes';

type Responder = (params: URLSearchParams) => unknown;

/** A fake API whose `request` answers `/caps?…` through `respond` (validated with the real schema). */
function capsApi(respond: Responder) {
  const paths: string[] = [];
  const request = vi.fn(async <T>(path: string, options: RequestOptions<T>): Promise<T> => {
    paths.push(path);
    const url = new URL(path, 'https://api.test');
    const parsed = options.schema.safeParse(await respond(url.searchParams));
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  return { api: fakeApi({ request: request as ApiClient['request'] }), paths, request };
}

async function mount(respond: Responder, kind: 'web' | 'native' = 'native') {
  const { api, paths, request } = capsApi(respond);
  const ctx: AppContext = { ...(await shellContext({ api, kind })), navigate: vi.fn(), skipSignIn: vi.fn() };
  const route = matchRoute('/');
  if (!route) throw new Error('no route');
  const show = () => {
    const el = CollectionScreen(ctx, route);
    document.body.replaceChildren(el);
    return el;
  };
  const el = show();
  await flush();
  return { el, ctx, paths, request, show };
}

const grid = (el: HTMLElement) => [...el.querySelectorAll('.cap-grid .cap-tile')];
const gridParams = (paths: string[]) =>
  paths.map((p) => new URL(p, 'https://x').searchParams).filter((s) => s.get('limit') !== '3');

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('collection screen', () => {
  it('[T-app-031] renders a CapPage as round tiles: brand · variant, country · year, "!" badge, image or brand-hued placeholder', async () => {
    const page = wirePage(
      [
        wireCap(1, {
          brand: 'Mahou',
          variant: 'Clásica',
          country: 'ES',
          year: 2023,
          imageUrls: { top: 'https://img.test/1.webp' },
        }),
        wireCap(2, { brand: 'Chimay', status: 'needsReview' }),
      ],
      { total: 1284, cursor: 'next' },
    );
    const { el } = await mount(() => page);
    const tiles = grid(el);
    expect(tiles).toHaveLength(2);

    const [mahou, chimay] = tiles;
    expect(mahou?.querySelector('.cap-title')?.textContent).toBe('Mahou · Clásica');
    expect(mahou?.querySelector('.cap-subtitle')?.textContent).toBe('ES · 2023');
    expect(mahou?.querySelector('img.cap-thumb')?.getAttribute('src')).toBe('https://img.test/1.webp');
    expect(mahou?.querySelector('.cap-badge')).toBeNull();
    expect(mahou?.querySelector('a')?.getAttribute('href')).toBe(`/cap/${ulid(1)}`);
    expect(mahou?.querySelector('a')?.hasAttribute('data-link')).toBe(true);

    expect(chimay?.querySelector('.cap-title')?.textContent).toBe('Chimay');
    expect(chimay?.querySelector('.cap-subtitle')).toBeNull();
    expect(chimay?.querySelector('.cap-badge')?.textContent).toBe(t('collection.needsReviewBadge'));
    const ph = chimay?.querySelector<HTMLElement>('.cap-thumb--placeholder');
    expect(ph?.getAttribute('style')).toBe(`--cap-hue: ${String(brandHue('Chimay'))}`);
    expect(brandHue(' chimay ')).toBe(brandHue('Chimay'));

    // An expired presigned URL falls back to the placeholder.
    mahou?.querySelector('img')?.dispatchEvent(new Event('error'));
    expect(mahou?.querySelector('.cap-thumb--placeholder')).not.toBeNull();

    expect(el.querySelector('.collection-count')?.textContent).toBe(t('collection.count', { count: '1,284' }));
    expect(countLabel({ items: [], total: 1, done: true })).toBe(t('collection.countOne'));
    expect(countLabel({ items: [], total: null, done: false })).toBe(t('collection.countMore', { count: '0' }));
    expect(countLabel({ items: [], total: null, done: true })).toBe(t('collection.count', { count: '0' }));
  });

  it('[T-app-033] shows the empty state with a ＋ that opens /new; a filtered empty list says nothing matches', async () => {
    const { el } = await mount(() => wirePage([]));
    expect(grid(el)).toHaveLength(0);
    expect(el.querySelector('.empty-state p')?.textContent).toBe(t('collection.empty'));
    const plus = el.querySelector<HTMLAnchorElement>('.empty-state a.fab');
    expect(plus?.getAttribute('href')).toBe('/new');
    expect(plus?.hasAttribute('data-link')).toBe(true);
    expect(plus?.getAttribute('aria-label')).toBe(t('collection.add'));
    expect(el.querySelector<HTMLElement>('.load-more')?.hidden).toBe(true);
    expect(el.querySelector('.collection-count')?.textContent).toBe(t('collection.count', { count: '0' }));

    el.querySelector<HTMLButtonElement>('[data-chip="needsReview"]')?.click();
    await flush();
    expect(el.querySelector('.empty-state')).toBeNull();
    expect(el.querySelector('.collection-message')?.textContent).toBe(t('collection.noMatch'));
  });

  it('[T-app-034] wires search (300 ms debounce), chips and sort to the query; recently added shows only unfiltered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const respond: Responder = (p) => {
      if (p.get('limit') === '3')
        return wirePage([wireCap(7, { brand: 'Newest' }), wireCap(8), wireCap(9), wireCap(10)]);
      return wirePage([wireCap(1, { country: 'BE' }), wireCap(2, { country: 'BE' }), wireCap(3, { country: 'ES' })]);
    };
    const { api, paths } = capsApi(respond);
    const ctx: AppContext = { ...(await shellContext({ api })), navigate: vi.fn(), skipSignIn: vi.fn() };
    const route = matchRoute('/');
    if (!route) throw new Error('no route');
    const el = CollectionScreen(ctx, route);
    document.body.append(el);
    await vi.advanceTimersByTimeAsync(0);

    // Recently added: first 3 of sort=newest, shown above the grid while nothing is filtered.
    const recent = el.querySelector<HTMLElement>('.collection-recent');
    expect(paths).toContain('/caps?sort=newest&limit=3');
    expect(recent?.hidden).toBe(false);
    expect(recent?.querySelectorAll('.cap-tile')).toHaveLength(3);
    expect(recent?.querySelector('.cap-title')?.textContent).toBe('Newest');

    // Chips: All selected; country chips from the loaded page (most frequent first).
    const chipKeys = () => [...el.querySelectorAll<HTMLElement>('.chip')].map((c) => c.dataset.chip);
    expect(chipKeys()).toEqual([
      'all',
      'type:beer',
      'type:soft drink',
      'type:water',
      'type:cider',
      'type:wine',
      'type:other',
      'country:BE',
      'country:ES',
      'needsReview',
    ]);
    const pressed = (key: string) => el.querySelector(`[data-chip="${key}"]`)?.getAttribute('aria-pressed');
    expect(pressed('all')).toBe('true');

    // Search: nothing until 300 ms after the last keystroke.
    const search = el.querySelector<HTMLInputElement>('input[type="search"]');
    if (!search) throw new Error('no search');
    expect(search.placeholder).toBe(t('collection.searchPlaceholder'));
    const before = paths.length;
    search.value = 'Mah';
    search.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    search.value = 'Mahou';
    search.dispatchEvent(new Event('input'));
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS - 1);
    expect(paths.length).toBe(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(gridParams(paths).at(-1)?.get('q')).toBe('Mahou');
    expect(recent?.hidden).toBe(true);

    // Enter searches at once; the same query twice is not refetched.
    search.value = 'A·3·17';
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(gridParams(paths).at(-1)?.get('q')).toBe('A·3·17');
    const n = paths.length;
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'a' }));
    expect(paths.length).toBe(n);

    // Chips: type + country + needs review combine (AND); clicking a selected chip clears it; All clears all chips.
    el.querySelector<HTMLButtonElement>('[data-chip="type:beer"]')?.click();
    el.querySelector<HTMLButtonElement>('[data-chip="country:ES"]')?.click();
    el.querySelector<HTMLButtonElement>('[data-chip="needsReview"]')?.click();
    await vi.advanceTimersByTimeAsync(0);
    const last = gridParams(paths).at(-1);
    expect([last?.get('type'), last?.get('country'), last?.get('status'), last?.get('q')]).toEqual([
      'beer',
      'ES',
      'needsReview',
      'A·3·17',
    ]);
    expect(pressed('all')).toBe('false');
    expect(pressed('type:beer')).toBe('true');
    el.querySelector<HTMLButtonElement>('[data-chip="type:beer"]')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(gridParams(paths).at(-1)?.get('type')).toBeNull();
    el.querySelector<HTMLButtonElement>('[data-chip="all"]')?.click();
    await vi.advanceTimersByTimeAsync(0);
    const cleared = gridParams(paths).at(-1);
    expect([cleared?.get('country'), cleared?.get('status'), cleared?.get('q')]).toEqual([null, null, 'A·3·17']);

    // Sort sheet: brand · newest · country · year; the chosen one is checked and sent.
    const sorts = [...el.querySelectorAll<HTMLElement>('[data-sort]')];
    expect(sorts.map((s) => s.textContent)).toEqual([
      t('collection.sortBrand'),
      t('collection.sortNewest'),
      t('collection.sortCountry'),
      t('collection.sortYear'),
    ]);
    el.querySelector<HTMLButtonElement>('[data-sort="country"]')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(gridParams(paths).at(-1)?.get('sort')).toBe('country');
    expect(el.querySelector('[data-sort="country"]')?.getAttribute('aria-checked')).toBe('true');
  });

  it('[T-app-036] loads the next page from the cursor (button or scroll sentinel), reports errors with retry, pull-to-refresh on iOS', async () => {
    const observers: IntersectionObserverCallback[] = [];
    const disconnect = vi.fn();
    vi.stubGlobal(
      'IntersectionObserver',
      class {
        constructor(cb: IntersectionObserverCallback) {
          observers.push(cb);
        }
        observe() {}
        disconnect = disconnect;
      },
    );
    let failNext = false;
    const { el, paths, show } = await mount((p) => {
      if (p.get('limit') === '3') return wirePage([]);
      if (failNext) {
        failNext = false;
        throw new Error('offline');
      }
      const cursor = p.get('cursor');
      if (cursor === null) return wirePage([wireCap(1), wireCap(2)], { cursor: 'c2' });
      if (cursor === 'c2') return wirePage([wireCap(2), wireCap(3)], { cursor: 'c3' });
      return wirePage([wireCap(4)]);
    });
    const loadMore = el.querySelector<HTMLButtonElement>('.load-more');
    expect(el.querySelector('.collection-count')?.textContent).toBe(t('collection.countMore', { count: '2' }));
    expect(loadMore?.hidden).toBe(false);

    // Sentinel in view → next page; the overlapping cap is not duplicated.
    const fire = (isIntersecting: boolean) =>
      observers[0]?.([{ isIntersecting } as IntersectionObserverEntry], {} as IntersectionObserver);
    fire(false);
    fire(true);
    await flush();
    expect(gridParams(paths).at(-1)?.get('cursor')).toBe('c2');
    expect(grid(el).map((li) => li.querySelector('.cap-title')?.textContent)).toEqual([
      'Brand 1',
      'Brand 2',
      'Brand 3',
    ]);

    // A failing page shows an error with retry, which resumes from the same cursor.
    failNext = true;
    loadMore?.click();
    await flush();
    expect(el.querySelector('.collection-message p')?.textContent).toBe(t('collection.loadFailed'));
    expect(loadMore?.hidden).toBe(true);
    el.querySelector<HTMLButtonElement>('.collection-message button')?.click();
    await flush();
    expect(grid(el)).toHaveLength(4);
    expect(loadMore?.hidden).toBe(true);
    expect(el.querySelector('.collection-count')?.textContent).toBe(t('collection.count', { count: '4' }));

    // Pull-to-refresh (native): a long pull from the top reloads from the first page; a short one does nothing.
    const touch = (type: string, y: number) => {
      const e = new Event(type) as Event & { touches: unknown; changedTouches: unknown };
      Object.assign(e, { touches: [{ clientY: y }], changedTouches: [{ clientY: y }] });
      el.dispatchEvent(e);
    };
    const count = paths.length;
    touch('touchstart', 10);
    touch('touchend', 30);
    expect(paths.length).toBe(count);
    touch('touchstart', 10);
    touch('touchend', 120);
    await flush();
    expect(gridParams(paths.slice(count)).map((p) => p.get('cursor'))).toEqual([null]);
    expect(grid(el)).toHaveLength(2);

    // A screen no longer in the document stops observing.
    show();
    fire(true);
    expect(disconnect).toHaveBeenCalled();

    // A first page that fails: retry starts over.
    failNext = true;
    const again = await mount(() => {
      if (failNext) {
        failNext = false;
        throw new Error('offline');
      }
      return wirePage([wireCap(1)]);
    }, 'web');
    expect(again.el.querySelector('.collection-message p')?.textContent).toBe(t('collection.loadFailed'));
    again.el.querySelector<HTMLButtonElement>('.collection-message button')?.click();
    await flush();
    expect(grid(again.el)).toHaveLength(1);
  });

  it('[T-app-037] keeps filters, loaded caps and scroll position when the screen is shown again (back navigation)', async () => {
    const scrollTo = vi.fn();
    vi.stubGlobal('scrollTo', scrollTo);
    const { el, paths, show } = await mount(() => wirePage([wireCap(1, { country: 'ES' })]));
    el.querySelector<HTMLButtonElement>('[data-chip="country:ES"]')?.click();
    await flush();
    Object.defineProperty(window, 'scrollY', { value: 480, configurable: true });
    window.dispatchEvent(new Event('scroll'));

    const calls = paths.length;
    const back = show();
    await flush();
    expect(paths.length).toBe(calls); // no refetch
    expect(grid(back)).toHaveLength(1);
    expect(back.querySelector('[data-chip="country:ES"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(scrollTo).toHaveBeenCalledWith(0, 480);
    Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });

    // The old (detached) screen unsubscribes from scroll on its next event.
    window.dispatchEvent(new Event('scroll'));
  });
});
