// Albums (CAP-52; SCREENS.md § Navigation: "Albums behind ⋯ on Collection"; ADR-005; physical-link.md § The album):
// the user's albums, boxes and frames (letter badge, name, kind; albums show `used / total` pockets — total from the
// geometry, used "—" until the album has been opened once, then from the loaded sheets) and the "+ New" / Edit
// sheet: letter (the next free one proposed), name, kind, sheets/cols/rows (Leuchtturm GRANDE 6 × 7 by default),
// optional pocket/pitch mm. `POST /albums` (409 → the letter is taken, inline) or `PATCH /albums/{id}` with the changed
// fields only (409 → shrinking below an occupied pocket / renaming an album that holds caps). Tapping an album opens
// its sheet 1 (album-sheet-screen.ts). Styles: styles/albums.css.
import { Album, type AlbumInput } from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import { recordSheetUsage, usedPockets } from '../albums/known.js';
import {
  albumPatch,
  albumSheetPath,
  albumValues,
  AlbumListSchema,
  newAlbumValues,
  totalPockets,
  validateAlbum,
  type AlbumFormErrors,
  type AlbumFormField,
  type AlbumFormValues,
} from '../albums/model.js';
import { ScreenHeader } from '../components/screen-header.js';
import { showToast } from '../components/toast.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

export const KIND_LABEL: Readonly<Record<Album['kind'], MessageKey>> = {
  album: 'albums.kindAlbum',
  box: 'albums.kindBox',
  frame: 'albums.kindFrame',
};

const ERROR_LABEL: Readonly<Record<NonNullable<AlbumFormErrors[AlbumFormField]>, MessageKey>> = {
  required: 'albums.errorRequired',
  invalid: 'albums.errorInvalid',
  pitch: 'albums.errorPitch',
};

const FIELD_LABEL: Readonly<Record<AlbumFormField, MessageKey>> = {
  letter: 'albums.letter',
  name: 'albums.name',
  kind: 'albums.kind',
  sheets: 'albums.sheets',
  cols: 'albums.cols',
  rows: 'albums.rows',
  pocketMm: 'albums.pocketMm',
  pitchMm: 'albums.pitchMm',
};

export interface AlbumFormOptions {
  /** Every album, box and frame (the next free letter). */
  readonly albums: readonly Album[];
  /** The record being edited; absent → "+ New". */
  readonly album?: Album;
  onSaved(album: Album): void;
  onCancel(): void;
}

