// Placing a cap in the album (CAP-53; SCREENS.md #6 "Where is it?" and #7 move / swap; physical-link.md § Keeping
// them in sync; ADR-005): the bottom sheets every entry point shares — the "Where is it?" actions (Assign / Move,
// Swap with…, Remove from album) opened from Detail and from a long-press on the album sheet, the pocket picker
// (album letter → the CAP-52 sheet grid in pick mode, or a typed code `A·3·17`), the explicit confirmations (move,
// swap, remove — never silent, CLAUDE.md § Invariantes) with a 409 "pocket occupied" turned into a Swap offer, and the
// one-line next-free proposal on save ("Put it in A·3·17?" Yes / Choose… / Not now). Styles: styles/albums.css.
import type { Album, AlbumLocation, Location, SheetView } from '@capcollector/shared';
import { formatLocationCode } from '@capcollector/shared';

import {
  cellLocation,
  clearLocation,
  defaultAlbum,
  fetchAlbums,
  fetchSheet,
  isOccupied,
  nextFree,
  occupantAt,
  pocketAlbums,
  putLocation,
  readLastAlbum,
  samePocket,
  typedLocation,
  writeLastAlbum,
  type LocationResult,
} from '../albums/place.js';
import { sheetCells, sheetCount } from '../albums/model.js';
import type { AppContext } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { h, type Child } from '../ui/dom.js';
import { ConfirmSheet } from './confirm-sheet.js';
import { showToast } from './toast.js';

type SheetPocket = SheetView['pockets'][number];

/** The cap being placed: its id, the name shown in the confirmations, and where it is now. */
export interface PlaceSubject {
  readonly capId: string;
  readonly name: string;
  readonly location?: Location | undefined;
}

export type PlaceOutcome = { readonly kind: 'placed'; readonly result: LocationResult } | { readonly kind: 'cleared' };

/** A bottom sheet with arbitrary content; `close(value)` removes it. A tap on the backdrop closes it with null. */
function bottomSheet<T>(
  host: HTMLElement,
  build: (close: (value: T | null) => void) => Child[],
  className = '',
): Promise<T | null> {
  return new Promise((resolve) => {
    const close = (value: T | null) => {
      backdrop.remove();
      resolve(value);
    };
    const backdrop = h('div', {
      class: 'sheet-backdrop',
      on: { click: (e) => e.target === backdrop && close(null) },
    });
    backdrop.append(
      h(
        'div',
        { class: `sheet ${className}`.trim(), attrs: { role: 'dialog', 'aria-modal': 'true' } },
        ...build(close),
      ),
    );
    host.append(backdrop);
  });
}

function sheetButton(label: string, action: string, onClick: () => void, secondary = true): HTMLButtonElement {
  return h(
    'button',
    {
      class: secondary ? 'button button--secondary' : 'button',
      attrs: { type: 'button', 'data-action': action },
      on: { click: onClick },
    },
    label,
  );
}

// ── pocket picker ──

export interface PickOptions {
  readonly albums: readonly Album[];
  /** `free`: empty pockets are tappable, taken ones greyed with their brand. `occupied`: the reverse (Swap with…). */
  readonly mode: 'free' | 'occupied';
  /** The cap being placed: its own pocket is never a target. */
  readonly capId?: string;
  /** Where the grid opens: the cap's pocket, else the default album's first sheet. */
  readonly start?: AlbumLocation;
}

export interface Picked {
  readonly location: AlbumLocation;
  /** The cap in that pocket, when the grid showed one. */
  readonly occupant?: SheetPocket;
}

const CODE_ERROR: Record<'invalid' | 'noAlbum' | 'outOfRange', MessageKey> = {
  invalid: 'place.codeInvalid',
  noAlbum: 'place.codeNoAlbum',
  outOfRange: 'place.codeOutOfRange',
};

