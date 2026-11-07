// Response schemas of the cap detail calls (CAP-24, openapi.yaml § /caps/{capId}, /history, DELETE): parsed with
// the shared contracts, never cast (CAP-21). `GET /caps/{capId}` uses the shared `Cap` schema directly.
import { CapHistory } from '@capcollector/shared';

import type { Schema } from '../api/schema.js';

/** `GET /caps/{capId}/history`: an array of `CapHistory`, newest first (openapi.yaml). */
export const CapHistoryListSchema: Schema<CapHistory[]> = {
  safeParse(data) {
    if (!Array.isArray(data)) return { success: false, error: new Error('history: not an array') };
    const entries: CapHistory[] = [];
    for (const [i, item] of data.entries()) {
      const parsed = CapHistory.safeParse(item);
      if (!parsed.success) return { success: false, error: new Error(`history[${i}]: ${parsed.error.message}`) };
      entries.push(parsed.data);
    }
    return { success: true, data: entries };
  },
};

/** `204 No Content` (the client yields `undefined` for an empty body). */
export const NoContentSchema: Schema<void> = {
  safeParse: (data) =>
    data === undefined ? { success: true, data: undefined } : { success: false, error: new Error('expected no body') },
};
