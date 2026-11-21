// Initial layout (CAP-75; physical-link.md § Initial layout, ADR-005): plan the physical albums for the caps that have
// no location yet. Order type → country → brand → variant → year → capId, unknown values last in each level (text
// compared like the brand index, `normaliseBrand`). A new type starts a new sheet, a new country a new row; brands
// follow on. Albums are filled in the order chosen, sheet by sheet, row-major; pockets already holding a cap are never
// used. When the albums run out the plan places nothing and says how many more pockets / sheets are needed. DOM-free.
import {
  CapType,
  formatLocationCode,
  GRANDE_SHEET,
  normaliseBrand,
  pocketToCell,
  type Album,
  type AlbumLocation,
  type Cap,
} from '@capcollector/shared';

import { nextFreeLetter, sheetCount } from './model.js';

/** One cap → one pocket. */
export interface Placement {
  readonly capId: string;
  /** `A·3·17`. */
  readonly code: string;
  readonly location: AlbumLocation;
  readonly albumId: string;
}

export interface PlannedPocket {
  readonly pocket: number;
  readonly capId: string;
  readonly code: string;
  readonly brand: string;
}

/** Where a type / country group starts (or continues on a new sheet), labelled at that pocket. */
export interface GroupStart {
  readonly pocket: number;
  readonly row: number;
  readonly type?: CapType;
  readonly country?: string;
}

/** One sheet the plan writes to, as the sheet view would show it. */
export interface SheetPreview {
  readonly albumId: string;
  readonly letter: string;
  readonly sheet: number;
  readonly cols: number;
  readonly rows: number;
  readonly planned: readonly PlannedPocket[];
  /** Pockets already holding a cap (placed before the plan). */
  readonly occupied: readonly number[];
  readonly groups: readonly GroupStart[];
}

export interface LayoutTotals {
  readonly placed: number;
  /** Empty pockets left on the sheets the plan writes to. */
  readonly gapsLeft: number;
  /** Album letter → sheets the plan writes to. */
  readonly sheetsUsedByAlbum: Readonly<Record<string, number>>;
}

export interface Shortfall {
  /** Caps that did not fit. */
  readonly pockets: number;
  /** More sheets needed, with the geometry of the last album chosen (GRANDE 6 × 7 when none). */
  readonly sheetsNeeded: number;
  /** The letter "+ New album" would propose; null when all 26 are taken. */
  readonly nextLetter: string | null;
}

export interface LayoutPlan {
  /** In plan order (the order Apply writes them); empty on a shortfall. */
  readonly placements: readonly Placement[];
  /** Empty on a shortfall. */
  readonly sheets: readonly SheetPreview[];
  readonly totals: LayoutTotals;
  readonly shortfall?: Shortfall;
}

/** A live cap with no location: what the plan places. */
export function isUnplaced(cap: Cap): boolean {
  return cap.location === undefined && cap.deletedAt === undefined;
}

/** Albums that can take caps (kind album with geometry). */
function fillable(album: Album): boolean {
  return album.kind === 'album' && sheetCount(album) > 0 && (album.cols ?? 0) > 0 && (album.rows ?? 0) > 0;
}

const TYPES: readonly string[] = CapType.options;

/** Unknown (undefined / empty) after every known value. */
function compareKnown<T>(a: T | undefined, b: T | undefined, cmp: (x: T, y: T) => number): number {
  if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? 1 : -1;
  return cmp(a, b);
}

const text = (s: string | undefined) => {
  const n = s === undefined ? '' : normaliseBrand(s);
  return n === '' ? undefined : n;
};
const byString = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);

/** physical-link.md § Initial layout: type → country → brand → variant → year → capId, unknown last per level. */
export function compareForLayout(a: Cap, b: Cap): number {
  const type = (c: Cap) => (c.type === undefined ? undefined : TYPES.indexOf(c.type));
  return (
    compareKnown(type(a), type(b), (x, y) => x - y) ||
    compareKnown(a.country, b.country, byString) ||
    compareKnown(text(a.brand), text(b.brand), byString) ||
    compareKnown(text(a.variant), text(b.variant), byString) ||
    compareKnown(a.year, b.year, (x, y) => x - y) ||
    byString(a.capId, b.capId)
  );
}

interface Slot {
  /** Index into the chosen albums; `albums.length` = overflow (sheets that do not exist yet). */
  album: number;
  sheet: number;
  pocket: number;
}

/**
 * The plan for `caps` (the whole collection: unplaced ones are placed, placed ones mark occupied pockets) into
 * `albums`, in the order given. `include` narrows the caps to place (the scope picker), never the occupied pockets.
 */
