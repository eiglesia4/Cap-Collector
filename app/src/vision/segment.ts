// Tray segmentation (CAP-82; ADR-009 §1–2): find the crown caps in one photo of a tray, on the device, in pure
// TypeScript over RGBA pixels (the `Pixels` of dhash.ts), with no AI, no server and no dependency. The user confirms
// the circles afterwards (ADR-009 §2), so detection has to be good, not perfect.
//
// The caller passes a downscaled raster (long edge ≤ 1600). Pipeline, following the CAP-82 guideline with four
// deliberate changes (each one is covered by the T-vision tests):
//   0. Working copy: box-averaged by an integer factor so the long edge is ≤ 800 px. The caps stay ≥ ~15 px in radius
//      on a 20–30 cap tray, and every later step runs on a quarter of the pixels (performance guard).
//   1–2. Background = a colour **plane** a + b·x + c·y fitted (least squares, per channel) to a border band of ~4 %,
//      instead of one median colour: a soft shadow or a light gradient across the tray is then background, not
//      foreground (CHANGE 1). The fit runs twice, the second time without the band pixels far from the first plane
//      (caps lying on the border). Foreground = RGB distance to that plane (luma and chroma together) above the Otsu
//      threshold of the distance map, and never below MIN_CONTRAST, so an empty tray yields nothing instead of noise.
//   3. Holes filled (background not reachable from the photo's edge: a cap's light ring or label below the threshold
//      must not cut it into a disc and an annulus), then opening and closing with a square of radius ≈ 0.4 % of the
//      short edge.
//   4. Connected components (4-connectivity); those under 0.2 % of the image are dropped, and so are soft blobs
//      (CHANGE 4): a component must stand MIN_CONTRAST above the distance map just outside it (the median of 64
//      samples on a circle beyond its farthest pixel). A cap has a sharp edge; a shadow or a stain fades out.
//   5. Per component: centroid, equivalent radius √(A/π), and roundness A / (π·Rmax²), Rmax being the farthest pixel
//      from the centroid. The guideline's 4πA/P² over a pixel perimeter rates a square *rounder* than a disc once the
//      staircase is corrected, so it cannot reject rectangles; A/(πRmax²) is ≈ 1 for a disc, 0.64 for a square, 0.5
//      for two touching discs (CHANGE 2). The median radius r̃ is taken over the round (> 0.8) inner components.
//   6. Components of ≥ 1.8 × the median area (touching caps) are split at the peaks of their chamfer distance
//      transform (≥ 0.6 r̃ high, ≥ 1.2 r̃ apart), each peak a circle of its own height (≈ the cap's radius). A split
//      is kept only if its circles cover ≥ 85 % of the component with a matching area (a long rectangle has ridge
//      peaks too); otherwise one circle covering the component is returned `uncertain`, unless the component fills
//      its bounding box like a rectangle (> 0.88; a disc fills 0.785), which is rejected.
//   7. Rejected: roundness < 0.75 when not split (rectangles, rods), or equivalent radius outside 0.6–1.5 r̃ (coins,
//      crumbs, lids). A component touching the image border is kept, `uncertain`, when its area is 0.25–2.25 × the
//      median (a cap cut by the edge), since its roundness and size cannot be judged (CHANGE 3: the size window).
//   8. Reading order: rows clustered by cy within r̃ of the row's running mean, top → bottom, then left → right; at
//      most MAX_CIRCLES, the rest dropped with `truncated: true`.
// Circles are in the coordinates of the raster passed in (continuous: pixel i covers [i, i + 1)). `scale` maps them to
// the full-resolution photo (`opts.sourceWidth / pixels.width`, 1 without it); crop.ts takes it.
import type { Pixels } from '../images/dhash.js';

export interface DetectedCircle {
  readonly cx: number;
  readonly cy: number;
  readonly r: number;
  /** Touching caps that could not be split, or a cap cut by the photo's edge: the adjust screen highlights it. */
  readonly uncertain: boolean;
}

