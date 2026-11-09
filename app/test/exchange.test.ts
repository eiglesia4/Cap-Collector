// Exchange with an external AI tests (CAP-45; ADR-007; exchange.md § Flow, § request.json, § Pending requests,
// § Batch; SCREENS.md #9): the request bundle and its zip, the batch `requests.json`, the upload validation (format,
// requestId, photo dHash, ignored fields), "Continue to review" (analyse with `useAi: false` + `known`, routed by
// outcome) and the request status PATCHes in order. The API is a fake `request`; photos go through a fake `prepare`.
import {
  AnalyseRequest,
  CapInput,
  EXCHANGE_FORMAT,
  EXCHANGE_INSTRUCTIONS,
  ExchangeBatchV1,
  ExchangeDocumentV1,
  type ExchangeRequestItem,
} from '@capcollector/shared';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import type { CaptureSession } from '../src/capture/context';
import type { AppContext } from '../src/context';
import { photoMismatch, readAnswer, readUpload } from '../src/exchange/answer';
import { batchZip, bundleItems, promptText, singleZip } from '../src/exchange/bundle';
import { continueToReview } from '../src/exchange/continue';
import { capSubject, scanSubject } from '../src/exchange/subjects';
import type { CapPhoto } from '../src/images/resize';
import { matchRoute } from '../src/router/routes';
import { ScanReviewScreen } from '../src/screens/cap-form-screen';
import { ExchangeView } from '../src/screens/exchange-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const SCAN_ID = ulid(45);
const CAP_ID = ulid(7);
const OTHER_CAP = ulid(8);
const REQ_ID = ulid(90);
const REQ_CAP = ulid(91);
const NEW_SCAN = ulid(46);
const TOP_HASH = 'f0f0f03030f0f0f0';
const UNDER_HASH = '866796a6a6966796';
const FAR_HASH = '0f0f0fcfcf0f0f0f';
const NOW = new Date('2026-11-09T10:00:00.000Z');

const webp = (n: number) => new Blob([new Uint8Array(n).fill(7)], { type: 'image/webp' });
const photo = (dhash: string, size = 900): CapPhoto => ({ blob: webp(size), width: 1024, height: 1024, dhash });

function openScan(): CaptureSession {
  return {
    scanId: SCAN_ID,
    useAi: true,
    top: { photo: photo(TOP_HASH), ref: { key: `u1/${SCAN_ID}/top.webp`, width: 1024, height: 1024 } },
    underside: {
      photo: photo(UNDER_HASH, 800),
      ref: { key: `u1/${SCAN_ID}/underside.webp`, width: 1024, height: 1024 },
    },
  };
}

const pendingItem = (extra: Partial<ExchangeRequestItem> = {}): ExchangeRequestItem => ({
  requestId: REQ_ID,
  createdAt: '2026-11-09T09:00:00.000Z',
  status: 'waiting',
  scanId: SCAN_ID,
  dhash: TOP_HASH,
  ...extra,
});

/** The bare `response` an external AI returns (exchange.md: "Return ONLY the JSON of `response`"). */
const bareResponse = (fields: Record<string, unknown> = {}) => ({
  provider: 'ChatGPT',
  model: 'gpt-4o',
  fields: { brand: 'Mahou', country: 'Spain', type: 'lager', year: '1998', ...fields },
  confidence: { brand: 0.9, country: 0.4, year: null },
  notes: 'Red cap with a star',
});

const jsonFile = (name: string, value: unknown) =>
  new File([JSON.stringify(value)], name, { type: 'application/json' });
const imageFile = (name: string, size = 900) => new File([new Uint8Array(size).fill(3)], name, { type: 'image/webp' });

interface Call {
  path: string;
  method: string;
  body: unknown;
}
type Answer = (path: string, method: string, body: unknown) => unknown;

