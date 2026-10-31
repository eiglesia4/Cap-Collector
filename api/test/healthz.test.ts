// Tests for GET /healthz (CAP-11).
import { describe, expect, it } from 'vitest';

import { handler } from '../src/handlers/healthz.js';

describe('healthz', () => {
  it('[T-api-001] returns 200 with status ok as uncached JSON', async () => {
    const res = await handler();
    expect(res).toMatchObject({
      statusCode: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
    expect(typeof res).toBe('object');
    expect(JSON.parse((res as { body: string }).body)).toEqual({ status: 'ok' });
  });
});
