// Exchange (SCREENS.md #9, CAP-45; ADR-007; exchange.md § Flow, § Pending requests, § Batch): download a request
// bundle (photo + JSON) for any external AI — scope this scan/cap · all `needsReview` · pick caps — with Share
// (iPhone) / Download (Mac), "Copy prompt" and "Copy JSON"; the pending list (`GET /exchange/requests`); and the
// upload of the answer (drop zone on the Mac, file picker everywhere), validated, tagged with its provider
// (`PATCH {status: answered, provider}`) and continued into the normal review (exchange/continue.ts) or, for a stored
// cap, into the form in `edit` mode with "AI suggests: X" (CAP-43). Reached from Collection ⋯, Review / Manual
// ("Export for external AI", `?scanId=`), Detail ⋯ ("Ask external AI", `?capId=`). Styles: styles/exchange.css.
import { Cap, ExchangeRequestItem, type CapFields } from '@capcollector/shared';

import type { Schema } from '../api/schema.js';
import { suggestionsFor } from '../capture/review.js';
import { newUlid } from '../capture/ulid.js';
import { CapPageSchema } from '../collection/cap-page.js';
import { capTitle } from '../components/cap-tile.js';
import { ScreenHeader } from '../components/screen-header.js';
import type { AppContext, Screen } from '../context.js';
import {
  externalSource,
  photoMismatch,
  photoOf,
  providerChip,
  providerId,
  PROVIDERS,
  readAnswer,
  readUpload,
  type Answer,
  type AnswerProblem,
  type ProviderChip,
} from '../exchange/answer.js';
import { batchZip, bundleItems, jsonText, promptText, singleZip, type BundleItem } from '../exchange/bundle.js';
import { continueToReview, markRequest, type ReviewPhotos } from '../exchange/continue.js';
import { capSubject, scanSubject } from '../exchange/subjects.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { resizeToWebp, type CapPhoto } from '../images/resize.js';
import type { StoredPhotoOptions } from '../images/stored.js';
import { uploadImage, type PutFn } from '../images/upload.js';
import { pathFor } from '../router/routes.js';
import { h, type Child } from '../ui/dom.js';
import { CapForm } from './cap-form-screen.js';

export interface ExchangeOptions extends StoredPhotoOptions {
  readonly newId?: () => string;
  readonly now?: () => Date;
  readonly put?: PutFn;
  /** Clipboard write; false when the copy failed. */
  readonly copy?: (text: string) => Promise<boolean>;
  /** Mac/web download of a built bundle. */
  readonly download?: (file: File) => void;
}

/** Caps per `needsReview` batch / pick list (openapi.yaml `GET /caps` max limit). */
export const EXCHANGE_PAGE = 200;
/** Results of a cap search (pick caps, attach to a cap). */
export const SEARCH_LIMIT = 30;

/** `GET /exchange/requests`: an array of `ExchangeRequestItem` (openapi.yaml). */
export const ExchangeRequestListSchema: Schema<ExchangeRequestItem[]> = {
  safeParse(data) {
    if (!Array.isArray(data)) return { success: false, error: new Error('exchange requests: not an array') };
    const items: ExchangeRequestItem[] = [];
    for (const [i, item] of data.entries()) {
      const parsed = ExchangeRequestItem.safeParse(item);
      if (!parsed.success)
        return { success: false, error: new Error(`exchange requests[${i}]: ${parsed.error.message}`) };
      items.push(parsed.data);
    }
    return { success: true, data: items };
  },
};

