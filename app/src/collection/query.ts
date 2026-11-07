// Collection query (CAP-23, SCREENS.md #1): what the search field, the filter chips and the sort sheet select, and its
// mapping 1:1 onto the `GET /caps` query parameters (openapi.yaml § /caps). One value per dimension — the API takes a
// single `type` and a single `country` — and chips of different dimensions combine with AND.
import type { Cap, CapType } from '@capcollector/shared';

export const SORTS = ['brand', 'newest', 'country', 'year'] as const;
export type Sort = (typeof SORTS)[number];

/** Page size of the grid (openapi default 60, max 200). */
export const PAGE_SIZE = 60;
/** "Recently added" strip: first three of `sort=newest`. */
export const RECENT_SIZE = 3;
/** Country chips shown, computed from the loaded caps. */
export const TOP_COUNTRIES = 4;

export interface CollectionQuery {
  /** Free text as typed; a location code such as `A·3·17` is passed as-is (the API matches it by location). */
  readonly q: string;
  readonly type: CapType | null;
  readonly country: string | null;
  readonly needsReview: boolean;
  readonly sort: Sort;
}

export const DEFAULT_QUERY: CollectionQuery = { q: '', type: null, country: null, needsReview: false, sort: 'brand' };

/** True when a search or chip narrows the list (the "All" chip is then not selected). */
export function isFiltered(query: CollectionQuery): boolean {
  return query.q.trim() !== '' || query.type !== null || query.country !== null || query.needsReview;
}

/** `/caps?…` for one page of `query`. Defaults (sort=brand, no cursor) are still sent explicitly for sort. */
export function capsPath(query: CollectionQuery, page: { cursor?: string | null; limit?: number } = {}): string {
  const params = new URLSearchParams();
  const q = query.q.trim();
  if (q !== '') params.set('q', q);
  if (query.type !== null) params.set('type', query.type);
  if (query.country !== null) params.set('country', query.country);
  if (query.needsReview) params.set('status', 'needsReview');
  params.set('sort', query.sort);
  params.set('limit', String(page.limit ?? PAGE_SIZE));
  if (page.cursor) params.set('cursor', page.cursor);
  return `/caps?${params.toString()}`;
}

/** Most frequent countries among `caps` (ties broken A–Z), always keeping `selected` so its chip stays visible. */
export function topCountries(caps: readonly Cap[], selected: string | null, n = TOP_COUNTRIES): string[] {
  const counts = new Map<string, number>();
  for (const cap of caps) if (cap.country) counts.set(cap.country, (counts.get(cap.country) ?? 0) + 1);
  const ranked = [...counts.entries()]
    .sort(([a, x], [b, y]) => y - x || a.localeCompare(b))
    .map(([country]) => country)
    .slice(0, n);
  if (selected !== null && !ranked.includes(selected)) ranked.push(selected);
  return ranked;
}
