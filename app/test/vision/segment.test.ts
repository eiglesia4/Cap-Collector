// Tray segmentation and crop (CAP-82; ADR-009 §1–2; ADR-004 §1) over synthetic trays (test/vision/synthetic.ts):
// counts and geometry for dark-on-light and light-on-dark caps, shadows and gradients, touching caps, shapes that are
// not caps, a cap cut by the edge, an empty tray, reading order, the 30-cap limit, the crop's dHash against the
// single-capture path, and the performance guard.
import { describe, expect, it, vi } from 'vitest';

import { hammingDistance } from '../../src/images/dhash';
import {
  ImageTooLargeError,
  MAX_BYTES,
  MAX_EDGE,
  resizeToWebp,
  WebpUnsupportedError,
  type Raster,
  type RasterCodec,
} from '../../src/images/resize';
import { cropCircle, cropSquare, resampleRaster } from '../../src/vision/crop';
import { detectCaps, MAX_CIRCLES, otsu, readingOrder, type DetectedCircle } from '../../src/vision/segment';
import { grid, tray, type Disc, type Rgb } from './synthetic';

const W = 1600;
const H = 1200;
const R = 70;
const LIGHT: Rgb = [226, 222, 212];
const DARK: Rgb = [38, 36, 40];
/** 4 × 5 caps, 260 px apart. */
const CENTRES = grid(4, 5, 260, { x: 280, y: 210 });

const discs = (color: Rgb, centres = CENTRES, extra: Partial<Disc> = {}): Disc[] =>
  centres.map((c) => ({ ...c, r: R, color, ...extra }));

/** Each expected disc matched by exactly one circle within 0.1 r, radius within 10 %. */
function expectMatches(circles: readonly DetectedCircle[], expected: readonly Disc[]): void {
  expect(circles).toHaveLength(expected.length);
  for (const d of expected) {
    const near = circles.filter((c) => Math.hypot(c.cx - d.cx, c.cy - d.cy) <= 0.1 * d.r);
    expect(near, `disc at ${String(d.cx)},${String(d.cy)}`).toHaveLength(1);
    expect(Math.abs(near[0]!.r - d.r) / d.r).toBeLessThanOrEqual(0.1);
  }
}

