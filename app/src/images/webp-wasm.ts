// WebP encoder fallback (ADR-010 §1, CAP-88): WebKit (Safari, WKWebView in the iPhone app) cannot encode WebP from a
// canvas — `toBlob('image/webp')` silently returns a PNG — so the same RGBA pixels are encoded with libwebp compiled to
// WebAssembly (`@jsquash/webp`). Only the encoder entry is imported (the decoder wasm stays out), and only on first
// need through a dynamic import: Vite emits it and its `webp_enc*.wasm` as separate assets, so Chrome and Firefox never
// download them. Capacitor serves them from the app bundle (offline).
import type { Raster } from './resize.js';

const WEBP = 'image/webp';

/** Encode `raster` (RGBA) as WebP at `quality` 0–1 (libwebp takes 0–100); rejects when the wasm encoder fails. */
export async function encodeWebpWasm(raster: Raster, quality: number): Promise<Blob> {
  const { default: encode } = await import('@jsquash/webp/encode');
  // The encoder reads only `data`, `width` and `height` of the ImageData it is given.
  const image = { data: raster.data, width: raster.width, height: raster.height } as ImageData;
  const buffer = await encode(image, { quality: Math.round(Math.min(1, Math.max(0, quality)) * 100) });
  return new Blob([buffer], { type: WEBP });
}
