// "Already in collection" (SCREENS.md #4, CAP-42; ADR-003 outcome 2): reason line, the new photo next to the stored
// cap's (`GET /caps/{id}` → `imageUrls.top`), and an opt-in diff — nothing ticked by default. Update existing →
// `PATCH` with only the ticked fields (+ "+1 quantity", + "Replace top photo") → the cap's Detail. It's a variant →
// the form pre-filled with the scan's values and `variantOf`. Discard → Collection (SCREENS.md § Navigation); the
// uploaded images stay orphaned in S3 for the lifecycle rule, no delete call. Styles: styles/scan-duplicate.css.
import { Cap, type CapType, type Closure, type Material } from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import { capTitle, capImage } from '../components/cap-tile.js';
import { showToast } from '../components/toast.js';
import {
  diffRows,
  duplicateScan,
  hasTicks,
  updatePatch,
  variantPath,
  type DiffField,
  type DiffRow,
  type DuplicateMatch,
} from '../capture/duplicate.js';
import type { CaptureSession } from '../capture/context.js';
import { invalidateCollection } from '../collection/state.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { CLOSURE_LABEL, MATERIAL_LABEL, TYPE_LABEL } from '../i18n/labels.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

const LABEL: Readonly<Record<DiffField, MessageKey>> = {
  brand: 'form.brand',
  variant: 'form.variant',
  producer: 'form.producer',
  country: 'form.country',
  type: 'form.type',
  material: 'form.material',
  closure: 'form.closure',
  year: 'form.year',
  description: 'form.description',
  textOnCap: 'scanDuplicate.textOnCap',
};

/** A field value as shown in the diff; empty → the "—" of the form. */
function display(field: DiffField, value: DiffRow['stored']): string {
  if (value === undefined) return t('form.none');
  if (field === 'type') return t(TYPE_LABEL[value as CapType]);
  if (field === 'material') return t(MATERIAL_LABEL[value as Material]);
  if (field === 'closure') return t(CLOSURE_LABEL[value as Closure]);
  return String(value);
}

function objectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

function revoke(url: string | null): void {
  if (url !== null && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

export function reasonText(match: DuplicateMatch): string {
  return match.by === 'dhash'
    ? t('scanDuplicate.byImage', { distance: match.hammingDistance })
    : t('scanDuplicate.byBrand');
}

export const ScanDuplicateScreen: Screen = (ctx) => {
  const found = duplicateScan(ctx.capture.current());
  const preview = found?.session.top ? objectUrl(found.session.top.photo.blob) : null;

  const discard = h(
    'a',
    {
      class: 'header-action',
      attrs: { href: pathFor('collection'), 'data-link': true, 'data-action': 'discard' },
      on: {
        click: () => {
          revoke(preview);
          ctx.capture.clear();
        },
      },
    },
    t('scan.discard'),
  );
  const header = h(
    'header',
    { class: 'screen-header' },
    h('h1', { class: 'screen-title' }, t('scanDuplicate.title')),
    discard,
  );

  if (found === null) {
    // Reloaded or reached without a capture: the scan context lives in memory only (CAP-41).
    return h(
      'section',
      { class: 'screen scan-duplicate' },
      header,
      h('p', { class: 'muted', attrs: { role: 'status' } }, t('scanDuplicate.noScan')),
      h('a', { class: 'button', attrs: { href: pathFor('scan'), 'data-link': true } }, t('scanDuplicate.scanAgain')),
    );
  }
  const { session, match } = found;

  const storedPhoto = h('div', { class: 'duplicate-photo' });
  const body = h('div', { class: 'duplicate-body' });
  const el = h(
    'section',
    { class: 'screen scan-duplicate' },
    header,
    h('p', { class: 'duplicate-reason', attrs: { 'data-by': match.by } }, reasonText(match)),
    h(
      'div',
      { class: 'duplicate-photos' },
      h(
        'figure',
        { class: 'duplicate-figure', attrs: { 'data-photo': 'new' } },
        h(
          'div',
          { class: 'duplicate-photo' },
          preview === null ? '' : h('img', { class: 'cap-thumb', attrs: { src: preview, alt: '' } }),
        ),
        h('figcaption', {}, t('scanDuplicate.newPhoto')),
      ),
      h(
        'figure',
        { class: 'duplicate-figure', attrs: { 'data-photo': 'stored' } },
        storedPhoto,
        h('figcaption', {}, t('scanDuplicate.storedPhoto')),
      ),
    ),
    body,
  );

  const load = () => {
    body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('capDetail.loading')));
    Promise.resolve()
      .then(() => ctx.api.request(`/caps/${encodeURIComponent(match.capId)}`, { schema: Cap }))
      .then(
        (cap) => {
          storedPhoto.replaceChildren(capImage(cap));
          body.replaceChildren(...review(ctx, session, match, cap, () => revoke(preview)));
        },
        (error: unknown) => {
          const notFound = (error instanceof HttpError || error instanceof ProblemError) && error.status === 404;
          body.replaceChildren(
            h(
              'p',
              { class: 'status status--error', attrs: { role: 'alert' } },
              t(notFound ? 'capDetail.notFound' : 'capDetail.loadFailed'),
            ),
            notFound
              ? ''
              : h(
                  'button',
                  {
                    class: 'button button--secondary',
                    attrs: { type: 'button', 'data-action': 'retry' },
                    on: { click: load },
                  },
                  t('common.retry'),
                ),
          );
        },
      );
  };
  load();
  return el;
};

