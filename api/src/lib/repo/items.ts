// Storage-item planning shared by both repositories (data-model.md, ADR-006): turns a cap write into the exact set of
// conditional puts/deletes of one transaction — cap item (+ GSI attributes), `HIST#` item, pocket `LOCK#` marker —
// with keys built ONLY by @capcollector/shared keys.ts. The Dynamo repo sends the plan as a TransactWrite; the
// in-memory repo applies it atomically, so both enforce the same invariants.
import {
  type AlbumLocation,
  type Cap,
  type CapHistory,
  brandGsi2,
  capPk,
  capSk,
  historySk,
  locationGsi1,
  lockSk,
  userPk,
} from '@capcollector/shared';

import { BadRequest } from '../errors.js';
import type { CapIndexEntry, CapPrevious, CapWrite } from './types.js';

export type Item = Record<string, unknown> & { pk: string; sk: string };
// A type alias (not an interface) so it is assignable to Record<string, unknown>.
export type Key = { pk: string; sk: string };

/** One write of a transaction with its condition. */
export type Op =
  | { op: 'put'; item: Item; ifNotExists: true }
  | { op: 'put'; item: Item; ifUpdatedAt: string }
  | { op: 'delete'; key: Key; ifCapId: string };

/** Attributes that exist only in storage, never in a returned entity. */
export const STORAGE_ATTRIBUTES = ['pk', 'sk', 'gsi1pk', 'gsi1sk', 'gsi2pk', 'gsi2sk', 'ttl'] as const;

export function stripKeys<T>(item: Record<string, unknown>): T {
  const out: Record<string, unknown> = { ...item };
  for (const a of STORAGE_ATTRIBUTES) delete out[a];
  return out as T;
}

const isLive = (cap: Cap) => cap.deletedAt === undefined;

/** The album-kind location of a live cap, with its resolved album id, or undefined. */
function pocketOf(cap: Cap, albumId: string | undefined): { albumId: string; loc: AlbumLocation } | undefined {
  if (!isLive(cap) || cap.location?.kind !== 'album') return undefined;
  if (!albumId) throw new Error(`albumId is required to store cap ${cap.capId} in album ${cap.location.album}`);
  return { albumId, loc: cap.location };
}

/** The stored cap item: record + keys + GSI1 (live, in an album pocket) + GSI2 (every live cap). */
export function capItem(uid: string, cap: Cap, albumId?: string): Item {
  const pocket = pocketOf(cap, albumId);
  return {
    ...cap,
    pk: userPk(uid),
    sk: capSk(cap.capId),
    ...(pocket ? locationGsi1(pocket.albumId, pocket.loc) : {}),
    ...(isLive(cap) ? brandGsi2(cap.brand, cap.variant, cap.capId) : {}),
  };
}

export function historyItem(h: CapHistory): Item {
  return { ...h, pk: capPk(h.capId), sk: historySk(h.ts) };
}

export function lockKey(uid: string, cap: Cap, albumId?: string): Key | undefined {
  const pocket = pocketOf(cap, albumId);
  return pocket ? { pk: userPk(uid), sk: lockSk(pocket.albumId, pocket.loc) } : undefined;
}

function checkWrite(write: CapWrite): void {
  if (write.history.capId !== write.cap.capId) throw new Error('history entry belongs to another cap');
}

/** Create: cap must not exist; lock (if any) must be free; history ts unique. */
export function planCreate(uid: string, write: CapWrite): Op[] {
  checkWrite(write);
  const ops: Op[] = [
    { op: 'put', item: capItem(uid, write.cap, write.albumId), ifNotExists: true },
    { op: 'put', item: historyItem(write.history), ifNotExists: true },
  ];
  const lock = lockKey(uid, write.cap, write.albumId);
  if (lock) ops.push({ op: 'put', item: { ...lock, capId: write.cap.capId }, ifNotExists: true });
  return ops;
}

/** Replace: stored `updatedAt` must still be the one read; the lock moves only when the pocket changes. */
export function planPatch(uid: string, prev: CapPrevious, write: CapWrite): Op[] {
  checkWrite(write);
  if (prev.cap.capId !== write.cap.capId) throw new Error('patch changes the capId');
  const ops: Op[] = [
    { op: 'put', item: capItem(uid, write.cap, write.albumId), ifUpdatedAt: prev.cap.updatedAt },
    { op: 'put', item: historyItem(write.history), ifNotExists: true },
  ];
  const before = lockKey(uid, prev.cap, prev.albumId);
  const after = lockKey(uid, write.cap, write.albumId);
  if (before?.sk !== after?.sk) {
    if (before) ops.push({ op: 'delete', key: before, ifCapId: prev.cap.capId });
    if (after) ops.push({ op: 'put', item: { ...after, capId: write.cap.capId }, ifNotExists: true });
  }
  return ops;
}

/** Tombstone of `prev` at `history.ts` (ADR-006). */
export function tombstone(prev: Cap, history: CapHistory): Cap {
  return { ...prev, deletedAt: history.ts, updatedAt: history.ts };
}

/** Opaque page cursor: base64url(JSON(key)) — the same for both repositories. */
export function encodeCursor(key: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(key), 'utf8').toString('base64url');
}

/** Decodes a cursor and checks it belongs to `pk` (a cursor cannot walk another user's partition). */
export function decodeCursor(cursor: string, pk: string): Key {
  let key: unknown;
  try {
    key = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    throw new BadRequest('Invalid cursor');
  }
  const k = key as Partial<Key> | null;
  if (typeof k?.pk !== 'string' || typeof k.sk !== 'string' || k.pk !== pk) throw new BadRequest('Invalid cursor');
  return { pk: k.pk, sk: k.sk };
}

export function pageSize(limit: number | undefined, def: number, max: number): number {
  if (limit === undefined) return def;
  if (!Number.isInteger(limit) || limit < 1 || limit > max) throw new BadRequest(`limit must be 1–${max}`);
  return limit;
}

/** Pocket number from a GSI1 sort key, using keys.ts's own format (no key spelled here). */
const POCKET_PREFIX = locationGsi1('_', { kind: 'album', album: 'A', sheet: 1, pocket: 1 }).gsi1sk.replace(/\d+$/, '');
export function pocketFromGsi1Sk(sk: string): number {
  return Number(sk.slice(POCKET_PREFIX.length));
}

/** GSI1 partition of one sheet, from keys.ts. */
export function gsi1Pk(albumId: string, sheet: number): string {
  return locationGsi1(albumId, { kind: 'album', album: 'A', sheet, pocket: 1 }).gsi1pk;
}

/** GSI2 partition of one brand, from keys.ts. */
export function gsi2Pk(brand: string): string {
  return brandGsi2(brand, undefined, '').gsi2pk;
}

/** GSI2 sort-key prefix for one brand+variant (`VAR#<v>#CAP#`), derived from keys.ts. */
export function gsi2VariantPrefix(brand: string, variant: string): string {
  return brandGsi2(brand, variant, '').gsi2sk;
}

/** A cap item reduced to the GSI projection (data-model.md § Indexes). */
export function toIndexEntry(item: Record<string, unknown>): CapIndexEntry {
  const c = item as unknown as Cap;
  return {
    capId: c.capId,
    brand: c.brand,
    ...(c.variant === undefined ? {} : { variant: c.variant }),
    images: c.images,
    status: c.status,
  };
}
