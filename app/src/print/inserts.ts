// The insert PDF, built on the client (CAP-54; ADR-001; physical-link.md § Insert discs and § Sheet index, amended
// 2026-11-09; SCREENS.md #8): data → PDF bytes with `pdf-lib` (built-in Helvetica, nothing embedded) and QR codes from
// `qrcode` drawn as vector squares. Discs first — front pages (code large, brand, ISO country · year, grey cut circle
// for a circle punch; page 1 carries the 20 mm calibration square) each followed by its back page (brand · variant,
// producer, type / material, acquired on, a 12 mm QR `collectors://cap/<id>`, columns mirrored) — then one sheet
// index page per sheet. `planInserts` is the pure page plan the tests read; `buildInsertsPdf` draws it.
import { formatLocationCode, type Album, type Cap } from '@capcollector/shared';
import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage } from 'pdf-lib';
import QRCode from 'qrcode';

import { t } from '../i18n/i18n.js';
import { MATERIAL_LABEL, TYPE_LABEL } from '../i18n/labels.js';
import { APP_SCHEME } from '../router/deep-link.js';
import {
  A4_PORTRAIT,
  CALIBRATION_MM,
  MARGIN_MM,
  PT_PER_MM,
  QR_MM,
  backSlot,
  chord,
  discDiameter,
  discGrid,
  indexGeometry,
  layoutDiscs,
  type DiscGrid,
  type DiscSlot,
  type IndexGeometry,
} from './layout.js';

export type PrintWhat = 'discs' | 'index' | 'both';

export interface IndexSheet {
  readonly sheet: number;
  /** The caps on that sheet (any order). */
  readonly caps: readonly Cap[];
}

export interface InsertsInput {
  /** Needs `pocketMm` and `pitchMm` (the print screen asks for them first). */
  readonly album: Album;
  /** Caps to print a disc for, in print order. */
  readonly discs: readonly Cap[];
  /** Sheets to print an index page for. */
  readonly sheets: readonly IndexSheet[];
  readonly what: PrintWhat;
  readonly printedOn: Date;
}

export type PagePlan =
  | { readonly kind: 'front'; readonly calibration: boolean; readonly slots: readonly DiscSlot[] }
  | { readonly kind: 'back'; readonly slots: readonly DiscSlot[] }
  | { readonly kind: 'index'; readonly sheet: number; readonly geometry: IndexGeometry };

/** The QR payload of a disc: the app's deep link to the cap (CAP-33). */
export function qrPayload(capId: string): string {
  return `${APP_SCHEME}://cap/${capId}`;
}

function measurements(album: Album): { pocketMm: number; pitchMm: number } {
  if (album.pocketMm === undefined || album.pitchMm === undefined) throw new Error('album pocket/pitch not measured');
  return { pocketMm: album.pocketMm, pitchMm: album.pitchMm };
}

/** Pages in print order: front, back, front, back…, then the index pages. */
export function planInserts(input: InsertsInput): { grid: DiscGrid | null; pages: PagePlan[] } {
  const { pocketMm, pitchMm } = measurements(input.album);
  const pages: PagePlan[] = [];
  let grid: DiscGrid | null = null;
  if (input.what !== 'index' && input.discs.length > 0) {
    grid = discGrid(discDiameter(pocketMm));
    const slots = layoutDiscs(input.discs.length, grid);
    const fronts = (slots.at(-1)?.sheet ?? 0) + 1;
    for (let sheet = 0; sheet < fronts; sheet++) {
      const onSheet = slots.filter((s) => s.sheet === sheet);
      const g = grid;
      pages.push({ kind: 'front', calibration: sheet === 0, slots: onSheet });
      pages.push({ kind: 'back', slots: onSheet.map((s) => backSlot(s, g)) });
    }
  }
  if (input.what !== 'discs') {
    const cols = input.album.cols ?? 6;
    const rows = input.album.rows ?? 7;
    for (const { sheet } of [...input.sheets].sort((a, b) => a.sheet - b.sheet)) {
      pages.push({ kind: 'index', sheet, geometry: indexGeometry(cols, rows, pitchMm) });
    }
  }
  return { grid, pages };
}

// ── drawing ──

const INK = rgb(0.106, 0.102, 0.09);
const MUTED = rgb(0.36, 0.35, 0.33);
const CUT = rgb(0.6, 0.6, 0.6);

