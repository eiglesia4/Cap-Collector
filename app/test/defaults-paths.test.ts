// One set of "defaults when unsure" for every capture path (CAP-124; features.md § Defaults when unsure and § Place
// from GPS; exchange.md § Multi-import step 8): `newCapDefaults` itself, then the same empty fields through the
// built-in AI review, the single exchange review, Manual entry and multi-import, which must all end with the same
// values; editing an existing cap (and an exchange answer for one) gets none.
import { Cap, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import type { CaptureSession } from '../src/capture/context';
import { newCapDefaults } from '../src/capture/defaults';
import { LAST_PLACE_KEY } from '../src/capture/place';
import { EMPTY_VALUES } from '../src/cap/form-model';
import type { AppContext } from '../src/context';
import { runImport, type ImportRow } from '../src/exchange/multi-import';
import type { CapPhoto, Raster, RasterCodec } from '../src/images/resize';
import { CapForm, type CapFormOptions } from '../src/screens/cap-form-screen';
import { resampleRaster } from '../src/vision/crop';
import { capPng, decodePng } from './fixtures/multi-import/make';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const NOW = new Date(2026, 10, 28, 10, 30);
const SCAN_ID = ulid(61);
const ref: ImageRef = { key: `u1/${SCAN_ID}/top.webp`, width: 1024, height: 1024, bytes: 900 };
const photo: CapPhoto = {
  blob: new Blob([new Uint8Array(9)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash: 'f0f0f03030f0f0f0',
};
/** What the AI (or the user) gave: year, type, material, closure and place are empty. */
const GIVEN = { brand: 'Marca', producer: 'Cervecera X' };
/** What every path must end with for those empty fields. */
const EXPECTED = {
  acquiredOn: '2026-11-28',
  year: '2026',
  type: 'beer',
  material: 'steel',
  closure: 'pry-off',
  acquiredWhere: 'Segovia',
};

afterEach(() => document.body.replaceChildren());

async function context(): Promise<AppContext> {
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const parsed = opts.schema.safeParse(path.startsWith('/caps?') ? { items: [] } : undefined);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform('web');
  await platform.store.set(LAST_PLACE_KEY, 'Segovia');
  return {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
    now: () => NOW,
  };
}

/** The values a form shows for the defaulted fields, once the place has arrived. */
async function formValues(options: CapFormOptions): Promise<Record<string, string>> {
  const el = CapForm(await context(), options);
  document.body.replaceChildren(el);
  for (let i = 0; i < 6; i++) await flush();
  const value = (name: string) => el.querySelector<HTMLInputElement | HTMLSelectElement>(`#cap-${name}`)?.value ?? '';
  return Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, value(k)]));
}

const identified = (exchange?: CaptureSession['exchange']): CaptureSession => ({
  scanId: SCAN_ID,
  useAi: !exchange,
  top: { photo, ref },
  response: { scanId: SCAN_ID, outcome: 'identified', fields: { ...GIVEN }, suggestions: [] } as AnalyseResponse,
  ...(exchange ? { exchange } : {}),
});

