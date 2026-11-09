// Settings (CAP-21 skeleton; CAP-58, SCREENS.md inventory "Settings behind ⋯"): API URL override (development builds
// only), a connection check against GET /healthz, "Use AI identification" (CAP-41: on by default, kept in the platform
// store, sent as `useAi` by the capture flow), the default album of the "next free" proposal (CAP-53's stored letter),
// each album's pocket / pitch in mm (`PATCH /albums/{id}`, read by the insert PDF, CAP-54), "Scans & AI cost" (the
// last 50 `GET /scans` and the week's AI cost, ADR-004 threshold tuning), About (app, API, web and contracts
// versions) and Sign out (CAP-22: clears the stored session; the shell then shows the sign-in screen).
// Styles: styles/settings.css.
import { Album, CONTRACTS_VERSION, type Scan } from '@capcollector/shared';

import { AlbumListSchema, parseMeasures } from '../albums/model.js';
import { defaultAlbum, pocketAlbums, readLastAlbum, writeLastAlbum } from '../albums/place.js';
import type { AppContext } from '../context.js';
import { readUseAi, writeUseAi } from '../capture/ai-setting.js';
import { ScreenHeader } from '../components/screen-header.js';
import { ConfigError } from '../config.js';
import type { Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { scanReport, SCANS_SHOWN, type ScanReport } from '../settings/scans.js';
import { h } from '../ui/dom.js';

export const SettingsScreen: Screen = (ctx) => {
  const status = h('p', { class: 'status', attrs: { role: 'status' } });

  const apiSection = () => {
    const input = h('input', {
      class: 'input',
      attrs: { id: 'api-url', type: 'url', inputmode: 'url', autocomplete: 'off', value: ctx.apiUrl.override() ?? '' },
    });
    input.placeholder = ctx.config.apiUrl ?? '';
    const form = h(
      'form',
      {
        class: 'field',
        on: {
          submit: (event) => {
            event.preventDefault();
            ctx.apiUrl.setOverride(input.value).then(
              () => (status.textContent = t('settings.apiUrlSaved')),
              (error: unknown) => {
                if (!(error instanceof ConfigError)) throw error;
                status.textContent = t('settings.apiUrlInvalid');
              },
            );
          },
        },
      },
      h('label', { attrs: { for: 'api-url' } }, t('settings.apiUrl')),
      input,
      h('small', { class: 'muted' }, t('settings.apiUrlHint')),
      h('button', { class: 'button', attrs: { type: 'submit' } }, t('common.save')),
    );
    return form;
  };

  const check = h(
    'button',
    {
      class: 'button button--secondary',
      attrs: { type: 'button' },
      on: {
        click: () => {
          if (ctx.apiUrl.current() === null) {
            status.textContent = t('settings.apiNotConfigured');
            return;
          }
          ctx.api.healthz().then(
            () => (status.textContent = t('settings.apiOk')),
            () => (status.textContent = t('settings.apiFailed')),
          );
        },
      },
    },
    t('settings.checkApi'),
  );

  const ai = h('input', { attrs: { type: 'checkbox', name: 'ai', checked: true } });
  void readUseAi(ctx.platform.store).then((on) => (ai.checked = on));
  ai.addEventListener('change', () => void writeUseAi(ctx.platform.store, ai.checked));

  return h(
    'section',
    { class: 'screen settings' },
    ScreenHeader(t('settings.title')),
    ctx.config.dev && apiSection(),
    check,
    status,
    h('label', { class: 'field field--row' }, ai, h('span', {}, t('settings.ai'))),
    h('small', { class: 'muted' }, t('settings.aiHint')),
    AlbumSettings(ctx),
    ScansSection(ctx),
    About(ctx),
    ctx.session.signedIn() &&
      h(
        'button',
        {
          class: 'button button--secondary',
          attrs: { type: 'button', name: 'sign-out' },
          on: { click: () => void ctx.session.signOut() },
        },
        t('settings.signOut'),
      ),
  );
};

const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 4 });
/** Week total: cents, or sub-cent precision for the small amounts a week of Haiku calls costs. */
const usdTotal = new Intl.NumberFormat('en-US', {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 4,
});
const when = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const integer = new Intl.NumberFormat('en-US');

