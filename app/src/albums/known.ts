// What the sheet view knows without asking the API (CAP-52): caps already loaded elsewhere in the app — the
// Collection grid and strip (collection/state.ts) and the caps opened on Detail — for their presigned thumbnail
// (`SheetPocket.thumbKey` is an S3 key, not a URL; a presigned `thumbUrl` arrives with contracts v0.3), and the
// pockets used per loaded sheet, for the Albums list's `used / total` ("—" until the album has been opened once).
// Kept per app context (no module-level globals, CAP-21); lost on reload by design.
import type { Cap } from '@capcollector/shared';

import type { AppContext } from '../context.js';
import { collectionState } from '../collection/state.js';

interface Known {
  /** Caps seen on Detail, by id. */
  readonly caps: Map<string, Cap>;
  /** albumId → sheet → occupied pockets, for the sheets loaded so far. */
  readonly used: Map<string, Map<number, number>>;
}

const known = new WeakMap<object, Known>();

function of(ctx: Pick<AppContext, 'api'>): Known {
  let k = known.get(ctx.api);
  if (!k) {
    k = { caps: new Map(), used: new Map() };
    known.set(ctx.api, k);
  }
  return k;
}

/** Detail loaded this cap: its image URL can serve the sheet view while it is valid. */
export function rememberCap(ctx: Pick<AppContext, 'api'>, cap: Cap): void {
  of(ctx).caps.set(cap.capId, cap);
}

/** The presigned top image of a cap already loaded in the app, if any. */
export function knownThumb(ctx: Pick<AppContext, 'api'>, capId: string): string | undefined {
  const seen = of(ctx).caps.get(capId)?.imageUrls?.top;
  if (seen !== undefined) return seen;
  const state = collectionState(ctx);
  const loaded = [...state.pager.state().items, ...(state.recent ?? [])];
  return loaded.find((c) => c.capId === capId)?.imageUrls?.top;
}

export function recordSheetUsage(ctx: Pick<AppContext, 'api'>, albumId: string, sheet: number, used: number): void {
  const k = of(ctx);
  const sheets = k.used.get(albumId) ?? new Map<number, number>();
  sheets.set(sheet, used);
  k.used.set(albumId, sheets);
}

/** Occupied pockets over the sheets loaded so far; null until the album has been opened once. */
export function usedPockets(ctx: Pick<AppContext, 'api'>, albumId: string): number | null {
  const sheets = of(ctx).used.get(albumId);
  if (!sheets) return null;
  let total = 0;
  for (const n of sheets.values()) total += n;
  return total;
}
