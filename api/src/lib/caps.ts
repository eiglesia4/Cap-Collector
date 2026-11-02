// Caps service (CAP-18): create / get / patch / tombstone / history / list behind the thin caps-* handlers.
// Spec: openapi.yaml /caps, /caps/{capId}, /caps/{capId}/history; ADR-006 (every write appends HIST# in the same
// transaction, delete = tombstone); data-model.md (GSI2 maintained by the repository, tombstones drop GSI attributes).
import {
  Cap,
  type CapHistory,
  type CapInput,
  CapInput as CapInputSchema,
  type CapPatch,
  CapPatch as CapPatchSchema,
  CapStatus as CapStatusSchema,
  CapType,
  CountryCode,
  type Location,
  type Source,
  Ulid,
  normaliseBrand,
  parseLocationCode,
} from '@capcollector/shared';
import { z } from 'zod';

import { BadRequest, NotFound } from './errors.js';
import { ValidationError } from './http.js';
import { newId } from './ids.js';
import type { Repositories } from './repo/types.js';
import { after, now } from './time.js';

/** Collections up to this size report `total` (CapPage.total); larger ones omit it (CAP-18). */
export const TOTAL_LIMIT = 5000;
export const LIST_DEFAULT_LIMIT = 60;
export const LIST_MAX_LIMIT = 200;

const LOCATION_V1 = 'location is set through PUT /caps/{capId}/location (V3), not in this body';

/** V1 scope (CAP-18): `location` is never accepted on POST/PATCH /caps; 422 with the field path. */
function rejectLocation(v: { location?: unknown }, ctx: z.RefinementCtx): void {
  if (v.location !== undefined) ctx.addIssue({ code: 'custom', path: ['location'], message: LOCATION_V1 });
}

/** Re-checks the assembled record against the `Cap` contract (refines like forTrade ≤ quantity) and answers 422. */
function checkCap(candidate: unknown): Cap {
  const r = Cap.safeParse(candidate);
  if (!r.success) throw new ValidationError(r.error, 'body');
  return r.data;
}

/** The album id a record's album-kind location needs for its storage keys (data-model.md § Indexes). */
async function albumIdOf(repos: Repositories, uid: string, cap: Cap): Promise<string | undefined> {
  if (cap.deletedAt !== undefined || cap.location?.kind !== 'album') return undefined;
  const album = await repos.albums.byLetter(uid, cap.location.album);
  if (!album) throw new Error(`cap ${cap.capId} points to album ${cap.location.album}, which does not exist`);
  return album.albumId;
}

/** A live cap of this user, or 404 (unknown and tombstoned look the same, openapi.yaml GET /caps/{capId}). */
async function liveCap(repos: Repositories, uid: string, capId: string): Promise<Cap> {
  const cap = await repos.caps.get(uid, capId);
  if (!cap || cap.deletedAt !== undefined) throw new NotFound(`cap ${capId} not found`);
  return cap;
}

/** `{capId}` path parameter (openapi.yaml components.parameters.capId: a ULID). */
export const CapIdPath = z.object({ capId: Ulid });

/** Top-level keys of the JSON body as sent (before zod defaults), for PATCH. */
export function sentKeys(raw: unknown): ReadonlySet<string> {
  return new Set(typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? Object.keys(raw) : []);
}

/** POST /caps body: the shared `CapInput` plus the V1 location rule. */
export const CapCreateBody = CapInputSchema.superRefine(rejectLocation);
/** PATCH /caps/{capId} body: the shared `CapPatch` plus the V1 location rule. */
export const CapPatchBody = CapPatchSchema.superRefine(rejectLocation);

export async function createCap(repos: Repositories, uid: string, input: CapInput): Promise<Cap> {
  const ts = now();
  const { source, ...fields } = input;
  const cap = checkCap({
    ...fields,
    capId: newId(),
    status: input.status ?? 'complete',
    source,
    createdAt: ts,
    updatedAt: ts,
  });
  const history: CapHistory = { capId: cap.capId, ts, source, action: 'created', changes: [] };
  await repos.caps.put(uid, { cap, history });
  return cap;
}

export async function getCap(repos: Repositories, uid: string, capId: string): Promise<Cap> {
  return liveCap(repos, uid, capId);
}