/** The "+ New" / Edit sheet. */
export function AlbumForm(ctx: AppContext, options: AlbumFormOptions): HTMLElement {
  const { album } = options;
  let values: AlbumFormValues = album ? albumValues(album) : newAlbumValues(options.albums);
  let saving = false;

  const errorFor = new Map<AlbumFormField, HTMLElement>();
  const fieldFor = new Map<AlbumFormField, HTMLElement>();
  const formStatus = h('p', { class: 'status status--error', attrs: { role: 'alert', 'data-status': 'form' } });

  const set = (name: AlbumFormField, value: string) => {
    values = { ...values, [name]: value };
  };

  function field(name: AlbumFormField, control: HTMLElement, hint?: string): HTMLElement {
    const id = `album-${name}`;
    control.id = id;
    control.dataset.field = name;
    const error = h('p', { class: 'field-error', attrs: { 'data-error': name } });
    error.hidden = true;
    errorFor.set(name, error);
    const el = h(
      'div',
      { class: 'field' },
      h('label', { attrs: { for: id } }, t(FIELD_LABEL[name])),
      control,
      hint !== undefined && h('p', { class: 'muted field-hint' }, hint),
      error,
    );
    fieldFor.set(name, el);
    return el;
  }

  function input(name: Exclude<AlbumFormField, 'kind'>, attrs: Record<string, string>): HTMLInputElement {
    const el = h('input', { class: 'input', attrs: { autocomplete: 'off', ...attrs } });
    el.value = values[name];
    el.addEventListener('input', () => set(name, el.value));
    return el;
  }

  const letter = input('letter', { maxlength: '1', autocapitalize: 'characters', inputmode: 'text' });
  letter.addEventListener('input', () => {
    letter.value = letter.value.toUpperCase();
    set('letter', letter.value);
  });
  const name = input('name', { maxlength: '60' });
  const kind = h('select', { class: 'input' });
  for (const k of ['album', 'box', 'frame'] as const) {
    const option = h('option', { attrs: { value: k } }, t(KIND_LABEL[k]));
    option.selected = values.kind === k;
    kind.append(option);
  }
  const numberAttrs = (min: string, max: string) => ({ type: 'number', inputmode: 'numeric', min, max });
  const geometry = h(
    'div',
    { class: 'album-geometry field-row' },
    field('sheets', input('sheets', numberAttrs('1', '99'))),
    field('cols', input('cols', numberAttrs('1', '12'))),
    field('rows', input('rows', numberAttrs('1', '12'))),
  );
  const decimal = { type: 'number', inputmode: 'decimal', step: '0.5' };
  const measures = h(
    'div',
    { class: 'album-measures' },
    h(
      'div',
      { class: 'field-row' },
      field('pocketMm', input('pocketMm', { ...decimal, min: '10', max: '100' })),
      field('pitchMm', input('pitchMm', { ...decimal, min: '10', max: '120' })),
    ),
    h('p', { class: 'muted field-hint' }, t('albums.measureHint')),
  );
  const showGeometry = () => {
    geometry.hidden = values.kind !== 'album';
  };
  kind.addEventListener('change', () => {
    set('kind', kind.value);
    showGeometry();
  });
  showGeometry();

  function showErrors(errors: AlbumFormErrors, letterTaken = false): void {
    for (const [name, el] of errorFor) {
      const problem = errors[name];
      const message =
        name === 'letter' && letterTaken
          ? t('albums.letterTaken', { letter: values.letter.toUpperCase() })
          : problem
            ? t(ERROR_LABEL[problem])
            : '';
      el.textContent = message;
      el.hidden = message === '';
      fieldFor.get(name)?.classList.toggle('field--invalid', message !== '');
    }
  }

  const save = h(
    'button',
    { class: 'button', attrs: { type: 'submit', 'data-action': 'save-album' } },
    t('common.save'),
  );
  const cancel = h(
    'button',
    {
      class: 'button button--secondary',
      attrs: { type: 'button', 'data-action': 'cancel' },
      on: { click: () => options.onCancel() },
    },
    t('common.cancel'),
  );

  async function submit(): Promise<void> {
    if (saving) return;
    formStatus.textContent = '';
    const result = validateAlbum(values);
    if (!result.ok) {
      showErrors(result.errors);
      return;
    }
    showErrors({});
    saving = true;
    save.disabled = true;
    try {
      const saved = album ? await patch(album, result.input) : await create(result.input);
      options.onSaved(saved);
    } catch (error) {
      const status = error instanceof ProblemError || error instanceof HttpError ? error.status : 0;
      if (status === 409 && !album) {
        showErrors({}, true);
      } else if (status === 409) {
        const detail = error instanceof ProblemError ? error.problem.detail : undefined;
        formStatus.textContent =
          detail !== undefined ? t('albums.editConflict', { detail }) : t('albums.editConflictGeneric');
      } else {
        formStatus.textContent = t('albums.saveFailed');
      }
    } finally {
      saving = false;
      save.disabled = false;
    }
  }

  function create(body: AlbumInput): Promise<Album> {
    return ctx.api.request('/albums', { method: 'POST', body, schema: Album });
  }

  async function patch(prev: Album, input: AlbumInput): Promise<Album> {
    const body = albumPatch(prev, input);
    if (body === null) return prev;
    return ctx.api.request(`/albums/${encodeURIComponent(prev.albumId)}`, { method: 'PATCH', body, schema: Album });
  }

  const form = h(
    'form',
    {
      class: 'sheet album-form',
      attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'album-form-title', novalidate: true },
      on: {
        submit: (event) => {
          event.preventDefault();
          void submit();
        },
      },
    },
    h(
      'h2',
      { class: 'sheet-title', attrs: { id: 'album-form-title' } },
      album ? t('albums.editTitle', { letter: album.letter }) : t('albums.newTitle'),
    ),
    h('div', { class: 'field-row' }, field('letter', letter), field('kind', kind)),
    field('name', name),
    geometry,
    measures,
    formStatus,
    save,
    cancel,
  );
  return form;
}

