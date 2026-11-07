// Cap fixtures for the collection tests (CAP-23): wire-shaped caps (as `GET /caps` returns them) and a page builder.

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** A valid ULID that sorts by `n`. */
export function ulid(n: number): string {
  let s = '';
  let v = n;
  for (let i = 0; i < 10; i++) {
    s = (CROCKFORD[v % 32] ?? '0') + s;
    v = Math.floor(v / 32);
  }
  return '01JBF70A1B2C3D4E' + s;
}

export function wireCap(n: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    capId: ulid(n),
    status: 'complete',
    images: { top: { key: `u1/${ulid(n)}/top.webp`, width: 1024, height: 1024 } },
    createdAt: '2026-11-01T10:00:00.000Z',
    updatedAt: '2026-11-01T10:00:00.000Z',
    brand: `Brand ${n}`,
    tags: [],
    quantity: 1,
    forTrade: 0,
    source: 'manual',
    ...fields,
  };
}

export function wirePage(caps: Record<string, unknown>[], extra: { cursor?: string; total?: number } = {}) {
  return { items: caps, ...extra };
}