describe('detectCaps', () => {
  it('[T-vision-001] 20 separated dark caps on a light tray → 20 circles, centre within 0.1 r, radius within 10 %', () => {
    const expected = discs(DARK);
    const result = detectCaps(tray({ width: W, height: H, background: LIGHT, discs: expected, noise: 8, seed: 1 }));
    expectMatches(result.circles, expected);
    expect(result.circles.every((c) => !c.uncertain)).toBe(true);
    expect(Math.abs(result.medianRadius - R) / R).toBeLessThanOrEqual(0.1);
    expect(result.truncated).toBe(false);
    expect(result.scale).toBe(1);
  });

  it('[T-vision-002] light caps on a dark tray, with rings and gradient fills → 20 circles', () => {
    const expected = discs([214, 206, 190], CENTRES, { ring: [150, 140, 120], gradient: true });
    const result = detectCaps(tray({ width: W, height: H, background: [30, 34, 44], discs: expected, noise: 8 }), {
      sourceWidth: 4032,
    });
    expectMatches(result.circles, expected);
    expect(result.scale).toBeCloseTo(4032 / W);
  });

  it('[T-vision-003] a light gradient and a soft shadow across the tray → still 20, none spurious', () => {
    const expected = discs([150, 40, 30], CENTRES, { ring: [90, 20, 20] });
    const result = detectCaps(
      tray({
        width: W,
        height: H,
        background: { from: [235, 230, 220], to: [175, 170, 160] },
        shadow: { cx: 1300, cy: 300, radius: 500, strength: 0.25 },
        discs: expected,
        noise: 10,
        seed: 3,
      }),
    );
    expectMatches(result.circles, expected);
  });

  it('[T-vision-004] two touching caps → two circles, or one uncertain circle over both, never none', () => {
    const others = discs(DARK, grid(2, 4, 260, { x: 280, y: 210 }));
    const pair: Disc[] = [
      { cx: 600, cy: 900, r: R, color: DARK },
      { cx: 600 + 2 * R, cy: 900, r: R, color: DARK },
    ];
    const result = detectCaps(tray({ width: W, height: H, background: LIGHT, discs: [...others, ...pair], noise: 6 }));
    const near = result.circles.filter((c) => c.cy > 800);
    if (near.length === 2) {
      for (const d of pair) expect(near.some((c) => Math.hypot(c.cx - d.cx, c.cy - d.cy) <= 0.25 * R)).toBe(true);
    } else {
      expect(near).toHaveLength(1);
      expect(near[0]?.uncertain).toBe(true);
      expect(Math.abs((near[0]?.cx ?? 0) - (600 + R))).toBeLessThan(0.25 * R);
    }
    expect(result.circles.filter((c) => c.cy < 800)).toHaveLength(8);
  });

  it('[T-vision-005] a rectangle, a long bar and a coin of a clearly different size are rejected', () => {
    const caps = discs(DARK, grid(2, 5, 260, { x: 280, y: 210 }));
    const coin: Disc = { cx: 400, cy: 900, r: 32, color: DARK };
    const result = detectCaps(
      tray({
        width: W,
        height: H,
        background: LIGHT,
        discs: [...caps, coin],
        rects: [
          { x: 700, y: 820, w: 120, h: 120, color: DARK },
          { x: 1000, y: 850, w: 420, h: 90, color: DARK },
        ],
        noise: 6,
      }),
    );
    expectMatches(result.circles, caps);
  });

  it('[T-vision-006] a cap cut by the photo edge is kept and marked uncertain', () => {
    const inner = discs(DARK, grid(2, 4, 260, { x: 400, y: 300 }));
    const cut: Disc = { cx: 30, cy: 900, r: R, color: DARK };
    const result = detectCaps(tray({ width: W, height: H, background: LIGHT, discs: [...inner, cut], noise: 6 }));
    expect(result.circles).toHaveLength(9);
    const edge = result.circles.find((c) => c.cx < 100);
    expect(edge?.uncertain).toBe(true);
    expect(Math.abs((edge?.cy ?? 0) - 900)).toBeLessThan(0.15 * R);
    expect(result.circles.filter((c) => c.uncertain)).toHaveLength(1);
  });

  it('[T-vision-007] an empty tray (noise, gradient, shadow) → no circles', () => {
    const plain = detectCaps(tray({ width: W, height: H, background: LIGHT, noise: 12, seed: 7 }));
    expect(plain).toEqual({ circles: [], medianRadius: 0, scale: 1, truncated: false });
    const shaded = detectCaps(
      tray({
        width: W,
        height: H,
        background: { from: [235, 230, 220], to: [185, 180, 170] },
        shadow: { cx: 800, cy: 600, radius: 600, strength: 0.15 },
        noise: 12,
      }),
    );
    expect(shaded.circles).toEqual([]);
    // Degenerate inputs.
    expect(detectCaps({ data: new Uint8ClampedArray(4 * 4 * 4), width: 4, height: 4 }).circles).toEqual([]);
    expect(otsu(new Float32Array(10))).toBe(0);
  });

  it('[T-vision-008] reading order is row-major, top → bottom then left → right, with slightly tilted rows', () => {
    const tilted = grid(4, 5, 260, { x: 280, y: 180 }, 4);
    const expected = discs(DARK, tilted);
    const result = detectCaps(tray({ width: W, height: H, background: LIGHT, discs: expected, noise: 6 }));
    expect(result.circles).toHaveLength(20);
    result.circles.forEach((c, i) => {
      const d = expected[i]!;
      expect(Math.hypot(c.cx - d.cx, c.cy - d.cy), `circle ${String(i)}`).toBeLessThanOrEqual(0.1 * R);
    });
    // The pure ordering on its own: two rows, the second starting higher than the end of the first.
    const pts = [
      { cx: 300, cy: 112 },
      { cx: 100, cy: 100 },
      { cx: 200, cy: 106 },
      { cx: 100, cy: 210 },
    ];
    expect(readingOrder(pts, 50).map((p) => p.cx)).toEqual([100, 200, 300, 100]);
  });

  it('[T-vision-009] 35 caps → the first 30 in reading order, truncated', () => {
    const centres = grid(5, 7, 210, { x: 170, y: 170 });
    const expected = centres.map((c) => ({ ...c, r: 60, color: DARK }));
    const result = detectCaps(tray({ width: W, height: H, background: LIGHT, discs: expected, noise: 6 }));
    expect(result.truncated).toBe(true);
    expect(result.circles).toHaveLength(MAX_CIRCLES);
    // Rows 1–4 complete, then 2 of row 5.
    const last = result.circles.at(-1)!;
    expect(Math.hypot(last.cx - expected[29]!.cx, last.cy - expected[29]!.cy)).toBeLessThanOrEqual(6);
  });

  it('[T-vision-011] performance: a 1600 × 1200 tray is segmented in < 1.5 s (fails only above 3 s)', () => {
    const image = tray({ width: W, height: H, background: LIGHT, discs: discs(DARK), noise: 8 });
    const start = performance.now();
    const result = detectCaps(image);
    const ms = performance.now() - start;
    console.info(`[T-vision-011] detectCaps 1600×1200: ${ms.toFixed(0)} ms`);
    expect(result.circles).toHaveLength(20);
    expect(ms).toBeLessThan(3000);
  });
});

