// Import → "Varias chapas" (CAP-121; SCREENS.md § Multi-import; ADR-012): step 1, ask — the prompt
// (`multiImportInstructions` in the UI language) and the empty template (`MULTI_IMPORT_TEMPLATE`) with copy buttons, the
// photo-format card and one line of how-to; step 2, upload one zip (drop zone on the web, "Elegir zip" everywhere;
// loose images + JSONs too), checked against MULTI_IMPORT_LIMITS before any image is decoded, then "Importando n de N"
// with Cancel; step 3, the summary on the same screen — the five counts, one row per file pair, and "Ver por revisar",
// "Reintentar fallidas", "Importar otro zip". The work itself is exchange/multi-import.ts.
import { MULTI_IMPORT_LIMITS, MULTI_IMPORT_TEMPLATE, multiImportInstructions, type Cap } from '@capcollector/shared';

import { defaultPlace } from '../capture/place.js';
import { newUlid } from '../capture/ulid.js';
import { invalidateCollection } from '../collection/state.js';
import { capTitle } from '../components/cap-tile.js';
import type { AppContext } from '../context.js';
import { readUpload } from '../exchange/answer.js';
import {
  checkPairs,
  checkSize,
  pairUploads,
  resetFailed,
  runImport,
  summarise,
  type FailReason,
  type ImportRow,
  type LimitProblem,
  type RowStatus,
} from '../exchange/multi-import.js';
import { language, t, type MessageKey } from '../i18n/i18n.js';
import { browserCodec, type RasterCodec } from '../images/resize.js';
import { uploadImage, type PutFn } from '../images/upload.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

export interface MultiImportOptions {
  readonly copy: (text: string) => Promise<boolean>;
  readonly put?: PutFn;
  readonly newId?: () => string;
  readonly now?: () => Date;
  /** Decoder / WebP encoder (tests inject one; the app uses the browser's with its wasm fallback). */
  readonly codec?: RasterCodec;
}

type Status = Exclude<RowStatus, 'pending'>;

const COUNT_LABEL: Readonly<Record<Status, MessageKey>> = {
  imported: 'exchange.multi.count.imported',
  inCollection: 'exchange.multi.count.inCollection',
  repeated: 'exchange.multi.count.repeated',
  possibleDuplicate: 'exchange.multi.count.possibleDuplicate',
  failed: 'exchange.multi.count.failed',
};

const STATUS_LABEL: Readonly<Record<Status, MessageKey>> = {
  imported: 'exchange.multi.status.imported',
  inCollection: 'exchange.multi.status.inCollection',
  repeated: 'exchange.multi.status.repeated',
  possibleDuplicate: 'exchange.multi.status.possibleDuplicate',
  failed: 'exchange.multi.status.failed',
};

const REASON_LABEL: Readonly<Record<FailReason, MessageKey>> = {
  noJson: 'exchange.multi.reason.noJson',
  noImage: 'exchange.multi.reason.noImage',
  duplicateName: 'exchange.multi.reason.duplicateName',
  invalidJson: 'exchange.multi.reason.invalidJson',
  badImage: 'exchange.multi.reason.badImage',
  uploadFailed: 'exchange.multi.reason.uploadFailed',
  checkFailed: 'exchange.multi.reason.checkFailed',
  saveFailed: 'exchange.multi.reason.saveFailed',
  cancelled: 'exchange.multi.reason.cancelled',
};

const PHOTO_TIPS: readonly MessageKey[] = [
  'exchange.multi.photo.faceUp',
  'exchange.multi.photo.background',
  'exchange.multi.photo.apart',
  'exchange.multi.photo.above',
  'exchange.multi.photo.light',
];

const STATUS_ORDER: readonly Status[] = ['imported', 'inCollection', 'repeated', 'possibleDuplicate', 'failed'];

function limitMessage(problem: LimitProblem): string {
  if (problem.kind === 'tooBig') {
    return t('exchange.multi.tooBig', { max: String(MULTI_IMPORT_LIMITS.maxZipBytes / (1024 * 1024)) });
  }
  if (problem.kind === 'tooManyPairs') {
    return t('exchange.multi.tooMany', { count: String(problem.pairs), max: String(MULTI_IMPORT_LIMITS.maxCaps) });
  }
  return t('exchange.multi.empty');
}

