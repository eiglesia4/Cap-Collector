// The one cap form (ADR-003; SCREENS.md #3 "AI review", #5 "Manual entry" and Edit from #6; CAP-25, CAP-43), modes
// `empty | edit | ai-prefilled`. Photos: pick → resize to WebP ≤ 1024 px (ADR-006) → presigned
// upload (`POST /uploads` + PUT) → `ImageRef`. Fields in SCREENS.md order with inline errors from the shared
// `CapInput` schema and from a 422's `Problem.errors[]`. Save → `POST /caps` or a `PATCH` holding only the changed
// fields. New cap: "Save and flag needs review" sets `status: needsReview`; edit: a "Needs review" toggle pre-filled
// from the cap's status, sent only when changed (architect review, CAP-25, 2026-11-08). Leaving unsaved asks first.
// From a capture (CAP-41, `/new?scanId=…`): the scan's uploaded photos, the AI's brand suggestions, and the dHashes
// (plus `aiModel`) carried into `POST /caps` while the photo they were computed from is still the one attached.
// "It's a variant" (CAP-42, `/new?scanId=…&variantOf=<capId>`): pre-filled with the scan's fields, saved with
// `variantOf` (ADR-008 §1) and the scan's `source`.
// AI review (CAP-43, `/scan/review`, mode `ai-prefilled`): values from the identification, fields below 0.7 confidence
// highlighted as unsure, the scan's photos (not re-uploaded); Save → `POST /caps` with `source = bedrock:<aiModel>`,
// hashes, `aiModel`, `aiConfidence`; Ask again (`known` = edited fields, re-fills only untouched ones); Add underside.
// Re-identify (CAP-43, mode `edit` + `ai`): "AI suggests: X" per differing field, applied only when accepted → PATCH.
import {
  AnalyseResponse,
  Cap,
  CapType as CapTypeEnum,
  Closure as ClosureEnum,
  Condition as ConditionEnum,
  Material as MaterialEnum,
  type CapStatus,
  type CapType,
  type Closure,
  type Condition,
  type Material,
} from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import { brandSuggestions } from '../cap/brand.js';
import {
  EMPTY_VALUES,
  imagesFromCap,
  MAX_TAG_LENGTH,
  MAX_TAGS,
  patchBody,
  problemErrors,
  sameImages,
  sameValues,
  validate,
  valuesFromCap,
  valuesFromFields,
  type FieldName,
  type FormErrors,
  type FormImages,
  type FormValues,
  type ValueField,
} from '../cap/form-model.js';
import type { CaptureSession } from '../capture/context.js';
import { scanSource } from '../capture/duplicate.js';
import { analyseBody, routeFor } from '../capture/flow.js';
import {
  isAiField,
  knownFromValues,
  refill,
  reviewProvenance,
  reviewScan,
  unsureFields,
  type AiField,
  type Suggestion,
} from '../capture/review.js';
import { CapPageSchema } from '../collection/cap-page.js';
import { capsPath, DEFAULT_QUERY } from '../collection/query.js';
import { invalidateCollection } from '../collection/state.js';
import { capImage } from '../components/cap-tile.js';
import { ConfirmSheet } from '../components/confirm-sheet.js';
import { showToast } from '../components/toast.js';
import type { AppContext, Screen } from '../context.js';
import { searchCountries } from '../i18n/countries.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { CLOSURE_LABEL, CONDITION_LABEL, MATERIAL_LABEL, TYPE_LABEL } from '../i18n/labels.js';
import {
  ImageTooLargeError,
  resizeToWebp,
  WebpUnsupportedError,
  type CapPhoto,
  type ImageCodec,
} from '../images/resize.js';
import { uploadImage, type PutFn, type Side } from '../images/upload.js';
import { pathFor } from '../router/routes.js';
import { h, type Child } from '../ui/dom.js';

/** Brand autocomplete waits this long after the last keystroke. */
export const BRAND_DEBOUNCE_MS = 250;
/** Caps fetched per autocomplete lookup (`GET /caps?q=`). */
export const BRAND_LOOKUP_LIMIT = 30;
/** "Export for external AI" from the review: off until the Exchange screen lands (CAP-45). */
export const EXCHANGE_READY = false;

export type FormMode = 'empty' | 'edit' | 'ai-prefilled';

export interface CapFormOptions {
  readonly mode: FormMode;
  /** The cap being edited (mode `edit`). */
  readonly cap?: Cap;
  /** Image codec and PUT function; tests inject fakes (default: canvas and fetch). */
  readonly codec?: ImageCodec;
  readonly put?: PutFn;
  /** Manual entry of a capture (mode `empty`): its photos, suggestions and hashes (CAP-41). */
  readonly scan?: CaptureSession;
  /** Starting values instead of the empty ones (CAP-42 "It's a variant": the scan's fields). */
  readonly prefill?: FormValues;
  /** Merged into `POST /caps` (CAP-42: `variantOf`, `source`, `textOnCap` of the scan). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /** Circular crop + dHash for "Add underside photo" (CAP-43); tests inject a fake (happy-dom has no canvas). */
  readonly prepare?: (file: Blob) => Promise<CapPhoto>;
  /** Re-identify (CAP-43, mode `edit`): the AI's suggestions, each applied only when accepted, and their author. */
  readonly ai?: { readonly suggestions: readonly Suggestion[]; readonly source: string };
}

