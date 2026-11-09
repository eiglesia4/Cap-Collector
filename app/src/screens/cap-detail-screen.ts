// Cap detail (SCREENS.md #6, CAP-24): header (back to Collection, Edit, "⋯" with Share, Re-identify with AI (CAP-43)
// and Delete), top photo with
// the underside as a swappable thumbnail, title and producer · country · year, chips, stat tiles, fields card,
// "Where is it?", the "Same brand" carousel and the history list. Data: `GET /caps/{capId}`, `/history` and
// `GET /caps?q=<brand>` (openapi.yaml); delete is a tombstone (`DELETE`, ADR-006) followed by an undo-less "Deleted"
// toast in V1 (restore is V2).
import { Cap, formatLocationCode, Location, type CapHistory } from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import { sameBrand } from '../cap/brand.js';
import { CapHistoryListSchema, NoContentSchema } from '../cap/schemas.js';
import { linkOrigin, shareRequest } from '../cap/share.js';
import { CapPageSchema } from '../collection/cap-page.js';
import { capsPath, DEFAULT_QUERY } from '../collection/query.js';
import { forgetCap } from '../collection/state.js';
import { capImage, capTitle, CapTile } from '../components/cap-tile.js';
import { ConfirmSheet } from '../components/confirm-sheet.js';
import { showToast } from '../components/toast.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { CLOSURE_LABEL, CONDITION_LABEL, MATERIAL_LABEL, TYPE_LABEL } from '../i18n/labels.js';
import { exchangePath, pathFor } from '../router/routes.js';
import { h, type Child } from '../ui/dom.js';

/** Same-brand caps fetched for the carousel (one page). */
export const VARIANTS_LIMIT = 60;

const ACTION_LABEL: Record<CapHistory['action'], MessageKey> = {
  created: 'history.created',
  updated: 'history.updated',
  located: 'history.located',
  moved: 'history.moved',
  swapped: 'history.swapped',
  deleted: 'history.deleted',
  restored: 'history.restored',
  reidentified: 'history.reidentified',
};

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

export function formatDate(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : dateFormat.format(d);
}

function value(v: unknown): string {
  if (v === undefined || v === null) return t('history.empty');
  if (typeof v === 'string') return v;
  if (typeof v === 'object' && v !== null && 'kind' in v) {
    const loc = Location.safeParse(v);
    if (loc.success) return formatLocationCode(loc.data);
  }
  return JSON.stringify(v);
}

/** One line summarising a history entry's changes: `year: 2022 → 2023; producer: Mahou → —`. */
export function changesLine(entry: CapHistory): string {
  return entry.changes
    .map((c) =>
      'from' in c && c.from !== undefined
        ? t('history.change', { field: c.field, from: value(c.from), to: value(c.to) })
        : t('history.set', { field: c.field, to: value(c.to) }),
    )
    .join(t('history.changeSeparator'));
}

export { sameBrand };

/** Caps of the same brand as `cap`, excluding `cap` itself. */
export function variantsOf(cap: Cap, candidates: readonly Cap[]): Cap[] {
  return candidates.filter((c) => c.capId !== cap.capId && sameBrand(c.brand, cap.brand));
}

function isNotFound(error: unknown): boolean {
  return (error instanceof HttpError || error instanceof ProblemError) && error.status === 404;
}

export const CapDetailScreen: Screen = (ctx, route) => {
  const capId = route.params.id ?? '';
  const body = h('div', { class: 'detail-body' });
  const actions = h('span', { class: 'header-actions' });
  const back = h(
    'a',
    { class: 'header-action back-link', attrs: { href: pathFor('collection'), 'data-link': true } },
    t('capDetail.back'),
  );
  const el = h('section', { class: 'screen cap-detail' }, h('header', { class: 'screen-header' }, back, actions), body);

  const load = () => {
    body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('capDetail.loading')));
    Promise.resolve()
      .then(() => ctx.api.request(`/caps/${encodeURIComponent(capId)}`, { schema: Cap }))
      .then(
        (cap) => render(ctx, el, cap),
        (error: unknown) => {
          const notFound = isNotFound(error);
          body.replaceChildren(
            h(
              'div',
              { class: 'detail-error' },
              h('p', { attrs: { role: 'status' } }, t(notFound ? 'capDetail.notFound' : 'capDetail.loadFailed')),
              !notFound &&
                h(
                  'button',
                  { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: load } },
                  t('common.retry'),
                ),
            ),
          );
        },
      );
  };

  function render(context: AppContext, root: HTMLElement, cap: Cap): void {
    actions.replaceChildren(
      h(
        'a',
        {
          class: 'header-action',
          attrs: { href: pathFor('capEdit', { id: cap.capId }), 'data-link': true },
        },
        t('capDetail.edit'),
      ),
      moreMenu(context, root, cap),
    );
    body.replaceChildren(
      h(
        'div',
        { class: 'detail-content' },
        photos(cap),
        h('h1', { class: 'screen-title detail-title' }, capTitle(cap)),
        subtitle(cap),
        chips(cap),
        stats(cap),
        fieldsCard(cap),
        whereIsIt(cap),
        variantsSection(context, cap),
        historySection(context, cap),
      ),
    );
  }

  load();
  return el;
};

