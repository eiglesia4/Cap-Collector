// `capcollector.exchange` v1 — the photo + JSON bundle for any external AI, and what comes back (ADR-007,
// exchange.md). The `response` object is also the shape Bedrock must return (ADR-006 of EP-06). Owned by the architect.
import { z } from 'zod';

import { CapFields } from './cap.js';
import {
  CapType,
  Closure,
  Confidence,
  CountryCode,
  DHash,
  Instant,
  Material,
  type UiLanguage,
  Ulid,
  Year,
} from './enums.js';

export const EXCHANGE_FORMAT = 'capcollector.exchange' as const;
/** Every version ever emitted must stay accepted by `parseExchangeUpload` (CONVENTIONS.md § Identifiers). */
export const EXCHANGE_VERSIONS = [1] as const;
export const EXCHANGE_CURRENT_VERSION = 1 as const;

/** Text handed to the external model; the app copies it verbatim into `request.json` (exchange.md). */
const LANGUAGE_NAME: Record<UiLanguage, string> = { es: 'Spanish', en: 'English' };

/**
 * Instructions for the vision model, Bedrock and external alike (ADR-007, ADR-008 §7). v0.4 (CAP-95, decided with the owner
 * on 2026-11-23): best guesses with a low confidence instead of null, `type` inferred from the producer, the usual
 * crown-cap material/closure, never a guessed `year`, and `description` written in the user's language. v0.5 (CAP-107):
 * brand, variant, producer and textOnCap are never translated; enum fields take the listed codes.
 */
export function exchangeInstructions(language: UiLanguage = 'en'): string {
  return (
    'You are helping identify a bottle cap. Look at the attached photo(s). Fill the `response` object below and give ' +
    `a confidence 0–1 per field. ${fieldRules(language)} Return ONLY the JSON of \`response\`.`
  );
}

/** The field rules shared by the single-cap and the multi-import prompts (v0.4/v0.5 rules; v0.6 split them out). */
function fieldRules(language: UiLanguage): string {
  return (
    'Give your best guess for every field you can reasonably infer: a low confidence is better than null. Infer `type` ' +
    'from the brand, producer or text (a brewery → beer, a cider maker → cider, a winery → wine). Crown caps are ' +
    'usually steel and pry-off unless the photo shows otherwise. Use null only when there is no basis at all, and for ' +
    '`year` unless a year is printed or the design clearly dates it. Keep brand, variant and textOnCap exactly as ' +
    'printed, and producer as the company names itself; never translate them. The enum fields take the codes listed ' +
    'in the schema. Country is ISO 3166-1 alpha-2. Write `description` in ' +
    `${LANGUAGE_NAME[language]}.`
  );
}

/**
 * v0.6 (CAP-119, ADR-012, decided with the owner on 2026-11-28): the prompt for a multi-import. One tray photo in; a
 * zip of cut-out caps (about 2 mm of transparent margin), each with a `response` JSON of the same base name, out. The
 * app shows it with `MULTI_IMPORT_TEMPLATE` and the photo-format card (SCREENS.md § Multi-import).
 */
export function multiImportInstructions(language: UiLanguage = 'en'): string {
  const { maxCaps } = MULTI_IMPORT_LIMITS;
  return (
    'You are helping catalogue bottle caps. The attached photo shows several caps. For every cap in the photo:\n' +
    '1. Cut it out into its own image file: one cap per file, square, the cap centred, with a margin of about 2 mm ' +
    "(about 7 % of the cap's diameter) of transparent background all round the rim. Remove the background and the " +
    "cap's shadow, and don't cut into the rim. PNG or WebP, at least 400 px across, never upscaled.\n" +
    '2. Name the file `<brand>_<variant>` as printed: spaces become hyphens, ASCII letters, digits and hyphens only ' +
    '(drop accents). Use `Unknown` when no brand can be read, leave out `_<variant>` when there is none, and add ' +
    '`-2`, `-3`… when two names would clash.\n' +
    '3. Fill a copy of the empty `response` template below for that cap and save it as a JSON file with the same name ' +
    `(\`<name>.json\`). Give a confidence 0–1 for brand, variant and year. ${fieldRules(language)} Set \`provider\` ` +
    'and `model` to who you are. Put anything worth knowing that fits no field in `notes`, in English.\n' +
    `Return ONE zip file with all the image and JSON pairs and nothing else (at most ${maxCaps} caps). Don't add ` +
    'fields to the template, and use the same `response` shape for every cap.'
  );
}

/** v0.6 (ADR-012 §5): what one multi-import zip may hold; over a limit it is rejected before any image is decoded. */
export const MULTI_IMPORT_LIMITS = { maxCaps: 50, maxZipBytes: 50 * 1024 * 1024 } as const;

