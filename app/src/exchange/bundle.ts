// Request bundle for an external AI (CAP-45; ADR-007; exchange.md § Flow step 1, § request.json, § Batch): the
// `request.json` document (shared `ExchangeDocumentV1`, `kind: request`, empty `response`), its zip
// `cap-<capId|scanId>-request.zip` with `top.webp`, `underside.webp` (if any) and `request.json`, the batch zip (one
// folder per cap + `requests.json`, shared `ExchangeBatchV1`), and the "Copy prompt" / "Copy JSON" texts. DOM-free.
import {
  EXCHANGE_CURRENT_VERSION,
  EXCHANGE_FIELD_SCHEMA,
  EXCHANGE_FORMAT,
  EXCHANGE_INSTRUCTIONS,
  emptyExchangeResponse,
  type CapFields,
  type ExchangeDocument,
} from '@capcollector/shared';
import { strToU8, zipSync, type Zippable } from 'fflate';

export type PhotoSide = 'top' | 'underside';

export interface BundlePhoto {
  readonly side: PhotoSide;
  /** The stored / captured WebP (circular crop). */
  readonly blob: Blob;
  readonly dhash: string;
}

/** What one request is about: a new scan (`scanId`) or a stored cap (`capId`), its photos and what it already has. */
export interface BundleSubject {
  readonly capId?: string;
  readonly scanId?: string;
  readonly photos: readonly BundlePhoto[];
  readonly known: Partial<CapFields>;
}

export interface BundleItem {
  readonly subject: BundleSubject;
  readonly document: ExchangeDocument;
}

export const ZIP_TYPE = 'application/zip';

/** `top.webp` / `underside.webp` (exchange.md § Flow), inside `folder/` for a batch. */
export function photoFile(side: PhotoSide, folder = ''): string {
  return `${folder}${side}.webp`;
}

/** `cap-<capId|scanId>` (exchange.md § Flow); the request id when the request has neither. */
export function subjectName(subject: BundleSubject, requestId: string): string {
  return `cap-${subject.capId ?? subject.scanId ?? requestId}`;
}

/** `request.json` for one subject (exchange.md § request.json). `folder` prefixes the photo files in a batch. */
export function requestDocument(
  subject: BundleSubject,
  requestId: string,
  createdAt: string,
  folder = '',
): ExchangeDocument {
  const top = subject.photos.find((p) => p.side === 'top');
  if (!top) throw new Error('a request needs the top photo');
  const photos = (['top', 'underside'] as const).flatMap((side) => {
    const photo = subject.photos.find((p) => p.side === side);
    return photo ? [{ file: photoFile(side, folder), side, dhash: photo.dhash }] : [];
  });
  return {
    format: EXCHANGE_FORMAT,
    version: EXCHANGE_CURRENT_VERSION,
    kind: 'request',
    requestId,
    createdAt,
    ...(subject.capId !== undefined ? { capId: subject.capId } : {}),
    ...(subject.scanId !== undefined ? { scanId: subject.scanId } : {}),
    photos,
    instructions: EXCHANGE_INSTRUCTIONS,
    schema: { ...EXCHANGE_FIELD_SCHEMA },
    known: { ...subject.known },
    response: emptyExchangeResponse(),
  };
}

async function bytes(blob: Blob): Promise<Uint8Array> {
  return new Uint8Array(await blob.arrayBuffer());
}

/** Pretty JSON, as the user pastes it ("Copy JSON"). */
export function jsonText(value: ExchangeDocument | readonly ExchangeDocument[]): string {
  return JSON.stringify(value, null, 2) + '\n';
}

/**
 * "Copy prompt": for chat UIs that take pasted text + an image — the instructions, the field schema, what the record
 * already has, and the empty `response` to fill.
 */
export function promptText(document: ExchangeDocument): string {
  return [
    document.instructions,
    '',
    `Field schema: ${JSON.stringify(document.schema, null, 2)}`,
    '',
    `Known: ${JSON.stringify(document.known, null, 2)}`,
    '',
    `requestId: ${document.requestId}`,
    '',
    `response: ${JSON.stringify(document.response, null, 2)}`,
    '',
  ].join('\n');
}

/** WebP is already compressed: stored (level 0); the JSON is deflated. */
async function addPhotos(entries: Zippable, subject: BundleSubject, folder: string): Promise<void> {
  for (const photo of subject.photos) entries[photoFile(photo.side, folder)] = [await bytes(photo.blob), { level: 0 }];
}

/** `cap-<id>-request.zip`: `top.webp`, `underside.webp` (if any), `request.json`. */
export async function singleZip(item: BundleItem): Promise<File> {
  const entries: Zippable = {};
  await addPhotos(entries, item.subject, '');
  entries['request.json'] = strToU8(jsonText(item.document));
  const name = `${subjectName(item.subject, item.document.requestId)}-request.zip`;
  return new File([zipSync(entries)], name, { type: ZIP_TYPE });
}

/** Batch (exchange.md § Batch): one `cap-<id>/` folder of photos per cap plus `requests.json` (`ExchangeBatchV1`). */
export async function batchZip(items: readonly BundleItem[], date: string): Promise<File> {
  if (items.length === 0) throw new Error('a batch needs at least one cap');
  const entries: Zippable = {};
  for (const item of items)
    await addPhotos(entries, item.subject, `${subjectName(item.subject, item.document.requestId)}/`);
  entries['requests.json'] = strToU8(jsonText(items.map((i) => i.document)));
  return new File([zipSync(entries)], `caps-${items.length}-${date}-requests.zip`, { type: ZIP_TYPE });
}

/** Builds the request(s) of a scope: one document per subject (a batch prefixes photo paths with the cap folder). */
export function bundleItems(subjects: readonly BundleSubject[], newId: () => string, createdAt: string): BundleItem[] {
  const batch = subjects.length > 1;
  return subjects.map((subject) => {
    const requestId = newId();
    const folder = batch ? `${subjectName(subject, requestId)}/` : '';
    return { subject, document: requestDocument(subject, requestId, createdAt, folder) };
  });
}