describe('cropCircle', () => {
  /** A cap with structure (two-colour ring, gradient) so its dHash means something. */
  const CAP: Disc = { cx: 0, cy: 0, r: 0, color: [180, 60, 40], ring: [240, 220, 120], gradient: true };

  /** Encoder stand-in: a WebP blob whose size can be forced per call. */
  function encoder(sizes: number[] = [], type = 'image/webp') {
    return vi.fn(async (raster: Raster, _quality: number) => {
      const size = sizes.shift() ?? raster.width;
      return new Blob([new Uint8Array(size)], { type });
    });
  }

  it('[T-vision-010] crops a CapPhoto ≤ 1024 px from the full-resolution photo whose dHash matches the single-capture path (± 2 bits)', async () => {
    // Full resolution 2400 × 1800 (r = 150); detection on the 1200 × 900 copy (scale 2).
    const centres = grid(3, 4, 520, { x: 400, y: 380 });
    const full = tray({
      width: 2400,
      height: 1800,
      background: LIGHT,
      discs: centres.map((c) => ({ ...CAP, ...c, r: 150 })),
      noise: 6,
    });
    const small = resampleRaster(full, { sx: 0, sy: 0, sw: 2400, sh: 1800 }, 1200, 900);
    const detection = detectCaps(small, { sourceWidth: 2400 });
    expect(detection.scale).toBe(2);
    expect(detection.circles).toHaveLength(12);

    const encodeRaster = encoder();
    const codec: RasterCodec = {
      decode: vi.fn(async () => ({ source: document.createElement('canvas'), width: 2400, height: 1800 })),
      encode: vi.fn(),
      raster: vi.fn(async (_image, crop, w, h) => resampleRaster(full, crop, w, h)),
      encodeRaster,
    };
    const image = await codec.decode(new Blob());
    for (const [i, circle] of detection.circles.entries()) {
      const batch = await cropCircle({ image, codec }, circle, detection.scale);
      expect(Math.max(batch.width, batch.height)).toBeLessThanOrEqual(MAX_EDGE);
      expect(batch.width).toBe(batch.height);
      expect(batch.blob.type).toBe('image/webp');

      // Single capture of the same cap: the user frames it with the same margin; resize.ts crops the centre square.
      const truth = centres[i]!;
      const single: RasterCodec = {
        ...codec,
        decode: vi.fn(async () => ({ source: document.createElement('canvas'), width: 318, height: 318 })),
        raster: vi.fn(async (_img, crop, w, h) =>
          resampleRaster(
            full,
            { sx: truth.cx - 159 + crop.sx, sy: truth.cy - 159 + crop.sy, sw: crop.sw, sh: crop.sh },
            w,
            h,
          ),
        ),
      };
      const reference = await resizeToWebp(new Blob(), { crop: 'circle', codec: single });
      expect(hammingDistance(batch.dhash, reference.dhash), `cap ${String(i)}`).toBeLessThanOrEqual(2);

      // The raster input gives the same photo.
      const fromRaster = await cropCircle({ raster: full, codec: { encodeRaster } }, circle, detection.scale);
      expect(fromRaster.dhash).toBe(batch.dhash);
    }
    // The stored image is masked: transparent corners.
    const masked = encodeRaster.mock.calls[0]![0];
    expect(masked.data[3]).toBe(0);
  });

  it('[T-vision-012] the crop square keeps a 6 % margin, slides inside the photo at the edge, and encoding errors surface', async () => {
    expect(cropSquare({ cx: 500, cy: 400, r: 100, uncertain: false }, 2, 4000, 3000)).toEqual({
      sx: 788,
      sy: 588,
      sw: 424,
      sh: 424,
    });
    // A cap at the left edge: the square starts at 0.
    expect(cropSquare({ cx: 20, cy: 400, r: 100, uncertain: true }, 1, 4000, 3000).sx).toBe(0);
    // Never larger than the photo.
    expect(cropSquare({ cx: 50, cy: 50, r: 200, uncertain: true }, 1, 300, 200)).toEqual({
      sx: 0,
      sy: 0,
      sw: 200,
      sh: 200,
    });

    const raster = tray({ width: 400, height: 400, background: LIGHT, discs: [{ ...CAP, cx: 200, cy: 200, r: 120 }] });
    const circle = { cx: 200, cy: 200, r: 120, uncertain: false };
    // Too large at 0.85 → retried lower; still too large at every quality → refused.
    const retried = encoder([MAX_BYTES + 1, 1000]);
    await expect(cropCircle({ raster, codec: { encodeRaster: retried } }, circle, 1)).resolves.toMatchObject({
      width: 254,
    });
    expect(retried.mock.calls.map((c) => c[1])).toEqual([0.85, 0.7]);
    await expect(
      cropCircle(
        { raster, codec: { encodeRaster: encoder([MAX_BYTES + 1, MAX_BYTES + 1, MAX_BYTES + 1]) } },
        circle,
        1,
      ),
    ).rejects.toBeInstanceOf(ImageTooLargeError);
    // A browser that falls back to PNG, or has no canvas.
    await expect(
      cropCircle({ raster, codec: { encodeRaster: encoder([], 'image/png') } }, circle, 1),
    ).rejects.toBeInstanceOf(WebpUnsupportedError);
    const blind: RasterCodec = {
      decode: vi.fn(),
      encode: vi.fn(),
      raster: vi.fn(async () => null),
      encodeRaster: encoder(),
    };
    await expect(
      cropCircle(
        { image: { source: document.createElement('canvas'), width: 400, height: 400 }, codec: blind },
        circle,
        1,
      ),
    ).rejects.toBeInstanceOf(WebpUnsupportedError);
  });
});