const OUTCOME_LABEL: Readonly<Record<Scan['outcome'], MessageKey>> = {
  duplicate: 'settings.scans.duplicate',
  identified: 'settings.scans.identified',
  unidentified: 'settings.scans.unidentified',
};

/** Default album (CAP-53) and the pocket / pitch of each album (CAP-54), over `GET /albums`. */
function AlbumSettings(ctx: AppContext): HTMLElement {
  const body = h('div', { class: 'settings-albums' }, h('p', { class: 'muted' }, t('settings.albumsLoading')));

  function measureForm(album: Album): HTMLElement {
    const input = (name: 'pocketMm' | 'pitchMm', value: number | undefined, label: MessageKey) =>
      h(
        'label',
        { class: 'field' },
        t(label),
        h('input', {
          class: 'input',
          attrs: {
            type: 'number',
            inputmode: 'decimal',
            step: '0.5',
            name,
            value: value === undefined ? '' : String(value),
          },
        }),
      );
    const note = h('small', { class: 'muted', attrs: { role: 'status' } });
    const form = h(
      'form',
      {
        class: 'settings-measures',
        attrs: { 'data-album': album.letter },
        on: {
          submit: (event) => {
            event.preventDefault();
            const field = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value ?? '';
            const measures = parseMeasures(field('pocketMm'), field('pitchMm'));
            if (!measures.ok) {
              note.textContent = t(measures.error);
              return;
            }
            note.textContent = '';
            Promise.resolve()
              .then(() =>
                ctx.api.request(`/albums/${encodeURIComponent(album.albumId)}`, {
                  method: 'PATCH',
                  body: { pocketMm: measures.pocketMm, pitchMm: measures.pitchMm },
                  schema: Album,
                }),
              )
              .then(
                () => (note.textContent = t('settings.measuresSaved')),
                () => (note.textContent = t('settings.measuresFailed')),
              );
          },
        },
      },
      h(
        'p',
        { class: 'settings-measures__album' },
        t('settings.albumName', { letter: album.letter, name: album.name }),
      ),
      h(
        'div',
        { class: 'field-row' },
        input('pocketMm', album.pocketMm, 'albums.pocketMm'),
        input('pitchMm', album.pitchMm, 'albums.pitchMm'),
      ),
      h('button', { class: 'button button--secondary', attrs: { type: 'submit' } }, t('common.save')),
      note,
    );
    return form;
  }

  void Promise.resolve()
    .then(() =>
      Promise.all([ctx.api.request('/albums', { schema: AlbumListSchema }), readLastAlbum(ctx.platform.store)]),
    )
    .then(([albums, last]: [Album[], string | null]) => {
      const candidates = pocketAlbums(albums);
      if (candidates.length === 0) {
        body.replaceChildren(h('p', { class: 'muted' }, t('settings.noAlbums')));
        return;
      }
      const select = h(
        'select',
        { class: 'input', attrs: { name: 'default-album', id: 'default-album' } },
        ...candidates.map((a) =>
          h('option', { attrs: { value: a.letter } }, t('settings.albumName', { letter: a.letter, name: a.name })),
        ),
      );
      select.value = defaultAlbum(albums, last)?.letter ?? '';
      select.addEventListener('change', () => void writeLastAlbum(ctx.platform.store, select.value));
      body.replaceChildren(
        h(
          'div',
          { class: 'field' },
          h('label', { attrs: { for: 'default-album' } }, t('settings.defaultAlbum')),
          select,
          h('small', { class: 'muted' }, t('settings.defaultAlbumHint')),
        ),
        h('h3', { class: 'settings-subtitle' }, t('settings.measures')),
        h('small', { class: 'muted' }, t('print.measureHint')),
        ...candidates.map(measureForm),
      );
    })
    .catch(() => body.replaceChildren(h('p', { class: 'muted' }, t('settings.albumsFailed'))));

  return h('section', { class: 'settings-section' }, h('h2', { class: 'settings-title' }, t('albums.title')), body);
}