/** The scan's uploaded photos as form images. */
function imagesFromScan(scan: CaptureSession): FormImages {
  const out: FormImages = {};
  if (scan.top?.ref) out.top = scan.top.ref;
  if (scan.underside?.ref) out.underside = scan.underside.ref;
  return out;
}

/** dHashes and AI model of the scan, for the sides whose scanned photo is still attached (ADR-004 bookkeeping). */
export function scanFields(scan: CaptureSession, images: FormImages): Record<string, string> {
  const out: Record<string, string> = {};
  if (scan.top?.ref && images.top?.key === scan.top.ref.key) out.dhash = scan.top.photo.dhash;
  if (scan.underside?.ref && images.underside?.key === scan.underside.ref.key) {
    out.dhashUnderside = scan.underside.photo.dhash;
  }
  if (scan.response?.aiModel !== undefined) out.aiModel = scan.response.aiModel;
  return out;
}

type SlotState = 'idle' | 'processing' | 'uploading' | 'failed';

interface Slot {
  state: SlotState;
  /** Resized image waiting to be (re)uploaded after a failure. */
  pending: Parameters<typeof uploadImage>[2] | null;
  /** Object URL previewing a picked image. */
  preview: string | null;
  error: string | null;
}

const LABEL: Record<ValueField, MessageKey> = {
  brand: 'form.brand',
  variant: 'form.variant',
  producer: 'form.producer',
  country: 'form.country',
  type: 'form.type',
  material: 'form.material',
  closure: 'form.closure',
  year: 'form.year',
  description: 'form.description',
  condition: 'form.condition',
  acquiredWhere: 'form.acquiredWhere',
  acquiredOn: 'form.acquiredOn',
  tags: 'form.tags',
  notes: 'form.notes',
  quantity: 'form.quantity',
  forTrade: 'form.forTrade',
};

function objectUrl(blob: Blob): string | null {
  return typeof URL.createObjectURL === 'function' ? URL.createObjectURL(blob) : null;
}

function revoke(url: string | null): void {
  if (url !== null && typeof URL.revokeObjectURL === 'function') URL.revokeObjectURL(url);
}

function enumOptions<T extends string>(values: readonly T[], labels: Readonly<Record<T, MessageKey>>, current: string) {
  return [
    h('option', { attrs: { value: '' } }, t('form.none')),
    ...values.map((v) => h('option', { attrs: { value: v, selected: v === current } }, t(labels[v]))),
  ];
}