/** Album letter → sheet → the sheet grid in pick mode, or a typed code. Resolves null on Cancel. */
export function pickLocation(ctx: AppContext, host: HTMLElement, options: PickOptions): Promise<Picked | null> {
  const albums = pocketAlbums(options.albums);
  return bottomSheet<Picked>(
    host,
    (close) => {
      const startAlbum = albums.find((a) => a.letter === options.start?.album) ?? albums[0];
      let album: Album | undefined = startAlbum;
      let sheet = options.start && startAlbum?.letter === options.start.album ? options.start.sheet : 1;

      const albumSelect = h(
        'select',
        {
          attrs: { name: 'album', 'aria-label': t('place.album') },
          on: {
            change: () => {
              album = albums.find((a) => a.letter === albumSelect.value);
              sheet = 1;
              renderSheets();
              void loadGrid();
            },
          },
        },
        ...albums.map((a) =>
          h(
            'option',
            { attrs: { value: a.letter, selected: a === album } },
            t('place.albumOption', { letter: a.letter, name: a.name }),
          ),
        ),
      );
      const sheetSelect = h('select', {
        attrs: { name: 'sheet', 'aria-label': t('place.sheet') },
        on: {
          change: () => {
            sheet = Number(sheetSelect.value);
            void loadGrid();
          },
        },
      });
      const renderSheets = () => {
        const n = album ? sheetCount(album) : 0;
        sheetSelect.replaceChildren(
          ...Array.from({ length: n }, (_, i) =>
            h(
              'option',
              { attrs: { value: String(i + 1), selected: i + 1 === sheet } },
              t('place.sheetOption', { sheet: String(i + 1) }),
            ),
          ),
        );
      };

      const grid = h('div', { class: 'pick-grid-host' });
      async function loadGrid(): Promise<void> {
        if (!album) return;
        const current = album;
        grid.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('sheet.loading')));
        let view: SheetView;
        try {
          view = await fetchSheet(ctx.api, current.albumId, sheet);
        } catch {
          grid.replaceChildren(h('p', { attrs: { role: 'alert' } }, t('sheet.loadFailed')));
          return;
        }
        const list = h('ol', {
          class: 'sheet-grid pick-grid',
          attrs: { style: `--cols: ${String(view.cols)}`, 'aria-label': t('sheet.grid') },
        });
        for (const cell of sheetCells(view)) {
          const own = cell.cap?.capId !== undefined && cell.cap.capId === options.capId;
          const enabled = !own && (options.mode === 'free' ? !cell.cap : Boolean(cell.cap));
          const label = cell.cap
            ? t('place.cellTaken', { brand: cell.cap.brand, code: cell.code })
            : t('place.cellFree', { code: cell.code });
          const button = h(
            'button',
            {
              class: 'pocket-link',
              attrs: { type: 'button', 'aria-label': label, disabled: !enabled },
              on: {
                click: () =>
                  close({
                    location: cellLocation(view.letter, view.sheet, cell.pocket),
                    ...(cell.cap ? { occupant: cell.cap } : {}),
                  }),
              },
            },
            cell.cap
              ? h('span', { class: 'pocket-brand' }, cell.cap.brand)
              : h('span', { class: 'pocket-thumb pocket-number' }, String(cell.pocket)),
          );
          const li = h(
            'li',
            {
              class: [
                'pocket',
                cell.cap ? 'pocket--occupied' : 'pocket--empty',
                enabled ? '' : 'pocket--disabled',
                own ? 'pocket--own' : '',
              ]
                .filter(Boolean)
                .join(' '),
            },
            button,
          );
          li.dataset.pocket = String(cell.pocket);
          li.dataset.code = cell.code;
          list.append(li);
        }
        grid.replaceChildren(list);
      }

      const codeInput = h('input', {
        attrs: {
          name: 'code',
          type: 'text',
          autocapitalize: 'characters',
          autocomplete: 'off',
          placeholder: t('place.codePlaceholder'),
          'aria-label': t('place.code'),
        },
      });
      const codeError = h('p', { class: 'status status--error', attrs: { role: 'alert' } });
      codeError.hidden = true;
      const codeForm = h(
        'form',
        {
          class: 'pick-code',
          on: {
            submit: (e) => {
              e.preventDefault();
              const typed = typedLocation(codeInput.value, albums);
              if (!typed.ok) {
                codeError.textContent = t(CODE_ERROR[typed.reason]);
                codeError.hidden = false;
                return;
              }
              close({ location: typed.location });
            },
          },
        },
        codeInput,
        h(
          'button',
          { class: 'button button--secondary', attrs: { type: 'submit', 'data-action': 'use-code' } },
          t('place.go'),
        ),
      );

      renderSheets();
      void loadGrid();
      return [
        h('p', { class: 'sheet-message' }, t(options.mode === 'free' ? 'place.pickTitle' : 'place.pickSwapTitle')),
        h('div', { class: 'pick-selects' }, albums.length > 1 && albumSelect, sheetSelect),
        grid,
        codeForm,
        codeError,
        sheetButton(t('common.cancel'), 'cancel', () => close(null)),
      ];
    },
    'pick-sheet',
  );
}

