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
// Pre-assigned pocket (CAP-52, an empty pocket of the album sheet): the scan's `targetLocationCode`, or `/new?pocket=`,
// is sent as `CapInput.location` (CAP-50) so the new cap lands in that pocket; a 409 means it is taken meanwhile.
// Otherwise a new cap's Save proposes the next free pocket of the default album first (CAP-53, "Put it in A·3·17?"
// Yes / Choose… / Not now; components/place-sheet.ts); backing out of the proposal does not save.
// A batch item (CAP-84, ADR-009 §3): the batch strip on top; Save goes to the batch's next item instead of Detail, and
// without "Propose next free pocket" (the batch's toggle) the cap is saved without a location and no proposal; Cancel
// discards this item and moves on.
// Photos go through the crop check first (CAP-92, ADR-010 §2: components/crop-check.ts as a sheet over the form, so the
// typed values stay): the slot pickers and "Add underside photo" both get the detector-placed circle and Use photo;
// the cropped WebP is what is uploaded. No blind centre crop and no "square" option any more.
// CAP-93 (ADR-004, architect decision in the CAP-92 review): a photo picked in the form carries its dHash (computed by
// `cropCircle` exactly like a scan's), sent as `dhash` / `dhashUnderside` with the new cap or, in edit, in the PATCH
// of the side it replaces — while that photo is still the one attached — so hand-entered caps are found by later scans.
// Defaults when unsure (CAP-98, features.md § Defaults when unsure): a new cap (AI review, Manual entry, batch) starts
// with `acquiredOn` = today, steel + pry-off when empty (marked "default — check") and `type` guessed from its text
// (marked "guessed — check", re-guessed while the text is typed). Changing a marked or unsure field, or its "Looks
// right" tap, clears the mark; Save of a new cap with an AI-unsure or guessed value still unchecked → `needsReview`.
// Edit mode gets no defaults and no automatic status.
// CAP-100 (same section, and § Place from GPS): an empty `year` = the current year and an empty `acquiredWhere` = the
// place the phone is at now (web: the last place used on this device), both marked "default — check" and never
// flagging the cap. The place arrives after the form opens (once per form, once per batch) and does not overwrite
// what the user typed meanwhile; a saved `acquiredWhere` becomes the device's last place used.
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
  type AlbumLocation,
  formatLocationCode,
} from '@capcollector/shared';

import { HttpError, ProblemError } from '../api/errors.js';
import { pocketLocation } from '../albums/model.js';
import { finishBatchItem } from '../batch/run.js';
import { BatchStrip } from '../components/batch-strip.js';
import { isOccupied, wireLocation } from '../albums/place.js';
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
import { guessType, localDate, newCapDefaults, type Mark } from '../capture/defaults.js';
import { appendNotes, NOTES_MAX, notesHeader } from '../exchange/append-notes.js';
import { defaultPlace, rememberPlace } from '../capture/place.js';
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
import { markReviewed } from '../exchange/continue.js';
import { capImage } from '../components/cap-tile.js';
import { ConfirmSheet } from '../components/confirm-sheet.js';
import { CropCheckSheet, type CropCheckDeps } from '../components/crop-check.js';
import { proposeLocation } from '../components/place-sheet.js';
import { showToast } from '../components/toast.js';
import { clockOf, type AppContext, type Screen } from '../context.js';
import { searchCountries } from '../i18n/countries.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { CLOSURE_LABEL, CONDITION_LABEL, MATERIAL_LABEL, TYPE_LABEL } from '../i18n/labels.js';
import type { CapPhoto } from '../images/resize.js';
import { uploadImage, type PutFn, type Side } from '../images/upload.js';
import { exchangePath, pathFor } from '../router/routes.js';
import { h, type Child } from '../ui/dom.js';

/** Brand autocomplete waits this long after the last keystroke. */
export const BRAND_DEBOUNCE_MS = 250;
/** Caps fetched per autocomplete lookup (`GET /caps?q=`). */
export const BRAND_LOOKUP_LIMIT = 30;

export type FormMode = 'empty' | 'edit' | 'ai-prefilled';

