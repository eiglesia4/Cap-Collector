// Insert discs and sheet index (CAP-54; physical-link.md § Insert discs and § Sheet index, amended 2026-11-09;
// SCREENS.md #8; ADR-001 client-side PDF): disc layout maths and mirrored backs, the PDF's page plan (calibration
// square on page 1 only) and page count, the sheet index grid at the pitch, the scopes, the QR payload, the print
// screen (ask for pocket/pitch first, Generate → download / share, Mark as printed) and the deep link that waits for
// sign-in.
import { Cap } from '@capcollector/shared';
import { PDFDocument } from 'pdf-lib';
import QRCode from 'qrcode';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderApp, type AppHandle } from '../src/app';
import type { ApiClient, RequestOptions } from '../src/api/client';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import { buildInsertsPdf, planInserts, qrPayload, type InsertsInput } from '../src/print/inserts';
import {
  A4_PORTRAIT,
  PT_PER_MM,
  backSlot,
  discDiameter,
  discGrid,
  frontPages,
  indexGeometry,
  layoutDiscs,
} from '../src/print/layout';
import { albumCaps, indexSheets, lastPrintKey, scopeCaps } from '../src/print/scope';
import { deepLinkPath } from '../src/router/deep-link';
import { matchRoute } from '../src/router/routes';
import { AlbumSheetScreen } from '../src/screens/album-sheet-screen';
import { PrintView } from '../src/screens/print-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { TEST_SESSION, fakeApi, fakePlatform, flush, memoryStore, shellContext } from './support/fakes';

const ALBUM_ID = ulid(900);
const TS = '2026-11-09T10:00:00.000Z';
const album = (extra: Record<string, unknown> = {}) =>
  ({
    albumId: ALBUM_ID,
    letter: 'A',
    name: 'Leuchtturm GRANDE',
    kind: 'album',
    sheets: 10,
    cols: 6,
    rows: 7,
    pocketMm: 33,
    pitchMm: 36,
    createdAt: TS,
    updatedAt: TS,
    ...extra,
  }) as const;
const ALBUM = album() as unknown as Parameters<typeof albumCaps>[1];

const at = (sheet: number, pocket: number, letter = 'A') => ({ kind: 'album', album: letter, sheet, pocket });
const placed = (n: number, sheet: number, pocket: number, extra: Record<string, unknown> = {}) =>
  Cap.parse(wireCap(n, { brand: `Brand ${n}`, location: at(sheet, pocket), country: 'ES', year: 1990 + n, ...extra }));

afterEach(() => {
  document.body.replaceChildren();
});

