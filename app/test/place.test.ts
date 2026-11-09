// Placing caps (CAP-53; physical-link.md § Keeping them in sync; SCREENS.md #6 "Where is it?", #7 move / swap;
// ADR-005; openapi PUT/DELETE /caps/{id}/location, GET /albums/{id}/next-free): the next-free proposal on save, the
// pocket picker (tapped cell, typed code), swap, the 409 → Swap offer, remove, the sheet grid long-press and "Put this
// one in A·3·17" from Already in collection. The API is a fake `request` routed by method + path.
import { CapInput, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { ProblemError } from '../src/api/errors';
import { LAST_ALBUM_KEY, defaultAlbum, typedLocation, wireLocation } from '../src/albums/place';
import type { CaptureSession } from '../src/capture/context';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { CapPhoto } from '../src/images/resize';
import { matchRoute, pathFor } from '../src/router/routes';
import { AlbumSheetScreen, LONG_PRESS_MS } from '../src/screens/album-sheet-screen';
import { CapDetailScreen } from '../src/screens/cap-detail-screen';
import { ScanReviewScreen } from '../src/screens/cap-form-screen';
import { ScanDuplicateScreen } from '../src/screens/scan-duplicate-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, memoryStore, shellContext } from './support/fakes';

const ALBUM_ID = ulid(900);
const ALBUM_C = ulid(902);
const BOX_ID = ulid(901);
const SCAN_ID = ulid(53);
const CAP_ID = ulid(7);
const CHIMAY = ulid(17);
const TS = '2026-11-09T10:00:00.000Z';

const album = (albumId: string, letter: string, sheets = 10) => ({
  albumId,
  letter,
  name: `Album ${letter}`,
  kind: 'album',
  sheets,
  cols: 6,
  rows: 7,
  createdAt: TS,
  updatedAt: TS,
});
const albumA = album(ALBUM_ID, 'A');
const albumC = album(ALBUM_C, 'C', 2);
const boxB = { albumId: BOX_ID, letter: 'B', name: 'Trade box', kind: 'box', createdAt: TS, updatedAt: TS };

const pocket = (n: number, capId: string, brand: string) => ({
  pocket: n,
  capId,
  brand,
  thumbKey: `u1/${capId}/t.webp`,
});
const sheetView = (sheet: number, pockets: ReturnType<typeof pocket>[], albumId = ALBUM_ID, letter = 'A') => ({
  albumId,
  letter,
  sheet,
  cols: 6,
  rows: 7,
  pockets,
});
const SHEETS: Record<string, unknown> = {
  [`/albums/${ALBUM_ID}/sheets/1`]: sheetView(1, [pocket(1, ulid(1), 'Mahou'), pocket(2, CAP_ID, 'Estrella')]),
  [`/albums/${ALBUM_ID}/sheets/3`]: sheetView(3, [pocket(17, CHIMAY, 'Chimay')]),
  [`/albums/${ALBUM_C}/sheets/1`]: sheetView(1, [], ALBUM_C, 'C'),
};

const at = (letter: string, sheet: number, n: number, albumId?: string) => ({
  kind: 'album' as const,
  album: letter,
  sheet,
  pocket: n,
  ...(albumId ? { albumId } : {}),
});

const photo: CapPhoto = {
  blob: new Blob([new Uint8Array(9)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash: 'f0f0f03030f0f0f0',
};
const ref = (side: string): ImageRef => ({ key: `u1/${SCAN_ID}/${side}.webp`, width: 1024, height: 1024, bytes: 900 });

function identified(target?: string): CaptureSession {
  return {
    scanId: SCAN_ID,
    useAi: true,
    ...(target ? { targetLocationCode: target } : {}),
    top: { photo, ref: ref('top') },
    response: {
      scanId: SCAN_ID,
      outcome: 'identified',
      fields: { brand: 'Mahou', country: 'ES' },
      confidence: { brand: 0.9, country: 0.9 },
      aiModel: 'haiku-vision',
      suggestions: [],
    } satisfies AnalyseResponse,
  };
}

type Answer = (path: string, method: string, body: unknown) => unknown;
interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** Albums A (10 sheets) and box B; sheets from SHEETS; next-free of A = A·3·17... unless overridden. */
const base =
  (extra: Answer = () => undefined): Answer =>
  (path, method, body) => {
    const answer = extra(path, method, body);
    if (answer !== undefined) return answer;
    if (method === 'GET' && path === '/albums') return [albumA, boxB];
    if (method === 'GET' && path === `/albums/${ALBUM_ID}/next-free`)
      return { albumId: ALBUM_ID, location: at('A', 3, 16), code: 'A·3·16' };
    if (method === 'GET' && path in SHEETS) return SHEETS[path];
    if (method === 'POST' && path === '/caps') return { ...wireCap(9), ...(body as object) };
    return undefined;
  };

async function setup(answer: Answer, store = memoryStore()) {
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
  const platform = fakePlatform('native', store);
  const ctx: AppContext = {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  return { ctx, calls, store };
}

async function settle(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

const $ = <E extends Element = HTMLElement>(selector: string, root: ParentNode = document): E => {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};
const click = async (selector: string) => {
  $(selector).click();
  await settle();
};
const message = () => $('.sheet-backdrop:last-child .sheet-message').textContent;
const posted = (calls: Call[]) =>
  calls.find((c) => c.method === 'POST' && c.path === '/caps')?.body as Record<string, unknown> | undefined;

function mountReview(ctx: AppContext, session: CaptureSession): HTMLElement {
  ctx.capture.start(session);
  const el = ScanReviewScreen(ctx, matchRoute('/scan/review') as never);
  document.body.replaceChildren(el);
  return el;
}
const save = async (el: HTMLElement) => {
  $('form', el).dispatchEvent(new Event('submit', { cancelable: true }));
  await settle();
};

const conflict = () =>
  new ProblemError({
    type: 'about:blank',
    title: 'Conflict',
    status: 409,
    detail: 'pocket A·3·17 is occupied',
    errors: [{ path: 'body.location', message: `occupied by cap ${CHIMAY}` }],
  });

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('next-free proposal on save', () => {
  it('[T-app-095] proposed only with an album and no target; Yes puts `location` in the POST, Not now does not', async () => {
    // The default album is the one last used (platform.store), else the first album by letter; boxes never.
    expect(defaultAlbum([boxB, albumC, albumA] as never, null)?.letter).toBe('A');
    expect(defaultAlbum([albumA, albumC] as never, 'C')?.letter).toBe('C');
    expect(defaultAlbum([albumA] as never, 'Z')?.letter).toBe('A');
    expect(defaultAlbum([boxB] as never, 'B')).toBeUndefined();

    // Yes: the next free pocket of A goes into the one POST, and A becomes the remembered album.
    {
      const { ctx, calls, store } = await setup(base());
      const el = mountReview(ctx, identified());
      await save(el);
      expect(message()).toBe(t('place.propose', { code: 'A·3·16' }));
      expect(posted(calls)).toBeUndefined(); // never silently
      await click('[data-action="yes"]');
      expect(posted(calls)?.location).toEqual(at('A', 3, 16));
      expect(CapInput.safeParse(posted(calls)).success).toBe(true);
      expect(store.data.get(LAST_ALBUM_KEY)).toBe('A');
      expect(ctx.navigate).toHaveBeenCalledWith(pathFor('capDetail', { id: ulid(9) }));
    }
    // Not now: saved without a location.
    {
      const { ctx, calls } = await setup(base());
      await save(mountReview(ctx, identified()));
      await click('[data-action="not-now"]');
      expect(posted(calls)).toBeDefined();
      expect(posted(calls)).not.toHaveProperty('location');
    }
    // A tap on the backdrop backs out: nothing saved, the form stays.
    {
      const { ctx, calls } = await setup(base());
      await save(mountReview(ctx, identified()));
      $('.sheet-backdrop').click();
      await settle();
      expect(posted(calls)).toBeUndefined();
      expect(ctx.navigate).not.toHaveBeenCalled();
    }
    // The album last used is the default (C), and a full album says so (only Choose… / Not now).
    {
      const { ctx, calls } = await setup(
        base((path) =>
          path === '/albums'
            ? [albumA, albumC]
            : path === `/albums/${ALBUM_C}/next-free`
              ? { albumId: ALBUM_C, location: null, code: null }
              : undefined,
        ),
        memoryStore({ [LAST_ALBUM_KEY]: 'C' }),
      );
      await save(mountReview(ctx, identified()));
      expect(calls.map((c) => c.path)).toContain(`/albums/${ALBUM_C}/next-free`);
      expect(message()).toBe(t('place.full', { letter: 'C' }));
      expect(document.querySelector('[data-action="yes"]')).toBeNull();
    }
    // Only a box: no proposal, saved straight away without a location.
    {
      const { ctx, calls } = await setup(base((path) => (path === '/albums' ? [boxB] : undefined)));
      await save(mountReview(ctx, identified()));
      expect(document.querySelector('.sheet-backdrop')).toBeNull();
      expect(posted(calls)).not.toHaveProperty('location');
    }
    // A scan started from a pocket (targetLocationCode): no proposal, no albums call, that pocket.
    {
      const { ctx, calls } = await setup(base());
      await save(mountReview(ctx, identified('A·1·5')));
      expect(calls.some((c) => c.path === '/albums')).toBe(false);
      expect(posted(calls)?.location).toEqual(at('A', 1, 5));
    }
    // The proposed pocket taken meanwhile: 409 → the form's conflict message, not a field error.
    {
      const { ctx } = await setup(
        base((path, method) => (method === 'POST' && path === '/caps' ? conflict() : undefined)),
      );
      const el = mountReview(ctx, identified());
      await save(el);
      await click('[data-action="yes"]');
      expect(el.textContent).toContain(t('form.conflict'));
    }
  });

  it('[T-app-096] the picker builds the Location from a tapped empty cell and from a typed code', async () => {
    // Typed codes are checked against the albums: any separator, lower case; unknown letter, out of range, nonsense.
    const albums = [albumA, boxB, albumC] as never;
    expect(typedLocation('a-2-7', albums)).toEqual({ ok: true, location: at('A', 2, 7) });
    expect(typedLocation('C·2·42', albums)).toEqual({ ok: true, location: at('C', 2, 42) });
    expect(typedLocation('C·3·1', albums)).toEqual({ ok: false, reason: 'outOfRange' });
    expect(typedLocation('A·1·43', albums)).toEqual({ ok: false, reason: 'outOfRange' });
    expect(typedLocation('B·1·1', albums)).toEqual({ ok: false, reason: 'noAlbum' });
    expect(typedLocation('Z·1·1', albums)).toEqual({ ok: false, reason: 'noAlbum' });
    expect(typedLocation('hello', albums)).toEqual({ ok: false, reason: 'invalid' });
    expect(wireLocation(at('A', 1, 2, ALBUM_ID))).toEqual(at('A', 1, 2));

    // Tapped cell: Choose… opens the grid at the proposed sheet; taken pockets are disabled, with their brand.
    {
      const { ctx, calls } = await setup(
        base((path) =>
          path === `/albums/${ALBUM_ID}/next-free`
            ? { albumId: ALBUM_ID, location: at('A', 1, 3), code: 'A·1·3' }
            : undefined,
        ),
      );
      await save(mountReview(ctx, identified()));
      await click('[data-action="choose"]');
      expect(message()).toBe(t('place.pickTitle'));
      const cells = [...document.querySelectorAll<HTMLElement>('.pick-grid .pocket')];
      expect(cells).toHaveLength(42);
      const taken = $<HTMLButtonElement>('.pick-grid [data-pocket="1"] button');
      expect(taken.disabled).toBe(true);
      expect(taken.getAttribute('aria-label')).toBe(t('place.cellTaken', { brand: 'Mahou', code: 'A·1·1' }));
      await click('.pick-grid [data-pocket="5"] button');
      expect(posted(calls)?.location).toEqual(at('A', 1, 5));
    }
    // Typed code: errors inline, then a valid one; Cancel in the picker goes back to the proposal.
    {
      const { ctx, calls } = await setup(base());
      await save(mountReview(ctx, identified()));
      await click('[data-action="choose"]');
      await click('.sheet-backdrop [data-action="cancel"]');
      expect(message()).toBe(t('place.propose', { code: 'A·3·16' }));
      await click('[data-action="choose"]');
      const input = $<HTMLInputElement>('.pick-code input');
      input.value = 'Z 1 1';
      $('.pick-code').dispatchEvent(new Event('submit', { cancelable: true }));
      expect($('.pick-sheet [role="alert"]:not([hidden])').textContent).toBe(t('place.codeNoAlbum'));
      input.value = 'a.2.7';
      $('.pick-code').dispatchEvent(new Event('submit', { cancelable: true }));
      await settle();
      expect(posted(calls)?.location).toEqual(at('A', 2, 7));
    }
  });
});

// ── Detail "Where is it?" ──

const stored = (fields: Record<string, unknown> = {}) =>
  wireCap(7, { brand: 'Estrella', location: at('A', 1, 2, ALBUM_ID), ...fields });

async function mountDetail(answer: Answer) {
  const setupResult = await setup(answer);
  const el = CapDetailScreen(setupResult.ctx, matchRoute(pathFor('capDetail', { id: CAP_ID })) as never);
  document.body.replaceChildren(el);
  await settle();
  return { ...setupResult, el };
}

const puts = (calls: Call[]) => calls.filter((c) => c.method === 'PUT').map((c) => ({ path: c.path, body: c.body }));

describe('"Where is it?" on Detail', () => {
  it('[T-app-097] Swap with… picks an occupied cell, confirms, sends swap: true and renders both caps from the response', async () => {
    const swapped = {
      cap: stored({ location: at('A', 3, 17, ALBUM_ID) }),
      swapped: wireCap(17, { brand: 'Chimay', location: at('A', 1, 2, ALBUM_ID) }),
    };
    const { el, calls } = await mountDetail(
      base((path, method) =>
        method === 'GET' && path === `/caps/${CAP_ID}` ? stored() : method === 'PUT' ? swapped : undefined,
      ),
    );
    expect($('.where-code', el).textContent).toBe('A·1·2');
    await click('[data-action="where"]');
    expect(message()).toBe(t('place.current', { name: 'Estrella', code: 'A·1·2' }));
    await click('[data-action="swap"]');
    expect(message()).toBe(t('place.pickSwapTitle'));
    // Swap mode: the cap's own pocket and empty pockets are not targets.
    expect($<HTMLButtonElement>('.pick-grid [data-pocket="2"] button').disabled).toBe(true);
    expect($<HTMLButtonElement>('.pick-grid [data-pocket="5"] button').disabled).toBe(true);
    $<HTMLSelectElement>('.pick-selects select[name="sheet"]').value = '3';
    $('.pick-selects select[name="sheet"]').dispatchEvent(new Event('change'));
    await settle();
    await click('.pick-grid [data-pocket="17"] button');
    expect(message()).toBe(t('place.swapConfirm', { brand: 'Chimay', code: 'A·3·17' }));
    expect(puts(calls)).toEqual([]);
    await click('[data-confirm]');
    expect(puts(calls)).toEqual([{ path: `/caps/${CAP_ID}/location`, body: { location: at('A', 3, 17), swap: true } }]);
    expect($('.where-code', el).textContent).toBe('A·3·17');
    expect($('.toast').textContent).toBe(t('place.swapped', { brand: 'Chimay' }));
  });

  it('[T-app-098] a 409 (pocket occupied) offers Swap in place, naming the occupant from its sheet', async () => {
    let attempt = 0;
    const { el, calls } = await mountDetail(
      base((path, method) => {
        if (method === 'GET' && path === `/caps/${CAP_ID}`) return stored();
        if (method === 'PUT') {
          attempt += 1;
          return attempt === 1
            ? conflict()
            : { cap: stored({ location: at('A', 3, 17, ALBUM_ID) }), swapped: wireCap(17, { brand: 'Chimay' }) };
        }
        return undefined;
      }),
    );
    await click('[data-action="where"]');
    await click('[data-action="move"]');
    const input = $<HTMLInputElement>('.pick-code input');
    input.value = 'A·3·17';
    $('.pick-code').dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(message()).toBe(t('place.moveConfirm', { name: 'Estrella', from: 'A·1·2', to: 'A·3·17' }));
    await click('[data-confirm]');
    expect(message()).toBe(t('place.occupiedSwap', { code: 'A·3·17', brand: 'Chimay' }));
    await click('[data-confirm]');
    expect(puts(calls).map((p) => p.body)).toEqual([
      { location: at('A', 3, 17) },
      { location: at('A', 3, 17), swap: true },
    ]);
    expect($('.where-code', el).textContent).toBe('A·3·17');

    // A cap with no location: "Assign to a pocket", no Remove; same pocket again → nothing sent.
    document.body.replaceChildren();
    const fresh = await mountDetail(
      base((path, method) =>
        method === 'GET' && path === `/caps/${CAP_ID}` ? stored({ location: undefined }) : undefined,
      ),
    );
    expect($('.where-code', fresh.el).textContent).toBe(t('capDetail.notInAlbum'));
    await click('[data-action="where"]');
    expect($('[data-action="move"]').textContent).toBe(t('place.assign'));
    expect(document.querySelector('[data-action="remove"]')).toBeNull();
  });

  it('[T-app-099] Remove from album confirms, sends DELETE and the row shows "Not in an album"', async () => {
    let cleared = false;
    const { el, calls } = await mountDetail(
      base((path, method) => {
        if (method === 'DELETE' && path === `/caps/${CAP_ID}/location`) {
          cleared = true;
          return undefined; // 204
        }
        if (method === 'GET' && path === `/caps/${CAP_ID}`) return cleared ? stored({ location: undefined }) : stored();
        return undefined;
      }),
    );
    await click('[data-action="where"]');
    await click('[data-action="remove"]');
    expect(message()).toBe(t('place.removeConfirm', { name: 'Estrella', code: 'A·1·2' }));
    await click('[data-confirm]');
    expect(calls.filter((c) => c.method === 'DELETE').map((c) => c.path)).toEqual([`/caps/${CAP_ID}/location`]);
    expect($('.where-code', el).textContent).toBe(t('capDetail.notInAlbum'));
    expect($('.toast').textContent).toBe(t('place.removed'));

    // Out of the album now: the sheet no longer offers Remove.
    await click('[data-action="where"]');
    expect(document.querySelector('[data-action="remove"]')).toBeNull();
  });
});

describe('album sheet long-press and Already in collection', () => {
  it('[T-app-100] a long-press on an occupied pocket opens Move / Swap / Remove for that cap and reloads the sheet', async () => {
    const { ctx, calls } = await setup(
      base((_p, method) =>
        method === 'PUT' ? { cap: wireCap(17, { brand: 'Chimay', location: at('A', 3, 18, ALBUM_ID) }) } : undefined,
      ),
    );
    const el = AlbumSheetScreen(ctx, matchRoute(`/albums/${ALBUM_ID}/sheets/3`) as never);
    document.body.replaceChildren(el);
    await settle();
    expect($('.sheet-hint', el).textContent).toBe(t('sheet.moveHint'));

    // Held for LONG_PRESS_MS: the sheet opens for Chimay, and the click that ends the press does not open Detail.
    vi.useFakeTimers();
    const cell = $('.sheet-grid [data-pocket="17"]', el);
    cell.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS);
    vi.useRealTimers();
    expect(message()).toBe(t('place.current', { name: 'Chimay', code: 'A·3·17' }));
    const link = $<HTMLAnchorElement>('a.pocket-link', cell);
    const navigated = new MouseEvent('click', { bubbles: true, cancelable: true });
    link.dispatchEvent(navigated);
    expect(navigated.defaultPrevented).toBe(true);

    // A short press is a normal tap.
    await click('.sheet-backdrop [data-action="cancel"]');
    vi.useFakeTimers();
    cell.dispatchEvent(new Event('pointerdown'));
    vi.advanceTimersByTime(LONG_PRESS_MS - 100);
    cell.dispatchEvent(new Event('pointerup'));
    vi.advanceTimersByTime(200);
    vi.useRealTimers();
    expect(document.querySelector('.place-sheet')).toBeNull();

    // Right-click (Mac) → Move → the empty pocket 18 → confirm → PUT; the sheet loads again.
    cell.dispatchEvent(new MouseEvent('contextmenu', { cancelable: true }));
    await click('[data-action="move"]');
    await click('.pick-grid [data-pocket="18"] button');
    expect(message()).toBe(t('place.moveConfirm', { name: 'Chimay', from: 'A·3·17', to: 'A·3·18' }));
    const before = calls.filter((c) => c.path === `/albums/${ALBUM_ID}/sheets/3`).length;
    await click('[data-confirm]');
    expect(puts(calls)).toEqual([{ path: `/caps/${CHIMAY}/location`, body: { location: at('A', 3, 18) } }]);
    expect(calls.filter((c) => c.path === `/albums/${ALBUM_ID}/sheets/3`).length).toBeGreaterThan(before);
    // Empty pockets have no long-press: they start a scan.
    expect($('.sheet-grid [data-pocket="5"] button', el).dataset.action).toBe('scan-pocket');
  });

  it('[T-app-101] Already in collection reached from a pocket offers "Put this one in A·3·17" and sends the same move as Detail', async () => {
    const duplicateSession = (target?: string): CaptureSession => ({
      scanId: SCAN_ID,
      useAi: true,
      ...(target ? { targetLocationCode: target } : {}),
      top: { photo, ref: ref('top') },
      response: {
        scanId: SCAN_ID,
        outcome: 'duplicate',
        match: { capId: CAP_ID, hammingDistance: 4, by: 'dhash' },
        suggestions: [],
      },
    });
    const { ctx, calls } = await setup(
      base((path, method) =>
        method === 'GET' && path === `/caps/${CAP_ID}`
          ? stored()
          : method === 'PUT'
            ? { cap: stored({ location: at('A', 3, 17, ALBUM_ID) }) }
            : undefined,
      ),
    );
    ctx.capture.start(duplicateSession('A·3·17'));
    const el = ScanDuplicateScreen(ctx, matchRoute('/scan/duplicate') as never);
    document.body.replaceChildren(el);
    await settle();
    const place = $('[data-action="place"]', el);
    expect(place.textContent).toBe(t('place.putHere', { code: 'A·3·17' }));
    await click('[data-action="place"]');
    // It already lives in A·1·2: a move, confirmed explicitly.
    expect(message()).toBe(t('place.moveConfirm', { name: 'Estrella', from: 'A·1·2', to: 'A·3·17' }));
    await click('[data-confirm]');
    expect(puts(calls)).toEqual([{ path: `/caps/${CAP_ID}/location`, body: { location: at('A', 3, 17) } }]);
    expect(ctx.navigate).toHaveBeenCalledWith(pathFor('capDetail', { id: CAP_ID }));
    expect(ctx.capture.current()).toBeNull();

    // From the Scan tab (no target): no such action.
    document.body.replaceChildren();
    ctx.capture.start(duplicateSession());
    const plain = ScanDuplicateScreen(ctx, matchRoute('/scan/duplicate') as never);
    document.body.replaceChildren(plain);
    await settle();
    expect(plain.querySelector('[data-action="place"]')).toBeNull();
  });
});
