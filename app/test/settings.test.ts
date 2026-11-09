// Tests for Settings: dev-only API URL override, connection check, version (CAP-21), the "Use AI identification"
// toggle (CAP-41), and CAP-58's default album, pocket / pitch editor, About and "Scans & AI cost".
import { CONTRACTS_VERSION } from '@capcollector/shared';
import { describe, expect, it, vi } from 'vitest';

import { LAST_ALBUM_KEY } from '../src/albums/place';
import type { ApiClient, RequestOptions } from '../src/api/client';
import { scanReport } from '../src/settings/scans';
import { ulid } from './support/caps';
import { NetworkError } from '../src/api/errors';
import { readUseAi, USE_AI_KEY } from '../src/capture/ai-setting';
import { matchRoute } from '../src/router/routes';
import { SettingsScreen } from '../src/screens/settings-screen';
import { t } from '../src/i18n/i18n';
import { fakeApi, flush, shellContext, TEST_CONFIG } from './support/fakes';

async function render(
  config = TEST_CONFIG,
  healthz: ApiClient['healthz'] = vi.fn(async () => ({ status: 'ok' as const })),
) {
  const api = fakeApi({ healthz });
  const ctx = { ...(await shellContext({ config, api })), navigate: vi.fn(), skipSignIn: vi.fn() };
  const route = matchRoute('/settings');
  if (!route) throw new Error('no route');
  const el = SettingsScreen(ctx, route);
  const status = () => el.querySelector('[role="status"]')?.textContent;
  return { el, ctx, status };
}

describe('settings screen', () => {
  it('[T-app-013] saves a valid API URL override in development, rejects invalid ones, checks /healthz and shows the version', async () => {
    const { el, ctx, status } = await render();
    expect(el.querySelector('h1')?.textContent).toBe(t('settings.title'));
    expect(el.querySelector('dd')?.textContent).toBe('1.2.3');

    const input = el.querySelector<HTMLInputElement>('#api-url');
    const form = el.querySelector('form');
    if (!input || !form) throw new Error('no API URL form');
    expect(input.placeholder).toBe('https://api.test');

    input.value = 'nope';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(status()).toBe(t('settings.apiUrlInvalid'));

    input.value = 'http://localhost:3000';
    form.dispatchEvent(new Event('submit', { cancelable: true }));
    await flush();
    expect(status()).toBe(t('settings.apiUrlSaved'));
    expect(ctx.apiUrl.current()).toBe('http://localhost:3000');

    el.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    await flush();
    expect(ctx.api.healthz).toHaveBeenCalled();
    expect(status()).toBe(t('settings.apiOk'));

    const failing = await render(
      TEST_CONFIG,
      vi.fn(async () => Promise.reject(new NetworkError('offline'))),
    );
    failing.el.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    await flush();
    expect(failing.status()).toBe(t('settings.apiFailed'));

    // Production build: no override field; without an API URL the check says so instead of calling.
    const prod = await render({ apiUrl: null, version: '0.2.0', dev: false, apple: null, webUrl: null });
    expect(prod.el.querySelector('#api-url')).toBeNull();
    prod.el.querySelector<HTMLButtonElement>('button[type="button"]')?.click();
    expect(prod.status()).toBe(t('settings.apiNotConfigured'));
    expect(prod.ctx.api.healthz).not.toHaveBeenCalled();
  });

  it('[T-app-073] "Use AI identification" is on by default, persists in the platform store and reads back', async () => {
    const { el, ctx } = await render();
    const ai = el.querySelector<HTMLInputElement>('input[name="ai"]');
    if (!ai) throw new Error('no AI toggle');
    await flush();
    expect([ai.disabled, ai.checked]).toEqual([false, true]);
    expect(await readUseAi(ctx.platform.store)).toBe(true);

    ai.checked = false;
    ai.dispatchEvent(new Event('change'));
    await flush();
    expect(await ctx.platform.store.get(USE_AI_KEY)).toBe('off');
    expect(await readUseAi(ctx.platform.store)).toBe(false);
    // A new Settings screen shows the stored choice.
    const again = SettingsScreen(ctx, matchRoute('/settings') ?? (undefined as never));
    await flush();
    expect(again.querySelector<HTMLInputElement>('input[name="ai"]')?.checked).toBe(false);

    ai.checked = true;
    ai.dispatchEvent(new Event('change'));
    await flush();
    expect(await ctx.platform.store.get(USE_AI_KEY)).toBeNull();
  });
});

// ── CAP-58 ──

