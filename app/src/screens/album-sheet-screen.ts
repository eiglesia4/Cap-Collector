// Album sheet (CAP-52; SCREENS.md #7 and § Navigation: "tap pocket → Detail; tap empty pocket → Scan pre-assigned to
// that pocket"; ADR-005 Sheet view; physical-link.md § Location code). Header `A · sheet 3 of 10` with ‹ › and a
// sheet picker on tap; the grid mirrors the physical sheet — `cols × rows` round cells, row-major numbering
// (`pocketToCell`). An occupied pocket shows the cap's thumbnail when the app already holds its presigned image
// (Collection / Detail), else a brand-hued placeholder with the pocket number, and the brand under it; an empty
// pocket shows its number faintly and starts a scan pre-assigned to it (`targetLocationCode`, CAP-41/CAP-50).
// Long-press (or right-click on the Mac) on an occupied pocket opens the "Where is it?" actions for that cap — Move,
// Swap with…, Remove (CAP-53, components/place-sheet.ts) — and the sheet reloads after a change. Not here yet:
// "Print inserts" (CAP-54).
// Styles: styles/albums.css.
import { SheetView, type Album } from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import { knownThumb, recordSheetUsage } from '../albums/known.js';
import {
  albumSheetPath,
  AlbumListSchema,
  pocketLocation,
  scanIntoPath,
  sheetCells,
  sheetCount,
  type SheetCell,
} from '../albums/model.js';
import { brandHue } from '../components/cap-tile.js';
import { placeActions, type PlaceSubject } from '../components/place-sheet.js';
import type { AppContext, Screen } from '../context.js';
import { t } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

/** How long a press on an occupied pocket lasts before it opens Move / Swap (CAP-53). */
export const LONG_PRESS_MS = 500;

/**
 * Long-press on `el` (pointer held for LONG_PRESS_MS without moving away) or a context-menu request → `onHold`. The
 * click that ends a long-press does not follow the link.
 */
function onLongPress(el: HTMLElement, onHold: () => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let held = false;
  const cancel = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  el.addEventListener('pointerdown', () => {
    held = false;
    cancel();
    timer = setTimeout(() => {
      timer = undefined;
      held = true;
      onHold();
    }, LONG_PRESS_MS);
  });
  for (const type of ['pointerup', 'pointerleave', 'pointercancel'] as const) el.addEventListener(type, cancel);
  el.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    cancel();
    onHold();
  });
  el.addEventListener(
    'click',
    (e) => {
      if (!held) return;
      held = false;
      e.preventDefault();
      e.stopPropagation();
    },
    { capture: true },
  );
}

function placeholder(cell: SheetCell & { cap: NonNullable<SheetCell['cap']> }): HTMLElement {
  return h(
    'span',
    {
      class: 'pocket-thumb cap-thumb--placeholder',
      attrs: { style: `--cap-hue: ${String(brandHue(cell.cap.brand))}`, 'aria-hidden': 'true' },
    },
    String(cell.pocket),
  );
}

function thumb(ctx: AppContext, cell: SheetCell & { cap: NonNullable<SheetCell['cap']> }): HTMLElement {
  const url = knownThumb(ctx, cell.cap.capId);
  if (url === undefined) return placeholder(cell);
  const img = h('img', { class: 'pocket-thumb', attrs: { src: url, alt: '', loading: 'lazy', decoding: 'async' } });
  // The presigned URL lasts ≈5 min: once expired, the placeholder.
  img.addEventListener('error', () => img.replaceWith(placeholder(cell)), { once: true });
  return img;
}

/** One pocket of the grid. */
export function PocketCell(ctx: AppContext, cell: SheetCell, onHold?: (subject: PlaceSubject) => void): HTMLElement {
  const li = h('li', { class: cell.cap ? 'pocket pocket--occupied' : 'pocket pocket--empty' });
  li.dataset.pocket = String(cell.pocket);
  li.dataset.row = String(cell.row);
  li.dataset.col = String(cell.col);
  li.dataset.code = cell.code;
  const occupied = cell.cap;
  if (occupied) {
    const brand = [occupied.brand, occupied.variant].filter(Boolean).join(t('collection.separator'));
    li.append(
      h(
        'a',
        {
          class: 'pocket-link',
          attrs: {
            href: pathFor('capDetail', { id: occupied.capId }),
            'data-link': true,
            'aria-label': t('sheet.pocketCap', { brand, code: cell.code }),
          },
        },
        thumb(ctx, { ...cell, cap: occupied }),
        h('span', { class: 'pocket-brand' }, occupied.brand),
      ),
    );
    if (onHold) {
      const subject: PlaceSubject = {
        capId: occupied.capId,
        name: brand,
        location: pocketLocation(cell.code) ?? undefined,
      };
      onLongPress(li, () => onHold(subject));
    }
  } else {
    li.append(
      h(
        'button',
        {
          class: 'pocket-link',
          attrs: {
            type: 'button',
            'data-action': 'scan-pocket',
            'aria-label': t('sheet.pocketEmpty', { code: cell.code }),
          },
          on: { click: () => ctx.navigate(scanIntoPath(cell.code)) },
        },
        h('span', { class: 'pocket-thumb pocket-number' }, String(cell.pocket)),
      ),
    );
  }
  return li;
}

