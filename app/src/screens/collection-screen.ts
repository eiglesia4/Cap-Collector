// Collection tab (SCREENS.md #1, CAP-23): header with the cap count, sort sheet and the "⋯" menu (Albums, Exchange,
// Settings); search (debounced, `q`), filter chips (All · type · top countries · Needs review), the "Recently added"
// strip, the 3-column grid with cursor-based infinite scroll, pull-to-refresh on iOS and the empty state. Filters,
// loaded pages and scroll live in collection/state.ts so coming back from a cap's detail restores them.
import type { Cap, CapType } from '@capcollector/shared';

import type { CapPage } from '../collection/cap-page.js';
import { CapPageSchema } from '../collection/cap-page.js';
import type { PagerState } from '../collection/pager.js';
import {
  capsPath,
  DEFAULT_QUERY,
  isFiltered,
  RECENT_SIZE,
  SORTS,
  topCountries,
  type CollectionQuery,
  type Sort,
} from '../collection/query.js';
import { collectionState } from '../collection/state.js';
import { CapTile } from '../components/cap-tile.js';
import { ScreenHeader } from '../components/screen-header.js';
import type { AppContext, Screen } from '../context.js';
import { countryName } from '../i18n/countries.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { TYPE_LABEL } from '../i18n/labels.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

/** Search waits this long after the last keystroke (story: debounced 300 ms). */
export const SEARCH_DEBOUNCE_MS = 300;
/** Pull distance (px) that triggers a refresh on iOS. */
export const PULL_THRESHOLD = 70;

const TYPE_CHIPS: readonly CapType[] = ['beer', 'soft drink', 'water', 'cider', 'wine', 'other'];

const SORT_LABEL: Record<Sort, MessageKey> = {
  brand: 'collection.sortBrand',
  newest: 'collection.sortNewest',
  country: 'collection.sortCountry',
  year: 'collection.sortYear',
};

const numberFormat = new Intl.NumberFormat('en-US');

function capsCount(n: number): string {
  return n === 1 ? t('collection.countOne') : t('collection.count', { count: numberFormat.format(n) });
}

/** "1,284 caps" from `total`; without it "60+ caps" while more pages remain, else the exact loaded count. */
export function countLabel(state: Pick<PagerState, 'items' | 'total' | 'done'>): string {
  if (state.total !== null) return capsCount(state.total);
  if (!state.done) return t('collection.countMore', { count: numberFormat.format(state.items.length) });
  return capsCount(state.items.length);
}

function fetchPage(ctx: AppContext, query: CollectionQuery) {
  return (cursor: string | null): Promise<CapPage> =>
    ctx.api.request(capsPath(query, { cursor }), { schema: CapPageSchema });
}

