// Plan layout (CAP-75; physical-link.md § Initial layout; ADR-005; SCREENS.md #7 sheet grid): `/albums/layout`, from
// Albums → "Plan layout…". Setup: which caps (all without a location, or one type of them) and the albums to fill, in
// the order ticked, with "+ New album" inline (the CAP-52 sheet). Preview: the totals and every planned sheet in the
// sheet-view grid, group labels (type · country) at the rows where a group starts; a shortfall places nothing and says
// what is missing. Apply: one `PUT /caps/{id}/location` at a time with a progress bar, stopping on the first error
// (Resume skips what is already placed). Then: print discs + sheet index for the planned sheets of each album
// (print scope "these sheets") or open the first planned sheet. Pure planning in albums/layout-plan.ts.
import { CapType, type Album, type Cap } from '@capcollector/shared';

import { applyLayout } from '../albums/layout-apply.js';
import { isUnplaced, planLayout, plannedSheets, type LayoutPlan, type SheetPreview } from '../albums/layout-plan.js';
import { AlbumListSchema, albumPlanPrintPath, albumSheetPath } from '../albums/model.js';
import { pocketAlbums } from '../albums/place.js';
import { fetchAllCaps } from '../collection/all-caps.js';
import type { AppContext, Screen } from '../context.js';
import { countryName } from '../i18n/countries.js';
import { t } from '../i18n/i18n.js';
import { TYPE_LABEL } from '../i18n/labels.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';
import { AlbumForm } from './albums-screen.js';

type Scope = 'all' | CapType;

const ALL: Scope = 'all';

function groupLabel(group: SheetPreview['groups'][number]): string {
  const type = group.type === undefined ? t('layout.unknownType') : t(TYPE_LABEL[group.type]);
  const country = group.country === undefined ? t('layout.unknownCountry') : countryName(group.country);
  return [type, country].join(t('collection.separator'));
}

/** One planned sheet in the sheet-view grid: planned caps, pockets already taken, free pockets. */
function SheetPreviewView(sheet: SheetPreview): HTMLElement {
  const planned = new Map(sheet.planned.map((p) => [p.pocket, p]));
  const occupied = new Set(sheet.occupied);
  const groups = new Map(sheet.groups.map((g) => [g.pocket, g]));
  const cells: HTMLElement[] = [];
  for (let pocket = 1; pocket <= sheet.cols * sheet.rows; pocket++) {
    const cap = planned.get(pocket);
    const state = cap ? 'planned' : occupied.has(pocket) ? 'occupied' : 'empty';
    const li = h(
      'li',
      { class: `pocket pocket--${state}` },
      h(
        'span',
        { class: 'pocket-link' },
        cap
          ? h('span', { class: 'pocket-brand' }, cap.brand)
          : h('span', { class: 'pocket-thumb pocket-number' }, String(pocket)),
      ),
    );
    li.dataset.pocket = String(pocket);
    li.dataset.state = state;
    if (cap) li.dataset.capId = cap.capId;
    const group = groups.get(pocket);
    if (group) li.dataset.group = groupLabel(group);
    cells.push(li);
  }
  const article = h(
    'article',
    { class: 'layout-sheet' },
    h('h2', { class: 'section-title' }, t('layout.sheetTitle', { letter: sheet.letter, sheet: sheet.sheet })),
    h(
      'ul',
      { class: 'layout-groups muted' },
      ...sheet.groups.map((g) => h('li', {}, t('layout.groupRow', { row: g.row, label: groupLabel(g) }))),
    ),
    h(
      'ol',
      {
        class: 'sheet-grid layout-grid',
        attrs: { style: `--cols: ${String(sheet.cols)}`, 'aria-label': t('sheet.grid') },
      },
      ...cells,
    ),
  );
  article.dataset.sheet = `${sheet.letter}·${String(sheet.sheet)}`;
  return article;
}