/** Text WinAnsi Helvetica can draw: accents kept where the font has them, stripped otherwise, the rest as `?`. */
export function drawable(font: PDFFont, text: string): string {
  const charset = new Set(font.getCharacterSet());
  return [...text]
    .map((ch) => {
      if (charset.has(ch.codePointAt(0) ?? 0)) return ch;
      const bare = ch.normalize('NFD').replace(/\p{M}/gu, '');
      return [...bare].every((c) => charset.has(c.codePointAt(0) ?? 0)) && bare !== '' ? bare : '?';
    })
    .join('');
}

class Drawer {
  constructor(
    private readonly page: PDFPage,
    private readonly regular: PDFFont,
    private readonly bold: PDFFont,
    private readonly heightMm: number,
  ) {}

  private y(mm: number): number {
    return (this.heightMm - mm) * PT_PER_MM;
  }

  /** Centred text at `cy` (baseline-centred), shrunk from `size` down to `min` pt to fit `maxWidthMm`, then cut. */
  centred(
    text: string,
    cx: number,
    cy: number,
    maxWidthMm: number,
    size: number,
    opts: { bold?: boolean; min?: number; color?: ReturnType<typeof rgb> } = {},
  ): void {
    const font = opts.bold ? this.bold : this.regular;
    let value = drawable(font, text);
    if (value === '' || maxWidthMm <= 0) return;
    const max = maxWidthMm * PT_PER_MM;
    let s = size;
    const min = opts.min ?? 4;
    while (s > min && font.widthOfTextAtSize(value, s) > max) s -= 0.25;
    while (value.length > 1 && font.widthOfTextAtSize(value, s) > max) value = `${value.slice(0, -2)}…`;
    const width = font.widthOfTextAtSize(value, s);
    this.page.drawText(value, {
      x: cx * PT_PER_MM - width / 2,
      y: this.y(cy) - font.heightAtSize(s) * 0.35,
      size: s,
      font,
      color: opts.color ?? INK,
    });
  }

  text(text: string, x: number, y: number, size: number, bold = false, color = INK): void {
    const font = bold ? this.bold : this.regular;
    this.page.drawText(drawable(font, text), { x: x * PT_PER_MM, y: this.y(y), size, font, color });
  }

  circle(cx: number, cy: number, r: number, color = CUT, width = 0.5): void {
    this.page.drawEllipse({
      x: cx * PT_PER_MM,
      y: this.y(cy),
      xScale: r * PT_PER_MM,
      yScale: r * PT_PER_MM,
      borderColor: color,
      borderWidth: width,
    });
  }

  rect(
    x: number,
    y: number,
    w: number,
    hgt: number,
    fill?: ReturnType<typeof rgb>,
    border?: ReturnType<typeof rgb>,
  ): void {
    this.page.drawRectangle({
      x: x * PT_PER_MM,
      y: this.y(y + hgt),
      width: w * PT_PER_MM,
      height: hgt * PT_PER_MM,
      ...(fill ? { color: fill } : {}),
      ...(border ? { borderColor: border, borderWidth: 0.5 } : {}),
    });
  }

  qr(payload: string, cx: number, top: number, sizeMm: number): void {
    const code = QRCode.create(payload, { errorCorrectionLevel: 'M' });
    const n = code.modules.size;
    const m = sizeMm / n;
    const x0 = cx - sizeMm / 2;
    for (let r = 0; r < n; r++) {
      for (let c = 0; c < n; c++) {
        if (code.modules.get(r, c)) this.rect(x0 + c * m, top + r * m, m, m, INK);
      }
    }
  }
}

function capName(cap: Cap): string {
  return [cap.brand, cap.variant].filter(Boolean).join(t('collection.separator'));
}

function drawFront(d: Drawer, cap: Cap, slot: DiscSlot, diameter: number): void {
  const r = diameter / 2;
  const { cx, cy } = slot;
  d.circle(cx, cy, r);
  const code = cap.location ? formatLocationCode(cap.location) : '';
  d.centred(code, cx, cy - r * 0.38, chord(r, r * 0.55) - 2, 13, { bold: true, min: 6 });
  d.centred(cap.brand, cx, cy + r * 0.22, chord(r, r * 0.3) - 2, 8, { min: 4.5 });
  const small = [cap.country, cap.year === undefined ? undefined : String(cap.year)]
    .filter(Boolean)
    .join(t('collection.separator'));
  d.centred(small, cx, cy + r * 0.55, chord(r, r * 0.65) - 2, 6, { min: 4, color: MUTED });
}

