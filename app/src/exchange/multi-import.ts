// Multi-import from an external AI (CAP-121; ADR-012; exchange.md § Multi-import): one zip (or loose files) of cut-out
// caps, each image paired with a JSON `response` by base name, every cap saved at once as `needsReview` after the
// duplicate checks — inside the zip (the batch guard of ADR-009), dHash against the collection (`POST /scans/analyse`
// with `useAi: false`: never Bedrock, ADR-004) and brand + variant (saved anyway, flagged). Nothing existing is
// changed. Pure orchestration over injected effects (API, upload, codec, clock, place), like capture/batch.ts.
//
// Order: the image of the next pair is prepared (decode → WebP ≤ 1024 → dHash) while the current one is checked and
// saved, so at most two pairs are in flight, but the checks and saves run one by one in zip order and the "repeated in
// zip" outcome never depends on timing (plan Q2).
import {
  AnalyseResponse,
  Cap,
  MULTI_IMPORT_LIMITS,
  normaliseBrand,
  normaliseResponseFields,
  parseExchangeUpload,
  type AnalyseRequest,
  type CapInput,
  type ExchangeResponse,
  type ImageRef,
  type PartialCapFields,
  type Source,
} from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import { BATCH_DHASH_GUARD } from '../capture/batch.js';
import { DEFAULT_CLOSURE, DEFAULT_MATERIAL, localDate } from '../capture/defaults.js';
import { CapPageSchema } from '../collection/cap-page.js';
import { language } from '../i18n/i18n.js';
import { dhash, hammingDistance } from '../images/dhash.js';
import {
  encodeWithin,
  fitWithin,
  inscribedSquare,
  WebpUnsupportedError,
  type CapPhoto,
  type Raster,
  type RasterCodec,
} from '../images/resize.js';
import { externalSource, notesFrom, providerId, type UploadContents } from './answer.js';

/** The images a pair may use (exchange.md § Multi-import: `.png`, `.webp`, `.jpg`, `.jpeg`). */
const PAIR_IMAGE = /\.(png|webp|jpe?g)$/i;
/** Caps fetched for the brand + variant check (`GET /caps?brand=`). */
export const BRAND_CHECK_LIMIT = 60;
/** Brand used when the AI gave none (the prompt's file name for such a cap). */
export const UNKNOWN_BRAND = 'Unknown';

/** Why a zip is refused before any image is decoded (ADR-012 §5). */
export type LimitProblem =
  { kind: 'tooBig'; bytes: number } | { kind: 'tooManyPairs'; pairs: number } | { kind: 'empty' };

/** Why a row failed. */
export type FailReason =
  | 'noJson'
  | 'noImage'
  | 'duplicateName'
  | 'invalidJson'
  | 'badImage'
  | 'uploadFailed'
  | 'checkFailed'
  | 'saveFailed'
  | 'cancelled';

export type RowStatus = 'pending' | 'imported' | 'inCollection' | 'repeated' | 'possibleDuplicate' | 'failed';

/** One file pair of the upload, and what became of it. */
export interface ImportRow {
  /** Base name as in the zip (e.g. `Grimbergen_Double-Ambree`). */
  readonly name: string;
  readonly image?: Blob;
  /** The parsed JSON value, or `invalid` when the JSON could not be read at all. */
  readonly json?: { readonly value: unknown } | 'invalid';
  status: RowStatus;
  reason?: FailReason;
  /** The detail of an invalid JSON (zod / format message). */
  detail?: string;
  /** The cap saved for this row. */
  capId?: string;
  /** The existing cap it matched (dHash: in collection; brand + variant: possible duplicate). */
  matchCapId?: string;
  /** "Brand · Variant" once the JSON is read. */
  title?: string;
  /** The prepared WebP (thumbnail and upload). */
  photo?: CapPhoto;
}

/** Total bytes of what was picked; the zip limit applies to loose files too. */
export function checkSize(files: readonly File[]): LimitProblem | null {
  const bytes = files.reduce((sum, f) => sum + f.size, 0);
  return bytes > MULTI_IMPORT_LIMITS.maxZipBytes ? { kind: 'tooBig', bytes } : null;
}