async function setup(answer: Answer, kind: 'web' | 'native' = 'web') {
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

let ids = 0;
function view(
  ctx: AppContext,
  query: Record<string, string> = {},
  extra: { prepare?: (b: Blob) => Promise<CapPhoto> } = {},
) {
  ids = 0;
  const downloads: File[] = [];
  const copies: string[] = [];
  const el = ExchangeView(ctx, query, {
    newId: () => [REQ_ID, REQ_CAP, NEW_SCAN, ulid(92)][ids++] ?? ulid(99),
    now: () => NOW,
    put: async () => new Response(null, { status: 200 }),
    fetchImage: async (url) => webp(url.includes('underside') ? 800 : 900),
    prepare: extra.prepare ?? (async (blob) => photo(blob.size === 800 ? UNDER_HASH : TOP_HASH, blob.size)),
    download: (file) => downloads.push(file),
    copy: async (text) => {
      copies.push(text);
      return true;
    },
  });
  document.body.replaceChildren(el);
  return { el, downloads, copies };
}

async function settle(times = 12): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

const q = <T extends HTMLElement = HTMLElement>(el: ParentNode, selector: string) => el.querySelector<T>(selector);
const click = (el: ParentNode, selector: string) => {
  const target = q(el, selector);
  if (!target) throw new Error(`missing ${selector}`);
  target.click();
};

async function zipEntries(file: File): Promise<Record<string, Uint8Array>> {
  return unzipSync(new Uint8Array(await file.arrayBuffer()));
}

const storedCap = (n: number, extra: Record<string, unknown> = {}) =>
  wireCap(n, {
    images: {
      top: { key: `u1/${ulid(n)}/top.webp`, width: 1024, height: 1024 },
      underside: { key: `u1/${ulid(n)}/underside.webp`, width: 1024, height: 1024 },
    },
    imageUrls: { top: `https://s3.test/${n}/top`, underside: `https://s3.test/${n}/underside` },
    status: 'needsReview',
    country: 'ES',
    ...extra,
  });

afterEach(() => document.body.replaceChildren());

describe('request bundle (CAP-45)', () => {
  it('[T-app-082] request.json matches ExchangeDocumentV1 and the zip holds top.webp, underside.webp and request.json', async () => {
    const subject = scanSubject(openScan(), SCAN_ID);
    expect(subject).not.toBeNull();
    expect(scanSubject(openScan(), ulid(1))).toBeNull(); // another scan's context is not this scan
    const [item] = bundleItems([subject!], () => REQ_ID, NOW.toISOString());
    const doc = item!.document;
    expect(ExchangeDocumentV1.safeParse(doc).success).toBe(true);
    expect(doc).toMatchObject({
      format: EXCHANGE_FORMAT,
      version: 1,
      kind: 'request',
      requestId: REQ_ID,
      createdAt: NOW.toISOString(),
      scanId: SCAN_ID,
      photos: [
        { file: 'top.webp', side: 'top', dhash: TOP_HASH },
        { file: 'underside.webp', side: 'underside', dhash: UNDER_HASH },
      ],
      instructions: EXCHANGE_INSTRUCTIONS,
      known: {},
    });
    expect(doc.capId).toBeUndefined();
    expect(Object.values(doc.response.fields).every((v) => v === null)).toBe(true);
    const file = await singleZip(item!);
    expect(file.name).toBe(`cap-${SCAN_ID}-request.zip`);
    const entries = await zipEntries(file);
    expect(Object.keys(entries).sort()).toEqual(['request.json', 'top.webp', 'underside.webp']);
    expect(entries['top.webp']?.length).toBe(900);
    expect(JSON.parse(new TextDecoder().decode(entries['request.json']))).toEqual(doc);
    const prompt = promptText(doc);
    expect(prompt).toContain(EXCHANGE_INSTRUCTIONS);
    expect(prompt).toContain(REQ_ID);
    expect(prompt).toContain('"brand": null');

    // A stored cap: its photos from `imageUrls`, its hash computed when missing, `known` = what it has.
    const prepare = vi.fn(async (b: Blob) => photo(b.size === 800 ? UNDER_HASH : TOP_HASH));
    const stored = await capSubject(
      (await import('@capcollector/shared')).Cap.parse(storedCap(7, { dhash: 'aaaaaaaaaaaaaaaa' })),
      { fetchImage: async (url) => webp(url.includes('underside') ? 800 : 900), prepare },
    );
    expect(stored.capId).toBe(CAP_ID);
    expect(stored.photos.map((p) => [p.side, p.dhash])).toEqual([
      ['top', 'aaaaaaaaaaaaaaaa'],
      ['underside', UNDER_HASH],
    ]);
    expect(prepare).toHaveBeenCalledTimes(1); // only the side without a stored hash
    expect(stored.known).toEqual({ brand: 'Brand 7', country: 'ES' });

    // The screen: this scan → registered (`POST /exchange/requests`) → shared (iPhone); Copy prompt / JSON.
    const phone = await setup((path, method, body) => {
      if (path === '/exchange/requests' && method === 'POST')
        return { ...(body as object), createdAt: NOW.toISOString(), status: 'waiting' };
      if (path === '/exchange/requests') return [];
      return undefined;
    }, 'native');
    phone.ctx.capture.start(openScan());
    const { el, copies } = view(phone.ctx, { scanId: SCAN_ID });
    await settle();
    expect(q<HTMLInputElement>(el, '[data-scope="this"]')?.checked).toBe(true);
    click(el, '[data-action="create"]');
    await settle();
    const register = phone.calls.find((c) => c.path === '/exchange/requests' && c.method === 'POST');
    expect(register?.body).toEqual({ requestId: REQ_ID, dhash: TOP_HASH, scanId: SCAN_ID });
    expect(phone.platform.share).toHaveBeenCalledTimes(1);
    const shared = vi.mocked(phone.platform.share).mock.calls[0]?.[0].files?.[0];
    expect(shared?.name).toBe(`cap-${SCAN_ID}-request.zip`);
    click(el, '[data-action="copy-prompt"]');
    click(el, '[data-action="copy-json"]');
    await settle(2);
    expect(copies[0]).toContain(EXCHANGE_INSTRUCTIONS);
    expect(ExchangeDocumentV1.safeParse(JSON.parse(copies[1] ?? '')).success).toBe(true);
    expect(q(el, '[data-status="copy"]')?.hidden).toBe(false);
  });

  it('[T-app-083] a multi-cap request zips one folder per cap plus requests.json (ExchangeBatchV1)', async () => {
    const shared = await import('@capcollector/shared');
    const opts = { fetchImage: async (url: string) => webp(url.includes('underside') ? 800 : 900) };
    const subjects = [
      await capSubject(shared.Cap.parse(storedCap(7, { dhash: TOP_HASH, dhashUnderside: UNDER_HASH })), opts),
      await capSubject(shared.Cap.parse(storedCap(8, { dhash: FAR_HASH, dhashUnderside: UNDER_HASH })), opts),
    ];
    let n = 0;
    const items = bundleItems(subjects, () => [REQ_ID, REQ_CAP][n++] ?? '', NOW.toISOString());
    const file = await batchZip(items, '2026-11-09');
    expect(file.name).toBe('caps-2-2026-11-09-requests.zip');
    const entries = await zipEntries(file);
    expect(Object.keys(entries).sort()).toEqual([
      `cap-${CAP_ID}/top.webp`,
      `cap-${CAP_ID}/underside.webp`,
      `cap-${OTHER_CAP}/top.webp`,
      `cap-${OTHER_CAP}/underside.webp`,
      'requests.json',
    ]);
    const batch = ExchangeBatchV1.parse(JSON.parse(new TextDecoder().decode(entries['requests.json'])));
    expect(batch.map((d) => [d.requestId, d.capId, d.photos[0]?.file])).toEqual([
      [REQ_ID, CAP_ID, `cap-${CAP_ID}/top.webp`],
      [REQ_CAP, OTHER_CAP, `cap-${OTHER_CAP}/top.webp`],
    ]);
    await expect(batchZip([], '2026-11-09')).rejects.toThrow();

    // The screen: "All caps that need review" → one registration per cap, one download (Mac).
    const mac = await setup((path, method, body) => {
      if (path.startsWith('/caps?status=needsReview'))
        return { items: [storedCap(7, { dhash: TOP_HASH }), storedCap(8, { dhash: FAR_HASH })] };
      if (path === '/exchange/requests' && method === 'POST')
        return { ...(body as object), createdAt: NOW.toISOString(), status: 'waiting' };
      if (path === '/exchange/requests') return [];
      return undefined;
    });
    const { el, downloads } = view(mac.ctx);
    await settle();
    expect(q(el, '[data-scope="this"]')).toBeNull(); // no scan or cap given
    expect(q<HTMLInputElement>(el, '[data-scope="needsReview"]')?.checked).toBe(true);
    click(el, '[data-action="create"]');
    await settle();
    const registered = mac.calls.filter((c) => c.path === '/exchange/requests' && c.method === 'POST');
    expect(registered.map((c) => (c.body as { capId: string }).capId)).toEqual([CAP_ID, OTHER_CAP]);
    expect(downloads.map((f) => f.name)).toEqual(['caps-2-2026-11-09-requests.zip']);
    expect(q(el, '[data-action="copy-prompt"]')).toBeNull(); // a batch has no single prompt
    expect(mac.platform.share).not.toHaveBeenCalled();

    // Pick caps with nothing picked → explained, nothing registered.
    const pick = await setup((path) =>
      path.startsWith('/caps?') ? { items: [storedCap(7)] } : path === '/exchange/requests' ? [] : undefined,
    );
    const picker = view(pick.ctx);
    await settle();
    const radio = q<HTMLInputElement>(picker.el, '[data-scope="pick"]');
    radio!.checked = true;
    radio!.dispatchEvent(new Event('change'));
    await settle();
    expect(q(picker.el, `[data-pick-cap="${CAP_ID}"]`)).not.toBeNull();
    click(picker.el, '[data-action="create"]');
    await settle();
    expect(q(picker.el, '[data-status="request"]')?.getAttribute('role')).toBe('alert');
    expect(pick.calls.some((c) => c.method === 'POST')).toBe(false);
  });
});

describe('upload answer (CAP-45)', () => {
  it('[T-app-084] wrong format is rejected, an unknown requestId offers "attach to a cap", a photo mismatch only warns, ignored fields are reported', async () => {
    const pending = [pendingItem()];
    // Unknown format / version → rejected explicitly; a batch answer is V4; no JSON at all.
    const wrong = await readUpload([jsonFile('answer.json', { format: 'other.app', version: 1 })]);
    expect(readAnswer(wrong, pending)).toMatchObject({ ok: false, problem: { kind: 'format' } });
    const v9 = await readUpload([jsonFile('answer.json', { format: EXCHANGE_FORMAT, version: 9 })]);
    expect(readAnswer(v9, pending)).toMatchObject({ ok: false, problem: { kind: 'format' } });
    expect(readAnswer(await readUpload([jsonFile('a.json', [bareResponse()])]), pending)).toMatchObject({
      ok: false,
      problem: { kind: 'batch' },
    });
    expect(readAnswer(await readUpload([imageFile('top.webp')]), pending)).toMatchObject({
      ok: false,
      problem: { kind: 'noJson' },
    });
    expect(readAnswer(await readUpload([jsonFile('a.json', { hello: 1 })]), pending)).toMatchObject({
      ok: false,
      problem: { kind: 'invalid' },
    });

    // The zip back with the whole document: matched by its requestId; fields normalised, unknown keys ignored.
    const doc = {
      ...bundleItems([scanSubject(openScan(), SCAN_ID)!], () => REQ_ID, NOW.toISOString())[0]!.document,
      response: bareResponse({ colour: 'red', country: 'Atlantis' }),
    };
    const zip = new File(
      [zipSync({ 'request.json': strToU8(JSON.stringify(doc)), 'top.webp': new Uint8Array(900) })],
      'answer.zip',
      { type: 'application/zip' },
    );
    const contents = await readUpload([zip]);
    expect(contents.images.map((i) => i.name)).toEqual(['top.webp']);
    const read = readAnswer(contents, pending);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.answer.request?.requestId).toBe(REQ_ID);
    expect(read.answer.fields).toEqual({ brand: 'Mahou', type: 'beer', year: 1998 });
    expect(read.answer.ignored).toEqual(['colour']);
    expect(read.answer.problems).toEqual(['country: Atlantis']);
    expect(read.answer.notes).toBe('Red cap with a star\nignored: colour="red"\nnot understood: country: Atlantis');
    expect(read.answer.confidence).toEqual({ brand: 0.9, country: 0.4 });
    expect(photoMismatch(TOP_HASH, FAR_HASH)).toBe(true);
    expect(photoMismatch(TOP_HASH, TOP_HASH)).toBe(false);

    // The screen: an answer for no pending request → the attach-to-a-cap picker.
    const mac = await setup((path) => {
      if (path === '/exchange/requests') return pending;
      if (path.startsWith('/caps?')) return { items: [storedCap(7)] };
      return undefined;
    });
    const unknown = view(mac.ctx);
    await settle();
    vi.mocked(mac.platform.pickFiles).mockResolvedValueOnce([jsonFile('answer.json', { ...doc, requestId: ulid(77) })]);
    click(unknown.el, '[data-action="pick-answer"]');
    await settle();
    expect(q(unknown.el, '[data-match]')?.dataset.match).toBe('none');
    expect(q(unknown.el, '[data-attach]')).not.toBeNull();
    click(unknown.el, `[data-attach-cap="${CAP_ID}"]`);
    expect(q(unknown.el, `[data-attached="${CAP_ID}"]`)).not.toBeNull();

    // A wrong format through the screen: an alert, no answer panel.
    vi.mocked(mac.platform.pickFiles).mockResolvedValueOnce([jsonFile('answer.json', { format: 'nope', version: 1 })]);
    click(unknown.el, '[data-action="pick-answer"]');
    await settle();
    expect(q(unknown.el, '[data-status="upload"]')?.getAttribute('role')).toBe('alert');
    expect(q(unknown.el, '[data-status="upload"]')?.textContent).toContain('unknown exchange format');
    expect(q(unknown.el, '[data-match]')).toBeNull();

    // Bare response uploaded for a pending request, with a photo that is not the request's: warning, not a block.
    const mismatch = view(mac.ctx, { requestId: REQ_ID }, { prepare: async () => photo(FAR_HASH) });
    await settle();
    expect(q(mismatch.el, '[data-uploaded-for]')?.textContent).toContain(REQ_ID);
    vi.mocked(mac.platform.pickFiles).mockResolvedValueOnce([
      jsonFile('response.json', bareResponse({ colour: 'red' })),
      imageFile('photo.webp'),
    ]);
    click(mismatch.el, '[data-action="pick-answer"]');
    await settle();
    expect(q(mismatch.el, '[data-match]')?.dataset.match).toBe('request');
    expect(q(mismatch.el, '[data-warning="photo"]')).not.toBeNull();
    expect(q(mismatch.el, '[data-ignored]')?.textContent).toContain('colour');
    expect(q<HTMLButtonElement>(mismatch.el, '[data-action="continue"]')?.disabled).toBe(false);
    // The provider chip comes pre-selected from the answer's own `provider`.
    expect(q(mismatch.el, '[data-provider="chatgpt"]')?.getAttribute('aria-pressed')).toBe('true');
  });
});