function ScanRow(scan: Scan): HTMLElement {
  const parts = [
    when.format(new Date(scan.ts)),
    t(OUTCOME_LABEL[scan.outcome]),
    scan.bestDistance === undefined
      ? t('settings.scans.noDistance', { threshold: String(scan.threshold) })
      : t('settings.scans.distance', { distance: String(scan.bestDistance), threshold: String(scan.threshold) }),
  ];
  const ai = scan.aiCalled
    ? [
        scan.aiModel ?? t('settings.scans.ai'),
        t('settings.scans.tokens', {
          input: integer.format(scan.inputTokens ?? 0),
          output: integer.format(scan.outputTokens ?? 0),
        }),
        usd.format(scan.costEstimateUsd ?? 0),
      ]
    : [t('settings.scans.noAi')];
  const row = h(
    'li',
    { class: 'scan-row' },
    h('span', { class: 'scan-row__main' }, parts.join(t('collection.separator'))),
    h('span', { class: 'scan-row__ai muted' }, ai.join(t('collection.separator'))),
  );
  row.dataset.outcome = scan.outcome;
  return row;
}

export function ScanReportView(report: ScanReport): HTMLElement[] {
  const { week } = report;
  const total = h(
    'p',
    { class: 'scan-week', attrs: { 'data-week-cost': '' } },
    t(week.complete ? 'settings.scans.week' : 'settings.scans.weekPartial', {
      cost: usdTotal.format(week.costUsd),
      calls: integer.format(week.aiCalls),
      scans: integer.format(week.scans),
    }),
  );
  if (report.recent.length === 0) return [total, h('p', { class: 'muted' }, t('settings.scans.empty'))];
  return [
    total,
    h(
      'p',
      { class: 'muted' },
      t('settings.scans.recent', { count: String(Math.min(SCANS_SHOWN, report.recent.length)) }),
    ),
    h('ul', { class: 'scan-list' }, ...report.recent.map(ScanRow)),
  ];
}

/** "Scans & AI cost": loaded the first time it is opened. */
function ScansSection(ctx: AppContext): HTMLElement {
  const body = h('div', { class: 'scan-report' });
  let loaded = false;
  const load = () => {
    loaded = true;
    body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('settings.scans.loading')));
    Promise.resolve()
      .then(() => scanReport(ctx.api, new Date()))
      .then(
        (report) => body.replaceChildren(...ScanReportView(report)),
        () => {
          loaded = false;
          body.replaceChildren(h('p', { attrs: { role: 'alert' } }, t('settings.scans.failed')));
        },
      );
  };
  const details = h(
    'details',
    { class: 'settings-section settings-scans' },
    h('summary', { class: 'settings-title' }, t('settings.scans.title')),
    body,
  );
  details.addEventListener('toggle', () => {
    if (details.open && !loaded) load();
  });
  return details;
}

/** App, API, web and contracts versions. */
function About(ctx: AppContext): HTMLElement {
  const row = (label: MessageKey, value: string, key: string) => [
    h('dt', {}, t(label)),
    h('dd', { attrs: { 'data-about': key } }, value),
  ];
  return h(
    'section',
    { class: 'settings-section' },
    h('h2', { class: 'settings-title' }, t('settings.about')),
    h(
      'dl',
      { class: 'meta' },
      ...row('settings.version', ctx.config.version, 'version'),
      ...row('settings.contracts', CONTRACTS_VERSION, 'contracts'),
      ...row('settings.apiUrl', ctx.apiUrl.current() ?? t('settings.notSet'), 'api'),
      ...row('settings.webUrl', ctx.config.webUrl ?? t('settings.notSet'), 'web'),
    ),
  );
}