export interface Detection {
  /** In reading order, at most MAX_CIRCLES. */
  readonly circles: readonly DetectedCircle[];
  /** r̃ in raster pixels; 0 when nothing was found. */
  readonly medianRadius: number;
  /** Full-resolution pixels per raster pixel. */
  readonly scale: number;
  /** More than MAX_CIRCLES caps were found; the extras were dropped. */
  readonly truncated: boolean;
}

export interface DetectOptions {
  /** Width of the full-resolution photo the raster was scaled from (for `scale`). */
  readonly sourceWidth?: number;
}

/** A tray holds at most this many caps (ADR-009; SCREENS.md § Batch mode). */
export const MAX_CIRCLES = 30;
/** Long edge of the working copy. */
export const WORK_EDGE = 800;
/** Minimum RGB distance from the background that can count as a cap, whatever Otsu says (empty tray → nothing). */
export const MIN_CONTRAST = 28;

const BORDER_BAND = 0.04;
const MIN_AREA = 0.002;
const ROUND = 0.8;
const ACCEPT_ROUND = 0.75;
const SPLIT_AREA = 1.8;
/** A component filling more of its bounding box than this is a rectangle, not caps (a disc fills π/4 ≈ 0.785). */
const BOX_FILL_MAX = 0.88;
/** Split circles must cover this share of the component, and their total area match it within ±25 %. */
const SPLIT_COVERAGE = 0.85;

interface Work {
  readonly w: number;
  readonly h: number;
  /** Box factor: one work pixel = f × f raster pixels. */
  readonly f: number;
  readonly rgb: readonly [Float32Array, Float32Array, Float32Array];
}

/** Box-average `pixels` by an integer factor so the long edge is ≤ WORK_EDGE. */
function workingCopy(pixels: Pixels): Work {
  const { data, width, height } = pixels;
  const f = Math.max(1, Math.ceil(Math.max(width, height) / WORK_EDGE));
  const w = Math.floor(width / f);
  const h = Math.floor(height / f);
  const rgb: [Float32Array, Float32Array, Float32Array] = [
    new Float32Array(w * h),
    new Float32Array(w * h),
    new Float32Array(w * h),
  ];
  const n = f * f;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let dy = 0; dy < f; dy++) {
        let p = ((y * f + dy) * width + x * f) * 4;
        for (let dx = 0; dx < f; dx++, p += 4) {
          r += data[p] ?? 0;
          g += data[p + 1] ?? 0;
          b += data[p + 2] ?? 0;
        }
      }
      const i = y * w + x;
      rgb[0][i] = r / n;
      rgb[1][i] = g / n;
      rgb[2][i] = b / n;
    }
  }
  return { w, h, f, rgb };
}

type Plane = readonly [number, number, number];

/** 3 × 3 determinant. */
function det3(a: readonly (readonly number[])[]): number {
  const m = (r: number, c: number) => a[r]?.[c] ?? 0;
  return (
    m(0, 0) * (m(1, 1) * m(2, 2) - m(1, 2) * m(2, 1)) -
    m(0, 1) * (m(1, 0) * m(2, 2) - m(1, 2) * m(2, 0)) +
    m(0, 2) * (m(1, 0) * m(2, 1) - m(1, 1) * m(2, 0))
  );
}

/** 3 × 3 linear solve (Cramer); a singular system falls back to the mean. */
function solve3(m: readonly (readonly number[])[], v: readonly number[]): Plane {
  const d = det3(m);
  const n = m[0]?.[0] ?? 0;
  if (Math.abs(d) < 1e-9) return [(v[0] ?? 0) / Math.max(1, n), 0, 0];
  const col = (k: number) => m.map((row, r) => row.map((x, c) => (c === k ? (v[r] ?? 0) : x)));
  return [det3(col(0)) / d, det3(col(1)) / d, det3(col(2)) / d];
}

/**
 * Least-squares plane a + b·x + c·y of each channel over the border band, skipping the pixels whose `skip` distance
 * is above MIN_CONTRAST (the robust second pass leaves out caps lying in the band).
 */
