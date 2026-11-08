// 64-bit difference hash of the cropped cap photo, computed on the device before upload (ADR-004 §1, CAP-36) and
// compared on the server by Hamming distance (≤ 10 = "Already in collection", api/src/lib/scans.ts). Shared `DHash`:
// 16 lower-case hex chars. Pure over RGBA pixels (an `ImageData` or the codec's `Raster`), so it tests without a canvas.
//
// Algorithm: luma (BT.601) composited over black (transparent pixels count as 0, so the masked corners of a circular
// crop are the same for every cap) → area-average down to 9 × 8 (a box filter with fractional edges, not nearest
// neighbour, so the hash does not depend on the photo's resolution) → for each row, bit = 1 when the right neighbour
// is brighter → 64 bits row-major, the first one the most significant.
import { DHash } from '@capcollector/shared';

export const DHASH_COLUMNS = 9;
export const DHASH_ROWS = 8;

/** RGBA pixels, 4 bytes each, row-major (the shape of `ImageData`). */
export interface Pixels {
  readonly data: ArrayLike<number>;
  readonly width: number;
  readonly height: number;
}

/** For each output index, the source indices it covers and the share of each (summing to 1). */
function axisWeights(source: number, target: number): { index: number; weight: number }[][] {
  const scale = source / target;
  const weights: { index: number; weight: number }[][] = [];
  for (let o = 0; o < target; o++) {
    const start = o * scale;
    const end = start + scale;
    const cell: { index: number; weight: number }[] = [];
    for (let i = Math.floor(start); i < Math.min(source, Math.ceil(end)); i++) {
      const overlap = Math.min(end, i + 1) - Math.max(start, i);
      if (overlap > 0) cell.push({ index: i, weight: overlap / scale });
    }
    weights.push(cell);
  }
  return weights;
}

/** Grayscale area average of `pixels` at `columns` × `rows`, row-major. */
export function areaAverageGray(pixels: Pixels, columns: number, rows: number): Float64Array {
  const { data, width, height } = pixels;
  if (width < 1 || height < 1 || data.length < width * height * 4) throw new RangeError('empty or short pixel data');
  // Horizontal pass: every source row down to `columns` values; then the vertical pass down to `rows`.
  const xs = axisWeights(width, columns);
  const ys = axisWeights(height, rows);
  const narrow = new Float64Array(height * columns);
  for (let y = 0; y < height; y++) {
    for (let c = 0; c < columns; c++) {
      let sum = 0;
      for (const { index, weight } of xs[c] ?? []) {
        const p = (y * width + index) * 4;
        const luma = 0.299 * (data[p] ?? 0) + 0.587 * (data[p + 1] ?? 0) + 0.114 * (data[p + 2] ?? 0);
        sum += ((luma * (data[p + 3] ?? 255)) / 255) * weight;
      }
      narrow[y * columns + c] = sum;
    }
  }
  const out = new Float64Array(columns * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < columns; c++) {
      let sum = 0;
      for (const { index, weight } of ys[r] ?? []) sum += (narrow[index * columns + c] ?? 0) * weight;
      out[r * columns + c] = sum;
    }
  }
  return out;
}

/** 64-bit dHash of `pixels` as 16 lower-case hex chars (shared `DHash`). */
export function dhash(pixels: Pixels): string {
  const gray = areaAverageGray(pixels, DHASH_COLUMNS, DHASH_ROWS);
  let hex = '';
  let nibble = 0;
  let bits = 0;
  for (let r = 0; r < DHASH_ROWS; r++) {
    for (let c = 0; c < DHASH_COLUMNS - 1; c++) {
      const left = gray[r * DHASH_COLUMNS + c] ?? 0;
      const right = gray[r * DHASH_COLUMNS + c + 1] ?? 0;
      nibble = (nibble << 1) | (right > left ? 1 : 0);
      if (++bits % 4 === 0) {
        hex += nibble.toString(16);
        nibble = 0;
      }
    }
  }
  return hex;
}

/** Number of differing bits between two dHashes (same rule as the API's duplicate check). */
export function hammingDistance(a: string, b: string): number {
  if (!DHash.safeParse(a).success || !DHash.safeParse(b).success) throw new RangeError('dHash expected');
  let distance = 0;
  for (let i = 0; i < a.length; i++) {
    let x = Number.parseInt(a[i] ?? '0', 16) ^ Number.parseInt(b[i] ?? '0', 16);
    while (x > 0) {
      distance += x & 1;
      x >>= 1;
    }
  }
  return distance;
}