/** Fields a PATCH may never touch (server-owned). */
const SERVER_FIELDS = new Set(['capId', 'createdAt', 'updatedAt', 'deletedAt', 'source']);

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Applies only the keys the client sent. SPEC-GAP CAP-18: `CapPatch` is `CapInput.partial()`, and zod 4 still fills the
 * `.default()`s of CapInput inside it (tags [], quantity 1, forTrade 0, source manual) — applying the parsed object
 * would silently overwrite those fields, breaking "nothing is overwritten without an explicit tick" (CLAUDE.md).
 * The parsed body is used for validation and values; `sent` (the raw JSON keys) decides what changes.
 */
export async function patchCap(
  repos: Repositories,
  uid: string,
  capId: string,
  patch: CapPatch,
  sent: ReadonlySet<string>,
): Promise<Cap> {
  const prev = await liveCap(repos, uid, capId);
  const next: Record<string, unknown> = { ...prev };
  const changes: CapHistory['changes'] = [];
  for (const [field, value] of Object.entries(patch)) {
    if (!sent.has(field) || SERVER_FIELDS.has(field)) continue;
    if (same(prev[field as keyof Cap], value)) continue;
    const from = prev[field as keyof Cap];
    changes.push({ field, ...(from === undefined ? {} : { from }), to: value });
    next[field] = value;
  }
  if (changes.length === 0) return prev;

  const ts = after(prev.updatedAt);
  next.updatedAt = ts;
  const cap = checkCap(next);
  // The history entry carries who made the change; the record keeps its original provenance.
  const source: Source = sent.has('source') ? patch.source! : 'manual';
  const history: CapHistory = { capId, ts, source, action: 'updated', changes };
  const albumId = await albumIdOf(repos, uid, prev);
  await repos.caps.patch(
    uid,
    { cap: prev, ...(albumId ? { albumId } : {}) },
    { cap, ...(albumId ? { albumId } : {}), history },
  );
  return cap;
}

/** Tombstone (ADR-006). Idempotent: an already-deleted cap answers 204 again without a new history entry. */
export async function deleteCap(repos: Repositories, uid: string, capId: string): Promise<void> {
  const prev = await repos.caps.get(uid, capId);
  if (!prev) throw new NotFound(`cap ${capId} not found`);
  if (prev.deletedAt !== undefined) return;
  const ts = after(prev.updatedAt);
  const albumId = await albumIdOf(repos, uid, prev);
  const history: CapHistory = {
    capId,
    ts,
    source: 'manual',
    action: 'deleted',
    changes: [{ field: 'deletedAt', to: ts }],
  };
  await repos.caps.softDelete(uid, { cap: prev, ...(albumId ? { albumId } : {}) }, history);
}

/** Newest first (openapi.yaml). Ownership is checked through the user's cap item; tombstoned caps keep their history. */
export async function capHistory(repos: Repositories, uid: string, capId: string): Promise<CapHistory[]> {
  const cap = await repos.caps.get(uid, capId);
  if (!cap) throw new NotFound(`cap ${capId} not found`);
  return (await repos.caps.history(capId)).reverse();
}

// ---------------------------------------------------------------------------------------------------------------
// List (GET /caps)

const Bool = z.enum(['true', 'false']).transform((v) => v === 'true');
export const ListSort = z.enum(['brand', 'newest', 'country', 'year']);
export type ListSort = z.infer<typeof ListSort>;

/** Query of GET /caps (openapi.yaml parameters). */
export const CapListQuery = z.object({
  q: z.string().trim().max(200).optional(),
  status: CapStatusSchema.optional(),
  country: CountryCode.optional(),
  type: CapType.optional(),
  tag: z.string().trim().min(1).max(30).optional(),
  forTrade: Bool.optional(),
  sort: ListSort.default('brand'),
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(LIST_MAX_LIMIT).default(LIST_DEFAULT_LIMIT),
  includeDeleted: Bool.default(false),
});
export type CapListQuery = z.infer<typeof CapListQuery>;

export interface CapPage {
  items: Cap[];
  cursor?: string;
  total?: number;
}

/** True when the free text or location code `q` matches the cap. Accent- and case-insensitive (normaliseBrand). */
export function matchesQuery(cap: Cap, q: string): boolean {
  const code = parseLocationCode(q);
  if (code && cap.location && sameLocation(cap.location, code)) return true;
  const needle = normaliseBrand(q);
  if (!needle) return false;
  const hay = [cap.brand, cap.variant, cap.producer, cap.textOnCap, ...cap.tags];
  return hay.some((h) => h !== undefined && normaliseBrand(h).includes(needle));
}

