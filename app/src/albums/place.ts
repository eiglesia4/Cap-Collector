// Placing caps in the physical album (CAP-53; physical-link.md § Keeping them in sync: "Save proposes next free
// pocket; moves/swaps are explicit actions with history"; ADR-005; openapi `PUT/DELETE /caps/{id}/location`,
// `GET /albums/{id}/next-free`): the default album (the letter last used, kept in `platform.store`), the next-free
// proposal, the location calls and their 409 ("pocket occupied"), the occupant of a pocket (one sheet query), and a
// typed code `A·3·17` checked against the user's albums. DOM-free; the sheets live in components/place-sheet.ts.
import { Cap, NextFree, SheetView, parseLocationCode, type Album, type AlbumLocation } from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import { HttpError, ProblemError } from '../api/errors.js';
import type { Schema } from '../api/schema.js';
import { NoContentSchema } from '../cap/schemas.js';
import type { KeyValueStore } from '../platform/platform.js';
import { AlbumListSchema, sheetCount } from './model.js';

type SheetPocket = SheetView['pockets'][number];

/** Store key of the album letter last used to place a cap (the default album of the save proposal). */
export const LAST_ALBUM_KEY = 'albums.lastLetter';

export async function readLastAlbum(store: KeyValueStore): Promise<string | null> {
  return store.get(LAST_ALBUM_KEY);
}

export function writeLastAlbum(store: KeyValueStore, letter: string): Promise<void> {
  return store.set(LAST_ALBUM_KEY, letter);
}

/** Albums proper (boxes and frames have no pockets to propose), by letter. */
export function pocketAlbums(albums: readonly Album[]): Album[] {
  return albums.filter((a) => a.kind === 'album' && sheetCount(a) > 0).sort((a, b) => a.letter.localeCompare(b.letter));
}

/** The album the proposal looks into: the one last used when it still exists, else the first by letter. */
export function defaultAlbum(albums: readonly Album[], last: string | null): Album | undefined {
  const candidates = pocketAlbums(albums);
  return candidates.find((a) => a.letter === last) ?? candidates[0];
}

/** `PUT /caps/{id}/location` → `{ cap, swapped? }` (openapi), both parsed with the shared `Cap`. */
export interface LocationResult {
  readonly cap: Cap;
  readonly swapped?: Cap;
}

export const LocationResultSchema: Schema<LocationResult> = {
  safeParse(data) {
    if (typeof data !== 'object' || data === null)
      return { success: false, error: new Error('location: not an object') };
    const record = data as Record<string, unknown>;
    const cap = Cap.safeParse(record.cap);
    if (!cap.success) return { success: false, error: cap.error };
    if (record.swapped === undefined) return { success: true, data: { cap: cap.data } };
    const swapped = Cap.safeParse(record.swapped);
    if (!swapped.success) return { success: false, error: swapped.error };
    return { success: true, data: { cap: cap.data, swapped: swapped.data } };
  },
};

/** The location as a client sends it: `albumId` is server-filled, never sent (shared `Location`). */
export function wireLocation(loc: AlbumLocation): AlbumLocation {
  return { kind: 'album', album: loc.album, sheet: loc.sheet, pocket: loc.pocket };
}

const locationPath = (capId: string) => `/caps/${encodeURIComponent(capId)}/location`;

export function putLocation(
  api: ApiClient,
  capId: string,
  location: AlbumLocation,
  swap = false,
): Promise<LocationResult> {
  const body = { location: wireLocation(location), ...(swap ? { swap: true } : {}) };
  return api.request(locationPath(capId), { method: 'PUT', body, schema: LocationResultSchema });
}

export async function clearLocation(api: ApiClient, capId: string): Promise<void> {
  await api.request(locationPath(capId), { method: 'DELETE', schema: NoContentSchema });
}

export function fetchAlbums(api: ApiClient): Promise<Album[]> {
  return api.request('/albums', { schema: AlbumListSchema });
}

export function nextFree(api: ApiClient, albumId: string): Promise<NextFree> {
  return api.request(`/albums/${encodeURIComponent(albumId)}/next-free`, { schema: NextFree });
}

export function fetchSheet(api: ApiClient, albumId: string, sheet: number): Promise<SheetView> {
  return api.request(`/albums/${encodeURIComponent(albumId)}/sheets/${String(sheet)}`, { schema: SheetView });
}

/** 409 from a location call: the pocket is taken (one cap per pocket, ADR-005). */
export function isOccupied(error: unknown): boolean {
  return (error instanceof ProblemError || error instanceof HttpError) && error.status === 409;
}

/** The cap in a pocket, read from its sheet (GSI1, one query); undefined when empty or not readable. */
export async function occupantAt(
  api: ApiClient,
  albums: readonly Album[],
  loc: AlbumLocation,
): Promise<SheetPocket | undefined> {
  const album = albums.find((a) => a.letter === loc.album);
  if (!album) return undefined;
  try {
    const view = await fetchSheet(api, album.albumId, loc.sheet);
    return view.pockets.find((p) => p.pocket === loc.pocket);
  } catch {
    return undefined;
  }
}

/** True when the pocket exists in that album (sheet ≤ sheets, pocket ≤ cols × rows). */
export function fitsAlbum(album: Album, loc: AlbumLocation): boolean {
  const pockets = (album.cols ?? 0) * (album.rows ?? 0);
  return album.kind === 'album' && loc.sheet <= sheetCount(album) && loc.pocket <= pockets;
}

export type TypedLocation =
  | { readonly ok: true; readonly location: AlbumLocation }
  | { readonly ok: false; readonly reason: 'invalid' | 'noAlbum' | 'outOfRange' };

/** A code typed in the picker (`A·3·17`, `a 3 17`…, `parseLocationCode`), checked against the user's albums. */
export function typedLocation(text: string, albums: readonly Album[]): TypedLocation {
  const loc = parseLocationCode(text);
  if (loc?.kind !== 'album') return { ok: false, reason: 'invalid' };
  const album = pocketAlbums(albums).find((a) => a.letter === loc.album);
  if (!album) return { ok: false, reason: 'noAlbum' };
  if (!fitsAlbum(album, loc)) return { ok: false, reason: 'outOfRange' };
  return { ok: true, location: loc };
}

/** The location of a tapped cell of the picker grid. */
export function cellLocation(letter: string, sheet: number, pocket: number): AlbumLocation {
  return { kind: 'album', album: letter, sheet, pocket };
}

/** Same pocket, ignoring the server-filled `albumId`. */
export function samePocket(a: AlbumLocation | undefined, b: AlbumLocation | undefined): boolean {
  return a !== undefined && b !== undefined && a.album === b.album && a.sheet === b.sheet && a.pocket === b.pocket;
}
