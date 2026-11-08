// Cap form (CAP-25; SCREENS.md #5, ADR-003 modes empty | edit, ADR-006 WebP ≤ 1024 px; openapi.yaml § POST /caps,
// PATCH /caps/{capId}, POST /uploads). Images go through a fake codec: happy-dom has no canvas encoder.
import { Cap } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { NetworkError, ProblemError } from '../src/api/errors';
import { brandSuggestions } from '../src/cap/brand';
import {
  EMPTY_VALUES,
  patchBody,
  problemErrors,
  validate,
  valuesFromCap,
  type FormValues,
} from '../src/cap/form-model';
import { collectionState } from '../src/collection/state';
import type { AppContext } from '../src/context';
import { searchCountries } from '../src/i18n/countries';
import { t } from '../src/i18n/i18n';
import {
  browserCodec,
  fitWithin,
  ImageDecodeError,
  ImageTooLargeError,
  MAX_BYTES,
  resizeToWebp,
  WebpUnsupportedError,
  type ImageCodec,
} from '../src/images/resize';
import { uploadImage, UploadFailedError } from '../src/images/upload';
import { matchRoute } from '../src/router/routes';
import {
  BRAND_DEBOUNCE_MS,
  CapForm,
  EditCapScreen,
  NewCapScreen,
  type CapFormOptions,
} from '../src/screens/cap-form-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const TOP = { key: 'u1/01JBF70A1B2C3D4E5F6G7H8J9K/top.webp', width: 1024, height: 768 };

function capOf(wire: Record<string, unknown>): Cap {
  return Cap.parse(wire);
}

/** Decodes to `width` × `height`; encodes blobs of `type`, sized from `sizes` in turn (default 1000 bytes). */
function fakeCodec(width: number, height: number, opts: { type?: string; sizes?: number[] } = {}) {
  const encodes: { crop: unknown; width: number; height: number; quality: number }[] = [];
  const sizes = [...(opts.sizes ?? [])];
  const codec: ImageCodec = {
    decode: vi.fn(async () => ({ source: document.createElement('canvas'), width, height, close: vi.fn() })),
    encode: vi.fn(async (_img, crop, w, h, quality) => {
      encodes.push({ crop, width: w, height: h, quality });
      return new Blob([new Uint8Array(sizes.shift() ?? 1000)], { type: opts.type ?? 'image/webp' });
    }),
  };
  return { codec, encodes };
}

type Handler = (path: string, method: string, body: unknown) => unknown;

interface Mounted {
  el: HTMLElement;
  ctx: AppContext;
  calls: { path: string; method: string; body: unknown }[];
  put: ReturnType<typeof vi.fn>;
  platform: ReturnType<typeof fakePlatform>;
}

const UPLOAD_OK = (side = 'top') => ({
  key: `u1/01JBF70A1B2C3D4E5F6G7H8J9K/${side}.webp`,
  url: `https://s3.test/${side}`,
  expiresAt: '2030-01-01T00:00:00.000Z',
});

async function mount(
  handler: Handler,
  options: Partial<CapFormOptions> & { kind?: 'web' | 'native'; putStatus?: number[] } = {},
): Promise<Mounted> {
  const calls: Mounted['calls'] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    const parsed = opts.schema.safeParse(await handler(path, method, opts.body));
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform(options.kind ?? 'web');
  const api = fakeApi({ request: request as ApiClient['request'] });
  const ctx: AppContext = { ...(await shellContext({ api, platform })), navigate: vi.fn(), skipSignIn: vi.fn() };
  const statuses = [...(options.putStatus ?? [])];
  const put = vi.fn(async () => new Response(null, { status: statuses.shift() ?? 200 }));
  const el = CapForm(ctx, {
    mode: options.mode ?? 'empty',
    ...(options.cap ? { cap: options.cap } : {}),
    codec: options.codec ?? fakeCodec(2048, 1536).codec,
    put,
  });
  document.body.replaceChildren(el);
  return { el, ctx, calls, put, platform };
}