function sameLocation(have: Location, want: Location): boolean {
  if (want.kind === 'album') {
    return (
      have.kind === 'album' && have.album === want.album && have.sheet === want.sheet && have.pocket === want.pocket
    );
  }
  // A bare letter `B` names a box/frame (physical-link.md § Location code).
  return have.kind !== 'album' && have.album === want.album;
}

function matchesFilters(cap: Cap, f: CapListQuery): boolean {
  if (f.status && cap.status !== f.status) return false;
  if (f.country && cap.country !== f.country) return false;
  if (f.type && cap.type !== f.type) return false;
  if (f.tag && !cap.tags.some((t) => normaliseBrand(t) === normaliseBrand(f.tag!))) return false;
  if (f.forTrade !== undefined && cap.forTrade > 0 !== f.forTrade) return false;
  if (f.q && !matchesQuery(cap, f.q)) return false;
  return true;
}

/** The fields a sort compares, kept in the cursor so a page resumes after the last item even if items changed. */
const SortKey = z.object({
  capId: z.string(),
  brand: z.string(),
  variant: z.string().optional(),
  country: z.string().optional(),
  year: z.number().optional(),
  createdAt: z.string(),
});
type SortKey = z.infer<typeof SortKey>;
const Cursor = z.object({ s: ListSort, k: SortKey });

const str = (a: string | undefined, b: string | undefined) => (a ?? '').localeCompare(b ?? '', 'en');
/** Missing values sort last in ascending order. */
function missingLast<T>(a: T | undefined, b: T | undefined, cmp: (x: T, y: T) => number): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  return cmp(a, b);
}
const byBrand = (a: SortKey, b: SortKey) =>
  str(normaliseBrand(a.brand), normaliseBrand(b.brand)) || str(a.variant, b.variant);
const byId = (a: SortKey, b: SortKey) => (a.capId < b.capId ? -1 : a.capId > b.capId ? 1 : 0);

/**
 * Total orders (capId breaks ties): brand A→Z then variant; newest = createdAt descending; country A→Z (none last)
 * then brand; year oldest first (none last) then brand.
 */
export const COMPARATORS: Record<ListSort, (a: SortKey, b: SortKey) => number> = {
  brand: (a, b) => byBrand(a, b) || byId(a, b),
  newest: (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt) || byId(b, a),
  country: (a, b) => missingLast(a.country, b.country, str) || byBrand(a, b) || byId(a, b),
  year: (a, b) => missingLast(a.year, b.year, (x, y) => x - y) || byBrand(a, b) || byId(a, b),
};

const sortKey = (c: Cap): SortKey => ({
  capId: c.capId,
  brand: c.brand,
  createdAt: c.createdAt,
  ...(c.variant === undefined ? {} : { variant: c.variant }),
  ...(c.country === undefined ? {} : { country: c.country }),
  ...(c.year === undefined ? {} : { year: c.year }),
});

export function encodeListCursor(sort: ListSort, last: Cap): string {
  return Buffer.from(JSON.stringify({ s: sort, k: sortKey(last) }), 'utf8').toString('base64url');
}

function decodeListCursor(cursor: string, sort: ListSort): SortKey {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequest('Invalid cursor');
  }
  const r = Cursor.safeParse(raw);
  if (!r.success) throw new BadRequest('Invalid cursor');
  if (r.data.s !== sort) throw new BadRequest('The cursor belongs to another sort order');
  return r.data.k;
}

export async function listCaps(repos: Repositories, uid: string, query: CapListQuery): Promise<CapPage> {
  const all = await repos.caps.listAll(uid, { includeDeleted: query.includeDeleted });
  const cmp = COMPARATORS[query.sort];
  const matching = all.filter((c) => matchesFilters(c, query)).sort((a, b) => cmp(sortKey(a), sortKey(b)));
  let start = 0;
  if (query.cursor) {
    const last = decodeListCursor(query.cursor, query.sort);
    const i = matching.findIndex((c) => cmp(sortKey(c), last) > 0);
    start = i === -1 ? matching.length : i;
  }
  const items = matching.slice(start, start + query.limit);
  const more = start + items.length < matching.length;
  return {
    items,
    ...(more ? { cursor: encodeListCursor(query.sort, items.at(-1)!) } : {}),
    ...(all.length <= TOTAL_LIMIT ? { total: matching.length } : {}),
  };
}
