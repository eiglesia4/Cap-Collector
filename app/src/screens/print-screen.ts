// Print inserts (CAP-54; SCREENS.md #8 "A4 pocket inserts"; physical-link.md § Insert discs and § Sheet index,
// amended 2026-11-09): `/albums/:albumId/print?sheet=<n>`, reached from the album sheet. Without the album's pocket and
// pitch it asks for them first (suggested 33 / 36 mm, saved with `PATCH /albums/{id}`). Then: scope (this sheet ·
// since last print · whole album), what to print (discs · sheet index · both), the count preview, **Generate** — the
// PDF built on the client (print/inserts.ts) goes to the share sheet on the iPhone, a download on the Mac — and
// "Mark as printed" (the per-album timestamp of "since last print").
import { Album, type Cap } from '@capcollector/shared';

import { AlbumListSchema, albumSheetPath, sheetCount } from '../albums/model.js';
import type { AppContext, Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { buildInsertsPdf, planInserts, type PrintWhat } from '../print/inserts.js';
import { discDiameter, SUGGESTED_PITCH_MM, SUGGESTED_POCKET_MM } from '../print/layout.js';
import {
  albumCaps,
  fetchAllCaps,
  indexSheets,
  markPrinted,
  readLastPrint,
  scopeCaps,
  type PrintScope,
} from '../print/scope.js';
import { h } from '../ui/dom.js';

export interface PrintOptions {
  /** Mac/web download of the PDF; tests inject a fake. */
  readonly download?: (file: File) => void;
  readonly now?: () => Date;
}

function browserDownload(file: File): void {
  if (typeof URL.createObjectURL !== 'function') return;
  const url = URL.createObjectURL(file);
  const a = h('a', { attrs: { href: url, download: file.name } });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const dateFormat = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

/** The ask-first form: pocket and pitch in mm, suggested from Edu's COMPART measurement. */
function MeasureForm(ctx: AppContext, album: Album, saved: (album: Album) => void): HTMLElement {
  const input = (value: number | undefined, suggested: number, field: string) =>
    h('input', {
      class: 'input',
      attrs: {
        type: 'number',
        inputmode: 'decimal',
        step: '0.5',
        min: '10',
        max: '120',
        name: field,
        value: String(value ?? suggested),
      },
    });
  const pocket = input(album.pocketMm, SUGGESTED_POCKET_MM, 'pocketMm');
  const pitch = input(album.pitchMm, SUGGESTED_PITCH_MM, 'pitchMm');
  const error = h('p', { class: 'status status--error', attrs: { role: 'alert' } });
  error.hidden = true;
  const fail = (key: MessageKey) => {
    error.textContent = t(key);
    error.hidden = false;
  };
  const form = h(
    'form',
    {
      class: 'print-measure',
      on: {
        submit: (e) => {
          e.preventDefault();
          const pocketMm = Number(pocket.value.replace(',', '.'));
          const pitchMm = Number(pitch.value.replace(',', '.'));
          if (!(pocketMm >= 10 && pocketMm <= 100 && pitchMm >= 10 && pitchMm <= 120))
            return fail('print.measureInvalid');
          if (pitchMm < pocketMm) return fail('albums.errorPitch');
          void ctx.api
            .request(`/albums/${encodeURIComponent(album.albumId)}`, {
              method: 'PATCH',
              body: { pocketMm, pitchMm },
              schema: Album,
            })
            .then(saved, () => fail('print.measureFailed'));
        },
      },
    },
    h('p', {}, t('print.measureAsk')),
    h(
      'div',
      { class: 'field-row' },
      h('label', { class: 'field' }, t('albums.pocketMm'), pocket),
      h('label', { class: 'field' }, t('albums.pitchMm'), pitch),
    ),
    h('p', { class: 'muted field-hint' }, t('print.measureHint')),
    error,
    h('button', { class: 'button', attrs: { type: 'submit', 'data-action': 'save-measures' } }, t('print.measureSave')),
  );
  return form;
}

export function PrintView(
  ctx: AppContext,
  albumId: string,
  startSheet: number,
  options: PrintOptions = {},
): HTMLElement {
  const download = options.download ?? browserDownload;
  const now = options.now ?? (() => new Date());
  const back = h(
    'a',
    { class: 'header-action', attrs: { href: albumSheetPath(albumId, startSheet), 'data-link': true } },
    t('print.back'),
  );
  const body = h('div', { class: 'print-body' });
  const el = h(
    'section',
    { class: 'screen print-inserts' },
    h('header', { class: 'screen-header' }, back, h('h1', { class: 'screen-title' }, t('print.title'))),
    body,
  );

  function failed(key: MessageKey): void {
    body.replaceChildren(
      h('p', { attrs: { role: 'alert' } }, t(key)),
      h(
        'button',
        { class: 'button button--secondary', attrs: { type: 'button' }, on: { click: () => void load() } },
        t('common.retry'),
      ),
    );
  }

  function render(album: Album, caps: readonly Cap[], lastPrint: Date | null): void {
    if (album.kind !== 'album') return failed('print.notAlbum');
    if (album.pocketMm === undefined || album.pitchMm === undefined) {
      body.replaceChildren(MeasureForm(ctx, album, (next) => render(next, caps, lastPrint)));
      return;
    }
    const sheets = sheetCount(album);
    let scope: PrintScope = 'sheet';
    let what: PrintWhat = 'both';
    let sheet = Math.min(Math.max(1, startSheet), sheets);
    let since = lastPrint;
    const inAlbum = albumCaps(caps, album);

    const selection = () => {
      const discs = scopeCaps(inAlbum, scope, { sheet, since });
      const index = indexSheets(inAlbum, discs, scope, sheet);
      return { discs, index };
    };

    const preview = h('p', { class: 'print-preview', attrs: { role: 'status', 'data-preview': '' } });
    const status = h('p', { class: 'muted', attrs: { role: 'status', 'data-status': '' } });
    status.hidden = true;
    const generate = h(
      'button',
      { class: 'button', attrs: { type: 'button', 'data-action': 'generate' }, on: { click: () => void run() } },
      t(ctx.platform.kind === 'native' ? 'print.generateShare' : 'print.generateDownload'),
    );
    const mark = h(
      'button',
      {
        class: 'button button--secondary',
        attrs: { type: 'button', 'data-action': 'mark-printed' },
        on: {
          click: () => {
            const when = now();
            void markPrinted(ctx.platform.store, album.albumId, when).then(() => {
              since = when;
              sinceLabel.textContent = t('print.scope.since', { date: dateFormat.format(when) });
              mark.hidden = true;
              say('print.marked');
              update();
            });
          },
        },
      },
      t('print.markPrinted'),
    );
    mark.hidden = true;

    const say = (key: MessageKey | null) => {
      status.textContent = key === null ? '' : t(key);
      status.hidden = key === null;
    };

    function update(): void {
      const { discs, index } = selection();
      const plan = planInserts({ album, discs, sheets: index, what, printedOn: now() });
      const discPages = plan.pages.filter((p) => p.kind === 'front').length;
      const indexPages = plan.pages.filter((p) => p.kind === 'index').length;
      const parts: string[] = [];
      if (what !== 'index') parts.push(t('print.previewDiscs', { count: discs.length, pages: discPages * 2 }));
      if (what !== 'discs') parts.push(t('print.previewIndex', { count: indexPages }));
      preview.textContent = parts.join(t('collection.separator'));
      generate.disabled = plan.pages.length === 0;
    }

    async function run(): Promise<void> {
      const { discs, index } = selection();
      generate.disabled = true;
      say('print.building');
      try {
        const printedOn = now();
        const bytes = await buildInsertsPdf({ album, discs, sheets: index, what, printedOn });
        const name = t('print.fileName', {
          letter: album.letter,
          scope: scope === 'sheet' ? String(sheet) : scope,
        });
        const file = new File([bytes as BlobPart], name, { type: 'application/pdf' });
        if (ctx.platform.kind === 'native') await ctx.platform.share({ title: name, files: [file] }).catch(() => false);
        else download(file);
        say('print.ready');
        mark.hidden = false;
      } catch {
        say('print.failed');
      } finally {
        update();
      }
    }

    const radio = <T extends string>(
      name: string,
      value: T,
      current: T,
      label: HTMLElement | string,
      set: (v: T) => void,
    ) => {
      const input = h('input', { attrs: { type: 'radio', name, value, [`data-${name}`]: value } });
      input.checked = current === value;
      input.addEventListener('change', () => {
        set(value);
        update();
      });
      return h('label', { class: 'check' }, input, label);
    };

    const sheetSelect = h(
      'select',
      {
        class: 'input print-sheet',
        attrs: { name: 'sheet', 'aria-label': t('place.sheet') },
        on: {
          change: () => {
            sheet = Number(sheetSelect.value);
            update();
          },
        },
      },
      ...Array.from({ length: sheets }, (_, i) =>
        h(
          'option',
          { attrs: { value: String(i + 1), selected: i + 1 === sheet } },
          t('place.sheetOption', { sheet: String(i + 1) }),
        ),
      ),
    );
    const sinceLabel = h(
      'span',
      {},
      since === null ? t('print.scope.sinceNever') : t('print.scope.since', { date: dateFormat.format(since) }),
    );

    body.replaceChildren(
      h(
        'p',
        { class: 'muted' },
        t('print.intro', { diameter: String(discDiameter(album.pocketMm)), letter: album.letter }),
      ),
      h(
        'fieldset',
        { class: 'print-options' },
        h('legend', {}, t('print.scope')),
        h(
          'div',
          { class: 'print-scope-sheet' },
          radio('scope', 'sheet', scope, t('print.scope.sheet'), (v) => (scope = v)),
          sheetSelect,
        ),
        radio('scope', 'since', scope, sinceLabel, (v) => (scope = v)),
        radio('scope', 'album', scope, t('print.scope.album'), (v) => (scope = v)),
      ),
      h(
        'fieldset',
        { class: 'print-options' },
        h('legend', {}, t('print.what')),
        radio('what', 'discs', what, t('print.what.discs'), (v) => (what = v)),
        radio('what', 'index', what, t('print.what.index'), (v) => (what = v)),
        radio('what', 'both', what, t('print.what.both'), (v) => (what = v)),
      ),
      preview,
      h('p', { class: 'muted field-hint' }, t('print.paperHint')),
      generate,
      status,
      mark,
    );
    update();
  }

  async function load(): Promise<void> {
    body.replaceChildren(h('p', { class: 'muted', attrs: { role: 'status' } }, t('print.loading')));
    try {
      const [albums, caps] = await Promise.all([
        ctx.api.request('/albums', { schema: AlbumListSchema }),
        fetchAllCaps(ctx.api),
      ]);
      const album = albums.find((a) => a.albumId === albumId);
      if (!album) return failed('sheet.notFound');
      render(album, caps, await readLastPrint(ctx.platform.store, album.albumId));
    } catch {
      failed('print.loadFailed');
    }
  }

  void load();
  return el;
}

export const PrintScreen: Screen = (ctx, route) => {
  const sheet = Number(route.query.sheet ?? 1);
  return PrintView(ctx, route.params.albumId ?? '', Number.isInteger(sheet) && sheet >= 1 ? sheet : 1);
};