/** Multi-import's saved body for the same fields, through `runImport` with stubbed effects. */
async function importedValues(): Promise<Record<string, string>> {
  const posts: Record<string, unknown>[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    let answer: unknown;
    if (path === '/scans/analyse') answer = { scanId: SCAN_ID, outcome: 'unidentified', suggestions: [] };
    else if (path.startsWith('/caps?')) answer = { items: [] };
    else if (path === '/caps') {
      posts.push(opts.body as Record<string, unknown>);
      answer = wireCap(70, opts.body as Record<string, unknown>);
    }
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const codec: RasterCodec = {
    decode: async (blob) => {
      const raster = decodePng(new Uint8Array(await blob.arrayBuffer()));
      return { source: raster as unknown as CanvasImageSource, width: raster.width, height: raster.height };
    },
    raster: async (image, crop, w, h) => resampleRaster(image.source as unknown as Raster, crop, w, h),
    encodeRaster: async () => new Blob([new Uint8Array(8)], { type: 'image/webp' }),
    encode: async () => null,
  };
  const row: ImportRow = {
    name: 'Marca',
    status: 'pending',
    image: new Blob([capPng(1) as BlobPart], { type: 'image/png' }),
    json: { value: { provider: 'Anthropic', model: 'm', fields: { ...GIVEN }, confidence: {}, notes: null } },
  };
  await runImport(
    [row],
    {
      api: { request: request as ApiClient['request'] },
      upload: async () => ref,
      codec,
      newId: () => ulid(62),
      now: () => NOW,
      place: Promise.resolve('Segovia'),
      possibleDuplicateNote: () => '',
    },
    { cancelled: () => false, onProgress: () => undefined },
  );
  const body = posts[0] ?? {};
  return Object.fromEntries(Object.keys(EXPECTED).map((k) => [k, body[k] === undefined ? '' : String(body[k])]));
}

describe('defaults when unsure on every capture path (CAP-124)', () => {
  it('[T-app-258] newCapDefaults fills each empty field with its mark, keeps given values, and guesses the type from the text', () => {
    const all = newCapDefaults({}, { now: NOW, text: 'Cervecera X', place: 'Segovia' });
    expect(all.values).toEqual({
      acquiredOn: '2026-11-28',
      year: 2026,
      type: 'beer',
      material: 'steel',
      closure: 'pry-off',
      acquiredWhere: 'Segovia',
    });
    expect([...all.marks]).toEqual([
      ['year', 'default'],
      ['type', 'guessed'],
      ['material', 'default'],
      ['closure', 'default'],
      ['acquiredWhere', 'default'],
    ]);
    expect(all.filled).toEqual(['acquiredOn', 'year', 'type', 'material', 'closure', 'acquiredWhere']);
    // Given values are never replaced; no place and no match leave those empty.
    const given = newCapDefaults(
      {
        year: 1990,
        type: 'cider',
        material: 'aluminium',
        closure: 'twist-off',
        acquiredOn: '2020-01-01',
        acquiredWhere: 'Madrid',
      },
      { now: NOW, text: 'Cervecera X', place: 'Segovia' },
    );
    expect(given.values).toEqual({});
    expect(given.filled).toEqual([]);
    const bare = newCapDefaults({}, { now: NOW, text: 'Zeta', place: null });
    expect(bare.values).not.toHaveProperty('type');
    expect(bare.values).not.toHaveProperty('acquiredWhere');
  });

  it('[T-app-259] the same empty fields end with the same values on every path: built-in AI, single exchange, Manual entry, multi-import', async () => {
    const paths: [string, () => Promise<Record<string, string>>][] = [
      ['built-in AI review', () => formValues({ mode: 'ai-prefilled', scan: identified() })],
      [
        'single exchange review',
        () => formValues({ mode: 'ai-prefilled', scan: identified({ source: 'external:gemini' }) }),
      ],
      ['manual entry', () => formValues({ mode: 'empty', prefill: { ...EMPTY_VALUES, tags: [], ...GIVEN } })],
      ['multi-import', importedValues],
    ];
    for (const [name, run] of paths) expect([name, await run()]).toEqual([name, EXPECTED]);
  });

  it('[T-app-260] editing an existing cap, and an exchange answer for one, get no defaults (regression)', async () => {
    const cap = Cap.parse(wireCap(5, { brand: 'Marca', producer: 'Cervecera X' }));
    for (const options of [
      { mode: 'edit', cap },
      { mode: 'edit', cap, ai: { suggestions: [], source: 'external:gemini', notes: 'AI notes' } },
    ] as CapFormOptions[]) {
      const values = await formValues(options);
      expect(values).toEqual({ acquiredOn: '', year: '', type: '', material: '', closure: '', acquiredWhere: '' });
      expect(document.querySelector('.field--default, .field--guessed')).toBeNull();
    }
  });
});
