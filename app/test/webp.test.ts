// WebP on WebKit (ADR-010 §1, CAP-88): when the canvas hands back a PNG for WebP (Safari, the iPhone app), the browser
// codec encodes the same pixels with libwebp wasm, remembers it for the session, and only gives up
// (`WebpUnsupportedError`) when both fail. The wasm module is stubbed: no real wasm is fetched in vitest.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  browserCodec,
  encodeWithin,
  MAX_BYTES,
  resizeToWebp,
  WebpUnsupportedError,
  type Raster,
  type WebpSupport,
} from '../src/images/resize';
import { encodeWebpWasm } from '../src/images/webp-wasm';
import { cropCircle } from '../src/vision/crop';

const wasmEncode = vi.hoisted(() => vi.fn());
vi.mock('@jsquash/webp/encode', () => ({ default: wasmEncode }));

const WASM_BYTES = new Uint8Array([82, 73, 70, 70]).buffer;

/** A canvas whose `toBlob` answers with `type` (WebKit: PNG whatever was asked). */
function fakeCanvas(type: string | null, w = 4, h = 4) {
  const pixels = new Uint8ClampedArray(w * h * 4).map((_, i) => i % 251);
  const toBlob = vi.fn((cb: BlobCallback) => cb(type === null ? null : new Blob(['c'], { type })));
  const context = {
    imageSmoothingQuality: 'low',
    drawImage: vi.fn(),
    getImageData: vi.fn((_x: number, _y: number, gw: number, gh: number) => ({
      data: gw * gh * 4 === pixels.length ? pixels : new Uint8ClampedArray(gw * gh * 4).fill(200),
    })),
    createImageData: vi.fn((cw: number, ch: number) => ({ data: new Uint8ClampedArray(cw * ch * 4) })),
    putImageData: vi.fn(),
  };
  const canvas = { width: 0, height: 0, getContext: vi.fn(() => context), toBlob };
  const doc = { createElement: () => canvas } as unknown as Document;
  return { doc, canvas, context, pixels, toBlob };
}

function codecFor(fake: ReturnType<typeof fakeCanvas>, support: WebpSupport = { canvasFails: false }) {
  const bitmap = { width: 4, height: 4, close: vi.fn() } as unknown as ImageBitmap;
  return browserCodec({ document: fake.doc, createImageBitmap: vi.fn(async () => bitmap), support });
}

beforeEach(() => {
  wasmEncode.mockReset();
  wasmEncode.mockResolvedValue(WASM_BYTES);
});
afterEach(() => vi.restoreAllMocks());

describe('WebP wasm fallback', () => {
  it('[T-app-165] a canvas returning PNG → the wasm encoder gets the same pixels and quality, and the result is WebP', async () => {
    const fake = fakeCanvas('image/png');
    const photo = await resizeToWebp(new Blob(['x']), { codec: codecFor(fake) });
    expect(photo.blob.type).toBe('image/webp');
    expect(fake.toBlob).toHaveBeenCalledTimes(1);
    expect(wasmEncode).toHaveBeenCalledTimes(1);
    const [image, options] = wasmEncode.mock.calls[0] as [ImageData, { quality: number }];
    expect(image).toMatchObject({ data: fake.pixels, width: 4, height: 4 });
    expect(options).toEqual({ quality: 85 });

    // A canvas yielding no blob at all also falls back; encodeWebpWasm maps quality 0–1 onto libwebp's 0–100.
    const none = fakeCanvas(null);
    await expect(resizeToWebp(new Blob(['x']), { codec: codecFor(none) })).resolves.toMatchObject({ width: 4 });
    const raster: Raster = { data: new Uint8ClampedArray(4), width: 1, height: 1 };
    await encodeWebpWasm(raster, 0.55);
    await encodeWebpWasm(raster, 2);
    expect(wasmEncode.mock.calls.slice(-2).map((c) => (c[1] as { quality: number }).quality)).toEqual([55, 100]);
  });

  it('[T-app-166] the fallback is remembered for the session: later encodes (image and raster) skip the canvas', async () => {
    const fake = fakeCanvas('image/png');
    const support: WebpSupport = { canvasFails: false };
    const codec = codecFor(fake, support);
    await resizeToWebp(new Blob(['x']), { codec });
    expect(support.canvasFails).toBe(true);
    await resizeToWebp(new Blob(['y']), { codec });
    // A codec created later in the same session shares the memory.
    const raster: Raster = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
    const blob = await codecFor(fake, support).encodeRaster(raster, 0.7);
    expect(blob?.type).toBe('image/webp');
    expect(fake.toBlob).toHaveBeenCalledTimes(1);
    expect(fake.context.putImageData).toHaveBeenCalledTimes(0);
    expect(wasmEncode).toHaveBeenCalledTimes(3);
    expect(wasmEncode.mock.calls[2]?.[0]).toMatchObject({ data: raster.data, width: 2, height: 2 });
  });

  it('[T-app-167] a canvas returning WebP never touches wasm', async () => {
    const fake = fakeCanvas('image/webp');
    const support: WebpSupport = { canvasFails: false };
    const codec = codecFor(fake, support);
    await resizeToWebp(new Blob(['x']), { codec });
    const blob = await codec.encodeRaster({ data: new Uint8ClampedArray(16), width: 2, height: 2 }, 0.85);
    expect(blob?.type).toBe('image/webp');
    expect(wasmEncode).not.toHaveBeenCalled();
    expect(support.canvasFails).toBe(false);
  });

  it('[T-app-168] both failing → WebpUnsupportedError with the new message', async () => {
    wasmEncode.mockRejectedValue(new Error('Encoding error.'));
    const fake = fakeCanvas('image/png');
    const failure = resizeToWebp(new Blob(['x']), { codec: codecFor(fake) });
    await expect(failure).rejects.toBeInstanceOf(WebpUnsupportedError);
    await expect(failure).rejects.toThrow('neither the canvas nor the WebP wasm encoder produced a WebP image');
    expect(wasmEncode).toHaveBeenCalledTimes(1);
  });

  it('[T-app-169] the encodeWithin quality step-down works through the fallback', async () => {
    const big = new Uint8Array(MAX_BYTES + 1).buffer;
    wasmEncode.mockResolvedValueOnce(big).mockResolvedValueOnce(big).mockResolvedValueOnce(WASM_BYTES);
    const fake = fakeCanvas('image/png');
    const codec = codecFor(fake);
    const raster: Raster = { data: new Uint8ClampedArray(16), width: 2, height: 2 };
    const blob = await encodeWithin((quality) => codec.encodeRaster(raster, quality));
    expect(blob.size).toBe(WASM_BYTES.byteLength);
    expect(wasmEncode.mock.calls.map((c) => (c[1] as { quality: number }).quality)).toEqual([85, 70, 55]);
  });

  it('[T-app-170] cropCircle with a PNG-only canvas codec still yields a WebP cap photo', async () => {
    const fake = fakeCanvas('image/png', 8, 8);
    const codec = codecFor(fake);
    const image = await codec.decode(new Blob(['x']));
    const photo = await cropCircle({ image, codec }, { cx: 2, cy: 2, r: 2, uncertain: false }, 1);
    expect(photo.blob.type).toBe('image/webp');
    expect(photo.dhash).toMatch(/^[0-9a-f]{16}$/);
    expect(wasmEncode).toHaveBeenCalledTimes(1);
    // The masked circle (transparent corners) is what wasm encodes.
    const encoded = wasmEncode.mock.calls[0]?.[0] as ImageData;
    expect(encoded.data[3]).toBe(0);
  });
});
