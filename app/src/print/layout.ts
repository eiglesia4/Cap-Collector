// Geometry of the insert PDF (CAP-54; physical-link.md § Insert discs and § Sheet index, amended 2026-11-09:
// round COMPART pockets, inner Ø ≈ 33 mm, pitch ≈ 36 mm; SCREENS.md #8). Pure maths in millimetres from the
// top-left corner of the page; inserts.ts converts to PDF points. Discs: Ø = pocket − 3 mm, a dense grid with 3 mm
// gutters centred on A4 portrait, the 20 mm calibration square in a band at the top of page 1 only; each back page
// mirrors its front's columns so a duplex (long-edge) or second pass lands every back on its front. Sheet index
// (physical-link.md § Sheet index): one A4 portrait page per sheet, the `cols × rows` grid in the physical sheet's
// orientation, as large as fits inside the margins (≈ 88 % at 36 mm pitch), proportions kept. Inside labels
// (CAP-123, physical-link.md § Inside labels): Ø 25 mm cut, text inside a 21 mm circle, 28 mm pitch; one page per
// sheet mirroring its grid when that fits A4, else a dense flow in pocket order.

/** Points per millimetre (PDF user space is 1/72 in). */
export const PT_PER_MM = 72 / 25.4;

export const A4_PORTRAIT = { width: 210, height: 297 } as const;
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
 * The `cols × rows` grid at `pitchMm` on A4 portrait, below the header band, as large as fits inside the margins
 * (never above 1 : 1). A full 6 × 7 sheet at 36 mm (216 × 252 mm) prints at ≈ 88 % (decided by the architect on
 * CAP-54, 2026-11-09).
 */
export function indexGeometry(cols: number, rows: number, pitchMm: number): IndexGeometry {
  const { width, height } = A4_PORTRAIT;
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

// ── Inside labels (CAP-123, physical-link.md § Inside labels) ──

/** Cut circle of an inside label (a common 25 mm / 1" punch). */
export const LABEL_MM = 25;
/** The text stays inside this circle, 2 mm within the cut line. */
export const LABEL_TEXT_MM = 21;
/** Label pitch: 25 mm + a 3 mm gutter. */
export const LABEL_PITCH_MM = LABEL_MM + GUTTER_MM;
/** Header band of a grid-mode labels page ("Album A · Sheet 3 · inside labels"). */
export const LABEL_HEADER_MM = 12;

const LABEL_AREA = { width: A4_PORTRAIT.width - 2 * MARGIN_MM, height: A4_PORTRAIT.height - 2 * MARGIN_MM };

/**
 * Grid mode (one page per sheet, mirroring it) when `cols × 28 ≤ 190` and `rows × 28 + header ≤ 277`. The header
 * counted is the worst case, the page carrying the calibration band too, so every sheet page has the same geometry.
 */
export function labelGridFits(cols: number, rows: number): boolean {
  return (
    cols * LABEL_PITCH_MM <= LABEL_AREA.width &&
    rows * LABEL_PITCH_MM + LABEL_HEADER_MM + CALIBRATION_BAND_MM <= LABEL_AREA.height
  );
}

export interface LabelSlot {
  /** Index of the cap in the labels list. */
  readonly index: number;
  readonly col: number;
  readonly row: number;
  /** Centre, mm from the top-left corner. */
  readonly cx: number;
  readonly cy: number;
  /** Flow mode: the pocket number printed at the label's bottom edge. */
  readonly pocket?: number;
}

/** Centre of column 0 for `cols` labels, the row block centred on the page like the discs. */
function labelX0(cols: number): number {
  return (A4_PORTRAIT.width - (cols * LABEL_PITCH_MM - GUTTER_MM)) / 2 + LABEL_MM / 2;
}

/** Grid mode: the label of `pocket` (1-based, row-major as on the sheet) at its row and column. */
export function labelGridSlot(index: number, pocket: number, cols: number, calibration: boolean): LabelSlot {
  const col = (pocket - 1) % cols;
  const row = Math.floor((pocket - 1) / cols);
  const top = MARGIN_MM + (calibration ? CALIBRATION_BAND_MM : 0) + LABEL_HEADER_MM;
  return {
    index,
    col,
    row,
    cx: labelX0(cols) + col * LABEL_PITCH_MM,
    cy: top + LABEL_MM / 2 + row * LABEL_PITCH_MM,
  };
}

/** Flow mode: columns and rows of the dense layout (page 1 loses the calibration band when it carries it). */
export function labelFlowGrid(): { cols: number; rowsFirst: number; rowsOther: number } {
  const per = (span: number) => Math.floor((span + GUTTER_MM) / LABEL_PITCH_MM);
  return {
    cols: per(LABEL_AREA.width),
    rowsFirst: per(LABEL_AREA.height - CALIBRATION_BAND_MM),
    rowsOther: per(LABEL_AREA.height),
  };
}

/** Flow mode: `count` labels row-major, page by page; the first page is shorter when it carries the calibration. */
export function layoutLabelsFlow(count: number, calibrationFirst: boolean): LabelSlot[][] {
  const { cols, rowsFirst, rowsOther } = labelFlowGrid();
  const pages: LabelSlot[][] = [];
  let index = 0;
  while (index < count) {
    const first = pages.length === 0 && calibrationFirst;
    const rows = first ? rowsFirst : rowsOther;
    const top = MARGIN_MM + (first ? CALIBRATION_BAND_MM : 0);
    const slots: LabelSlot[] = [];
    for (let i = 0; i < cols * rows && index < count; i++, index++) {
      const col = i % cols;
      const row = Math.floor(i / cols);
      slots.push({
        index,
        col,
        row,
        cx: labelX0(cols) + col * LABEL_PITCH_MM,
        cy: top + LABEL_MM / 2 + row * LABEL_PITCH_MM,
      });
    }
    pages.push(slots);
  }
  return pages;
}