function backgroundPlanes(work: Work, skip?: Float32Array): Plane[] {
  const { w, h, rgb } = work;
  const band = Math.max(2, Math.round(Math.min(w, h) * BORDER_BAND));
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  const sv = [0, 0, 0];
  const sxv = [0, 0, 0];
  const syv = [0, 0, 0];
  const add = (x: number, y: number) => {
    const i = y * w + x;
    if (skip !== undefined && (skip[i] ?? 0) > MIN_CONTRAST) return;
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    sxy += x * y;
    syy += y * y;
    for (let c = 0; c < 3; c++) {
      const v = rgb[c as 0 | 1 | 2][i] ?? 0;
      sv[c] = (sv[c] ?? 0) + v;
      sxv[c] = (sxv[c] ?? 0) + x * v;
      syv[c] = (syv[c] ?? 0) + y * v;
    }
  };
  for (let y = 0; y < h; y++) {
    if (y < band || y >= h - band) {
      for (let x = 0; x < w; x++) add(x, y);
    } else {
      for (let x = 0; x < band; x++) add(x, y);
      for (let x = w - band; x < w; x++) add(x, y);
    }
  }
  const m = [
    [n, sx, sy],
    [sx, sxx, sxy],
    [sy, sxy, syy],
  ];
  return [0, 1, 2].map((c) => solve3(m, [sv[c] ?? 0, sxv[c] ?? 0, syv[c] ?? 0]));
}

/** RGB distance of every work pixel to the background planes. */
function distanceMap(work: Work, planes: readonly Plane[]): Float32Array {
  const { w, h, rgb } = work;
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      let sum = 0;
      for (let c = 0; c < 3; c++) {
        const [a, b, cc] = planes[c] ?? [0, 0, 0];
        const d = (rgb[c as 0 | 1 | 2][i] ?? 0) - (a + b * x + cc * y);
        sum += d * d;
      }
      out[i] = Math.sqrt(sum);
    }
  }
  return out;
}

/** Otsu threshold of `values` (256 bins over 0…max). */
export function otsu(values: Float32Array): number {
  let max = 0;
  for (const v of values) if (v > max) max = v;
  if (max === 0) return 0;
  const bins = 256;
  const hist = new Float64Array(bins);
  for (const v of values) {
    const b = Math.min(bins - 1, Math.floor((v / max) * bins));
    hist[b] = (hist[b] ?? 0) + 1;
  }
  const total = values.length;
  let sumAll = 0;
  for (let i = 0; i < bins; i++) sumAll += i * (hist[i] ?? 0);
  let sumB = 0;
  let wB = 0;
  let best = 0;
  let bestT = 0;
  for (let t = 0; t < bins; t++) {
    const count = hist[t] ?? 0;
    wB += count;
    if (wB === 0) continue;
    const wF = total - wB;
    if (wF === 0) break;
    sumB += t * count;
    const mB = sumB / wB;
    const mF = (sumAll - sumB) / wF;
    const between = wB * wF * (mB - mF) ** 2;
    if (between > best) {
      best = between;
      bestT = t;
    }
  }
  return ((bestT + 1) / bins) * max;
}

/** Binary erosion (all set) or dilation (any set) with a (2k+1)² square, separable via running counts. */
function morph(mask: Uint8Array, w: number, h: number, k: number, erode: boolean): Uint8Array {
  const tmp = new Uint8Array(w * h);
  const out = new Uint8Array(w * h);
  const full = 2 * k + 1;
  // Outside the image counts as background for dilation and as foreground for erosion (no erosion from the border).
  const outside = erode ? 1 : 0;
  const pass = (
    src: Uint8Array,
    dst: Uint8Array,
    len: number,
    lines: number,
    at: (line: number, i: number) => number,
  ) => {
    for (let line = 0; line < lines; line++) {
      let count = 0;
      for (let i = -k; i <= k; i++) count += i < 0 || i >= len ? outside : (src[at(line, i)] ?? 0);
      for (let i = 0; i < len; i++) {
        dst[at(line, i)] = erode ? (count === full ? 1 : 0) : count > 0 ? 1 : 0;
        const leaving = i - k;
        const entering = i + k + 1;
        count -= leaving < 0 ? outside : (src[at(line, leaving)] ?? 0);
        count += entering >= len ? outside : (src[at(line, entering)] ?? 0);
      }
    }
  };
  pass(mask, tmp, w, h, (y, x) => y * w + x);
  pass(tmp, out, h, w, (x, y) => y * w + x);
  return out;
}

