// Renders the iOS icon and launch images (CAP-56), the web favicon / apple-touch-icon (CAP-74) and the Android
// adaptive icon (CAP-112) from the SVG sources in app/design (copies of doc/spec/design/brand/):
// `npx tsx app/design/render.ts` from the repo root, after editing an SVG; the outputs are committed. Needs
// `rsvg-convert` (brew install librsvg).
// App Store Connect rejects an icon with an alpha channel: rsvg writes 8-bit RGB for an opaque drawing, and any RGBA
// output (other librsvg versions) is re-encoded here as 8-bit RGB (colour type 2). Node built-ins only (no new
// dependency).
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

function rasterise(source: { file: string } | { svg: string }, size?: number): Buffer {
  const sizeArgs = size === undefined ? [] : ['--width', String(size), '--height', String(size)];
  return 'file' in source
    ? execFileSync('rsvg-convert', ['--format', 'png', ...sizeArgs, join(here, source.file)])
    : execFileSync('rsvg-convert', ['--format', 'png', ...sizeArgs], { input: source.svg });
}

function render(svg: string, out: string, size?: number): void {
  writeFileSync(out, rgbaToRgb(rasterise({ file: svg }, size)));
}

const publicDir = join(here, '..', 'public');

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

// Web (CAP-74, brand README: icon-light for favicon / web app icon): SVG favicon plus 32 px PNG and 180 px
// apple-touch-icon, all served from app/public and linked by index.html.
copyFileSync(join(here, 'icon-light.svg'), join(publicDir, 'favicon.svg'));
render('icon-light.svg', join(publicDir, 'favicon-32.png'), 32);
render('icon-light.svg', join(publicDir, 'apple-touch-icon.png'), 180);

// ── Android (CAP-112, ADR-011 §4) ──
// Adaptive icon: the ink background as a colour, the copper cap as a vector foreground (the icon.svg paths, scaled into
// the 66 dp safe zone of the 108 dp canvas) and a white monochrome layer for themed icons; legacy square and round
// PNGs for launchers older than API 26. The splash is the ground colour (values/colors.xml), drawn by the theme.
const res = join(here, '..', 'android', 'app', 'src', 'main', 'res');

/** Path data, ring and centre of icon.svg: the single source of the cap's shape. */
function capShape(svg: string): { cap: string; ring: number; centre: number; stops: [string, string] } {
  const cap = /<path d="([^"]+)" fill="url\(#g\)"\/>/.exec(svg)?.[1];
  const ring = /<circle cx="512" cy="512" r="(\d+)" fill="none"/.exec(svg)?.[1];
  const centre = /<circle cx="512" cy="512" r="(\d+)" fill="#FAFAF7"/.exec(svg)?.[1];
  const stops = [...svg.matchAll(/stop-color="(#[0-9A-Fa-f]{6})"/g)].map((m) => m[1]);
  if (!cap || !ring || !centre || stops.length !== 2) throw new Error('icon.svg no longer has the expected shapes');
  return { cap, ring: Number(ring), centre: Number(centre), stops: [stops[0] ?? '', stops[1] ?? ''] };
}

/** A circle as vector path data (VectorDrawable has no <circle>). */
const circle = (r: number) =>
  `M${String(512 - r)},512a${String(r)},${String(r)} 0,1 0,${String(2 * r)},0a${String(r)},${String(r)} 0,1 0,${String(-2 * r)},0Z`;

/** Scale of the 1024 viewport inside the 108 dp canvas so the cap (≈ 736 px wide) fits the 66 dp safe circle. */
const FOREGROUND_SCALE = 0.8;

function foregroundVector(svg: string): string {
  const { cap, ring, centre, stops } = capShape(svg);
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by app/design/render.ts from app/design/icon.svg (CAP-112): the copper cap, foreground of the adaptive icon. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    xmlns:aapt="http://schemas.android.com/aapt"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">
    <group android:pivotX="512" android:pivotY="512" android:scaleX="${String(FOREGROUND_SCALE)}" android:scaleY="${String(FOREGROUND_SCALE)}">
        <path android:pathData="${cap}">
            <aapt:attr name="android:fillColor">
                <gradient android:type="radial" android:centerX="409.6" android:centerY="358.4" android:gradientRadius="768">
                    <item android:offset="0" android:color="${stops[0]}" />
                    <item android:offset="1" android:color="${stops[1]}" />
                </gradient>
            </aapt:attr>
        </path>
        <path android:pathData="${circle(ring)}" android:strokeColor="#8CF3D9B8" android:strokeWidth="14" />
        <path android:pathData="${circle(centre)}" android:fillColor="#FAFAF7" />
    </group>
</vector>
`;
}

function monochromeVector(svg: string): string {
  const { cap, centre } = capShape(svg);
  return `<?xml version="1.0" encoding="utf-8"?>
<!-- Generated by app/design/render.ts from app/design/icon.svg (CAP-112): the cap's silhouette for themed icons. -->
<vector xmlns:android="http://schemas.android.com/apk/res/android"
    android:width="108dp"
    android:height="108dp"
    android:viewportWidth="1024"
    android:viewportHeight="1024">
    <group android:pivotX="512" android:pivotY="512" android:scaleX="${String(FOREGROUND_SCALE)}" android:scaleY="${String(FOREGROUND_SCALE)}">
        <path android:fillType="evenOdd" android:fillColor="#FFFFFFFF" android:pathData="${cap}${circle(centre)}" />
    </group>
</vector>
`;
}

/** Legacy launcher sizes (48 dp) per density. */
const LEGACY = { mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 } as const;

function writeAndroidIcons(svg: string): void {
  mkdirSync(join(res, 'drawable'), { recursive: true });
  writeFileSync(join(res, 'drawable', 'ic_launcher_foreground.xml'), foregroundVector(svg));
  writeFileSync(join(res, 'drawable', 'ic_launcher_monochrome.xml'), monochromeVector(svg));
  // The round legacy icon: the same drawing on an ink disc instead of the square.
  const round = svg.replace(
    '<rect width="1024" height="1024" fill="#1B1A17"/>',
    '<circle cx="512" cy="512" r="512" fill="#1B1A17"/>',
  );
  for (const [density, size] of Object.entries(LEGACY)) {
    const dir = join(res, `mipmap-${density}`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'ic_launcher.png'), rgbaToRgb(rasterise({ file: 'icon.svg' }, size)));
    writeFileSync(join(dir, 'ic_launcher_round.png'), rasterise({ svg: round }, size));
  }
}

writeAndroidIcons(readFileSync(join(here, 'icon.svg'), 'utf8'));
