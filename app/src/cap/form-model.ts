// State and rules of the cap form (CAP-25, ADR-003 modes `empty | edit`), kept free of DOM so they test directly:
// raw input values ↔ the shared `CapInput` (validated with the contract's own zod schema, issues mapped to inline
// messages), the `POST /caps` body, and the `PATCH /caps/{id}` body holding only the fields that changed (`null`
// clears an optional field, openapi.yaml § PATCH).
import { CapInput, CapPatch, Year, type Cap, type CapStatus, type ImageRef, type Problem } from '@capcollector/shared';

import { t } from '../i18n/i18n.js';

/** What each input holds, as typed (strings; tags as chips). Order = SCREENS.md #5 field order (story CAP-25). */
export interface FormValues {
  brand: string;
  variant: string;
  producer: string;
  country: string;
  type: string;
  material: string;
  closure: string;
  year: string;
  description: string;
  condition: string;
  acquiredWhere: string;
  acquiredOn: string;
  tags: string[];
  notes: string;
  quantity: string;
  forTrade: string;
}

export type ValueField = keyof FormValues;
/** A place an error can be shown: an input, a photo slot, or the form as a whole. */
export type FieldName = ValueField | 'top' | 'underside' | 'form';
export type FormErrors = Partial<Record<FieldName, string>>;

export interface FormImages {
  top?: ImageRef;
  underside?: ImageRef;
}

export const FIELD_ORDER: readonly ValueField[] = [
  'brand',
  'variant',
  'producer',
  'country',
  'type',
  'material',
  'closure',
  'year',
  'description',
  'condition',
  'acquiredWhere',
  'acquiredOn',
  'tags',
  'notes',
  'quantity',
  'forTrade',
];

const TEXT_FIELDS = [
  'brand',
  'variant',
  'producer',
  'country',
  'type',
  'material',
  'closure',
  'description',
  'condition',
  'acquiredWhere',
  'acquiredOn',
  'notes',
] as const satisfies readonly ValueField[];
const NUMBER_FIELDS = ['year', 'quantity', 'forTrade'] as const satisfies readonly ValueField[];

/** Limits of the shared contract, read from it so the messages follow a contract change. */
export const YEAR_MIN = Year.minValue ?? 1850;
export const YEAR_MAX = Year.maxValue ?? 2100;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 30;

export const EMPTY_VALUES: Readonly<FormValues> = {
  brand: '',
  variant: '',
  producer: '',
  country: '',
  type: '',
  material: '',
  closure: '',
  year: '',
  description: '',
  condition: '',
  acquiredWhere: '',
  acquiredOn: '',
  tags: [],
  notes: '',
  quantity: '1',
  forTrade: '0',
};

export function valuesFromCap(cap: Cap): FormValues {
  const s = (v: string | number | undefined) => (v === undefined ? '' : String(v));
  return {
    brand: cap.brand,
    variant: s(cap.variant),
    producer: s(cap.producer),
    country: s(cap.country),
    type: s(cap.type),
    material: s(cap.material),
    closure: s(cap.closure),
    year: s(cap.year),
    description: s(cap.description),
    condition: s(cap.condition),
    acquiredWhere: s(cap.acquiredWhere),
    acquiredOn: s(cap.acquiredOn),
    tags: [...cap.tags],
    notes: s(cap.notes),
    quantity: String(cap.quantity),
    forTrade: String(cap.forTrade),
  };
}

export function sameValues(a: FormValues, b: FormValues): boolean {
  return FIELD_ORDER.every((k) => {
    const x = a[k];
    const y = b[k];
    return Array.isArray(x) && Array.isArray(y) ? x.length === y.length && x.every((v, i) => v === y[i]) : x === y;
  });
}

/** The images of a loaded cap as form state. */
export function imagesFromCap(images: Cap['images']): FormImages {
  return images.underside ? { top: images.top, underside: images.underside } : { top: images.top };
}

export function sameImages(a: FormImages, b: FormImages): boolean {
  return a.top?.key === b.top?.key && a.underside?.key === b.underside?.key;
}

/** Digits only → number; empty → undefined (or NaN when the field is required); anything else → NaN (rejected). */
function toNumber(raw: string, required: boolean): number | undefined {
  const s = raw.trim();
  if (s === '') return required ? Number.NaN : undefined;
  return /^\d+$/.test(s) ? Number(s) : Number.NaN;
}

/** The form as a `CapInput` candidate (unvalidated): empty inputs are left out, numbers parsed. */
export function candidate(values: FormValues, images: FormImages, status: CapStatus): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of TEXT_FIELDS) {
    const v = values[k].trim();
    if (v !== '') out[k] = v;
  }
  for (const k of NUMBER_FIELDS) {
    const n = toNumber(values[k], k !== 'year');
    if (n !== undefined) out[k] = n;
  }
  out.tags = values.tags;
  const imgs: Record<string, ImageRef> = {};
  if (images.top) imgs.top = images.top;
  if (images.underside) imgs.underside = images.underside;
  out.images = imgs;
  out.source = 'manual';
  out.status = status;
  return out;
}

