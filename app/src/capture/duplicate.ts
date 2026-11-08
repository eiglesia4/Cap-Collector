// "Already in collection" rules (CAP-42; SCREENS.md #4; ADR-003 "nothing in a stored record is overwritten without an
// explicit tick"; ADR-008 §1 `variantOf`): the opt-in field diff between the stored cap and what the scan brought, the
// `PATCH /caps/{id}` body holding only the ticked fields (absent = untouched, shared `CapPatch`), the author of the
// change (`source`), and the way into the form for "It's a variant". DOM-free so every rule tests directly.
import { Source, type AnalyseResponse, type Cap, type CapFields, type CapPatch } from '@capcollector/shared';

import type { CaptureSession } from './context.js';
import { manualEntryPath } from './flow.js';

export type DiffField = keyof CapFields;

/** Every `CapFields` key, in form order (SCREENS.md #5). */
export const DIFF_FIELDS: readonly DiffField[] = [
  'brand',
  'variant',
  'producer',
  'country',
  'type',
  'material',
  'closure',
  'year',
  'description',
  'textOnCap',
];

type FieldValue = CapFields[DiffField];

export interface DiffRow {
  readonly field: DiffField;
  /** What the record has now; `undefined` = empty (counts as a difference). */
  readonly stored: FieldValue;
  readonly next: NonNullable<FieldValue>;
}

/** The fields the scan brought (AI identification or `known`) that differ from the stored cap. */
/** What the scan brought: `AnalyseResponse.fields` (every key optional, `undefined` allowed). */
export type ScanFields = NonNullable<AnalyseResponse['fields']>;

export function diffRows(stored: Cap, fields: ScanFields | undefined): DiffRow[] {
  if (fields === undefined) return [];
  const rows: DiffRow[] = [];
  for (const field of DIFF_FIELDS) {
    const next = fields[field];
    if (next === undefined || next === stored[field]) continue;
    rows.push({ field, stored: stored[field], next });
  }
  return rows;
}

export interface Ticks {
  readonly fields: ReadonlySet<DiffField>;
  /** "+1 quantity": `quantity = stored + 1`. */
  readonly quantity: boolean;
  /** "Replace top photo" with the scanned one. */
  readonly photo: boolean;
}

export const NO_TICKS: Ticks = { fields: new Set(), quantity: false, photo: false };

export function hasTicks(ticks: Ticks): boolean {
  return ticks.fields.size > 0 || ticks.quantity || ticks.photo;
}

/** Who makes a change taken from this scan: the AI model that identified it, else the user (`manual`). */
export function scanSource(session: CaptureSession): Source {
  const model = session.response?.aiModel;
  if (model === undefined || session.response?.fields === undefined) return 'manual';
  const parsed = Source.safeParse(`bedrock:${model}`);
  return parsed.success ? parsed.data : 'manual';
}

/** `PATCH /caps/{id}` body with exactly the ticked changes; `null` when nothing is ticked. */
export function updatePatch(
  stored: Cap,
  rows: readonly DiffRow[],
  ticks: Ticks,
  session: CaptureSession,
): CapPatch | null {
  if (!hasTicks(ticks)) return null;
  const patch: Record<string, unknown> = {};
  let fromScan = false;
  for (const row of rows) {
    if (!ticks.fields.has(row.field)) continue;
    patch[row.field] = row.next;
    fromScan = true;
  }
  if (ticks.quantity) patch.quantity = stored.quantity + 1;
  const top = session.top;
  if (ticks.photo && top?.ref) {
    // The whole `images` object is replaced (CapPatch): the stored underside is kept as it is.
    patch.images = stored.images.underside ? { top: top.ref, underside: stored.images.underside } : { top: top.ref };
    // SPEC-GAP CAP-42: the story names only `images.top`; the stored dHash must describe the stored top photo
    // (ADR-004 compares against it), so the scanned photo's hash goes with it in the same PATCH.
    patch.dhash = top.photo.dhash;
  }
  patch.source = fromScan ? scanSource(session) : 'manual';
  return patch as CapPatch;
}

/** "It's a variant": manual entry of this scan, pre-filled with its values and linked to the matched cap. */
export function variantPath(scanId: string, capId: string): string {
  return `${manualEntryPath(scanId)}&variantOf=${encodeURIComponent(capId)}`;
}

export type DuplicateMatch = NonNullable<NonNullable<CaptureSession['response']>['match']>;

/** The open scan context of a duplicate outcome with its match, or null when there is none. */
export function duplicateScan(
  session: CaptureSession | null,
): { session: CaptureSession; match: DuplicateMatch } | null {
  const match = session?.response?.match;
  if (!session || session.response?.outcome !== 'duplicate' || match === undefined || !session.top?.ref) return null;
  return { session, match };
}