describe('continue to review (CAP-45)', () => {
  const analysed = (outcome: 'duplicate' | 'unidentified', scanId = NEW_SCAN) =>
    outcome === 'duplicate'
      ? { scanId, outcome, match: { capId: CAP_ID, hammingDistance: 3, by: 'dhash' }, suggestions: [] }
      : { scanId, outcome, suggestions: [] };
  const uploadsTo = (body: unknown) => ({
    key: `u1/${NEW_SCAN}/${(body as { side: string }).side}.webp`,
    url: 'https://s3.test/put',
    expiresAt: '2030-01-01T00:00:00.000Z',
  });

  it('[T-app-085] continue-to-review analyses with useAi:false and known = the answer, and routes by outcome', async () => {
    const deps = async (outcome: 'duplicate' | 'unidentified', caps: unknown[] = []) => {
      const { ctx, calls } = await setup((path, method, body) => {
        if (path === '/uploads') return uploadsTo(body);
        if (path === '/scans/analyse') return analysed(outcome);
        if (path.startsWith('/caps?')) return { items: caps };
        return undefined;
      });
      return {
        ctx,
        calls,
        run: () =>
          continueToReview(
            {
              api: ctx.api,
              capture: ctx.capture,
              newId: () => NEW_SCAN,
              upload: async (side) => ({ key: `u1/${NEW_SCAN}/${side}.webp`, width: 1024, height: 1024 }),
            },
            {
              photos: { top: { photo: photo(TOP_HASH) } },
              fields: { brand: 'Mahou', variant: 'Clásica', country: 'ES' },
              confidence: { brand: 0.9 },
              source: 'external:chatgpt',
              requestId: REQ_ID,
            },
          ),
      };
    };

    // dHash near-match (server step 1) → Already in collection, with the answer's fields to diff.
    const dup = await deps('duplicate');
    expect(await dup.run()).toBe('/scan/duplicate');
    const body = dup.calls.find((c) => c.path === '/scans/analyse')?.body as AnalyseRequest;
    expect(AnalyseRequest.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({
      scanId: NEW_SCAN,
      dhash: TOP_HASH,
      imageKeys: { top: `u1/${NEW_SCAN}/top.webp` },
      known: { brand: 'Mahou', variant: 'Clásica', country: 'ES' },
      useAi: false,
    });
    const session = dup.ctx.capture.current();
    expect(session?.exchange).toEqual({ source: 'external:chatgpt', requestId: REQ_ID });
    expect(session?.response).toMatchObject({ outcome: 'duplicate', match: { capId: CAP_ID, by: 'dhash' } });
    expect(session?.response?.fields?.brand).toBe('Mahou');
    expect(dup.calls.some((c) => c.path.startsWith('/caps?'))).toBe(false); // no brand check after a dHash hit

    // No image match, same normalised brand + variant stored → duplicate by brand (step 3, on the client).
    const brand = await deps('unidentified', [
      storedCap(7, { brand: 'MAHOU', variant: 'clasica', dhash: FAR_HASH }),
      storedCap(8, { brand: 'Mahou', variant: 'Negra' }),
    ]);
    expect(await brand.run()).toBe('/scan/duplicate');
    expect(brand.ctx.capture.current()?.response?.match).toEqual({ capId: CAP_ID, hammingDistance: 64, by: 'brand' });
    expect(brand.calls.find((c) => c.path.startsWith('/caps?'))?.path).toContain('q=Mahou');

    // Nothing matches → AI review in `ai-prefilled` mode, unsure fields from the answer's confidence.
    const fresh = await deps('unidentified', [storedCap(8, { brand: 'Mahou', variant: 'Negra' })]);
    expect(await fresh.run()).toBe('/scan/review');
    expect(fresh.ctx.capture.current()?.response).toMatchObject({
      outcome: 'identified',
      fields: { brand: 'Mahou', country: 'ES' },
      confidence: { brand: 0.9 },
    });
    const review = ScanReviewScreen(fresh.ctx, matchRoute('/scan/review') as never);
    expect(review.dataset.mode).toBe('ai-prefilled');
    expect(q(review, '.field[data-field="country"]')?.classList.contains('field--unsure')).toBe(true);
    expect(q(review, '[data-action="export"]')).toBeNull(); // already an external answer
  });

  it('[T-app-086] the request moves waiting → answered (provider) on Continue, then → reviewed after the review saves', async () => {
    const pending = [pendingItem({ scanId: ulid(55) })];
    const { ctx, calls, platform } = await setup((path, method, body) => {
      if (path === '/exchange/requests') return pending;
      if (path.startsWith('/exchange/requests/'))
        return { ...pendingItem(), status: (body as { status: string }).status };
      if (path === '/uploads') return uploadsTo(body);
      if (path === '/scans/analyse') return analysed('unidentified');
      if (path.startsWith('/caps?')) return { items: [] };
      if (path === '/caps' && method === 'POST') return wireCap(9, body as Record<string, unknown>);
      return undefined;
    });
    const { el } = view(ctx, { requestId: REQ_ID });
    await settle();
    vi.mocked(platform.pickFiles).mockResolvedValueOnce([
      jsonFile('response.json', bareResponse({ provider: undefined })),
      imageFile('top.webp'),
    ]);
    click(el, '[data-action="pick-answer"]');
    await settle();
    // No provider picked yet → asked for, nothing sent.
    const before = calls.length;
    click(el, '[data-provider="other"]');
    click(el, '[data-action="continue"]');
    await settle();
    expect(q(el, '[data-status="continue"]')?.getAttribute('role')).toBe('alert');
    expect(calls.length).toBe(before);
    const name = q<HTMLInputElement>(el, '[data-provider-name]');
    name!.value = 'Le Chat';
    name!.dispatchEvent(new Event('input'));
    click(el, '[data-action="continue"]');
    await settle();
    expect(ctx.navigate).toHaveBeenLastCalledWith('/scan/review');
    const patches = () => calls.filter((c) => c.path.startsWith('/exchange/requests/'));
    expect(patches().map((c) => [c.method, c.body])).toEqual([['PATCH', { status: 'answered', provider: 'le-chat' }]]);

    // The review saves → POST /caps with the provider as author, the answer's notes, then PATCH reviewed.
    const review = ScanReviewScreen(ctx, matchRoute('/scan/review') as never);
    document.body.replaceChildren(review);
    expect(q<HTMLTextAreaElement>(review, '#cap-notes')?.value).toBe('Red cap with a star');
    q(review, 'form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const save = calls.find((c) => c.path === '/caps' && c.method === 'POST');
    expect(save?.body).toMatchObject({ brand: 'Mahou', country: 'ES', source: 'external:le-chat', aiConfidence: 0.9 });
    expect(CapInput.safeParse(save?.body).success).toBe(true);
    expect(patches().map((c) => (c.body as { status: string }).status)).toEqual(['answered', 'reviewed']);
    expect(calls.indexOf(save!)).toBeLessThan(calls.indexOf(patches()[1]!));
    expect(ctx.capture.current()).toBeNull();

    // A stored cap's request: the form in edit mode with "AI suggests", PATCH the cap, then reviewed.
    const capPending = [pendingItem({ requestId: REQ_CAP, capId: CAP_ID, scanId: undefined, status: 'answered' })];
    const second = await setup((path, method, body) => {
      if (path === '/exchange/requests') return capPending;
      if (path.startsWith('/exchange/requests/')) return { ...capPending[0], status: 'reviewed' };
      if (path === `/caps/${CAP_ID}` && method === 'GET') return storedCap(7, { brand: 'Mahu' });
      if (path === `/caps/${CAP_ID}` && method === 'PATCH') return storedCap(7, body as Record<string, unknown>);
      return undefined;
    });
    const capView = view(second.ctx, { requestId: REQ_CAP });
    await settle();
    vi.mocked(second.platform.pickFiles).mockResolvedValueOnce([jsonFile('response.json', bareResponse())]);
    click(capView.el, '[data-action="pick-answer"]');
    await settle();
    click(capView.el, '[data-provider="gemini"]');
    click(capView.el, '[data-action="continue"]');
    await settle();
    // Already answered: no second `answered`; the form shows the suggestion.
    expect(second.calls.some((c) => c.method === 'PATCH' && c.path.startsWith('/exchange/'))).toBe(false);
    click(capView.el, '[data-accept="brand"]');
    capView.el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    const capPatch = second.calls.find((c) => c.path === `/caps/${CAP_ID}` && c.method === 'PATCH');
    expect(capPatch?.body).toMatchObject({ brand: 'Mahou', source: 'external:gemini' });
    expect(second.calls.filter((c) => c.path.startsWith('/exchange/requests/')).map((c) => c.body)).toEqual([
      { status: 'reviewed' },
    ]);
  });
});
