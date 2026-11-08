// Albums service (CAP-49): GET/POST /albums, PATCH /albums/{albumId}, the sheet view and the next free pocket behind
// thin handlers. Spec: ADR-005 (album · sheet · pocket), physical-link.md § The album / § Location code (row-major,
// `A·3·17`), openapi.yaml /albums*, data-model.md `ALBUM#<albumId>` and GSI1 `LOC#<albumId>#<sheet>` / `POCKET#nn`.
import {
  Album,
  AlbumInput,
  AlbumLetter,
  GRANDE_SHEET,
  LocationKind,
  type NextFree,
  type SheetView,
  Ulid,
  formatLocationCode,
} from '@capcollector/shared';
import { z } from 'zod';

import { Conflict, NotFound } from './errors.js';
import { ValidationError } from './http.js';
import { newId } from './ids.js';
import type { Repositories, SheetEntry } from './repo/types.js';
import { after, now } from './time.js';

export const AlbumIdPath = z.object({ albumId: Ulid });
export const AlbumSheetPath = z.object({ albumId: Ulid, sheet: z.coerce.number().int().min(1) });

/**
 * PATCH body: `AlbumInput` with partial semantics (absent = untouched), written out field by field because
 * `AlbumInput.partial()` would still apply the `cols`/`rows` defaults (zod 4) and silently resize the album.
 */
export const AlbumPatchBody = z
  .object({
    letter: AlbumLetter.optional(),
    name: AlbumInput.shape.name.optional(),
    kind: LocationKind.optional(),
    sheets: AlbumInput.shape.sheets,
    cols: AlbumInput.shape.cols.unwrap().optional(),
    rows: AlbumInput.shape.rows.unwrap().optional(),
    pocketMm: AlbumInput.shape.pocketMm,
    pitchMm: AlbumInput.shape.pitchMm,
  })
  .strict();
export type AlbumPatchBody = z.infer<typeof AlbumPatchBody>;

export interface AlbumDeps {
  repos: Repositories;
  /** Injectable for tests; epoch milliseconds. */
  clock?: () => number;
}

interface Geometry {
  sheets: number;
  cols: number;
  rows: number;
}

/** The pocket grid of an album-kind record; undefined for boxes and frames (they have no sheets or pockets). */
function geometryOf(a: Album): Geometry | undefined {
  if (a.kind !== 'album' || !a.sheets || !a.cols || !a.rows) return undefined;
  return { sheets: a.sheets, cols: a.cols, rows: a.rows };
}

/** Re-checks the assembled record against the `Album` contract (album geometry, pitch ≥ pocket) and answers 422. */
function checkAlbum(candidate: unknown): Album {
  const r = Album.safeParse(candidate);
  if (!r.success) throw new ValidationError(r.error, 'body');
  return r.data;
}

/** Optional fields copied only when present (`exactOptionalPropertyTypes`). */
function present<T extends Record<string, unknown>>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

async function albumOr404(deps: AlbumDeps, uid: string, albumId: string): Promise<Album> {
  const album = await deps.repos.albums.get(uid, albumId);
  if (!album) throw new NotFound(`album ${albumId} not found`);
  return album;
}

/** Live caps on one sheet, by pocket (one GSI1 query). */
async function sheetEntries(deps: AlbumDeps, albumId: string, sheet: number): Promise<SheetEntry[]> {
  const entries = await deps.repos.caps.listGsi1(albumId, sheet);
  return entries.sort((a, b) => a.pocket - b.pocket);
}

/** POST /albums → 201 Album; 409 when the letter is already used by another album of the user. */
export async function createAlbum(deps: AlbumDeps, uid: string, body: AlbumInput): Promise<Album> {
  const ts = now(deps.clock);
  // SPEC-GAP CAP-49: `Album` says boxes and frames leave the geometry undefined, but `AlbumInput` defaults cols/rows
  // for every kind; for box/frame the geometry (defaults and any `sheets` sent) is dropped rather than stored.
  const geometry = body.kind === 'album' ? present({ sheets: body.sheets, cols: body.cols, rows: body.rows }) : {};
  const album = checkAlbum({
    albumId: newId(),
    letter: body.letter,
    name: body.name,
    kind: body.kind,
    ...geometry,
    ...present({ pocketMm: body.pocketMm, pitchMm: body.pitchMm }),
    createdAt: ts,
    updatedAt: ts,
  });
  await deps.repos.albums.create(uid, album);
  return album;
}

/** GET /albums → every album, box and frame of the user, by letter. */
export async function listAlbums(deps: AlbumDeps, uid: string): Promise<Album[]> {
  const albums = await deps.repos.albums.list(uid);
  return albums.sort((a, b) => (a.letter < b.letter ? -1 : a.letter > b.letter ? 1 : 0));
}

/** True when any live cap of the user is stored in this album/box/frame (caps keep the letter in `location.album`). */
async function hasCaps(deps: AlbumDeps, uid: string, album: Album): Promise<boolean> {
  const caps = await deps.repos.caps.listAll(uid);
  return caps.some((c) => c.location?.album === album.letter);
}

