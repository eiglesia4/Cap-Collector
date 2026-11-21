// Initial layout (CAP-75; physical-link.md § Initial layout, § Insert discs, § Sheet index; ADR-005): the plan's order
// (type → country → brand → variant → year, unknown last), its gaps (new type → new sheet, new country → new row),
// albums filled in the order chosen around occupied pockets, the shortfall, the sequential apply that stops on the
// first error and resumes, and the print scope "these sheets".
import { Album, Cap } from '@capcollector/shared';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { ProblemError } from '../src/api/errors';
import { applyLayout } from '../src/albums/layout-apply';
import { compareForLayout, planLayout, plannedSheets } from '../src/albums/layout-plan';
import { albumPlanPrintPath, parseSheetList } from '../src/albums/model';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import { indexSheets, scopeCaps } from '../src/print/scope';
import { matchRoute } from '../src/router/routes';
import { AlbumLayoutView } from '../src/screens/album-layout-screen';
import { AlbumsScreen } from '../src/screens/albums-screen';
import { PrintView } from '../src/screens/print-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const TS = '2026-11-21T10:00:00.000Z';

function album(letter: string, n: number, geometry: { sheets: number; cols: number; rows: number }) {
  return {
    albumId: ulid(900 + n),
    letter,
    name: `Binder ${letter}`,
    kind: 'album',
    ...geometry,
    pocketMm: 33,
    pitchMm: 36,
    createdAt: TS,
    updatedAt: TS,
  };
}
const toAlbum = (raw: Record<string, unknown>) => Album.parse(raw);
const cap = (n: number, fields: Record<string, unknown> = {}) => Cap.parse(wireCap(n, fields));
const codes = (plan: ReturnType<typeof planLayout>) => plan.placements.map((p) => [p.capId, p.code]);

const settle = async () => {
  for (let i = 0; i < 20; i++) await flush();
};

