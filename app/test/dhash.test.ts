// Tests for the client dHash and the circular crop of the cap photo (CAP-36, ADR-004 §1): golden hashes, fixture
// distances, the crop/mask/encode path through a fake codec (hash of the inscribed square, architect revision
// 2026-11-08), and stability across the resize step.
import { DHash } from '@capcollector/shared';
import { describe, expect, it, vi } from 'vitest';

import { areaAverageGray, dhash, hammingDistance } from '../src/images/dhash';
import {
  browserCodec,
  inscribedSquare,
  maskCircle,
  MAX_EDGE,
  resizeToWebp,
  WebpUnsupportedError,
  type Crop,
  type Raster,
  type RasterCodec,
} from '../src/images/resize';
import expected from './fixtures/dhash/expected.json';
import { DESIGNS, FIXTURES, LAMP, renderCap, type FixtureName } from './fixtures/dhash/make';

/** Opaque gray RGBA rows from luma values. */
const gray = (rows: number[][]) => ({
  data: rows.flat().flatMap((v) => [v, v, v, 255]),
  width: rows[0]?.length ?? 0,
  height: rows.length,
});

/** Rendering 1024 px caps is CPU-bound; give it room when the whole suite runs in parallel under coverage. */
const HEAVY = { timeout: 20_000 };

const alphaAt = (r: Raster, x: number, y: number) => r.data[(y * r.width + x) * 4 + 3];

