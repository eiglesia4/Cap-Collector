// Upload of an external AI's answer (CAP-45; ADR-007; exchange.md § Flow step 3): read the picked / dropped files (the
// zip back, or loose `*.json` + images), parse with the shared `parseExchangeUpload` (unknown `format` / `version`
// rejected, never silently), match the `requestId` against the pending requests (else the user attaches it to a cap),
// normalise the fields (`normaliseResponseFields`: ignored keys and unparseable values are reported and appended to
// notes, never dropped silently), and compare the photo's dHash with the request's (ADR-004 tolerance → a warning,
// not a block). DOM-free: the photo hashing is injected.
import {
  normaliseResponseFields,
  parseExchangeUpload,
  Source,
  type PartialCapFields,
  type ExchangeRequestItem,
  type ExchangeResponse,
} from '@capcollector/shared';
import { unzipSync } from 'fflate';

import { hammingDistance } from '../images/dhash.js';
import type { PhotoSide } from './bundle.js';

/** Photo hash difference still taken as "the same photo" (ADR-004 tolerance; story CAP-45). */
export const PHOTO_TOLERANCE = 10;

/** Providers offered as chips (story CAP-45); "other" asks for a name. */
export const PROVIDERS = ['chatgpt', 'gemini', 'claude', 'other'] as const;
export type ProviderChip = (typeof PROVIDERS)[number];

export interface UploadFile {
  readonly name: string;
  readonly blob: Blob;
}

export interface UploadContents {
  readonly json: readonly { readonly name: string; readonly value: unknown }[];
  readonly images: readonly UploadFile[];
  /** Files that could not be read (bad JSON, broken zip). */
  readonly unreadable: readonly string[];
}

const IMAGE = /\.(webp|jpe?g|png|heic)$/i;
const IMAGE_TYPE: Record<string, string> = {
  webp: 'image/webp',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
};