export function MultiImportSection(ctx: AppContext, options: MultiImportOptions): HTMLElement {
  const newId = options.newId ?? (() => newUlid());
  const now = options.now ?? (() => new Date());
  let rows: ImportRow[] = [];
  let running = false;
  let cancel = false;
  const thumbs: string[] = [];

  // ── 1. Ask ──
  const prompt = multiImportInstructions(language());
  const template = JSON.stringify(MULTI_IMPORT_TEMPLATE, null, 2);
  const copied = h('p', { class: 'muted', attrs: { role: 'status', 'data-status': 'multi-copy' } });
  copied.hidden = true;
  const copyButton = (key: MessageKey, action: string, text: string) =>
    h(
      'button',
      {
        class: 'button button--secondary button--small',
        attrs: { type: 'button', 'data-action': action },
        on: {
          click: () =>
            void options.copy(text).then((ok) => {
              copied.textContent = t(ok ? 'exchange.copied' : 'exchange.copyFailed');
              copied.hidden = false;
            }),
        },
      },
      t(key),
    );
  const promptBox = h('textarea', {
    class: 'input multi-import-text',
    attrs: { readonly: true, rows: '6', 'data-multi': 'prompt', 'aria-label': t('exchange.multi.prompt') },
  });
  promptBox.value = prompt;
  const templateBox = h('pre', { class: 'multi-import-text', attrs: { 'data-multi': 'template' } }, template);

  const ask = h(
    'div',
    { class: 'exchange-section', attrs: { 'data-section': 'multi-ask' } },
    h('h3', { class: 'section-title' }, t('exchange.multi.askTitle')),
    h('p', { class: 'section-subtitle' }, t('exchange.multi.prompt')),
    promptBox,
    copyButton('exchange.multi.copyPrompt', 'copy-multi-prompt', prompt),
    h('p', { class: 'section-subtitle' }, t('exchange.multi.template')),
    templateBox,
    copyButton('exchange.multi.copyTemplate', 'copy-multi-template', template),
    copied,
    h(
      'div',
      { class: 'multi-import-photo', attrs: { 'data-multi': 'photo' } },
      h('p', { class: 'section-subtitle' }, t('exchange.multi.photoTitle')),
      h(
        'ul',
        {},
        ...PHOTO_TIPS.map((key) => h('li', {}, t(key))),
        h('li', {}, t('exchange.multi.photo.max', { max: String(MULTI_IMPORT_LIMITS.maxCaps) })),
      ),
    ),
    h('p', { class: 'muted' }, t('exchange.multi.how')),
  );

  // ── 2. Upload, progress ──
  const status = h('p', { class: 'muted exchange-status', attrs: { 'data-status': 'multi' } });
  status.hidden = true;
  const say = (text: string | null, role = 'status') => {
    status.textContent = text ?? '';
    status.hidden = text === null;
    status.setAttribute('role', role);
  };
  const cancelButton = h(
    'button',
    {
      class: 'button button--secondary button--small',
      attrs: { type: 'button', 'data-action': 'multi-cancel' },
      on: {
        click: () => {
          cancel = true;
          cancelButton.disabled = true;
        },
      },
    },
    t('common.cancel'),
  );
  const progress = h('div', { class: 'multi-import-progress', attrs: { 'data-multi': 'progress' } });
  progress.hidden = true;
  const summary = h('div', { class: 'multi-import-summary', attrs: { 'data-multi': 'summary' } });
  summary.hidden = true;

  async function pick(): Promise<void> {
    const files = await ctx.platform
      .pickFiles({ accept: '.zip,application/zip,.json,application/json,image/*', multiple: true })
      .catch(() => []);
    await handle(files);
  }

  async function handle(files: readonly File[]): Promise<void> {
    if (running || files.length === 0) return;
    const tooBig = checkSize(files);
    if (tooBig) return say(limitMessage(tooBig), 'alert');
    const contents = await readUpload(files);
    const zipFailed = contents.unreadable.some((name) => /\.zip$/i.test(name));
    if (zipFailed && contents.images.length === 0 && contents.json.length === 0) {
      return say(t('exchange.multi.unreadable'), 'alert');
    }
    const paired = pairUploads(contents);
    const limit = checkPairs(paired);
    if (limit) return say(limitMessage(limit), 'alert');
    clearThumbs();
    rows = paired;
    await run();
  }

  async function run(): Promise<void> {
    running = true;
    cancel = false;
    cancelButton.disabled = false;
    say(null);
    summary.hidden = true;
    upload.hidden = true;
    const todo = rows.filter((r) => r.status === 'pending').length;
    const line = h('span', {}, t('exchange.multi.progress', { done: '0', total: String(todo) }));
    progress.replaceChildren(line, cancelButton);
    progress.hidden = false;
    try {
      await runImport(
        rows,
        {
          api: ctx.api,
          upload: (photo) => uploadImage(ctx.api, 'top', photo, options.put),
          codec: options.codec ?? browserCodec(),
          newId,
          now,
          place: defaultPlace(ctx),
          possibleDuplicateNote: (cap: Cap) =>
            t('exchange.multi.possibleNote', { title: capTitle(cap), id: cap.capId.slice(-6) }),
        },
        {
          cancelled: () => cancel,
          onProgress: (done, total) => {
            line.textContent = t('exchange.multi.progress', { done: String(done), total: String(total) });
          },
        },
      );
    } finally {
      running = false;
      progress.hidden = true;
      if (rows.some((r) => r.capId !== undefined)) invalidateCollection(ctx);
      renderSummary();
    }
  }

  // ── 3. Summary ──
  function clearThumbs(): void {
    for (const url of thumbs.splice(0)) URL.revokeObjectURL?.(url);
  }

  function thumb(row: ImportRow): HTMLElement {
    if (row.photo && typeof URL.createObjectURL === 'function') {
      const url = URL.createObjectURL(row.photo.blob);
      thumbs.push(url);
      return h('img', { class: 'cap-thumb multi-import-thumb', attrs: { src: url, alt: '' } });
    }
    return h('span', {
      class: 'cap-thumb cap-thumb--placeholder multi-import-thumb',
      attrs: { 'aria-hidden': 'true' },
    });
  }

  function rowView(row: ImportRow): HTMLElement {
    const state = row.status === 'pending' ? 'failed' : row.status;
    return h(
      'li',
      { class: 'multi-import-row', attrs: { 'data-row': row.name, 'data-row-status': state } },
      thumb(row),
      h('span', { class: 'multi-import-name' }, row.title ?? row.name),
      h('span', { class: `chip chip--${state}`, attrs: { 'data-status-chip': state } }, t(STATUS_LABEL[state])),
      row.capId &&
        h(
          'a',
          { attrs: { href: pathFor('capDetail', { id: row.capId }), 'data-link': true, 'data-open': 'cap' } },
          t('exchange.multi.openCap'),
        ),
      row.matchCapId &&
        h(
          'a',
          { attrs: { href: pathFor('capDetail', { id: row.matchCapId }), 'data-link': true, 'data-open': 'existing' } },
          t('exchange.multi.openExisting'),
        ),
      row.reason &&
        h(
          'span',
          { class: 'muted multi-import-reason', attrs: { 'data-reason': row.reason } },
          t(REASON_LABEL[row.reason]),
        ),
    );
  }

  function renderSummary(): void {
    clearThumbs();
    const counts = summarise(rows);
    const retryable = rows.filter(
      (r) => r.status === 'failed' && r.reason !== 'noJson' && r.reason !== 'noImage' && r.reason !== 'invalidJson',
    ).length;
    summary.replaceChildren(
      h('h3', { class: 'section-title' }, t('exchange.multi.summaryTitle')),
      h(
        'dl',
        { class: 'multi-import-counts' },
        ...STATUS_ORDER.flatMap((s) => [
          h('dt', {}, t(COUNT_LABEL[s])),
          h('dd', { attrs: { 'data-count': s } }, String(counts[s])),
        ]),
      ),
      h('ul', { class: 'multi-import-rows' }, ...rows.map(rowView)),
      h(
        'div',
        { class: 'multi-import-actions' },
        h(
          'a',
          {
            class: 'button',
            attrs: {
              href: `${pathFor('collection')}?status=needsReview`,
              'data-link': true,
              'data-action': 'view-review',
            },
          },
          t('exchange.multi.viewReview'),
        ),
        retryable > 0 &&
          h(
            'button',
            {
              class: 'button button--secondary',
              attrs: { type: 'button', 'data-action': 'multi-retry' },
              on: {
                click: () => {
                  if (resetFailed(rows) > 0) void run();
                },
              },
            },
            t('exchange.multi.retry'),
          ),
        h(
          'button',
          {
            class: 'button button--secondary',
            attrs: { type: 'button', 'data-action': 'multi-another' },
            on: {
              click: () => {
                clearThumbs();
                rows = [];
                summary.hidden = true;
                upload.hidden = false;
                say(null);
              },
            },
          },
          t('exchange.multi.another'),
        ),
      ),
    );
    summary.hidden = false;
  }

  const dropZone =
    ctx.platform.kind === 'web'
      ? h(
          'div',
          {
            class: 'drop-zone',
            attrs: { 'data-drop': 'multi', tabindex: '0' },
            on: {
              dragover: (e) => {
                e.preventDefault();
                dropZone?.classList.add('drop-zone--over');
              },
              dragleave: () => dropZone?.classList.remove('drop-zone--over'),
              drop: (e) => {
                e.preventDefault();
                dropZone?.classList.remove('drop-zone--over');
                void handle([...(e.dataTransfer?.files ?? [])]);
              },
            },
          },
          t('exchange.multi.dropHere'),
        )
      : null;

  const upload = h(
    'div',
    { attrs: { 'data-multi': 'upload' } },
    dropZone,
    h(
      'button',
      {
        class: 'button button--secondary',
        attrs: { type: 'button', 'data-action': 'pick-zip' },
        on: { click: () => void pick() },
      },
      t('exchange.multi.chooseZip'),
    ),
  );

  return h(
    'div',
    { class: 'multi-import', attrs: { 'data-part': 'many' } },
    ask,
    h(
      'div',
      { class: 'exchange-section', attrs: { 'data-section': 'multi-upload' } },
      h('h3', { class: 'section-title' }, t('exchange.multi.uploadTitle')),
      upload,
      status,
      progress,
      summary,
    ),
  );
}
