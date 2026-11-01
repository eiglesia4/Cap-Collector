// Physical location of a cap and its code `A·3·17` (ADR-005, physical-link.md § Location code). Owned by the architect.
import { z } from 'zod';

import { LocationKind } from './enums.js';

/** Album identifier as the user sees it: a single upper-case letter A–Z. */
export const AlbumLetter = z.string().regex(/^[A-Z]$/, 'album letter A–Z expected');

const base = {
  /** Which album/box/frame, by its letter (unique per user; the `Album` record maps letter → albumId). */
  album: AlbumLetter,
};

/** `album` kind: sheet and pocket are required, 1-based, row-major on the sheet. */
export const AlbumLocation = z.object({
  kind: z.literal('album'),
  ...base,
  sheet: z.number().int().min(1),
  pocket: z.number().int().min(1),
});

/** `box` / `frame` kinds carry no sheet or pocket (trade stock, wall displays). */
export const LooseLocation = z.object({
  kind: z.enum(LocationKind.options.filter((k) => k !== 'album') as ['box', 'frame']),
  ...base,
});

export const Location = z.discriminatedUnion('kind', [AlbumLocation, LooseLocation]);
export type Location = z.infer<typeof Location>;
export type AlbumLocation = z.infer<typeof AlbumLocation>;

/** Separator used when rendering a code. */
export const LOCATION_SEPARATOR = '·';

/**
 * Renders `A·3·17` for album pockets, `B` for a box/frame. Pocket is zero-padded to two digits only
 * in storage keys (see keys.ts), never in the human code.
 */
export function formatLocationCode(loc: Location): string {
  if (loc.kind === 'album') return [loc.album, loc.sheet, loc.pocket].join(LOCATION_SEPARATOR);
  return loc.album;
}

/**
 * Parses a human code typed or scanned by the user. Accepts `·`, `.`, `-`, `/` or spaces as separators and
 * a lower-case letter; `A·3·17` → album pocket, `B` alone → a loose location of the given `looseKind`
 * (default `box`). Returns `null` when the text is not a code.
 */
export function parseLocationCode(text: string, looseKind: 'box' | 'frame' = 'box'): Location | null {
  const m = /^\s*([A-Za-z])(?:\s*[·.\-/\s]\s*(\d{1,3})\s*[·.\-/\s]\s*(\d{1,3}))?\s*$/.exec(text);
  if (!m) return null;
  const album = m[1]!.toUpperCase();
  if (m[2] === undefined) return { kind: looseKind, album };
  const sheet = Number(m[2]);
  const pocket = Number(m[3]);
  if (sheet < 1 || pocket < 1) return null;
  return { kind: 'album', album, sheet, pocket };
}

/** Row-major pocket number → (row, col), both 1-based, for a sheet of `cols` columns. */
export function pocketToCell(pocket: number, cols: number): { row: number; col: number } {
  const i = pocket - 1;
  return { row: Math.floor(i / cols) + 1, col: (i % cols) + 1 };
}

export function cellToPocket(row: number, col: number, cols: number): number {
  return (row - 1) * cols + col;
}