interface Component {
  readonly pixels: Int32Array;
  readonly area: number;
  readonly cx: number;
  readonly cy: number;
  readonly radius: number;
  readonly roundness: number;
  readonly border: boolean;
  readonly box: { readonly x0: number; readonly y0: number; readonly x1: number; readonly y1: number };
}

/** Background pixels not connected (4-connectivity) to the photo's edge become foreground. */
function fillHoles(mask: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(mask);
  const seen = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  let top = 0;
  const seed = (i: number) => {
    if (mask[i] === 0 && seen[i] === 0) {
      seen[i] = 1;
      stack[top++] = i;
    }
  };
  for (let x = 0; x < w; x++) {
    seed(x);
    seed((h - 1) * w + x);
  }
  for (let y = 0; y < h; y++) {
    seed(y * w);
    seed(y * w + w - 1);
  }
  while (top > 0) {
    const i = stack[--top] ?? 0;
    const x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < w * (h - 1)) seed(i + w);
  }
  for (let i = 0; i < out.length; i++) if (mask[i] === 0 && seen[i] === 0) out[i] = 1;
  return out;
}

/** Mean distance inside the component minus the median distance on a circle `gap` beyond its farthest pixel. */
function edgeContrast(
  members: readonly number[],
  distance: Float32Array,
  w: number,
  h: number,
  centre: { cx: number; cy: number; rmax: number },
  gap: number,
): number {
  let inside = 0;
  for (const i of members) inside += distance[i] ?? 0;
  inside /= members.length;
  const ring: number[] = [];
  const radius = centre.rmax + gap;
  for (let a = 0; a < 64; a++) {
    const x = Math.floor(centre.cx + radius * Math.cos((a * Math.PI) / 32));
    const y = Math.floor(centre.cy + radius * Math.sin((a * Math.PI) / 32));
    if (x >= 0 && y >= 0 && x < w && y < h) ring.push(distance[y * w + x] ?? 0);
  }
  return inside - median(ring);
}