export const AlbumSheetScreen: Screen = (ctx, route) => {
  const albumId = route.params.albumId ?? '';
  const sheet = Number(route.params.sheet);

  const back = h(
    'a',
    { class: 'header-action', attrs: { href: pathFor('albums'), 'data-link': true } },
    t('sheet.back'),
  );
  const header = h('header', { class: 'screen-header sheet-header' }, back);
  const body = h('div', { class: 'sheet-body' });
  const el = h('section', { class: 'screen album-sheet' }, header, body);

  const go = (n: number) => ctx.navigate(albumSheetPath(albumId, n));

  function renderHeader(album: Album, sheets: number): void {
    const title = t('sheet.title', { letter: album.letter, sheet: String(sheet), sheets: String(sheets) });
    const arrow = (label: string, symbol: string, n: number, action: string) =>
      h(
        'button',
        {
          class: 'header-action sheet-arrow',
          attrs: { type: 'button', 'aria-label': label, 'data-action': action, disabled: n < 1 || n > sheets },
          on: { click: () => go(n) },
        },
        symbol,
      );
    const picker = h(
      'details',
      { class: 'more-menu sheet-picker' },
      h('summary', { class: 'screen-title', attrs: { 'aria-label': t('sheet.pick') } }, title),
      h(
        'div',
        { class: 'menu sheet-picker-menu' },
        ...Array.from({ length: sheets }, (_, i) => {
          const n = i + 1;
          const item = h(
            'button',
            {
              class: 'menu-item',
              attrs: { type: 'button', 'aria-current': n === sheet ? 'page' : undefined },
              on: { click: () => go(n) },
            },
            String(n),
          );
          item.dataset.sheet = String(n);
          return item;
        }),
      ),
    );
    header.replaceChildren(
      back,
      h(
        'div',
        { class: 'sheet-nav' },
        arrow(t('sheet.prev'), t('sheet.prevSymbol'), sheet - 1, 'prev-sheet'),
        picker,
        arrow(t('sheet.next'), t('sheet.nextSymbol'), sheet + 1, 'next-sheet'),
      ),
    );
  }

  function renderGrid(album: Album, view: SheetView): void {
    const grid = h('ol', {
      class: 'sheet-grid',
      attrs: { style: `--cols: ${String(view.cols)}`, 'aria-label': t('sheet.grid') },
    });
    const hold = (subject: PlaceSubject) =>
      void placeActions(ctx, el, subject).then((outcome) => {
        if (outcome) void load();
      });
    grid.append(...sheetCells(view).map((cell) => PocketCell(ctx, cell, hold)));
    body.replaceChildren(h('p', { class: 'muted sheet-album-name' }, album.name), grid);
    if (view.pockets.length > 0) body.append(h('p', { class: 'muted sheet-hint' }, t('sheet.moveHint')));
  }

  function failed(notFound: boolean): void {
    body.replaceChildren(
      h('p', { attrs: { role: 'alert' } }, t(notFound ? 'sheet.notFound' : 'sheet.loadFailed')),
      notFound
        ? h(
            'a',
            { class: 'button button--secondary', attrs: { href: pathFor('albums'), 'data-link': true } },
            t('sheet.back'),
          )
        : h(
            'button',
            { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => void load() } },
            t('common.retry'),
          ),
    );
  }

  async function load(): Promise<void> {
    body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('sheet.loading')));
    if (!Number.isInteger(sheet) || sheet < 1) return failed(true);
    try {
      const path = `/albums/${encodeURIComponent(albumId)}/sheets/${String(sheet)}`;
      const [albums, view] = await Promise.all([
        ctx.api.request('/albums', { schema: AlbumListSchema }),
        ctx.api.request(path, { schema: SheetView }),
      ]);
      const album = albums.find((a) => a.albumId === albumId);
      if (!album) return failed(true);
      recordSheetUsage(ctx, albumId, sheet, view.pockets.length);
      renderHeader(album, sheetCount(album));
      renderGrid(album, view);
    } catch (error) {
      const status = error instanceof ProblemError || error instanceof HttpError ? error.status : 0;
      failed(status === 404);
    }
  }

  void load();
  return el;
};
