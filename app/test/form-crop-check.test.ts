// Crop check for the form's photos (CAP-92; ADR-010 §2): Manual entry's photo slots and the review's "Add underside
// photo" open the crop check as a sheet over the form (values kept); Use photo puts the cropped photo in the slot and
// uploads it; Retake reopens the picker. No path that brings in a new photo calls the blind centred crop any more
// (`resizeToWebp(…, { crop: 'circle' })` is spied). Codec, detector and cropper are fakes (happy-dom has no canvas).
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { CapPhoto } from '../src/images/resize';
import * as resize from '../src/images/resize';
import { CapForm } from '../src/screens/cap-form-screen';
import { ScanView } from '../src/screens/scan-screen';
import { wireCap } from './support/caps';
import { fakeApi, fakeCropCheck, fakePlatform, flush, shellContext } from './support/fakes';

vi.mock('../src/images/resize', async (original) => {
  const actual = await original<typeof import('../src/images/resize')>();
  return { ...actual, resizeToWebp: vi.fn(actual.resizeToWebp) };
});

const KEY = 'u1/01JBF70A1B2C3D4E5F6G7H8J9K/top.webp';
const CHECKED: CapPhoto = {
  blob: new Blob([new Uint8Array(1000)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash: 'f0f0f03030f0f0f0',
};

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

const $ = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

async function manualEntry() {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    const answer =
      path === '/uploads'
        ? { key: KEY, url: 'https://s3.test/top', expiresAt: '2030-01-01T00:00:00.000Z' }
        : path === '/caps' && method === 'POST'
          ? { ...wireCap(7), ...(opts.body as object) }
          : undefined;
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform('web');
  const api = fakeApi({ request: request as ApiClient['request'] });
  const ctx: AppContext = { ...(await shellContext({ api, platform })), navigate: vi.fn(), skipSignIn: vi.fn() };
  const check = fakeCropCheck(() => CHECKED);
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const el = CapForm(ctx, { mode: 'empty', check, put });
  document.body.replaceChildren(el);
  const pickNext = (name: string | null) =>
    vi.mocked(platform.pickFiles).mockResolvedValueOnce(name === null ? [] : [new File([name], `${name}.jpg`)]);
  const brand = (value: string) => {
    const input = $<HTMLInputElement>(el, '#cap-brand');
    input.value = value;
    input.dispatchEvent(new Event('input'));
  };
  return { el, ctx, calls, check, put, pickNext, brand };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.mocked(resize.resizeToWebp).mockClear();
});

describe('crop check in the form', () => {
  it('[T-app-178] Manual entry "add photo" opens the crop check; Use photo puts the cropped photo in the slot and saves it', async () => {
    const m = await manualEntry();
    m.brand('Daura');
    m.pickNext('top');
    $(m.el, '[data-pick="top:library"]').click();
    await settle();
    const sheet = $(m.el, '.crop-sheet');
    expect(sheet.querySelector('[data-crop-check="top"] h2')?.textContent).toBe(t('scan.checkTitle'));
    expect(m.calls).toEqual([]);

    $(sheet, '[data-action="use-photo"]').click();
    await settle();
    expect(m.el.querySelector('.crop-sheet')).toBeNull();
    expect(m.check.crop).toHaveBeenCalledTimes(1);
    expect(m.put).toHaveBeenCalledWith('https://s3.test/top', expect.objectContaining({ body: CHECKED.blob }));
    expect(m.calls.find((c) => c.path === '/uploads')?.body).toEqual({
      side: 'top',
      contentType: 'image/webp',
      bytes: 1000,
    });
    expect($(m.el, '[data-side="top"]').dataset.state).toBe('idle');
    // No "crop to a square" option any more: every photo is checked.
    expect(m.el.querySelector('#cap-square')).toBeNull();

    $<HTMLFormElement>(m.el, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(m.calls.find((c) => c.path === '/caps' && c.method === 'POST')?.body).toMatchObject({
      brand: 'Daura',
      images: { top: { key: KEY, width: 1024, height: 1024 } },
    });
  });

  it('[T-app-179] Retake reopens the picker and keeps the form values; backing out closes the sheet without a photo', async () => {
    const m = await manualEntry();
    m.brand('Mahou');
    m.pickNext('first');
    $(m.el, '[data-pick="top:library"]').click();
    await settle();
    // Retake → the picker again → the check of the new photo.
    m.pickNext('second');
    $(m.el, '[data-action="crop-retake"]').click();
    await settle();
    expect(m.check.codec.decode).toHaveBeenCalledTimes(2);
    expect((vi.mocked(m.check.codec.decode).mock.calls[1]?.[0] as File).name).toBe('second.jpg');
    expect(m.el.querySelector('.crop-sheet')).not.toBeNull();
    // Retake with the picker closed → no photo, the form as it was.
    m.pickNext(null);
    $(m.el, '[data-action="crop-retake"]').click();
    await settle();
    expect(m.el.querySelector('.crop-sheet')).toBeNull();
    expect($<HTMLInputElement>(m.el, '#cap-brand').value).toBe('Mahou');
    expect(m.calls).toEqual([]);
    expect($(m.el, '[data-side="top"] .photo-preview--empty')).not.toBeNull();

    // A tap on the backdrop closes it too.
    m.pickNext('third');
    $(m.el, '[data-pick="top:library"]').click();
    await settle();
    $(m.el, '.sheet-backdrop').click();
    await settle();
    expect(m.el.querySelector('.crop-sheet')).toBeNull();
    expect(m.calls).toEqual([]);
    expect($<HTMLInputElement>(m.el, '#cap-brand').value).toBe('Mahou');
  });

  it('[T-app-180] no path that brings in a new photo calls the blind centred crop (resizeToWebp is spied)', async () => {
    // Form slot.
    const m = await manualEntry();
    m.pickNext('top');
    $(m.el, '[data-pick="top:library"]').click();
    await settle();
    $(m.el, '[data-action="use-photo"]').click();
    await settle();

    // Scan: top and underside.
    const platform = fakePlatform('web');
    const ctx: AppContext = {
      ...(await shellContext({
        api: fakeApi({ request: vi.fn(async () => Promise.reject(new Error('x'))) }),
        platform,
      })),
      navigate: vi.fn(),
      skipSignIn: vi.fn(),
    };
    const scan = ScanView(ctx, { check: fakeCropCheck(() => CHECKED), put: vi.fn() });
    document.body.replaceChildren(scan);
    for (const name of ['t', 'uu']) {
      vi.mocked(platform.pickFiles).mockResolvedValueOnce([new File([name], `${name}.jpg`)]);
      $(scan, '[data-action="upload"]').click();
      await settle();
      $(scan, '[data-action="use-photo"]').click();
      await settle();
    }
    expect(ctx.capture.current()?.underside?.photo).toBe(CHECKED);
    expect(resize.resizeToWebp).not.toHaveBeenCalled();
  });
});
