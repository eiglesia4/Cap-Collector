// What the insert PDF covers (CAP-54; physical-link.md § Insert discs: scopes this sheet · since last print · whole
// album): every live cap placed in the album is read with `GET /caps` (no album filter in the contract, so all pages,
// filtered here), then narrowed to a scope. "Since last print" compares `updatedAt` (it moves on placement, moves and
// edits) with a per-album timestamp kept in `platform.store`, set by "Mark as printed". The index pages cover the
// sheets that hold a printed disc, each with all its caps. DOM-free.
import type { Album, AlbumLocation, Cap } from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import { CapPageSchema, type CapPage } from '../collection/cap-page.js';
import { capsPath, DEFAULT_QUERY } from '../collection/query.js';
import type { KeyValueStore } from '../platform/platform.js';
import type { IndexSheet } from './inserts.js';

export type PrintScope = 'sheet' | 'since' | 'album';

/** The largest page the contract allows (`limit` ≤ 200). */
export const FETCH_LIMIT = 200;
/** Safety stop for a runaway cursor. */
const MAX_PAGES = 50;

export const lastPrintKey = (albumId: string) => `print.last.${albumId}`;

export async function readLastPrint(store: KeyValueStore, albumId: string): Promise<Date | null> {
  const raw = await store.get(lastPrintKey(albumId));
  if (raw === null) return null;
  const date = new Date(raw);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function markPrinted(store: KeyValueStore, albumId: string, when: Date): Promise<void> {
  return store.set(lastPrintKey(albumId), when.toISOString());
}

/** Every live cap, all pages of `GET /caps`. */
export async function fetchAllCaps(api: ApiClient): Promise<Cap[]> {
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

type Placed = Cap & { location: AlbumLocation };

function placedIn(cap: Cap, album: Album): cap is Placed {
  return cap.location?.kind === 'album' && cap.location.album === album.letter && cap.deletedAt === undefined;
}

/** The caps placed in `album`, by sheet then pocket. */
export function albumCaps(caps: readonly Cap[], album: Album): Placed[] {
  return caps
    .filter((c): c is Placed => placedIn(c, album))
    .sort((a, b) => a.location.sheet - b.location.sheet || a.location.pocket - b.location.pocket);
}

export interface ScopeOptions {
  readonly sheet: number;
  /** Last "Mark as printed"; null = never, so everything counts as new. */
  readonly since: Date | null;
}

/** The discs of a scope, in sheet / pocket order. */
export function scopeCaps(inAlbum: readonly Placed[], scope: PrintScope, options: ScopeOptions): Placed[] {
  if (scope === 'sheet') return inAlbum.filter((c) => c.location.sheet === options.sheet);
  if (scope === 'since') {
    const since = options.since;
    return since === null ? [...inAlbum] : inAlbum.filter((c) => new Date(c.updatedAt) > since);
  }
  return [...inAlbum];
}

/** Index pages: every sheet holding one of `discs` — or the chosen sheet for the sheet scope — with all its caps. */
export function indexSheets(
  inAlbum: readonly Placed[],
  discs: readonly Placed[],
  scope: PrintScope,
  sheet: number,
): IndexSheet[] {
  const numbers = new Set(discs.map((c) => c.location.sheet));
  if (scope === 'sheet') numbers.add(sheet);
  return [...numbers]
    .sort((a, b) => a - b)
    .map((n) => ({ sheet: n, caps: inAlbum.filter((c) => c.location.sheet === n) }));
}