interface Issue {
  readonly code: string;
  readonly path: readonly PropertyKey[];
  readonly maximum?: unknown;
}

function fieldOf(path: readonly PropertyKey[]): FieldName {
  const [first, second] = path;
  if (first === 'images') return second === 'underside' ? 'underside' : 'top';
  return typeof first === 'string' && (FIELD_ORDER as readonly string[]).includes(first)
    ? (first as ValueField)
    : 'form';
}

/** Inline message for a contract issue on `field` (CAP-25: reuse CapInput's issues). */
export function messageFor(field: FieldName, issue: Issue): string {
  switch (field) {
    case 'brand':
      return issue.code === 'too_big'
        ? t('form.errorTooLong', { max: String(issue.maximum) })
        : t('form.errorBrandRequired');
    case 'year':
      return t('form.errorYear', { min: YEAR_MIN, max: YEAR_MAX });
    case 'quantity':
      return t('form.errorQuantity');
    case 'forTrade':
      return t('form.errorForTrade');
    case 'top':
      return t('form.errorTopPhoto');
    case 'acquiredOn':
      return t('form.errorDate');
    case 'tags':
      return t('form.errorTags', { max: MAX_TAGS, length: MAX_TAG_LENGTH });
    default:
      return issue.code === 'too_big' && typeof issue.maximum === 'number'
        ? t('form.errorTooLong', { max: issue.maximum })
        : t('form.errorInvalid');
  }
}

export type Validation = { ok: true; input: CapInput } | { ok: false; errors: FormErrors };

/**
 * Validate with the shared `CapInput` schema. `forTrade ≤ quantity` is a refinement of `Cap`, not of `CapInput`,
 * so it is checked here with the same rule and path.
 */
export function validate(values: FormValues, images: FormImages, status: CapStatus): Validation {
  const errors: FormErrors = {};
  const parsed = CapInput.safeParse(candidate(values, images, status));
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const field = fieldOf(issue.path);
      errors[field] ??= messageFor(field, issue);
    }
  }
  const quantity = toNumber(values.quantity, true);
  const forTrade = toNumber(values.forTrade, true);
  if (errors.forTrade === undefined && quantity !== undefined && forTrade !== undefined && forTrade > quantity) {
    errors.forTrade = t('form.errorForTrade');
  }
  if (parsed.success && Object.keys(errors).length === 0) return { ok: true, input: parsed.data };
  return { ok: false, errors };
}

/** Keys of `CapPatch` the form edits, each compared against the loaded cap. */
const PATCH_KEYS = [
  'brand',
  'variant',
  'producer',
  'country',
  'type',
  'material',
  'closure',
  'year',
  'description',
  'condition',
  'acquiredWhere',
  'acquiredOn',
  'notes',
  'quantity',
  'forTrade',
] as const;

function sameImageSet(a: Cap['images'], b: Cap['images']): boolean {
  return a.top.key === b.top.key && a.underside?.key === b.underside?.key;
}

/**
 * `PATCH` body with only what differs from `cap` (story CAP-25: never send unchanged fields); `null` clears a field
 * the user emptied. Null when nothing changed. `source: manual` names the author of the change (CAP-18).
 */
export function patchBody(cap: Cap, input: CapInput): CapPatch | null {
  const patch: Record<string, unknown> = {};
  for (const k of PATCH_KEYS) {
    const before = cap[k];
    const after = input[k];
    if (before !== after) patch[k] = after ?? null;
  }
  if (cap.tags.length !== input.tags.length || cap.tags.some((tag, i) => tag !== input.tags[i])) {
    patch.tags = input.tags;
  }
  if (!sameImageSet(cap.images, input.images)) patch.images = input.images;
  if (input.status !== undefined && input.status !== cap.status) patch.status = input.status;
  if (Object.keys(patch).length === 0) return null;
  patch.source = 'manual';
  const checked = CapPatch.safeParse(patch);
  if (!checked.success) throw new Error(`patch does not match CapPatch: ${checked.error.message}`);
  // CapPatch fills no defaults (v0.2), so the parsed body has exactly the keys built above.
  return checked.data;
}

/**
 * `Problem.errors[]` of a 422 (CAP-17: `path` like `brand`, `/forTrade` or `images.top`) placed next to the fields;
 * a path the form does not show lands on `form`.
 */
export function problemErrors(problem: Problem): FormErrors {
  const errors: FormErrors = {};
  for (const e of problem.errors ?? []) {
    const path = (e.path ?? '').replace(/^\//, '').split(/[./]/);
    const field = fieldOf(path);
    const message = e.message ?? t('form.errorInvalid');
    errors[field] = errors[field] === undefined ? message : `${errors[field]} ${message}`;
  }
  return errors;
}