describe('insert discs: layout and PDF', () => {
  it('[T-app-102] disc layout: Ø = pocket − 3, N discs → pages, positions on a 3 mm gutter grid, backs mirrored', () => {
    expect(discDiameter(33)).toBe(30);
    const grid = discGrid(30);
    // 190 mm usable width → 5 columns of 30 + 3; page 1 loses the 30 mm calibration band.
    expect([grid.cols, grid.rowsFirst, grid.rowsOther]).toEqual([5, 7, 8]);
    expect(grid.x0).toBeCloseTo((210 - (5 * 33 - 3)) / 2 + 15);

    const slots = layoutDiscs(36, grid);
    expect(slots.filter((s) => s.sheet === 0)).toHaveLength(35);
    expect(slots.filter((s) => s.sheet === 1)).toHaveLength(1);
    expect(frontPages(36, grid)).toBe(2);
    expect(frontPages(0, grid)).toBe(0);
    expect(frontPages(75, grid)).toBe(2); // 35 + 40
    expect(frontPages(76, grid)).toBe(3);
    const [first, second, sixth, last] = [slots[0], slots[1], slots[5], slots[35]];
    expect(first).toMatchObject({ sheet: 0, col: 0, row: 0, cy: 10 + 30 + 15 });
    expect((second?.cx ?? 0) - (first?.cx ?? 0)).toBeCloseTo(33);
    expect(sixth).toMatchObject({ col: 0, row: 1 });
    expect((sixth?.cy ?? 0) - (first?.cy ?? 0)).toBeCloseTo(33);
    expect(last).toMatchObject({ sheet: 1, col: 0, row: 0, cy: 10 + 15 });
    // Every disc stays on the page.
    for (const s of slots) {
      expect(s.cx - 15).toBeGreaterThanOrEqual(10 - 1e-9);
      expect(s.cx + 15).toBeLessThanOrEqual(200 + 1e-9);
      expect(s.cy + 15).toBeLessThanOrEqual(287 + 1e-9);
    }
    // Backs: same row, mirrored column, so flipping on the long edge puts each back on its front.
    for (const s of slots) {
      const b = backSlot(s, grid);
      expect(b.col).toBe(grid.cols - 1 - s.col);
      expect(b.cx).toBeCloseTo(A4_PORTRAIT.width - s.cx);
      expect(b.cy).toBe(s.cy);
      expect(b.cx).toBeCloseTo(grid.x0 + b.col * 33);
    }
    expect(() => discGrid(200)).toThrow();
  });

  it('[T-app-103] the PDF interleaves fronts and backs, has the calibration square on page 1 only and the right page count', async () => {
    const discs = Array.from({ length: 36 }, (_, i) => placed(i + 1, 1 + Math.floor(i / 42), (i % 42) + 1));
    const input: InsertsInput = {
      album: album() as never,
      discs,
      sheets: [{ sheet: 1, caps: discs }],
      what: 'both',
      printedOn: new Date(TS),
    };
    const { pages } = planInserts(input);
    expect(pages.map((p) => p.kind)).toEqual(['front', 'back', 'front', 'back', 'index']);
    expect(pages.map((p) => (p.kind === 'front' ? p.calibration : null))).toEqual([true, null, false, null, null]);
    expect(planInserts({ ...input, what: 'discs' }).pages).toHaveLength(4);
    expect(planInserts({ ...input, what: 'index' }).pages.map((p) => p.kind)).toEqual(['index']);
    expect(planInserts({ ...input, discs: [], what: 'discs' }).pages).toEqual([]);
    expect(() => planInserts({ ...input, album: album({ pocketMm: undefined }) as never })).toThrow();

    // Real bytes: A4 portrait disc and index pages; brands outside WinAnsi do not break the build.
    const odd = [placed(90, 2, 1, { brand: 'Tsingtao 青岛', variant: 'Ž' }), ...discs.slice(0, 2)];
    const bytes = await buildInsertsPdf({ ...input, discs: odd, sheets: [{ sheet: 2, caps: odd }] });
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    const sizes = doc
      .getPages()
      .map((p) => [Math.round(p.getWidth() / PT_PER_MM), Math.round(p.getHeight() / PT_PER_MM)]);
    expect(sizes).toEqual([
      [210, 297],
      [210, 297],
      [210, 297],
    ]);
    expect(doc.getTitle()).toBe(t('print.pdfTitle', { letter: 'A' }));
    await expect(buildInsertsPdf({ ...input, discs: [], what: 'discs' })).rejects.toThrow();
  });

  it('[T-app-104] the sheet index grid has cols × rows cells at the pitch, as large as fits A4 portrait (≈ 88 % for 6 × 7 at 36 mm)', () => {
    const g = indexGeometry(6, 7, 36);
    // 6 × 7 at 36 mm = 216 × 252 mm: width limits (210 − 20 margin = 190 mm; height 297 − 20 − 16 header = 261 mm).
    expect(g.scale).toBeCloseTo(Math.min(190 / 216, 261 / 252));
    expect(Math.round(g.scale * 100)).toBe(88);
    expect(g.cell).toBeCloseTo(36 * g.scale);
    expect(g.x0 + 6 * g.cell).toBeLessThanOrEqual(A4_PORTRAIT.width - 10 + 1e-9);
    expect(g.y0 + 7 * g.cell).toBeLessThanOrEqual(A4_PORTRAIT.height - 10 + 1e-9);
    expect(g.x0).toBeCloseTo((A4_PORTRAIT.width - 6 * g.cell) / 2);
    // A small sheet fits at 1:1.
    const small = indexGeometry(2, 2, 36);
    expect(small.scale).toBe(1);
    expect(small.cell).toBe(36);
    // The plan uses the album's geometry and pitch, one portrait page per sheet, in sheet order.
    const plan = planInserts({
      album: album({ cols: 5, rows: 4, pitchMm: 40 }) as never,
      discs: [],
      sheets: [
        { sheet: 3, caps: [] },
        { sheet: 1, caps: [] },
      ],
      what: 'index',
      printedOn: new Date(TS),
    });
    expect(plan.pages).toEqual([
      { kind: 'index', sheet: 1, geometry: indexGeometry(5, 4, 40) },
      { kind: 'index', sheet: 3, geometry: indexGeometry(5, 4, 40) },
    ]);
  });

  it('[T-app-105] scopes: this sheet, since the last print (updatedAt), whole album; index pages cover the sheets printed', () => {
    const caps = [
      placed(3, 2, 5, { updatedAt: '2026-11-05T00:00:00.000Z' }),
      placed(1, 1, 7, { updatedAt: '2026-11-01T00:00:00.000Z' }),
      placed(2, 1, 2, { updatedAt: '2026-11-08T00:00:00.000Z' }),
      placed(4, 1, 3, { location: at(1, 3, 'C') }),
      Cap.parse(wireCap(5)), // not placed
      Cap.parse(wireCap(6, { location: { kind: 'box', album: 'A' } })),
      placed(7, 1, 9, { deletedAt: TS }),
    ];
    const inAlbum = albumCaps(caps, ALBUM);
    expect(inAlbum.map((c) => c.capId)).toEqual([ulid(2), ulid(1), ulid(3)]); // sheet then pocket
    expect(scopeCaps(inAlbum, 'sheet', { sheet: 1, since: null }).map((c) => c.capId)).toEqual([ulid(2), ulid(1)]);
    expect(scopeCaps(inAlbum, 'album', { sheet: 1, since: null })).toHaveLength(3);
    expect(scopeCaps(inAlbum, 'since', { sheet: 1, since: null })).toHaveLength(3);
    const since = scopeCaps(inAlbum, 'since', { sheet: 1, since: new Date('2026-11-04T00:00:00.000Z') });
    expect(since.map((c) => c.capId)).toEqual([ulid(2), ulid(3)]);

    // Index pages: the sheets of the printed discs, each with all its caps; the sheet scope always has its sheet.
    expect(indexSheets(inAlbum, since, 'since', 1).map((s) => [s.sheet, s.caps.length])).toEqual([
      [1, 2],
      [2, 1],
    ]);
    expect(indexSheets(inAlbum, [], 'sheet', 4)).toEqual([{ sheet: 4, caps: [] }]);
    expect(lastPrintKey(ALBUM_ID)).toBe(`print.last.${ALBUM_ID}`);
  });

  it('[T-app-106] the disc QR encodes collectors://cap/<id>, which the app opens as that cap', () => {
    const id = ulid(42);
    expect(qrPayload(id)).toBe(`collectors://cap/${id}`);
    expect(deepLinkPath(qrPayload(id))).toBe(`/cap/${id}`);
    const code = QRCode.create(qrPayload(id), { errorCorrectionLevel: 'M' });
    expect(code.modules.size).toBeGreaterThanOrEqual(21);
    // 12 mm over the module count: each module ≥ 0.35 mm, readable by a phone camera.
    expect(12 / code.modules.size).toBeGreaterThan(0.35);
  });
});