describe('layout plan', () => {
  it('[T-app-127] sorts by type → country → brand → variant → year → capId, unknown values last in each level, text accent- and case-insensitive', () => {
    const caps = [
      cap(1, { brand: 'Zeta', type: 'beer', country: 'ES' }),
      cap(2, { brand: 'Água', type: 'water', country: 'PT' }),
      cap(3, { brand: 'Mahou', country: 'ES' }), // no type → after every type
      cap(4, { brand: 'Mahou', type: 'beer' }), // no country → after ES within beer
      cap(5, { brand: 'águila', type: 'beer', country: 'ES', variant: 'Pilsen', year: 1990 }),
      cap(6, { brand: 'Aguila', type: 'beer', country: 'ES', variant: 'pilsen' }), // no year → after 1990
      cap(7, { brand: 'Aguila', type: 'beer', country: 'ES' }), // no variant → after the variants
      cap(8, { brand: 'Chimay', type: 'beer', country: 'BE' }),
      cap(9, { brand: 'Aguila', type: 'beer', country: 'ES', variant: 'Pilsen', year: 1990 }), // tie → capId
    ];
    const order = [...caps].sort(compareForLayout).map((c) => c.capId);
    expect(order).toEqual([8, 5, 9, 6, 7, 1, 4, 2, 3].map(ulid));
  });

  it('[T-app-128] a new type starts a new sheet, a new country a new row; brands of a country follow on without gaps', () => {
    const a = toAlbum(album('A', 1, { sheets: 3, cols: 6, rows: 7 }));
    const caps = [
      cap(1, { brand: 'Mahou', type: 'beer', country: 'ES' }),
      cap(2, { brand: 'Alhambra', type: 'beer', country: 'ES' }),
      cap(3, { brand: 'Estrella', type: 'beer', country: 'ES' }),
      cap(4, { brand: 'Paulaner', type: 'beer', country: 'DE' }),
      cap(5, { brand: 'Beck', type: 'beer', country: 'DE' }),
      cap(6, { brand: 'Font Vella', type: 'water', country: 'ES' }),
    ];
    const plan = planLayout(caps, [a]);
    expect(codes(plan)).toEqual([
      [ulid(5), 'A·1·1'], // beer · DE, row 1
      [ulid(4), 'A·1·2'],
      [ulid(2), 'A·1·7'], // beer · ES, row 2 (row 1 keeps its gap)
      [ulid(3), 'A·1·8'],
      [ulid(1), 'A·1·9'],
      [ulid(6), 'A·2·1'], // water: new sheet
    ]);
    expect(plan.sheets.map((s) => [s.letter, s.sheet, s.groups.map((g) => [g.row, g.type, g.country])])).toEqual([
      [
        'A',
        1,
        [
          [1, 'beer', 'DE'],
          [2, 'beer', 'ES'],
        ],
      ],
      ['A', 2, [[1, 'water', 'ES']]],
    ]);
    expect(plan.totals).toEqual({ placed: 6, gapsLeft: 42 - 5 + 42 - 1, sheetsUsedByAlbum: { A: 2 } });
    expect(plan.shortfall).toBeUndefined();
  });

  it('[T-app-129] fills the albums in the order chosen, sheet by sheet, and never uses an occupied pocket', () => {
    const a = toAlbum(album('A', 1, { sheets: 1, cols: 2, rows: 2 }));
    const b = toAlbum(album('B', 2, { sheets: 2, cols: 2, rows: 2 }));
    const box = toAlbum({ ...album('C', 3, { sheets: 1, cols: 2, rows: 2 }), kind: 'box' });
    const placed = cap(50, { brand: 'Old', location: { kind: 'album', album: 'A', sheet: 1, pocket: 2 } });
    const deletedThere = cap(51, {
      brand: 'Gone',
      location: { kind: 'album', album: 'A', sheet: 1, pocket: 3 },
      deletedAt: TS,
    });
    const caps = [placed, deletedThere, ...[1, 2, 3, 4, 5].map((n) => cap(n, { brand: `B${n}`, type: 'beer' }))];

    const plan = planLayout(caps, [box, a, b]);
    expect(codes(plan)).toEqual([
      [ulid(1), 'A·1·1'],
      [ulid(2), 'A·1·3'], // pocket 2 is taken; the deleted cap's pocket is free
      [ulid(3), 'A·1·4'],
      [ulid(4), 'B·1·1'],
      [ulid(5), 'B·1·2'],
    ]);
    expect(plan.sheets.map((s) => [s.letter, s.sheet, s.occupied])).toEqual([
      ['A', 1, [2]],
      ['B', 1, []],
    ]);
    expect(plan.totals).toEqual({ placed: 5, gapsLeft: 2, sheetsUsedByAlbum: { A: 1, B: 1 } });
    expect(plannedSheets(plan, b.albumId)).toEqual([1]);

    // The order chosen, not the letter, decides which album fills first; the scope narrows what is placed.
    const reversed = planLayout(caps, [b, a], (c) => c.brand !== 'B5');
    expect(codes(reversed).map(([, code]) => code)).toEqual(['B·1·1', 'B·1·2', 'B·1·3', 'B·1·4']);
  });

  it('[T-app-130] not enough room → no placements, and how many pockets and sheets are missing (with the next letter)', () => {
    const a = toAlbum(album('A', 1, { sheets: 1, cols: 2, rows: 2 }));
    const caps = Array.from({ length: 10 }, (_, i) => cap(i + 1, { type: 'beer', country: 'ES' }));
    const plan = planLayout(caps, [a]);
    expect(plan.placements).toEqual([]);
    expect(plan.sheets).toEqual([]);
    expect(plan.shortfall).toEqual({ pockets: 6, sheetsNeeded: 2, nextLetter: 'B' });
    // No album chosen: everything is missing, on GRANDE sheets.
    expect(planLayout(caps, []).shortfall).toEqual({ pockets: 10, sheetsNeeded: 1, nextLetter: 'A' });
  });
});