/** v0.6 (ADR-012 §4): the empty `response` the owner pastes next to the prompt. No `requestId`, no `known`. */
export const MULTI_IMPORT_TEMPLATE: ExchangeResponse = {
  provider: null,
  model: null,
  fields: {
    brand: null,
    variant: null,
    producer: null,
    country: null,
    type: null,
    material: null,
    closure: null,
    year: null,
    description: null,
    textOnCap: null,
  },
  confidence: { brand: null, variant: null, year: null },
  notes: null,
};

/** The English instructions (pre-v0.4 callers and exchange bundles without a language). */
export const EXCHANGE_INSTRUCTIONS = exchangeInstructions('en');

/** Human-readable field schema sent to the model (strings, not zod), kept in step with `ResponseFields`. */
export const EXCHANGE_FIELD_SCHEMA = {
  brand: 'string',
  variant: 'string|null',
  producer: 'string|null',
  country: 'ISO 3166-1 alpha-2|null',
  type: CapType.options.join('|') + '|null',
  material: Material.options.join('|') + '|null',
  closure: Closure.options.join('|') + '|null',
  year: 'integer|null',
  description: 'string|null',
  textOnCap: 'string|null',
} as const;

export const ExchangePhoto = z.object({
  file: z.string().min(1),
  side: z.enum(['top', 'underside']),
  dhash: DHash,
});

/**
 * What the model fills: every field nullable (it was told to use null when unsure). Loose on purpose: unknown
 * keys survive parsing so `normaliseResponseFields` can report them as `ignored` (exchange.md § Upload answer).
 */
export const ResponseFields = z.looseObject({
  brand: z.string().nullable(),
  variant: z.string().nullable(),
  producer: z.string().nullable(),
  country: z.string().nullable(),
  type: z.string().nullable(),
  material: z.string().nullable(),
  closure: z.string().nullable(),
  year: z.union([z.number().int(), z.string()]).nullable(),
  description: z.string().nullable(),
  textOnCap: z.string().nullable(),
});
export type ResponseFields = z.infer<typeof ResponseFields>;

export const ExchangeResponse = z.object({
  provider: z.string().nullable(),
  model: z.string().nullable(),
  fields: ResponseFields.partial(),
  confidence: z.record(z.string(), Confidence.nullable()).default({}),
  notes: z.string().nullable().default(null),
});
export type ExchangeResponse = z.infer<typeof ExchangeResponse>;

/** Empty response the app writes into `request.json`. */
export function emptyExchangeResponse(): ExchangeResponse {
  const fields = Object.fromEntries(Object.keys(ResponseFields.shape).map((k) => [k, null])) as ResponseFields;
  return { provider: null, model: null, fields, confidence: { brand: null, variant: null, year: null }, notes: null };
}

/** The whole `request.json` document, v1 (exchange.md § request.json). */
export const ExchangeDocumentV1 = z.object({
  format: z.literal(EXCHANGE_FORMAT),
  version: z.literal(1),
  kind: z.literal('request'),
  requestId: Ulid,
  createdAt: Instant,
  /** Cap being re-identified, absent for a new scan. */
  capId: Ulid.optional(),
  scanId: Ulid.optional(),
  photos: z.array(ExchangePhoto).min(1).max(2),
  instructions: z.string().min(1),
  schema: z.record(z.string(), z.string()),
  known: CapFields.partial().default({}),
  response: ExchangeResponse,
});
export type ExchangeDocument = z.infer<typeof ExchangeDocumentV1>;

/** Batch request (`requests.json`): one document per cap. */
export const ExchangeBatchV1 = z.array(ExchangeDocumentV1).min(1);

/** Lifecycle of a downloaded request (`EXCHANGE#<requestId>`), 30-day TTL. */
export const ExchangeStatus = z.enum(['waiting', 'answered', 'reviewed', 'expired']);
export const ExchangeRequestItem = z.object({
  requestId: Ulid,
  createdAt: Instant,
  status: ExchangeStatus,
  capId: Ulid.optional(),
  scanId: Ulid.optional(),
  dhash: DHash,
  answeredAt: Instant.optional(),
  provider: z.string().optional(),
  ttl: z.number().int().optional(),
});
export type ExchangeRequestItem = z.infer<typeof ExchangeRequestItem>;

/** What the upload parser accepts: the full document with `response` filled, the bare `response`, or a batch. */
export type ExchangeUpload =
  | { kind: 'document'; document: ExchangeDocument }
  | { kind: 'response'; response: ExchangeResponse }
  | { kind: 'batch'; documents: ExchangeDocument[] };

/**
 * Parses an uploaded JSON value. Rejects unknown `format` or `version` explicitly (never silently) and
 * accepts every version in `EXCHANGE_VERSIONS`.
 */
