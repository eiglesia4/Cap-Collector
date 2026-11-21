// Synthetic tray photos for the segmentation tests (CAP-82): discs (plain, with a ring, or with a gradient fill) and
// other shapes on a plain or gradient background, with an optional soft shadow and seeded noise. RGBA, row-major.
import type { Raster } from '../../src/images/resize';

export type Rgb = readonly [number, number, number];

export interface Disc {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  readonly color: Rgb;
  /** A ring between 0.78 r and 0.9 r (the crimp edge of a cap). */
  readonly ring?: Rgb;
  /** Brighter top-left, darker bottom-right (±25 %). */
  readonly gradient?: boolean;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
  readonly color: Rgb;
}

export interface TrayOptions {
  readonly width: number;
  readonly height: number;
  /** Plain colour, or a linear gradient from the top-left corner to the bottom-right one. */
  readonly background: Rgb | { readonly from: Rgb; readonly to: Rgb };
  /** A soft dark blob (multiplies the background by up to 1 − strength). */
  readonly shadow?: { readonly cx: number; readonly cy: number; readonly radius: number; readonly strength: number };
  readonly discs?: readonly Disc[];
  readonly rects?: readonly Rect[];
  /** Uniform noise amplitude per channel. */
  readonly noise?: number;
  readonly seed?: number;
}

/** mulberry32: a small seeded PRNG in [0, 1). */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function tray(options: TrayOptions): Raster {
  const { width, height } = options;
  const data = new Uint8ClampedArray(width * height * 4);
  const rand = prng(options.seed ?? 1);
  const bg = options.background;
  const plain = Array.isArray(bg) ? (bg as Rgb) : null;
  const grad = plain === null ? (bg as { from: Rgb; to: Rgb }) : null;
  const diag = width + height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const p = (y * width + x) * 4;
      let color: Rgb;
      if (plain) color = plain;
      else {
        const t = (x + y) / diag;
        color = [0, 1, 2].map((c) => grad!.from[c]! + (grad!.to[c]! - grad!.from[c]!) * t) as unknown as Rgb;
      }
      let k = 1;
      const s = options.shadow;
      if (s) {
        const d = Math.hypot(x - s.cx, y - s.cy) / s.radius;
        k = 1 - s.strength * Math.exp(-d * d);
      }
      data[p] = color[0] * k;
      data[p + 1] = color[1] * k;
      data[p + 2] = color[2] * k;
      data[p + 3] = 255;
    }
  }
  for (const r of options.rects ?? []) {
    for (let y = Math.max(0, r.y); y < Math.min(height, r.y + r.h); y++) {
      for (let x = Math.max(0, r.x); x < Math.min(width, r.x + r.w); x++)
        data.set([...r.color, 255], (y * width + x) * 4);
    }
  }
  for (const d of options.discs ?? []) {
    const x0 = Math.max(0, Math.floor(d.cx - d.r));
    const x1 = Math.min(width - 1, Math.ceil(d.cx + d.r));
    const y0 = Math.max(0, Math.floor(d.cy - d.r));
    const y1 = Math.min(height - 1, Math.ceil(d.cy + d.r));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - d.cx;
        const dy = y + 0.5 - d.cy;
        const rho = Math.hypot(dx, dy) / d.r;
        if (rho > 1) continue;
        let color: Rgb = d.ring && rho >= 0.78 && rho <= 0.9 ? d.ring : d.color;
        if (d.gradient) {
          const g = 1 + 0.25 * (-(dx + dy) / (2 * d.r));
          color = color.map((v) => v * g) as unknown as Rgb;
        }
        data.set([...color, 255], (y * width + x) * 4);
      }
    }
  }
  const noise = options.noise ?? 0;
  if (noise > 0) {
    for (let i = 0; i < data.length; i += 4) {
      for (let c = 0; c < 3; c++) data[i + c] = (data[i + c] ?? 0) + (rand() * 2 - 1) * noise;
    }
  }
  return { data, width, height };
}

/** A rows × cols grid of disc centres, `pitch` apart from `origin`, rows tilted by `tiltDeg`. */
export function grid(
  rows: number,
  cols: number,
  pitch: number,
  origin: { x: number; y: number },
  tiltDeg = 0,
): { cx: number; cy: number }[] {
  const tan = Math.tan((tiltDeg * Math.PI) / 180);
  const out: { cx: number; cy: number }[] = [];
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) out.push({ cx: origin.x + c * pitch, cy: origin.y + r * pitch + c * pitch * tan });
  }
  return out;
}
