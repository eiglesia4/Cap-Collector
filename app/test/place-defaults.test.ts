// Year and place defaults (CAP-100, features.md § Defaults when unsure and § Place from GPS): the current year, the
// place where the phone is now (native plugin stubbed) or the last place used on the web, marked "default — check",
// never flagging the cap; once per batch; typing first wins; nothing in edit mode.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Cap, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import type { CaptureSession } from '../src/capture/context';
import { defaultPlace, formatPlace, LAST_PLACE_KEY, regionOf, resetBatchPlace } from '../src/capture/place';
import type { AppContext } from '../src/context';
import type { CapPhoto } from '../src/images/resize';
import { createCapacitorPlatform, type CapacitorPlugins } from '../src/platform/capacitor/capacitor-platform';
import { PLACE_GUARD_MS } from '../src/platform/capacitor/place-name-plugin';
import type { PlaceName, Platform } from '../src/platform/platform';
import { CapForm, type CapFormOptions } from '../src/screens/cap-form-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, memoryStore, shellContext } from './support/fakes';

const SCAN_ID = ulid(61);
const NOW = new Date(2026, 2, 5, 10, 30);
// The spec's neutral example (features.md § Place from GPS, CAP-101): Segovia, province of Segovia.
const SEGOVIA: PlaceName = { locality: 'Segovia', region: 'Segovia', countryCode: 'ES', deviceRegion: 'ES' };

const photo: CapPhoto = {
  blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash: 'f0f0f03030f0f0f0',
};
const ref: ImageRef = { key: `u1/${SCAN_ID}/top.webp`, width: 1024, height: 1024, bytes: 900 };

function session(response: AnalyseResponse, batchId?: string): CaptureSession {
  return {
    scanId: SCAN_ID,
    useAi: true,
    top: { photo, ref },
    response,
    ...(batchId ? { batch: { batchId, index: 0, placeAsYouGo: false } } : {}),
  };
}
const unidentified = (): AnalyseResponse => ({ scanId: SCAN_ID, outcome: 'unidentified', suggestions: [] });
/** An AI answer that left `year` and `acquiredWhere` empty, everything it named sure. */
const identified = (): AnalyseResponse => ({
  scanId: SCAN_ID,
  outcome: 'identified',
  suggestions: [],
  fields: { brand: 'Mahou', type: 'beer', material: 'steel', closure: 'pry-off', country: 'ES' },
  confidence: { brand: 0.95, type: 0.9, material: 0.9, closure: 0.9, country: 0.9, variant: 0.9, producer: 0.9 },
});

async function mount(options: CapFormOptions, platform: Platform = fakePlatform()) {
  const bodies: Record<string, unknown>[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    if (opts.method === 'POST' || opts.method === 'PATCH') bodies.push(opts.body as Record<string, unknown>);
    const answer =
      path === '/caps' || path.startsWith('/caps/') ? { ...wireCap(9), ...(opts.body as object) } : undefined;
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const ctx: AppContext = {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
    now: () => NOW,
  };
  const el = CapForm(ctx, options);
  document.body.replaceChildren(el);
  await settle();
  const saved = async () => {
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    return bodies[0];
  };
  return { el, saved, platform };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 8; i++) await flush();
}

const control = (el: ParentNode, name: string) =>
  el.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#cap-${name}`);
const markOf = (el: ParentNode, name: string) =>
  el.querySelector(`[data-hint-for="${name}"] [data-mark]`)?.getAttribute('data-mark') ?? null;
