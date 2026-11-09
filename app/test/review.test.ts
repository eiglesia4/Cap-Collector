// AI review and re-identify tests (CAP-43; SCREENS.md #3; ADR-003 §1 pre-filled form, unsure fields highlighted, tick
// rule; shared `AnalyseResponse` / `CapInput` / `CapPatch`): the unsure rule, the Save body from the scan (no
// re-upload), Ask again (`known` = edited fields, untouched ones re-filled), Add underside, and re-identify applying
// only accepted suggestions. The API is a fake `request`; photos go through a fake `prepare` (happy-dom has no canvas).
import { AnalyseRequest, CapInput, CapPatch, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { ProblemError } from '../src/api/errors';
import { EMPTY_VALUES } from '../src/cap/form-model';
import type { CaptureSession } from '../src/capture/context';
import { knownFromValues, refill, reidentifyBody, suggestionsFor, unsureFields } from '../src/capture/review';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { CapPhoto } from '../src/images/resize';
import { matchRoute, pathFor } from '../src/router/routes';
import { ScanReviewScreen } from '../src/screens/cap-form-screen';
import { ReidentifyView } from '../src/screens/reidentify-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const SCAN_ID = ulid(43);
const CAP_ID = ulid(7);
const TOP_HASH = 'f0f0f03030f0f0f0';
const UNDER_HASH = '866796a6a6966796';
const MODEL = 'haiku-vision';

const photo = (dhash: string): CapPhoto => ({
  blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash,
});
const ref = (side: string): ImageRef => ({ key: `u1/${SCAN_ID}/${side}.webp`, width: 1024, height: 1024, bytes: 900 });

const identified = (extra: Partial<AnalyseResponse> = {}): AnalyseResponse => ({
  scanId: SCAN_ID,
  outcome: 'identified',
  fields: { brand: 'Mahou', country: 'ES', type: 'beer', year: 1998 },
  confidence: { brand: 0.92, country: 0.55, type: 0.81 },
  aiModel: MODEL,
  suggestions: [],
  ...extra,
});

function session(withUnderside = false): CaptureSession {
  return {
    scanId: SCAN_ID,
    useAi: true,
    top: { photo: photo(TOP_HASH), ref: ref('top') },
    ...(withUnderside ? { underside: { photo: photo(UNDER_HASH), ref: ref('underside') } } : {}),
    response: identified(),
  };
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}
type Answer = (path: string, method: string, body: unknown) => unknown;

async function setup(answer: Answer, kind: 'web' | 'native' = 'native') {
  const calls: Call[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    const value = answer(path, method, opts.body);
    if (value instanceof Error) throw value;
    const parsed = opts.schema.safeParse(value);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform(kind);
  const ctx: AppContext = {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  return { ctx, calls, platform };
}

const uploads: Answer = (path, _method, body) =>
  path === '/uploads'
    ? {
        key: `u1/${SCAN_ID}/${(body as { side: string }).side}.webp`,
        url: 'https://s3.test/put',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }
    : undefined;

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

const q = <T extends HTMLElement = HTMLElement>(el: ParentNode, selector: string) => el.querySelector<T>(selector);
const fieldEl = (el: ParentNode, name: string) => q(el, `.field[data-field="${name}"]`);
const type = (el: ParentNode, id: string, value: string) => {
  const input = q<HTMLInputElement>(el, `#cap-${id}`);
  if (!input) throw new Error(`missing #cap-${id}`);
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
};
const submit = (el: ParentNode) => q(el, 'form')?.dispatchEvent(new Event('submit', { cancelable: true }));

function review(ctx: AppContext): HTMLElement {
  const el = ScanReviewScreen(ctx, matchRoute('/scan/review') as never);
  document.body.replaceChildren(el);
  return el;
}

afterEach(() => document.body.replaceChildren());

describe('AI review (CAP-43)', () => {
  it('[T-app-078] fields below 0.7 confidence, or with none, are highlighted as unsure until edited', async () => {
    const rule = unsureFields({ brand: 0.92, country: 0.55, type: 0.7 });
    expect(rule.has('brand')).toBe(false);
    expect(rule.has('type')).toBe(false); // 0.7 is not below 0.7
    expect(rule.get('country')).toBe(0.55);
    expect(rule.has('variant') && rule.get('variant') === undefined).toBe(true);
    expect([...unsureFields(undefined).keys()]).toHaveLength(9);

    const { ctx } = await setup(() => undefined);
    ctx.capture.start(session());
    const el = review(ctx);
    expect(q(el, 'h1')?.textContent).toBe(t('scanReview.title'));
    expect(q(el, '.cap-form')?.dataset.mode ?? el.dataset.mode).toBe('ai-prefilled');
    expect(q<HTMLInputElement>(el, '#cap-brand')?.value).toBe('Mahou');
    expect(q<HTMLSelectElement>(el, '#cap-country')?.value).toBe('ES');
    expect(fieldEl(el, 'brand')?.classList.contains('field--unsure')).toBe(false);
    expect(fieldEl(el, 'country')?.classList.contains('field--unsure')).toBe(true);
    expect(q(el, '[data-hint-for="country"]')?.textContent).toBe('Unsure · 55 %');
    expect(q(el, '[data-hint-for="variant"]')?.textContent).toBe(t('review.unsure'));
    // Collector's own fields are never "unsure".
    expect(fieldEl(el, 'notes')?.classList.contains('field--unsure')).toBe(false);
    // The scan's photos are shown from memory.
    expect(el.querySelectorAll('.photo-slot[data-side="top"] img')).toHaveLength(1);

    type(el, 'variant', 'Clásica');
    expect(fieldEl(el, 'variant')?.classList.contains('field--unsure')).toBe(false);
    expect(q(el, '[data-hint-for="variant"]')?.hidden).toBe(true);

    // Without an identified scan (reload): nothing to review.
    ctx.capture.clear();
    const none = review(ctx);
    expect(q(none, '[role="status"]')?.textContent).toBe(t('scanDuplicate.noScan'));
    expect(q(none, 'form')).toBeNull();
  });

  it('[T-app-079] Save posts the scan’s images, hashes, model and brand confidence with source bedrock — no re-upload', async () => {
    const { ctx, calls } = await setup((path, _m, body) =>
      path === '/caps' ? { ...wireCap(9), ...(body as object) } : undefined,
    );
    ctx.capture.start(session(true));
    const el = review(ctx);
    submit(el);
    await settle();
    const post = calls.find((c) => c.path === '/caps');
    expect(post?.body).toEqual({
      brand: 'Mahou',
      country: 'ES',
      type: 'beer',
      year: 1998,
      tags: [],
      quantity: 1,
      forTrade: 0,
      images: { top: ref('top'), underside: ref('underside') },
      status: 'complete',
      source: `bedrock:${MODEL}`,
      dhash: TOP_HASH,
      dhashUnderside: UNDER_HASH,
      aiModel: MODEL,
      aiConfidence: 0.92,
    });
    expect(CapInput.safeParse(post?.body).success).toBe(true);
    // CAP-53: a new cap's Save first reads the albums for the next-free proposal; none here → saved without one.
    expect(calls.map((c) => c.path)).toEqual(['/albums', '/caps']);
    expect(ctx.navigate).toHaveBeenCalledWith(pathFor('capDetail', { id: ulid(9) }));
    expect(ctx.capture.current()).toBeNull();

    // "Save and flag needs review" as in CAP-25.
    const flagged = await setup((path, _m, body) =>
      path === '/caps' ? { ...wireCap(9), ...(body as object) } : undefined,
    );
    flagged.ctx.capture.start(session());
    const el2 = review(flagged.ctx);
    q(el2, '[data-save="needsReview"]')?.click();
    await settle();
    expect(flagged.calls.find((c) => c.path === '/caps')?.body).toMatchObject({
      status: 'needsReview',
      source: `bedrock:${MODEL}`,
    });
  });

  it('[T-app-080] Ask again sends known = edited fields and re-fills only the untouched ones; Add underside asks with both', async () => {
    // Pure rules.
    const values = { ...EMPTY_VALUES, tags: [], brand: 'Mahou', country: 'ES', year: '19x8', variant: '' };
    expect(knownFromValues(values, new Set(['brand', 'year', 'variant', 'notes']))).toEqual({ brand: 'Mahou' });
    expect(refill(values, new Set(['brand']), { brand: 'Other', country: 'PT' })).toEqual({
      country: 'PT',
      year: '',
    });

    const answers: (AnalyseResponse | Error)[] = [
      identified({ fields: { brand: 'Mahu', country: 'PT', type: 'beer' }, confidence: { brand: 0.4, country: 0.9 } }),
      identified({ outcome: 'unidentified', fields: undefined }),
      new ProblemError({ type: 'about:blank', title: 'AI unavailable', status: 503 }),
      identified({ outcome: 'duplicate', match: { capId: CAP_ID, hammingDistance: 30, by: 'brand' } }),
    ];
    const { ctx, calls } = await setup((path) => (path === '/scans/analyse' ? answers.shift() : undefined));
    ctx.capture.start(session(true));
    const el = review(ctx);
    expect(q(el, '[data-action="add-underside"]')?.hidden).toBe(true); // the scan already has one
    // "Export for external AI" (CAP-45): this scan on the Exchange screen.
    expect(q(el, '[data-action="export"]')?.getAttribute('href')).toBe(`/exchange?scanId=${SCAN_ID}`);
    type(el, 'brand', 'Mahou Clásica');
    q(el, '[data-action="ask-again"]')?.click();
    await settle();
    const ask = calls[0]?.body as AnalyseRequest;
    expect(AnalyseRequest.safeParse(ask).success).toBe(true);
    expect(ask).toEqual({
      scanId: SCAN_ID,
      dhash: TOP_HASH,
      dhashUnderside: UNDER_HASH,
      imageKeys: { top: ref('top').key, underside: ref('underside').key },
      known: { brand: 'Mahou Clásica' },
      useAi: true,
    });
    expect(q<HTMLInputElement>(el, '#cap-brand')?.value).toBe('Mahou Clásica'); // kept
    expect(q<HTMLSelectElement>(el, '#cap-country')?.value).toBe('PT'); // re-filled
    expect(q<HTMLInputElement>(el, '#cap-year')?.value).toBe(''); // the new answer has none
    expect(fieldEl(el, 'country')?.classList.contains('field--unsure')).toBe(false); // 0.9 now
    expect(fieldEl(el, 'brand')?.classList.contains('field--unsure')).toBe(false); // edited by the user
    expect(q(el, '[data-ai-status]')?.textContent).toBe(t('review.updated'));

    q(el, '[data-action="ask-again"]')?.click();
    await settle();
    expect(q(el, '[data-ai-status]')?.textContent).toBe(t('review.notIdentified'));
    expect(q<HTMLInputElement>(el, '#cap-brand')?.value).toBe('Mahou Clásica');

    q(el, '[data-action="ask-again"]')?.click();
    await settle();
    expect(q(el, '[data-ai-status]')?.textContent).toBe(t('scan.aiUnavailable'));

    q(el, '[data-action="ask-again"]')?.click();
    await settle();
    expect(ctx.navigate).toHaveBeenCalledWith('/scan/duplicate');
    expect(ctx.capture.current()?.response?.outcome).toBe('duplicate');

    // Add underside (missing): camera → circular crop + dHash → upload → Ask again with both images.
    const second = await setup((path, method, body) =>
      path === '/scans/analyse' ? identified() : uploads(path, method, body),
    );
    vi.mocked(second.platform.camera).mockResolvedValueOnce(new File(['u'], 'under.jpg'));
    second.ctx.capture.start(session());
    const prepare = vi.fn(async () => photo(UNDER_HASH));
    const put = vi.fn(async () => new Response(null, { status: 200 }));
    const { CapForm } = await import('../src/screens/cap-form-screen');
    const scan = second.ctx.capture.current() as CaptureSession;
    const form = CapForm(second.ctx, { mode: 'ai-prefilled', scan, prepare, put });
    document.body.replaceChildren(form);
    q(form, '[data-action="add-underside"]')?.click();
    await settle(12);
    expect(prepare).toHaveBeenCalledTimes(1);
    expect(second.calls.map((c) => c.path)).toEqual(['/uploads', '/scans/analyse']);
    expect(second.calls[1]?.body).toMatchObject({
      dhashUnderside: UNDER_HASH,
      imageKeys: { top: ref('top').key, underside: ref('underside').key },
    });
    expect(form.querySelectorAll('.photo-slot[data-side="underside"] img')).toHaveLength(1);
    expect(q(form, '[data-action="add-underside"]')?.hidden).toBe(true);
  });

  it('[T-app-081] re-identify sends the cap’s own images with capId + known; the PATCH holds only accepted suggestions', async () => {
    const stored = wireCap(7, {
      brand: 'Mahou',
      country: 'ES',
      dhash: TOP_HASH,
      imageUrls: { top: 'https://img.test/top.webp' },
    });
    const suggestion = identified({
      scanId: ulid(50),
      fields: { brand: 'Mahou', variant: 'Cinco Estrellas', country: 'PT', year: 1998 },
    });
    expect(suggestionsFor(stored as never, suggestion.fields).map((s) => s.field)).toEqual([
      'variant',
      'country',
      'year',
    ]);

    const { ctx, calls } = await setup((path, method, body) => {
      if (path === `/caps/${CAP_ID}` && method === 'GET') return stored;
      if (path === '/scans/analyse') return suggestion;
      if (path === `/caps/${CAP_ID}` && method === 'PATCH') return { ...stored, ...(body as object) };
      return undefined;
    });
    const el = ReidentifyView(ctx, CAP_ID, { newId: () => ulid(50) });
    document.body.replaceChildren(el);
    await settle();
    const ask = calls.find((c) => c.path === '/scans/analyse')?.body;
    expect(ask).toEqual(reidentifyBody(stored as never, ulid(50), TOP_HASH));
    expect(ask).toEqual({
      scanId: ulid(50),
      dhash: TOP_HASH,
      imageKeys: { top: `u1/${CAP_ID}/top.webp` },
      known: { brand: 'Mahou', country: 'ES' },
      capId: CAP_ID,
      useAi: true,
    });
    expect(calls.some((c) => c.path === '/uploads')).toBe(false);
    expect(q(el, 'h1')?.textContent).toBe(t('reidentify.title'));
    expect(q(el, '[data-hint-for="variant"]')?.textContent).toContain('AI suggests: Cinco Estrellas');
    // Nothing is applied until accepted.
    expect(q<HTMLInputElement>(el, '#cap-variant')?.value).toBe('');
    q(el, '[data-accept="variant"]')?.click();
    expect(q<HTMLInputElement>(el, '#cap-variant')?.value).toBe('Cinco Estrellas');
    expect(q(el, '[data-hint-for="variant"]')?.hidden).toBe(true);
    submit(el);
    await settle();
    const patch = calls.find((c) => c.method === 'PATCH');
    expect(patch?.body).toEqual({ variant: 'Cinco Estrellas', source: `bedrock:${MODEL}` });
    expect(CapPatch.safeParse(patch?.body).success).toBe(true);
    expect(ctx.navigate).toHaveBeenCalledWith(pathFor('capDetail', { id: CAP_ID }));

    // A cap with no stored hash: its photo is fetched and hashed like a scan.
    const unhashed = { ...stored, dhash: undefined };
    const fetchImage = vi.fn(async () => new Blob(['x']));
    const prepare = vi.fn(async () => photo(UNDER_HASH));
    const second = await setup((path) =>
      path === '/scans/analyse' ? identified({ fields: { brand: 'Mahou', country: 'ES' } }) : unhashed,
    );
    const el2 = ReidentifyView(second.ctx, CAP_ID, { fetchImage, prepare, newId: () => ulid(51) });
    await settle();
    expect(fetchImage).toHaveBeenCalledWith('https://img.test/top.webp');
    expect(second.calls[1]?.body).toMatchObject({ dhash: UNDER_HASH });
    expect(q(el2, '[role="status"]')?.textContent).toBe(t('reidentify.nothing'));

    // AI unavailable → message and retry.
    let down = true;
    const third = await setup((path) =>
      path === '/scans/analyse'
        ? down
          ? new ProblemError({ type: 'about:blank', title: 'AI unavailable', status: 503 })
          : suggestion
        : stored,
    );
    const el3 = ReidentifyView(third.ctx, CAP_ID, { newId: () => ulid(52) });
    await settle();
    expect(q(el3, '[role="alert"]')?.textContent).toBe(t('scan.aiUnavailable'));
    down = false;
    q(el3, '[data-action="retry"]')?.click();
    await settle();
    expect(q(el3, '[data-accept="country"]')).not.toBeNull();
  });
});
