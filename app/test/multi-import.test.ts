// Multi-import from an external AI (CAP-121; ADR-012; exchange.md § Multi-import; SCREENS.md § Multi-import): the ask
// step (prompt by UI language, empty template), pairing and limits, the per-pair run (in-zip guard, dHash against the
// collection with `useAi: false`, brand + variant flag, the saved body), the flattening of a transparent cut-out before
// the dHash, the summary, cancel and retry. The fixture is the synthetic zip of fixtures/multi-import/ (never the
// owner's photos); images go through a fake codec that decodes those PNGs and resamples them like the canvas.
import { readFileSync } from 'node:fs';

import {
  AnalyseRequest,
  CapInput,
  MULTI_IMPORT_LIMITS,
  MULTI_IMPORT_TEMPLATE,
  multiImportInstructions,
} from '@capcollector/shared';
import { strToU8, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { LAST_PLACE_KEY } from '../src/capture/place';
import type { AppContext } from '../src/context';
import { readUpload } from '../src/exchange/answer';
import { checkPairs, checkSize, flatten, importSource, pairUploads, prepareImage } from '../src/exchange/multi-import';
import { setLanguage, t } from '../src/i18n/i18n';
import { dhash } from '../src/images/dhash';
import { inscribedSquare, type Raster, type RasterCodec } from '../src/images/resize';
import { ExchangeView } from '../src/screens/exchange-screen';
import { resampleRaster } from '../src/vision/crop';
import { capPng, decodePng, PAIRS, ZIP_PATH } from './fixtures/multi-import/make';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const NOW = new Date('2026-11-28T10:00:00.000Z');
const zipFile = (bytes: Uint8Array = readFileSync(ZIP_PATH), name = 'caps.zip') =>
  new File([bytes as BlobPart], name, { type: 'application/zip' });

/** Decodes the fixture PNGs and resamples like the canvas; records what it encodes. */
function pngCodec() {
  const encoded: Raster[] = [];
  const codec: RasterCodec & { decodes: number } = {
    decodes: 0,
    async decode(blob) {
      codec.decodes += 1;
      const raster = decodePng(new Uint8Array(await blob.arrayBuffer()));
      return { source: raster as unknown as CanvasImageSource, width: raster.width, height: raster.height };
    },
    async raster(image, crop, width, height) {
      return resampleRaster(image.source as unknown as Raster, crop, width, height);
    },
    async encodeRaster(raster) {
      encoded.push(raster);
      return new Blob([new Uint8Array(64)], { type: 'image/webp' });
    },
    encode: async () => null,
  };
  return { codec, encoded };
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** The Import screen with a fake API: `dupBrand` is "already in collection" by dHash; `stored` answers ?brand=. */
async function setup(
  options: { dupBrand?: string; stored?: Record<string, unknown>[]; failCapsFor?: string; noPlace?: boolean } = {},
) {
  const calls: Call[] = [];
  let saved = 100;
  const answer = (path: string, method: string, body: unknown): unknown => {
    if (path === '/exchange/requests') return [];
    if (path === '/uploads') {
      return { key: `u1/${ulid(saved)}/top.webp`, url: 'https://s3.test/put', expiresAt: '2030-01-01T00:00:00.000Z' };
    }
    if (path === '/scans/analyse') {
      const req = body as AnalyseRequest;
      return options.dupBrand !== undefined && req.known?.brand === options.dupBrand
        ? {
            scanId: req.scanId,
            outcome: 'duplicate',
            match: { capId: ulid(7), hammingDistance: 2, by: 'dhash' },
            suggestions: [],
          }
        : { scanId: req.scanId, outcome: 'unidentified', suggestions: [] };
    }
    if (path.startsWith('/caps?')) return { items: options.stored ?? [] };
    if (path === '/caps' && method === 'POST') {
      if ((body as { brand: string }).brand === options.failCapsFor) return new Error('500');
      return wireCap((saved += 1), body as Record<string, unknown>);
    }
    return undefined;
  };
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    const value = answer(path, method, opts.body);
    if (value instanceof Error) throw value;
    const parsed = opts.schema.safeParse(value);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform('web');
  if (!options.noPlace) await platform.store.set(LAST_PLACE_KEY, 'Segovia');
  const ctx: AppContext = {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  const { codec, encoded } = pngCodec();
  const copies: string[] = [];
  let ids = 0;
  const el = ExchangeView(
    ctx,
    {},
    {
      codec,
      newId: () => ulid(500 + (ids += 1)),
      now: () => NOW,
      put: async () => new Response(null, { status: 200 }),
      copy: async (text) => {
        copies.push(text);
        return true;
      },
    },
  );
  document.body.replaceChildren(el);
  await flush();
  const upload = async (files: File[]) => {
    vi.mocked(platform.pickFiles).mockResolvedValueOnce(files);
    el.querySelector<HTMLButtonElement>('[data-action="pick-zip"]')?.click();
    await vi.waitFor(() => expect(el.querySelector<HTMLElement>('[data-multi="summary"]')?.hidden).toBe(false));
  };
  const posts = () => calls.filter((c) => c.path === '/caps' && c.method === 'POST');
  const row = (name: string) => el.querySelector<HTMLElement>(`[data-row="${name}"]`);
  return { el, calls, posts, row, upload, codec, encoded, copies, platform };
}

afterEach(() => {
  setLanguage('en');
  document.body.replaceChildren();
});

describe('multi-import pairing and limits (CAP-121)', () => {
  it('[T-exchange-001] pairs image and JSON by base name, case-insensitively; orphans, clashes and __MACOSX are handled', async () => {
    const six = await readUpload([zipFile()]);
    expect(pairUploads(six).map((r) => [r.name, r.status])).toEqual(PAIRS.map(([name]) => [name, 'pending']));

    const zip = zipSync({
      'caps/One.PNG': capPng(1),
      'caps/one.json': strToU8('{"fields":{"brand":"One"}}'),
      'Two.webp': capPng(2),
      'Three.json': strToU8('{}'),
      '__MACOSX/caps/._One.PNG': capPng(9),
      '.DS_Store': strToU8('x'),
      'Four.jpg': capPng(4),
      'Four.jpeg': capPng(5),
      'Four.json': strToU8('{}'),
      'Five.json': strToU8('{ not json'),
      'Five.png': capPng(6),
      'notes.txt': strToU8('ignored'),
    });
    const rows = pairUploads(await readUpload([zipFile(zip)]));
    const byName = Object.fromEntries(rows.map((r) => [r.name, [r.status, r.reason]]));
    expect(byName).toEqual({
      One: ['pending', undefined],
      Two: ['failed', 'noJson'],
      Three: ['failed', 'noImage'],
      Four: ['failed', 'duplicateName'],
      Five: ['pending', undefined], // read as invalid JSON when it runs
    });
    expect(rows.find((r) => r.name === 'Five')?.json).toBe('invalid');
  });

  it('[T-exchange-002] an upload over maxZipBytes or with more than maxCaps pairs is refused before any image is decoded', async () => {
    const big = new File([new Uint8Array(8)], 'big.zip', { type: 'application/zip' });
    Object.defineProperty(big, 'size', { value: MULTI_IMPORT_LIMITS.maxZipBytes + 1 });
    expect(checkSize([big])).toEqual({ kind: 'tooBig', bytes: MULTI_IMPORT_LIMITS.maxZipBytes + 1 });
    expect(checkSize([zipFile()])).toBeNull();

    const files: Record<string, Uint8Array> = {};
    for (let i = 0; i <= MULTI_IMPORT_LIMITS.maxCaps; i++) {
      files[`cap-${i}.png`] = capPng(1, 8);
      files[`cap-${i}.json`] = strToU8('{}');
    }
    const rows = pairUploads(await readUpload([zipFile(zipSync(files))]));
    expect(checkPairs(rows)).toEqual({ kind: 'tooManyPairs', pairs: MULTI_IMPORT_LIMITS.maxCaps + 1 });
    expect(checkPairs([])).toEqual({ kind: 'empty' });

    // Through the screen: the refusal is shown and nothing is decoded or sent.
    const env = await setup();
    vi.mocked(env.platform.pickFiles).mockResolvedValueOnce([zipFile(zipSync(files))]);
    env.el.querySelector<HTMLButtonElement>('[data-action="pick-zip"]')?.click();
    await vi.waitFor(() =>
      expect(env.el.querySelector('[data-status="multi"]')?.textContent).toBe(
        t('exchange.multi.tooMany', { count: '51', max: '50' }),
      ),
    );
    expect(env.el.querySelector('[data-status="multi"]')?.getAttribute('role')).toBe('alert');
    vi.mocked(env.platform.pickFiles).mockResolvedValueOnce([big]);
    env.el.querySelector<HTMLButtonElement>('[data-action="pick-zip"]')?.click();
    await vi.waitFor(() =>
      expect(env.el.querySelector('[data-status="multi"]')?.textContent).toBe(
        t('exchange.multi.tooBig', { max: '50' }),
      ),
    );
    expect(env.codec.decodes).toBe(0);
    expect(env.calls.some((c) => c.path === '/uploads')).toBe(false);
  });
});

describe('multi-import (CAP-121)', () => {
  it('[T-app-240] the prompt follows the UI language and the template is the empty MULTI_IMPORT_TEMPLATE', async () => {
    setLanguage('es');
    const es = await setup();
    expect(es.el.querySelector('[data-part-title="many"]')?.textContent).toBe('Varias chapas');
    expect(es.el.querySelector('[data-part-title="one"]')?.textContent).toBe('Una chapa');
    expect(es.el.querySelector<HTMLTextAreaElement>('[data-multi="prompt"]')?.value).toBe(
      multiImportInstructions('es'),
    );
    es.el.querySelector<HTMLButtonElement>('[data-action="copy-multi-prompt"]')?.click();
    es.el.querySelector<HTMLButtonElement>('[data-action="copy-multi-template"]')?.click();
    await flush();
    expect(es.copies[0]).toBe(multiImportInstructions('es'));
    const template = JSON.parse(es.copies[1] ?? '{}') as Record<string, unknown>;
    expect(template).toEqual(MULTI_IMPORT_TEMPLATE);
    expect(template).not.toHaveProperty('known');
    expect(template).not.toHaveProperty('requestId');
    expect(Object.values(template.fields as Record<string, unknown>).every((v) => v === null)).toBe(true);
    expect(es.el.querySelector('[data-multi="photo"]')?.textContent).toContain('Hasta 50 chapas');
    setLanguage('en');
    const en = await setup();
    expect(en.el.querySelector<HTMLTextAreaElement>('[data-multi="prompt"]')?.value).toBe(
      multiImportInstructions('en'),
    );
  });

  it('[T-app-241] six pairs → six rows; the saved body is needsReview, external:anthropic, with the defaults (CAP-124: year too)', async () => {
    const env = await setup();
    await env.upload([zipFile()]);
    expect(env.el.querySelectorAll('[data-row]')).toHaveLength(6);
    expect(env.posts()).toHaveLength(6);
    for (const post of env.posts()) expect(CapInput.safeParse(post.body).success).toBe(true);
    const grimbergen = env.posts()[0]?.body as Record<string, unknown>;
    expect(grimbergen).toMatchObject({
      brand: 'Grimbergen',
      variant: 'Double Ambrée',
      country: 'BE',
      type: 'beer',
      status: 'needsReview',
      source: 'external:anthropic',
      aiModel: 'claude-test-model',
      aiConfidence: 0.9,
      material: 'steel',
      closure: 'pry-off',
      acquiredOn: '2026-11-28',
      acquiredWhere: 'Segovia',
      year: 2026, // CAP-124: the current year when the AI gave none
      notes: `Red rim\n${t('exchange.multi.defaultsNote', { fields: 'year, material, closure, place' })}`,
      images: { top: { key: expect.stringMatching(/^u1\//) } },
      dhash: expect.stringMatching(/^[0-9a-f]{16}$/),
    });
    expect(grimbergen).not.toHaveProperty('location');
    const bodies = env.posts().map((p) => p.body as Record<string, unknown>);
    expect(bodies[1]).toMatchObject({ brand: 'La Cibeles', year: 2019 });
    expect(bodies[2]).toMatchObject({ brand: 'Mahou', country: 'ES' }); // normalised from "Spain"
    expect(bodies[3]).toMatchObject({ material: 'aluminium', closure: 'twist-off' }); // the AI's own, not defaults
    expect(bodies[4]).toMatchObject({ brand: 'Unknown' });
    expect(env.row('Grimbergen_Double-Ambree')?.querySelector('.multi-import-name')?.textContent).toBe(
      'Grimbergen · Double Ambrée',
    );
    expect(importSource(null)).toBe('external:unknown');
    expect(importSource('Le Chat')).toBe('external:le-chat');
  });

  it('[T-app-242] an invalid JSON is a failed row with its reason; the other pairs still import', async () => {
    const files: Record<string, Uint8Array> = {
      'Good.png': capPng(1),
      'Good.json': strToU8(JSON.stringify(PAIRS[0][2])),
      'Broken.png': capPng(2),
      'Broken.json': strToU8('{ "fields": '),
      'Wrong.png': capPng(3),
      'Wrong.json': strToU8(JSON.stringify({ format: 'something.else', version: 1 })),
    };
    const env = await setup();
    await env.upload([zipFile(zipSync(files))]);
    expect(env.posts()).toHaveLength(1);
    for (const name of ['Broken', 'Wrong']) {
      expect(env.row(name)?.dataset.rowStatus).toBe('failed');
      expect(env.row(name)?.querySelector('[data-reason]')?.textContent).toBe(t('exchange.multi.reason.invalidJson'));
    }
    expect(env.row('Good')?.dataset.rowStatus).toBe('imported');
  });

  it('[T-app-243] a dHash match is "already in collection": no POST /caps for it, and analyse always carries useAi: false', async () => {
    const env = await setup({ dupBrand: 'Mahou' });
    await env.upload([zipFile()]);
    const analyses = env.calls.filter((c) => c.path === '/scans/analyse').map((c) => c.body as AnalyseRequest);
    expect(analyses).toHaveLength(6);
    for (const body of analyses) {
      expect(AnalyseRequest.safeParse(body).success).toBe(true);
      expect(body.useAi).toBe(false);
    }
    expect(env.posts().map((p) => (p.body as { brand: string }).brand)).not.toContain('Mahou');
    expect(env.posts()).toHaveLength(5);
    const mahou = env.row('Mahou_Clasica');
    expect(mahou?.dataset.rowStatus).toBe('inCollection');
    expect(mahou?.querySelector('[data-open="existing"]')?.getAttribute('href')).toBe(`/cap/${ulid(7)}`);
  });

  it('[T-app-244] two near-identical images in one zip: the second is "repeated in the zip" and not saved', async () => {
    const files: Record<string, Uint8Array> = {
      'First.png': capPng(1),
      'First.json': strToU8(JSON.stringify(PAIRS[0][2])),
      'Again.png': capPng(1),
      'Again.json': strToU8(JSON.stringify(PAIRS[1][2])),
    };
    const env = await setup();
    await env.upload([zipFile(zipSync(files))]);
    expect(env.posts()).toHaveLength(1);
    expect(env.row('Again')?.dataset.rowStatus).toBe('repeated');
    expect(env.calls.filter((c) => c.path === '/uploads')).toHaveLength(1); // checked before uploading
  });

  it('[T-app-245] a brand + variant match is saved anyway, flagged "possible duplicate", with a note naming the other cap', async () => {
    const existing = wireCap(9, { brand: 'GRIMBERGEN', variant: 'double ambree' });
    const env = await setup({ stored: [existing] });
    await env.upload([zipFile()]);
    const query = env.calls.find((c) => c.path.startsWith('/caps?'))?.path ?? '';
    expect(new URL(query, 'https://x').searchParams.get('brand')).toBe('Grimbergen');
    const grimbergen = env.posts()[0]?.body as { notes: string };
    expect(grimbergen.notes).toBe(
      [
        'Red rim',
        t('exchange.multi.possibleNote', { title: 'GRIMBERGEN · double ambree', id: ulid(9).slice(-6) }),
        t('exchange.multi.defaultsNote', { fields: 'year, material, closure, place' }),
      ].join('\n'),
    );
    const row = env.row('Grimbergen_Double-Ambree');
    expect(row?.dataset.rowStatus).toBe('possibleDuplicate');
    expect(row?.querySelector('[data-open="cap"]')).not.toBeNull();
    expect(row?.querySelector('[data-open="existing"]')?.getAttribute('href')).toBe(`/cap/${ulid(9)}`);
    // "Unknown" is never brand-checked.
    expect(
      env.calls
        .filter((c) => c.path.startsWith('/caps?'))
        .map((c) => c.path)
        .join(),
    ).not.toContain('Unknown');
  });

  it('[T-app-246] a transparent cut-out is flattened before the dHash and stored as WebP ≤ 1024 with its alpha kept', async () => {
    const { codec, encoded } = pngCodec();
    const blob = new Blob([capPng(3) as BlobPart], { type: 'image/png' });
    const photo = await prepareImage(blob, codec);
    const pixels = decodePng(capPng(3));
    expect(photo.dhash).toBe(dhash(inscribedSquare(flatten(pixels))));
    expect(photo.blob.type).toBe('image/webp');
    const stored = encoded[0];
    expect(stored?.data[3]).toBe(0); // the corner stays transparent in the stored copy
    expect(flatten(pixels).data[3]).toBe(255);
    expect(Array.from(flatten(pixels).data.subarray(0, 3))).toEqual([0, 0, 0]);
    // A large image is resized to ≤ 1024 px.
    const big = await prepareImage(new Blob([capPng(2, 1100) as BlobPart]), codec);
    expect([big.width, big.height]).toEqual([1024, 1024]);
  });

  it('[T-app-247] the summary counts each outcome and "Ver por revisar" opens the Collection filtered to needsReview', async () => {
    const env = await setup({ dupBrand: 'Mahou', stored: [wireCap(9, { brand: 'Daura', variant: 'Marzen' })] });
    const files: Record<string, Uint8Array> = { 'Orphan.png': capPng(7) };
    for (const [name, n, response] of PAIRS) {
      files[`${name}.png`] = capPng(n);
      files[`${name}.json`] = strToU8(JSON.stringify(response));
    }
    files['Twin.png'] = capPng(1);
    files['Twin.json'] = strToU8(JSON.stringify(PAIRS[1][2]));
    await env.upload([zipFile(zipSync(files))]);
    const count = (s: string) => env.el.querySelector(`[data-count="${s}"]`)?.textContent;
    expect([
      count('imported'),
      count('inCollection'),
      count('repeated'),
      count('possibleDuplicate'),
      count('failed'),
    ]).toEqual(['4', '1', '1', '1', '1']);
    expect(env.el.querySelector('[data-action="view-review"]')?.getAttribute('href')).toBe('/?status=needsReview');
    expect(env.el.querySelector('[data-row="Orphan"] [data-reason]')?.textContent).toBe(
      t('exchange.multi.reason.noJson'),
    );
    // "Importar otro zip" brings the upload back.
    env.el.querySelector<HTMLButtonElement>('[data-action="multi-another"]')?.click();
    expect(env.el.querySelector<HTMLElement>('[data-multi="upload"]')?.hidden).toBe(false);
    expect(env.el.querySelector<HTMLElement>('[data-multi="summary"]')?.hidden).toBe(true);
  });

  it('[T-app-248] Cancel stops after the current cap and keeps what was saved; "Reintentar fallidas" resends only failed rows', async () => {
    const env = await setup({ failCapsFor: 'La Cibeles' });
    // Hold the first save so Cancel lands mid-run.
    const original = env.calls.push.bind(env.calls);
    let held = false;
    env.calls.push = (...items: Call[]) => {
      const n = original(...items);
      if (!held && items.some((c) => c.path === '/caps' && c.method === 'POST')) {
        held = true;
        env.el.querySelector<HTMLButtonElement>('[data-action="multi-cancel"]')?.click();
      }
      return n;
    };
    await env.upload([zipFile()]);
    expect(env.posts()).toHaveLength(1); // the cap being saved when Cancel was pressed
    const statuses = [...env.el.querySelectorAll<HTMLElement>('[data-row]')].map((r) => r.dataset.rowStatus);
    expect(statuses).toEqual(['imported', 'failed', 'failed', 'failed', 'failed', 'failed']);
    expect(env.el.querySelectorAll('[data-reason="cancelled"]')).toHaveLength(5);

    // Retry: only the failed rows run again (the saved one is not re-sent); La Cibeles fails to save this time.
    env.calls.push = original;
    env.el.querySelector<HTMLButtonElement>('[data-action="multi-retry"]')?.click();
    await vi.waitFor(() => expect(env.posts()).toHaveLength(6));
    await vi.waitFor(() => expect(env.el.querySelector<HTMLElement>('[data-multi="summary"]')?.hidden).toBe(false));
    const brands = env.posts().map((p) => (p.body as { brand: string }).brand);
    expect(brands.filter((b) => b === 'Grimbergen')).toHaveLength(1);
    expect(env.row('La-Cibeles')?.querySelector('[data-reason]')?.textContent).toBe(
      t('exchange.multi.reason.saveFailed'),
    );
    expect(env.el.querySelector('[data-count="imported"]')?.textContent).toBe('5');
  });
});

describe('multi-import defaults when unsure (CAP-124)', () => {
  const answer = (fields: Record<string, unknown>) => ({
    provider: 'Anthropic',
    model: 'claude-test-model',
    fields: {
      brand: 'Marca',
      variant: null,
      producer: null,
      country: null,
      type: null,
      material: null,
      closure: null,
      year: null,
      description: null,
      textOnCap: null,
      ...fields,
    },
    confidence: { brand: 0.8 },
    notes: null,
  });
  const one = (fields: Record<string, unknown>) =>
    zipFile(zipSync({ 'Cap.png': capPng(1), 'Cap.json': strToU8(JSON.stringify(answer(fields))) }));
  const saved = async (env: Awaited<ReturnType<typeof setup>>, fields: Record<string, unknown>) => {
    await env.upload([one(fields)]);
    return env.posts()[0]?.body as Record<string, unknown>;
  };

  it('[T-app-255] an AI year of null saves the current year, and the notes line names "año"', async () => {
    setLanguage('es');
    const body = await saved(await setup({ noPlace: true }), { type: 'beer', material: 'steel', closure: 'pry-off' });
    expect(body.year).toBe(NOW.getFullYear());
    expect(body.notes).toBe(t('exchange.multi.defaultsNote', { fields: 'año' }));
    expect(body.notes).toBe('Valores por defecto al importar: año.');
    expect(CapInput.safeParse(body).success).toBe(true);
  });

  it('[T-app-256] an AI type of null is guessed from the text ("Cervecera X" → beer); with no match it stays empty', async () => {
    const beer = await saved(await setup({ noPlace: true }), { producer: 'Cervecera X', year: 2001 });
    expect(beer.type).toBe('beer');
    expect(beer.notes).toBe(t('exchange.multi.defaultsNote', { fields: 'type, material, closure' }));
    const none = await saved(await setup({ noPlace: true }), { brand: 'Zeta', year: 2001 });
    expect(none).not.toHaveProperty('type');
    expect(none.notes).toBe(t('exchange.multi.defaultsNote', { fields: 'material, closure' }));
  });

  it('[T-app-257] a full AI answer is saved as given, with no defaults notes line', async () => {
    const full = { type: 'cider', material: 'aluminium', closure: 'twist-off', year: 1987, producer: 'Cervecera X' };
    const body = await saved(await setup({ noPlace: true }), full);
    expect(body).toMatchObject(full);
    expect(body).not.toHaveProperty('notes');
    expect(body).not.toHaveProperty('acquiredWhere');
    expect(body.acquiredOn).toBe('2026-11-28'); // today, as every new cap (not named in the notes line)
  });
});