function imageType(name: string): string {
  return IMAGE_TYPE[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'application/octet-stream';
}

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Reads every picked file; a zip is opened and its JSON and images are taken as if picked loose. */
export async function readUpload(files: readonly File[]): Promise<UploadContents> {
  const json: { name: string; value: unknown }[] = [];
  const images: UploadFile[] = [];
  const unreadable: string[] = [];
  const add = (name: string, data: Uint8Array | string) => {
    const base = name.split('/').pop() ?? name;
    if (name.startsWith('__MACOSX/') || base.startsWith('.')) return;
    if (/\.json$/i.test(name)) {
      const parsed = parseJson(typeof data === 'string' ? data : new TextDecoder().decode(data));
      if (parsed.ok) json.push({ name, value: parsed.value });
      else unreadable.push(name);
    } else if (IMAGE.test(name)) {
      images.push({ name, blob: new Blob([data as BlobPart], { type: imageType(name) }) });
    }
  };
  for (const file of files) {
    if (/\.zip$/i.test(file.name) || file.type === 'application/zip') {
      try {
        const entries = unzipSync(new Uint8Array(await file.arrayBuffer()));
        for (const [name, data] of Object.entries(entries)) if (!name.endsWith('/')) add(name, data);
      } catch {
        unreadable.push(file.name);
      }
    } else if (/\.json$/i.test(file.name) || file.type === 'application/json') {
      add(file.name.endsWith('.json') ? file.name : `${file.name}.json`, await file.text());
    } else if (IMAGE.test(file.name) || file.type.startsWith('image/')) {
      images.push({ name: file.name, blob: file });
    }
  }
  return { json, images, unreadable };
}

/** The photo of one side among the uploaded images: `top.*` / `underside.*`, else the first image as the top. */
export function photoOf(images: readonly UploadFile[], side: PhotoSide): UploadFile | undefined {
  const named = images.find((i) => (i.name.split('/').pop() ?? '').toLowerCase().startsWith(side));
  if (named) return named;
  if (side === 'underside') return undefined;
  return images.find((i) => !(i.name.split('/').pop() ?? '').toLowerCase().startsWith('underside'));
}

export type AnswerProblem =
  /** No JSON among the files, or none parses. */
  | { readonly kind: 'noJson' }
  /** `format` / `version` not supported (the shared parser's message). */
  | { readonly kind: 'format'; readonly message: string }
  /** The JSON is not an exchange document or a `response` object. */
  | { readonly kind: 'invalid' }
  /** A batch answer (one array for several caps): V4 (story CAP-45). */
  | { readonly kind: 'batch' };

export interface Answer {
  /** `requestId` the answer names (the whole document), else the one it was uploaded for. */
  readonly requestId?: string;
  /** The pending request it belongs to; absent → the user attaches it to a cap. */
  readonly request?: ExchangeRequestItem;
  readonly response: ExchangeResponse;
  /** Normalised `CapFields` for the review. */
  readonly fields: PartialCapFields;
  /** Unknown keys of `fields` (shown as "ignored: a, b"). */
  readonly ignored: readonly string[];
  /** Values that could not be normalised (`country: Atlantis`). */
  readonly problems: readonly string[];
  /** The answer's `notes` plus every ignored / unparseable value, for the cap's notes. */
  readonly notes?: string;
  /** Per-field confidence 0–1 (nulls dropped). */
  readonly confidence: Readonly<Record<string, number>>;
  /** dHash the uploaded photo must be close to: the pending request's, else the document's top photo. */
  readonly expectedDhash?: string;
}

/** Statuses an answer can still be uploaded for. */
const OPEN: ReadonlySet<ExchangeRequestItem['status']> = new Set(['waiting', 'answered']);

function chooseJson(contents: UploadContents): { name: string; value: unknown } | undefined {
  return (
    contents.json.find((j) => /(^|\/)(request|response|answer)[^/]*\.json$/i.test(j.name) && !Array.isArray(j.value)) ??
    contents.json.find((j) => !/(^|\/)requests\.json$/i.test(j.name)) ??
    contents.json[0]
  );
}

function notesFrom(
  response: ExchangeResponse,
  ignored: readonly string[],
  problems: readonly string[],
): string | undefined {
  const raw = response.fields as Record<string, unknown>;
  const lines = [
    ...(response.notes ? [response.notes] : []),
    ...(ignored.length ? [`ignored: ${ignored.map((k) => `${k}=${JSON.stringify(raw[k])}`).join('; ')}`] : []),
    ...(problems.length ? [`not understood: ${problems.join('; ')}`] : []),
  ];
  return lines.length ? lines.join('\n') : undefined;
}

/**
 * Validates an upload against the pending requests (exchange.md § Flow step 3). `uploadedFor` is the request the user
 * pressed "Upload answer" on, used when the file is the bare `response` (it carries no `requestId`).
 */
export function readAnswer(
  contents: UploadContents,
  pending: readonly ExchangeRequestItem[],
  uploadedFor?: string,
): { ok: true; answer: Answer } | { ok: false; problem: AnswerProblem } {
  const chosen = chooseJson(contents);
  if (!chosen) return { ok: false, problem: { kind: 'noJson' } };
  if (Array.isArray(chosen.value)) return { ok: false, problem: { kind: 'batch' } };
  let upload: ReturnType<typeof parseExchangeUpload>;
  try {
    upload = parseExchangeUpload(chosen.value);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return /^(unknown exchange format|unsupported exchange version)/.test(message)
      ? { ok: false, problem: { kind: 'format', message } }
      : { ok: false, problem: { kind: 'invalid' } };
  }
  if (upload.kind === 'batch') return { ok: false, problem: { kind: 'batch' } };
  const response = upload.kind === 'document' ? upload.document.response : upload.response;
  const requestId = upload.kind === 'document' ? upload.document.requestId : uploadedFor;
  const request = pending.find((p) => p.requestId === requestId && OPEN.has(p.status));
  const { fields, ignored, problems } = normaliseResponseFields(response.fields as Record<string, unknown>);
  const confidence: Record<string, number> = {};
  for (const [k, v] of Object.entries(response.confidence)) if (typeof v === 'number') confidence[k] = v;
  const docTop = upload.kind === 'document' ? upload.document.photos.find((p) => p.side === 'top')?.dhash : undefined;
  const expectedDhash = request?.dhash ?? docTop;
  const notes = notesFrom(response, ignored, problems);
  return {
    ok: true,
    answer: {
      ...(requestId !== undefined ? { requestId } : {}),
      ...(request ? { request } : {}),
      response,
      fields,
      ignored,
      problems,
      ...(notes !== undefined ? { notes } : {}),
      confidence,
      ...(expectedDhash !== undefined ? { expectedDhash } : {}),
    },
  };
}

/** True when the uploaded photo is not the request's (ADR-004 tolerance): a warning, the review still goes on. */
export function photoMismatch(expected: string | undefined, actual: string | undefined): boolean {
  if (expected === undefined || actual === undefined) return false;
  return hammingDistance(expected, actual) > PHOTO_TOLERANCE;
}

/** The chip a provider name falls under (`ChatGPT-4o` → chatgpt), "other" for the rest. */
export function providerChip(name: string | null | undefined): ProviderChip | undefined {
  if (!name) return undefined;
  const n = name.toLowerCase();
  if (/chat\s*gpt|openai|gpt/.test(n)) return 'chatgpt';
  if (/gemini|bard|google/.test(n)) return 'gemini';
  if (/claude|anthropic/.test(n)) return 'claude';
  return 'other';
}

/** `provider` as stored on the request (`PATCH {status: answered, provider}`): the chip id, or the typed name. */
export function providerId(chip: ProviderChip, other: string): string | null {
  if (chip !== 'other') return chip;
  const typed = other.trim().toLowerCase().replace(/\s+/g, '-');
  return typed === '' ? null : typed;
}

/** `source = external:<provider>` (ADR-007), or null when the name makes no valid `Source`. */
export function externalSource(provider: string): Source | null {
  const parsed = Source.safeParse(`external:${provider}`);
  return parsed.success ? parsed.data : null;
}