export function CapForm(ctx: AppContext, options: CapFormOptions): HTMLElement {
  const { mode, cap, scan, prefill, extra } = options;
  if (mode === 'edit' && cap === undefined) throw new Error('edit mode needs a cap');
  if (mode === 'ai-prefilled' && !scan?.response?.fields) throw new Error('ai-prefilled mode needs an identified scan');
  const aiFields = mode === 'ai-prefilled' ? scan?.response?.fields : undefined;
  const initialValues: FormValues = cap
    ? valuesFromCap(cap)
    : aiFields
      ? valuesFromFields(aiFields)
      : (prefill ?? { ...EMPTY_VALUES, tags: [] });
  const initialImages: FormImages = cap ? imagesFromCap(cap.images) : scan ? imagesFromScan(scan) : {};
  const values: FormValues = { ...initialValues, tags: [...initialValues.tags] };
  const images: FormImages = { ...initialImages };
  const slots: Record<Side, Slot> = {
    top: { state: 'idle', pending: null, preview: null, error: null },
    underside: { state: 'idle', pending: null, preview: null, error: null },
  };
  // A capture's photos are still in memory: preview them from their blobs.
  if (scan?.top?.ref) slots.top.preview = objectUrl(scan.top.photo.blob);
  if (scan?.underside?.ref) slots.underside.preview = objectUrl(scan.underside.photo.blob);
  const touched = new Set<FieldName>();
  let submitted = false;
  let saving = false;
  let serverErrors: FormErrors = {};
  let square = false;

  const errorSlots = new Map<FieldName, HTMLElement>();
  const errorSlot = (name: FieldName) => {
    const el = h('p', { class: 'field-error', attrs: { role: 'alert', 'data-error-for': name } });
    el.hidden = true;
    errorSlots.set(name, el);
    return el;
  };

  // Edit mode: "Needs review" toggle, on for a cap that is not `complete` (an `unidentified` one included).
  const initialFlag = cap !== undefined && cap.status !== 'complete';
  const reviewToggle = h('input', { attrs: { type: 'checkbox', id: 'cap-needs-review' } });
  reviewToggle.checked = initialFlag;

  const dirty = () =>
    reviewToggle.checked !== initialFlag ||
    !sameValues(values, initialValues) ||
    !sameImages(images, initialImages) ||
    slots.top.pending !== null ||
    slots.underside.pending !== null;

  const busy = () => saving || Object.values(slots).some((s) => s.state === 'processing' || s.state === 'uploading');

  /** Show the errors of touched fields (all of them after a save attempt); server errors until the next edit. */
  function showErrors(): FormErrors {
    const result = validate(values, images, 'complete');
    const local = result.ok ? {} : result.errors;
    for (const [name, el] of errorSlots) {
      const message = serverErrors[name] ?? ((submitted || touched.has(name)) && local[name]) ?? undefined;
      el.textContent = message || '';
      el.hidden = !message;
      el.closest('.field')?.classList.toggle('field--invalid', Boolean(message));
    }
    return local;
  }

  // Per-field input (to re-fill it after "Ask again" or an accepted suggestion) and hint line (unsure / AI suggests).
  const controls = new Map<ValueField, HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>();
  const hints = new Map<ValueField, HTMLElement>();
  let unsure =
    mode === 'ai-prefilled' ? unsureFields(scan?.response?.confidence) : new Map<AiField, number | undefined>();

  function changed(name: ValueField): void {
    touched.add(name);
    if (isAiField(name) && unsure.delete(name)) renderHints();
    // Quantity and forTrade are checked together (forTrade ≤ quantity).
    if (name === 'quantity') touched.add('forTrade');
    delete serverErrors[name];
    delete serverErrors.form;
    showErrors();
  }

  function field(name: ValueField, control: HTMLElement, ...extra: Child[]): HTMLElement {
    control.id = `cap-${name}`;
    if (control instanceof HTMLInputElement || control instanceof HTMLSelectElement) controls.set(name, control);
    if (control instanceof HTMLTextAreaElement) controls.set(name, control);
    const required = name === 'brand' ? t('form.required') : '';
    const hint = h('div', { class: 'field-hint', attrs: { 'data-hint-for': name } });
    hint.hidden = true;
    hints.set(name, hint);
    return h(
      'div',
      { class: 'field', attrs: { 'data-field': name } },
      h('label', { attrs: { for: control.id } }, t(LABEL[name]), required),
      hint,
      control,
      ...extra,
      errorSlot(name),
    );
  }

  /** Put `value` into field `name` as if typed (re-fill after "Ask again", an accepted AI suggestion). */
  function setValue(name: AiField, value: string): void {
    values[name] = value;
    if (name === 'country') return fillCountries();
    const control = controls.get(name);
    if (control) control.value = value;
  }

  /** Unsure highlight (ai-prefilled) and "AI suggests: X" with Accept (re-identify), per field. */
  function renderHints(): void {
    for (const [name, hint] of hints) {
      const fieldEl = hint.closest('.field');
      const isUnsure = isAiField(name) && unsure.has(name);
      fieldEl?.classList.toggle('field--unsure', isUnsure);
      const suggestion = options.ai?.suggestions.find((s) => s.field === name && values[name] !== s.value);
      if (isUnsure) {
        const c = unsure.get(name as AiField);
        hint.replaceChildren(
          h(
            'span',
            { class: 'unsure-label' },
            c === undefined ? t('review.unsure') : t('review.unsureConfidence', { percent: Math.round(c * 100) }),
          ),
        );
      } else if (suggestion) {
        hint.replaceChildren(
          h('span', { class: 'ai-suggests' }, t('review.aiSuggests', { value: displayValue(name, suggestion.value) })),
          h(
            'button',
            {
              class: 'button button--small button--secondary',
              attrs: { type: 'button', 'data-accept': name },
              on: {
                click: () => {
                  setValue(suggestion.field, suggestion.value);
                  changed(name);
                  renderHints();
                },
              },
            },
            t('review.accept'),
          ),
        );
      } else {
        hint.replaceChildren();
      }
      hint.hidden = !isUnsure && !suggestion;
    }
  }

  function textInput(
    name: Exclude<ValueField, 'tags'>,
    attrs: Record<string, string | boolean> = {},
  ): HTMLInputElement {
    const input = h('input', { class: 'input', attrs: { type: 'text', autocomplete: 'off', ...attrs } });
    input.value = values[name];
    input.addEventListener('input', () => {
      values[name] = input.value;
      changed(name);
    });
    return input;
  }

  function textArea(name: 'description' | 'notes'): HTMLTextAreaElement {
    const area = h('textarea', { class: 'input', attrs: { rows: '3' } });
    area.value = values[name];
    area.addEventListener('input', () => {
      values[name] = area.value;
      changed(name);
    });
    return area;
  }

  function select(name: 'type' | 'material' | 'closure' | 'condition', opts: HTMLOptionElement[]): HTMLSelectElement {
    const el = h('select', { class: 'input' }, ...opts);
    el.value = values[name];
    el.addEventListener('change', () => {
      values[name] = el.value;
      changed(name);
    });
    return el;
  }

  // ── Brand with autocomplete from the collection (story CAP-25: `GET /caps?q=`, debounced) ──
  const brandInput = textInput('brand', { autocapitalize: 'words' });
  const suggestions = h('ul', { class: 'suggestions', attrs: { role: 'listbox' } });
  suggestions.hidden = true;
  let lookupTimer: ReturnType<typeof setTimeout> | undefined;
  let lookupGeneration = 0;
  const showSuggestions = (brands: string[]) => {
    suggestions.replaceChildren(
      ...brands.map((brand) =>
        h(
          'li',
          {},
          h(
            'button',
            {
              class: 'suggestion',
              attrs: { type: 'button', role: 'option', 'data-brand': brand },
              on: {
                click: () => {
                  brandInput.value = brand;
                  values.brand = brand;
                  changed('brand');
                  showSuggestions([]);
                },
              },
            },
            brand,
          ),
        ),
      ),
    );
    suggestions.hidden = brands.length === 0;
  };
  // An unidentified capture offers the AI's brand reading(s) up front (SCREENS.md #5 "AI brand suggestions").
  if (scan?.response?.suggestions.length) showSuggestions([...scan.response.suggestions]);
  brandInput.addEventListener('input', () => {
    clearTimeout(lookupTimer);
    const typed = brandInput.value;
    const mine = ++lookupGeneration;
    if (typed.trim() === '') return showSuggestions([]);
    lookupTimer = setTimeout(() => {
      Promise.resolve()
        .then(() =>
          ctx.api.request(capsPath({ ...DEFAULT_QUERY, q: typed.trim() }, { limit: BRAND_LOOKUP_LIMIT }), {
            schema: CapPageSchema,
          }),
        )
        .then((page) => mine === lookupGeneration && showSuggestions(brandSuggestions(typed, page.items)))
        // Suggestions are a convenience: a failed lookup just shows none.
        .catch(() => mine === lookupGeneration && showSuggestions([]));
    }, BRAND_DEBOUNCE_MS);
  });

  // ── Country: ISO list with a search box filtering the select ──
  const countrySearch = h('input', {
    class: 'input country-search',
    attrs: {
      type: 'search',
      autocomplete: 'off',
      placeholder: t('form.countrySearch'),
      'aria-label': t('form.countrySearch'),
    },
  });
  const countrySelect = h('select', { class: 'input' });
  const fillCountries = () => {
    const matches = searchCountries(countrySearch.value);
    const current = values.country;
    if (current !== '' && !matches.some((c) => c.code === current)) {
      matches.unshift(...searchCountries('').filter((c) => c.code === current));
    }
    countrySelect.replaceChildren(
      h('option', { attrs: { value: '' } }, t('form.none')),
      ...matches.map((c) => h('option', { attrs: { value: c.code, selected: c.code === current } }, c.name)),
    );
    countrySelect.value = current;
  };
  countrySearch.addEventListener('input', fillCountries);
  countrySelect.addEventListener('change', () => {
    values.country = countrySelect.value;
    changed('country');
  });
  fillCountries();

  // ── Tags: chip input (Enter or comma adds; × removes) ──
  const tagList = h('ul', { class: 'tag-chips' });
  const tagInput = h('input', {
    class: 'input tag-input',
    attrs: { type: 'text', autocomplete: 'off', autocapitalize: 'none', placeholder: t('form.tagPlaceholder') },
  });
  const renderTags = () => {
    tagList.replaceChildren(
      ...values.tags.map((tag, i) =>
        h(
          'li',
          { class: 'chip chip--tag' },
          tag,
          h(
            'button',
            {
              class: 'chip-remove',
              attrs: { type: 'button', 'aria-label': t('form.removeTag', { tag }) },
              on: {
                click: () => {
                  values.tags = values.tags.filter((_, j) => j !== i);
                  renderTags();
                  changed('tags');
                },
              },
            },
            t('form.removeSymbol'),
          ),
        ),
      ),
    );
  };
  const addTag = () => {
    const tag = tagInput.value.replace(/,/g, ' ').trim().slice(0, MAX_TAG_LENGTH);
    tagInput.value = '';
    if (tag === '' || values.tags.includes(tag) || values.tags.length >= MAX_TAGS) return;
    values.tags = [...values.tags, tag];
    renderTags();
    changed('tags');
  };
  tagInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      addTag();
    } else if (e.key === 'Backspace' && tagInput.value === '' && values.tags.length > 0) {
      values.tags = values.tags.slice(0, -1);
      renderTags();
      changed('tags');
    }
  });
  tagInput.addEventListener('blur', addTag);
  renderTags();
  const tagBox = h('div', { class: 'tag-box' }, tagList, tagInput);
  tagBox.id = 'cap-tags';

  // ── Photos ──
  const photoBox = h('div', { class: 'photo-slots' });
  const formError = errorSlot('form');

  function renderPhotos(): void {
    photoBox.replaceChildren(photoSlot('top'), photoSlot('underside'));
    updateButtons();
    showErrors();
  }

  function photoSlot(side: Side): HTMLElement {
    const slot = slots[side];
    const preview =
      slot.preview !== null
        ? h('img', { class: 'photo-preview', attrs: { src: slot.preview, alt: '' } })
        : cap && images[side] !== undefined && images[side]?.key === cap.images[side]?.key
          ? capImage(cap, side, 'photo-preview')
          : h(
              'span',
              { class: 'photo-preview photo-preview--empty', attrs: { 'aria-hidden': 'true' } },
              t('form.photoAdd'),
            );
    const working = slot.state === 'processing' || slot.state === 'uploading';
    const pickButton = (source: 'camera' | 'library', key: MessageKey) =>
      h(
        'button',
        {
          class: 'button button--secondary button--small',
          attrs: { type: 'button', 'data-pick': `${side}:${source}`, disabled: working },
          on: { click: () => void pick(side, source) },
        },
        t(key),
      );
    const native = ctx.platform.kind === 'native';
    return h(
      'div',
      { class: 'photo-slot', attrs: { 'data-side': side, 'data-state': slot.state } },
      preview,
      h('p', { class: 'photo-label' }, t(side === 'top' ? 'form.photoTop' : 'form.photoUnderside')),
      working && h('p', { class: 'muted', attrs: { role: 'status' } }, t('form.uploading')),
      slot.error !== null && h('p', { class: 'field-error', attrs: { role: 'alert' } }, slot.error),
      slot.state === 'failed' &&
        h(
          'button',
          {
            class: 'button button--small',
            attrs: { type: 'button', 'data-retry': side },
            on: { click: () => void upload(side) },
          },
          t('form.retryUpload'),
        ),
      native ? pickButton('camera', 'form.takePhoto') : null,
      pickButton('library', native ? 'form.choosePhoto' : 'form.uploadPhoto'),
      side === 'top' && errorSlot('top'),
    );
  }

  async function pick(side: Side, source: 'camera' | 'library'): Promise<void> {
    let file: File | null;
    try {
      file =
        source === 'camera'
          ? await ctx.platform.camera()
          : ((await ctx.platform.pickFiles({ accept: 'image/*' }))[0] ?? null);
    } catch {
      file = null;
      slots[side].error = t('form.photoFailed');
      renderPhotos();
    }
    if (file === null) return;
    const slot = slots[side];
    slot.state = 'processing';
    slot.error = null;
    renderPhotos();
    try {
      const resizeOptions = options.codec ? { square, codec: options.codec } : { square };
      const resized = await resizeToWebp(file, resizeOptions);
      revoke(slot.preview);
      slot.preview = objectUrl(resized.blob);
      slot.pending = resized;
    } catch (error) {
      slot.state = 'idle';
      slot.error =
        error instanceof WebpUnsupportedError
          ? t('form.webpUnsupported')
          : error instanceof ImageTooLargeError
            ? t('form.photoTooLarge')
            : t('form.photoUnreadable');
      renderPhotos();
      return;
    }
    await upload(side);
  }

  /** Upload the pending image of `side`; on failure everything typed stays and the slot offers a retry (CAP-25). */
  async function upload(side: Side): Promise<void> {
    const slot = slots[side];
    if (slot.pending === null) return;
    slot.state = 'uploading';
    slot.error = null;
    renderPhotos();
    try {
      images[side] = await uploadImage(ctx.api, side, slot.pending, options.put);
      slot.pending = null;
      slot.state = 'idle';
      if (side === 'top') delete serverErrors.top;
    } catch {
      slot.state = 'failed';
      slot.error = t('form.uploadFailed');
    }
    renderPhotos();
  }

  const squareToggle = h('input', { attrs: { type: 'checkbox', id: 'cap-square' } });
  squareToggle.addEventListener('change', () => {
    square = squareToggle.checked;
  });

  // ── Buttons and save ──
  const saveButton = h(
    'button',
    { class: 'button', attrs: { type: 'submit', 'data-save': 'complete' } },
    t('common.save'),
  );
  const flagButton = h(
    'button',
    {
      class: 'button button--secondary',
      attrs: { type: 'button', 'data-save': 'needsReview' },
      on: { click: () => void save('needsReview') },
    },
    t('form.saveFlagged'),
  );
  function updateButtons(): void {
    saveButton.disabled = busy();
    flagButton.disabled = busy();
    if (mode === 'ai-prefilled') updateAiButtons();
  }

  /**
   * Status of an edit save: the cap's own unless the "Needs review" toggle changed (on → needsReview, off → complete),
   * so nothing is overwritten without an explicit tick (CLAUDE.md § Invariantes, ADR-003; decided 2026-11-08).
   */
  function editStatus(current: Cap): CapStatus {
    if (reviewToggle.checked === initialFlag) return current.status;
    return reviewToggle.checked ? 'needsReview' : 'complete';
  }

  async function save(status: CapStatus): Promise<void> {
    if (busy()) return;
    submitted = true;
    serverErrors = {};
    if (Object.values(slots).some((s) => s.state === 'failed')) {
      serverErrors.form = t('form.retryFirst');
      showErrors();
      return;
    }
    const result = validate(values, images, status);
    showErrors();
    if (!result.ok) {
      el.querySelector<HTMLElement>('.field--invalid input, .field--invalid select, .field--invalid textarea')?.focus();
      return;
    }
    saving = true;
    updateButtons();
    try {
      let saved: Cap;
      if (mode === 'edit' && cap) {
        const patch = patchBody(cap, result.input);
        if (patch === null) {
          releasePreviews();
          return ctx.navigate(pathFor('capDetail', { id: cap.capId }));
        }
        // An accepted AI suggestion makes the AI the author of the change (architect rule, CAP-42).
        if (options.ai?.suggestions.some((s) => s.field in patch && values[s.field] === s.value)) {
          patch.source = options.ai.source;
        }
        saved = await ctx.api.request(`/caps/${encodeURIComponent(cap.capId)}`, {
          method: 'PATCH',
          body: patch,
          schema: Cap,
        });
      } else {
        const body = {
          ...result.input,
          ...(scan ? scanFields(scan, images) : {}),
          ...(mode === 'ai-prefilled' && scan ? reviewProvenance(scan) : {}),
          ...extra,
        };
        saved = await ctx.api.request('/caps', { method: 'POST', body, schema: Cap });
      }
      if (scan) ctx.capture.clear();
      invalidateCollection(ctx);
      releasePreviews();
      ctx.navigate(pathFor('capDetail', { id: saved.capId }));
      showToast(t('form.saved'));
    } catch (error) {
      serverErrors =
        error instanceof ProblemError && error.problem.errors?.length
          ? problemErrors(error.problem)
          : {
              form:
                (error instanceof ProblemError || error instanceof HttpError) && error.status === 409
                  ? t('form.conflict')
                  : t('form.saveFailed'),
            };
      showErrors();
    } finally {
      saving = false;
      updateButtons();
    }
  }

  // ── AI review actions (CAP-43): Ask again, Add underside photo ──
  const aiStatus = h('p', { class: 'muted ai-status', attrs: { role: 'status', 'data-ai-status': '' } });
  aiStatus.hidden = true;
  let asking = false;
  const sayAi = (key: MessageKey | null) => {
    aiStatus.textContent = key === null ? '' : t(key);
    aiStatus.hidden = key === null;
  };
  const askButton = h(
    'button',
    {
      class: 'button button--secondary button--small',
      attrs: { type: 'button', 'data-action': 'ask-again' },
      on: { click: () => void askAgain() },
    },
    t('review.askAgain'),
  );
  const undersideButton = h(
    'button',
    {
      class: 'button button--secondary button--small',
      attrs: { type: 'button', 'data-action': 'add-underside' },
      on: { click: () => void addUnderside() },
    },
    t('review.addUnderside'),
  );
  const updateAiButtons = () => {
    askButton.disabled = asking || busy();
    undersideButton.disabled = asking || busy();
    undersideButton.hidden = scan?.underside?.ref !== undefined;
  };

  /**
   * `POST /scans/analyse` again for this scan: same `scanId` and images, `known` = the fields the user edited; the
   * answer re-fills only untouched fields. A `duplicate` answer (brand re-check) goes to Already in collection.
   */
  async function askAgain(): Promise<void> {
    if (!scan?.top?.ref || asking) return;
    asking = true;
    sayAi('review.asking');
    updateAiButtons();
    try {
      const body = { ...analyseBody(scan), known: knownFromValues(values, touched), useAi: true };
      const response = await ctx.api.request('/scans/analyse', { method: 'POST', body, schema: AnalyseResponse });
      scan.response = response;
      if (response.outcome === 'duplicate') {
        releasePreviews();
        return ctx.navigate(routeFor(response));
      }
      if (response.outcome === 'unidentified') return sayAi('review.notIdentified');
      for (const [field, value] of Object.entries(refill(values, touched, response.fields))) {
        setValue(field as AiField, value);
      }
      unsure = unsureFields(response.confidence);
      for (const name of touched) if (isAiField(name)) unsure.delete(name);
      renderHints();
      showErrors();
      sayAi('review.updated');
    } catch (error) {
      const unavailable = (error instanceof ProblemError || error instanceof HttpError) && error.status === 503;
      sayAi(unavailable ? 'scan.aiUnavailable' : 'review.askFailed');
    } finally {
      asking = false;
      updateAiButtons();
    }
  }

  /** Underside photo for this scan: camera (or picker) → circular crop + dHash → upload → Ask again with both. */
  async function addUnderside(): Promise<void> {
    if (!scan || asking) return;
    let file: File | null;
    try {
      file =
        ctx.platform.kind === 'native'
          ? await ctx.platform.camera()
          : ((await ctx.platform.pickFiles({ accept: 'image/*' }))[0] ?? null);
    } catch {
      return sayAi('form.photoFailed');
    }
    if (file === null) return;
    asking = true;
    updateAiButtons();
    sayAi('scan.preparing');
    try {
      const photo = await (options.prepare ?? ((f: Blob) => resizeToWebp(f, { crop: 'circle' })))(file);
      sayAi('scan.uploading');
      const ref = await uploadImage(ctx.api, 'underside', photo, options.put);
      scan.underside = { photo, ref };
      images.underside = ref;
      revoke(slots.underside.preview);
      slots.underside.preview = objectUrl(photo.blob);
    } catch {
      asking = false;
      updateAiButtons();
      return sayAi('scan.undersideFailed');
    }
    asking = false;
    renderPhotos();
    await askAgain();
  }

  /** Leaving the form: free the photo previews' object URLs. */
  function releasePreviews(): void {
    revoke(slots.top.preview);
    revoke(slots.underside.preview);
  }

  // Cancel is a real link (SCREENS.md § Navigation: Cancel → Scan; Edit goes back to the cap's detail). With unsaved
  // changes the click is held here — before the router's document listener — until the user confirms.
  // SPEC-GAP CAP-25: the router has no leave hook, so the browser's own Back button (Mac/web) is not guarded; the
  // form is modal (no tab bar), and on the iPhone Cancel is the only way out. Accepted for V1 (architect, 2026-11-08).
  const leaveTo = cap ? pathFor('capDetail', { id: cap.capId }) : pathFor('scan');
  // "Export for external AI" (SCREENS.md #3) waits for the Exchange screen (CAP-45).
  // SPEC-GAP CAP-43: the story hides it "by route existence", but `/exchange` already exists as a placeholder; a
  // constant stands in until CAP-45 flips it.
  const exportLink = EXCHANGE_READY
    ? h(
        'a',
        {
          class: 'button button--secondary button--small',
          attrs: { href: pathFor('exchange'), 'data-link': true, 'data-action': 'export' },
        },
        t('scan.exportExternal'),
      )
    : null;
  async function confirmLeave(): Promise<void> {
    const discard = await ConfirmSheet(el, {
      message: t('form.discardConfirm'),
      confirm: t('form.discard'),
      cancel: t('form.keepEditing'),
      danger: true,
    });
    if (!discard) return;
    releasePreviews();
    ctx.navigate(leaveTo);
  }
  const cancel = h(
    'a',
    {
      class: 'header-action',
      attrs: { href: leaveTo, 'data-link': true, 'data-action': 'cancel' },
      on: {
        click: (e) => {
          if (!dirty()) return releasePreviews();
          e.preventDefault();
          void confirmLeave();
        },
      },
    },
    t('common.cancel'),
  );

  const typeOptions = enumOptions<CapType>(CapTypeEnum.options, TYPE_LABEL, values.type);
  const materialOptions = enumOptions<Material>(MaterialEnum.options, MATERIAL_LABEL, values.material);
  const closureOptions = enumOptions<Closure>(ClosureEnum.options, CLOSURE_LABEL, values.closure);
  const conditionOptions = enumOptions<Condition>(ConditionEnum.options, CONDITION_LABEL, values.condition);

  const form = h(
    'form',
    {
      class: 'cap-form-body',
      attrs: { novalidate: true },
      on: {
        submit: (e) => {
          e.preventDefault();
          void save(cap ? editStatus(cap) : 'complete');
        },
      },
    },
    mode === 'ai-prefilled' &&
      h(
        'section',
        { class: 'form-section ai-actions' },
        h('div', { class: 'ai-buttons' }, askButton, undersideButton, exportLink),
        aiStatus,
      ),
    h(
      'section',
      { class: 'form-section' },
      photoBox,
      h('label', { class: 'check' }, squareToggle, t('form.cropSquare')),
    ),
    h(
      'section',
      { class: 'form-section' },
      field('brand', brandInput, suggestions),
      field('variant', textInput('variant')),
      field('producer', textInput('producer')),
      field('country', countrySelect, countrySearch),
      field('type', select('type', typeOptions)),
      field('material', select('material', materialOptions)),
      field('closure', select('closure', closureOptions)),
      field('year', textInput('year', { inputmode: 'numeric', pattern: '[0-9]*', maxlength: '4' })),
      field('description', textArea('description')),
    ),
    h(
      'section',
      { class: 'form-section' },
      field('condition', select('condition', conditionOptions)),
      field('acquiredWhere', textInput('acquiredWhere')),
      field('acquiredOn', textInput('acquiredOn', { type: 'date' })),
      field('tags', tagBox),
      field('notes', textArea('notes')),
      h(
        'div',
        { class: 'field-row' },
        field('quantity', textInput('quantity', { inputmode: 'numeric', pattern: '[0-9]*' })),
        field('forTrade', textInput('forTrade', { inputmode: 'numeric', pattern: '[0-9]*' })),
      ),
    ),
    formError,
    mode === 'edit' && h('label', { class: 'check' }, reviewToggle, t('form.needsReview')),
    h('div', { class: 'form-actions' }, saveButton, mode === 'edit' ? false : flagButton),
  );

  const el = h(
    'section',
    { class: 'screen cap-form', attrs: { 'data-mode': mode } },
    h(
      'header',
      { class: 'screen-header' },
      cancel,
      h(
        'h1',
        { class: 'screen-title' },
        t(
          options.ai
            ? 'reidentify.title'
            : mode === 'edit'
              ? 'capEdit.title'
              : mode === 'ai-prefilled'
                ? 'scanReview.title'
                : extra?.variantOf
                  ? 'newCap.variantTitle'
                  : 'newCap.title',
        ),
      ),
    ),
    form,
  );
  renderPhotos();
  renderHints();
  return el;
}