async function clipboardCopy(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
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

const PROBLEM: Record<AnswerProblem['kind'], MessageKey> = {
  noJson: 'exchange.noJson',
  format: 'exchange.badFormat',
  invalid: 'exchange.invalidAnswer',
  batch: 'exchange.batchAnswer',
};

const PROVIDER_LABEL: Record<ProviderChip, MessageKey> = {
  chatgpt: 'exchange.provider.chatgpt',
  gemini: 'exchange.provider.gemini',
  claude: 'exchange.provider.claude',
  other: 'exchange.provider.other',
};

const STATUS_LABEL: Record<ExchangeRequestItem['status'], MessageKey> = {
  waiting: 'exchange.status.waiting',
  answered: 'exchange.status.answered',
  reviewed: 'exchange.status.reviewed',
  expired: 'exchange.status.expired',
};

type Scope = 'this' | 'needsReview' | 'pick';

/** The uploaded answer while the user tags its provider (and, unmatched, picks the cap it belongs to). */
interface AnswerState {
  readonly answer: Answer;
  readonly photos?: ReviewPhotos;
  readonly mismatch: boolean;
  chip?: ProviderChip;
  other: string;
  attached?: Cap;
}

export function ExchangeView(
  ctx: AppContext,
  query: Readonly<Record<string, string>>,
  options: ExchangeOptions = {},
): HTMLElement {
  const newId = options.newId ?? (() => newUlid());
  const now = options.now ?? (() => new Date());
  const prepare = options.prepare ?? ((file: Blob) => resizeToWebp(file, { crop: 'circle' }));
  const copy = options.copy ?? clipboardCopy;
  const download = options.download ?? browserDownload;
  const { scanId, capId } = query;
  const thisKey: MessageKey | null = capId ? 'exchange.scope.thisCap' : scanId ? 'exchange.scope.thisScan' : null;

  let pending: ExchangeRequestItem[] = [];
  let scope: Scope = thisKey ? 'this' : 'needsReview';
  const picked = new Map<string, Cap>();
  let bundle: { items: BundleItem[]; file: File } | null = null;
  let uploadedFor: string | undefined = query.requestId;
  let current: AnswerState | null = null;
  let busy = false;

  const say = (target: HTMLElement, key: MessageKey | null, role = 'status', params?: Record<string, string>) => {
    target.textContent = key === null ? '' : t(key, params);
    target.hidden = key === null;
    target.setAttribute('role', role);
  };

  // ── Request ──
  const requestStatus = h('p', { class: 'muted exchange-status', attrs: { 'data-status': 'request' } });
  requestStatus.hidden = true;
  const result = h('div', { class: 'exchange-result', attrs: { 'data-result': '' } });
  result.hidden = true;
  const pickBox = h('div', { class: 'exchange-pick', attrs: { 'data-pick': '' } });

  const radio = (value: Scope, key: MessageKey) => {
    const input = h('input', { attrs: { type: 'radio', name: 'scope', value, 'data-scope': value } });
    input.checked = scope === value;
    input.addEventListener('change', () => {
      scope = value;
      renderPick();
    });
    return h('label', { class: 'check' }, input, t(key));
  };

  /** A search box over the collection; `row` renders each hit. */
  function capSearch(row: (cap: Cap) => HTMLElement, name: string): HTMLElement {
    const list = h('ul', { class: 'exchange-caps', attrs: { 'data-caps': name } });
    const input = h('input', {
      class: 'input',
      attrs: { type: 'search', placeholder: t('exchange.searchCaps'), 'data-search': name },
    });
    const run = async () => {
      const params = new URLSearchParams({ limit: String(SEARCH_LIMIT), sort: 'brand' });
      if (input.value.trim() !== '') params.set('q', input.value.trim());
      try {
        const page = await ctx.api.request(`/caps?${params.toString()}`, { schema: CapPageSchema });
        list.replaceChildren(...page.items.map((cap) => h('li', {}, row(cap))));
      } catch {
        list.replaceChildren(h('li', { class: 'muted' }, t('exchange.searchFailed')));
      }
    };
    input.addEventListener('input', () => void run());
    void run();
    return h('div', { class: 'exchange-search' }, input, list);
  }

  function renderPick(): void {
    if (scope !== 'pick') return void pickBox.replaceChildren();
    if (pickBox.childElementCount > 0) return;
    pickBox.replaceChildren(
      capSearch((cap) => {
        const box = h('input', { attrs: { type: 'checkbox', 'data-pick-cap': cap.capId } });
        box.checked = picked.has(cap.capId);
        box.addEventListener('change', () => (box.checked ? picked.set(cap.capId, cap) : picked.delete(cap.capId)));
        return h('label', { class: 'check' }, box, capTitle(cap));
      }, 'pick'),
    );
  }

  async function subjectsOfScope() {
    if (scope === 'this' && scanId) {
      const subject = scanSubject(ctx.capture.current(), scanId);
      if (!subject) throw new ScopeError('exchange.scanGone');
      return [subject];
    }
    if (scope === 'this' && capId) {
      const cap = await ctx.api.request(`/caps/${encodeURIComponent(capId)}`, { schema: Cap });
      return [await capSubject(cap, options)];
    }
    let caps: Cap[];
    if (scope === 'needsReview') {
      const params = new URLSearchParams({ status: 'needsReview', limit: String(EXCHANGE_PAGE) });
      caps = (await ctx.api.request(`/caps?${params.toString()}`, { schema: CapPageSchema })).items;
    } else {
      caps = [...picked.values()];
    }
    if (caps.length === 0) throw new ScopeError(scope === 'pick' ? 'exchange.pickNone' : 'exchange.noneNeedReview');
    const subjects = [];
    for (const cap of caps) subjects.push(await capSubject(cap, options));
    return subjects;
  }

  async function deliver(file: File): Promise<void> {
    if (ctx.platform.kind === 'native') {
      await ctx.platform.share({ title: file.name, files: [file] }).catch(() => false);
    } else {
      download(file);
    }
  }

  async function create(): Promise<void> {
    if (busy) return;
    busy = true;
    createButton.disabled = true;
    result.hidden = true;
    say(requestStatus, 'exchange.building');
    try {
      const items = bundleItems(await subjectsOfScope(), newId, now().toISOString());
      for (const { document: doc } of items) {
        const top = doc.photos.find((p) => p.side === 'top');
        await ctx.api.request('/exchange/requests', {
          method: 'POST',
          body: {
            requestId: doc.requestId,
            dhash: top?.dhash,
            ...(doc.capId !== undefined ? { capId: doc.capId } : {}),
            ...(doc.scanId !== undefined ? { scanId: doc.scanId } : {}),
          },
          schema: ExchangeRequestItem,
        });
      }
      const [only] = items;
      const file =
        items.length === 1 && only ? await singleZip(only) : await batchZip(items, now().toISOString().slice(0, 10));
      bundle = { items, file };
      say(requestStatus, null);
      renderResult();
      await deliver(file);
      void loadPending();
    } catch (error) {
      say(requestStatus, error instanceof ScopeError ? error.key : 'exchange.createFailed', 'alert');
    } finally {
      busy = false;
      createButton.disabled = false;
    }
  }

  const copied = h('p', { class: 'muted', attrs: { role: 'status', 'data-status': 'copy' } });
  copied.hidden = true;
  const copyButton = (key: MessageKey, action: string, text: () => string) =>
    h(
      'button',
      {
        class: 'button button--secondary button--small',
        attrs: { type: 'button', 'data-action': action },
        on: {
          click: () => void copy(text()).then((ok) => say(copied, ok ? 'exchange.copied' : 'exchange.copyFailed')),
        },
      },
      t(key),
    );

  function renderResult(): void {
    if (!bundle) return;
    const { items, file } = bundle;
    const [only] = items;
    result.replaceChildren(
      h(
        'p',
        { attrs: { 'data-file': file.name } },
        t('exchange.ready', { name: file.name, count: String(items.length) }),
      ),
      h(
        'div',
        { class: 'ai-buttons' },
        h(
          'button',
          {
            class: 'button button--small',
            attrs: { type: 'button', 'data-action': 'deliver' },
            on: { click: () => void deliver(file) },
          },
          t(ctx.platform.kind === 'native' ? 'exchange.share' : 'exchange.download'),
        ),
        items.length === 1 && only && copyButton('exchange.copyPrompt', 'copy-prompt', () => promptText(only.document)),
        copyButton('exchange.copyJson', 'copy-json', () =>
          items.length === 1 && only ? jsonText(only.document) : jsonText(items.map((i) => i.document)),
        ),
      ),
      copied,
    );
    result.hidden = false;
  }

  const createButton = h(
    'button',
    { class: 'button', attrs: { type: 'button', 'data-action': 'create' }, on: { click: () => void create() } },
    t('exchange.create'),
  );

  const requestSection = h(
    'section',
    { class: 'exchange-section', attrs: { 'data-section': 'request' } },
    h('h2', { class: 'section-title' }, t('exchange.requestTitle')),
    h('p', { class: 'muted' }, t('exchange.requestHint')),
    h(
      'fieldset',
      { class: 'exchange-scope' },
      h('legend', {}, t('exchange.scope')),
      thisKey && radio('this', thisKey),
      radio('needsReview', 'exchange.scope.needsReview'),
      radio('pick', 'exchange.scope.pick'),
    ),
    pickBox,
    createButton,
    requestStatus,
    result,
  );

  // ── Upload answer ──
  const uploadStatus = h('p', { class: 'muted exchange-status', attrs: { 'data-status': 'upload' } });
  uploadStatus.hidden = true;
  const answerBox = h('div', { class: 'exchange-answer', attrs: { 'data-answer': '' } });
  const forLine = h('p', { class: 'muted', attrs: { 'data-uploaded-for': '' } });

  function renderFor(): void {
    forLine.textContent = uploadedFor ? t('exchange.uploadFor', { id: uploadedFor }) : '';
    forLine.hidden = !uploadedFor;
  }

  async function preparePhoto(file: Blob | undefined): Promise<CapPhoto | undefined> {
    if (file === undefined) return undefined;
    try {
      return await prepare(file);
    } catch {
      return undefined;
    }
  }

  async function handleFiles(files: readonly File[]): Promise<void> {
    if (files.length === 0) return;
    current = null;
    answerBox.replaceChildren();
    say(uploadStatus, 'exchange.reading');
    const contents = await readUpload(files);
    const read = readAnswer(contents, pending, uploadedFor);
    if (!read.ok) {
      const params = read.problem.kind === 'format' ? { detail: read.problem.message } : undefined;
      return say(uploadStatus, PROBLEM[read.problem.kind], 'alert', params);
    }
    const { answer } = read;
    const top = await preparePhoto(photoOf(contents.images, 'top')?.blob);
    const underside = await preparePhoto(photoOf(contents.images, 'underside')?.blob);
    const photos: ReviewPhotos | undefined = top
      ? { top: { photo: top }, ...(underside ? { underside: { photo: underside } } : {}) }
      : undefined;
    const chip = providerChip(answer.response.provider);
    current = {
      answer,
      ...(photos ? { photos } : {}),
      mismatch: photoMismatch(answer.expectedDhash, top?.dhash),
      ...(chip ? { chip } : {}),
      other: chip === 'other' ? (answer.response.provider ?? '') : '',
    };
    say(uploadStatus, null);
    renderAnswer();
  }

  const continueStatus = h('p', { class: 'muted exchange-status', attrs: { 'data-status': 'continue' } });
  continueStatus.hidden = true;

  function renderAnswer(): void {
    const state = current;
    if (!state) return void answerBox.replaceChildren();
    const { answer } = state;
    const filled = (Object.entries(answer.fields) as [keyof CapFields, unknown][]).filter(([, v]) => v !== undefined);
    const chips = PROVIDERS.map((p) =>
      h(
        'button',
        {
          class: 'chip',
          attrs: { type: 'button', 'data-provider': p, 'aria-pressed': String(state.chip === p) },
          on: {
            click: () => {
              state.chip = p;
              renderAnswer();
            },
          },
        },
        t(PROVIDER_LABEL[p]),
      ),
    );
    const other = h('input', {
      class: 'input',
      attrs: { type: 'text', placeholder: t('exchange.providerName'), 'data-provider-name': '' },
    });
    other.value = state.other;
    other.hidden = state.chip !== 'other';
    other.addEventListener('input', () => (state.other = other.value));
    const go = h(
      'button',
      { class: 'button', attrs: { type: 'button', 'data-action': 'continue' }, on: { click: () => void proceed() } },
      t('exchange.continue'),
    );
    answerBox.replaceChildren(
      ...present(
        h(
          'p',
          { attrs: { 'data-match': answer.request ? 'request' : 'none' } },
          answer.request ? t('exchange.matched', { id: answer.request.requestId }) : t('exchange.unmatched'),
        ),
        !answer.request &&
          h(
            'div',
            { class: 'exchange-attach', attrs: { 'data-attach': '' } },
            state.attached
              ? h(
                  'p',
                  { attrs: { 'data-attached': state.attached.capId } },
                  t('exchange.attachedTo', { name: capTitle(state.attached) }),
                )
              : h('p', { class: 'muted' }, t(state.photos ? 'exchange.attachOrNew' : 'exchange.attachHint')),
            capSearch(
              (cap) =>
                h(
                  'button',
                  {
                    class: 'menu-item',
                    attrs: { type: 'button', 'data-attach-cap': cap.capId },
                    on: {
                      click: () => {
                        state.attached = cap;
                        renderAnswer();
                      },
                    },
                  },
                  capTitle(cap),
                ),
              'attach',
            ),
          ),
        state.mismatch &&
          h(
            'p',
            { class: 'exchange-warning', attrs: { role: 'alert', 'data-warning': 'photo' } },
            t('exchange.photoMismatch'),
          ),
        answer.ignored.length > 0 &&
          h(
            'p',
            { class: 'muted', attrs: { 'data-ignored': '' } },
            t('exchange.ignored', { fields: answer.ignored.join(', ') }),
          ),
        answer.problems.length > 0 &&
          h(
            'p',
            { class: 'muted', attrs: { 'data-problems': '' } },
            t('exchange.problems', { values: answer.problems.join('; ') }),
          ),
        h(
          'dl',
          { class: 'exchange-fields' },
          ...filled.flatMap(([k, v]) => [h('dt', {}, t(`form.${k}` as MessageKey)), h('dd', {}, String(v))]),
        ),
        h('p', { class: 'section-title' }, t('exchange.provider')),
        h('div', { class: 'chips', attrs: { role: 'group' } }, ...chips),
        other,
        go,
        continueStatus,
      ),
    );
  }

  /** "Continue to review": tag the provider, then the review of a stored cap or of a new capture. */
  async function proceed(): Promise<void> {
    const state = current;
    if (!state || busy) return;
    const provider = state.chip ? providerId(state.chip, state.other) : null;
    const source = provider !== null ? externalSource(provider) : null;
    if (provider === null || source === null) return say(continueStatus, 'exchange.providerRequired', 'alert');
    const { answer } = state;
    const request = answer.request;
    const targetCap = request?.capId ?? state.attached?.capId;
    // A new capture needs its photo: from the upload, else the still-open scan the request came from.
    const session = ctx.capture.current();
    const openScan =
      request?.scanId !== undefined && session?.scanId === request.scanId && session.top?.ref ? session : undefined;
    const photos: ReviewPhotos | undefined =
      state.photos ??
      (openScan?.top?.ref
        ? {
            top: { photo: openScan.top.photo, ref: openScan.top.ref },
            ...(openScan.underside?.ref
              ? { underside: { photo: openScan.underside.photo, ref: openScan.underside.ref } }
              : {}),
          }
        : undefined);
    if (targetCap === undefined && photos === undefined) return say(continueStatus, 'exchange.photoNeeded', 'alert');
    busy = true;
    say(continueStatus, 'exchange.continuing');
    try {
      if (request?.status === 'waiting') {
        const ok = await markRequest(ctx.api, request.requestId, { status: 'answered', provider });
        if (!ok) throw new ScopeError('exchange.answeredFailed');
      }
      if (targetCap !== undefined) {
        const cap = await ctx.api.request(`/caps/${encodeURIComponent(targetCap)}`, { schema: Cap });
        const suggestions = suggestionsFor(cap, answer.fields);
        if (suggestions.length === 0) return say(continueStatus, 'exchange.nothingNew');
        const requestId = request?.requestId;
        el.replaceChildren(
          CapForm(ctx, {
            mode: 'edit',
            cap,
            ai: { suggestions, source },
            onSaved: async () => void (await markRequest(ctx.api, requestId, { status: 'reviewed' })),
          }),
        );
        return;
      }
      if (!photos) return;
      const path = await continueToReview(
        {
          api: ctx.api,
          capture: ctx.capture,
          newId,
          upload: (side, photo) => uploadImage(ctx.api, side, photo, options.put),
        },
        {
          photos,
          fields: answer.fields,
          confidence: answer.confidence,
          source,
          ...(request ? { requestId: request.requestId } : {}),
          ...(answer.notes !== undefined ? { notes: answer.notes } : {}),
        },
      );
      ctx.navigate(path);
    } catch (error) {
      say(continueStatus, error instanceof ScopeError ? error.key : 'exchange.continueFailed', 'alert');
    } finally {
      busy = false;
    }
  }

  async function pickAnswer(): Promise<void> {
    const files = await ctx.platform
      .pickFiles({ accept: '.zip,.json,application/zip,application/json,image/*', multiple: true })
      .catch(() => []);
    await handleFiles(files);
  }

  const dropZone =
    ctx.platform.kind === 'web'
      ? h(
          'div',
          {
            class: 'drop-zone',
            attrs: { 'data-drop': '', tabindex: '0' },
            on: {
              dragover: (e) => {
                e.preventDefault();
                dropZone?.classList.add('drop-zone--over');
              },
              dragleave: () => dropZone?.classList.remove('drop-zone--over'),
              drop: (e) => {
                e.preventDefault();
                dropZone?.classList.remove('drop-zone--over');
                void handleFiles([...(e.dataTransfer?.files ?? [])]);
              },
            },
          },
          t('exchange.dropHere'),
        )
      : null;

  const uploadSection = h(
    'section',
    { class: 'exchange-section', attrs: { 'data-section': 'upload' } },
    h('h2', { class: 'section-title' }, t('exchange.uploadTitle')),
    forLine,
    dropZone,
    h(
      'button',
      {
        class: 'button button--secondary',
        attrs: { type: 'button', 'data-action': 'pick-answer' },
        on: { click: () => void pickAnswer() },
      },
      t('exchange.chooseFiles'),
    ),
    uploadStatus,
    answerBox,
  );

  // ── Pending ──
  const pendingList = h('ul', { class: 'exchange-pending', attrs: { 'data-pending': '' } });

  function renderPending(): void {
    if (pending.length === 0) {
      pendingList.replaceChildren(h('li', { class: 'muted' }, t('exchange.noPending')));
      return;
    }
    pendingList.replaceChildren(
      ...pending.map((item) =>
        h(
          'li',
          { class: 'exchange-item', attrs: { 'data-request': item.requestId } },
          h(
            'span',
            { class: `chip chip--${item.status}`, attrs: { 'data-status-chip': item.status } },
            t(STATUS_LABEL[item.status]),
          ),
          h(
            'span',
            { class: 'exchange-item-what' },
            t(item.capId ? 'exchange.itemCap' : 'exchange.itemScan', {
              date: item.createdAt.slice(0, 10),
              id: (item.capId ?? item.scanId ?? item.requestId).slice(-6),
            }),
          ),
          (item.status === 'waiting' || item.status === 'answered') &&
            h(
              'button',
              {
                class: 'button button--secondary button--small',
                attrs: { type: 'button', 'data-action': 'upload-for' },
                on: {
                  click: () => {
                    uploadedFor = item.requestId;
                    renderFor();
                    void pickAnswer();
                  },
                },
              },
              t('exchange.uploadAnswer'),
            ),
        ),
      ),
    );
  }

  async function loadPending(): Promise<void> {
    try {
      pending = await ctx.api.request('/exchange/requests', { schema: ExchangeRequestListSchema });
      renderPending();
    } catch {
      pendingList.replaceChildren(h('li', { class: 'muted', attrs: { role: 'alert' } }, t('exchange.pendingFailed')));
    }
  }

  const el = h(
    'section',
    { class: 'screen exchange' },
    ScreenHeader(
      t('exchange.title'),
      h('a', { class: 'header-action', attrs: { href: pathFor('collection'), 'data-link': true } }, t('common.close')),
    ),
    requestSection,
    uploadSection,
    h(
      'section',
      { class: 'exchange-section', attrs: { 'data-section': 'pending' } },
      h('h2', { class: 'section-title' }, t('exchange.pendingTitle')),
      pendingList,
    ),
  );
  renderPick();
  renderFor();
  void loadPending();
  return el;
}

/** The children that render (`h` skips `false` / `null`; `replaceChildren` does not). */
function present(...children: Child[]): (Node | string)[] {
  return children.filter((c): c is Node | string => c !== null && c !== undefined && c !== false);
}

/** A failure the screen explains with its own message. */
class ScopeError extends Error {
  constructor(readonly key: MessageKey) {
    super(key);
  }
}

/** `/exchange` (`?scanId=` · `?capId=` · `?requestId=`). */
export const ExchangeScreen: Screen = (ctx, route) => ExchangeView(ctx, route.query);