const q = <T extends Element = HTMLElement>(root: ParentNode, selector: string): T => {
  const found = root.querySelector<T>(selector);
  if (!found) throw new Error(`missing ${selector}`);
  return found;
};

function type(root: ParentNode, field: string, value: string): void {
  const input = q<HTMLInputElement | HTMLTextAreaElement>(root, `#cap-${field}`);
  input.value = value;
  input.dispatchEvent(new Event('input'));
}

function choose(root: ParentNode, field: string, value: string): void {
  const select = q<HTMLSelectElement>(root, `#cap-${field}`);
  select.value = value;
  select.dispatchEvent(new Event('change'));
}

const errorFor = (root: ParentNode, field: string) => {
  const el = root.querySelector<HTMLElement>(`[data-error-for="${field}"]`);
  return el && !el.hidden ? el.textContent : null;
};

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

async function addTopPhoto(m: Mounted): Promise<void> {
  vi.mocked(m.platform.pickFiles).mockResolvedValueOnce([new File(['x'], 'a.jpg', { type: 'image/jpeg' })]);
  q<HTMLButtonElement>(m.el, '[data-pick="top:library"]').click();
  await settle();
}

function submit(root: ParentNode): void {
  q<HTMLFormElement>(root, 'form').dispatchEvent(new Event('submit', { cancelable: true }));
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('cap form — validation', () => {
  it('[T-app-048] validates with the shared CapInput: brand required, forTrade ≤ quantity, year range; inline and live', async () => {
    const values = (over: Partial<FormValues>): FormValues => ({ ...EMPTY_VALUES, tags: [], ...over });
    const noBrand = validate(values({}), { top: TOP }, 'complete');
    expect(noBrand.ok).toBe(false);
    if (!noBrand.ok) expect(noBrand.errors.brand).toBe(t('form.errorBrandRequired'));

    const tooMany = validate(values({ brand: 'Mahou', quantity: '2', forTrade: '3' }), { top: TOP }, 'complete');
    expect(!tooMany.ok && tooMany.errors.forTrade).toBe(t('form.errorForTrade'));

    for (const year of ['1849', '2101', '19x5']) {
      const bad = validate(values({ brand: 'Mahou', year }), { top: TOP }, 'complete');
      expect(!bad.ok && bad.errors.year).toBe(t('form.errorYear', { min: 1850, max: 2100 }));
    }
    const noPhoto = validate(values({ brand: 'Mahou' }), {}, 'complete');
    expect(!noPhoto.ok && noPhoto.errors.top).toBe(t('form.errorTopPhoto'));
    const longVariant = validate(values({ brand: 'Mahou', variant: 'x'.repeat(81) }), { top: TOP }, 'complete');
    expect(!longVariant.ok && longVariant.errors.variant).toBe(t('form.errorTooLong', { max: 80 }));
    const noQuantity = validate(values({ brand: 'Mahou', quantity: '' }), { top: TOP }, 'complete');
    expect(!noQuantity.ok && noQuantity.errors.quantity).toBe(t('form.errorQuantity'));

    const good = validate(
      values({ brand: ' Mahou ', year: '2023', quantity: '3', forTrade: '2' }),
      { top: TOP },
      'needsReview',
    );
    expect(good.ok && good.input).toMatchObject({
      brand: 'Mahou',
      year: 2023,
      quantity: 3,
      forTrade: 2,
      status: 'needsReview',
      source: 'manual',
    });

    // In the DOM: nothing shown before the user acts; a save attempt shows every error, editing updates them live.
    const m = await mount(() => undefined);
    expect(errorFor(m.el, 'brand')).toBeNull();
    submit(m.el);
    await settle();
    expect(errorFor(m.el, 'brand')).toBe(t('form.errorBrandRequired'));
    expect(errorFor(m.el, 'top')).toBe(t('form.errorTopPhoto'));
    expect(m.calls).toHaveLength(0);
    type(m.el, 'brand', 'Mahou');
    expect(errorFor(m.el, 'brand')).toBeNull();
    type(m.el, 'forTrade', '5');
    expect(errorFor(m.el, 'forTrade')).toBe(t('form.errorForTrade'));
    type(m.el, 'quantity', '5');
    expect(errorFor(m.el, 'forTrade')).toBeNull();
  });
});

describe('cap form — images', () => {
  it('[T-app-049] resize gives a WebP with the long edge ≤ 1024 px and the uploaded ImageRef carries its size', async () => {
    expect(fitWithin(4032, 3024)).toEqual({ width: 1024, height: 768 });
    expect(fitWithin(3024, 4032)).toEqual({ width: 768, height: 1024 });
    expect(fitWithin(600, 400)).toEqual({ width: 600, height: 400 });

    const { codec, encodes } = fakeCodec(4032, 3024);
    const image = await resizeToWebp(new Blob(['x']), { codec });
    expect(image).toMatchObject({ width: 1024, height: 768 });
    expect(image.blob.type).toBe('image/webp');
    expect(encodes[0]).toMatchObject({
      width: 1024,
      height: 768,
      quality: 0.85,
      crop: { sx: 0, sy: 0, sw: 4032, sh: 3024 },
    });

    const square = await resizeToWebp(new Blob(['x']), { codec, square: true });
    expect(square).toMatchObject({ width: 1024, height: 1024 });
    expect(encodes[1]?.crop).toEqual({ sx: 504, sy: 0, sw: 3024, sh: 3024 });

    const request = vi.fn(async () => UPLOAD_OK());
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const ref = await uploadImage({ request: request as ApiClient['request'] }, 'top', image, put);
    expect(request).toHaveBeenCalledWith(
      '/uploads',
      expect.objectContaining({
        method: 'POST',
        body: { side: 'top', contentType: 'image/webp', bytes: 1000 },
      }),
    );
    expect(put).toHaveBeenCalledWith('https://s3.test/top', {
      method: 'PUT',
      headers: { 'Content-Type': 'image/webp' },
      body: image.blob,
    });
    expect(ref).toEqual({ key: UPLOAD_OK().key, width: 1024, height: 768, bytes: 1000 });
  });

  it('[T-app-050] never passes off another format as WebP, lowers quality above 1 MiB, and says why in the form', async () => {
    await expect(
      resizeToWebp(new Blob(['x']), { codec: fakeCodec(100, 100, { type: 'image/png' }).codec }),
    ).rejects.toBeInstanceOf(WebpUnsupportedError);
    const big = fakeCodec(100, 100, { sizes: [MAX_BYTES + 1, MAX_BYTES - 1] });
    const image = await resizeToWebp(new Blob(['x']), { codec: big.codec });
    expect(big.encodes.map((e) => e.quality)).toEqual([0.85, 0.7]);
    expect(image.blob.size).toBe(MAX_BYTES - 1);
    const huge = fakeCodec(100, 100, { sizes: [MAX_BYTES + 1, MAX_BYTES + 1, MAX_BYTES + 1] });
    await expect(resizeToWebp(new Blob(['x']), { codec: huge.codec })).rejects.toBeInstanceOf(ImageTooLargeError);

    const m = await mount(() => UPLOAD_OK(), { codec: fakeCodec(100, 100, { type: 'image/png' }).codec });
    await addTopPhoto(m);
    expect(q(m.el, '[data-side="top"]').textContent).toContain(t('form.webpUnsupported'));
    expect(m.calls).toHaveLength(0);
  });

  it('[T-app-051] an upload failure keeps everything typed and offers a retry that completes the save', async () => {
    const m = await mount(
      (path, method, body) =>
        path === '/uploads' ? UPLOAD_OK() : method === 'POST' ? { ...wireCap(7), ...(body as object) } : undefined,
      { putStatus: [500, 200] },
    );
    type(m.el, 'brand', 'Mahou');
    type(m.el, 'year', '2023');
    await addTopPhoto(m);
    const slot = q(m.el, '[data-side="top"]');
    expect(slot.dataset.state).toBe('failed');
    expect(slot.textContent).toContain(t('form.uploadFailed'));
    expect(q<HTMLInputElement>(m.el, '#cap-brand').value).toBe('Mahou');
    expect(q<HTMLInputElement>(m.el, '#cap-year').value).toBe('2023');

    submit(m.el);
    await settle();
    expect(errorFor(m.el, 'form')).toBe(t('form.retryFirst'));
    expect(m.calls.filter((c) => c.path === '/caps')).toHaveLength(0);

    q<HTMLButtonElement>(m.el, '[data-retry="top"]').click();
    await settle();
    expect(q(m.el, '[data-side="top"]').dataset.state).toBe('idle');
    expect(m.put).toHaveBeenCalledTimes(2);
    submit(m.el);
    await settle();
    const post = m.calls.find((c) => c.path === '/caps');
    expect(post?.body).toMatchObject({
      brand: 'Mahou',
      year: 2023,
      images: { top: { key: UPLOAD_OK().key, width: 1024, height: 768 } },
    });
  });
});

describe('cap form — save', () => {
  it('[T-app-052] creates with POST /caps (source manual; status complete or needsReview), then opens the new cap', async () => {
    const created = wireCap(9);
    for (const [button, status] of [
      ['complete', 'complete'],
      ['needsReview', 'needsReview'],
    ] as const) {
      const m = await mount((path) => (path === '/uploads' ? UPLOAD_OK() : created));
      const state = collectionState(m.ctx);
      state.started = true;
      type(m.el, 'brand', 'Mahou');
      choose(m.el, 'type', 'beer');
      await addTopPhoto(m);
      if (button === 'complete') submit(m.el);
      else q<HTMLButtonElement>(m.el, '[data-save="needsReview"]').click();
      await settle();
      const post = m.calls.find((c) => c.path === '/caps');
      expect(post?.method).toBe('POST');
      expect(post?.body).toMatchObject({
        brand: 'Mahou',
        type: 'beer',
        source: 'manual',
        status,
        quantity: 1,
        forTrade: 0,
      });
      expect(m.ctx.navigate).toHaveBeenCalledWith(`/cap/${ulid(9)}`);
      expect(state.started).toBe(false);
      expect(document.querySelector('.toast')?.textContent).toBe(t('form.saved'));
    }
  });

  it('[T-app-053] PATCH sends only the changed fields (null clears one); no change sends nothing', async () => {
    const cap = capOf(
      wireCap(3, {
        brand: 'Mahou',
        variant: 'Clásica',
        producer: 'Mahou SM',
        year: 2022,
        tags: ['lager'],
        status: 'complete',
      }),
    );
    const input = (over: Partial<FormValues>) => {
      const result = validate({ ...valuesFromCap(cap), ...over }, { top: cap.images.top }, 'complete');
      if (!result.ok) throw new Error('invalid');
      return result.input;
    };
    expect(patchBody(cap, input({}))).toBeNull();
    expect(patchBody(cap, input({ year: '2023', producer: '' }))).toEqual({
      year: 2023,
      producer: null,
      source: 'manual',
    });
    expect(patchBody(cap, input({ tags: ['lager', 'spain'] }))).toEqual({ tags: ['lager', 'spain'], source: 'manual' });
    const flagged = validate(valuesFromCap(cap), { top: cap.images.top }, 'needsReview');
    expect(flagged.ok && patchBody(cap, flagged.input)).toEqual({ status: 'needsReview', source: 'manual' });
    const photo = validate(valuesFromCap(cap), { top: TOP }, 'complete');
    expect(photo.ok && patchBody(cap, photo.input)).toEqual({ images: { top: TOP }, source: 'manual' });

    const m = await mount(
      (_p, method) => (method === 'PATCH' ? wireCap(3, { brand: 'Mahou', year: 2023 }) : undefined),
      {
        mode: 'edit',
        cap,
      },
    );
    expect(q<HTMLInputElement>(m.el, '#cap-variant').value).toBe('Clásica');
    submit(m.el);
    await settle();
    expect(m.calls).toHaveLength(0);
    expect(m.ctx.navigate).toHaveBeenCalledWith(`/cap/${ulid(3)}`);

    type(m.el, 'year', '2023');
    type(m.el, 'producer', '');
    submit(m.el);
    await settle();
    expect(m.calls).toEqual([
      { path: `/caps/${ulid(3)}`, method: 'PATCH', body: { year: 2023, producer: null, source: 'manual' } },
    ]);
  });

  it('[T-app-054] shows 422 Problem.errors[] next to their fields and keeps the form on other failures', async () => {
    expect(
      problemErrors({
        title: 'Unprocessable',
        status: 422,
        errors: [
          { path: '/brand', message: 'brand taken' },
          { path: 'images.top', message: 'bad key' },
          { message: 'odd' },
        ],
      }),
    ).toEqual({ brand: 'brand taken', top: 'bad key', form: 'odd' });

    let fail: unknown = new ProblemError({
      title: 'Unprocessable',
      status: 422,
      errors: [{ path: 'year', message: 'year out of range' }],
    });
    const m = await mount((path) => {
      if (path === '/uploads') return UPLOAD_OK();
      throw fail;
    });
    type(m.el, 'brand', 'Mahou');
    await addTopPhoto(m);
    submit(m.el);
    await settle();
    expect(errorFor(m.el, 'year')).toBe('year out of range');
    expect(m.ctx.navigate).not.toHaveBeenCalled();
    type(m.el, 'year', '2020');
    expect(errorFor(m.el, 'year')).toBeNull();

    fail = new NetworkError('offline');
    submit(m.el);
    await settle();
    expect(errorFor(m.el, 'form')).toBe(t('form.saveFailed'));
    expect(q<HTMLInputElement>(m.el, '#cap-brand').value).toBe('Mahou');

    fail = new ProblemError({ title: 'Conflict', status: 409 });
    submit(m.el);
    await settle();
    expect(errorFor(m.el, 'form')).toBe(t('form.conflict'));
  });
});

describe('cap form — inputs', () => {
  it('[T-app-055] brand autocomplete: debounced GET /caps?q=, distinct brands from the collection, tap fills', async () => {
    expect(
      brandSuggestions('mah', [{ brand: 'Mahou' }, { brand: 'MAHOU' }, { brand: 'San Mahón' }, { brand: 'Estrella' }]),
    ).toEqual(['Mahou', 'San Mahón']);
    expect(brandSuggestions('Mahou', [{ brand: 'mahou' }])).toEqual([]);
    expect(brandSuggestions(' ', [{ brand: 'Mahou' }])).toEqual([]);

    const m = await mount(() =>
      wirePage([wireCap(1, { brand: 'Mahou' }), wireCap(2, { brand: 'Mahou Cinco Estrellas' })]),
    );
    type(m.el, 'brand', 'M');
    type(m.el, 'brand', 'Mah');
    await new Promise((r) => setTimeout(r, BRAND_DEBOUNCE_MS + 20));
    await settle();
    expect(m.calls).toHaveLength(1);
    expect(m.calls[0]?.path).toContain('q=Mah');
    const options = [...m.el.querySelectorAll<HTMLButtonElement>('.suggestion')];
    expect(options.map((o) => o.textContent)).toEqual(['Mahou', 'Mahou Cinco Estrellas']);
    options[1]?.click();
    expect(q<HTMLInputElement>(m.el, '#cap-brand').value).toBe('Mahou Cinco Estrellas');
    expect(q(m.el, '.suggestions').hidden).toBe(true);
  });

  it('[T-app-056] country search filters the ISO list; tags are chips (Enter adds, duplicates ignored, × removes)', async () => {
    expect(searchCountries('spa').map((c) => c.code)).toContain('ES');
    expect(searchCountries('es').map((c) => c.code)).toContain('ES');
    expect(searchCountries('').length).toBeGreaterThan(240);

    const m = await mount(() => undefined);
    const search = q<HTMLInputElement>(m.el, '.country-search');
    search.value = 'portu';
    search.dispatchEvent(new Event('input'));
    const codes = () => [...q<HTMLSelectElement>(m.el, '#cap-country').options].map((o) => o.value);
    expect(codes()).toEqual(['', 'PT']);
    choose(m.el, 'country', 'PT');
    search.value = 'spain';
    search.dispatchEvent(new Event('input'));
    expect(codes()).toEqual(['', 'PT', 'ES']);
    expect(q<HTMLSelectElement>(m.el, '#cap-country').value).toBe('PT');

    const tag = q<HTMLInputElement>(m.el, '.tag-input');
    for (const value of ['lager', 'lager', 'spain']) {
      tag.value = value;
      tag.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', cancelable: true }));
    }
    const chips = () => [...m.el.querySelectorAll('.chip--tag')].map((c) => c.firstChild?.textContent);
    expect(chips()).toEqual(['lager', 'spain']);
    q<HTMLButtonElement>(m.el, '.chip--tag .chip-remove').click();
    expect(chips()).toEqual(['spain']);
    tag.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace' }));
    expect(chips()).toEqual([]);
  });

  it('[T-app-057] Cancel leaves at once when nothing changed and asks before discarding unsaved changes', async () => {
    const m = await mount(() => undefined);
    const cancel = q<HTMLAnchorElement>(m.el, '[data-action="cancel"]');
    expect(cancel.getAttribute('href')).toBe('/scan');
    const clean = new MouseEvent('click', { bubbles: true, cancelable: true });
    cancel.dispatchEvent(clean);
    expect(clean.defaultPrevented).toBe(false);

    type(m.el, 'notes', 'half typed');
    const dirty = new MouseEvent('click', { bubbles: true, cancelable: true });
    cancel.dispatchEvent(dirty);
    expect(dirty.defaultPrevented).toBe(true);
    const sheet = q(m.el, '.sheet');
    expect(sheet.textContent).toContain(t('form.discardConfirm'));
    q<HTMLButtonElement>(sheet, 'button.button--secondary').click();
    await settle();
    expect(m.ctx.navigate).not.toHaveBeenCalled();
    expect(q<HTMLTextAreaElement>(m.el, '#cap-notes').value).toBe('half typed');

    cancel.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    q<HTMLButtonElement>(m.el, '.sheet [data-confirm]').click();
    await settle();
    expect(m.ctx.navigate).toHaveBeenCalledWith('/scan');
  });
});

describe('cap form — screens', () => {
  it('[T-app-058] /new is the empty form; /cap/:id/edit loads the cap into the edit form, with not-found and retry', async () => {
    const platform = fakePlatform('native');
    let reply: () => unknown = () => wireCap(4, { brand: 'Alhambra' });
    const request = vi.fn(async <T>(_path: string, opts: RequestOptions<T>): Promise<T> => {
      const parsed = opts.schema.safeParse(reply());
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
    const ctx: AppContext = {
      ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
      navigate: vi.fn(),
      skipSignIn: vi.fn(),
    };
    const newRoute = matchRoute('/new');
    const editRoute = matchRoute(`/cap/${ulid(4)}/edit`);
    if (!newRoute || !editRoute) throw new Error('routes');

    const empty = NewCapScreen(ctx, newRoute);
    expect(empty.dataset.mode).toBe('empty');
    expect(q<HTMLInputElement>(empty, '#cap-quantity').value).toBe('1');
    // Native: camera and library; web would only offer "Choose photo".
    expect(empty.querySelector('[data-pick="top:camera"]')).not.toBeNull();

    const edit = EditCapScreen(ctx, editRoute);
    await settle();
    expect(q(edit, '.cap-form').dataset.mode).toBe('edit');
    expect(q<HTMLInputElement>(edit, '#cap-brand').value).toBe('Alhambra');
    expect(q(edit, '[data-action="cancel"]').getAttribute('href')).toBe(`/cap/${ulid(4)}`);

    reply = () => {
      throw new ProblemError({ title: 'Not found', status: 404 });
    };
    const missing = EditCapScreen(ctx, editRoute);
    await settle();
    expect(missing.textContent).toContain(t('capDetail.notFound'));

    reply = () => {
      throw new NetworkError('offline');
    };
    const failed = EditCapScreen(ctx, editRoute);
    await settle();
    expect(failed.textContent).toContain(t('capDetail.loadFailed'));
    reply = () => wireCap(4, { brand: 'Alhambra' });
    q<HTMLButtonElement>(failed, 'button').click();
    await settle();
    expect(q<HTMLInputElement>(failed, '#cap-brand').value).toBe('Alhambra');
  });

  it('[T-app-059] the browser codec decodes with createImageBitmap (or an <img>) and encodes WebP on a canvas', async () => {
    const close = vi.fn();
    const bitmap = { width: 40, height: 30, close };
    const createImageBitmap = vi.fn(async () => bitmap as unknown as ImageBitmap);
    const draw = vi.fn();
    const canvas = document.createElement('canvas');
    vi.spyOn(canvas, 'getContext').mockReturnValue({ drawImage: draw, imageSmoothingQuality: 'low' } as never);
    vi.spyOn(canvas, 'toBlob').mockImplementation((cb, type) => cb(new Blob(['w'], { type: type ?? '' })));
    const doc = {
      createElement: (tag: string) => (tag === 'canvas' ? canvas : document.createElement(tag)),
    } as unknown as Document;
    const codec = browserCodec({ document: doc, createImageBitmap });
    const image = await resizeToWebp(new Blob(['x']), { codec });
    expect(createImageBitmap).toHaveBeenCalledWith(expect.any(Blob), { imageOrientation: 'from-image' });
    expect(draw).toHaveBeenCalledWith(bitmap, 0, 0, 40, 30, 0, 0, 40, 30);
    expect(image).toMatchObject({ width: 40, height: 30 });
    expect(close).toHaveBeenCalled();

    const broken = browserCodec({
      document: doc,
      createImageBitmap: vi.fn(async () => Promise.reject(new Error('x'))),
    });
    await expect(broken.decode(new Blob(['x']))).rejects.toBeInstanceOf(ImageDecodeError);

    vi.spyOn(canvas, 'getContext').mockReturnValue(null);
    await expect(codec.encode(image as never, { sx: 0, sy: 0, sw: 1, sh: 1 }, 1, 1, 0.85)).resolves.toBeNull();

    // No createImageBitmap: an <img> decodes from an object URL, which is revoked afterwards.
    const urls = { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() };
    const img = document.createElement('img');
    Object.defineProperty(img, 'naturalWidth', { value: 12 });
    Object.defineProperty(img, 'naturalHeight', { value: 8 });
    const imgDoc = {
      createElement: () => {
        setTimeout(() => img.onload?.(new Event('load')), 0);
        return img;
      },
    } as unknown as Document;
    const fallback = browserCodec({ document: imgDoc, createImageBitmap: undefined, URL: urls });
    await expect(fallback.decode(new Blob(['x']))).resolves.toMatchObject({ width: 12, height: 8 });
    expect(urls.revokeObjectURL).toHaveBeenCalledWith('blob:x');

    const badImg = document.createElement('img');
    const badDoc = {
      createElement: () => {
        setTimeout(() => badImg.onerror?.(new Event('error')), 0);
        return badImg;
      },
    } as unknown as Document;
    await expect(
      browserCodec({ document: badDoc, createImageBitmap: undefined, URL: urls }).decode(new Blob(['x'])),
    ).rejects.toBeInstanceOf(ImageDecodeError);

    // A failed PUT is an UploadFailedError.
    const request = vi.fn(async () => UPLOAD_OK());
    const api = { request: request as ApiClient['request'] };
    await expect(uploadImage(api, 'top', image, async () => Promise.reject(new Error('net')))).rejects.toBeInstanceOf(
      UploadFailedError,
    );
  });
});
