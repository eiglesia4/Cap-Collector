// Brand assets on the web (CAP-74, doc/spec/design/brand/README.md): index.html links the SVG favicon, the 32 px PNG
// favicon and the 180 px apple-touch-icon; the files sit in app/public (copied verbatim into dist/ by Vite) and come
// from icon-light, the variant for favicons. PNG sizes and colour types are read from the IHDR chunk.
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC_BRAND = join(APP, '..', 'doc', 'spec', 'design', 'brand');

function ihdr(path: string) {
  const png = readFileSync(path);
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colourType: png[25] };
}

describe('web brand icons', () => {
  it('[T-app-126] index.html links the favicon (SVG + 32 px) and the apple-touch-icon; the files exist in public/ and come from icon-light', () => {
    const doc = new DOMParser().parseFromString(readFileSync(join(APP, 'index.html'), 'utf8'), 'text/html');
    const links = [...doc.querySelectorAll('link[rel="icon"], link[rel="apple-touch-icon"]')].map((l) => ({
      rel: l.getAttribute('rel'),
      href: l.getAttribute('href'),
      sizes: l.getAttribute('sizes'),
    }));
    expect(links).toEqual([
      { rel: 'icon', href: '/favicon.svg', sizes: null },
      { rel: 'icon', href: '/favicon-32.png', sizes: '32x32' },
      { rel: 'apple-touch-icon', href: '/apple-touch-icon.png', sizes: '180x180' },
    ]);
    for (const { href } of links) expect(existsSync(join(APP, 'public', href ?? '')), href ?? '').toBe(true);

    expect(readFileSync(join(APP, 'public', 'favicon.svg'), 'utf8')).toBe(
      readFileSync(join(SPEC_BRAND, 'icon-light.svg'), 'utf8'),
    );
    // Opaque RGB PNGs (iOS fills transparency of a touch icon with black).
    expect(ihdr(join(APP, 'public', 'favicon-32.png'))).toEqual({ width: 32, height: 32, colourType: 2 });
    expect(ihdr(join(APP, 'public', 'apple-touch-icon.png'))).toEqual({ width: 180, height: 180, colourType: 2 });
  });
});