function components(
  mask: Uint8Array,
  w: number,
  h: number,
  minArea: number,
  distance: Float32Array,
  gap: number,
): Component[] {
  const label = new Uint8Array(w * h);
  const stack = new Int32Array(w * h);
  const found: Component[] = [];
  for (let start = 0; start < w * h; start++) {
    if (mask[start] !== 1 || label[start] === 1) continue;
    let top = 0;
    stack[top++] = start;
    label[start] = 1;
    const members: number[] = [];
    const visit = (j: number) => {
      if (mask[j] === 1 && label[j] === 0) {
        label[j] = 1;
        stack[top++] = j;
      }
    };
    while (top > 0) {
      const i = stack[--top] ?? 0;
      members.push(i);
      const x = i % w;
      if (x > 0) visit(i - 1);
      if (x < w - 1) visit(i + 1);
      if (i >= w) visit(i - w);
      if (i < w * (h - 1)) visit(i + w);
    }
    if (members.length < minArea) continue;
    let sx = 0;
    let sy = 0;
    let x0 = w;
    let y0 = h;
    let x1 = 0;
    let y1 = 0;
    for (const i of members) {
      const x = i % w;
      const y = (i - x) / w;
      sx += x + 0.5;
      sy += y + 0.5;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
    const area = members.length;
    const cx = sx / area;
    const cy = sy / area;
    let rmax2 = 0;
    for (const i of members) {
      const x = i % w;
      const y = (i - x) / w;
      rmax2 = Math.max(rmax2, (x + 0.5 - cx) ** 2 + (y + 0.5 - cy) ** 2);
    }
    // +0.5: the farthest pixel reaches half a pixel beyond its centre.
    const rmax = Math.sqrt(rmax2) + 0.5;
    if (edgeContrast(members, distance, w, h, { cx, cy, rmax }, gap) < MIN_CONTRAST) continue;
    found.push({
      pixels: Int32Array.from(members),
      area,
      cx,
      cy,
      radius: Math.sqrt(area / Math.PI),
      roundness: area / (Math.PI * rmax * rmax),
      border: x0 === 0 || y0 === 0 || x1 === w - 1 || y1 === h - 1,
      box: { x0, y0, x1, y1 },
    });
  }
  return found;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

interface Peak {
  readonly x: number;
  readonly y: number;
  readonly d: number;
}

/**
 * Peaks of the chamfer (3-4) distance transform of `c`, ≥ `minHeight` and ≥ `minGap` apart, highest first: the
 * centres of touching caps, each with its height ≈ that cap's radius.
 */
function distancePeaks(c: Component, w: number, minHeight: number, minGap: number): Peak[] {
  const { x0, y0, x1, y1 } = c.box;
  // A 1-pixel frame of background around the bounding box.
  const bw = x1 - x0 + 3;
  const bh = y1 - y0 + 3;
  const dt = new Float64Array(bw * bh);
  for (const i of c.pixels) {
    const x = i % w;
    const y = (i - x) / w;
    dt[(y - y0 + 1) * bw + (x - x0 + 1)] = 1e9;
  }
  const at = (i: number) => dt[i] ?? 0;
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const i = y * bw + x;
      if (at(i) === 0) continue;
      dt[i] = Math.min(at(i), at(i - 1) + 3, at(i - bw) + 3, at(i - bw - 1) + 4, at(i - bw + 1) + 4);
    }
  }
  for (let y = bh - 2; y >= 1; y--) {
    for (let x = bw - 2; x >= 1; x--) {
      const i = y * bw + x;
      if (at(i) === 0) continue;
      dt[i] = Math.min(at(i), at(i + 1) + 3, at(i + bw) + 3, at(i + bw + 1) + 4, at(i + bw - 1) + 4);
    }
  }
  const candidates: Peak[] = [];
  for (let y = 1; y < bh - 1; y++) {
    for (let x = 1; x < bw - 1; x++) {
      const d = at(y * bw + x) / 3;
      if (d >= minHeight) candidates.push({ x: x + x0 - 1 + 0.5, y: y + y0 - 1 + 0.5, d });
    }
  }
  candidates.sort((a, b) => b.d - a.d);
  const peaks: Peak[] = [];
  for (const p of candidates) {
    if (peaks.every((q) => (q.x - p.x) ** 2 + (q.y - p.y) ** 2 >= minGap * minGap)) peaks.push(p);
  }
  return peaks;
}

function boxFill(c: Component): number {
  const { x0, y0, x1, y1 } = c.box;
  return c.area / ((x1 - x0 + 1) * (y1 - y0 + 1));
}

/** True when `circles` cover the component (≥ SPLIT_COVERAGE of its pixels) and their area matches it. */
function explains(c: Component, w: number, circles: readonly { cx: number; cy: number; r: number }[]): boolean {
  let covered = 0;
  for (const i of c.pixels) {
    const x = (i % w) + 0.5;
    const y = Math.floor(i / w) + 0.5;
    if (circles.some((k) => (x - k.cx) ** 2 + (y - k.cy) ** 2 <= (k.r * 1.05) ** 2)) covered++;
  }
  const circleArea = circles.reduce((sum, k) => sum + Math.PI * k.r * k.r, 0);
  const ratio = c.area / circleArea;
  return covered / c.area >= SPLIT_COVERAGE && ratio >= 0.8 && ratio <= 1.25;
}