// ── move / swap / remove ──

function failed(): null {
  showToast(t('place.failed'));
  return null;
}

/** After a PUT: remember the album as the default, and say what happened. */
async function done(ctx: AppContext, result: LocationResult): Promise<PlaceOutcome> {
  const loc = result.cap.location;
  if (loc?.kind === 'album') await writeLastAlbum(ctx.platform.store, loc.album);
  showToast(
    result.swapped
      ? t('place.swapped', { brand: result.swapped.brand })
      : t('place.moved', { code: loc ? formatLocationCode(loc) : '' }),
  );
  return { kind: 'placed', result };
}

/** Confirm, then `PUT … { location, swap: true }`. */
async function confirmSwap(
  ctx: AppContext,
  host: HTMLElement,
  subject: PlaceSubject,
  target: AlbumLocation,
  occupant: Pick<SheetPocket, 'brand'> | undefined,
  taken = false,
): Promise<PlaceOutcome | null> {
  const code = formatLocationCode(target);
  const brand = occupant?.brand ?? t('place.anotherCap');
  const ok = await ConfirmSheet(host, {
    message: taken ? t('place.occupiedSwap', { code, brand }) : t('place.swapConfirm', { brand, code }),
    confirm: t('place.swapAction'),
    cancel: t('common.cancel'),
  });
  if (!ok) return null;
  try {
    return await done(ctx, await putLocation(ctx.api, subject.capId, target, true));
  } catch {
    return failed();
  }
}

/**
 * Move (or first placement) to `target`, after an explicit confirmation; a 409 (taken meanwhile, or a typed code of a
 * taken pocket) offers Swap in place.
 */
export async function moveTo(
  ctx: AppContext,
  host: HTMLElement,
  subject: PlaceSubject,
  target: AlbumLocation,
  albums: readonly Album[] = [],
): Promise<PlaceOutcome | null> {
  const to = formatLocationCode(target);
  if (subject.location?.kind === 'album' && samePocket(subject.location, target)) {
    showToast(t('place.alreadyThere', { code: to }));
    return null;
  }
  const ok = await ConfirmSheet(host, {
    message: subject.location
      ? t('place.moveConfirm', { name: subject.name, from: formatLocationCode(subject.location), to })
      : t('place.putConfirm', { name: subject.name, code: to }),
    confirm: t(subject.location ? 'place.moveAction' : 'place.putAction'),
    cancel: t('common.cancel'),
  });
  if (!ok) return null;
  try {
    return await done(ctx, await putLocation(ctx.api, subject.capId, target));
  } catch (error) {
    if (!isOccupied(error)) return failed();
    const list = albums.length > 0 ? albums : await fetchAlbums(ctx.api).catch(() => []);
    const occupant = await occupantAt(ctx.api, list, target);
    return confirmSwap(ctx, host, subject, target, occupant, true);
  }
}

async function remove(ctx: AppContext, host: HTMLElement, subject: PlaceSubject): Promise<PlaceOutcome | null> {
  if (!subject.location) return null;
  const ok = await ConfirmSheet(host, {
    message: t('place.removeConfirm', { name: subject.name, code: formatLocationCode(subject.location) }),
    confirm: t('place.removeAction'),
    cancel: t('common.cancel'),
    danger: true,
  });
  if (!ok) return null;
  try {
    await clearLocation(ctx.api, subject.capId);
  } catch {
    return failed();
  }
  showToast(t('place.removed'));
  return { kind: 'cleared' };
}

type Action = 'move' | 'swap' | 'remove';

