// Stats of the collection (CAP-58; features.md § Phase 2 "Stats tab"; SCREENS.md inventory: Stats is a bottom tab),
// computed on the client from every live cap (`GET /caps`, all pages): totals, and bar series by country (top 15 +
// others), type, year (single years, or decades when the years are spread out), status and caps added per month over
// the last 12 months (`createdAt`, UTC months). DOM- and label-free: bars carry keys, the screen names them.
import { CapStatus, CapType, type Cap } from '@capcollector/shared';

import { normaliseBrand } from '../cap/brand.js';

/** One bar: a country code, type, year / decade start, status or `YYYY-MM`; or `others` / `unknown`. */
export interface Bar {
  readonly key: string;
  readonly count: number;
}

export const OTHERS = 'others';
export const UNKNOWN = 'unknown';
/** Countries shown by name; the rest are summed into "others". */
export const TOP_COUNTRIES = 15;
/** More distinct years than this → decade buckets. */
export const MAX_YEAR_BARS = 12;
export const MONTHS = 12;

export interface Totals {
  readonly caps: number;
  /** Distinct brands, normalised (case, accents, spacing) as the duplicate check compares them. */
  readonly brands: number;
  readonly countries: number;
  readonly inAlbum: number;
  /** In a box or a frame. */
  readonly loose: number;
  /** No location. */
  readonly unplaced: number;
}

export interface Stats {
  readonly totals: Totals;
  readonly byCountry: readonly Bar[];
  readonly byType: readonly Bar[];
  readonly byYear: { readonly unit: 'year' | 'decade'; readonly bars: readonly Bar[] };
  readonly byStatus: readonly Bar[];
  /** Oldest month first, months with no additions included. */
  readonly perMonth: readonly Bar[];
}

function count<T>(items: readonly T[], keyOf: (item: T) => string | undefined): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = keyOf(item) ?? UNKNOWN;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** `unknown` always last; the rest by `order`. */
function bars(counts: Map<string, number>, order: (a: Bar, b: Bar) => number): Bar[] {
  const all = [...counts.entries()].map(([key, n]) => ({ key, count: n }));
  const known = all.filter((b) => b.key !== UNKNOWN).sort(order);
  const unknown = all.filter((b) => b.key === UNKNOWN);
  return [...known, ...unknown];
}

const byCountDesc = (a: Bar, b: Bar) => b.count - a.count || a.key.localeCompare(b.key);

function countryBars(caps: readonly Cap[]): Bar[] {
  const sorted = bars(
    count(caps, (c) => c.country),
    byCountDesc,
  );
  const known = sorted.filter((b) => b.key !== UNKNOWN);
  const unknown = sorted.filter((b) => b.key === UNKNOWN);
  const top = known.slice(0, TOP_COUNTRIES);
  const rest = known.slice(TOP_COUNTRIES).reduce((sum, b) => sum + b.count, 0);
  return [...top, ...(rest > 0 ? [{ key: OTHERS, count: rest }] : []), ...unknown];
}

function yearBars(caps: readonly Cap[]): Stats['byYear'] {
  const years = new Set(caps.flatMap((c) => (c.year === undefined ? [] : [c.year])));
  const unit = years.size > MAX_YEAR_BARS ? 'decade' : 'year';
  const keyOf = (c: Cap) =>
    c.year === undefined ? undefined : String(unit === 'decade' ? Math.floor(c.year / 10) * 10 : c.year);
  return { unit, bars: bars(count(caps, keyOf), (a, b) => Number(a.key) - Number(b.key)) };
}

const monthKey = (d: Date) => `${String(d.getUTCFullYear())}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;

function monthBars(caps: readonly Cap[], now: Date): Bar[] {
  const keys = Array.from({ length: MONTHS }, (_, i) =>
    monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (MONTHS - 1 - i), 1))),
  );
  const counts = new Map(keys.map((k) => [k, 0]));
  for (const cap of caps) {
    const key = monthKey(new Date(cap.createdAt));
    const n = counts.get(key);
    if (n !== undefined) counts.set(key, n + 1);
  }
  return keys.map((key) => ({ key, count: counts.get(key) ?? 0 }));
}

export function collectionStats(all: readonly Cap[], now: Date): Stats {
  const caps = all.filter((c) => c.deletedAt === undefined);
  const kind = (c: Cap) => c.location?.kind;
  const typeOrder = CapType.options as readonly string[];
  const statusCounts = count(caps, (c) => c.status);
  return {
    totals: {
      caps: caps.length,
      brands: new Set(caps.map((c) => normaliseBrand(c.brand))).size,
      countries: new Set(caps.flatMap((c) => (c.country === undefined ? [] : [c.country]))).size,
      inAlbum: caps.filter((c) => kind(c) === 'album').length,
      loose: caps.filter((c) => kind(c) === 'box' || kind(c) === 'frame').length,
      unplaced: caps.filter((c) => kind(c) === undefined).length,
    },
    byCountry: countryBars(caps),
    byType: bars(
      count(caps, (c) => c.type),
      (a, b) => b.count - a.count || typeOrder.indexOf(a.key) - typeOrder.indexOf(b.key),
    ),
    byYear: yearBars(caps),
    byStatus: CapStatus.options.map((key) => ({ key, count: statusCounts.get(key) ?? 0 })),
    perMonth: monthBars(caps, now),
  };
}
