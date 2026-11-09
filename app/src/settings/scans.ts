// "Scans & AI cost" in Settings (CAP-58; ADR-004 threshold tuning; openapi `GET /scans`, newest first, limit ≤ 200,
// cursor): the last 50 scans with outcome, best dHash distance against the threshold, model, tokens and estimated
// cost, plus the AI cost of the last 7 days. Pages are read only until they reach past the 7 days (or a safety stop),
// so the week total covers every scan of the week. DOM-free.
import { Scan } from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import type { Schema } from '../api/schema.js';

export const SCANS_SHOWN = 50;
export const SCAN_PAGE = 200;
export const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
/** At most this many pages for the week total; beyond it the total is marked partial. */
const MAX_PAGES = 5;

export interface ScanPage {
  readonly items: Scan[];
  readonly cursor?: string;
}

export const ScanPageSchema: Schema<ScanPage> = {
  safeParse(data) {
    const fail = (message: string) => ({ success: false as const, error: new Error(`scans page: ${message}`) });
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not an object');
    const { items, cursor } = data as Record<string, unknown>;
    if (!Array.isArray(items)) return fail('items must be an array');
    const scans: Scan[] = [];
    for (const [i, item] of items.entries()) {
      const parsed = Scan.safeParse(item);
      if (!parsed.success) return fail(`items[${String(i)}]: ${parsed.error.message}`);
      scans.push(parsed.data);
    }
    if (cursor !== undefined && typeof cursor !== 'string') return fail('cursor must be a string');
    return { success: true, data: typeof cursor === 'string' ? { items: scans, cursor } : { items: scans } };
  },
};

export interface WeekCost {
  readonly costUsd: number;
  readonly aiCalls: number;
  readonly scans: number;
  /** False when the safety stop cut the reading short (the totals are then a lower bound). */
  readonly complete: boolean;
}

export interface ScanReport {
  /** Newest first, at most SCANS_SHOWN. */
  readonly recent: readonly Scan[];
  readonly week: WeekCost;
}

const time = (s: Scan) => Date.parse(s.ts);

export async function scanReport(api: Pick<ApiClient, 'request'>, now: Date): Promise<ScanReport> {
  const since = now.getTime() - WEEK_MS;
  const scans: Scan[] = [];
  let cursor: string | undefined;
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({ limit: String(SCAN_PAGE) });
    if (cursor !== undefined) params.set('cursor', cursor);
    const result = await api.request(`/scans?${params.toString()}`, { schema: ScanPageSchema });
    scans.push(...result.items);
    cursor = result.cursor;
    const oldest = Math.min(...result.items.map(time));
    if (cursor === undefined || result.items.length === 0 || oldest < since) {
      complete = true;
      break;
    }
  }
  scans.sort((a, b) => time(b) - time(a));
  const week = scans.filter((s) => time(s) >= since);
  return {
    recent: scans.slice(0, SCANS_SHOWN),
    week: {
      costUsd: week.reduce((sum, s) => sum + (s.costEstimateUsd ?? 0), 0),
      aiCalls: week.filter((s) => s.aiCalled).length,
      scans: week.length,
      complete,
    },
  };
}