/** The diff, the shortcuts and the three actions, once the stored cap is loaded. */
function review(
  ctx: AppContext,
  session: CaptureSession,
  match: DuplicateMatch,
  cap: Cap,
  release: () => void,
): Node[] {
  const rows = diffRows(cap, session.response?.fields);
  const ticked = new Set<DiffField>();
  let quantity = false;
  let photo = false;
  let saving = false;

  const error = h('p', { class: 'status status--error', attrs: { role: 'alert' } });
  error.hidden = true;
  const update = h(
    'button',
    { class: 'button', attrs: { type: 'button', 'data-action': 'update' }, on: { click: () => void save() } },
    t('scanDuplicate.update'),
  );
  const ticks = () => ({ fields: ticked, quantity, photo });
  const refresh = () => {
    update.disabled = saving || !hasTicks(ticks());
  };

  const checkbox = (attrs: Record<string, string>, onChange: (checked: boolean) => void) =>
    h('input', {
      attrs: { type: 'checkbox', ...attrs },
      on: {
        change: (e) => {
          onChange((e.target as HTMLInputElement).checked);
          refresh();
        },
      },
    });

  const diff =
    rows.length === 0
      ? h('p', { class: 'muted', attrs: { 'data-diff': 'none' } }, t('scanDuplicate.noDiff'))
      : h(
          'ul',
          { class: 'duplicate-diff', attrs: { 'aria-label': t('scanDuplicate.diffLabel') } },
          ...rows.map((row) =>
            h(
              'li',
              { attrs: { 'data-field': row.field } },
              h(
                'label',
                { class: 'duplicate-row' },
                checkbox({ name: row.field }, (on) => (on ? ticked.add(row.field) : ticked.delete(row.field))),
                h('span', { class: 'duplicate-field' }, t(LABEL[row.field])),
                h(
                  'span',
                  { class: 'duplicate-values' },
                  h('span', { class: 'duplicate-stored' }, display(row.field, row.stored)),
                  t('scanDuplicate.arrow'),
                  h('span', { class: 'duplicate-next' }, display(row.field, row.next)),
                ),
              ),
            ),
          ),
        );

  const plusOne = h(
    'button',
    {
      class: 'chip',
      attrs: { type: 'button', 'data-action': 'quantity', 'aria-pressed': 'false' },
      on: {
        click: () => {
          quantity = !quantity;
          plusOne.setAttribute('aria-pressed', String(quantity));
          refresh();
        },
      },
    },
    t('scanDuplicate.plusOne', { from: cap.quantity, to: cap.quantity + 1 }),
  );

  const replacePhoto = h(
    'label',
    { class: 'duplicate-row duplicate-row--photo' },
    checkbox({ name: 'replaceTop', 'data-action': 'photo' }, (on) => (photo = on)),
    h('span', { class: 'duplicate-field' }, t('scanDuplicate.replacePhoto')),
  );

  async function save(): Promise<void> {
    const patch = updatePatch(cap, rows, ticks(), session);
    if (patch === null || saving) return;
    saving = true;
    error.hidden = true;
    refresh();
    try {
      await ctx.api.request(`/caps/${encodeURIComponent(cap.capId)}`, { method: 'PATCH', body: patch, schema: Cap });
      ctx.capture.clear();
      release();
      invalidateCollection(ctx);
      ctx.navigate(pathFor('capDetail', { id: cap.capId }));
      showToast(t('scanDuplicate.updated'));
    } catch {
      error.textContent = t('scanDuplicate.updateFailed');
      error.hidden = false;
    } finally {
      saving = false;
      refresh();
    }
  }

  refresh();
  return [
    h('p', { class: 'duplicate-title' }, capTitle(cap)),
    diff,
    h('div', { class: 'chips' }, plusOne),
    replacePhoto,
    error,
    h(
      'div',
      { class: 'duplicate-actions' },
      update,
      h(
        'a',
        {
          class: 'button button--secondary',
          attrs: { href: variantPath(session.scanId, match.capId), 'data-link': true, 'data-action': 'variant' },
          on: { click: release },
        },
        t('scanDuplicate.variant'),
      ),
    ),
  ];
}
