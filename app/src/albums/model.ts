// Albums and the sheet view (CAP-52; ADR-005; physical-link.md § The album, § Location code; SCREENS.md #7): the
// `GET /albums` list schema, the next free letter, pocket totals, the "+ New" / Edit form values ↔ `AlbumInput` /
// PATCH body, the sheet grid (`cols × rows` cells, row-major, `pocketToCell`), the `A·3` search code and the paths
// of the sheet view and of a scan pre-assigned to a pocket. DOM-free.
import {
  Album,
  AlbumInput,
  AlbumLetter,
  formatLocationCode,
  GRANDE_SHEET,
  LOCATION_SEPARATOR,
  parseLocationCode,
  pocketToCell,
  type AlbumLocation,
  type SheetView,
} from '@capcollector/shared';

import type { Schema } from '../api/schema.js';

type LocationKind = Album['kind'];
type SheetPocket = SheetView['pockets'][number];

/** `GET /albums` → `Album[]` (openapi `/albums`), each item parsed with the shared `Album`. */
export const AlbumListSchema: Schema<Album[]> = {
  safeParse(data) {
    if (!Array.isArray(data)) return { success: false, error: new Error('albums: not an array') };
    const albums: Album[] = [];
    for (const [i, item] of data.entries()) {
      const parsed = Album.safeParse(item);
      if (!parsed.success) return { success: false, error: new Error(`albums[${i}]: ${parsed.error.message}`) };
      albums.push(parsed.data);
    }
    return { success: true, data: albums };
  },
};

const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';

/** The first letter A–Z no album, box or frame uses yet ("+ New" proposes it); null when all 26 are taken. */
export function nextFreeLetter(albums: readonly Pick<Album, 'letter'>[]): string | null {
  const used = new Set(albums.map((a) => a.letter));
  return [...LETTERS].find((l) => !used.has(l)) ?? null;
}

/** Pockets of an album (`sheets × cols × rows`); null for boxes and frames, which have no sheets. */
export function totalPockets(album: Album): number | null {
  if (album.kind !== 'album' || !album.sheets || !album.cols || !album.rows) return null;
  return album.sheets * album.cols * album.rows;
}

/** The sheet count of an album; 0 for a box or frame. */
export function sheetCount(album: Album): number {
  return album.kind === 'album' ? (album.sheets ?? 0) : 0;
}

// ── "+ New" / Edit form ──

/** What the album sheet holds, as typed (numbers as text so a cleared field stays empty). */
export interface AlbumFormValues {
  readonly letter: string;
  readonly name: string;
  readonly kind: LocationKind;
  readonly sheets: string;
  readonly cols: string;
  readonly rows: string;
  readonly pocketMm: string;
  readonly pitchMm: string;
}

export type AlbumFormField = keyof AlbumFormValues;
/** Field → the kind of problem (the screen turns it into copy). */
export type AlbumFormErrors = Partial<Record<AlbumFormField, 'invalid' | 'required' | 'pitch'>>;

/** Sheets of a new Leuchtturm GRANDE binder (physical-link.md: ~10 sheets per binder). */
export const DEFAULT_SHEETS = 10;

/** A new album: the proposed letter, GRANDE 6 × 7 and ~10 sheets (physical-link.md § The album). */
export function newAlbumValues(albums: readonly Pick<Album, 'letter'>[]): AlbumFormValues {
  return {
    letter: nextFreeLetter(albums) ?? '',
    name: '',
    kind: 'album',
    sheets: String(DEFAULT_SHEETS),
    cols: String(GRANDE_SHEET.cols),
    rows: String(GRANDE_SHEET.rows),
    pocketMm: '',
    pitchMm: '',
  };
}

const text = (n: number | undefined) => (n === undefined ? '' : String(n));

export function albumValues(album: Album): AlbumFormValues {
  return {
    letter: album.letter,
    name: album.name,
    kind: album.kind,
    sheets: text(album.sheets),
    cols: text(album.cols ?? GRANDE_SHEET.cols),
    rows: text(album.rows ?? GRANDE_SHEET.rows),
    pocketMm: text(album.pocketMm),
    pitchMm: text(album.pitchMm),
  };
}

/** A number field: empty → undefined, else the parsed number (NaN when not a number, rejected by the schema). */
function num(value: string): number | undefined {
  const v = value.trim().replace(',', '.');
  return v === '' ? undefined : Number(v);
}

export type AlbumValidation = { ok: true; input: AlbumInput } | { ok: false; errors: AlbumFormErrors };

/**
 * Form values → `AlbumInput` (shared schema). Boxes and frames send no geometry; an album needs its sheet count (the
 * `Album` contract: "albums need sheets, cols and rows") and pitch ≥ pocket when both are set.
 */