/** Row-major reading order: rows by cy within `tolerance` of the row's running mean, then left → right. */
export function readingOrder<T extends { readonly cx: number; readonly cy: number }>(
  circles: readonly T[],
  tolerance: number,
): T[] {
  const byY = [...circles].sort((a, b) => a.cy - b.cy);
  const rows: T[][] = [];
  let mean = Number.NEGATIVE_INFINITY;
  for (const c of byY) {
    const row = rows.at(-1);
    if (row && Math.abs(c.cy - mean) <= tolerance) {
      row.push(c);
      mean += (c.cy - mean) / row.length;
    } else {
      rows.push([c]);
      mean = c.cy;
    }
  }
  return rows.flatMap((row) => row.sort((a, b) => a.cx - b.cx));
}

export function detectCaps(pixels: Pixels, opts: DetectOptions = {}): Detection {
  const scale = opts.sourceWidth !== undefined && pixels.width > 0 ? opts.sourceWidth / pixels.width : 1;
  const empty: Detection = { circles: [], medianRadius: 0, scale, truncated: false };
  const work = workingCopy(pixels);
  const { w, h, f } = work;
  if (w < 8 || h < 8) return empty;

  // Two passes: the second fit ignores band pixels far from the first plane (caps lying on the border).
  const distance = distanceMap(work, backgroundPlanes(work, distanceMap(work, backgroundPlanes(work))));
  const threshold = Math.max(otsu(distance), MIN_CONTRAST);
  let mask: Uint8Array = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) mask[i] = (distance[i] ?? 0) > threshold ? 1 : 0;
  const k = Math.max(1, Math.round(Math.min(w, h) * 0.004));
  mask = fillHoles(mask, w, h);
  mask = morph(morph(mask, w, h, k, true), w, h, k, false); // open
  mask = morph(morph(mask, w, h, k, false), w, h, k, true); // close

  const found = components(mask, w, h, MIN_AREA * w * h, distance, 2 * k + 2);
  const round = found.filter((c) => !c.border && c.roundness > ROUND);
  const rMed = median((round.length > 0 ? round : found.filter((c) => !c.border)).map((c) => c.radius));
  if (rMed === 0) return empty;
  const aMed = Math.PI * rMed * rMed;

  const circles: DetectedCircle[] = [];
  for (const c of found) {
    const ratio = c.area / aMed;
    if (c.border) {
      if (ratio >= 0.25 && ratio <= 2.25) circles.push({ cx: c.cx, cy: c.cy, r: c.radius, uncertain: true });
      continue;
    }
    if (ratio >= SPLIT_AREA) {
      const peaks = distancePeaks(c, w, 0.6 * rMed, 1.2 * rMed).slice(0, Math.round(ratio) + 1);
      const split = peaks.map((p) => ({ cx: p.x, cy: p.y, r: Math.min(1.2 * rMed, Math.max(0.8 * rMed, p.d)) }));
      if (split.length >= 2 && explains(c, w, split)) {
        for (const p of split) circles.push({ ...p, uncertain: false });
      } else if (c.roundness >= 0.45 && boxFill(c) <= BOX_FILL_MAX) {
        // Looks like caps that touch but would not split: one circle over them, for the user to fix.
        circles.push({ cx: c.cx, cy: c.cy, r: c.radius, uncertain: true });
      }
      continue;
    }
    const sized = c.radius >= 0.6 * rMed && c.radius <= 1.5 * rMed;
    if (sized && c.roundness >= ACCEPT_ROUND) circles.push({ cx: c.cx, cy: c.cy, r: c.radius, uncertain: false });
  }

  const ordered = readingOrder(circles, rMed).map((c) => ({ ...c, cx: c.cx * f, cy: c.cy * f, r: c.r * f }));
  return {
    circles: ordered.slice(0, MAX_CIRCLES),
    medianRadius: rMed * f,
    scale,
    truncated: ordered.length > MAX_CIRCLES,
  };
}