/** The "Where is it?" sheet: the current code and Assign / Move, Swap with…, Remove from album. */
export async function placeActions(
  ctx: AppContext,
  host: HTMLElement,
  subject: PlaceSubject,
): Promise<PlaceOutcome | null> {
  const loc = subject.location;
  const action = await bottomSheet<Action>(
    host,
    (close) => [
      h(
        'p',
        { class: 'sheet-message', attrs: { 'data-where': loc ? formatLocationCode(loc) : '' } },
        loc ? t('place.current', { name: subject.name, code: formatLocationCode(loc) }) : t('capDetail.notInAlbum'),
      ),
      sheetButton(t(loc ? 'place.move' : 'place.assign'), 'move', () => close('move'), false),
      sheetButton(t('place.swap'), 'swap', () => close('swap')),
      loc && sheetButton(t('place.remove'), 'remove', () => close('remove')),
      sheetButton(t('common.cancel'), 'cancel', () => close(null)),
    ],
    'place-sheet',
  );
  if (action === null) return null;
  if (action === 'remove') return remove(ctx, host, subject);

  let albums: Album[];
  try {
    albums = await fetchAlbums(ctx.api);
  } catch {
    return failed();
  }
  if (pocketAlbums(albums).length === 0) {
    showToast(t('place.noAlbums'));
    return null;
  }
  const last = await readLastAlbum(ctx.platform.store);
  const start =
    loc?.kind === 'album'
      ? loc
      : (() => {
          const album = defaultAlbum(albums, last);
          return album ? cellLocation(album.letter, 1, 1) : undefined;
        })();
  const picked = await pickLocation(ctx, host, {
    albums,
    mode: action === 'move' ? 'free' : 'occupied',
    capId: subject.capId,
    ...(start ? { start } : {}),
  });
  if (picked === null) return null;
  if (action === 'swap') return confirmSwap(ctx, host, subject, picked.location, picked.occupant);
  return moveTo(ctx, host, subject, picked.location, albums);
}

// ── next-free proposal on save ──

/** `undefined` location = saved without one ("Not now", or nothing to propose); null = the user backed out. */
export type Proposal = { readonly location?: AlbumLocation } | null;

/**
 * Before `POST /caps` of a new cap with no pre-assigned pocket: when the user has an album, propose its next free
 * pocket (the album last used, else the first). Yes → that pocket; Choose… → the picker; Not now → no location.
 * Without albums, or when they cannot be read, the cap saves without a location (as before CAP-53).
 */
export async function proposeLocation(ctx: AppContext, host: HTMLElement): Promise<Proposal> {
  let albums: Album[];
  try {
    albums = pocketAlbums(await fetchAlbums(ctx.api));
  } catch {
    return {};
  }
  const album = defaultAlbum(albums, await readLastAlbum(ctx.platform.store));
  if (!album) return {};
  const free = await nextFree(ctx.api, album.albumId).catch(() => null);
  const proposed = free?.location ?? null;

  for (;;) {
    const answer = await bottomSheet<'yes' | 'choose' | 'notNow'>(
      host,
      (close) => [
        h(
          'p',
          { class: 'sheet-message', attrs: { 'data-proposal': proposed ? formatLocationCode(proposed) : '' } },
          proposed
            ? t('place.propose', { code: formatLocationCode(proposed) })
            : t(free ? 'place.full' : 'place.noProposal', { letter: album.letter }),
        ),
        proposed && sheetButton(t('place.yes'), 'yes', () => close('yes'), false),
        sheetButton(t('place.choose'), 'choose', () => close('choose'), proposed !== null),
        sheetButton(t('place.notNow'), 'not-now', () => close('notNow')),
      ],
      'propose-sheet',
    );
    if (answer === null) return null;
    if (answer === 'notNow') return {};
    if (answer === 'yes' && proposed) {
      await writeLastAlbum(ctx.platform.store, proposed.album);
      return { location: { kind: 'album', album: proposed.album, sheet: proposed.sheet, pocket: proposed.pocket } };
    }
    const picked = await pickLocation(ctx, host, {
      albums,
      mode: 'free',
      start: proposed ?? cellLocation(album.letter, 1, 1),
    });
    if (picked !== null) {
      await writeLastAlbum(ctx.platform.store, picked.location.album);
      return { location: picked.location };
    }
    // Cancel in the picker: back to the proposal.
  }
}
