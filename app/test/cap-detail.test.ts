// Cap detail screen (CAP-24, SCREENS.md #6; openapi.yaml § GET/DELETE /caps/{capId}, /history).
import { Cap, type CapHistory } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import { HttpError, NetworkError } from '../src/api/errors';
import { capLink, shareRequest, shareText } from '../src/cap/share';
import { collectionState } from '../src/collection/state';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import { matchRoute } from '../src/router/routes';
import { CapDetailScreen, changesLine, formatDate, sameBrand, variantsOf } from '../src/screens/cap-detail-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const ID = ulid(1);

const FULL = wireCap(1, {
  brand: 'Mahou',
  variant: 'Clásica',
  producer: 'Mahou San Miguel',
  country: 'ES',
  year: 2023,
  type: 'beer',
  material: 'steel',
  closure: 'pry-off',
  condition: 'good',
  status: 'needsReview',
  quantity: 3,
  forTrade: 2,
  createdAt: '2024-05-02T10:00:00.000Z',
  acquiredWhere: 'Bar Pepe',
  acquiredOn: '2024-05-01',
  tags: ['spain', 'lager'],
  textOnCap: 'MAHOU 5 ESTRELLAS',
  description: 'Red cap with gold star',
  notes: 'From the summer trip',
  location: { kind: 'album', album: 'A', sheet: 3, pocket: 17 },
  images: {
    top: { key: 'u1/x/top.webp', width: 1024, height: 1024 },
    underside: { key: 'u1/x/underside.webp', width: 1024, height: 1024 },
  },
  imageUrls: { top: 'https://img.test/top.webp', underside: 'https://img.test/under.webp' },
});

const HISTORY: CapHistory[] = [
  { capId: ID, ts: '2024-05-02T10:00:00.000Z', source: 'manual', action: 'created', changes: [] },
  {
    capId: ID,
    ts: '2024-06-10T09:00:00.000Z',
    source: 'manual',
    action: 'updated',
    changes: [
      { field: 'year', from: 2022, to: 2023 },
      { field: 'producer', to: 'Mahou San Miguel' },
    ],
  },
];

type Route = (path: string, method: string) => unknown;

