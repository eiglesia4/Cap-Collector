// AI review rules (CAP-43; SCREENS.md #3; ADR-003 §1 pre-filled form with unsure fields highlighted, third mode of the
// one form; shared `AnalyseResponse` / `CapInput`): which fields are "unsure", what "Ask again" sends as `known`, which
// fields its answer may re-fill, the provenance a save from the review carries, and the re-identify request built
// from a stored cap. DOM-free so every rule tests directly.
import { CapFields, type AnalyseRequest, type AnalyseResponse, type Cap } from '@capcollector/shared';

import { valuesFromFields, type FormValues } from '../cap/form-model.js';
import type { CaptureSession } from './context.js';
import { scanSource } from './duplicate.js';

/** Below this confidence (or with none) a pre-filled field is highlighted as unsure (story CAP-43). */
export const UNSURE_BELOW = 0.7;

/** The form fields an AI fills (`CapFields` minus `textOnCap`, which the form has no input for), in form order. */
export const AI_FIELDS = [
  'brand',
  'variant',
  'producer',
  'country',
  'type',
  'material',
  'closure',
  'year',
  'description',
] as const satisfies readonly (keyof FormValues & keyof CapFields)[];
export type AiField = (typeof AI_FIELDS)[number];

export function isAiField(name: string): name is AiField {
  return (AI_FIELDS as readonly string[]).includes(name);
}

/** Unsure fields with their confidence (`undefined` = the model gave none). */
export function unsureFields(confidence: AnalyseResponse['confidence']): Map<AiField, number | undefined> {
  const out = new Map<AiField, number | undefined>();
  for (const field of AI_FIELDS) {
    const c = confidence?.[field];
    if (c === undefined || c < UNSURE_BELOW) out.set(field, c);
  }
  return out;
}

/**
 * "Ask again" `known`: the AI fields the user has edited, as valid `CapFields` values (so the model does not
 * contradict them). Emptied or still-invalid inputs are left out.
 */
export function knownFromValues(values: FormValues, edited: ReadonlySet<string>): Partial<CapFields> {
  const known: Record<string, unknown> = {};
  for (const field of AI_FIELDS) {
    if (!edited.has(field)) continue;
    const raw = values[field].trim();
    if (raw === '') continue;
    const value = field === 'year' ? (/^\d+$/.test(raw) ? Number(raw) : Number.NaN) : raw;
    if (CapFields.shape[field].safeParse(value).success) known[field] = value;
  }
  return known as Partial<CapFields>;
}

/** The new answer's values for every AI field the user has not edited; edited ones are kept as typed. */
export function refill(
  values: FormValues,
  edited: ReadonlySet<string>,
  fields: AnalyseResponse['fields'],
): Partial<Pick<FormValues, AiField>> {
  const next = valuesFromFields(fields ?? {});
  const out: Partial<Pick<FormValues, AiField>> = {};
  for (const field of AI_FIELDS) {
    if (edited.has(field) || next[field] === values[field]) continue;
    out[field] = next[field];
  }
  return out;
}

/**
 * Provenance of a cap saved from the AI review: `source = bedrock:<aiModel>` (the story's `source: 'ai'` is not a valid
 * shared `Source`; architect rule from CAP-42) and `aiConfidence` = the brand's confidence.
 */
export function reviewProvenance(session: CaptureSession): { source: string; aiConfidence?: number } {
  const brand = session.response?.confidence?.brand;
  return { source: scanSource(session), ...(brand !== undefined ? { aiConfidence: brand } : {}) };
}

/** The open scan context of an `identified` outcome, or null (reload, other outcome). */
export function reviewScan(session: CaptureSession | null): CaptureSession | null {
  if (!session?.top?.ref || session.response?.outcome !== 'identified' || !session.response.fields) return null;
  return session;
}

/** What a stored cap already has, as `known` for re-identify. */
export function knownFromCap(cap: Cap): Partial<CapFields> {
  const known: Record<string, unknown> = {};
  for (const field of [...AI_FIELDS, 'textOnCap'] as const) {
    if (cap[field] !== undefined) known[field] = cap[field];
  }
  return known as Partial<CapFields>;
}

/** `POST /scans/analyse` for re-identifying a stored cap: its own images (no upload), `capId`, `known`, AI on. */
export function reidentifyBody(cap: Cap, scanId: string, dhash: string): AnalyseRequest {
  const body: AnalyseRequest = {
    scanId,
    dhash,
    imageKeys: { top: cap.images.top.key },
    known: knownFromCap(cap),
    capId: cap.capId,
    useAi: true,
  };
  if (cap.images.underside) {
    body.imageKeys.underside = cap.images.underside.key;
    if (cap.dhashUnderside !== undefined) body.dhashUnderside = cap.dhashUnderside;
  }
  return body;
}

export interface Suggestion {
  readonly field: AiField;
  /** The suggested value as the form input holds it. */
  readonly value: string;
}

/** "AI suggests: X" for each AI field whose suggestion differs from the stored cap's value. */
export function suggestionsFor(cap: Cap, fields: AnalyseResponse['fields']): Suggestion[] {
  if (!fields) return [];
  const next = valuesFromFields(fields);
  const out: Suggestion[] = [];
  for (const field of AI_FIELDS) {
    const value = next[field];
    if (value === '' || fields[field] === cap[field]) continue;
    out.push({ field, value });
  }
  return out;
}
