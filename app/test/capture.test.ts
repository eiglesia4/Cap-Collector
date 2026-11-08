// Capture flow tests (CAP-41; SCREENS.md #2 and § Navigation; ADR-003 three outcomes; ADR-004; openapi
// § /scans/analyse with its 503): the flow state machine, the analyse request body, the Scan screen on web and
// iPhone, cancel clearing the scan context, and manual entry pre-filled from a capture. Photos go through a fake
// `prepare` (happy-dom has no canvas); the API is a fake `request`.
import { AnalyseRequest, Ulid, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { HttpError, ProblemError } from '../src/api/errors';
import { USE_AI_KEY } from '../src/capture/ai-setting';
import { createCaptureStore, type CaptureSession, type CaptureStore } from '../src/capture/context';
import {
  analyseBody,
  createCaptureFlow,
  manualEntryPath,
  routeFor,
  type CaptureDeps,
  type CaptureState,
} from '../src/capture/flow';
import { newUlid } from '../src/capture/ulid';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import { ImageDecodeError, type CapPhoto } from '../src/images/resize';
import { matchRoute } from '../src/router/routes';
import { NewCapScreen, scanFields } from '../src/screens/cap-form-screen';
import { ScanDuplicateScreen } from '../src/screens/scan-duplicate-screen';
import { ScanView } from '../src/screens/scan-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, memoryStore, shellContext } from './support/fakes';

const SCAN_ID = ulid(41);
const CAP_ID = ulid(7);
const TOP_HASH = 'f0f0f03030f0f0f0';
const UNDER_HASH = '866796a6a6966796';

const photo = (dhash: string): CapPhoto => ({
  blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash,
});

const ref = (side: string): ImageRef => ({ key: `u1/${SCAN_ID}/${side}.webp`, width: 1024, height: 1024, bytes: 900 });

const response = (outcome: AnalyseResponse['outcome'], extra: Partial<AnalyseResponse> = {}): AnalyseResponse => ({
  scanId: SCAN_ID,
  outcome,
  suggestions: [],
  ...extra,
});

const unavailable = () => new ProblemError({ type: 'about:blank', title: 'AI unavailable', status: 503 });

async function settle(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

/** A flow over mocked effects; `analyse` answers from `answers` in turn (an Error is thrown). */
function flowWith(answers: (AnalyseResponse | Error)[], over: Partial<CaptureDeps> = {}) {
  const store = createCaptureStore();
  const queue = [...answers];
  const deps = {
    store,
    prepare: vi.fn(async (file: Blob) => photo(file.size === 2 ? UNDER_HASH : TOP_HASH)),
    upload: vi.fn(async (side: 'top' | 'underside') => ref(side)),
    analyse: vi.fn(async () => {
      const next = queue.shift() ?? response('identified');
      if (next instanceof Error) throw next;
      return next;
    }),
    useAi: vi.fn(async () => true),
    newId: () => SCAN_ID,
    ...over,
  };
  const flow = createCaptureFlow(deps);
  const states: CaptureState['step'][] = [];
  flow.subscribe((s) => states.push(s.step));
  return { flow, deps, store, states };
}

const TOP_FILE = new Blob(['t']);
const UNDER_FILE = new Blob(['uu']);

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('capture flow', () => {
  it('[T-app-068] routes the three outcomes and the 503; retries only what failed; a bad photo means retake', async () => {
    expect(routeFor(response('duplicate', { match: { capId: CAP_ID, hammingDistance: 3, by: 'dhash' } }))).toBe(
      '/scan/duplicate',
    );
    expect(routeFor(response('identified'))).toBe('/scan/review');
    expect(routeFor(response('unidentified'))).toBe(`/new?scanId=${SCAN_ID}`);
    expect(manualEntryPath(SCAN_ID)).toBe(`/new?scanId=${SCAN_ID}`);

    for (const [answer, path] of [
      [response('duplicate'), '/scan/duplicate'],
      [response('identified'), '/scan/review'],
      [response('unidentified', { suggestions: ['Mahou'] }), `/new?scanId=${SCAN_ID}`],
    ] as const) {
      const { flow, store, states } = flowWith([answer]);
      await flow.shoot(TOP_FILE);
      expect(flow.state()).toEqual({ step: 'underside' });
      await flow.skipUnderside();
      expect(states).toEqual(['preparing', 'underside', 'uploading', 'analysing', 'done']);
      expect(flow.state()).toEqual({ step: 'done', path });
      // The analyse answer stays in the scan context for the review screens.
      expect(store.current()?.response).toEqual(answer);
    }

    // 503 (problem or bare status) → "AI unavailable"; Retry analyses again without uploading again.
    for (const error of [unavailable(), new HttpError(503)]) {
      const { flow, deps } = flowWith([error, response('identified')]);
      await flow.shoot(TOP_FILE);
      await flow.addUnderside(UNDER_FILE);
      expect(flow.state()).toEqual({ step: 'aiUnavailable' });
      await flow.retry();
      expect(flow.state()).toEqual({ step: 'done', path: '/scan/review' });
      expect(deps.upload).toHaveBeenCalledTimes(2);
      expect(deps.analyse).toHaveBeenCalledTimes(2);
    }

    // Any other analyse error is retryable as such.
    const other = flowWith([new HttpError(500)]);
    await other.flow.shoot(TOP_FILE);
    await other.flow.skipUnderside();
    expect(other.flow.state()).toEqual({ step: 'failed', kind: 'analyse' });

    // An upload failure retries the upload of the side that is missing only.
    const upload = vi
      .fn<(side: 'top' | 'underside') => Promise<ImageRef>>()
      .mockResolvedValueOnce(ref('top'))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(ref('underside'));
    const flaky = flowWith([response('unidentified')], { upload });
    await flaky.flow.shoot(TOP_FILE);
    await flaky.flow.addUnderside(UNDER_FILE);
    expect(flaky.flow.state()).toEqual({ step: 'failed', kind: 'upload' });
    await flaky.flow.retry();
    expect(upload.mock.calls.map(([side]) => side)).toEqual(['top', 'underside', 'underside']);
    expect(flaky.flow.state()).toEqual({ step: 'done', path: `/new?scanId=${SCAN_ID}` });

    // Unusable photos: top → Retake starts over; underside → back to the underside question.
    const prepare = vi.fn(async () => {
      throw new ImageDecodeError('bad');
    });
    const bad = flowWith([], { prepare });
    await bad.flow.shoot(TOP_FILE);
    expect(bad.flow.state()).toEqual({ step: 'failed', kind: 'photo', side: 'top' });
    await bad.flow.retry();
    expect(bad.flow.state()).toEqual({ step: 'idle' });
    expect(bad.store.current()).toBeNull();

    const badUnder = flowWith([]);
    await badUnder.flow.shoot(TOP_FILE);
    vi.mocked(badUnder.deps.prepare).mockRejectedValueOnce(new ImageDecodeError('bad'));
    await badUnder.flow.addUnderside(UNDER_FILE);
    expect(badUnder.flow.state()).toEqual({ step: 'failed', kind: 'photo', side: 'underside' });
    await badUnder.flow.retry();
    expect(badUnder.flow.state()).toEqual({ step: 'underside' });
    expect(badUnder.store.current()?.top?.photo.dhash).toBe(TOP_HASH);
  });

  it('[T-app-069] builds the analyse body from the scan context: useAi from settings, no capId on a fresh scan', async () => {
    const off = flowWith([response('unidentified')], { useAi: vi.fn(async () => false) });
    await off.flow.shoot(TOP_FILE);
    await off.flow.skipUnderside();
    const [first] = vi.mocked(off.deps.analyse).mock.calls[0] as unknown as [AnalyseRequest];
    expect(first).toEqual({ scanId: SCAN_ID, dhash: TOP_HASH, imageKeys: { top: ref('top').key }, useAi: false });
    expect(first).not.toHaveProperty('capId');
    expect(first).not.toHaveProperty('known');
    expect(AnalyseRequest.parse(first)).toEqual(first);

    const both = flowWith([response('identified')], { targetLocationCode: 'A·3·17' });
    await both.flow.shoot(TOP_FILE);
    await both.flow.addUnderside(UNDER_FILE);
    const [second] = vi.mocked(both.deps.analyse).mock.calls[0] as unknown as [AnalyseRequest];
    expect(second).toEqual({
      scanId: SCAN_ID,
      dhash: TOP_HASH,
      dhashUnderside: UNDER_HASH,
      imageKeys: { top: ref('top').key, underside: ref('underside').key },
      useAi: true,
      targetLocationCode: 'A·3·17',
    });
    expect(AnalyseRequest.parse(second)).toEqual(second);
    expect(() => analyseBody({ scanId: SCAN_ID, useAi: true })).toThrow(/not uploaded/);

    // Settings "off" is what the Scan screen reads; the scan id is a fresh ULID.
    const ids = new Set(Array.from({ length: 20 }, () => newUlid()));
    expect(ids.size).toBe(20);
    for (const id of ids) expect(Ulid.safeParse(id).success).toBe(true);
    expect(newUlid(0, (b) => b.fill(0))).toBe('0'.repeat(26));
    expect(newUlid(1_700_000_000_000, (b) => b.fill(31)).slice(10)).toBe('Z'.repeat(16));
    expect(newUlid(1_700_000_000_000).slice(0, 10)).toBe('01HF7YAT00');

    // `/new?scanId=…` reaches the form with its query.
    expect(matchRoute('/new', `?scanId=${SCAN_ID}`)).toMatchObject({
      route: { name: 'newCap' },
      query: { scanId: SCAN_ID },
      path: `/new?scanId=${SCAN_ID}`,
    });
  });
});

type Handler = (path: string, method: string, body: unknown) => unknown;

async function screen(kind: 'web' | 'native', handler: Handler, store = memoryStore()) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    const answer = await handler(path, method, opts.body);
    if (answer instanceof Error) throw answer;
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform(kind, store);
  const api = fakeApi({ request: request as ApiClient['request'] });
  const ctx: AppContext = { ...(await shellContext({ api, platform })), navigate: vi.fn(), skipSignIn: vi.fn() };
  const put = vi.fn(async () => new Response(null, { status: 200 }));
  const prepare = vi.fn(async (file: Blob) => photo(file.size === 2 ? UNDER_HASH : TOP_HASH));
  const el = ScanView(ctx, { prepare, put, newId: () => SCAN_ID });
  document.body.replaceChildren(el);
  return { el, ctx, calls, put, platform, prepare };
}

const uploads: Handler = (path, _method, body) =>
  path === '/uploads'
    ? {
        key: `u1/${SCAN_ID}/${(body as { side: string }).side}.webp`,
        url: 'https://s3.test/put',
        expiresAt: '2030-01-01T00:00:00.000Z',
      }
    : undefined;

const click = (root: ParentNode, selector: string) => {
  const el = root.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  el.click();
};

describe('scan screen', () => {
  it('[T-app-070] web shows "Upload photo" and never calls the camera; iPhone shoots; both reach the outcome', async () => {
    const web = await screen('web', (path, method, body) =>
      path === '/scans/analyse' ? response('identified') : uploads(path, method, body),
    );
    expect(web.el.querySelector('h1')?.textContent).toBe(t('scan.uploadTitle'));
    expect(web.el.querySelector('[data-action="shoot"]')).toBeNull();
    expect(web.el.querySelector('[data-action="manual"]')?.getAttribute('href')).toBe('/new');
    vi.mocked(web.platform.pickFiles).mockResolvedValueOnce([new File(['t'], 'top.jpg')]);
    click(web.el, '[data-action="upload"]');
    await settle();
    expect(web.el.dataset.step).toBe('underside');
    expect(web.el.querySelector('.scan-guide img')).not.toBeNull();
    expect(web.el.querySelector('[data-action="upload"]')?.textContent).toBe(t('scan.uploadUnderside'));
    vi.mocked(web.platform.pickFiles).mockResolvedValueOnce([new File(['uu'], 'under.jpg')]);
    click(web.el, '[data-action="upload"]');
    await settle();
    expect(web.platform.camera).not.toHaveBeenCalled();
    expect(web.platform.pickFiles).toHaveBeenCalledWith({ accept: 'image/*' });
    expect(web.calls.map((c) => c.path)).toEqual(['/uploads', '/uploads', '/scans/analyse']);
    expect(web.put).toHaveBeenCalledTimes(2);
    expect(web.ctx.navigate).toHaveBeenCalledWith('/scan/review');
    expect(web.ctx.capture.current()?.response?.outcome).toBe('identified');

    // iPhone: Shoot opens the camera; a cancelled camera leaves the screen as it was.
    const phone = await screen('native', (path, method, body) =>
      path === '/scans/analyse' ? unavailable() : uploads(path, method, body),
    );
    expect(phone.el.querySelector('h1')?.textContent).toBe(t('scan.title'));
    click(phone.el, '[data-action="shoot"]');
    await settle();
    expect(phone.el.dataset.step).toBe('idle');
    vi.mocked(phone.platform.camera).mockResolvedValueOnce(new File(['t'], 'top.jpg'));
    click(phone.el, '[data-action="shoot"]');
    await settle();
    click(phone.el, '[data-action="skip"]');
    await settle();
    // 503 → the sheet: Enter manually (this scan), Export for external AI (not yet), Retry.
    expect(phone.el.dataset.step).toBe('aiUnavailable');
    const sheet = phone.el.querySelector('[data-sheet="ai-unavailable"]');
    expect(sheet?.querySelector('[data-action="manual"]')?.getAttribute('href')).toBe(`/new?scanId=${SCAN_ID}`);
    expect(sheet?.querySelector<HTMLButtonElement>('[data-action="export"]')?.disabled).toBe(true);
    click(phone.el, '[data-action="retry"]');
    await settle();
    expect(phone.calls.filter((c) => c.path === '/scans/analyse')).toHaveLength(2);
    expect(phone.calls.filter((c) => c.path === '/uploads')).toHaveLength(1);

    // Settings "off" reaches the request; failures show their message with a retry.
    const off = await screen(
      'native',
      (path, method, body) => (path === '/scans/analyse' ? new HttpError(500) : uploads(path, method, body)),
      memoryStore({ [USE_AI_KEY]: 'off' }),
    );
    vi.mocked(off.platform.pickFiles).mockResolvedValueOnce([new File(['t'], 'top.jpg')]);
    click(off.el, '[data-action="library"]');
    await settle();
    click(off.el, '[data-action="skip"]');
    await settle();
    expect(off.calls.find((c) => c.path === '/scans/analyse')?.body).toMatchObject({ useAi: false });
    expect(off.el.querySelector('[role="alert"]')?.textContent).toBe(t('scan.analyseFailed'));
    expect(off.el.querySelector('[data-action="retry"]')?.textContent).toBe(t('common.retry'));

    const broken = await screen('native', uploads);
    broken.prepare.mockRejectedValueOnce(new ImageDecodeError('bad'));
    vi.mocked(broken.platform.camera).mockResolvedValueOnce(new File(['t'], 'top.jpg'));
    click(broken.el, '[data-action="shoot"]');
    await settle();
    expect(broken.el.querySelector('[role="alert"]')?.textContent).toBe(t('scan.photoFailed'));
    expect(broken.el.querySelector('[data-action="retry"]')?.textContent).toBe(t('scan.retake'));
  });

  it('[T-app-071] cancel clears the scan context; late results of the cancelled attempt are ignored', async () => {
    let finish: (p: CapPhoto) => void = () => undefined;
    const slow = flowWith([], { prepare: vi.fn(() => new Promise<CapPhoto>((resolve) => (finish = resolve))) });
    const shot = slow.flow.shoot(TOP_FILE);
    await flush();
    expect(slow.flow.state()).toEqual({ step: 'preparing', side: 'top' });
    expect(slow.store.current()?.scanId).toBe(SCAN_ID);
    slow.flow.cancel();
    finish(photo(TOP_HASH));
    await shot;
    expect(slow.flow.state()).toEqual({ step: 'idle' });
    expect(slow.store.current()).toBeNull();

    // Cancelled while analysing: the answer never routes.
    let answer: (r: AnalyseResponse) => void = () => undefined;
    const late = flowWith([], { analyse: vi.fn(() => new Promise<AnalyseResponse>((resolve) => (answer = resolve))) });
    await late.flow.shoot(TOP_FILE);
    const submitted = late.flow.skipUnderside();
    await flush();
    late.flow.cancel();
    answer(response('identified'));
    await submitted;
    expect(late.flow.state()).toEqual({ step: 'idle' });
    expect(late.states).not.toContain('done');

    // The screen's Cancel, a fresh Scan tab and Discard on an outcome screen all clear it.
    const s = await screen('native', uploads);
    vi.mocked(s.platform.camera).mockResolvedValueOnce(new File(['t'], 'top.jpg'));
    const cancel = s.el.querySelector<HTMLButtonElement>('[data-action="cancel"]');
    expect(cancel?.hidden).toBe(true);
    click(s.el, '[data-action="shoot"]');
    await settle();
    expect(s.ctx.capture.current()).not.toBeNull();
    expect(cancel?.hidden).toBe(false);
    cancel?.click();
    expect(s.ctx.capture.current()).toBeNull();
    expect(s.el.dataset.step).toBe('idle');
    expect(s.el.querySelector('.scan-guide img')).toBeNull();

    const store: CaptureStore = s.ctx.capture;
    store.start({ scanId: SCAN_ID, useAi: true });
    ScanView(s.ctx);
    expect(store.current()).toBeNull();

    store.start({ scanId: SCAN_ID, useAi: true });
    const outcome = ScanDuplicateScreen(s.ctx, matchRoute('/scan/duplicate') as never);
    expect(outcome.querySelector('h1')?.textContent).toBe(t('scanDuplicate.title'));
    click(outcome, '[data-action="discard"]');
    expect(outcome.querySelector('[data-action="discard"]')?.getAttribute('href')).toBe('/');
    expect(store.current()).toBeNull();
  });

  it('[T-app-072] manual entry of a capture: photos and AI suggestions pre-filled, hashes saved with the cap', async () => {
    const calls: { path: string; method: string; body: unknown }[] = [];
    const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
      calls.push({ path, method: opts.method ?? 'GET', body: opts.body });
      const answer = path === '/caps' ? { ...wireCap(7), ...(opts.body as object) } : undefined;
      const parsed = opts.schema.safeParse(answer);
      if (!parsed.success) throw parsed.error;
      return parsed.data;
    });
    const api = fakeApi({ request: request as ApiClient['request'] });
    const ctx: AppContext = {
      ...(await shellContext({ api, platform: fakePlatform('web') })),
      navigate: vi.fn(),
      skipSignIn: vi.fn(),
    };
    const session: CaptureSession = {
      scanId: SCAN_ID,
      useAi: true,
      top: { photo: photo(TOP_HASH), ref: ref('top') },
      underside: { photo: photo(UNDER_HASH), ref: ref('underside') },
      response: response('unidentified', { suggestions: ['Mahou', 'Mahon'], aiModel: 'haiku-vision' }),
    };
    ctx.capture.start(session);

    // Another scan id (or none) gets the plain empty form.
    const plain = NewCapScreen(ctx, matchRoute('/new', '?scanId=01JBF70A1B2C3D4E0000000000') as never);
    expect(plain.querySelector('.photo-slot[data-side="top"] img')).toBeNull();

    const el = NewCapScreen(ctx, matchRoute('/new', `?scanId=${SCAN_ID}`) as never);
    document.body.replaceChildren(el);
    expect(el.querySelectorAll('.photo-slot img')).toHaveLength(2);
    expect([...el.querySelectorAll('[data-brand]')].map((b) => b.getAttribute('data-brand'))).toEqual([
      'Mahou',
      'Mahon',
    ]);
    click(el, '[data-brand="Mahou"]');
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const post = calls.find((c) => c.path === '/caps');
    expect(post?.body).toMatchObject({
      brand: 'Mahou',
      source: 'manual',
      images: { top: ref('top'), underside: ref('underside') },
      dhash: TOP_HASH,
      dhashUnderside: UNDER_HASH,
      aiModel: 'haiku-vision',
    });
    expect(calls.filter((c) => c.path === '/uploads')).toHaveLength(0);
    expect(ctx.navigate).toHaveBeenCalledWith(`/cap/${CAP_ID}`);
    expect(ctx.capture.current()).toBeNull();

    // A replaced photo no longer carries the scan's hash.
    expect(
      scanFields(session, { top: { ...ref('top'), key: 'u1/other/top.webp' }, underside: ref('underside') }),
    ).toEqual({ dhashUnderside: UNDER_HASH, aiModel: 'haiku-vision' });
    expect(
      scanFields(
        { scanId: SCAN_ID, useAi: false, top: { photo: photo(TOP_HASH), ref: ref('top') } },
        {
          top: ref('top'),
        },
      ),
    ).toEqual({ dhash: TOP_HASH });
  });
});