const baseOf = (name: string) => {
  const file = name.split('/').pop() ?? name;
  const dot = file.lastIndexOf('.');
  return dot > 0 ? file.slice(0, dot) : file;
};

/**
 * Pairs `X.png|webp|jpg|jpeg` with `X.json`, case-insensitively, anywhere in the zip (`__MACOSX/` and dotfiles are
 * already dropped by `readUpload`). An orphan, a JSON that could not be parsed or a clashing name is a failed row; it
 * never aborts the import. Rows keep the order in which their names first appear.
 */
export function pairUploads(contents: UploadContents): ImportRow[] {
  const groups = new Map<string, { name: string; images: Blob[]; json: ({ value: unknown } | 'invalid')[] }>();
  const group = (path: string) => {
    const name = baseOf(path);
    const key = name.toLowerCase();
    let found = groups.get(key);
    if (!found) groups.set(key, (found = { name, images: [], json: [] }));
    return found;
  };
  for (const image of contents.images) if (PAIR_IMAGE.test(image.name)) group(image.name).images.push(image.blob);
  for (const entry of contents.json) group(entry.name).json.push({ value: entry.value });
  for (const name of contents.unreadable) if (/\.json$/i.test(name)) group(name).json.push('invalid');
  return [...groups.values()].map(({ name, images, json }) => {
    const [image] = images;
    const [first] = json;
    const row: ImportRow = { name, status: 'pending', ...(image ? { image } : {}), ...(first ? { json: first } : {}) };
    if (images.length > 1 || json.length > 1) return fail(row, 'duplicateName');
    if (!image) return fail(row, 'noImage');
    if (!first) return fail(row, 'noJson');
    return row;
  });
}

/** More pairs than ADR-012 §5 allows, counted before any image is decoded. */
export function checkPairs(rows: readonly ImportRow[]): LimitProblem | null {
  if (rows.length === 0) return { kind: 'empty' };
  return rows.length > MULTI_IMPORT_LIMITS.maxCaps ? { kind: 'tooManyPairs', pairs: rows.length } : null;
}

function fail(row: ImportRow, reason: FailReason, detail?: string): ImportRow {
  row.status = 'failed';
  row.reason = reason;
  if (detail !== undefined) row.detail = detail;
  return row;
}

/**
 * The image as stored and its dHash (ADR-012 §3): resized to ≤ 1024 px with its alpha kept, no re-crop; the dHash on a
 * copy flattened onto the background the capture uses, over the square inscribed in the cap, as scans do.
 */
export async function prepareImage(blob: Blob, codec: RasterCodec): Promise<CapPhoto> {
  const image = await codec.decode(blob);
  try {
    const { width, height } = fitWithin(image.width, image.height);
    const drawn = await codec.raster(image, { sx: 0, sy: 0, sw: image.width, sh: image.height }, width, height);
    if (drawn === null) throw new WebpUnsupportedError('this browser has no 2D canvas');
    const hash = dhash(inscribedSquare(flatten(drawn)));
    const encoded = await encodeWithin((quality) => codec.encodeRaster(drawn, quality));
    return { blob: encoded, width, height, dhash: hash };
  } finally {
    image.close?.();
  }
}

/**
 * Transparency composited onto the neutral background of a scan's crop.
 * SPEC-GAP CAP-121: ADR-012 §3 names "the neutral background that `cropCircle` uses", but there is no such constant:
 * all `cropCircle` leaves outside the cap is `maskCircle`'s transparent black, and the dHash ignores alpha. Flattening
 * onto black (RGB × α) is that same background (plan Q1).
 */
export function flatten(raster: Raster): Raster {
  const data = new Uint8ClampedArray(raster.data.length);
  for (let i = 0; i < raster.data.length; i += 4) {
    const alpha = (raster.data[i + 3] ?? 0) / 255;
    data[i] = (raster.data[i] ?? 0) * alpha;
    data[i + 1] = (raster.data[i + 1] ?? 0) * alpha;
    data[i + 2] = (raster.data[i + 2] ?? 0) * alpha;
    data[i + 3] = 255;
  }
  return { data, width: raster.width, height: raster.height };
}

