// Response schema of `GET /caps` (openapi.yaml § CapPage: `items`, optional `cursor` and `total`), each item parsed
// with the shared `Cap` contract — the client never casts a body (CAP-21).
//
// SPEC-GAP CAP-23: the story names a shared `CapPage`, but `@capcollector/shared` 0.2.0 only has it in openapi.yaml
// (no zod schema) and app/ has no direct `zod` dependency; it is assembled here from the shared `Cap` schema,
// exactly as openapi.yaml describes it. To be replaced by the shared schema once the architect publishes it.
import { Cap } from '@capcollector/shared';

import type { Schema } from '../api/schema.js';

export interface CapPage {
  readonly items: Cap[];
  readonly cursor?: string;
  readonly total?: number;
}

function fail(message: string) {
  return { success: false as const, error: new Error(`caps page: ${message}`) };
}

export const CapPageSchema: Schema<CapPage> = {
  safeParse(data) {
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return fail('not an object');
    const { items, cursor, total } = data as Record<string, unknown>;
    if (!Array.isArray(items)) return fail('items must be an array');
    const caps: Cap[] = [];
    for (const [i, item] of items.entries()) {
      const parsed = Cap.safeParse(item);
      if (!parsed.success) return fail(`items[${i}]: ${parsed.error.message}`);
      caps.push(parsed.data);
    }
    if (cursor !== undefined && typeof cursor !== 'string') return fail('cursor must be a string');
    if (total !== undefined && (typeof total !== 'number' || !Number.isInteger(total) || total < 0))
      return fail('total must be a non-negative integer');
    const page: { items: Cap[]; cursor?: string; total?: number } = { items: caps };
    if (cursor !== undefined && cursor !== '') page.cursor = cursor;
    if (total !== undefined) page.total = total;
    return { success: true, data: page };
  },
};