const TS = '2026-11-01T10:00:00.000Z';
const NOW = new Date('2026-11-10T12:00:00.000Z');
const wireAlbum = (letter: string, n: number, extra: Record<string, unknown> = {}) => ({
  albumId: ulid(900 + n),
  letter,
  name: `Album ${letter}`,
  kind: 'album',
  sheets: 10,
  cols: 6,
  rows: 7,
  createdAt: TS,
  updatedAt: TS,
  ...extra,
});
const wireScan = (n: number, ts: string, extra: Record<string, unknown> = {}) => ({
  scanId: ulid(500 + n),
  ts,
  dhash: '0123456789abcdef',
  outcome: 'identified',
  threshold: 10,
  aiCalled: false,
  ...extra,
});

interface Call {
  path: string;
  method: string;
  body: unknown;
}

/** Settings over a fake API answering `/albums`, `PATCH /albums/{id}` and `/scans` pages. */
async function settings(
  options: { albums?: unknown[]; scanPages?: unknown[][]; store?: Record<string, string>; patch?: 'fail' } = {},
) {
  const calls: Call[] = [];
  const albums = options.albums ?? [wireAlbum('A', 1, { pocketMm: 33, pitchMm: 36 }), wireAlbum('B', 2)];
  const pages = options.scanPages ?? [[]];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    let answer: unknown;
    if (path === '/albums') answer = albums;
    else if (method === 'PATCH') {
      if (options.patch === 'fail') throw new NetworkError('offline');
      const album = albums.find((a) => path.endsWith((a as { albumId: string }).albumId));
      answer = { ...(album as object), ...(opts.body as object) };
    } else if (path.startsWith('/scans?')) {
      const index = Number(new URLSearchParams(path.split('?')[1]).get('cursor') ?? '0');
      answer = { items: pages[index] ?? [], ...(index + 1 < pages.length ? { cursor: String(index + 1) } : {}) };
    }
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const shell = await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }) });
  for (const [k, v] of Object.entries(options.store ?? {})) await shell.platform.store.set(k, v);
  const ctx = { ...shell, navigate: vi.fn(), skipSignIn: vi.fn() };
  const el = SettingsScreen(ctx, matchRoute('/settings') ?? (undefined as never));
  document.body.replaceChildren(el);
  for (let i = 0; i < 5; i++) await flush();
  return { el, ctx, calls };
}