export function planLayout(
  caps: readonly Cap[],
  albums: readonly Album[],
  include: (cap: Cap) => boolean = () => true,
): LayoutPlan {
  const chosen = albums.filter(fillable);
  const occupied = new Set<string>();
  for (const cap of caps) {
    const loc = cap.location;
    if (loc?.kind === 'album' && cap.deletedAt === undefined) occupied.add(`${loc.album}|${loc.sheet}|${loc.pocket}`);
  }
  const toPlace = caps.filter((c) => isUnplaced(c) && include(c)).sort(compareForLayout);

  const last = chosen.at(-1);
  const overflowGeometry = { cols: last?.cols ?? GRANDE_SHEET.cols, rows: last?.rows ?? GRANDE_SHEET.rows };
  const geometry = (i: number) => {
    const album = chosen[i];
    return album
      ? { cols: album.cols ?? 0, rows: album.rows ?? 0, sheets: sheetCount(album) }
      : { ...overflowGeometry, sheets: Number.POSITIVE_INFINITY };
  };
  const isFree = (s: Slot) => {
    const album = chosen[s.album];
    return album === undefined || !occupied.has(`${album.letter}|${s.sheet}|${s.pocket}`);
  };
  /** The first free pocket at or after `s`, moving on to the next sheet / album. */
  const normalise = (s: Slot): Slot => {
    const at = { ...s };
    for (;;) {
      const g = geometry(at.album);
      if (at.pocket > g.cols * g.rows) {
        at.sheet += 1;
        at.pocket = 1;
        continue;
      }
      if (at.sheet > g.sheets) {
        at.album += 1;
        at.sheet = 1;
        at.pocket = 1;
        continue;
      }
      if (isFree(at)) return at;
      at.pocket += 1;
    }
  };

  const slots: { cap: Cap; slot: Slot; group: boolean }[] = [];
  let cursor: Slot = { album: 0, sheet: 1, pocket: 1 };
  let prev: { cap: Cap; slot: Slot } | undefined;
  for (const cap of toPlace) {
    let group = prev === undefined;
    if (prev !== undefined) {
      const { cols } = geometry(prev.slot.album);
      if (cap.type !== prev.cap.type) {
        // A new type starts a new sheet.
        cursor = { album: prev.slot.album, sheet: prev.slot.sheet + 1, pocket: 1 };
        group = true;
      } else if (cap.country !== prev.cap.country) {
        // A new country starts a new row (the previous row keeps its gap for later additions).
        const { row } = pocketToCell(prev.slot.pocket, cols);
        cursor = { album: prev.slot.album, sheet: prev.slot.sheet, pocket: row * cols + 1 };
        group = true;
      }
    }
    const slot = normalise(cursor);
    // A group continuing on a new sheet is labelled there too.
    if (prev && (slot.album !== prev.slot.album || slot.sheet !== prev.slot.sheet)) group = true;
    slots.push({ cap, slot, group });
    prev = { cap, slot };
    cursor = { ...slot, pocket: slot.pocket + 1 };
  }

  const overflow = slots.filter((s) => s.slot.album >= chosen.length);
  if (overflow.length > 0) {
    const sheetsNeeded = new Set(overflow.map((s) => s.slot.sheet)).size;
    return {
      placements: [],
      sheets: [],
      totals: { placed: 0, gapsLeft: 0, sheetsUsedByAlbum: {} },
      shortfall: { pockets: overflow.length, sheetsNeeded, nextLetter: nextFreeLetter(albums) },
    };
  }

  const placements: Placement[] = [];
  const sheets = new Map<string, SheetPreview & { planned: PlannedPocket[]; groups: GroupStart[] }>();
  for (const { cap, slot, group } of slots) {
    const album = chosen[slot.album];
    if (!album) continue;
    const location: AlbumLocation = { kind: 'album', album: album.letter, sheet: slot.sheet, pocket: slot.pocket };
    const code = formatLocationCode(location);
    placements.push({ capId: cap.capId, code, location, albumId: album.albumId });
    const key = `${album.letter}|${slot.sheet}`;
    let preview = sheets.get(key);
    if (!preview) {
      const cols = album.cols ?? 0;
      const rows = album.rows ?? 0;
      const taken: number[] = [];
      for (let p = 1; p <= cols * rows; p++) if (occupied.has(`${album.letter}|${slot.sheet}|${p}`)) taken.push(p);
      preview = {
        albumId: album.albumId,
        letter: album.letter,
        sheet: slot.sheet,
        cols,
        rows,
        planned: [],
        occupied: taken,
        groups: [],
      };
      sheets.set(key, preview);
    }
    preview.planned.push({ pocket: slot.pocket, capId: cap.capId, code, brand: cap.brand });
    if (group) {
      preview.groups.push({
        pocket: slot.pocket,
        row: pocketToCell(slot.pocket, preview.cols).row,
        ...(cap.type !== undefined ? { type: cap.type } : {}),
        ...(cap.country !== undefined ? { country: cap.country } : {}),
      });
    }
  }

  const list = [...sheets.values()];
  const sheetsUsedByAlbum: Record<string, number> = {};
  for (const s of list) sheetsUsedByAlbum[s.letter] = (sheetsUsedByAlbum[s.letter] ?? 0) + 1;
  const gapsLeft = list.reduce((n, s) => n + s.cols * s.rows - s.planned.length - s.occupied.length, 0);
  return { placements, sheets: list, totals: { placed: placements.length, gapsLeft, sheetsUsedByAlbum } };
}

/** The sheets of one album the plan writes to, ascending (the print scope "these sheets"). */
export function plannedSheets(plan: LayoutPlan, albumId: string): number[] {
  return plan.sheets
    .filter((s) => s.albumId === albumId)
    .map((s) => s.sheet)
    .sort((a, b) => a - b);
}