function usageText(ctx: AppContext, album: Album): string | null {
  const total = totalPockets(album);
  if (total === null) return null;
  const used = usedPockets(ctx, album.albumId);
  return used === null
    ? t('albums.usageUnknown', { total: String(total) })
    : t('albums.usage', { used: String(used), total: String(total) });
}

export const AlbumsScreen: Screen = (ctx) => {
  let albums: Album[] = [];
  const list = h('ul', { class: 'album-list', attrs: { 'aria-label': t('albums.title') } });
  const message = h('div', { class: 'albums-message', attrs: { role: 'status' } });

  const close = h(
    'a',
    { class: 'header-action', attrs: { href: pathFor('collection'), 'data-link': true } },
    t('common.close'),
  );
  const add = h(
    'button',
    {
      class: 'header-action',
      attrs: { type: 'button', 'data-action': 'new-album' },
      on: { click: () => openForm() },
    },
    t('albums.new'),
  );

  const el = h(
    'section',
    { class: 'screen albums' },
    ScreenHeader(t('albums.title'), h('span', { class: 'header-actions' }, add, close)),
    list,
    message,
  );

  function row(album: Album): HTMLElement {
    const usage = usageText(ctx, album);
    const body = [
      h('span', { class: 'album-letter', attrs: { 'aria-hidden': 'true' } }, album.letter),
      h(
        'span',
        { class: 'album-text' },
        h('span', { class: 'album-name' }, album.name),
        h('span', { class: 'album-kind muted' }, t(KIND_LABEL[album.kind])),
      ),
      usage !== null && h('span', { class: 'album-usage muted', attrs: { 'data-usage': '' } }, usage),
    ];
    const main =
      album.kind === 'album'
        ? h('a', { class: 'album-main', attrs: { href: albumSheetPath(album.albumId, 1), 'data-link': true } }, ...body)
        : h('div', { class: 'album-main' }, ...body);
    const edit = h(
      'button',
      {
        class: 'button button--secondary button--small',
        attrs: {
          type: 'button',
          'data-action': 'edit-album',
          'aria-label': t('albums.editTitle', { letter: album.letter }),
        },
        on: { click: () => openForm(album) },
      },
      t('albums.edit'),
    );
    const li = h('li', { class: 'album-row' }, main, edit);
    li.dataset.album = album.letter;
    return li;
  }

  function render(): void {
    list.replaceChildren(...albums.map(row));
    message.replaceChildren(albums.length === 0 ? h('p', { class: 'muted' }, t('albums.empty')) : '');
  }

  function openForm(album?: Album): void {
    const backdrop = h('div', {
      class: 'sheet-backdrop',
      on: { click: (e) => e.target === backdrop && backdrop.remove() },
    });
    backdrop.append(
      AlbumForm(ctx, {
        albums,
        ...(album ? { album } : {}),
        onCancel: () => backdrop.remove(),
        onSaved: (saved) => {
          backdrop.remove();
          const i = albums.findIndex((a) => a.albumId === saved.albumId);
          albums = i === -1 ? [...albums, saved] : albums.map((a) => (a.albumId === saved.albumId ? saved : a));
          albums.sort((a, b) => a.letter.localeCompare(b.letter));
          // A new album is empty: its usage is known without opening it.
          if (i === -1 && saved.kind === 'album') recordSheetUsage(ctx, saved.albumId, 1, 0);
          render();
          showToast(t('form.saved'));
        },
      }),
    );
    el.append(backdrop);
    backdrop.querySelector<HTMLInputElement>(album ? '[data-field="name"]' : '[data-field="letter"]')?.focus();
  }

  async function load(): Promise<void> {
    message.replaceChildren(h('p', { class: 'muted' }, t('albums.loading')));
    try {
      albums = await ctx.api.request('/albums', { schema: AlbumListSchema });
      render();
    } catch {
      message.replaceChildren(
        h('p', { attrs: { role: 'alert' } }, t('albums.loadFailed')),
        h(
          'button',
          { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => void load() } },
          t('common.retry'),
        ),
      );
    }
  }

  void load();
  return el;
};
