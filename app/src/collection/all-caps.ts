// Every live cap, all pages of `GET /caps` at the largest page the contract allows (openapi.yaml § /caps: limit ≤ 200).
// Used where the client needs the whole collection: the insert PDF (CAP-54) and the Stats tab (CAP-58).
import type { Cap } from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import { CapPageSchema, type CapPage } from './cap-page.js';
import { capsPath, DEFAULT_QUERY } from './query.js';

/** The largest page the contract allows (`limit` ≤ 200). */
export const FETCH_LIMIT = 200;
/** Safety stop for a runaway cursor. */
const MAX_PAGES = 50;

export async function fetchAllCaps(api: Pick<ApiClient, 'request'>): Promise<Cap[]> {
  const caps: Cap[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < MAX_PAGES; i++) {
    const page: CapPage = await api.request(capsPath(DEFAULT_QUERY, { limit: FETCH_LIMIT, cursor }), {
      schema: CapPageSchema,
    });
    caps.push(...page.items);
    cursor = page.cursor ?? null;
    if (cursor === null) break;
  }
  return caps;
}