export function validateAlbum(values: AlbumFormValues): AlbumValidation {
  const album = values.kind === 'album';
  const candidate: Record<string, unknown> = {
    letter: values.letter.trim().toUpperCase(),
    name: values.name.trim(),
    kind: values.kind,
  };
  const numbers = album
    ? (['sheets', 'cols', 'rows', 'pocketMm', 'pitchMm'] as const)
    : (['pocketMm', 'pitchMm'] as const);
  for (const key of numbers) {
    const n = num(values[key]);
    if (n !== undefined) candidate[key] = n;
  }
  const errors: AlbumFormErrors = {};
  if (album && candidate.sheets === undefined) errors.sheets = 'required';
  if (candidate.name === '') errors.name = 'required';
  const parsed = AlbumInput.safeParse(candidate);
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = issue.path[0];
      if (typeof field === 'string' && field in values && !errors[field as AlbumFormField]) {
        errors[field as AlbumFormField] = 'invalid';
      }
    }
  }
  const pocket = typeof candidate.pocketMm === 'number' ? candidate.pocketMm : undefined;
  const pitch = typeof candidate.pitchMm === 'number' ? candidate.pitchMm : undefined;
  if (pocket !== undefined && pitch !== undefined && pitch < pocket && !errors.pitchMm) errors.pitchMm = 'pitch';
  if (!parsed.success || Object.keys(errors).length > 0) return { ok: false, errors };
  const input = { ...parsed.data };
  if (!album) {
    // The cols/rows defaults of `AlbumInput` mean nothing for a box or frame (the API drops them, CAP-49).
    delete (input as Partial<AlbumInput>).cols;
    delete (input as Partial<AlbumInput>).rows;
  }
  return { ok: true, input };
}

/** `PATCH /albums/{id}` body: only what changed (absent = untouched, CAP-49 `AlbumPatchBody`); null when nothing did. */
export function albumPatch(prev: Album, input: AlbumInput): Record<string, unknown> | null {
  const body: Record<string, unknown> = {};
  const keys = ['letter', 'name', 'kind', 'sheets', 'cols', 'rows', 'pocketMm', 'pitchMm'] as const;
  for (const key of keys) {
    const next = input[key];
    if (next !== undefined && next !== prev[key]) body[key] = next;
  }
  return Object.keys(body).length === 0 ? null : body;
}

// ── sheet view ──

export interface SheetCell {
  readonly pocket: number;
  /** 1-based, row-major (physical-link.md § Location code: `A·3·17` = row 3, column 5). */
  readonly row: number;
  readonly col: number;
  /** `A·3·17`. */
  readonly code: string;
  readonly cap?: SheetPocket;
}

/** Every pocket of the sheet in row-major order, the occupied ones carrying their cap. */
export function sheetCells(view: SheetView): SheetCell[] {
  const byPocket = new Map(view.pockets.map((p) => [p.pocket, p]));
  const cells: SheetCell[] = [];
  for (let pocket = 1; pocket <= view.cols * view.rows; pocket++) {
    const { row, col } = pocketToCell(pocket, view.cols);
    const cap = byPocket.get(pocket);
    cells.push({
      pocket,
      row,
      col,
      code: formatLocationCode({ kind: 'album', album: view.letter, sheet: view.sheet, pocket }),
      ...(cap ? { cap } : {}),
    });
  }
  return cells;
}

/** `/albums/<albumId>/sheets/<n>`. */
export function albumSheetPath(albumId: string, sheet: number): string {
  return `/albums/${encodeURIComponent(albumId)}/sheets/${String(sheet)}`;
}

/** The Scan tab pre-assigned to a pocket (SCREENS.md § Navigation: "tap empty pocket → Scan pre-assigned"). */
export function scanIntoPath(code: string): string {
  return `/scan?${new URLSearchParams({ pocket: code }).toString()}`;
}

/** Manual entry pre-assigned to a pocket ("Enter manually" from a pre-assigned scan). */
export function newIntoPath(code: string): string {
  return `/new?${new URLSearchParams({ pocket: code }).toString()}`;
}

/** A pocket code (`A·3·17`) as an album location, or null when the text is not one. */
export function pocketLocation(code: string | undefined): AlbumLocation | null {
  if (code === undefined) return null;
  const loc = parseLocationCode(code);
  return loc?.kind === 'album' ? loc : null;
}

/** `A·3` typed in the Collection search (album + sheet, same separators as `parseLocationCode`). */
export function parseSheetCode(value: string): { letter: string; sheet: number } | null {
  const m = /^\s*([A-Za-z])\s*[·.\-/\s]\s*(\d{1,3})\s*$/.exec(value);
  if (!m) return null;
  const letter = m[1]!.toUpperCase();
  const sheet = Number(m[2]);
  if (!AlbumLetter.safeParse(letter).success || sheet < 1) return null;
  return { letter, sheet };
}

/** `A · 3` as shown on the search shortcut. */
export function sheetCode(letter: string, sheet: number): string {
  return `${letter}${LOCATION_SEPARATOR}${String(sheet)}`;
}

/** The album a sheet code names, when it exists, is an album and has that sheet. */
export function sheetTarget(albums: readonly Album[], code: { letter: string; sheet: number }): Album | undefined {
  const album = albums.find((a) => a.letter === code.letter);
  return album && code.sheet <= sheetCount(album) ? album : undefined;
}