function drawBack(d: Drawer, cap: Cap, slot: DiscSlot, diameter: number): void {
  const r = diameter / 2;
  const { cx, cy } = slot;
  d.circle(cx, cy, r);
  const lines = [
    capName(cap),
    cap.producer,
    [cap.type && t(TYPE_LABEL[cap.type]), cap.material && t(MATERIAL_LABEL[cap.material])]
      .filter(Boolean)
      .join(t('collection.separator')),
    cap.acquiredOn,
  ];
  const qrTop = cy + r - QR_MM - 2.2;
  const lineGap = Math.min(2.4, (qrTop - (cy - r + 3)) / lines.length);
  lines.forEach((line, i) => {
    if (!line) return;
    const y = cy - r + 4 + i * lineGap;
    d.centred(line, cx, y, chord(r, y - cy) - 2.5, i === 0 ? 5.5 : 5, { bold: i === 0, min: 3.5 });
  });
  d.qr(qrPayload(cap.capId), cx, qrTop, QR_MM);
}

function drawCalibration(d: Drawer): void {
  d.rect(MARGIN_MM, MARGIN_MM, CALIBRATION_MM, CALIBRATION_MM, undefined, INK);
  d.text(t('print.calibration'), MARGIN_MM + CALIBRATION_MM + 3, MARGIN_MM + CALIBRATION_MM / 2 + 1.5, 9);
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

function drawIndex(d: Drawer, input: InsertsInput, sheet: IndexSheet, g: IndexGeometry): void {
  const album = input.album;
  const cols = album.cols ?? 6;
  const rows = album.rows ?? 7;
  d.text(
    t('print.indexHeader', {
      letter: album.letter,
      sheet: String(sheet.sheet),
      date: dateFormat.format(input.printedOn),
    }),
    MARGIN_MM,
    MARGIN_MM + 6,
    12,
    true,
  );
  d.text(
    t('print.indexScale', { percent: String(Math.round(g.scale * 100)) }),
    MARGIN_MM,
    MARGIN_MM + 11,
    8,
    false,
    MUTED,
  );
  const byPocket = new Map<number, Cap>();
  for (const cap of sheet.caps) if (cap.location?.kind === 'album') byPocket.set(cap.location.pocket, cap);
  const pocketR = ((album.pocketMm ?? 0) * g.scale) / 2;
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const n = row * cols + col + 1;
      const x = g.x0 + col * g.cell;
      const y = g.y0 + row * g.cell;
      const cx = x + g.cell / 2;
      const cy = y + g.cell / 2;
      d.rect(x, y, g.cell, g.cell, undefined, CUT);
      d.circle(cx, cy, pocketR, CUT, 0.4);
      const cap = byPocket.get(n);
      if (!cap) continue;
      d.text(String(n), x + 1, y + 3, 5.5, false, MUTED);
      const code = formatLocationCode({ kind: 'album', album: album.letter, sheet: sheet.sheet, pocket: n });
      d.centred(code, cx, cy - pocketR * 0.4, pocketR * 1.6, 7, { bold: true, min: 4 });
      d.centred(capName(cap), cx, cy + pocketR * 0.15, pocketR * 1.8, 6.5, { min: 3.5 });
      if (cap.year !== undefined)
        d.centred(String(cap.year), cx, cy + pocketR * 0.55, pocketR * 1.4, 5.5, { min: 3.5, color: MUTED });
    }
  }
}

/** The PDF bytes for `input`. Throws when there is nothing to print. */
export async function buildInsertsPdf(input: InsertsInput): Promise<Uint8Array> {
  const { grid, pages } = planInserts(input);
  if (pages.length === 0) throw new Error('nothing to print');
  const doc = await PDFDocument.create();
  doc.setTitle(t('print.pdfTitle', { letter: input.album.letter }));
  doc.setCreator(t('app.name'));
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const plan of pages) {
    const page = doc.addPage([A4_PORTRAIT.width * PT_PER_MM, A4_PORTRAIT.height * PT_PER_MM]);
    const d = new Drawer(page, regular, bold, A4_PORTRAIT.height);
    if (plan.kind === 'index') {
      const sheet = input.sheets.find((s) => s.sheet === plan.sheet);
      if (sheet) drawIndex(d, input, sheet, plan.geometry);
      continue;
    }
    if (!grid) continue;
    if (plan.kind === 'front' && plan.calibration) drawCalibration(d);
    for (const slot of plan.slots) {
      const cap = input.discs[slot.index];
      if (!cap) continue;
      if (plan.kind === 'front') drawFront(d, cap, slot, grid.diameter);
      else drawBack(d, cap, slot, grid.diameter);
    }
  }
  return doc.save();
}
