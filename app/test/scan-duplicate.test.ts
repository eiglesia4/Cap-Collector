// "Already in collection" tests (CAP-42; SCREENS.md #4; ADR-003 "nothing overwritten without an explicit tick";
// ADR-008 §1 `variantOf`; shared `CapPatch`): the opt-in diff, the PATCH holding only the ticked changes, the variant
// path into the form, Discard. The API is a fake `request`; the scan context is built by hand (CAP-41 shape).
import { Cap, CapPatch, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { HttpError } from '../src/api/errors';
import type { CaptureSession } from '../src/capture/context';
import { diffRows, NO_TICKS, scanSource, updatePatch, variantPath } from '../src/capture/duplicate';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { CapPhoto } from '../src/images/resize';
import { matchRoute } from '../src/router/routes';
import { NewCapScreen } from '../src/screens/cap-form-screen';
import { ScanDuplicateScreen } from '../src/screens/scan-duplicate-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const SCAN_ID = ulid(42);
const CAP_ID = ulid(7);
const TOP_HASH = 'f0f0f03030f0f0f0';
const STORED_UNDER: ImageRef = { key: `u1/${CAP_ID}/underside.webp`, width: 1024, height: 1024 };

const photo = (dhash: string): CapPhoto => ({
  blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash,
});
const ref = (side: string): ImageRef => ({ key: `u1/${SCAN_ID}/${side}.webp`, width: 1024, height: 1024, bytes: 900 });

const stored = (extra: Record<string, unknown> = {}): Cap =>
  Cap.parse(
    wireCap(7, {
      brand: 'Mahou',
      variant: 'Clásica',
      country: 'ES',
      type: 'beer',
      quantity: 2,
      imageUrls: { top: 'https://img.test/top.webp' },
      ...extra,
    }),
  );

function session(match: Partial<NonNullable<AnalyseResponse['match']>> = {}, extra: Partial<AnalyseResponse> = {}) {
  const s: CaptureSession = {
    scanId: SCAN_ID,
    useAi: true,
    top: { photo: photo(TOP_HASH), ref: ref('top') },
    response: {
      scanId: SCAN_ID,
      outcome: 'duplicate',
      match: { capId: CAP_ID, hammingDistance: 6, by: 'dhash', ...match },
      suggestions: [],
      ...extra,
    },
  };
  return s;
}

/** AI-identified duplicate (`by: 'brand'`) whose fields differ from the stored cap in three places. */
const brandSession = () =>
  session(
    { by: 'brand', hammingDistance: 30 },
    {
      fields: { brand: 'Mahou', variant: 'Cinco Estrellas', country: 'ES', year: 1998, textOnCap: 'MAHOU 5*' },
      aiModel: 'haiku-vision',
    },
  );

interface Call {
  path: string;
  method: string;
  body: unknown;
}

async function setup(cap: Cap | Error = stored(), patchError?: Error) {
  const calls: Call[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const parse = (value: unknown): T => {
      const parsed = opts.schema.safeParse(value);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    };
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    if (path === `/caps/${CAP_ID}` && method === 'GET') {
      if (cap instanceof Error) throw cap;
      return parse(cap);
    }
    if (path === `/caps/${CAP_ID}` && method === 'PATCH') {
      if (patchError) throw patchError;
      return parse({ ...(cap as Cap), ...(opts.body as object) });
    }
    if (path === '/caps' && method === 'POST') return parse({ ...wireCap(9), ...(opts.body as object) });
    throw new Error(`unexpected ${method} ${path}`);
  });
  const api = fakeApi({ request: request as ApiClient['request'] });
  const ctx: AppContext = {
    ...(await shellContext({ api, platform: fakePlatform('native') })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  return { ctx, calls, request };
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

function render(ctx: AppContext): HTMLElement {
  const el = ScanDuplicateScreen(ctx, matchRoute('/scan/duplicate') as never);
  document.body.replaceChildren(el);
  return el;
}

const q = (el: HTMLElement, selector: string) => el.querySelector<HTMLElement>(selector);
const tick = (el: HTMLElement, selector: string) => {
  const box = q(el, selector) as HTMLInputElement;
  box.checked = !box.checked;
  box.dispatchEvent(new Event('change'));
};

afterEach(() => document.body.replaceChildren());

describe('Already in collection (CAP-42)', () => {
  it('[T-app-074] diff rows only for differing fields (stored empty counts), none ticked; both photos and the reason', async () => {
    // Pure rule: equal values and fields the scan did not bring give no row.
    const rows = diffRows(stored(), brandSession().response?.fields);
    expect(rows.map((r) => [r.field, r.stored, r.next])).toEqual([
      ['variant', 'Clásica', 'Cinco Estrellas'],
      ['year', undefined, 1998],
      ['textOnCap', undefined, 'MAHOU 5*'],
    ]);
    expect(diffRows(stored(), undefined)).toEqual([]);

    const { ctx, calls } = await setup();
    ctx.capture.start(brandSession());
    const el = render(ctx);
    expect(q(el, 'h1')?.textContent).toBe(t('scanDuplicate.title'));
    expect(q(el, '.duplicate-reason')?.textContent).toBe(t('scanDuplicate.byBrand'));
    await settle();
    expect(calls).toEqual([{ path: `/caps/${CAP_ID}`, method: 'GET', body: undefined }]);
    expect(q(el, '[data-photo="new"] img')).not.toBeNull();
    expect(q(el, '[data-photo="stored"] img')?.getAttribute('src')).toBe('https://img.test/top.webp');
    const items = [...el.querySelectorAll<HTMLElement>('.duplicate-diff li')];
    expect(items.map((li) => li.dataset.field)).toEqual(['variant', 'year', 'textOnCap']);
    expect(q(el, '[data-field="year"]')?.textContent).toContain(`${t('form.none')}${t('scanDuplicate.arrow')}1998`);
    expect([...el.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')].every((b) => !b.checked)).toBe(true);
    expect(q(el, '[data-action="quantity"]')?.getAttribute('aria-pressed')).toBe('false');
    expect((q(el, '[data-action="update"]') as HTMLButtonElement).disabled).toBe(true);

    // An image match (no AI call) has no fields to copy, says how close it was.
    const image = await setup();
    image.ctx.capture.start(session());
    const plain = render(image.ctx);
    expect(q(plain, '.duplicate-reason')?.textContent).toBe('Image match, distance 6 of 64');
    await settle();
    expect(q(plain, '[data-diff="none"]')).not.toBeNull();
  });

  it('[T-app-075] Update existing PATCHes exactly the ticked fields (+1 quantity, replaced top photo) → Detail', async () => {
    // Pure rule: nothing ticked → no PATCH; shortcuts only → the user is the author.
    const s = brandSession();
    const cap = stored({
      images: { top: { key: `u1/${CAP_ID}/top.webp`, width: 1024, height: 1024 }, underside: STORED_UNDER },
    });
    const rows = diffRows(cap, s.response?.fields);
    expect(updatePatch(cap, rows, NO_TICKS, s)).toBeNull();
    expect(updatePatch(cap, rows, { ...NO_TICKS, quantity: true }, s)).toEqual({ quantity: 3, source: 'manual' });
    expect(updatePatch(cap, rows, { ...NO_TICKS, photo: true }, s)).toEqual({
      images: { top: ref('top'), underside: STORED_UNDER },
      dhash: TOP_HASH,
      source: 'manual',
    });
    expect(scanSource(s)).toBe('bedrock:haiku-vision');
    expect(scanSource(session())).toBe('manual');

    const { ctx, calls } = await setup(cap);
    ctx.capture.start(s);
    const el = render(ctx);
    await settle();
    tick(el, 'input[name="year"]');
    expect((q(el, '[data-action="update"]') as HTMLButtonElement).disabled).toBe(false);
    tick(el, 'input[name="variant"]');
    tick(el, 'input[name="variant"]'); // ticked and unticked again: not sent
    q(el, '[data-action="quantity"]')?.click();
    expect(q(el, '[data-action="quantity"]')?.getAttribute('aria-pressed')).toBe('true');
    tick(el, '[data-action="photo"]');
    q(el, '[data-action="update"]')?.click();
    await settle();

    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.path).toBe(`/caps/${CAP_ID}`);
    expect(patch?.body).toEqual({
      year: 1998,
      quantity: 3,
      images: { top: ref('top'), underside: STORED_UNDER },
      dhash: TOP_HASH,
      source: 'bedrock:haiku-vision',
    });
    expect(CapPatch.safeParse(patch?.body).success).toBe(true);
    expect(ctx.navigate).toHaveBeenCalledWith(`/cap/${CAP_ID}`);
    expect(ctx.capture.current()).toBeNull();
  });

  it('[T-app-076] It’s a variant opens the form pre-filled with the scan’s values and saves with variantOf', async () => {
    expect(variantPath(SCAN_ID, CAP_ID)).toBe(`/new?scanId=${SCAN_ID}&variantOf=${CAP_ID}`);
    const { ctx, calls } = await setup();
    const s = brandSession();
    ctx.capture.start(s);
    const el = render(ctx);
    await settle();
    expect(q(el, '[data-action="variant"]')?.getAttribute('href')).toBe(variantPath(SCAN_ID, CAP_ID));

    // A variantOf that is not this scan's match gives the plain scan form.
    const other = NewCapScreen(ctx, matchRoute('/new', `?scanId=${SCAN_ID}&variantOf=${ulid(99)}`) as never);
    expect(q(other, 'h1')?.textContent).toBe(t('newCap.title'));
    expect((q(other, '#cap-brand') as HTMLInputElement | null)?.value ?? '').toBe('');

    const form = NewCapScreen(ctx, matchRoute('/new', `?scanId=${SCAN_ID}&variantOf=${CAP_ID}`) as never);
    document.body.replaceChildren(form);
    expect(q(form, 'h1')?.textContent).toBe(t('newCap.variantTitle'));
    expect((q(form, '#cap-brand') as HTMLInputElement).value).toBe('Mahou');
    expect((q(form, '#cap-variant') as HTMLInputElement).value).toBe('Cinco Estrellas');
    expect((q(form, '#cap-year') as HTMLInputElement).value).toBe('1998');
    form.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const post = calls.find((c) => c.path === '/caps');
    expect(post?.body).toMatchObject({
      brand: 'Mahou',
      variant: 'Cinco Estrellas',
      country: 'ES',
      year: 1998,
      textOnCap: 'MAHOU 5*',
      variantOf: CAP_ID,
      source: 'bedrock:haiku-vision',
      images: { top: ref('top') },
      dhash: TOP_HASH,
    });
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    expect(ctx.navigate).toHaveBeenCalledWith(`/cap/${ulid(9)}`);
  });

  it('[T-app-077] Discard → Collection and clears the context; no scan, load and update failures', async () => {
    const { ctx, calls } = await setup();
    ctx.capture.start(session());
    const el = render(ctx);
    await settle();
    const discard = q(el, '[data-action="discard"]');
    expect(discard?.getAttribute('href')).toBe('/');
    discard?.click();
    expect(ctx.capture.current()).toBeNull();
    expect(calls.every((c) => c.method === 'GET')).toBe(true); // no delete of the uploaded images

    // Reached without an open duplicate scan (reload): nothing to review, back to Scan.
    const none = render(ctx);
    expect(q(none, '[role="status"]')?.textContent).toBe(t('scanDuplicate.noScan'));
    expect(calls).toHaveLength(1);

    // The stored cap fails to load → retry; a 404 has no retry.
    const failing = await setup(new HttpError(500));
    failing.ctx.capture.start(session());
    const broken = render(failing.ctx);
    await settle();
    expect(q(broken, '[role="alert"]')?.textContent).toBe(t('capDetail.loadFailed'));
    q(broken, '[data-action="retry"]')?.click();
    await settle();
    expect(failing.calls).toHaveLength(2);
    const gone = await setup(new HttpError(404));
    gone.ctx.capture.start(session());
    const missing = render(gone.ctx);
    await settle();
    expect(q(missing, '[role="alert"]')?.textContent).toBe(t('capDetail.notFound'));
    expect(q(missing, '[data-action="retry"]')).toBeNull();

    // The PATCH fails: the screen stays, says so, and keeps the context for another try.
    const rejected = await setup(stored(), new HttpError(500));
    rejected.ctx.capture.start(session());
    const kept = render(rejected.ctx);
    await settle();
    q(kept, '[data-action="quantity"]')?.click();
    q(kept, '[data-action="update"]')?.click();
    await settle();
    expect(q(kept, '.duplicate-body [role="alert"]')?.textContent).toBe(t('scanDuplicate.updateFailed'));
    expect(q(kept, '.duplicate-body [role="alert"]')?.hidden).toBe(false);
    expect(rejected.ctx.navigate).not.toHaveBeenCalled();
    expect(rejected.ctx.capture.current()).not.toBeNull();
  });
});