/** A field value as shown in a hint: enum labels, the rest as typed. */
function displayValue(field: ValueField, value: string): string {
  if (field === 'type') return t(TYPE_LABEL[value as CapType]);
  if (field === 'material') return t(MATERIAL_LABEL[value as Material]);
  if (field === 'closure') return t(CLOSURE_LABEL[value as Closure]);
  return value;
}

/**
 * `/new`: Manual entry (SCREENS.md #5), the empty form; `/new?scanId=…` pre-fills it from that capture when its scan
 * context is still open (an unidentified cap, or "Enter manually" after a 503).
 */
export const NewCapScreen: Screen = (ctx, route) => {
  const session = ctx.capture.current();
  const scanId = route.query.scanId;
  const scan = scanId !== undefined && session?.scanId === scanId && session.top?.ref ? session : undefined;
  if (!scan) return CapForm(ctx, { mode: 'empty' });
  // "It's a variant" from Already in collection (CAP-42): only for the cap this scan matched.
  const variantOf = route.query.variantOf;
  if (variantOf === undefined || scan.response?.match?.capId !== variantOf)
    return CapForm(ctx, { mode: 'empty', scan });
  const fields = scan.response.fields ?? {};
  return CapForm(ctx, {
    mode: 'empty',
    scan,
    prefill: valuesFromFields(fields),
    extra: {
      variantOf,
      source: scanSource(scan),
      ...(fields.textOnCap !== undefined ? { textOnCap: fields.textOnCap } : {}),
    },
  });
};