export function parseExchangeUpload(value: unknown): ExchangeUpload {
  if (Array.isArray(value)) {
    return { kind: 'batch', documents: ExchangeBatchV1.parse(value) };
  }
  if (typeof value === 'object' && value !== null && 'format' in value) {
    const v = value as { format?: unknown; version?: unknown };
    if (v.format !== EXCHANGE_FORMAT) throw new Error(`unknown exchange format: ${String(v.format)}`);
    if (!EXCHANGE_VERSIONS.includes(v.version as 1))
      throw new Error(`unsupported exchange version: ${String(v.version)}`);
    return { kind: 'document', document: ExchangeDocumentV1.parse(value) };
  }
  return { kind: 'response', response: ExchangeResponse.parse(value) };
}

const COUNTRY_NAMES: Record<string, string> = {
  spain: 'ES',
  españa: 'ES',
  germany: 'DE',
  deutschland: 'DE',
  france: 'FR',
  italy: 'IT',
  italia: 'IT',
  portugal: 'PT',
  netherlands: 'NL',
  holland: 'NL',
  belgium: 'BE',
  'united kingdom': 'GB',
  uk: 'GB',
  england: 'GB',
  ireland: 'IE',
  'czech republic': 'CZ',
  czechia: 'CZ',
  austria: 'AT',
  poland: 'PL',
  denmark: 'DK',
  sweden: 'SE',
  norway: 'NO',
  finland: 'FI',
  'united states': 'US',
  usa: 'US',
  mexico: 'MX',
  méxico: 'MX',
  japan: 'JP',
  china: 'CN',
  brazil: 'BR',
  brasil: 'BR',
  argentina: 'AR',
  australia: 'AU',
  canada: 'CA',
  india: 'IN',
};

const MATERIAL_ALIASES: Record<string, string> = {
  aluminum: 'aluminium',
  alu: 'aluminium',
  tin: 'steel',
  metal: 'steel',
  tinplate: 'steel',
};
const CLOSURE_ALIASES: Record<string, string> = {
  'pry off': 'pry-off',
  pryoff: 'pry-off',
  crown: 'pry-off',
  'twist off': 'twist-off',
  twistoff: 'twist-off',
  'twist-of': 'twist-off',
};
const TYPE_ALIASES: Record<string, string> = {
  soda: 'soft drink',
  softdrink: 'soft drink',
  'soft-drink': 'soft drink',
  lager: 'beer',
  ale: 'beer',
  'mineral water': 'water',
  sidra: 'cider',
  vino: 'wine',
};

export const PartialCapFields = CapFields.partial();
export type PartialCapFields = z.infer<typeof PartialCapFields>;

export type Normalised = { fields: PartialCapFields; ignored: string[]; problems: string[] };

/**
 * Turns a model's loose answer into `CapFields` (exchange.md § Upload answer): trims, maps country names
 * to ISO codes and enum aliases to the contract values, drops nulls, reports unknown keys as `ignored`
 * and unparseable values as `problems` (the UI appends ignored/problem values to notes).
 */
export function normaliseResponseFields(raw: Record<string, unknown>): Normalised {
  const fields: Record<string, unknown> = {};
  const ignored: string[] = [];
  const problems: string[] = [];
  const known = new Set(Object.keys(ResponseFields.shape));
  for (const [k, v] of Object.entries(raw)) {
    if (!known.has(k)) {
      ignored.push(k);
      continue;
    }
    if (v === null || v === undefined || v === '') continue;
    const s = typeof v === 'string' ? v.trim() : v;
    switch (k) {
      case 'country': {
        const str = String(s);
        const code = /^[A-Za-z]{2}$/.test(str) ? str.toUpperCase() : COUNTRY_NAMES[str.toLowerCase()];
        if (code) fields.country = code;
        else problems.push(`country: ${str}`);
        break;
      }
      case 'material':
        fields.material = MATERIAL_ALIASES[String(s).toLowerCase()] ?? String(s).toLowerCase();
        break;
      case 'closure':
        fields.closure = CLOSURE_ALIASES[String(s).toLowerCase()] ?? String(s).toLowerCase();
        break;
      case 'type':
        fields.type = TYPE_ALIASES[String(s).toLowerCase()] ?? String(s).toLowerCase();
        break;
      case 'year': {
        const n = typeof s === 'number' ? s : Number.parseInt(String(s).replace(/[^0-9]/g, ''), 10);
        if (Number.isInteger(n) && Year.safeParse(n).success) fields.year = n;
        else problems.push(`year: ${String(v)}`);
        break;
      }
      default:
        fields[k] = s;
    }
  }
  const parsed = PartialCapFields.safeParse(fields);
  if (parsed.success) return { fields: parsed.data, ignored, problems };
  // Drop the offending keys one by one so the rest still reaches the review form.
  for (const issue of parsed.error.issues) {
    const key = String(issue.path[0]);
    problems.push(`${key}: ${String(fields[key])}`);
    delete fields[key];
  }
  return { fields: PartialCapFields.parse(fields), ignored, problems };
}

export { CountryCode };
