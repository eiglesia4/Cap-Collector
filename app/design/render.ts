// Renders the iOS icon and launch images from the SVG sources in app/design (CAP-56): `npx tsx app/design/render.ts`
// from the repo root, after editing an SVG; the PNGs are committed. Needs `rsvg-convert` (brew install librsvg).
// App Store Connect rejects an icon with an alpha channel: rsvg writes 8-bit RGB for an opaque drawing, and any RGBA
// output (other librsvg versions) is re-encoded here as 8-bit RGB (colour type 2). Node built-ins only (no new
// dependency).
import { execFileSync } from 'node:child_process';
import { copyFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const here = dirname(fileURLToPath(import.meta.url));
const assets = join(here, '..', 'ios', 'App', 'App', 'Assets.xcassets');

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let c = 0xffffffff;
  for (const byte of data) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, crc]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 8-bit PNG → 8-bit RGB PNG: RGB passes through, RGBA has its alpha dropped (the sources are fully opaque). */
export function rgbaToRgb(png: Buffer): Buffer {
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (png[24] === 8 && png[25] === 2) return png;
  if (png[24] !== 8 || png[25] !== 6) throw new Error('expected an 8-bit RGB or RGBA PNG');
  const idat: Buffer[] = [];
  for (let at = 8; at < png.length;) {
    const length = png.readUInt32BE(at);
    const type = png.toString('latin1', at + 4, at + 8);
    if (type === 'IDAT') idat.push(png.subarray(at + 8, at + 8 + length));
    at += 12 + length;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * 4;
  const rgba = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= 4 ? (rgba[y * stride + x - 4] ?? 0) : 0;
      const b = y > 0 ? (rgba[(y - 1) * stride + x] ?? 0) : 0;
      const c = x >= 4 && y > 0 ? (rgba[(y - 1) * stride + x - 4] ?? 0) : 0;
      const v = line[x] ?? 0;
      const out =
        filter === 0
          ? v
          : filter === 1
            ? v + a
            : filter === 2
              ? v + b
              : filter === 3
                ? v + ((a + b) >> 1)
                : v + paeth(a, b, c);
      rgba[y * stride + x] = out & 0xff;
    }
  }
  const rgb = Buffer.alloc(height * (width * 3 + 1));
  for (let y = 0; y < height; y++) {
    const row = y * (width * 3 + 1);
    rgb[row] = 0;
    for (let x = 0; x < width; x++) {
      for (let k = 0; k < 3; k++) rgb[row + 1 + x * 3 + k] = rgba[y * stride + x * 4 + k] ?? 0;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rgb, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function render(svg: string, out: string): void {
  const png = execFileSync('rsvg-convert', ['--format', 'png', join(here, svg)]);
  writeFileSync(out, rgbaToRgb(png));
}

const icon = join(assets, 'AppIcon.appiconset', 'AppIcon-1024.png');
render('icon.svg', icon);
for (const [svg, base] of [
  ['splash.svg', 'splash-2732x2732'],
  ['splash-dark.svg', 'splash-dark-2732x2732'],
] as const) {
  const first = join(assets, 'Splash.imageset', `${base}.png`);
  render(svg, first);
  // One 2732² image serves every scale (the Capacitor template's layout: `<name>.png`, `-1` and `-2`).
  for (const suffix of ['-1', '-2']) copyFileSync(first, join(assets, 'Splash.imageset', `${base}${suffix}.png`));
}
