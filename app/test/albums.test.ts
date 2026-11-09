// Albums and the album sheet (CAP-52; SCREENS.md #7 and § Navigation; ADR-005; physical-link.md § The album,
// § Location code; openapi /albums, /albums/{id}, /albums/{id}/sheets/{n}): the sheet grid (cols × rows, row-major,
// occupied pockets in their cells), an empty pocket starting a scan pre-assigned to it and the cap landing there,
// the "+ New" / Edit sheet (POST / PATCH bodies, 409 inline), the albums list usage, and `A·3` in the search.
import { Album, Cap, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { ProblemError } from '../src/api/errors';
import { rememberCap } from '../src/albums/known';
import {
  albumPatch,
  albumValues,
  nextFreeLetter,
  parseSheetCode,
  pocketLocation,
  sheetCells,
  validateAlbum,
  newAlbumValues,
} from '../src/albums/model';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { CapPhoto } from '../src/images/resize';
import { matchRoute, type RouteMatch } from '../src/router/routes';
import { AlbumSheetScreen } from '../src/screens/album-sheet-screen';
import { AlbumsScreen } from '../src/screens/albums-screen';
import { NewCapScreen, ScanReviewScreen } from '../src/screens/cap-form-screen';
import { CollectionScreen, SEARCH_DEBOUNCE_MS } from '../src/screens/collection-screen';
import { ScanScreen, ScanView } from '../src/screens/scan-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const ALBUM_ID = ulid(900);
const BOX_ID = ulid(901);
const SCAN_ID = ulid(52);
const TS = '2026-11-09T10:00:00.000Z';

const albumA = {
  albumId: ALBUM_ID,
  letter: 'A',
  name: 'Leuchtturm GRANDE',
  kind: 'album',
  sheets: 10,
  cols: 6,
  rows: 7,
  createdAt: TS,
  updatedAt: TS,
};
const boxB = { albumId: BOX_ID, letter: 'B', name: 'Trade box', kind: 'box', createdAt: TS, updatedAt: TS };

const sheet3 = {
  albumId: ALBUM_ID,
  letter: 'A',
  sheet: 3,
  cols: 6,
  rows: 7,
  pockets: [
    { pocket: 1, capId: ulid(1), brand: 'Mahou', variant: 'Clásica', thumbKey: `u1/${ulid(1)}/top.webp` },
    { pocket: 17, capId: ulid(17), brand: 'Chimay', thumbKey: `u1/${ulid(17)}/top.webp` },
    { pocket: 42, capId: ulid(42), brand: 'Estrella', thumbKey: `u1/${ulid(42)}/top.webp` },
  ],
};

type Handler = (path: string, method: string, body: unknown) => unknown;
interface Call {
  path: string;
  method: string;
  body: unknown;
}

async function context(handler: Handler, kind: 'web' | 'native' = 'native') {
  const calls: Call[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    const answer = await handler(path, method, opts.body);
    if (answer instanceof Error) throw answer;
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const api = fakeApi({ request: request as ApiClient['request'] });
  const ctx: AppContext = {
    ...(await shellContext({ api, platform: fakePlatform(kind) })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  return { ctx, calls };
}

function route(path: string, search = ''): RouteMatch {
  const match = matchRoute(path, search);
  if (!match) throw new Error(`no route ${path}`);
  return match;
}

async function settle(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) await flush();
}

const $ = <E extends Element = HTMLElement>(root: ParentNode, selector: string): E => {
  const el = root.querySelector<E>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
};

function type(input: HTMLInputElement | HTMLSelectElement, value: string): void {
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
}

const submit = (root: Element) =>
  (root instanceof HTMLFormElement ? root : $(root, 'form')).dispatchEvent(new Event('submit', { cancelable: true }));

const conflict = (detail?: string) =>
  new ProblemError({ type: 'about:blank', title: 'Conflict', status: 409, ...(detail ? { detail } : {}) });

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('album sheet', () => {
  it('[T-app-087] the grid renders cols × rows pockets numbered row-major, occupied ones in their cells (pocketToCell)', async () => {
    const { ctx, calls } = await context((path) =>
      path === '/albums' ? [albumA, boxB] : path === `/albums/${ALBUM_ID}/sheets/3` ? sheet3 : undefined,
    );
    // Chimay was opened on Detail: its presigned image serves the cell; the others get the placeholder + number.
    rememberCap(ctx, Cap.parse(wireCap(17, { brand: 'Chimay', imageUrls: { top: 'https://img.test/17.webp' } })));
    const el = AlbumSheetScreen(ctx, route(`/albums/${ALBUM_ID}/sheets/3`));
    document.body.replaceChildren(el);
    await settle();

    expect(calls.map((c) => c.path).sort()).toEqual(['/albums', `/albums/${ALBUM_ID}/sheets/3`]);
    expect($(el, '.sheet-picker summary').textContent).toBe(
      t('sheet.title', { letter: 'A', sheet: '3', sheets: '10' }),
    );
    const cells = [...el.querySelectorAll<HTMLElement>('.sheet-grid > .pocket')];
    expect(cells).toHaveLength(42);
    expect(cells.map((c) => Number(c.dataset.pocket))).toEqual(Array.from({ length: 42 }, (_, i) => i + 1));
    // physical-link.md § Location code: A·3·17 = row 3, column 5.
    const p17 = $(el, '[data-pocket="17"]');
    expect([p17.dataset.row, p17.dataset.col, p17.dataset.code]).toEqual(['3', '5', 'A·3·17']);
    expect($(el, '[data-pocket="42"]').dataset).toMatchObject({ row: '7', col: '6' });
    expect($(el, '[data-pocket="7"]').dataset).toMatchObject({ row: '2', col: '1' });

    const occupied = cells.filter((c) => c.classList.contains('pocket--occupied')).map((c) => c.dataset.pocket);
    expect(occupied).toEqual(['1', '17', '42']);
    expect($(p17, 'a').getAttribute('href')).toBe(`/cap/${ulid(17)}`);
    expect($(p17, 'img.pocket-thumb').getAttribute('src')).toBe('https://img.test/17.webp');
    expect($(p17, '.pocket-brand').textContent).toBe('Chimay');
    const p1 = $(el, '[data-pocket="1"]');
    expect($(p1, '.cap-thumb--placeholder').textContent).toBe('1');
    expect($(p1, 'a').getAttribute('aria-label')).toBe(
      t('sheet.pocketCap', { brand: 'Mahou · Clásica', code: 'A·3·1' }),
    );
    expect($(el, '[data-pocket="2"] .pocket-number').textContent).toBe('2');

    // ‹ › and the sheet picker change sheet.
    $(el, '[data-action="prev-sheet"]').click();
    expect(ctx.navigate).toHaveBeenLastCalledWith(`/albums/${ALBUM_ID}/sheets/2`);
    $(el, '[data-action="next-sheet"]').click();
    expect(ctx.navigate).toHaveBeenLastCalledWith(`/albums/${ALBUM_ID}/sheets/4`);
    expect(el.querySelectorAll('.sheet-picker-menu [data-sheet]')).toHaveLength(10);
    $(el, '.sheet-picker-menu [data-sheet="9"]').click();
    expect(ctx.navigate).toHaveBeenLastCalledWith(`/albums/${ALBUM_ID}/sheets/9`);

    // The model on its own: a 2 × 2 sheet.
    const small = sheetCells({ albumId: ALBUM_ID, letter: 'C', sheet: 1, cols: 2, rows: 2, pockets: [] });
    expect(small.map((c) => [c.pocket, c.row, c.col, c.code])).toEqual([
      [1, 1, 1, 'C·1·1'],
      [2, 1, 2, 'C·1·2'],
      [3, 2, 1, 'C·1·3'],
      [4, 2, 2, 'C·1·4'],
    ]);

    // Sheet 1 has no ‹; a sheet beyond the album, or a box, is "not found".
    const first = await context((path) => (path === '/albums' ? [albumA] : { ...sheet3, sheet: 1, pockets: [] }));
    const firstEl = AlbumSheetScreen(first.ctx, route(`/albums/${ALBUM_ID}/sheets/1`));
    await settle();
    expect($<HTMLButtonElement>(firstEl, '[data-action="prev-sheet"]').disabled).toBe(true);
    const missing = await context((path) =>
      path === '/albums' ? [albumA] : new ProblemError({ type: 'about:blank', title: 'Not found', status: 404 }),
    );
    const missingEl = AlbumSheetScreen(missing.ctx, route(`/albums/${ALBUM_ID}/sheets/11`));
    await settle();
    expect($(missingEl, '[role="alert"]').textContent).toBe(t('sheet.notFound'));
  });

  it('[T-app-088] tapping an empty pocket starts a scan with its targetLocationCode, and the saved cap lands in that pocket', async () => {
    const { ctx } = await context((path) =>
      path === '/albums' ? [albumA] : path.startsWith('/albums/') ? sheet3 : undefined,
    );
    const el = AlbumSheetScreen(ctx, route(`/albums/${ALBUM_ID}/sheets/3`));
    await settle();
    $(el, '[data-pocket="18"] [data-action="scan-pocket"]').click();
    const target = vi.mocked(ctx.navigate).mock.lastCall?.[0] ?? '';
    expect(target).toBe(`/scan?pocket=${encodeURIComponent('A·3·18')}`);

    // The Scan tab at that route: pre-assigned, and the code reaches `POST /scans/analyse` (CAP-41).
    const [path, search] = target.split('?');
    const scanRoute = route(path ?? '', `?${search ?? ''}`);
    expect(scanRoute.query.pocket).toBe('A·3·18');
    const top: ImageRef = { key: `u1/${SCAN_ID}/top.webp`, width: 1024, height: 1024, bytes: 900 };
    const scan = await context((p) =>
      p === '/uploads'
        ? { key: top.key, url: 'https://s3.test/put', expiresAt: '2030-01-01T00:00:00.000Z' }
        : p === '/scans/analyse'
          ? ({ scanId: SCAN_ID, outcome: 'identified', fields: { brand: 'Ambar' }, suggestions: [] } as AnalyseResponse)
          : undefined,
    );
    const view = ScanScreen(scan.ctx, scanRoute);
    expect($(view, '[data-target]').textContent).toBe(t('scan.into', { code: 'A·3·18' }));
    expect($(view, '[data-action="manual"]').getAttribute('href')).toBe(`/new?pocket=${encodeURIComponent('A·3·18')}`);
    // Shoot → the scan context and `POST /scans/analyse` carry the pocket.
    const photo: CapPhoto = {
      blob: new Blob([new Uint8Array(9)]),
      width: 1024,
      height: 1024,
      dhash: 'f0f0f03030f0f0f0',
    };
    const shot = ScanView(scan.ctx, {
      targetLocationCode: 'A·3·18',
      prepare: async () => photo,
      put: async () => new Response(null, { status: 200 }),
      newId: () => SCAN_ID,
    });
    vi.mocked(scan.ctx.platform.camera).mockResolvedValueOnce(new File(['t'], 'top.jpg'));
    $(shot, '[data-action="shoot"]').click();
    await settle();
    expect(scan.ctx.capture.current()?.targetLocationCode).toBe('A·3·18');
    $(shot, '[data-action="skip"]').click();
    await settle();
    expect(scan.calls.find((c) => c.path === '/scans/analyse')?.body).toMatchObject({ targetLocationCode: 'A·3·18' });
    expect(scan.ctx.navigate).toHaveBeenCalledWith('/scan/review');
    // A malformed code is a plain scan.
    expect(ScanScreen(scan.ctx, route('/scan', '?pocket=nope')).querySelector('[data-target]')).toBeNull();
    expect(pocketLocation('B')).toBeNull();
    expect(pocketLocation('a.3.18')).toEqual({ kind: 'album', album: 'A', sheet: 3, pocket: 18 });

    // AI review of a pre-assigned scan: Save → POST /caps with `location` (CAP-50).
    const save = await context((p, _m, body) => (p === '/caps' ? { ...wireCap(5), ...(body as object) } : undefined));
    save.ctx.capture.start({
      scanId: SCAN_ID,
      useAi: true,
      targetLocationCode: 'A·3·18',
      top: { photo, ref: top },
      response: { scanId: SCAN_ID, outcome: 'identified', fields: { brand: 'Ambar' }, suggestions: [] },
    });
    const review = ScanReviewScreen(save.ctx, route('/scan/review'));
    document.body.replaceChildren(review);
    expect($(review, '[data-pocket]').textContent).toBe(t('form.goesTo', { code: 'A·3·18' }));
    submit(review);
    await settle();
    const post = save.calls.find((c) => c.path === '/caps');
    expect(post?.body).toMatchObject({
      brand: 'Ambar',
      location: { kind: 'album', album: 'A', sheet: 3, pocket: 18 },
    });
    expect(save.ctx.navigate).toHaveBeenCalledWith(`/cap/${ulid(5)}`);

    // "Enter manually" from a pre-assigned scan: the empty form goes to the pocket too (same Save path as above).
    const manual = await context(() => undefined);
    const form = NewCapScreen(manual.ctx, route('/new', `?pocket=${encodeURIComponent('A·3·18')}`));
    expect($(form, '[data-pocket]').dataset.pocket).toBe('A·3·18');
    expect(NewCapScreen(manual.ctx, route('/new')).querySelector('[data-pocket]')).toBeNull();
    expect(NewCapScreen(manual.ctx, route('/new', '?pocket=B')).querySelector('[data-pocket]')).toBeNull();
  });
});

describe('albums', () => {
  it('[T-app-089] "+ New" proposes the next free letter and GRANDE 6 × 7, POSTs AlbumInput, and shows a 409 inline', async () => {
    let taken = true;
    const { ctx, calls } = await context((path, method, body) => {
      if (path === '/albums' && method === 'GET') return [albumA, boxB];
      if (path === '/albums' && method === 'POST') {
        if (taken) return conflict('letter C is already used');
        return { albumId: ulid(902), createdAt: TS, updatedAt: TS, ...(body as object) };
      }
      return undefined;
    });
    const el = AlbumsScreen(ctx, route('/albums'));
    document.body.replaceChildren(el);
    await settle();
    $(el, '[data-action="new-album"]').click();
    const form = $(el, '.album-form');
    const field = (name: string) => $<HTMLInputElement>(form, `[data-field="${name}"]`);
    expect(field('letter').value).toBe('C');
    expect([field('sheets').value, field('cols').value, field('rows').value]).toEqual(['10', '6', '7']);
    expect($(form, '.album-measures').textContent).toContain(t('albums.measureHint'));

    // Required name; pitch below the pocket size.
    type(field('pocketMm'), '34');
    type(field('pitchMm'), '30');
    submit(form);
    await settle();
    expect($(form, '[data-error="name"]').textContent).toBe(t('albums.errorRequired'));
    expect($(form, '[data-error="pitchMm"]').textContent).toBe(t('albums.errorPitch'));
    expect(calls.filter((c) => c.method === 'POST')).toHaveLength(0);

    type(field('name'), 'Kronkorken');
    type(field('pitchMm'), '36');
    submit(form);
    await settle();
    const post = calls.find((c) => c.method === 'POST');
    expect(post?.body).toEqual({
      letter: 'C',
      name: 'Kronkorken',
      kind: 'album',
      sheets: 10,
      cols: 6,
      rows: 7,
      pocketMm: 34,
      pitchMm: 36,
    });
    // 409: the letter is taken — inline on the letter, the sheet stays open.
    expect($(form, '[data-error="letter"]').textContent).toBe(t('albums.letterTaken', { letter: 'C' }));
    expect(form.isConnected).toBe(true);

    taken = false;
    submit(form);
    await settle();
    expect(form.isConnected).toBe(false);
    expect([...el.querySelectorAll<HTMLElement>('.album-row')].map((r) => r.dataset.album)).toEqual(['A', 'B', 'C']);

    // A box sends no geometry.
    const box = validateAlbum({ ...newAlbumValues([]), name: 'Flips', kind: 'box', sheets: '' });
    expect(box).toEqual({ ok: true, input: { letter: 'A', name: 'Flips', kind: 'box' } });
    expect(validateAlbum({ ...newAlbumValues([]), name: 'X', sheets: '' })).toMatchObject({
      ok: false,
      errors: { sheets: 'required' },
    });
    expect(validateAlbum({ ...newAlbumValues([]), name: 'X', letter: '1' })).toMatchObject({
      ok: false,
      errors: { letter: 'invalid' },
    });
    expect(nextFreeLetter([...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'].map((letter) => ({ letter })))).toBeNull();
  });

  it('[T-app-090] Edit PATCHes only the changed fields; a 409 (occupied pocket) says why; the list shows used / total', async () => {
    let refuse = true;
    const { ctx, calls } = await context((path, method, body) => {
      if (path === '/albums' && method === 'GET') return [albumA, boxB];
      if (path === `/albums/${ALBUM_ID}` && method === 'PATCH') {
        if (refuse) return conflict('pocket A·10·3 is occupied');
        return { ...albumA, ...(body as object) };
      }
      if (path === `/albums/${ALBUM_ID}/sheets/1`) return { ...sheet3, sheet: 1 };
      return undefined;
    });
    const el = AlbumsScreen(ctx, route('/albums'));
    document.body.replaceChildren(el);
    await settle();

    const rowA = $(el, '[data-album="A"]');
    expect($(rowA, '.album-letter').textContent).toBe('A');
    expect($(rowA, '.album-kind').textContent).toBe(t('albums.kindAlbum'));
    expect($(rowA, '.album-main').getAttribute('href')).toBe(`/albums/${ALBUM_ID}/sheets/1`);
    // Not opened yet: "—" used, total from the geometry (10 × 6 × 7).
    expect($(rowA, '[data-usage]').textContent).toBe(t('albums.usageUnknown', { total: '420' }));
    const rowB = $(el, '[data-album="B"]');
    expect(rowB.querySelector('[data-usage]')).toBeNull();
    expect($(rowB, '.album-main').tagName).toBe('DIV');

    $(rowA, '[data-action="edit-album"]').click();
    const form = $(el, '.album-form');
    const field = (name: string) => $<HTMLInputElement>(form, `[data-field="${name}"]`);
    expect(field('name').value).toBe('Leuchtturm GRANDE');
    type(field('sheets'), '9');
    submit(form);
    await settle();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ sheets: 9 });
    expect($(form, '[data-status="form"]').textContent).toBe(
      t('albums.editConflict', { detail: 'pocket A·10·3 is occupied' }),
    );

    refuse = false;
    type(field('sheets'), '12');
    type(field('name'), 'GRANDE 1');
    submit(form);
    await settle();
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ name: 'GRANDE 1', sheets: 12 });
    expect(form.isConnected).toBe(false);
    expect($(el, '[data-album="A"] .album-name').textContent).toBe('GRANDE 1');
    // Nothing changed → no request at all.
    const same = validateAlbum(albumValues(Album.parse(albumA)));
    expect(same.ok && albumPatch(Album.parse(albumA), same.input)).toBeNull();

    // Opening sheet 1 records its usage (3 caps): the list now shows it.
    AlbumSheetScreen(ctx, route(`/albums/${ALBUM_ID}/sheets/1`));
    await settle();
    const again = AlbumsScreen(ctx, route('/albums'));
    await settle();
    expect($(again, '[data-album="A"] [data-usage]').textContent).toBe(t('albums.usage', { used: '3', total: '420' }));
  });

  it('[T-app-091] "A·3" in the Collection search offers the sheet and Enter opens /albums/:id/sheets/3; other text searches', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { ctx, calls } = await context((path) => {
      if (path === '/albums') return [albumA, boxB];
      if (path.startsWith('/caps')) return wirePage([]);
      return undefined;
    });
    const el = CollectionScreen(ctx, route('/'));
    document.body.replaceChildren(el);
    await settle();
    const search = $<HTMLInputElement>(el, '.search-input');
    const link = $<HTMLAnchorElement>(el, '[data-sheet-link]');
    expect(link.hidden).toBe(true);

    type(search, 'a · 3');
    await vi.advanceTimersByTimeAsync(SEARCH_DEBOUNCE_MS);
    await settle();
    expect(link.hidden).toBe(false);
    expect(link.getAttribute('href')).toBe(`/albums/${ALBUM_ID}/sheets/3`);
    expect(link.textContent).toBe(t('collection.openSheet', { code: 'A·3' }));

    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(ctx.navigate).toHaveBeenCalledWith(`/albums/${ALBUM_ID}/sheets/3`);
    // Albums are fetched once.
    expect(calls.filter((c) => c.path === '/albums')).toHaveLength(1);

    // A sheet the album does not have, or a box letter, is a plain search.
    vi.mocked(ctx.navigate).mockClear();
    type(search, 'A·11');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(link.hidden).toBe(true);
    expect(calls.some((c) => c.path.startsWith('/caps?') && c.path.includes('q=A%C2%B711'))).toBe(true);
    type(search, 'B 1');
    search.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    await settle();
    expect(ctx.navigate).not.toHaveBeenCalled();

    // A full pocket code stays a search (the API matches it by location, CAP-23).
    expect(parseSheetCode('A·3·17')).toBeNull();
    expect(parseSheetCode('A·3')).toEqual({ letter: 'A', sheet: 3 });
    expect(parseSheetCode('a/12')).toEqual({ letter: 'A', sheet: 12 });
    expect(parseSheetCode('A·0')).toBeNull();
    expect(parseSheetCode('Mahou')).toBeNull();
  });
});