/** What a row's JSON says, normalised; an exception (format, zod) means the JSON is not a valid answer. */
interface ReadAnswer {
  readonly response: ExchangeResponse;
  readonly fields: PartialCapFields;
  readonly notes?: string;
}

function readJson(value: unknown): ReadAnswer {
  const upload = parseExchangeUpload(value);
  if (upload.kind === 'batch') throw new Error('a batch is not one cap');
  const response = upload.kind === 'document' ? upload.document.response : upload.response;
  const { fields, ignored, problems } = normaliseResponseFields(response.fields as Record<string, unknown>);
  const notes = notesFrom(response, ignored, problems);
  return { response, fields, ...(notes !== undefined ? { notes } : {}) };
}

/** `external:<provider>` (`Anthropic` → `external:anthropic`), `external:unknown` without a usable provider. */
export function importSource(provider: string | null | undefined): Source {
  const id = provider ? providerId('other', provider) : null;
  return (id !== null ? externalSource(id) : null) ?? (externalSource('unknown') as Source);
}

const titleOf = (fields: PartialCapFields) => [fields.brand, fields.variant].filter(Boolean).join(' · ');

export interface ImportDeps {
  readonly api: Pick<ApiClient, 'request'>;
  upload(photo: CapPhoto): Promise<ImageRef>;
  readonly codec: RasterCodec;
  newId(): string;
  now(): Date;
  /** `acquiredWhere`, asked once per import; null → left empty. */
  readonly place: Promise<string | null>;
  /** The note line naming the possible duplicate (i18n, from the screen). */
  possibleDuplicateNote(cap: Cap): string;
}

export interface ImportControl {
  /** Checked between pairs: true stops after the current one (saved caps stay). */
  cancelled(): boolean;
  /** Called after each row changes. */
  onProgress(done: number, total: number, row: ImportRow): void;
}

/** Imports `rows` (only those still `pending`) in order; returns when done or cancelled. */
export async function runImport(rows: readonly ImportRow[], deps: ImportDeps, control: ImportControl): Promise<void> {
  const todo = rows.filter((r) => r.status === 'pending');
  const total = todo.length;
  const prepared = new Map<ImportRow, Promise<CapPhoto | null>>();
  const prepare = (row: ImportRow | undefined) => {
    if (!row?.image || prepared.has(row)) return;
    const image = row.image;
    prepared.set(
      row,
      prepareImage(image, deps.codec).catch(() => null),
    );
  };
  // Hashes of this zip's caps imported so far (the in-zip guard, ADR-009).
  const imported: string[] = rows.flatMap((r) => (r.photo && r.capId ? [r.photo.dhash] : []));
  let done = 0;
  for (const [i, row] of todo.entries()) {
    if (control.cancelled()) {
      for (const rest of todo.slice(i)) fail(rest, 'cancelled');
      control.onProgress(done, total, row);
      return;
    }
    prepare(row);
    prepare(todo[i + 1]);
    await importRow(row, deps, prepared.get(row) ?? Promise.resolve(null), imported);
    done += 1;
    control.onProgress(done, total, row);
  }
}

async function importRow(
  row: ImportRow,
  deps: ImportDeps,
  photoReady: Promise<CapPhoto | null>,
  imported: string[],
): Promise<void> {
  if (!row.json || row.json === 'invalid') return void fail(row, 'invalidJson');
  let answer: ReadAnswer;
  try {
    answer = readJson(row.json.value);
  } catch (error) {
    return void fail(row, 'invalidJson', error instanceof Error ? error.message.slice(0, 200) : undefined);
  }
  const title = titleOf(answer.fields);
  if (title !== '') row.title = title;
  const photo = await photoReady;
  if (!photo) return void fail(row, 'badImage');
  row.photo = photo;

  if (imported.some((h) => hammingDistance(h, photo.dhash) <= BATCH_DHASH_GUARD)) {
    row.status = 'repeated';
    return;
  }

  let ref: ImageRef;
  try {
    ref = await deps.upload(photo);
  } catch {
    return void fail(row, 'uploadFailed');
  }

  let possible: Cap | undefined;
  try {
    const body: AnalyseRequest = {
      scanId: deps.newId(),
      dhash: photo.dhash,
      imageKeys: { top: ref.key },
      known: { ...answer.fields },
      useAi: false,
      language: language(),
    };
    const analysed = await deps.api.request('/scans/analyse', { method: 'POST', body, schema: AnalyseResponse });
    if (analysed.outcome === 'duplicate' && analysed.match) {
      row.status = 'inCollection';
      row.matchCapId = analysed.match.capId;
      return;
    }
    possible = await brandVariantMatch(deps.api, answer.fields);
  } catch {
    return void fail(row, 'checkFailed');
  }

  const body = await capBody(answer, ref, photo, deps, possible);
  try {
    const cap = await deps.api.request('/caps', { method: 'POST', body, schema: Cap });
    row.capId = cap.capId;
    imported.push(photo.dhash);
    if (possible) {
      row.status = 'possibleDuplicate';
      row.matchCapId = possible.capId;
    } else {
      row.status = 'imported';
    }
  } catch {
    fail(row, 'saveFailed');
  }
}