export function AlbumLayoutView(ctx: AppContext): HTMLElement {
  const back = h(
    'a',
    { class: 'header-action', attrs: { href: pathFor('albums'), 'data-link': true } },
    t('layout.back'),
  );
  const body = h('div', { class: 'layout-body' });
  const el = h(
    'section',
    { class: 'screen album-layout' },
    h('header', { class: 'screen-header' }, back, h('h1', { class: 'screen-title' }, t('layout.title'))),
    body,
  );

  let albums: Album[] = [];
  let caps: Cap[] = [];
  let scope: Scope = ALL;
  /** Album ids, in the order ticked. */
  let chosen: string[] = [];

  function failed(): void {
    body.replaceChildren(
      h('p', { attrs: { role: 'alert' } }, t('layout.loadFailed')),
      h(
        'button',
        { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => void load() } },
        t('common.retry'),
      ),
    );
  }

  const include = (cap: Cap) => scope === ALL || cap.type === scope;
  const selectedAlbums = () =>
    chosen.map((id) => albums.find((a) => a.albumId === id)).filter((a): a is Album => a !== undefined);

  // ── setup ──

  function setup(): void {
    const unplaced = caps.filter(isUnplaced);
    if (unplaced.length === 0) {
      body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('layout.nothing')));
      return;
    }
    const scopeSelect = h('select', { class: 'input', attrs: { name: 'scope', 'aria-label': t('layout.scope') } });
    scopeSelect.append(
      h('option', { attrs: { value: ALL } }, t('layout.scopeAll', { count: unplaced.length })),
      ...CapType.options
        .map((type) => ({ type, count: unplaced.filter((c) => c.type === type).length }))
        .filter((o) => o.count > 0)
        .map((o) =>
          h(
            'option',
            { attrs: { value: o.type } },
            t('layout.scopeType', { type: t(TYPE_LABEL[o.type]), count: o.count }),
          ),
        ),
    );
    scopeSelect.value = scope;
    scopeSelect.addEventListener('change', () => {
      scope = scopeSelect.value as Scope;
    });

    const fillable = pocketAlbums(albums);
    const albumList = h('ol', { class: 'layout-albums' });
    const renderAlbums = () => {
      albumList.replaceChildren(
        ...fillable.map((album) => {
          const box = h('input', { attrs: { type: 'checkbox', name: 'album', value: album.albumId } });
          box.checked = chosen.includes(album.albumId);
          box.addEventListener('change', () => {
            chosen = box.checked ? [...chosen, album.albumId] : chosen.filter((id) => id !== album.albumId);
            renderAlbums();
          });
          const order = chosen.indexOf(album.albumId);
          const li = h(
            'li',
            {},
            h(
              'label',
              { class: 'check' },
              box,
              h(
                'span',
                { class: 'layout-order', attrs: { 'aria-hidden': 'true' } },
                order === -1 ? '' : String(order + 1),
              ),
              t('layout.albumOption', { letter: album.letter, name: album.name }),
            ),
          );
          li.dataset.album = album.letter;
          return li;
        }),
      );
      if (fillable.length === 0) albumList.append(h('li', { class: 'muted' }, t('layout.noAlbums')));
    };
    renderAlbums();

    const newAlbum = h(
      'button',
      {
        class: 'button button--secondary button--small',
        attrs: { type: 'button', 'data-action': 'new-album' },
        on: { click: () => openAlbumForm() },
      },
      t('layout.newAlbum'),
    );
    const error = h('p', { class: 'status status--error', attrs: { role: 'alert' } });
    error.hidden = true;
    const preview = h(
      'button',
      {
        class: 'button',
        attrs: { type: 'button', 'data-action': 'preview' },
        on: {
          click: () => {
            if (selectedAlbums().length === 0) {
              error.textContent = t('layout.chooseAlbum');
              error.hidden = false;
              return;
            }
            showPlan(planLayout(caps, selectedAlbums(), include));
          },
        },
      },
      t('layout.preview'),
    );

    body.replaceChildren(
      h('p', { class: 'muted' }, t('layout.intro')),
      h('label', { class: 'field' }, t('layout.scope'), scopeSelect),
      h('fieldset', { class: 'print-options' }, h('legend', {}, t('layout.albums')), albumList, newAlbum),
      error,
      preview,
    );

    function openAlbumForm(): void {
      const backdrop = h('div', {
        class: 'sheet-backdrop',
        on: { click: (e) => e.target === backdrop && backdrop.remove() },
      });
      backdrop.append(
        AlbumForm(ctx, {
          albums,
          onCancel: () => backdrop.remove(),
          onSaved: (saved) => {
            backdrop.remove();
            albums = [...albums, saved].sort((a, b) => a.letter.localeCompare(b.letter));
            if (saved.kind === 'album') chosen = [...chosen, saved.albumId];
            setup();
          },
        }),
      );
      el.append(backdrop);
    }
  }

  // ── preview ──

  function showPlan(plan: LayoutPlan): void {
    const cancel = h(
      'button',
      { class: 'button button--secondary', attrs: { type: 'button', 'data-action': 'cancel' }, on: { click: setup } },
      t('common.cancel'),
    );
    if (plan.shortfall) {
      const s = plan.shortfall;
      body.replaceChildren(
        h(
          'p',
          { class: 'status status--error', attrs: { role: 'alert', 'data-shortfall': '' } },
          s.nextLetter === null
            ? t('layout.shortfallNoLetter', { pockets: s.pockets, sheets: s.sheetsNeeded })
            : t('layout.shortfall', { pockets: s.pockets, sheets: s.sheetsNeeded, letter: s.nextLetter }),
        ),
        cancel,
      );
      return;
    }
    const byAlbum = Object.entries(plan.totals.sheetsUsedByAlbum)
      .map(([letter, count]) => t('layout.sheetsByAlbum', { letter, count }))
      .join(t('collection.separator'));
    const apply = h(
      'button',
      { class: 'button', attrs: { type: 'button', 'data-action': 'apply' }, on: { click: () => void run(plan) } },
      t('layout.apply'),
    );
    body.replaceChildren(
      h(
        'p',
        { class: 'layout-totals', attrs: { role: 'status', 'data-totals': '' } },
        t('layout.totals', { placed: plan.totals.placed, sheets: plan.sheets.length, gaps: plan.totals.gapsLeft }),
        h('br', {}),
        byAlbum,
      ),
      ...plan.sheets.map(SheetPreviewView),
      h('div', { class: 'layout-actions' }, apply, cancel),
    );
  }

  // ── apply ──

  /** Caps placed by this screen (or before): Resume skips them. */
  const placed = new Set<string>();

  async function run(plan: LayoutPlan): Promise<void> {
    const total = plan.placements.length;
    const bar = h('progress', { class: 'layout-progress', attrs: { max: String(total) } });
    bar.value = 0;
    const label = h('p', { class: 'muted', attrs: { role: 'status' } }, t('layout.applying', { done: 0, total }));
    body.replaceChildren(bar, label);
    const result = await applyLayout(
      ctx.api,
      plan.placements,
      (capId) => placed.has(capId),
      ({ done }) => {
        bar.value = done;
        label.textContent = t('layout.applying', { done, total });
      },
    );
    // Everything before the failed placement is in its pocket now (written or skipped).
    for (const p of plan.placements) {
      if (!result.ok && p === result.failed) break;
      placed.add(p.capId);
    }
    if (!result.ok) {
      const cap = caps.find((c) => c.capId === result.failed.capId);
      body.replaceChildren(
        bar,
        h(
          'p',
          { class: 'status status--error', attrs: { role: 'alert', 'data-failed': result.failed.capId } },
          t('layout.failed', {
            brand: cap?.brand ?? result.failed.capId,
            code: result.failed.code,
            placed: plan.placements.filter((p) => placed.has(p.capId)).length,
          }),
        ),
        h(
          'button',
          { class: 'button', attrs: { type: 'button', 'data-action': 'resume' }, on: { click: () => void run(plan) } },
          t('layout.resume'),
        ),
        h(
          'a',
          { class: 'button button--secondary', attrs: { href: pathFor('albums'), 'data-link': true } },
          t('layout.back'),
        ),
      );
      return;
    }
    done(plan);
  }

  function done(plan: LayoutPlan): void {
    const first = plan.sheets[0];
    const albumIds = [...new Set(plan.sheets.map((s) => s.albumId))];
    body.replaceChildren(
      h('p', { attrs: { role: 'status', 'data-done': '' } }, t('layout.done', { placed: plan.placements.length })),
      ...albumIds.map((albumId) => {
        const letter = plan.sheets.find((s) => s.albumId === albumId)?.letter ?? '';
        const link = h(
          'a',
          {
            class: 'button',
            attrs: { href: albumPlanPrintPath(albumId, plannedSheets(plan, albumId)), 'data-link': true },
          },
          t('layout.print', { letter }),
        );
        link.dataset.action = 'print';
        return link;
      }),
      ...(first === undefined
        ? []
        : [
            h(
              'a',
              {
                class: 'button button--secondary',
                attrs: {
                  href: albumSheetPath(first.albumId, first.sheet),
                  'data-link': true,
                  'data-action': 'open-sheet',
                },
              },
              t('layout.openSheet', { letter: first.letter, sheet: first.sheet }),
            ),
          ]),
    );
  }

  async function load(): Promise<void> {
    body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('layout.loading')));
    try {
      [albums, caps] = await Promise.all([
        ctx.api.request('/albums', { schema: AlbumListSchema }),
        fetchAllCaps(ctx.api),
      ]);
      chosen = pocketAlbums(albums).map((a) => a.albumId);
      for (const cap of caps) if (!isUnplaced(cap)) placed.add(cap.capId);
      setup();
    } catch {
      failed();
    }
  }

  void load();
  return el;
}

export const AlbumLayoutScreen: Screen = (ctx) => AlbumLayoutView(ctx);