/**
 * The first occupied pocket the new geometry would cut off, or undefined. Only the sheets that can lose pockets are
 * queried: every remaining sheet when the pockets per sheet shrink, else only the sheets beyond the new count.
 */
async function firstCutOff(
  deps: AlbumDeps,
  albumId: string,
  prev: Geometry,
  next: Geometry,
): Promise<{ sheet: number; pocket: number } | undefined> {
  const perSheet = next.cols * next.rows;
  const firstSheet = perSheet < prev.cols * prev.rows ? 1 : next.sheets + 1;
  for (let sheet = firstSheet; sheet <= prev.sheets; sheet++) {
    const hit = (await sheetEntries(deps, albumId, sheet)).find((e) => sheet > next.sheets || e.pocket > perSheet);
    if (hit) return { sheet, pocket: hit.pocket };
  }
  return undefined;
}

/**
 * PATCH /albums/{albumId}: absent fields untouched. 409 when the letter (or kind) changes while caps use the album,
 * when the new letter is taken, or when the new sheets/cols/rows would cut off an occupied pocket.
 */
export async function patchAlbum(deps: AlbumDeps, uid: string, albumId: string, patch: AlbumPatchBody): Promise<Album> {
  const prev = await albumOr404(deps, uid, albumId);
  const kind = patch.kind ?? prev.kind;
  const geometry =
    kind === 'album'
      ? present({
          sheets: patch.sheets ?? prev.sheets,
          cols: patch.cols ?? prev.cols ?? GRANDE_SHEET.cols,
          rows: patch.rows ?? prev.rows ?? GRANDE_SHEET.rows,
        })
      : {};
  const next = checkAlbum({
    albumId,
    letter: patch.letter ?? prev.letter,
    name: patch.name ?? prev.name,
    kind,
    ...geometry,
    ...present({ pocketMm: patch.pocketMm ?? prev.pocketMm, pitchMm: patch.pitchMm ?? prev.pitchMm }),
    createdAt: prev.createdAt,
    updatedAt: after(prev.updatedAt, deps.clock),
  });

  // SPEC-GAP CAP-49: the story only guards letter renames; changing `kind` while caps use the record would strand
  // their locations (an album pocket in a box), so it gets the same 409.
  if ((next.letter !== prev.letter || next.kind !== prev.kind) && (await hasCaps(deps, uid, prev))) {
    throw new Conflict(`album ${prev.letter} holds caps: its letter and kind cannot change`);
  }
  const before = geometryOf(prev);
  const afterGeo = geometryOf(next);
  if (before && afterGeo) {
    const cut = await firstCutOff(deps, albumId, before, afterGeo);
    if (cut) throw new Conflict(`pocket ${prev.letter}·${cut.sheet}·${cut.pocket} is occupied`);
  }
  await deps.repos.albums.update(uid, next, prev.updatedAt);
  return next;
}

/** The album's pocket grid, or 404 for a box/frame (no sheets). */
function gridOr404(album: Album): Geometry {
  const g = geometryOf(album);
  // SPEC-GAP CAP-49: openapi defines no answer for a box/frame here; it has no sheets, so it reads as 404.
  if (!g) throw new NotFound(`${album.letter} is a ${album.kind}, not an album with sheets`);
  return g;
}

/** GET /albums/{albumId}/sheets/{sheet} → SheetView from one GSI1 query; 404 beyond the album's sheets. */
export async function sheetView(deps: AlbumDeps, uid: string, albumId: string, sheet: number): Promise<SheetView> {
  const album = await albumOr404(deps, uid, albumId);
  const g = gridOr404(album);
  if (sheet > g.sheets) throw new NotFound(`album ${album.letter} has ${g.sheets} sheets`);
  const entries = await sheetEntries(deps, albumId, sheet);
  return {
    albumId,
    letter: album.letter,
    sheet,
    cols: g.cols,
    rows: g.rows,
    pockets: entries.map((e) => ({
      pocket: e.pocket,
      capId: e.capId,
      brand: e.brand,
      ...(e.variant === undefined ? {} : { variant: e.variant }),
      // The S3 key only; the client presigns through the cap's `imageUrls` on detail (SheetPocket.thumbKey).
      thumbKey: e.images.top.key,
    })),
  };
}

/**
 * GET /albums/{albumId}/next-free → the first empty pocket in row-major order (sheet 1 pocket 1 onwards), or nulls
 * when the album is full. One GSI1 query per sheet, stopping at the first sheet with a gap.
 */
export async function nextFree(deps: AlbumDeps, uid: string, albumId: string): Promise<NextFree> {
  const album = await albumOr404(deps, uid, albumId);
  const g = gridOr404(album);
  const perSheet = g.cols * g.rows;
  for (let sheet = 1; sheet <= g.sheets; sheet++) {
    const taken = new Set((await sheetEntries(deps, albumId, sheet)).map((e) => e.pocket));
    for (let pocket = 1; pocket <= perSheet; pocket++) {
      if (taken.has(pocket)) continue;
      const location = { kind: 'album' as const, album: album.letter, sheet, pocket };
      return { albumId, location, code: formatLocationCode(location) };
    }
  }
  return { albumId, location: null, code: null };
}