describe('dHash', () => {
  it('[T-app-064] known pixel arrays give known hashes (area average to 9 × 8, right brighter = 1, MSB first)', () => {
    // Hand-verified 2-row images: each source row covers four of the eight hash rows.
    // Row 0 rises left → right (8 × "1"), row 1 falls (8 × "0") → 32 ones then 32 zeros.
    const rising = [10, 20, 30, 40, 50, 60, 70, 80, 90];
    expect(dhash(gray([rising, [...rising].reverse()]))).toBe('ffffffff00000000');
    // Alternating dark/bright gives 1010 1010 per row; a flat row gives zeros.
    const alternating = [0, 255, 0, 255, 0, 255, 0, 255, 0];
    expect(dhash(gray([alternating, Array<number>(9).fill(128)]))).toBe('aaaaaaaa00000000');
    // Area average, not nearest neighbour: each 2 × 2 block of an 18 × 16 image averages to the 9 × 8 cell.
    const cells = Array.from({ length: 8 }, (_, r) => Array.from({ length: 9 }, (_, c) => ((r * 7 + c * 13) % 9) * 25));
    const big = cells.flatMap((row) => {
      const wide = row.flatMap((v) => [v - 6, v + 6]);
      return [wide, wide];
    });
    expect(dhash(gray(big))).toBe(dhash(gray(cells)));
    // Fractional edges: 3 columns into 2 → (0 + 90/2) / 1.5 = 30 and (90/2 + 180) / 1.5 = 150.
    expect([...areaAverageGray(gray([[0, 90, 180]]), 2, 1)].map(Math.round)).toEqual([30, 150]);
    // Alpha is ignored (the hashed region is all cap): only BT.601 luma counts.
    expect([...areaAverageGray({ data: [100, 200, 50, 0], width: 1, height: 1 }, 1, 1)]).toEqual([
      0.299 * 100 + 0.587 * 200 + 0.114 * 50,
    ]);
    expect(() => dhash({ data: [], width: 0, height: 0 })).toThrow(RangeError);

    expect(hammingDistance('0000000000000000', 'ffffffffffffffff')).toBe(64);
    expect(hammingDistance('f0f0f0b0b0f0f0f0', 'f0f0f0b0b0f0f0f1')).toBe(1);
    expect(() => hammingDistance('F0F0F0B0B0F0F0F0', '0000000000000000')).toThrow(RangeError);
  });

  it('[T-app-065] fixtures (inscribed square): the same cap under two lights is ≤ 10 apart, different caps ≥ 20', () => {
    const hashes = Object.fromEntries(
      (Object.keys(FIXTURES) as FixtureName[]).map((name) => [name, dhash(FIXTURES[name]())]),
    ) as Record<FixtureName, string>;
    // Golden values in fixtures/dhash/expected.json (see make.ts to regenerate).
    expect(hashes).toEqual(expected);
    for (const hash of Object.values(hashes)) expect(DHash.safeParse(hash).success).toBe(true);

    expect(hammingDistance(hashes['red-band-daylight'], hashes['red-band-lamp'])).toBeLessThanOrEqual(10);
    const different: [FixtureName, FixtureName][] = [
      ['red-band-daylight', 'blue-diagonal'],
      ['red-band-daylight', 'green-rings'],
      ['red-band-lamp', 'blue-diagonal'],
      ['red-band-lamp', 'green-rings'],
      ['blue-diagonal', 'green-rings'],
    ];
    // Measured 22–37 (same cap: 4): with no background or mask edge in the hash, the margin over the threshold of 10 is wide.
    for (const [a, b] of different) {
      expect(hammingDistance(hashes[a], hashes[b]), `${a} vs ${b}`).toBeGreaterThanOrEqual(20);
    }
  });

  it(
    '[T-app-066] circular crop keeps the centre square, ≤ 1024 px, alpha outside the circle; hash of the inscribed square',
    HEAVY,
    async () => {
      // A 2000 × 1500 photo: the centre square is x 250…1750, scaled to 1024 × 1024.
      const crops: { crop: Crop; width: number; height: number }[] = [];
      const encoded: { raster: Raster; quality: number }[] = [];
      const close = vi.fn();
      const sizes = [2_000_000, 900_000];
      const codec: RasterCodec = {
        decode: vi.fn(async () => ({ source: document.createElement('canvas'), width: 2000, height: 1500, close })),
        encode: vi.fn(),
        raster: vi.fn(async (_image, crop, width, height) => {
          crops.push({ crop, width, height });
          return renderCap(DESIGNS.redBand, width);
        }),
        encodeRaster: vi.fn(async (raster, quality) => {
          encoded.push({ raster, quality });
          return new Blob([new Uint8Array(sizes.shift() ?? 1000)], { type: 'image/webp' });
        }),
      };
      const photo = await resizeToWebp(new Blob(['jpeg']), { crop: 'circle', codec });
      expect(crops).toEqual([{ crop: { sx: 250, sy: 0, sw: 1500, sh: 1500 }, width: MAX_EDGE, height: MAX_EDGE }]);
      expect(photo).toMatchObject({ width: 1024, height: 1024 });
      expect(photo.blob.size).toBe(900_000);
      // Quality steps down only while the WebP is above 1 MiB.
      expect(encoded.map((e) => e.quality)).toEqual([0.85, 0.7]);
      const sent = encoded[0]?.raster;
      if (!sent) throw new Error('nothing encoded');
      expect([alphaAt(sent, 0, 0), alphaAt(sent, 1023, 1023), alphaAt(sent, 1023, 0)]).toEqual([0, 0, 0]);
      expect([alphaAt(sent, 512, 512), alphaAt(sent, 512, 1), alphaAt(sent, 1, 512)]).toEqual([255, 255, 255]);
      // The hash is of the square inscribed in the circle, before the mask and before encoding.
      expect(photo.dhash).toBe(dhash(inscribedSquare(renderCap(DESIGNS.redBand, 1024))));
      expect(photo.dhash).not.toBe(dhash(sent));

      // Inscribed square: side = ⌊1024 / √2⌋ = 724, centred at 150; every pixel lies inside the circle (no mask edge).
      const inner = inscribedSquare(maskCircle(renderCap(DESIGNS.greenRings, 1024)));
      expect([inner.width, inner.height]).toEqual([724, 724]);
      expect(inner.data.filter((_, i) => i % 4 === 3).every((a) => a === 255)).toBe(true);
      const ramp: Raster = {
        data: new Uint8ClampedArray(Array.from({ length: 6 * 4 }, (_, i) => Math.floor(i / 4) * 10)),
        width: 3,
        height: 2,
      };
      // A 3 × 2 raster: diameter 2 → side 1, at x 1 (pixel 1 of the top row).
      expect(inscribedSquare(ramp)).toEqual({ data: new Uint8ClampedArray([10, 10, 10, 10]), width: 1, height: 1 });
      expect(close).toHaveBeenCalled();
      expect(codec.encode).not.toHaveBeenCalled();

      // maskCircle copies; the source keeps its pixels.
      const square = renderCap(DESIGNS.greenRings, 8);
      const masked = maskCircle(square);
      expect(alphaAt(square, 0, 0)).toBe(255);
      expect(alphaAt(masked, 0, 0)).toBe(0);
      expect(alphaAt(masked, 4, 4)).toBe(255);

      // No 2D canvas → refused like an unsupported encoder.
      const blind: RasterCodec = { ...codec, raster: vi.fn(async () => null) };
      await expect(resizeToWebp(new Blob(['x']), { crop: 'circle', codec: blind })).rejects.toBeInstanceOf(
        WebpUnsupportedError,
      );

      // The browser codec reads the drawn pixels back and encodes them through putImageData (canvas stubbed).
      const drawImage = vi.fn();
      const putImageData = vi.fn();
      const pixels = new Uint8ClampedArray([1, 2, 3, 4]);
      const context = {
        drawImage,
        imageSmoothingQuality: 'low',
        getImageData: vi.fn(() => ({ data: pixels })),
        createImageData: vi.fn((w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4) })),
        putImageData,
      };
      const canvas = document.createElement('canvas');
      vi.spyOn(canvas, 'getContext').mockReturnValue(context as never);
      vi.spyOn(canvas, 'toBlob').mockImplementation((cb, type) => cb(new Blob(['w'], { type: type ?? '' })));
      const doc = { createElement: () => canvas } as unknown as Document;
      const bitmap = { width: 3, height: 2, close: vi.fn() } as unknown as ImageBitmap;
      const real = browserCodec({ document: doc, createImageBitmap: vi.fn(async () => bitmap) });
      const image = await real.decode(new Blob(['x']));
      await expect(real.raster(image, { sx: 1, sy: 0, sw: 2, sh: 2 }, 1, 1)).resolves.toEqual({
        data: pixels,
        width: 1,
        height: 1,
      });
      expect(drawImage).toHaveBeenCalledWith(bitmap, 1, 0, 2, 2, 0, 0, 1, 1);
      const blob = await real.encodeRaster({ data: pixels, width: 1, height: 1 }, 0.85);
      expect(blob?.type).toBe('image/webp');
      expect((putImageData.mock.calls[0]?.[0] as { data: Uint8ClampedArray }).data).toEqual(pixels);
      vi.spyOn(canvas, 'getContext').mockReturnValue(null);
      await expect(real.raster(image, { sx: 0, sy: 0, sw: 1, sh: 1 }, 1, 1)).resolves.toBeNull();
      await expect(real.encodeRaster({ data: pixels, width: 1, height: 1 }, 0.85)).resolves.toBeNull();
    },
  );

  it(
    '[T-app-067] the hash is stable across the resize step: 1024 px and 512 px of the same cap differ by ≤ 2',
    HEAVY,
    () => {
      for (const [name, design] of Object.entries(DESIGNS)) {
        for (const light of [undefined, LAMP]) {
          const full = dhash(inscribedSquare(renderCap(design, 1024, light)));
          const half = dhash(inscribedSquare(renderCap(design, 512, light)));
          expect(hammingDistance(full, half), name).toBeLessThanOrEqual(2);
        }
      }
    },
  );
});