export interface CapFormOptions {
  readonly mode: FormMode;
  /** The cap being edited (mode `edit`). */
  readonly cap?: Cap;
  /** Codec / detector / cropper of the crop check (CAP-92); tests inject fakes (default: canvas and detectCaps). */
  readonly check?: CropCheckDeps;
  /** PUT function of the upload; tests inject a fake (default: fetch). */
  readonly put?: PutFn;
  /** Manual entry of a capture (mode `empty`): its photos, suggestions and hashes (CAP-41). */
  readonly scan?: CaptureSession;
  /** Starting values instead of the empty ones (CAP-42 "It's a variant": the scan's fields). */
  readonly prefill?: FormValues;
  /** Merged into `POST /caps` (CAP-42: `variantOf`, `source`, `textOnCap` of the scan). */
  readonly extra?: Readonly<Record<string, unknown>>;
  /**
   * Re-identify (CAP-43, mode `edit`): the AI's suggestions, each applied only when accepted, and their author; an
   * external answer's notes (CAP-114) are offered the same way, appended to the cap's notes only when ticked.
   */
  readonly ai?: { readonly suggestions: readonly Suggestion[]; readonly source: string; readonly notes?: string };
  /** Starting notes (CAP-45: an external answer's notes and ignored fields; modes `ai-prefilled` / `empty`). */
  readonly notes?: string;
  /** Runs after a successful save, before leaving (CAP-45: mark the exchange request `reviewed`). */
  readonly onSaved?: (cap: Cap) => Promise<void>;
  /** Pocket a new cap goes to (CAP-52: manual entry from an empty pocket); a scan's `targetLocationCode` otherwise. */
  readonly location?: AlbumLocation;
}

/** The scan's uploaded photos as form images. */
function imagesFromScan(scan: CaptureSession): FormImages {
  const out: FormImages = {};
  if (scan.top?.ref) out.top = scan.top.ref;
  if (scan.underside?.ref) out.underside = scan.underside.ref;
  return out;
}

/** The dHash of each side whose photo was picked in the form, by the uploaded key it belongs to (CAP-93). */
export type PickedHashes = Partial<Record<Side, { readonly key: string; readonly dhash: string }>>;

