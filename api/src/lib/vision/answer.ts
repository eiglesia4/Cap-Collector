// From a vision model's text answer to an `IdentifyResult` (CAP-39). The answer takes THE SAME path as an exchange
// upload (ADR-007, ADR-008 §7): `parseExchangeUpload` on the bare `response` → `normaliseResponseFields`, so Bedrock,
// the fake adapter and an external AI are read by one parser. Outcome rule (CAP-39): brand missing or its confidence
// below 0.4 → `unidentified` with up to 5 brand-like suggestions from `textOnCap`; otherwise `identified`.
import {
  type ExchangeResponse,
  type Normalised,
  normaliseResponseFields,
  parseExchangeUpload,
} from '@capcollector/shared';

import type { IdentifyResult, VisionUsage } from './adapter.js';

/** Below this brand confidence the cap counts as not identified (CAP-39). */
export const MIN_BRAND_CONFIDENCE = 0.4;
export const MAX_SUGGESTIONS = 5;

export type ParsedAnswer =
  { ok: true; response: ExchangeResponse; normalised: Normalised } | { ok: false; problem: string };

/** Removes a Markdown code fence (```json … ```) the model may have wrapped the JSON in. */
export function stripFences(text: string): string {
  const t = text.trim();
  const m = /^```[a-zA-Z0-9_-]*\s*\n?([\s\S]*?)\n?\s*```$/.exec(t);
  return (m ? m[1]! : t).trim();
}

/**
 * Parses the model's text. The bare `response` is what the prompt asks for; a full `request.json` document is
 * accepted too (its `response` is used). `provider` / `model` are filled with null when the model left them out:
 * they are bookkeeping, not identification. Problems never quote the answer text (it may echo the prompt).
 */
export function parseAnswer(text: string): ParsedAnswer {
  let json: unknown;
  try {
    json = JSON.parse(stripFences(text));
  } catch {
    return { ok: false, problem: 'answer is not JSON' };
  }
  if (Array.isArray(json)) return { ok: false, problem: 'answer is a batch, expected one response' };
  if (typeof json !== 'object' || json === null) return { ok: false, problem: 'answer is not a JSON object' };
  // SPEC-GAP CAP-39: shared `ExchangeResponse` requires `provider` / `model` (nullable); a model that omits them would
  // otherwise fail the whole answer, so they default to null before the shared parser runs.
  const value = 'format' in json ? json : { provider: null, model: null, ...json };
  try {
    const upload = parseExchangeUpload(value);
    // Arrays never reach here, so the upload is a document or a bare response.
    const response =
      upload.kind === 'document' ? upload.document.response : (upload as { response: ExchangeResponse }).response;
    return { ok: true, response, normalised: normaliseResponseFields(response.fields) };
  } catch (e) {
    const paths =
      e && typeof e === 'object' && 'issues' in e && Array.isArray(e.issues)
        ? (e.issues as { path: PropertyKey[] }[]).map((i) => i.path.join('.') || '(root)').join(', ')
        : 'unknown format or version';
    return { ok: false, problem: `answer does not match the response schema: ${paths}` };
  }
}

/**
 * Up to 5 distinct brand-like tokens from the text on the cap, in reading order: words of 3+ characters with at least
 * one letter (pure numbers, "1906", are years or volumes, not brands); case-insensitive dedupe, original casing kept.
 */
export function suggestionsFrom(textOnCap: string | null | undefined): string[] {
  if (!textOnCap) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const token of textOnCap.split(/[^\p{L}\p{N}'&-]+/u)) {
    const t = token.replace(/^['&-]+|['&-]+$/g, '');
    if (t.length < 3 || !/\p{L}/u.test(t) || seen.has(t.toLowerCase())) continue;
    seen.add(t.toLowerCase());
    out.push(t);
    if (out.length === MAX_SUGGESTIONS) break;
  }
  return out;
}

/** Non-null confidences of response fields only (the shared `FieldConfidence` keys are `CapFields` names). */
function fieldConfidence(response: ExchangeResponse): Record<string, number> {
  return Object.fromEntries(
    Object.entries(response.confidence).filter(
      (e): e is [string, number] => typeof e[1] === 'number' && e[0] !== 'provider' && e[0] !== 'model',
    ),
  );
}

export type AnswerResult = Exclude<IdentifyResult, { status: 'unavailable' }>;

/** Maps a parsed answer onto CAP-37's pipeline (step 3, the brand re-check, runs afterwards unchanged). */
export function toResult(parsed: ParsedAnswer, aiModel: string, usage?: VisionUsage): AnswerResult {
  const extra = usage ? { usage } : {};
  if (!parsed.ok) {
    return { status: 'unidentified', aiModel, suggestions: [], aiConfidence: 0, problems: [parsed.problem], ...extra };
  }
  const { response, normalised } = parsed;
  const { fields, ignored, problems } = normalised;
  const confidence = fieldConfidence(response);
  const aiConfidence = fields.brand ? (confidence.brand ?? 0) : 0;
  // SPEC-GAP CAP-39: shared `AnalyseResponse` has no `ignored` / `problems`; the adapter returns them and Bedrock logs
  // them at warn, but they do not reach the client (the exchange upload path shows them in notes instead).
  const notes = { ignored, problems };
  if (!fields.brand || aiConfidence < MIN_BRAND_CONFIDENCE) {
    const text = fields.textOnCap ?? (typeof response.fields.textOnCap === 'string' ? response.fields.textOnCap : null);
    return { status: 'unidentified', aiModel, suggestions: suggestionsFrom(text), aiConfidence, ...notes, ...extra };
  }
  return {
    status: 'identified',
    aiModel,
    fields: { ...fields, brand: fields.brand },
    confidence,
    aiConfidence,
    ...notes,
    ...extra,
  };
}
