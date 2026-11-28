// Multi-import fixture (CAP-121): a small synthetic zip like the one an external AI returns (exchange.md § Multi-import)
// — six `<brand>_<variant>.png` cut-outs (48 px RGBA, a cap disc on a transparent margin, each with its own pattern)
// and a `.json` `response` of the same name. Synthetic on purpose: never the owner's photos. Also the tiny PNG
// encoder / decoder the tests' fake codec uses (8-bit RGBA, filter 0, no interlace: exactly what `pngRgba` writes).
// Regenerate the committed zip after an intended change with:
//
//   npx tsx app/test/fixtures/multi-import/make.ts
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

import { strToU8, zipSync } from 'fflate';

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(strToU8(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An 8-bit RGBA PNG of `size` × `size` from `pixel(x, y)` → [r, g, b, a]. */
export function pngRgba(size: number, pixel: (x: number, y: number) => readonly number[]): Uint8Array {
  const raw = new Uint8Array(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) raw.set(pixel(x, y), y * (size * 4 + 1) + 1 + x * 4);
  }
  const header = new Uint8Array(13);
  const view = new DataView(header.buffer);
  view.setUint32(0, size);
  view.setUint32(4, size);
  header.set([8, 6, 0, 0, 0], 8);
  const parts = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', new Uint8Array(deflateSync(raw))),
    chunk('IEND', new Uint8Array(0)),
  ];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

/** RGBA pixels of a PNG written by `pngRgba` (filter 0 rows only). */
export function decodePng(bytes: Uint8Array): { data: Uint8ClampedArray; width: number; height: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const idat: Uint8Array[] = [];
  for (let at = 8; at < bytes.length;) {
    const length = view.getUint32(at);
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (type === 'IDAT') idat.push(bytes.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const data = new Uint8ClampedArray(width * height * 4);
  for (let y = 0; y < height; y++)
    data.set(raw.subarray(y * (width * 4 + 1) + 1, (y + 1) * (width * 4 + 1)), y * width * 4);
  return { data, width, height };
}

export const SIZE = 48;

/** A cap disc (≈ 7 % transparent margin, as the prompt asks) with pattern `n`: distinct dHashes per `n`. */
export function capPng(n: number, size = SIZE): Uint8Array {
  const r = size * 0.43;
  return pngRgba(size, (x, y) => {
    const dx = x + 0.5 - size / 2;
    const dy = y + 0.5 - size / 2;
    if (dx * dx + dy * dy > r * r) return [0, 0, 0, 0];
    const u = x / size;
    const v = y / size;
    const level = 128 + 110 * Math.sin((u * (n + 2) + v * ((n * 3) % 5)) * Math.PI * 2);
    return [level, (level * (n + 1)) % 256, 255 - level, 255];
  });
}

const answer = (fields: Record<string, unknown>, notes: string | null = null) => ({
  provider: 'Anthropic',
  model: 'claude-test-model',
  fields: {
    brand: null,
    variant: null,
    producer: null,
    country: null,
    type: 'beer',
    material: null,
    closure: null,
    year: null,
    description: null,
    textOnCap: null,
    ...fields,
  },
  confidence: { brand: 0.9, variant: 0.6, year: null },
  notes,
});

/** The six pairs, in zip order: base name, pattern, `response`. */
export const PAIRS = [
  ['Grimbergen_Double-Ambree', 1, answer({ brand: 'Grimbergen', variant: 'Double Ambrée', country: 'BE' }, 'Red rim')],
  ['La-Cibeles', 2, answer({ brand: 'La Cibeles', country: 'ES', year: 2019 })],
  ['Mahou_Clasica', 3, answer({ brand: 'Mahou', variant: 'Clásica', country: 'Spain' })],
  ['Estrella-Galicia', 4, answer({ brand: 'Estrella Galicia', material: 'aluminium', closure: 'twist-off' })],
  ['Unknown', 5, answer({ type: null })],
  ['Daura_Marzen', 6, answer({ brand: 'Daura', variant: 'Märzen', producer: 'Damm' })],
] as const;

export function buildZip(): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const [name, n, response] of PAIRS) {
    files[`${name}.png`] = capPng(n);
    files[`${name}.json`] = strToU8(JSON.stringify(response, null, 2));
  }
  return zipSync(files);
}

export const ZIP_PATH = join(dirname(fileURLToPath(import.meta.url)), 'multi-import.zip');

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) writeFileSync(ZIP_PATH, buildZip());