/** `dhash` / `dhashUnderside` of the picked photos that are still the attached ones (CAP-93; ADR-004 bookkeeping). */
export function pickedFields(picked: PickedHashes, images: FormImages): Record<string, string> {
  const out: Record<string, string> = {};
  if (picked.top && images.top?.key === picked.top.key) out.dhash = picked.top.dhash;
  if (picked.underside && images.underside?.key === picked.underside.key) {
    out.dhashUnderside = picked.underside.dhash;
  }
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

type SlotState = 'idle' | 'uploading' | 'failed';

interface Slot {
  state: SlotState;
  /** Cropped photo waiting to be (re)uploaded after a failure. */
  pending: CapPhoto | null;
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
  const location = mode === 'edit' ? null : (options.location ?? pocketLocation(scan?.targetLocationCode));
  const baseValues: FormValues = cap
    ? valuesFromCap(cap)
    : aiFields
      ? valuesFromFields(aiFields)
      : (prefill ?? { ...EMPTY_VALUES, tags: [] });
  // CAP-98: how the values the user did not type got there (defaults, text guess); new caps only.
  const marks = new Map<ValueField, Mark>();
  const textOnCap = [aiFields?.textOnCap, scan?.response?.fields?.textOnCap, extra?.textOnCap].find(
    (v): v is string => typeof v === 'string',
  );
  /** Guess `type` from the cap's text while it is empty or still a guess; drop a guess the text no longer backs. */
  const guess = (v: FormValues): void => {
    if (v.type !== '' && marks.get('type') !== 'guessed') return;
    const guessed = guessType([v.brand, v.producer, v.description, textOnCap ?? ''].join(' '));
    if (guessed !== undefined) {
      v.type = guessed;
      marks.set('type', 'guessed');
    } else if (marks.delete('type')) v.type = '';
  };
  const seeded: FormValues = { ...baseValues, tags: [...baseValues.tags] };
  if (mode !== 'edit') {
    // CAP-124: the same defaults as every other capture path (multi-import included); the place arrives later.
    const given = (v: string) => (v === '' ? undefined : v);
    const defaults = newCapDefaults(
      {
        ...(seeded.acquiredOn !== '' ? { acquiredOn: seeded.acquiredOn } : {}),
        ...(seeded.year !== '' ? { year: Number(seeded.year) } : {}),
        ...(given(seeded.material) ? { material: seeded.material as Material } : {}),
        ...(given(seeded.closure) ? { closure: seeded.closure as Closure } : {}),
        ...(given(seeded.type) ? { type: seeded.type as CapType } : {}),
      },
      { now: clockOf(ctx), text: [seeded.brand, seeded.producer, seeded.description, textOnCap ?? ''].join(' ') },
    );
    const { values: filled } = defaults;
    if (filled.acquiredOn !== undefined) seeded.acquiredOn = filled.acquiredOn;
    if (filled.year !== undefined) seeded.year = String(filled.year);
    if (filled.material !== undefined) seeded.material = filled.material;
    if (filled.closure !== undefined) seeded.closure = filled.closure;
    if (filled.type !== undefined) seeded.type = filled.type;
    for (const [field, mark] of defaults.marks) if (field !== 'acquiredWhere') marks.set(field, mark);
  }
  const initialValues: FormValues = !cap && options.notes !== undefined ? { ...seeded, notes: options.notes } : seeded;
  const initialImages: FormImages = cap ? imagesFromCap(cap.images) : scan ? imagesFromScan(scan) : {};
  const values: FormValues = { ...initialValues, tags: [...initialValues.tags] };
  const images: FormImages = { ...initialImages };
  const slots: Record<Side, Slot> = {
    top: { state: 'idle', pending: null, preview: null, error: null },
    underside: { state: 'idle', pending: null, preview: null, error: null },
  };
  /** Hashes of the photos picked in this form (CAP-93). */
  const picked: PickedHashes = {};
  // A capture's photos are still in memory: preview them from their blobs.
  if (scan?.top?.ref) slots.top.preview = objectUrl(scan.top.photo.blob);
  if (scan?.underside?.ref) slots.underside.preview = objectUrl(scan.underside.photo.blob);
  const touched = new Set<FieldName>();
  let submitted = false;
  let saving = false;
  let serverErrors: FormErrors = {};

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

  // CAP-114: an external answer's notes for a stored cap, offered unticked (nothing overwritten without a tick).
  const aiNotes = mode === 'edit' && options.ai?.notes?.trim() ? options.ai : undefined;
  const notesTick = h('input', { attrs: { type: 'checkbox', 'data-accept-notes': '' } });
  const notesFit = h('p', { class: 'muted', attrs: { 'data-notes-fit': '' } });
  /** The notes a save would write with the tick on, from the current notes and today's header. */
  const mergedNotes = () =>
    aiNotes?.notes === undefined
      ? null
      : appendNotes(values.notes, aiNotes.notes, notesHeader(aiNotes.source, localDate(clockOf(ctx))));
  /** "Shortened to fit" / "no room" next to the tick, as the notes field changes. */
  function renderNotesFit(): void {
    if (!aiNotes) return;
    const merged = mergedNotes();
    notesTick.disabled = merged === null;
    if (merged === null) notesTick.checked = false;
    notesFit.textContent =
      merged === null
        ? t('form.aiNotesNoRoom', { max: NOTES_MAX })
        : merged.truncated
          ? t('form.aiNotesTruncated', { max: NOTES_MAX })
          : '';
    notesFit.hidden = notesFit.textContent === '';
  }
  const aiNotesBox =
    aiNotes &&
    h(
      'div',
      { class: 'ai-notes', attrs: { 'data-ai-notes': '' } },
      h('span', { class: 'ai-suggests' }, t('form.aiNotes')),
      h('p', { class: 'ai-notes__text' }, aiNotes.notes ?? ''),
      h('label', { class: 'check' }, notesTick, t('form.aiNotesAdd')),
      notesFit,
    );

  const dirty = () =>
    notesTick.checked ||
    reviewToggle.checked !== initialFlag ||
    !sameValues(values, initialValues) ||
    !sameImages(images, initialImages) ||
    slots.top.pending !== null ||
    slots.underside.pending !== null;

  const busy = () => saving || Object.values(slots).some((s) => s.state === 'uploading');

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
    const cleared = marks.delete(name);
    if ((isAiField(name) && unsure.delete(name)) || cleared) renderHints();
    if (
      mode !== 'edit' &&
      !touched.has('type') &&
      (name === 'brand' || name === 'producer' || name === 'description')
    ) {
      reguess();
    }
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

  /** Re-run the type guess over the current text (CAP-98) and show its result. */
  function reguess(): void {
    const before = values.type;
    guess(values);
    if (values.type !== before) setValue('type', values.type);
    renderHints();
  }

  /** "Looks right" on a mark or an unsure highlight: the value is now the user's (CAP-98). */
  function confirmField(name: ValueField): void {
    touched.add(name);
    marks.delete(name);
    if (isAiField(name)) unsure.delete(name);
    renderHints();
  }

  /** A new cap still holding an AI-unsure value or a text guess nobody checked is saved as `needsReview` (CAP-98). */
  function toVerify(): boolean {
    if ([...marks.values()].includes('guessed')) return true;
    // SPEC-GAP CAP-98: an unsure field the AI left empty (typically `year`) has no value to verify, so it does not
    // flag the cap; otherwise nearly every AI save would be `needsReview`.
    // A field holding one of our defaults is not an AI guess (defaults alone never flag the cap).
    return [...unsure.keys()].some((name) => !marks.has(name) && values[name].trim() !== '');
  }

  const confirmButton = (name: ValueField) =>
    h(
      'button',
      {
        class: 'button button--small button--secondary',
        attrs: { type: 'button', 'data-confirm': name },
        on: { click: () => confirmField(name) },
      },
      t('form.markConfirm'),
    );

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
      const mark = marks.get(name);
      const isUnsure = mark === undefined && isAiField(name) && unsure.has(name);
      fieldEl?.classList.toggle('field--unsure', isUnsure);
      fieldEl?.classList.toggle('field--default', mark === 'default');
      fieldEl?.classList.toggle('field--guessed', mark === 'guessed');
      const suggestion = options.ai?.suggestions.find((s) => s.field === name && values[name] !== s.value);
      if (mark) {
        hint.replaceChildren(
          h(
            'span',
            { class: 'unsure-label', attrs: { 'data-mark': mark } },
            t(mark === 'default' ? 'form.markDefault' : 'form.markGuessed'),
          ),
          confirmButton(name),
        );
      } else if (isUnsure) {
        const c = unsure.get(name as AiField);
        hint.replaceChildren(
          h(
            'span',
            { class: 'unsure-label' },
            c === undefined ? t('review.unsure') : t('review.unsureConfidence', { percent: Math.round(c * 100) }),
          ),
          confirmButton(name),
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
      hint.hidden = !mark && !isUnsure && !suggestion;
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
      if (name === 'notes') renderNotesFit();
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
    const working = slot.state === 'uploading';
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

  /** The camera or the photo library (web: always a file picker); null when the user backs out. */
  async function takeFile(source: 'camera' | 'library'): Promise<File | null> {
    return source === 'camera'
      ? ctx.platform.camera()
      : ((await ctx.platform.pickFiles({ accept: 'image/*' }))[0] ?? null);
  }

  /** Pick or shoot, then the crop check (CAP-92); null when the user backs out of either. */
  async function checkedPhoto(side: Side, source: 'camera' | 'library'): Promise<CapPhoto | null> {
    const file = await takeFile(source);
    if (file === null) return null;
    return CropCheckSheet(el, { ...options.check, file, side, retake: () => takeFile(source) });
  }

  async function pick(side: Side, source: 'camera' | 'library'): Promise<void> {
    const slot = slots[side];
    let photo: CapPhoto | null;
    try {
      photo = await checkedPhoto(side, source);
    } catch {
      slot.error = t('form.photoFailed');
      renderPhotos();
      return;
    }
    if (photo === null) return;
    slot.error = null;
    revoke(slot.preview);
    slot.preview = objectUrl(photo.blob);
    slot.pending = photo;
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
      const ref = await uploadImage(ctx.api, side, slot.pending, options.put);
      images[side] = ref;
      picked[side] = { key: ref.key, dhash: slot.pending.dhash };
      slot.pending = null;
      slot.state = 'idle';
      if (side === 'top') delete serverErrors.top;
    } catch {
      slot.state = 'failed';
      slot.error = t('form.uploadFailed');
    }
    renderPhotos();
  }

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
    // CAP-114: the ticked AI notes are appended to the notes typed in the form.
    const merged = notesTick.checked ? mergedNotes() : null;
    const result = validate(merged ? { ...values, notes: merged.text } : values, images, status);
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
        const changes = patchBody(cap, result.input);
        // A replaced photo patches its side's hash with it (CAP-93); untouched photos send none.
        const patch = changes === null ? null : { ...changes, ...pickedFields(picked, images) };
        if (patch === null) {
          releasePreviews();
          return ctx.navigate(pathFor('capDetail', { id: cap.capId }));
        }
        // An accepted AI suggestion makes the AI the author of the change (architect rule, CAP-42).
        if (
          options.ai?.suggestions.some((s) => s.field in patch && values[s.field] === s.value) ||
          (options.ai && merged && 'notes' in patch)
        ) {
          patch.source = options.ai.source;
        }
        saved = await ctx.api.request(`/caps/${encodeURIComponent(cap.capId)}`, {
          method: 'PATCH',
          body: patch,
          schema: Cap,
        });
      } else {
        // CAP-53 (physical-link.md § Keeping them in sync): no pre-assigned pocket → propose the album's next free one.
        let placeIn = location;
        // A batch saved without "Propose next free pocket": no location, no proposal (§ Initial layout later).
        const unplacedBatch = scan?.batch !== undefined && !scan.batch.placeAsYouGo;
        if (!placeIn && !unplacedBatch) {
          const proposal = await proposeLocation(ctx, el);
          if (proposal === null) return;
          placeIn = proposal.location ?? null;
        }
        const body = {
          ...result.input,
          ...(scan ? scanFields(scan, images) : {}),
          ...pickedFields(picked, images),
          ...(mode === 'ai-prefilled' && scan ? reviewProvenance(scan) : {}),
          ...extra,
          ...(placeIn ? { location: wireLocation(placeIn) } : {}),
        };
        saved = await ctx.api.request('/caps', { method: 'POST', body, schema: Cap });
      }
      // CAP-100: the device's last place used (the web's `acquiredWhere` default).
      if (saved.acquiredWhere) await rememberPlace(ctx.platform.store, saved.acquiredWhere);
      // An external AI's answer (CAP-45): its pending request is now reviewed.
      if (scan?.exchange) await markReviewed(ctx.api, scan);
      await options.onSaved?.(saved);
      invalidateCollection(ctx);
      releasePreviews();
      const resolution = mode === 'ai-prefilled' || extra?.variantOf !== undefined ? 'saved' : 'manual';
      if (!(await finishBatchItem(ctx, scan, resolution, saved.location === undefined))) {
        if (scan) ctx.capture.clear();
        ctx.navigate(pathFor('capDetail', { id: saved.capId }));
      }
      showToast(t('form.saved'));
    } catch (error) {
      // A 409 is the pocket taken meanwhile (CAP-50): its `errors[]` names a cap id, not a form field.
      serverErrors = isOccupied(error)
        ? { form: t('form.conflict') }
        : error instanceof ProblemError && error.problem.errors?.length
          ? problemErrors(error.problem)
          : { form: t('form.saveFailed') };
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
        if (value !== '') marks.delete(field as AiField);
      }
      // CAP-98: the AI's new answer may leave material / closure / year empty again: the same defaults as at the start
      // (CAP-124 `newCapDefaults`) for the fields the user has not touched; `type` is re-guessed below.
      const kept = (name: 'material' | 'closure' | 'year') => touched.has(name) || values[name] !== '';
      const again = newCapDefaults(
        {
          ...(kept('material') ? { material: values.material as Material } : {}),
          ...(kept('closure') ? { closure: values.closure as Closure } : {}),
          ...(kept('year') ? { year: Number(values.year) } : {}),
          type: 'other',
          acquiredOn: values.acquiredOn,
        },
        { now: clockOf(ctx), text: '' },
      );
      for (const name of ['material', 'closure', 'year'] as const) {
        const value = again.values[name];
        if (value === undefined) continue;
        setValue(name, String(value));
        marks.set(name, 'default');
      }
      if (!touched.has('type')) reguess();
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

  /** Underside photo for this scan: camera (or picker) → crop check (CAP-92) → upload → Ask again with both. */
  async function addUnderside(): Promise<void> {
    if (!scan || asking) return;
    let photo: CapPhoto | null;
    try {
      const file = await takeFile(ctx.platform.kind === 'native' ? 'camera' : 'library');
      photo =
        file === null
          ? null
          : await CropCheckSheet(el, {
              ...options.check,
              file,
              side: 'underside',
              retake: () => takeFile(ctx.platform.kind === 'native' ? 'camera' : 'library'),
            });
    } catch {
      return sayAi('form.photoFailed');
    }
    if (photo === null) return;
    asking = true;
    updateAiButtons();
    try {
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
  // "Export for external AI" (SCREENS.md #3 / #5, exchange.md § Flow step 1): this scan, on the Exchange screen (CAP-45).
  const exportLink =
    scan?.top?.ref && !scan.exchange
      ? h(
          'a',
          {
            class: 'button button--secondary button--small',
            attrs: { href: exchangePath({ scanId: scan.scanId }), 'data-link': true, 'data-action': 'export' },
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
          if (scan?.batch) {
            // A batch item: Cancel discards it (after confirming unsaved changes) and opens the next one.
            e.preventDefault();
            void (async () => {
              const sure =
                !dirty() ||
                (await ConfirmSheet(el, {
                  message: t('form.discardConfirm'),
                  confirm: t('form.discard'),
                  cancel: t('form.keepEditing'),
                  danger: true,
                }));
              if (!sure) return;
              releasePreviews();
              await finishBatchItem(ctx, scan, 'discarded', false);
            })();
            return;
          }
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
          void save(cap ? editStatus(cap) : toVerify() ? 'needsReview' : 'complete');
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
    mode === 'empty' &&
      exportLink &&
      h('section', { class: 'form-section ai-actions' }, h('div', { class: 'ai-buttons' }, exportLink)),
    h('section', { class: 'form-section' }, photoBox),
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
      field('notes', textArea('notes'), aiNotesBox),
      h(
        'div',
        { class: 'field-row' },
        field('quantity', textInput('quantity', { inputmode: 'numeric', pattern: '[0-9]*' })),
        field('forTrade', textInput('forTrade', { inputmode: 'numeric', pattern: '[0-9]*' })),
      ),
    ),
    location &&
      h(
        'p',
        { class: 'muted form-pocket', attrs: { 'data-pocket': formatLocationCode(location) } },
        t('form.goesTo', { code: formatLocationCode(location) }),
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
    scan?.batch && BatchStrip(ctx, scan.batch.index),
    form,
  );
  renderPhotos();
  renderHints();
  renderNotesFit();
  // CAP-100: the place default arrives after the form opens; typing first wins. Started after the first render, and
  // on a microtask, so a test API or platform that rejects synchronously only loses the default.
  if (mode !== 'edit' && values.acquiredWhere === '') {
    void Promise.resolve()
      .then(() => defaultPlace(ctx, scan?.batch?.batchId))
      .then((place) => {
        if (!place || touched.has('acquiredWhere') || values.acquiredWhere !== '') return;
        values.acquiredWhere = place;
        initialValues.acquiredWhere = place;
        const control = controls.get('acquiredWhere');
        if (control) control.value = place;
        marks.set('acquiredWhere', 'default');
        renderHints();
      })
      .catch(() => undefined);
  }
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
  if (!scan) {
    // "Enter manually" from a scan pre-assigned to a pocket (CAP-52): the empty form, saved into that pocket.
    const location = pocketLocation(route.query.pocket);
    return CapForm(ctx, { mode: 'empty', ...(location ? { location } : {}) });
  }
  // "It's a variant" from Already in collection (CAP-42): only for the cap this scan matched.
  const variantOf = route.query.variantOf;
  if (variantOf === undefined || scan.response?.match?.capId !== variantOf)
    return CapForm(ctx, { mode: 'empty', scan });
  const fields = scan.response.fields ?? {};
  const notes = scan.exchange?.notes;
  return CapForm(ctx, {
    mode: 'empty',
    scan,
    prefill: valuesFromFields(fields),
    ...(notes !== undefined ? { notes } : {}),
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
  const notes = scan?.exchange?.notes;
  if (scan) return CapForm(ctx, { mode: 'ai-prefilled', scan, ...(notes !== undefined ? { notes } : {}) });
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