/** ADR-012 §2: a live cap with the same normalised brand and variant (`GET /caps?brand=`); none for "Unknown". */
async function brandVariantMatch(api: ImportDeps['api'], fields: PartialCapFields): Promise<Cap | undefined> {
  const brand = fields.brand;
  if (brand === undefined || normaliseBrand(brand) === '' || normaliseBrand(brand) === normaliseBrand(UNKNOWN_BRAND)) {
    return undefined;
  }
  const query = new URLSearchParams({ brand, limit: String(BRAND_CHECK_LIMIT) });
  const page = await api.request(`/caps?${query.toString()}`, { schema: CapPageSchema });
  const variant = normaliseBrand(fields.variant ?? '');
  return page.items.find(
    (c) => normaliseBrand(c.brand) === normaliseBrand(brand) && normaliseBrand(c.variant ?? '') === variant,
  );
}

/** The `POST /caps` body (exchange.md § Multi-import step 8; features.md § Defaults when unsure). */
async function capBody(
  answer: ReadAnswer,
  ref: ImageRef,
  photo: CapPhoto,
  deps: ImportDeps,
  possible: Cap | undefined,
): Promise<CapInput> {
  const { fields, response } = answer;
  const brandConfidence = response.confidence.brand;
  const place = await deps.place;
  const notes = [answer.notes, possible ? deps.possibleDuplicateNote(possible) : undefined]
    .filter((n): n is string => n !== undefined && n.trim() !== '')
    .join('\n');
  return {
    ...fields,
    // SPEC-GAP CAP-121: `brand` is required; an AI that names none gets the prompt's "Unknown" (plan Q3).
    brand: fields.brand ?? UNKNOWN_BRAND,
    material: fields.material ?? DEFAULT_MATERIAL,
    closure: fields.closure ?? DEFAULT_CLOSURE,
    acquiredOn: localDate(deps.now()),
    ...(place ? { acquiredWhere: place } : {}),
    ...(notes !== '' ? { notes: notes.slice(0, 2000) } : {}),
    images: { top: ref },
    dhash: photo.dhash,
    status: 'needsReview',
    source: importSource(response.provider),
    ...(response.model ? { aiModel: response.model.slice(0, 120) } : {}),
    ...(typeof brandConfidence === 'number' ? { aiConfidence: brandConfidence } : {}),
    tags: [],
    quantity: 1,
    forTrade: 0,
  };
}

/** Summary counts; each row falls in exactly one (plan Q5). */
export function summarise(rows: readonly ImportRow[]): Record<Exclude<RowStatus, 'pending'>, number> {
  const counts = { imported: 0, inCollection: 0, repeated: 0, possibleDuplicate: 0, failed: 0 };
  for (const row of rows) if (row.status !== 'pending') counts[row.status] += 1;
  return counts;
}

/** "Reintentar fallidas": failed rows that can be tried again go back to pending (orphans and bad JSON stay failed). */
export function resetFailed(rows: readonly ImportRow[]): number {
  let n = 0;
  for (const row of rows) {
    if (row.status !== 'failed' || !row.image || !row.json || row.json === 'invalid') continue;
    if (row.reason === 'duplicateName' || row.reason === 'invalidJson') continue;
    row.status = 'pending';
    delete row.reason;
    delete row.detail;
    n += 1;
  }
  return n;
}