function type(el: ParentNode, name: string, value: string): void {
  const input = control(el, name);
  if (!input) throw new Error(`missing #cap-${name}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function nativeAt(place: PlaceName | null | Promise<PlaceName | null>): Platform {
  const platform = fakePlatform('native');
  vi.mocked(platform.currentPlace).mockImplementation(() => Promise.resolve(place));
  return platform;
}

beforeEach(() => resetBatchPlace());
afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('year and place defaults (CAP-100)', () => {
  it('[T-app-197] formatPlace: "Locality, Region"; the country only when foreign; no repeats; cut to 120', () => {
    // A province named like its town is written once (CAP-100 no-repeat rule; SPEC-GAP CAP-104 in place.ts).
    expect(formatPlace(SEGOVIA, 'ES')).toBe('Segovia');
    expect(formatPlace({ locality: 'Lyon', region: 'Rhône', countryCode: 'FR' }, 'ES')).toBe('Lyon, Rhône, France');
    expect(formatPlace({ locality: 'Madrid', region: 'madrid', countryCode: 'ES' }, 'ES')).toBe('Madrid');
    // An unknown device region cannot tell foreign from home: the country is left out.
    expect(formatPlace({ locality: 'Lyon', region: 'Rhône', countryCode: 'FR' }, undefined)).toBe('Lyon, Rhône');
    // Only the country named: it is all there is.
    expect(formatPlace({ countryCode: 'ES' }, 'ES')).toBe('Spain');
    expect(formatPlace({}, 'ES')).toBe('');
    expect(formatPlace({ locality: 'x'.repeat(130) }, 'ES')).toHaveLength(120);
    expect(regionOf('es-ES')).toBe('ES');
    expect(regionOf('en')).toBeUndefined();
    expect(regionOf('not a tag')).toBeUndefined();
    expect(regionOf(undefined)).toBeUndefined();
  });

  it('[T-app-198] an empty year → the current year, marked "default", not flagged (also after an AI review); edit mode gets nothing', async () => {
    const manual = await mount({ mode: 'empty', scan: session(unidentified()) });
    expect(control(manual.el, 'year')?.value).toBe('2026');
    expect(markOf(manual.el, 'year')).toBe('default');
    type(manual.el, 'brand', 'Mahou');
    expect(await manual.saved()).toMatchObject({ year: 2026, status: 'complete' });

    // The AI left `year` empty (unsure, no confidence): the default wins over the highlight and does not flag.
    const review = await mount({ mode: 'ai-prefilled', scan: session(identified()) });
    expect(control(review.el, 'year')?.value).toBe('2026');
    expect(markOf(review.el, 'year')).toBe('default');
    expect(await review.saved()).toMatchObject({ year: 2026, status: 'complete' });

    const platform = nativeAt(SEGOVIA);
    const edit = await mount({ mode: 'edit', cap: Cap.parse(wireCap(3)) }, platform);
    expect(control(edit.el, 'year')?.value).toBe('');
    expect(control(edit.el, 'acquiredWhere')?.value).toBe('');
    expect(edit.el.querySelector('[data-mark]')).toBeNull();
    expect(platform.currentPlace).not.toHaveBeenCalled();
  });

  it('[T-app-199] iPhone: currentPlace (Segovia, Segovia) → "Segovia" filled and marked, saved and not flagged; null → empty', async () => {
    const at = await mount({ mode: 'empty', scan: session(unidentified()) }, nativeAt(SEGOVIA));
    expect(at.platform.currentPlace).toHaveBeenCalledTimes(1);
    expect(control(at.el, 'acquiredWhere')?.value).toBe('Segovia');
    expect(markOf(at.el, 'acquiredWhere')).toBe('default');
    type(at.el, 'brand', 'Mahou');
    expect(await at.saved()).toMatchObject({ acquiredWhere: 'Segovia', status: 'complete' });

    const nowhere = await mount({ mode: 'empty', scan: session(unidentified()) }, nativeAt(null));
    expect(control(nowhere.el, 'acquiredWhere')?.value).toBe('');
    expect(markOf(nowhere.el, 'acquiredWhere')).toBeNull();
    // No error UI: nothing but the empty field.
    expect(nowhere.el.querySelector('[role="alert"]:not([hidden])')).toBeNull();
  });

  it('[T-app-200] a place typed before the answer arrives is kept; "Looks right" clears the mark', async () => {
    let answer: (place: PlaceName | null) => void = () => undefined;
    const late = new Promise<PlaceName | null>((resolve) => (answer = resolve));
    const typed = await mount({ mode: 'empty', scan: session(unidentified()) }, nativeAt(late));
    type(typed.el, 'acquiredWhere', 'Rastro de Madrid');
    answer(SEGOVIA);
    await settle();
    expect(control(typed.el, 'acquiredWhere')?.value).toBe('Rastro de Madrid');
    expect(markOf(typed.el, 'acquiredWhere')).toBeNull();

    const confirmed = await mount({ mode: 'empty', scan: session(unidentified()) }, nativeAt(SEGOVIA));
    confirmed.el.querySelector<HTMLButtonElement>('[data-confirm="acquiredWhere"]')?.click();
    expect(markOf(confirmed.el, 'acquiredWhere')).toBeNull();
    expect(control(confirmed.el, 'acquiredWhere')?.value).toBe('Segovia');
  });

  it('[T-app-201] batch: one place lookup for every cap of the batch, a new one for the next batch', async () => {
    const platform = nativeAt(SEGOVIA);
    for (let i = 0; i < 3; i++) {
      const item = await mount({ mode: 'empty', scan: session(unidentified(), 'batch-1') }, platform);
      expect(control(item.el, 'acquiredWhere')?.value).toBe('Segovia');
    }
    expect(platform.currentPlace).toHaveBeenCalledTimes(1);
    await defaultPlace({ platform }, 'batch-2');
    await defaultPlace({ platform }, 'batch-2');
    expect(platform.currentPlace).toHaveBeenCalledTimes(2);
    // Outside a batch every form asks again.
    await defaultPlace({ platform });
    expect(platform.currentPlace).toHaveBeenCalledTimes(3);
  });

  it('[T-app-202] web: the last place used is pre-filled and marked (none stored → empty); a save stores it', async () => {
    const store = memoryStore();
    const web = fakePlatform('web', store);
    const first = await mount({ mode: 'empty', scan: session(unidentified()) }, web);
    expect(control(first.el, 'acquiredWhere')?.value).toBe('');
    expect(web.currentPlace).not.toHaveBeenCalled();
    type(first.el, 'brand', 'Mahou');
    type(first.el, 'acquiredWhere', 'Mercadillo de Segovia');
    await first.saved();
    expect(store.data.get(LAST_PLACE_KEY)).toBe('Mercadillo de Segovia');

    const next = await mount({ mode: 'empty', scan: session(unidentified()) }, web);
    expect(control(next.el, 'acquiredWhere')?.value).toBe('Mercadillo de Segovia');
    expect(markOf(next.el, 'acquiredWhere')).toBe('default');

    // A store that fails only loses the default.
    const broken = fakePlatform('web', { ...memoryStore(), get: () => Promise.reject(new Error('blocked')) });
    expect(await defaultPlace({ platform: broken })).toBeNull();
  });

  it("[T-app-203] Capacitor currentPlace: the plugin's names, null for {} / rejection / a bridge that never answers", async () => {
    const call = vi.fn<() => Promise<Record<string, unknown>>>();
    const platform = createCapacitorPlatform(fakePlatform('web'), {
      PlaceName: { currentPlace: call },
    } as unknown as CapacitorPlugins);

    call.mockResolvedValueOnce({
      locality: ' Segovia ',
      region: 'Segovia',
      countryCode: 'ES',
      deviceRegion: '',
      x: 1,
    });
    expect(await platform.currentPlace()).toEqual({
      locality: 'Segovia',
      region: 'Segovia',
      countryCode: 'ES',
    });
    call.mockResolvedValueOnce({});
    expect(await platform.currentPlace()).toBeNull();
    call.mockRejectedValueOnce(new Error('denied'));
    expect(await platform.currentPlace()).toBeNull();

    vi.useFakeTimers();
    call.mockReturnValueOnce(new Promise(() => undefined));
    const hanging = platform.currentPlace();
    await vi.advanceTimersByTimeAsync(PLACE_GUARD_MS);
    expect(await hanging).toBeNull();
  });

  it('[T-app-204] iOS wiring: the PlaceName plugin is built and registered, reduced accuracy, the usage string in English and Spanish', () => {
    const ios = (path: string) =>
      readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'ios', 'App', path), 'utf8');
    const plugin = ios('App/PlaceNamePlugin.swift');
    expect(plugin).toContain('jsName = "PlaceName"');
    expect(plugin).toContain('CAPPluginMethod(name: "currentPlace"');
    expect(plugin).toContain('desiredAccuracy = kCLLocationAccuracyReduced');
    expect(plugin).toContain('requestWhenInUseAuthorization()');
    expect(plugin).toContain('reverseGeocodeLocation(location)');
    expect(plugin).toContain('placemark.subAdministrativeArea ?? placemark.administrativeArea');
    // Names only: no coordinate ever goes to JS.
    expect(plugin).not.toMatch(/latitude|longitude|coordinate/);
    expect(plugin).not.toContain('call.reject');
    expect(ios('App/MainViewController.swift')).toContain('bridge?.registerPluginInstance(PlaceNamePlugin())');
    const pbx = ios('App.xcodeproj/project.pbxproj');
    expect(pbx.match(/\/\* PlaceNamePlugin\.swift in Sources \*\/,/g)).toHaveLength(1);
    expect(pbx.match(/\/\* InfoPlist\.strings in Resources \*\/,/g)).toHaveLength(1);
    expect(pbx).toMatch(/knownRegions = \(\s*en,\s*es,/);
    expect(ios('App/Info.plist')).toContain('<key>NSLocationWhenInUseUsageDescription</key>');
    expect(ios('App/es.lproj/InfoPlist.strings')).toContain(
      '"NSLocationWhenInUseUsageDescription" = "Para rellenar dónde conseguiste la chapa (solo el nombre del lugar)";',
    );
  });
});