describe('settings (CAP-58)', () => {
  it('[T-app-120] the default album picker lists the albums and persists the choice through platform.store', async () => {
    const boxes = [wireAlbum('A', 1), wireAlbum('B', 2), { ...wireAlbum('C', 3), kind: 'box', sheets: undefined }];
    const { el, ctx } = await settings({ albums: boxes, store: { [LAST_ALBUM_KEY]: 'B' } });
    const select = el.querySelector<HTMLSelectElement>('select[name="default-album"]');
    if (!select) throw new Error('no default album picker');
    // Albums proper only (a box has no pockets to propose); the stored letter is selected.
    expect([...select.options].map((o) => o.value)).toEqual(['A', 'B']);
    expect(select.value).toBe('B');
    select.value = 'A';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(await ctx.platform.store.get(LAST_ALBUM_KEY)).toBe('A');

    // A stored letter that no longer exists falls back to the first album; no albums → a hint instead.
    const gone = await settings({ store: { [LAST_ALBUM_KEY]: 'Z' } });
    expect(gone.el.querySelector<HTMLSelectElement>('select[name="default-album"]')?.value).toBe('A');
    const none = await settings({ albums: [] });
    expect(none.el.querySelector('select[name="default-album"]')).toBeNull();
    expect(none.el.querySelector('.settings-albums')?.textContent).toBe(t('settings.noAlbums'));
  });

  it('[T-app-121] each album has a pocket / pitch editor that validates and saves with PATCH /albums/{id}', async () => {
    const { el, calls } = await settings();
    const form = (letter: string) => el.querySelector<HTMLFormElement>(`form[data-album="${letter}"]`);
    const field = (letter: string, name: string) =>
      form(letter)?.querySelector<HTMLInputElement>(`input[name="${name}"]`) ?? (undefined as never);
    expect([field('A', 'pocketMm').value, field('A', 'pitchMm').value]).toEqual(['33', '36']);
    expect([field('B', 'pocketMm').value, field('B', 'pitchMm').value]).toEqual(['', '']);
    const note = (letter: string) => form(letter)?.querySelector('[role="status"]')?.textContent;
    const submit = async (letter: string) => {
      form(letter)?.dispatchEvent(new Event('submit', { cancelable: true }));
      for (let i = 0; i < 3; i++) await flush();
    };

    await submit('B');
    expect(note('B')).toBe(t('print.measureInvalid'));
    field('B', 'pocketMm').value = '34';
    field('B', 'pitchMm').value = '30';
    await submit('B');
    expect(note('B')).toBe(t('albums.errorPitch'));
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([]);

    field('B', 'pitchMm').value = '37,5';
    await submit('B');
    expect(calls.filter((c) => c.method === 'PATCH')).toEqual([
      { path: `/albums/${ulid(902)}`, method: 'PATCH', body: { pocketMm: 34, pitchMm: 37.5 } },
    ]);
    expect(note('B')).toBe(t('settings.measuresSaved'));

    const failing = await settings({ patch: 'fail' });
    failing.el.querySelector('form[data-album="A"]')?.dispatchEvent(new Event('submit', { cancelable: true }));
    for (let i = 0; i < 3; i++) await flush();
    expect(failing.el.querySelector('form[data-album="A"] [role="status"]')?.textContent).toBe(
      t('settings.measuresFailed'),
    );
  });

  it('[T-app-122] About shows the app version, contracts version, API URL and web URL', async () => {
    const { el } = await settings();
    const about = (key: string) => el.querySelector(`[data-about="${key}"]`)?.textContent;
    expect(about('version')).toBe(TEST_CONFIG.version);
    expect(about('contracts')).toBe(CONTRACTS_VERSION);
    expect(about('api')).toBe('https://api.test');
    expect(about('web')).toBe(t('settings.notSet'));
  });

  it('[T-app-123] "Scans & AI cost" lists the last 50 scans with outcome, distance, model, tokens and cost, and the week total', async () => {
    const recent = Array.from({ length: 60 }, (_, i) =>
      wireScan(i, new Date(NOW.getTime() - (i + 1) * 3_600_000).toISOString(), {
        aiCalled: i % 2 === 0,
        ...(i % 2 === 0 && {
          aiModel: 'anthropic.claude-haiku',
          inputTokens: 1200,
          outputTokens: 300,
          costEstimateUsd: 0.0025,
        }),
        ...(i === 1 && { outcome: 'duplicate', bestDistance: 4 }),
      }),
    );
    const old = [wireScan(99, '2026-10-01T10:00:00.000Z', { aiCalled: true, costEstimateUsd: 5 })];
    // Week total: 30 AI calls × $0.0025 over 60 scans; the older page is read (it crosses the week) but not summed.
    const report = await scanReport({ request: (await settings({ scanPages: [recent, old] })).ctx.api.request }, NOW);
    expect(report.recent).toHaveLength(50);
    expect(report.week).toMatchObject({ aiCalls: 30, scans: 60, complete: true });
    expect(report.week.costUsd).toBeCloseTo(0.075);

    const { el, calls } = await settings({ scanPages: [recent, old] });
    const details = el.querySelector<HTMLDetailsElement>('details.settings-scans');
    if (!details) throw new Error('no scans section');
    // Loaded on first open only.
    expect(calls.some((c) => c.path.startsWith('/scans'))).toBe(false);
    details.open = true;
    details.dispatchEvent(new Event('toggle'));
    await vi.waitFor(() => expect(el.querySelectorAll('.scan-row')).toHaveLength(50));
    expect(calls.filter((c) => c.path.startsWith('/scans')).map((c) => c.path)).toEqual([
      '/scans?limit=200',
      '/scans?limit=200&cursor=1',
    ]);
    expect(el.querySelector('[data-week-cost]')?.textContent).toBe(
      t('settings.scans.week', { cost: '$0.075', calls: '30', scans: '60' }),
    );
    const rows = [...el.querySelectorAll<HTMLElement>('.scan-row')];
    expect(rows[0]?.textContent).toContain(t('settings.scans.identified'));
    expect(rows[0]?.textContent).toContain('anthropic.claude-haiku');
    expect(rows[0]?.textContent).toContain(t('settings.scans.tokens', { input: '1,200', output: '300' }));
    expect(rows[0]?.textContent).toContain('$0.0025');
    expect(rows[1]?.dataset.outcome).toBe('duplicate');
    expect(rows[1]?.textContent).toContain(t('settings.scans.distance', { distance: '4', threshold: '10' }));
    expect(rows[1]?.textContent).toContain(t('settings.scans.noAi'));

    // Five pages all inside the week → stop and say the total is a lower bound.
    const busy = Array.from({ length: 6 }, (_, p) => [
      wireScan(p, NOW.toISOString(), { aiCalled: true, costEstimateUsd: 1 }),
    ]);
    const partial = await scanReport({ request: (await settings({ scanPages: busy })).ctx.api.request }, NOW);
    expect(partial.week).toEqual({ costUsd: 5, aiCalls: 5, scans: 5, complete: false });
    // No scans at all.
    const empty = await settings();
    const emptyDetails = empty.el.querySelector<HTMLDetailsElement>('details.settings-scans');
    if (emptyDetails) {
      emptyDetails.open = true;
      emptyDetails.dispatchEvent(new Event('toggle'));
    }
    await vi.waitFor(() =>
      expect(empty.el.querySelector('.scan-report')?.textContent).toContain(t('settings.scans.empty')),
    );
  });
});
