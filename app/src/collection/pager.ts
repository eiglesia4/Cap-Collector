// Cursor paging of the collection grid (CAP-23): appends each page, drops caps already shown (a cap edited between
// two pages can move across the cursor), and ignores answers to a query that has since been replaced.
import type { Cap } from '@capcollector/shared';

import type { CapPage } from './cap-page.js';

export type FetchPage = (cursor: string | null) => Promise<CapPage>;

export interface PagerState {
  readonly items: readonly Cap[];
  /** Cursor of the next page; null once the last page is in. */
  readonly cursor: string | null;
  readonly done: boolean;
  /** Collection size from the API when it reports one (only while ≤ 5 000, CAP-18). */
  readonly total: number | null;
  readonly loading: boolean;
  readonly error: unknown;
}

export interface Pager {
  state(): PagerState;
  /** Start over with a new page source (new search, chip or sort) and load its first page. */
  reset(fetchPage: FetchPage): Promise<void>;
  /** Load the next page; no-op while loading, after the last page or before the first reset. */
  loadMore(): Promise<void>;
  /** Drop a cap that was deleted elsewhere (CAP-24), keeping the loaded pages and the scroll position. */
  remove(capId: string): void;
}

const EMPTY: PagerState = { items: [], cursor: null, done: false, total: null, loading: false, error: null };

export function createPager(onChange: (state: PagerState) => void = () => undefined): Pager {
  let state = EMPTY;
  let source: FetchPage | null = null;
  let generation = 0;

  const set = (next: Partial<PagerState>) => {
    state = { ...state, ...next };
    onChange(state);
  };

  async function load(): Promise<void> {
    const fetchPage = source;
    if (fetchPage === null) return;
    const mine = generation;
    set({ loading: true, error: null });
    try {
      const page = await fetchPage(state.cursor);
      if (mine !== generation) return;
      const seen = new Set(state.items.map((c) => c.capId));
      const fresh = page.items.filter((c) => !seen.has(c.capId) && seen.add(c.capId));
      const cursor = page.cursor ?? null;
      set({
        items: [...state.items, ...fresh],
        cursor,
        done: cursor === null,
        total: page.total ?? state.total,
        loading: false,
      });
    } catch (error) {
      if (mine !== generation) return;
      set({ loading: false, error });
    }
  }

  return {
    state: () => state,
    reset(fetchPage) {
      generation += 1;
      source = fetchPage;
      state = EMPTY;
      return load();
    },
    loadMore() {
      if (state.loading || state.done || source === null) return Promise.resolve();
      return load();
    },
    remove(capId) {
      const items = state.items.filter((c) => c.capId !== capId);
      if (items.length === state.items.length) return;
      set({ items, total: state.total === null ? null : Math.max(0, state.total - 1) });
    },
  };
}
