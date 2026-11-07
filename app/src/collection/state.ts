// In-memory state of the Collection tab (CAP-23): query, loaded pages and scroll position survive leaving the screen,
// so back navigation from a cap's detail restores filters and scroll without refetching. Kept per app context (no
// module-level globals, CAP-21); lost on reload by design.
import type { Cap } from '@capcollector/shared';

import type { AppContext } from '../context.js';
import { createPager, type Pager, type PagerState } from './pager.js';
import { DEFAULT_QUERY, type CollectionQuery } from './query.js';

export interface CollectionState {
  query: CollectionQuery;
  readonly pager: Pager;
  /** Last pager change is forwarded to the screen currently mounted (if any). */
  listener: ((state: PagerState) => void) | null;
  /** "Recently added" strip; null until loaded. */
  recent: readonly Cap[] | null;
  /** Country chips, from the last page loaded without a country filter (kept while reloading or filtering). */
  countries: readonly string[];
  scrollY: number;
  /** False until the first page has been requested. */
  started: boolean;
}

const states = new WeakMap<object, CollectionState>();

/** The collection state of this app instance, created on first use. */
export function collectionState(ctx: Pick<AppContext, 'api'>): CollectionState {
  let state = states.get(ctx.api);
  if (!state) {
    const created: CollectionState = {
      query: DEFAULT_QUERY,
      pager: createPager((s) => created.listener?.(s)),
      listener: null,
      recent: null,
      countries: [],
      scrollY: 0,
      started: false,
    };
    state = created;
    states.set(ctx.api, state);
  }
  return state;
}

/** A cap was deleted (CAP-24): drop it from the loaded grid and the "Recently added" strip without refetching. */
export function forgetCap(ctx: Pick<AppContext, 'api'>, capId: string): void {
  const state = collectionState(ctx);
  state.pager.remove(capId);
  if (state.recent !== null) state.recent = state.recent.filter((c) => c.capId !== capId);
}
