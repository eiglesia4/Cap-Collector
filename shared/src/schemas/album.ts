// Album / box / frame definitions and the sheet view payload (ADR-005, physical-link.md). Owned by the architect.
import { z } from 'zod';

import { Instant, LocationKind, Ulid } from './enums.js';
import { AlbumLetter } from './location.js';

/** Leuchtturm GRANDE champagne-plaque sheet: 6 × 7 = 42 pockets (physical-link.md). */
export const GRANDE_SHEET = { cols: 6, rows: 7 } as const;

export const Album = z
  .object({
    albumId: Ulid,
    /** The letter used in location codes; unique per user. */
    letter: AlbumLetter,
    name: z.string().trim().min(1).max(60),
    kind: LocationKind,
    /** Album-only geometry. Boxes and frames leave them undefined. */
    sheets: z.number().int().min(1).max(99).optional(),
    cols: z.number().int().min(1).max(12).optional(),
    rows: z.number().int().min(1).max(12).optional(),
    /** Inner pocket side and centre-to-centre pitch, in mm — measured by the user; drives the insert-card PDF. */
    pocketMm: z.number().min(10).max(100).optional(),
    pitchMm: z.number().min(10).max(120).optional(),
    createdAt: Instant,
    updatedAt: Instant,
  })
  .refine((a) => a.kind !== 'album' || (a.sheets && a.cols && a.rows), {
    message: 'albums need sheets, cols and rows',
    path: ['kind'],
  })
  .refine((a) => !a.pitchMm || !a.pocketMm || a.pitchMm >= a.pocketMm, {
    message: 'pitch must be at least the pocket size',
    path: ['pitchMm'],
  });
export type Album = z.infer<typeof Album>;

export const AlbumInput = z
  .object({
    letter: AlbumLetter,
    name: z.string().trim().min(1).max(60),
    kind: LocationKind,
    sheets: z.number().int().min(1).max(99).optional(),
    cols: z.number().int().min(1).max(12).default(GRANDE_SHEET.cols),
    rows: z.number().int().min(1).max(12).default(GRANDE_SHEET.rows),
    pocketMm: z.number().min(10).max(100).optional(),
    pitchMm: z.number().min(10).max(120).optional(),
  })
  .strict();
export type AlbumInput = z.infer<typeof AlbumInput>;

/** One occupied pocket as returned by `GET /albums/{id}/sheets/{n}` (GSI1, one query). */
export const SheetPocket = z.object({
  pocket: z.number().int().min(1),
  capId: Ulid,
  brand: z.string(),
  variant: z.string().optional(),
  thumbKey: z.string(),
});

export const SheetView = z.object({
  albumId: Ulid,
  letter: AlbumLetter,
  sheet: z.number().int().min(1),
  cols: z.number().int().min(1),
  rows: z.number().int().min(1),
  pockets: z.array(SheetPocket),
});
export type SheetView = z.infer<typeof SheetView>;

/** `GET /albums/{id}/next-free` → the first empty pocket in row-major order, or null when the album is full. */
export const NextFree = z.object({
  albumId: Ulid,
  location: z
    .object({ kind: z.literal('album'), album: AlbumLetter, sheet: z.number().int(), pocket: z.number().int() })
    .nullable(),
  code: z.string().nullable(),
});
export type NextFree = z.infer<typeof NextFree>;
