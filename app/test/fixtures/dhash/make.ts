// dHash fixtures (CAP-36): synthetic cap photos built from hand-made pixel functions (no image library is available,
// story § Fixtures). Each cap is a design evaluated at pixel centres, so the same cap can be rendered at any size
// (1024 vs 512 px for the resize-stability test) and under another light (gain, offset, gamma, a side light and
// seeded sensor noise). `expected.json` holds the hashes of the four fixtures; regenerate it after an intended
// algorithm change with:
//
//   npx tsx -e "import('./app/test/fixtures/dhash/make.ts').then((m) => console.log(JSON.stringify(m.expectedHashes(), null, 2)))" > app/test/fixtures/dhash/expected.json
import { dhash } from '../../../src/images/dhash';
import { maskCircle, type Raster } from '../../../src/images/resize';

/** RGB in 0…255 at normalised coordinates (u, v) ∈ [0, 1)². */
type Design = (u: number, v: number) => readonly [number, number, number];

export interface Light {
  readonly gain: number;
  readonly offset: number;
  readonly gamma: number;
  /** Extra brightness from the left (negative) to the right (positive) edge, as a fraction. */
  readonly side: number;
  /** Peak-to-peak sensor noise in levels, from a seeded generator. */
  readonly noise: number;
  readonly seed: number;
}

export const DAYLIGHT: Light = { gain: 1, offset: 0, gamma: 1, side: 0, noise: 4, seed: 1 };
/** Warmer, darker, lower-contrast lamp from the right. */
export const LAMP: Light = { gain: 0.78, offset: 22, gamma: 1.12, side: 0.04, noise: 8, seed: 7 };

const ring = (u: number, v: number) => Math.hypot(u - 0.5, v - 0.5);

/** Red crown cap: dark rim, light disc, a white horizontal band with a darker "logo" blob on its left. */
const redBand: Design = (u, v) => {
  const r = ring(u, v);
  if (r > 0.44) return [90, 20, 25];
  if (Math.abs(v - 0.5) < 0.1) return Math.hypot(u - 0.32, v - 0.5) < 0.08 ? [60, 30, 40] : [235, 230, 220];
  return [200 - 120 * r, 40, 45];
};

/** Blue cap: bright on the left fading to dark on the right, with a yellow spot bottom-left. */
const blueDiagonal: Design = (u, v) => {
  if (ring(u, v) > 0.44) return [20, 30, 80];
  if (Math.hypot(u - 0.3, v - 0.68) < 0.11) return [240, 210, 40];
  const t = 1 - (u * 0.8 + v * 0.2);
  return [20 + 120 * t, 50 + 150 * t, 120 + 120 * t];
};

/** Green cap with concentric rings and a vertical dark bar. */
const greenRings: Design = (u, v) => {
  const r = ring(u, v);
  if (r > 0.44) return [10, 60, 20];
  if (Math.abs(u - 0.6) < 0.05) return [20, 40, 20];
  return Math.floor(r * 14) % 2 === 0 ? [60, 170, 70] : [150, 220, 140];
};

export const DESIGNS = { redBand, blueDiagonal, greenRings } as const;

/** Small deterministic PRNG (mulberry32), so the noise is the same on every run. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** `design` rendered at `size` × `size` under `light`, opaque RGBA. */
export function renderCap(design: Design, size: number, light: Light = DAYLIGHT): Raster {
  const data = new Uint8ClampedArray(size * size * 4);
  const random = prng(light.seed);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const u = (x + 0.5) / size;
      const v = (y + 0.5) / size;
      const lit = 1 + light.side * (2 * u - 1);
      const rgb = design(u, v);
      const p = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const level = 255 * ((light.gain * (rgb[c] ?? 0) * lit + light.offset) / 255) ** light.gamma;
        data[p + c] = level + (random() - 0.5) * light.noise;
      }
      data[p + 3] = 255;
    }
  }
  return { data, width: size, height: size };
}

/** The four fixture photos: the same cap under two lights, and two different caps. Circular, as the app crops them. */
export const FIXTURES = {
  'red-band-daylight': () => maskCircle(renderCap(redBand, 64, DAYLIGHT)),
  'red-band-lamp': () => maskCircle(renderCap(redBand, 64, LAMP)),
  'blue-diagonal': () => maskCircle(renderCap(blueDiagonal, 64, DAYLIGHT)),
  'green-rings': () => maskCircle(renderCap(greenRings, 64, LAMP)),
} as const;

export type FixtureName = keyof typeof FIXTURES;

export function expectedHashes(): Record<FixtureName, string> {
  const out = {} as Record<FixtureName, string>;
  for (const name of Object.keys(FIXTURES) as FixtureName[]) out[name] = dhash(FIXTURES[name]());
  return out;
}