export const CollectionScreen: Screen = (ctx) => {
  const store = collectionState(ctx);
  const win = window;

  // ── header ──
  const count = h('p', { class: 'collection-count muted', attrs: { 'aria-live': 'polite' } });
  const link = (route: 'albums' | 'exchange' | 'settings', label: string) =>
    h('a', { class: 'menu-item', attrs: { href: pathFor(route), 'data-link': true } }, label);
  const more = h(
    'details',
    { class: 'more-menu' },
    h(
      'summary',
      { class: 'header-action', attrs: { 'aria-label': t('collection.more') } },
      h('span', { class: 'icon-more', attrs: { 'aria-hidden': 'true' } }),
    ),
    h(
      'div',
      { class: 'menu' },
      link('albums', t('albums.title')),
      link('exchange', t('exchange.title')),
      link('settings', t('settings.title')),
    ),
  );

  const sortMenu = h('div', { class: 'menu', attrs: { role: 'menu' } });
  const sort = h(
    'details',
    { class: 'more-menu sort-menu' },
    h(
      'summary',
      { class: 'header-action', attrs: { 'aria-label': t('collection.sort') } },
      h('span', { class: 'icon-sort', attrs: { 'aria-hidden': 'true' } }),
    ),
    sortMenu,
  );
  const renderSortMenu = () => {
    sortMenu.replaceChildren(
      ...SORTS.map((s) => {
        const item = h(
          'button',
          {
            class: 'menu-item',
            attrs: { type: 'button', role: 'menuitemradio', 'aria-checked': String(store.query.sort === s) },
            on: {
              click: () => {
                sort.open = false;
                update({ sort: s });
              },
            },
          },
          t(SORT_LABEL[s]),
        );
        item.dataset.sort = s;
        return item;
      }),
    );
  };

  // ── search & chips ──
  const search = h('input', {
    class: 'input search-input',
    attrs: { type: 'search', enterkeyhint: 'search', autocomplete: 'off', 'aria-label': t('collection.search') },
  });
  search.placeholder = t('collection.searchPlaceholder');
  search.value = store.query.q;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  search.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => update({ q: search.value }), SEARCH_DEBOUNCE_MS);
  });
  search.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    clearTimeout(debounce);
    update({ q: search.value });
  });

  const chips = h('div', { class: 'chips', attrs: { role: 'toolbar', 'aria-label': t('collection.filters') } });
  const chip = (key: string, label: string, pressed: boolean, onClick: () => void) => {
    const el = h(
      'button',
      { class: 'chip', attrs: { type: 'button', 'aria-pressed': String(pressed) }, on: { click: onClick } },
      label,
    );
    el.dataset.chip = key;
    return el;
  };
  const renderChips = () => {
    const q = store.query;
    const all = q.type === null && q.country === null && !q.needsReview;
    chips.replaceChildren(
      chip('all', t('collection.chipAll'), all, () => update({ type: null, country: null, needsReview: false })),
      ...TYPE_CHIPS.map((type) =>
        chip(`type:${type}`, t(TYPE_LABEL[type]), q.type === type, () =>
          update({ type: q.type === type ? null : type }),
        ),
      ),
      ...[...store.countries, ...(q.country !== null && !store.countries.includes(q.country) ? [q.country] : [])].map(
        (c) =>
          chip(`country:${c}`, countryName(c), q.country === c, () => update({ country: q.country === c ? null : c })),
      ),
      chip('needsReview', t('collection.chipNeedsReview'), q.needsReview, () =>
        update({ needsReview: !q.needsReview }),
      ),
    );
  };

  // ── recently added, grid, footer ──
  const recentList = h('ul', { class: 'cap-strip' });
  const recent = h(
    'section',
    { class: 'collection-recent' },
    h('h2', { class: 'section-title' }, t('collection.recent')),
    recentList,
  );
  const renderRecent = () => {
    const caps = store.recent ?? [];
    recent.hidden = isFiltered(store.query) || caps.length === 0;
    recentList.replaceChildren(...caps.map(CapTile));
  };

  const grid = h('ul', { class: 'cap-grid', attrs: { 'aria-label': t('collection.title') } });
  let rendered: readonly Cap[] = [];

  const message = h('div', { class: 'collection-message', attrs: { role: 'status' } });
  const loadMore = h(
    'button',
    {
      class: 'button button--secondary load-more',
      attrs: { type: 'button' },
      on: { click: () => void store.pager.loadMore() },
    },
    t('collection.loadMore'),
  );

  const emptyState = () =>
    h(
      'div',
      { class: 'empty-state' },
      h('p', {}, t('collection.empty')),
      h(
        'a',
        { class: 'fab', attrs: { href: pathFor('newCap'), 'data-link': true, 'aria-label': t('collection.add') } },
        t('collection.addSymbol'),
      ),
    );

  const render = (state: PagerState) => {
    count.textContent = state.items.length === 0 && !state.done ? '' : countLabel(state);
    // A reset (new query) shrinks or replaces the list: rebuild; otherwise append only the new caps.
    const appended = rendered.length <= state.items.length && rendered.every((c, i) => state.items[i] === c);
    if (!appended) grid.replaceChildren();
    grid.append(...state.items.slice(appended ? rendered.length : 0).map(CapTile));
    rendered = state.items;
    if (state.items.length > 0 && store.query.country === null) store.countries = topCountries(state.items, null);

    if (state.error !== null) {
      const retry = () => (state.items.length === 0 ? refresh() : store.pager.loadMore());
      message.replaceChildren(
        h('p', {}, t('collection.loadFailed')),
        h(
          'button',
          { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => void retry() } },
          t('common.retry'),
        ),
      );
    } else if (state.done && state.items.length === 0) {
      message.replaceChildren(
        isFiltered(store.query) ? h('p', { class: 'muted' }, t('collection.noMatch')) : emptyState(),
      );
    } else if (state.loading && state.items.length === 0) {
      message.replaceChildren(h('p', { class: 'muted' }, t('collection.loading')));
    } else {
      message.replaceChildren();
    }
    loadMore.hidden = state.done || state.error !== null || state.items.length === 0;
    loadMore.disabled = state.loading;
    renderChips();
  };

  // ── data ──
  const loadRecent = () => {
    if (isFiltered(store.query)) return;
    const query: CollectionQuery = { ...DEFAULT_QUERY, sort: 'newest' };
    Promise.resolve()
      .then(() => ctx.api.request(capsPath(query, { limit: RECENT_SIZE }), { schema: CapPageSchema }))
      .then((page) => {
        store.recent = page.items.slice(0, RECENT_SIZE);
        renderRecent();
      })
      // The strip is a convenience: a failure leaves it as it was; the grid reports errors.
      .catch(() => undefined);
  };

  function refresh(): Promise<void> {
    store.started = true;
    loadRecent();
    return store.pager.reset(fetchPage(ctx, store.query));
  }

  function update(change: Partial<CollectionQuery>): void {
    const next = { ...store.query, ...change };
    if (JSON.stringify(next) === JSON.stringify(store.query)) return;
    store.query = next;
    store.scrollY = 0;
    renderSortMenu();
    renderRecent();
    void refresh();
  }

  const el = h(
    'section',
    { class: 'screen collection' },
    ScreenHeader(t('collection.title'), h('span', { class: 'header-actions' }, sort, more)),
    count,
    search,
    chips,
    recent,
    grid,
    message,
    loadMore,
  );

  // ── infinite scroll, pull-to-refresh, scroll memory ──
  const IO = (win as Window & { IntersectionObserver?: typeof IntersectionObserver }).IntersectionObserver;
  if (IO) {
    const observer = new IO(
      (entries) => {
        if (!el.isConnected) return observer.disconnect();
        if (entries.some((e) => e.isIntersecting)) void store.pager.loadMore();
      },
      { rootMargin: '600px 0px' },
    );
    observer.observe(loadMore);
  }

  const onScroll = () => {
    if (!el.isConnected) return win.removeEventListener('scroll', onScroll);
    store.scrollY = win.scrollY;
  };
  win.addEventListener('scroll', onScroll, { passive: true });

  if (ctx.platform.kind === 'native') {
    let startY: number | null = null;
    el.addEventListener(
      'touchstart',
      (e) => {
        startY = win.scrollY <= 0 ? (e.touches[0]?.clientY ?? null) : null;
      },
      { passive: true },
    );
    el.addEventListener('touchend', (e) => {
      const endY = e.changedTouches[0]?.clientY;
      if (startY !== null && endY !== undefined && endY - startY >= PULL_THRESHOLD) void refresh();
      startY = null;
    });
  }

  // The newest mounted screen receives pager changes; an older (detached) one stops being notified.
  store.listener = render;
  renderSortMenu();
  renderRecent();
  if (store.started) {
    render(store.pager.state());
    const y = store.scrollY;
    // Restore once the screen is in the document (the shell inserts it right after this returns).
    setTimeout(() => win.scrollTo(0, y), 0);
  } else {
    void refresh();
  }
  return el;
};
