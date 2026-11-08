// Location resolution and pocket occupancy (CAP-50), shared by POST /caps and PUT /caps/{capId}/location.
// Spec: ADR-005 (album · sheet · pocket; box/frame have none), physical-link.md § Location code, shared `Location`
// (`albumId` server-filled from the letter), data-model.md § Invariants (one cap per pocket via `LOCK#`).
import { type Album, type Location, formatLocationCode } from '@capcollector/shared';
import { ZodError } from 'zod';

import { Conflict, NotFound } from './errors.js';
import { ValidationError } from './http.js';
import type { Repositories } from './repo/types.js';

export interface ResolvedLocation {
  /** The location to store, with `albumId` filled from the letter. */
  location: Location;
  album: Album;
  /** The album id the cap's `LOCK#` marker and GSI1 keys take; only for album pockets (boxes/frames have neither). */
  lockAlbumId?: string;
}

/** 422 with one issue under `body.<path>`, like a schema failure. */
function invalid(path: string[], message: string): never {
  throw new ValidationError(new ZodError([{ code: 'custom', path, message, input: undefined }]), 'body');
}

/**
 * Letter → album record (404 when the user has none with that letter); the location kind must match the record's
 * kind and an album pocket must lie inside its sheets × cols × rows (422 otherwise).
 */
export async function resolveLocation(repos: Repositories, uid: string, loc: Location): Promise<ResolvedLocation> {
  const album = await repos.albums.byLetter(uid, loc.album);
  if (!album) throw new NotFound(`no album, box or frame with letter ${loc.album}`);
  // SPEC-GAP CAP-50: the spec does not say what a `box` location naming an album (or the reverse) means; it is
  // rejected rather than stored with a kind its record does not have.
  if (album.kind !== loc.kind) invalid(['location', 'kind'], `${loc.album} is a ${album.kind}, not a ${loc.kind}`);
  if (loc.kind !== 'album') return { location: { ...loc, albumId: album.albumId }, album };
  const { sheets = 0, cols = 0, rows = 0 } = album;
  if (loc.sheet > sheets) invalid(['location', 'sheet'], `album ${loc.album} has ${sheets} sheets`);
  if (loc.pocket > cols * rows)
    invalid(['location', 'pocket'], `sheets of album ${loc.album} have ${cols * rows} pockets`);
  return { location: { ...loc, albumId: album.albumId }, album, lockAlbumId: album.albumId };
}

/** The cap holding the target pocket, or undefined (free, or not an album pocket). */
export async function occupantOf(
  repos: Repositories,
  uid: string,
  target: ResolvedLocation,
): Promise<string | undefined> {
  const loc = target.location;
  if (!target.lockAlbumId || loc.kind !== 'album') return undefined;
  return repos.caps.occupant(uid, target.lockAlbumId, loc.sheet, loc.pocket);
}

/** 409 naming the occupying cap in `errors[]` (openapi.yaml PUT /caps/{capId}/location 409). */
export function occupied(target: ResolvedLocation, occupant: string): Conflict {
  return new Conflict(`pocket ${formatLocationCode(target.location)} is occupied`, [
    { path: 'body.location', message: `occupied by cap ${occupant}` },
  ]);
}

/** Throws the 409 when the target pocket is held by a cap other than `capId`. */
export async function assertFree(
  repos: Repositories,
  uid: string,
  target: ResolvedLocation,
  capId: string,
): Promise<void> {
  const occupant = await occupantOf(repos, uid, target);
  if (occupant && occupant !== capId) throw occupied(target, occupant);
}