async function mount(respond: Route, kind: 'web' | 'native' = 'native', id = ID) {
  const calls: { path: string; method: string }[] = [];
  const request = vi.fn(async <T>(path: string, options: RequestOptions<T>): Promise<T> => {
    const method = options.method ?? 'GET';
    calls.push({ path, method });
    const parsed = options.schema.safeParse(await respond(path, method));
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const platform = fakePlatform(kind);
  const api = fakeApi({ request: request as ApiClient['request'] });
  const ctx: AppContext = { ...(await shellContext({ api, platform })), navigate: vi.fn(), skipSignIn: vi.fn() };
  const route = matchRoute(`/cap/${id}`);
  if (!route) throw new Error('no route');
  const el = CapDetailScreen(ctx, route);
  document.body.replaceChildren(el);
  await flush();
  await flush();
  return { el, ctx, calls, platform };
}

const standard: Route = (path) => {
  if (path === `/caps/${ID}`) return FULL;
  if (path === `/caps/${ID}/history`) return HISTORY;
  if (path.startsWith('/caps?'))
    return wirePage([FULL, wireCap(2, { brand: 'mahou ', variant: 'Negra' }), wireCap(3, { brand: 'Mahoustein' })]);
  throw new Error(`unexpected ${path}`);
};

const text = (el: ParentNode, sel: string) => el.querySelector(sel)?.textContent;

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('cap detail', () => {
  it('[T-app-038] renders a cap with every section: photos (tap swaps), title, chips, stats, fields, location, history', async () => {
    const { el, calls } = await mount(standard);
    expect(calls.map((c) => c.path)).toContain(`/caps/${ID}`);

    // Header: back to Collection, Edit → /cap/:id/edit.
    expect(el.querySelector('.back-link')?.getAttribute('href')).toBe('/');
    expect(el.querySelector(`a[href="/cap/${ID}/edit"]`)?.textContent).toBe(t('capDetail.edit'));

    // Photos: top large, underside thumbnail; tapping swaps them.
    const main = () => el.querySelector('.detail-photo img')?.getAttribute('src');
    const thumb = el.querySelector<HTMLButtonElement>('.detail-photo-thumb');
    expect(main()).toBe('https://img.test/top.webp');
    expect(thumb?.querySelector('img')?.getAttribute('src')).toBe('https://img.test/under.webp');
    thumb?.click();
    expect(main()).toBe('https://img.test/under.webp');
    expect(thumb?.querySelector('img')?.getAttribute('src')).toBe('https://img.test/top.webp');
    thumb?.click();
    expect(main()).toBe('https://img.test/top.webp');

    expect(text(el, 'h1')).toBe('Mahou · Clásica');
    expect(text(el, '.detail-subtitle')).toBe('Mahou San Miguel · ES · 2023');
    expect([...el.querySelectorAll('.detail-chips .chip')].map((c) => c.textContent)).toEqual([
      t('capDetail.needsReview'),
      t('capType.beer'),
      t('material.steel'),
      t('closure.pryOff'),
      t('condition.good'),
    ]);
    expect([...el.querySelectorAll('.stat-tile')].map((s) => [text(s, '.stat-label'), text(s, '.stat-value')])).toEqual(
      [
        [t('capDetail.quantity'), '3'],
        [t('capDetail.forTrade'), '2'],
        [t('capDetail.added'), '2024'],
      ],
    );
    const fields = [...el.querySelectorAll('.fields-card dt')].map((dt) => [
      dt.textContent,
      dt.nextElementSibling?.textContent,
    ]);
    expect(fields).toEqual([
      [t('capDetail.acquiredWhere'), 'Bar Pepe'],
      [t('capDetail.acquiredOn'), '1 May 2024'],
      [t('capDetail.tags'), 'spain, lager'],
      [t('capDetail.textOnCap'), 'MAHOU 5 ESTRELLAS'],
      [t('capDetail.description'), 'Red cap with gold star'],
      [t('capDetail.notes'), 'From the summer trip'],
    ]);
    expect(text(el, '.where-code')).toBe('A·3·17');

    // History: newest first, action + date + one line of changes.
    const items = [...el.querySelectorAll('.history-item')];
    expect(items.map((i) => text(i, 'strong'))).toEqual([t('history.updated'), t('history.created')]);
    expect(text(items[0] ?? el, 'time')).toBe('10 Jun 2024');
    expect(text(items[0] ?? el, '.history-changes')).toBe('year: 2022 → 2023; producer: Mahou San Miguel');
    expect(items[1]?.querySelector('.history-changes')).toBeNull();
  });

  it('[T-app-039] a minimal cap: placeholder photo, no underside, "Not in an album", no fields card; empty and failed history', async () => {
    const minimal = wireCap(1, { brand: 'Chimay' });
    const { el } = await mount((path) => {
      if (path === `/caps/${ID}`) return minimal;
      if (path.endsWith('/history')) return [];
      return wirePage([minimal]);
    });
    expect(el.querySelector('.detail-photo .cap-thumb--placeholder')).not.toBeNull();
    expect(el.querySelector('.detail-photo-thumb')).toBeNull();
    expect(el.querySelector('.detail-subtitle')).toBeNull();
    expect(el.querySelector('.detail-chips')).toBeNull();
    expect(el.querySelector('.fields-card')).toBeNull();
    expect(text(el, '.where-code')).toBe(t('capDetail.notInAlbum'));
    expect(text(el, '.history-list')).toBe(t('capDetail.noHistory'));
    expect(el.querySelector<HTMLElement>('.detail-variants')?.hidden).toBe(true);

    const failing = await mount((path) => {
      if (path === `/caps/${ID}`) return wireCap(1, { status: 'unidentified', location: { kind: 'box', album: 'B' } });
      throw new NetworkError('offline');
    });
    expect(text(failing.el, '.history-list')).toBe(t('capDetail.historyFailed'));
    expect(text(failing.el, '.where-code')).toBe('B');
    expect(text(failing.el, '.detail-chips')).toBe(t('capDetail.unidentified'));
    expect(failing.el.querySelector<HTMLElement>('.detail-variants')?.hidden).toBe(true);

    // History lines format any value; dates that do not parse are shown as given.
    expect(
      changesLine({
        capId: ID,
        ts: 'x',
        source: 'manual',
        action: 'moved',
        changes: [
          {
            field: 'location',
            from: { kind: 'album', album: 'A', sheet: 1, pocket: 2 },
            to: { kind: 'album', album: 'A', sheet: 1, pocket: 3 },
          },
          { field: 'tags', from: ['a'], to: null },
        ],
      }),
    ).toBe('location: A·1·2 → A·1·3; tags: ["a"] → —');
    expect(formatDate('not a date')).toBe('not a date');
  });

  it('[T-app-040] delete: confirm sheet, DELETE once, cap dropped from the grid state, back to Collection with a "Deleted" toast', async () => {
    const { el, ctx, calls } = await mount((path, method) =>
      method === 'DELETE' ? undefined : standard(path, method),
    );
    // The grid already holds this cap: it must disappear without a refetch.
    const grid = collectionState(ctx);
    grid.recent = [Cap.parse(FULL)];
    await grid.pager.reset(async () => ({ items: [Cap.parse(FULL), Cap.parse(wireCap(2))], total: 2 }));

    const openDelete = () => el.querySelector<HTMLButtonElement>('[data-action="delete"]')?.click();
    openDelete();
    expect(text(el, '.sheet-message')).toBe(t('capDetail.deleteConfirm', { name: 'Mahou · Clásica' }));
    // Cancel (button, then backdrop): nothing is deleted.
    el.querySelector<HTMLButtonElement>('.sheet .button--secondary')?.click();
    await flush();
    openDelete();
    el.querySelector<HTMLElement>('.sheet-backdrop')?.click();
    el.querySelector<HTMLElement>('.sheet')?.click(); // already gone; no effect
    await flush();
    expect(el.querySelector('.sheet')).toBeNull();
    expect(calls.filter((c) => c.method === 'DELETE')).toHaveLength(0);

    vi.useFakeTimers({ toFake: ['setTimeout'] });
    openDelete();
    el.querySelector<HTMLButtonElement>('[data-confirm]')?.click();
    await vi.advanceTimersByTimeAsync(0);
    expect(calls.filter((c) => c.method === 'DELETE')).toEqual([{ path: `/caps/${ID}`, method: 'DELETE' }]);
    expect(ctx.navigate).toHaveBeenCalledWith('/');
    expect(grid.pager.state().items.map((c) => c.capId)).toEqual([ulid(2)]);
    expect(grid.pager.state().total).toBe(1);
    expect(grid.recent).toEqual([]);
    expect(text(document.body, '.toast')).toBe(t('capDetail.deleted'));
    await vi.advanceTimersByTimeAsync(5000);
    expect(document.body.querySelector('.toast')).toBeNull();

    // Removing an unknown cap leaves the state untouched.
    const before = grid.pager.state();
    grid.pager.remove('nope');
    expect(grid.pager.state()).toBe(before);
  });

  it('[T-app-041] a failed delete keeps the cap and says so; unknown cap and load errors (with retry) are reported', async () => {
    const { el, ctx } = await mount((path, method) => {
      if (method === 'DELETE') throw new HttpError(500);
      return standard(path, method);
    });
    el.querySelector<HTMLButtonElement>('[data-action="delete"]')?.click();
    el.querySelector<HTMLButtonElement>('[data-confirm]')?.click();
    await flush();
    expect(ctx.navigate).not.toHaveBeenCalled();
    expect(text(document.body, '.toast')).toBe(t('capDetail.deleteFailed'));

    const gone = await mount(() => {
      throw new HttpError(404);
    });
    expect(text(gone.el, '.detail-error p')).toBe(t('capDetail.notFound'));
    expect(gone.el.querySelector('.detail-error button')).toBeNull();

    let fail = true;
    const flaky = await mount((path, method) => {
      if (path === `/caps/${ID}` && fail) {
        fail = false;
        throw new NetworkError('offline');
      }
      return standard(path, method);
    });
    expect(text(flaky.el, '.detail-error p')).toBe(t('capDetail.loadFailed'));
    flaky.el.querySelector<HTMLButtonElement>('.detail-error button')?.click();
    expect(text(flaky.el, '[role="status"]')).toBe(t('capDetail.loading'));
    await flush();
    await flush();
    expect(text(flaky.el, 'h1')).toBe('Mahou · Clásica');
  });

  it('[T-app-042] "Same brand" carousel lists other caps of the brand from GET /caps?q=<brand>, excluding itself', async () => {
    const { el, calls } = await mount(standard);
    const search = calls.find((c) => c.path.startsWith('/caps?'));
    expect(new URL(search?.path ?? '', 'https://x').searchParams.get('q')).toBe('Mahou');
    const section = el.querySelector<HTMLElement>('.detail-variants');
    expect(section?.hidden).toBe(false);
    expect(text(el, '.detail-variants h2')).toBe(t('capDetail.variantsOne'));
    const tiles = [...el.querySelectorAll('.detail-variants .cap-tile a')];
    expect(tiles.map((a) => a.getAttribute('href'))).toEqual([`/cap/${ulid(2)}`]);

    const caps = [
      Cap.parse(FULL),
      Cap.parse(wireCap(2, { brand: 'MAHÓU' })),
      Cap.parse(wireCap(3, { brand: 'Mahou' })),
    ];
    const [self] = caps;
    if (!self) throw new Error('no cap');
    expect(variantsOf(self, caps).map((c) => c.capId)).toEqual([ulid(2), ulid(3)]);
    expect(sameBrand('  San  Miguel ', 'san miguel')).toBe(true);
    expect(sameBrand('Mahou', 'Mahoustein')).toBe(false);

    const many = await mount((path, method) =>
      path.startsWith('/caps?')
        ? wirePage([wireCap(2, { brand: 'Mahou' }), wireCap(3, { brand: 'Mahou' })])
        : standard(path, method),
    );
    expect(text(many.el, '.detail-variants h2')).toBe(t('capDetail.variants', { count: 2 }));
  });

  it('[T-app-043] share text is brand · variant · country · year with the app deep link (iPhone) or the web URL', async () => {
    const cap = Cap.parse(FULL);
    expect(shareText(cap)).toBe('Mahou · Clásica · ES · 2023');
    expect(shareText(Cap.parse(wireCap(5, { brand: 'Chimay', year: 1999 })))).toBe('Chimay · 1999');
    expect(capLink(cap, 'native', 'https://caps.test')).toBe(`collectors://cap/${ID}`);
    expect(capLink(cap, 'web', 'https://caps.test')).toBe(`https://caps.test/cap/${ID}`);
    expect(shareRequest(cap, 'web', 'https://caps.test')).toEqual({
      title: 'Mahou',
      text: 'Mahou · Clásica · ES · 2023',
      url: `https://caps.test/cap/${ID}`,
    });

    const { el, platform } = await mount(standard);
    el.querySelector<HTMLButtonElement>('[data-action="share"]')?.click();
    expect(platform.share).toHaveBeenCalledWith({
      title: 'Mahou',
      text: 'Mahou · Clásica · ES · 2023',
      url: `collectors://cap/${ID}`,
    });
    // A share sheet that throws is swallowed.
    vi.mocked(platform.share).mockRejectedValueOnce(new Error('boom'));
    el.querySelector<HTMLButtonElement>('[data-action="share"]')?.click();
    await flush();
  });
});