// ── print screen ──

interface Call {
  path: string;
  method: string;
  body: unknown;
}

async function printScreen(
  options: { album?: Record<string, unknown>; kind?: 'web' | 'native'; store?: ReturnType<typeof memoryStore> } = {},
) {
  const calls: Call[] = [];
  let current = album(options.album);
  const caps = [placed(1, 3, 1), placed(2, 3, 17), placed(3, 4, 2)];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    let answer: unknown;
    if (path === '/albums') answer = [current];
    else if (path.startsWith('/caps?')) answer = wirePage(caps.map((c) => ({ ...c })));
    else if (method === 'PATCH') answer = current = { ...current, ...(opts.body as object) };
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const store = options.store ?? memoryStore();
  const platform = fakePlatform(options.kind ?? 'web', store);
  const ctx: AppContext = {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
  };
  const download = vi.fn();
  const now = () => new Date('2026-11-10T12:00:00.000Z');
  const el = PrintView(ctx, ALBUM_ID, 3, { download, now });
  document.body.replaceChildren(el);
  for (let i = 0; i < 8; i++) await flush();
  return { el, calls, download, platform, store };
}

const settle = async () => {
  for (let i = 0; i < 20; i++) await flush();
};

describe('print screen', () => {
  it('[T-app-107] asks for pocket/pitch first (PATCH), then scope + what → preview, Generate downloads / shares the PDF, Mark as printed', async () => {
    // No measurements: the ask-first form, suggestions pre-filled, saved with PATCH /albums/{id}.
    const ask = await printScreen({ album: { pocketMm: undefined, pitchMm: undefined } });
    expect(ask.el.querySelector('.print-measure')).not.toBeNull();
    const pocket = ask.el.querySelector<HTMLInputElement>('input[name="pocketMm"]');
    const pitch = ask.el.querySelector<HTMLInputElement>('input[name="pitchMm"]');
    expect([pocket?.value, pitch?.value]).toEqual(['33', '36']);
    if (pitch) pitch.value = '30';
    ask.el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    expect(ask.el.querySelector('.print-measure [role="alert"]')?.textContent).toBe(t('albums.errorPitch'));
    if (pitch) pitch.value = '36';
    ask.el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    await settle();
    expect(ask.calls.filter((c) => c.method === 'PATCH')).toEqual([
      { path: `/albums/${ALBUM_ID}`, method: 'PATCH', body: { pocketMm: 33, pitchMm: 36 } },
    ]);
    expect(ask.el.querySelector('[data-action="generate"]')).not.toBeNull();

    // Measured: this sheet (3) by default, both → 2 discs on 2 pages + 1 index page.
    const { el, download, store } = await printScreen();
    const preview = () => el.querySelector('[data-preview]')?.textContent;
    expect(preview()).toBe(
      [t('print.previewDiscs', { count: 2, pages: 2 }), t('print.previewIndex', { count: 1 })].join(
        t('collection.separator'),
      ),
    );
    const pick = (name: string, value: string) => {
      const input = el.querySelector<HTMLInputElement>(`input[name="${name}"][value="${value}"]`);
      if (!input) throw new Error(`missing ${name}=${value}`);
      input.checked = true;
      input.dispatchEvent(new Event('change'));
    };
    pick('scope', 'album');
    pick('what', 'index');
    expect(preview()).toBe(t('print.previewIndex', { count: 2 }));
    pick('what', 'discs');
    expect(preview()).toBe(t('print.previewDiscs', { count: 3, pages: 2 }));

    el.querySelector<HTMLButtonElement>('[data-action="generate"]')?.click();
    await settle();
    expect(download).toHaveBeenCalledOnce();
    const file = download.mock.calls[0]?.[0] as File;
    expect(file.type).toBe('application/pdf');
    expect(file.name).toBe(t('print.fileName', { letter: 'A', scope: 'album' }));
    expect((await PDFDocument.load(await file.arrayBuffer())).getPageCount()).toBe(2);

    // Mark as printed: the per-album timestamp of "since last print", and the label shows it.
    const mark = el.querySelector<HTMLButtonElement>('[data-action="mark-printed"]');
    expect(mark?.hidden).toBe(false);
    mark?.click();
    await settle();
    expect(store.data.get(lastPrintKey(ALBUM_ID))).toBe('2026-11-10T12:00:00.000Z');
    pick('scope', 'since');
    expect(preview()).toBe(t('print.previewDiscs', { count: 0, pages: 0 }));
    expect(el.querySelector<HTMLButtonElement>('[data-action="generate"]')?.disabled).toBe(true);

    // iPhone: the share sheet with the PDF.
    const native = await printScreen({ kind: 'native' });
    native.el.querySelector<HTMLButtonElement>('[data-action="generate"]')?.click();
    await settle();
    expect(native.platform.share).toHaveBeenCalledOnce();
    expect(native.download).not.toHaveBeenCalled();

    // The album sheet links here for its sheet.
    const sheetCtx = await shellContext({
      api: fakeApi({
        request: (async (path: string, opts: RequestOptions<unknown>) => {
          const answer =
            path === '/albums'
              ? [album()]
              : { albumId: ALBUM_ID, letter: 'A', sheet: 3, cols: 6, rows: 7, pockets: [] };
          const parsed = opts.schema.safeParse(answer);
          if (!parsed.success) throw parsed.error;
          return parsed.data;
        }) as ApiClient['request'],
      }),
    });
    const sheet = AlbumSheetScreen(
      { ...sheetCtx, navigate: vi.fn(), skipSignIn: vi.fn() },
      matchRoute(`/albums/${ALBUM_ID}/sheets/3`) as never,
    );
    document.body.replaceChildren(sheet);
    await settle();
    expect(sheet.querySelector('[data-action="print"]')?.getAttribute('href')).toBe(
      `/albums/${ALBUM_ID}/print?sheet=3`,
    );
  });
});

