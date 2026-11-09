// Geometry of the insert PDF (CAP-54; physical-link.md § Insert discs and § Sheet index, amended 2026-11-09:
// round COMPART pockets, inner Ø ≈ 33 mm, pitch ≈ 36 mm; SCREENS.md #8). Pure maths in millimetres from the
// top-left corner of the page; inserts.ts converts to PDF points. Discs: Ø = pocket − 3 mm, a dense grid with 3 mm
// gutters centred on A4 portrait, the 20 mm calibration square in a band at the top of page 1 only; each back page
// mirrors its front's columns so a duplex (long-edge) or second pass lands every back on its front. Sheet index: one
// A4 landscape page per sheet with the `cols × rows` grid at the pocket pitch, scaled down only as far as needed to fit.

/** Points per millimetre (PDF user space is 1/72 in). */
export const PT_PER_MM = 72 / 25.4;

export const A4_PORTRAIT = { width: 210, height: 297 } as const;
export const A4_LANDSCAPE = { width: 297, height: 210 } as const;
export const MARGIN_MM = 10;
export const GUTTER_MM = 3;
/** The disc is this much smaller than the pocket (physical-link.md § Insert discs). */
export const DISC_CLEARANCE_MM = 3;
/** Suggested when the album has no measurements yet (Edu's COMPART measurement, 2026-11-09). */
export const SUGGESTED_POCKET_MM = 33;
export const SUGGESTED_PITCH_MM = 36;
export const CALIBRATION_MM = 20;
/** Height of page 1's calibration band: the square, its caption and a gap. */
export const CALIBRATION_BAND_MM = CALIBRATION_MM + 10;
/** QR on the back of a disc. */
export const QR_MM = 12;
/** Sheet index header band. */
export const INDEX_HEADER_MM = 16;

export function discDiameter(pocketMm: number): number {
  return pocketMm - DISC_CLEARANCE_MM;
}

export interface DiscGrid {
  readonly diameter: number;
  readonly cols: number;
  /** Rows on page 1 (below the calibration band) and on the following pages. */
  readonly rowsFirst: number;
  readonly rowsOther: number;
  /** Centre of column 0 (mm from the left edge); columns are `diameter + gutter` apart. */
  readonly x0: number;
  /** Centre of row 0 on page 1 and on the other pages (mm from the top edge). */
  readonly yFirst: number;
  readonly yOther: number;
}

function fit(span: number, diameter: number): number {
  return Math.max(0, Math.floor((span + GUTTER_MM) / (diameter + GUTTER_MM)));
}

/** The disc grid for a diameter on A4 portrait, horizontally centred so mirrored backs line up exactly. */
export function discGrid(diameter: number): DiscGrid {
  const { width, height } = A4_PORTRAIT;
  const step = diameter + GUTTER_MM;
  const cols = fit(width - 2 * MARGIN_MM, diameter);
  const rowsOther = fit(height - 2 * MARGIN_MM, diameter);
  const rowsFirst = fit(height - 2 * MARGIN_MM - CALIBRATION_BAND_MM, diameter);
  if (cols < 1 || rowsFirst < 1) throw new Error(`a ${String(diameter)} mm disc does not fit on A4`);
  const used = cols * step - GUTTER_MM;
  return {
    diameter,
    cols,
    rowsFirst,
    rowsOther,
    x0: (width - used) / 2 + diameter / 2,
    yFirst: MARGIN_MM + CALIBRATION_BAND_MM + diameter / 2,
    yOther: MARGIN_MM + diameter / 2,
  };
}

export interface DiscSlot {
  /** Index of the disc in the input order. */
  readonly index: number;
  /** 0-based front page (the PDF interleaves front, back, front, back…). */
  readonly sheet: number;
  readonly col: number;
  readonly row: number;
  /** Centre, mm from the top-left corner. */
  readonly cx: number;
  readonly cy: number;
}

/** Discs per front page: page 1 has fewer rows (calibration band). */
export function perPage(grid: DiscGrid, page: number): number {
  return grid.cols * (page === 0 ? grid.rowsFirst : grid.rowsOther);
}

/** Front positions of `count` discs, row-major, filling page 1 then the next pages. */
export function layoutDiscs(count: number, grid: DiscGrid): DiscSlot[] {
  const slots: DiscSlot[] = [];
  const step = grid.diameter + GUTTER_MM;
  let page = 0;
  let onPage = 0;
  for (let index = 0; index < count; index++) {
    if (onPage === perPage(grid, page)) {
      page += 1;
      onPage = 0;
    }
    const col = onPage % grid.cols;
    const row = Math.floor(onPage / grid.cols);
    slots.push({
      index,
      sheet: page,
      col,
      row,
      cx: grid.x0 + col * step,
      cy: (page === 0 ? grid.yFirst : grid.yOther) + row * step,
    });
    onPage += 1;
  }
  return slots;
}

/** Number of front pages for `count` discs (0 for none). */
export function frontPages(count: number, grid: DiscGrid): number {
  return count === 0 ? 0 : (layoutDiscs(count, grid).at(-1)?.sheet ?? 0) + 1;
}

/** Where a disc's back is printed: same row, mirrored column (the page is flipped on its long edge). */
export function backSlot(slot: DiscSlot, grid: DiscGrid): DiscSlot {
  const col = grid.cols - 1 - slot.col;
  return { ...slot, col, cx: A4_PORTRAIT.width - slot.cx };
}

/** Width of a horizontal chord of a circle of radius `r` at distance `dy` from its centre. */
export function chord(r: number, dy: number): number {
  return Math.abs(dy) >= r ? 0 : 2 * Math.sqrt(r * r - dy * dy);
}

export interface IndexGeometry {
  /** Paper millimetres per real millimetre (1 = to scale). */
  readonly scale: number;
  /** Pitch on paper. */
  readonly cell: number;
  /** Top-left of the grid (mm from the page's top-left). */
  readonly x0: number;
  readonly y0: number;
}

/**
 * The `cols × rows` grid at `pitchMm` on A4 landscape, below the header band. SPEC-GAP CAP-54: the story asks for the
 * grid "drawn to scale", but a GRANDE sheet (6 × 7 at 36 mm = 216 × 252 mm) does not fit an A4 page at 1:1, so the
 * grid is scaled down just enough to fit and the page prints the scale.
 */
export function indexGeometry(cols: number, rows: number, pitchMm: number): IndexGeometry {
  const { width, height } = A4_LANDSCAPE;
  const availW = width - 2 * MARGIN_MM;
  const availH = height - 2 * MARGIN_MM - INDEX_HEADER_MM;
  const scale = Math.min(1, availW / (cols * pitchMm), availH / (rows * pitchMm));
  const cell = pitchMm * scale;
  return {
    scale,
    cell,
    x0: (width - cols * cell) / 2,
    y0: MARGIN_MM + INDEX_HEADER_MM + (availH - rows * cell) / 2,
  };
}