function moreMenu(ctx: AppContext, root: HTMLElement, cap: Cap): HTMLElement {
  const menu: HTMLDetailsElement = h(
    'details',
    { class: 'more-menu' },
    h(
      'summary',
      { class: 'header-action', attrs: { 'aria-label': t('capDetail.more') } },
      h('span', { class: 'icon-more', attrs: { 'aria-hidden': 'true' } }),
    ),
    h(
      'div',
      { class: 'menu' },
      h(
        'button',
        {
          class: 'menu-item',
          attrs: { type: 'button', 'data-action': 'share' },
          on: {
            click: () => {
              menu.open = false;
              void ctx.platform
                .share(shareRequest(cap, linkOrigin(ctx.platform.kind, ctx.config.webUrl, window.location.origin)))
                .catch(() => false);
            },
          },
        },
        t('capDetail.share'),
      ),
      h(
        'a',
        {
          class: 'menu-item',
          attrs: { href: pathFor('capReidentify', { id: cap.capId }), 'data-link': true, 'data-action': 'reidentify' },
          on: { click: () => (menu.open = false) },
        },
        t('capDetail.reidentify'),
      ),
      // Exchange (CAP-45, SCREENS.md § Navigation): this cap as a request bundle for an external AI.
      h(
        'a',
        {
          class: 'menu-item',
          attrs: { href: exchangePath({ capId: cap.capId }), 'data-link': true, 'data-action': 'ask-external' },
          on: { click: () => (menu.open = false) },
        },
        t('capDetail.askExternal'),
      ),
      h(
        'button',
        {
          class: 'menu-item menu-item--danger',
          attrs: { type: 'button', 'data-action': 'delete' },
          on: {
            click: () => {
              menu.open = false;
              void confirmDelete(ctx, root, cap);
            },
          },
        },
        t('capDetail.delete'),
      ),
    ),
  );
  return menu;
}

async function confirmDelete(ctx: AppContext, root: HTMLElement, cap: Cap): Promise<void> {
  const ok = await ConfirmSheet(root, {
    message: t('capDetail.deleteConfirm', { name: capTitle(cap) }),
    confirm: t('capDetail.delete'),
    cancel: t('common.cancel'),
    danger: true,
  });
  if (!ok) return;
  try {
    await ctx.api.request(`/caps/${encodeURIComponent(cap.capId)}`, { method: 'DELETE', schema: NoContentSchema });
  } catch {
    showToast(t('capDetail.deleteFailed'));
    return;
  }
  forgetCap(ctx, cap.capId);
  ctx.navigate(pathFor('collection'));
  // V1: the toast only says "Deleted"; restore (undo) comes in V2.
  showToast(t('capDetail.deleted'));
}

function photos(cap: Cap): HTMLElement {
  let side: 'top' | 'underside' = 'top';
  const main = h('div', { class: 'detail-photo' }, capImage(cap, 'top', 'detail-photo-img'));
  const hasUnderside = cap.images.underside !== undefined;
  const thumb = h(
    'button',
    {
      class: 'detail-photo-thumb',
      attrs: { type: 'button', 'aria-label': t('capDetail.swapPhoto') },
      on: {
        click: () => {
          const other = side;
          side = side === 'top' ? 'underside' : 'top';
          main.replaceChildren(capImage(cap, side, 'detail-photo-img'));
          thumb.replaceChildren(capImage(cap, other, 'cap-thumb'));
          main.dataset.side = side;
        },
      },
    },
    capImage(cap, 'underside', 'cap-thumb'),
  );
  main.dataset.side = side;
  return h('div', { class: 'detail-photos' }, main, hasUnderside && thumb);
}

function subtitle(cap: Cap): Child {
  const line = [cap.producer, cap.country, cap.year === undefined ? undefined : String(cap.year)]
    .filter(Boolean)
    .join(t('collection.separator'));
  return line !== '' && h('p', { class: 'detail-subtitle muted' }, line);
}