describe('deep link resumes after sign-in', () => {
  let handle: AppHandle | undefined;
  afterEach(() => handle?.destroy());

  it('[T-app-108] a cap link opened signed out is kept, opened after sign-in, dropped on cancel and on restart', async () => {
    const id = ulid(7);
    const root = document.createElement('div');
    document.body.replaceChildren(root);

    // Signed out at /cap/<id>: Sign in; signing in lands on the cap, not Collection.
    window.history.replaceState(null, '', `/cap/${id}`);
    const ctx = await shellContext({ signedIn: false });
    handle = renderApp(root, ctx);
    expect(window.location.pathname).toBe('/sign-in');
    await ctx.session.save(TEST_SESSION);
    expect(window.location.pathname).toBe(`/cap/${id}`);
    handle.destroy();

    // Cancelled sign-in (Apple sheet dismissed): the link is dropped, signing in later lands on Collection.
    window.history.replaceState(null, '', `/cap/${id}`);
    const cancelled = await shellContext({ signedIn: false, platform: fakePlatform('native') });
    handle = renderApp(root, cancelled);
    const apple = () => root.querySelector<HTMLButtonElement>('.button--apple');
    // The attempt is prepared on mount (CAP-64) before the button is enabled.
    await vi.waitFor(() => expect(apple()?.disabled).toBe(false));
    apple()?.click();
    for (let i = 0; i < 10; i++) await flush();
    expect(cancelled.platform.signInWithApple).toHaveBeenCalled();
    await cancelled.session.save(TEST_SESSION);
    expect(window.location.pathname).toBe('/');
    handle.destroy();

    // Restart: nothing pending survives (memory only); other routes are never kept.
    window.history.replaceState(null, '', '/albums');
    const restarted = await shellContext({ signedIn: false });
    handle = renderApp(root, restarted);
    await restarted.session.save(TEST_SESSION);
    expect(window.location.pathname).toBe('/');
  });
});