/**
 * `/scan/review`: AI review (SCREENS.md #3, CAP-43), the form in mode `ai-prefilled` over the open scan context. Reached
 * without an identified scan (reload): nothing to review, back to Scan.
 */
export const ScanReviewScreen: Screen = (ctx) => {
  const scan = reviewScan(ctx.capture.current());
  if (scan) return CapForm(ctx, { mode: 'ai-prefilled', scan });
  return h(
    'section',
    { class: 'screen' },
    h(
      'header',
      { class: 'screen-header' },
      h('a', { class: 'header-action', attrs: { href: pathFor('scan'), 'data-link': true } }, t('common.cancel')),
      h('h1', { class: 'screen-title' }, t('scanReview.title')),
    ),
    h('p', { class: 'muted', attrs: { role: 'status' } }, t('scanDuplicate.noScan')),
    h('a', { class: 'button', attrs: { href: pathFor('scan'), 'data-link': true } }, t('scanDuplicate.scanAgain')),
  );
};

/** `/cap/:id/edit`: the same form in edit mode, once the cap is loaded. */
export const EditCapScreen: Screen = (ctx, route) => {
  const capId = route.params.id ?? '';
  const el = h('section', { class: 'screen cap-form-loader' });
  const back = h(
    'a',
    { class: 'header-action', attrs: { href: pathFor('capDetail', { id: capId }), 'data-link': true } },
    t('common.cancel'),
  );
  const load = () => {
    el.replaceChildren(
      h('header', { class: 'screen-header' }, back, h('h1', { class: 'screen-title' }, t('capEdit.title'))),
      h('p', { class: 'muted', attrs: { role: 'status' } }, t('capDetail.loading')),
    );
    Promise.resolve()
      .then(() => ctx.api.request(`/caps/${encodeURIComponent(capId)}`, { schema: Cap }))
      .then(
        (cap) => el.replaceChildren(CapForm(ctx, { mode: 'edit', cap })),
        (error: unknown) => {
          const notFound = (error instanceof HttpError || error instanceof ProblemError) && error.status === 404;
          el.replaceChildren(
            h('header', { class: 'screen-header' }, back, h('h1', { class: 'screen-title' }, t('capEdit.title'))),
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
  load();
  return el;
};