function chips(cap: Cap): Child {
  const labels = [
    cap.status === 'complete'
      ? undefined
      : t(cap.status === 'needsReview' ? 'capDetail.needsReview' : 'capDetail.unidentified'),
    cap.type && t(TYPE_LABEL[cap.type]),
    cap.material && t(MATERIAL_LABEL[cap.material]),
    cap.closure && t(CLOSURE_LABEL[cap.closure]),
    cap.condition && t(CONDITION_LABEL[cap.condition]),
  ].filter((l): l is string => Boolean(l));
  return (
    labels.length > 0 &&
    h('div', { class: 'chips detail-chips' }, ...labels.map((l) => h('span', { class: 'chip' }, l)))
  );
}

function stats(cap: Cap): HTMLElement {
  const tile = (label: string, v: string) =>
    h(
      'div',
      { class: 'stat-tile' },
      h('span', { class: 'stat-value' }, v),
      h('span', { class: 'stat-label muted' }, label),
    );
  return h(
    'div',
    { class: 'stat-tiles' },
    tile(t('capDetail.quantity'), String(cap.quantity)),
    tile(t('capDetail.forTrade'), String(cap.forTrade)),
    tile(t('capDetail.added'), cap.createdAt.slice(0, 4)),
  );
}

function fieldsCard(cap: Cap): Child {
  const rows: [MessageKey, string | undefined][] = [
    ['capDetail.acquiredWhere', cap.acquiredWhere],
    ['capDetail.acquiredOn', cap.acquiredOn && formatDate(cap.acquiredOn)],
    ['capDetail.tags', cap.tags.length > 0 ? cap.tags.join(t('capDetail.tagSeparator')) : undefined],
    ['capDetail.textOnCap', cap.textOnCap],
    ['capDetail.description', cap.description],
    ['capDetail.notes', cap.notes],
  ];
  const present = rows.filter((r): r is [MessageKey, string] => r[1] !== undefined && r[1] !== '');
  return (
    present.length > 0 &&
    h('dl', { class: 'card fields-card' }, ...present.flatMap(([k, v]) => [h('dt', {}, t(k)), h('dd', {}, v)]))
  );
}

function whereIsIt(cap: Cap): HTMLElement {
  return h(
    'div',
    { class: 'card where-row' },
    h('span', { class: 'muted' }, t('capDetail.where')),
    h('strong', { class: 'where-code' }, cap.location ? formatLocationCode(cap.location) : t('capDetail.notInAlbum')),
  );
}

function variantsSection(ctx: AppContext, cap: Cap): HTMLElement {
  const title = h('h2', { class: 'section-title' });
  const list = h('ul', { class: 'cap-carousel' });
  const section = h('section', { class: 'detail-variants' }, title, list);
  section.hidden = true;
  const query = { ...DEFAULT_QUERY, q: cap.brand };
  Promise.resolve()
    .then(() => ctx.api.request(capsPath(query, { limit: VARIANTS_LIMIT }), { schema: CapPageSchema }))
    .then((page) => {
      const variants = variantsOf(cap, page.items);
      title.textContent = t(variants.length === 1 ? 'capDetail.variantsOne' : 'capDetail.variants', {
        count: variants.length,
      });
      list.replaceChildren(...variants.map(CapTile));
      section.hidden = variants.length === 0;
    })
    // A convenience row: on failure it simply stays hidden.
    .catch(() => undefined);
  return section;
}

function historySection(ctx: AppContext, cap: Cap): HTMLElement {
  const list = h('ol', { class: 'history-list' });
  const section = h(
    'section',
    { class: 'detail-history' },
    h('h2', { class: 'section-title' }, t('capDetail.history')),
    list,
  );
  Promise.resolve()
    .then(() => ctx.api.request(`/caps/${encodeURIComponent(cap.capId)}/history`, { schema: CapHistoryListSchema }))
    .then((entries) => {
      // The API returns newest first; sort anyway so the order never depends on it.
      const sorted = [...entries].sort((a, b) => b.ts.localeCompare(a.ts));
      list.replaceChildren(
        ...sorted.map((e) => {
          const line = changesLine(e);
          return h(
            'li',
            { class: 'history-item' },
            h(
              'span',
              { class: 'history-head' },
              h('strong', {}, t(ACTION_LABEL[e.action])),
              h('time', { class: 'muted', attrs: { datetime: e.ts } }, formatDate(e.ts)),
            ),
            line !== '' && h('span', { class: 'history-changes muted' }, line),
          );
        }),
      );
      if (sorted.length === 0) list.replaceChildren(h('li', { class: 'muted' }, t('capDetail.noHistory')));
    })
    .catch(() => list.replaceChildren(h('li', { class: 'muted' }, t('capDetail.historyFailed'))));
  return section;
}