// ── apply ──

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function layoutApi(options: { albums: Record<string, unknown>[]; caps: Record<string, unknown>[]; failOn?: string }) {
  const calls: Call[] = [];
  let failOn = options.failOn;
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    let answer: unknown;
    if (path === '/albums') answer = options.albums;
    else if (path.startsWith('/caps?')) answer = wirePage(options.caps);
    else if (method === 'PUT') {
      const capId = decodeURIComponent(path.split('/')[2] ?? '');
      if (capId === failOn) {
        failOn = undefined; // the next attempt succeeds
        throw new ProblemError({ title: 'Conflict', status: 409, detail: 'pocket occupied' });
      }
      const wire = options.caps.find((c) => c.capId === capId) ?? {};
      answer = { cap: { ...wire, location: (opts.body as { location: unknown }).location } };
    }
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  return { api: fakeApi({ request: request as ApiClient['request'] }), calls };
}

async function context(api: ApiClient): Promise<AppContext> {
  return { ...(await shellContext({ api, platform: fakePlatform('web') })), navigate: vi.fn(), skipSignIn: vi.fn() };
}

describe('apply', () => {
  it('[T-app-131] Albums → Plan layout: preview, then one PUT per cap in plan order; it stops on the first error and Resume skips the caps placed', async () => {
    const a = album('A', 1, { sheets: 2, cols: 2, rows: 2 });
    const caps = [
      wireCap(1, { brand: 'Mahou', type: 'beer', country: 'ES' }),
      wireCap(2, { brand: 'Chimay', type: 'beer', country: 'BE' }),
      wireCap(3, { brand: 'Font Vella', type: 'water', country: 'ES' }),
      wireCap(4, { brand: 'Placed', type: 'beer', location: { kind: 'album', album: 'A', sheet: 1, pocket: 4 } }),
    ];
    const { api, calls } = layoutApi({ albums: [a], caps, failOn: ulid(1) });
    const ctx = await context(api);

    // The entry point on the Albums screen.
    expect(matchRoute('/albums/layout')?.route.name).toBe('albumLayout');
    const albums = AlbumsScreen(ctx, matchRoute('/albums')!);
    await settle();
    expect(albums.querySelector('[data-action="plan-layout"]')?.getAttribute('href')).toBe('/albums/layout');

    const el = AlbumLayoutView(ctx);
    document.body.replaceChildren(el);
    await settle();
    const scope = el.querySelector<HTMLSelectElement>('select[name="scope"]');
    expect(scope?.options[0]?.textContent).toBe(t('layout.scopeAll', { count: 3 }));
    expect(el.querySelector<HTMLInputElement>('input[name="album"]')?.checked).toBe(true);
    el.querySelector<HTMLButtonElement>('[data-action="preview"]')?.click();

    expect(el.querySelector('[data-totals]')?.textContent).toContain(
      t('layout.totals', { placed: 3, sheets: 2, gaps: 4 }),
    );
    const sheet1 = el.querySelector('[data-sheet="A·1"]');
    expect(
      [...(sheet1?.querySelectorAll<HTMLElement>('.pocket') ?? [])].map((p) => [p.dataset.pocket, p.dataset.state]),
    ).toEqual([
      ['1', 'planned'],
      ['2', 'empty'],
      ['3', 'planned'],
      ['4', 'occupied'],
    ]);
    expect(sheet1?.querySelector('.layout-groups')?.textContent).toContain(
      t('layout.groupRow', { row: 2, label: '' }).trim(),
    );
    expect(el.querySelectorAll('[data-sheet]')).toHaveLength(2);

    el.querySelector<HTMLButtonElement>('[data-action="apply"]')?.click();
    await settle();
    const puts = () => calls.filter((c) => c.method === 'PUT');
    // Plan order: Chimay (BE) A·1·1, Mahou (ES) A·1·3 fails → stop; Font Vella not attempted.
    expect(puts().map((c) => [c.path, c.body])).toEqual([
      [`/caps/${ulid(2)}/location`, { location: { kind: 'album', album: 'A', sheet: 1, pocket: 1 } }],
      [`/caps/${ulid(1)}/location`, { location: { kind: 'album', album: 'A', sheet: 1, pocket: 3 } }],
    ]);
    expect(el.querySelector('[data-failed]')?.textContent).toBe(
      t('layout.failed', { brand: 'Mahou', code: 'A·1·3', placed: 1 }),
    );

    el.querySelector<HTMLButtonElement>('[data-action="resume"]')?.click();
    await settle();
    expect(
      puts()
        .slice(2)
        .map((c) => c.path),
    ).toEqual([`/caps/${ulid(1)}/location`, `/caps/${ulid(3)}/location`]);
    expect(el.querySelector('[data-done]')?.textContent).toBe(t('layout.done', { placed: 3 }));

    // The pure apply skips what is placed and reports progress in order.
    const progress = vi.fn();
    const rerun = await applyLayout(
      api,
      [
        {
          capId: ulid(2),
          code: 'A·1·1',
          location: { kind: 'album', album: 'A', sheet: 1, pocket: 1 },
          albumId: a.albumId,
        },
      ],
      () => true,
      progress,
    );
    expect(rerun).toEqual({ ok: true, placed: 0, skipped: 1 });
    expect(progress).toHaveBeenCalledWith({ done: 1, total: 1 });
    expect(puts()).toHaveLength(4);
  });

  it('[T-app-132] after applying, print opens on the planned sheets ("these sheets" scope: discs and index of those sheets)', async () => {
    const a = album('A', 1, { sheets: 5, cols: 2, rows: 2 });
    const caps = [
      wireCap(1, { brand: 'One', type: 'beer' }),
      wireCap(2, { brand: 'Two', type: 'water' }),
      wireCap(9, { brand: 'Before', location: { kind: 'album', album: 'A', sheet: 4, pocket: 1 } }),
    ];
    const { api } = layoutApi({ albums: [a], caps });
    const ctx = await context(api);
    const el = AlbumLayoutView(ctx);
    document.body.replaceChildren(el);
    await settle();
    el.querySelector<HTMLButtonElement>('[data-action="preview"]')?.click();
    el.querySelector<HTMLButtonElement>('[data-action="apply"]')?.click();
    await settle();
    const print = el.querySelector<HTMLAnchorElement>('[data-action="print"]');
    expect(print?.textContent).toBe(t('layout.print', { letter: 'A' }));
    expect(print?.getAttribute('href')).toBe(albumPlanPrintPath(a.albumId, [1, 2]));
    expect(el.querySelector('[data-action="open-sheet"]')?.getAttribute('href')).toBe(`/albums/${a.albumId}/sheets/1`);

    const route = matchRoute(`/albums/${a.albumId}/print`, `?sheets=1,2&sheet=1`);
    expect(parseSheetList(route?.query.sheets)).toEqual([1, 2]);
    expect(parseSheetList('3, x,1,3,0')).toEqual([1, 3]);
    expect(parseSheetList(undefined)).toEqual([]);

    // The print screen, now with the caps in their pockets.
    const placedCaps = [
      wireCap(1, { brand: 'One', location: { kind: 'album', album: 'A', sheet: 1, pocket: 1 } }),
      wireCap(2, { brand: 'Two', location: { kind: 'album', album: 'A', sheet: 2, pocket: 1 } }),
      caps[2]!,
    ];
    const after = layoutApi({ albums: [a], caps: placedCaps });
    const view = PrintView(await context(after.api), a.albumId, 1, { sheets: [1, 2] });
    document.body.replaceChildren(view);
    await settle();
    expect(view.querySelector<HTMLInputElement>('input[data-scope="sheets"]')?.checked).toBe(true);
    expect(view.querySelector('[data-preview]')?.textContent).toBe(
      [t('print.previewDiscs', { count: 2, pages: 2 }), t('print.previewIndex', { count: 2 })].join(
        t('collection.separator'),
      ),
    );

    // Pure scope: discs and index pages of exactly the planned sheets.
    const inAlbum = placedCaps
      .map((c) => Cap.parse(c))
      .map((c) => c as Cap & { location: { kind: 'album'; album: string; sheet: number; pocket: number } });
    const discs = scopeCaps(inAlbum, 'sheets', { sheet: 1, since: null, sheets: [1, 2] });
    expect(discs.map((c) => c.brand)).toEqual(['One', 'Two']);
    expect(indexSheets(inAlbum, [], 'sheets', 1, [2, 3]).map((s) => s.sheet)).toEqual([2, 3]);
  });
});
