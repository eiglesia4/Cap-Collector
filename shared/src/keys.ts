// DynamoDB single-table keys — the ONLY place keys are built (data-model.md, Agreed 2026-10-31). Owned by the architect.
// api/ imports these; a key written any other way is a contract violation (CLAUDE.md "Nunca inventes claves").
import type { AlbumLocation } from './schemas/location.js';

export const TABLE_ATTRIBUTES = {
  pk: 'pk',
  sk: 'sk',
  gsi1pk: 'gsi1pk',
  gsi1sk: 'gsi1sk',
  gsi2pk: 'gsi2pk',
  gsi2sk: 'gsi2sk',
  ttl: 'ttl',
} as const;

export const INDEXES = { location: 'GSI1', brand: 'GSI2' } as const;

export const userPk = (uid: string) => `USER#${uid}` as const;
export const capPk = (capId: string) => `CAP#${capId}` as const;

export const capSk = (capId: string) => `CAP#${capId}` as const;
export const historySk = (ts: string) => `HIST#${ts}` as const;
export const scanSk = (ts: string, scanId: string) => `SCAN#${ts}#${scanId}` as const;
export const exchangeSk = (requestId: string) => `EXCHANGE#${requestId}` as const;
export const albumSk = (albumId: string) => `ALBUM#${albumId}` as const;
export const wishSk = (id: string) => `WISH#${id}` as const;
/** Pocket occupancy marker, written transactionally with the cap (data-model.md § Invariants): one cap per pocket. */
export const lockSk = (albumId: string, loc: AlbumLocation) => `LOCK#${albumId}#${loc.sheet}#${loc.pocket}` as const;

/** Sort-key prefixes for `begins_with` queries on a user's partition. */
export const SK_PREFIX = {
  cap: 'CAP#',
  scan: 'SCAN#',
  exchange: 'EXCHANGE#',
  album: 'ALBUM#',
  wish: 'WISH#',
  lock: 'LOCK#',
} as const;

/** GSI1 — sheet view in one query. Pocket zero-padded to 2 digits so range queries sort numerically. */
export const locationGsi1 = (albumId: string, loc: AlbumLocation) => ({
  gsi1pk: `LOC#${albumId}#${loc.sheet}`,
  gsi1sk: `POCKET#${String(loc.pocket).padStart(2, '0')}`,
});

/**
 * Brand normalisation shared by GSI2 and the post-identification duplicate check (ADR-004 step 3):
 * lower-case, accents stripped, non-alphanumerics removed. "Estrella Galicia 1906" → "estrellagalicia1906".
 */
export function normaliseBrand(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

/** GSI2 — variants of a brand and name-based duplicate check. Variant goes in the SK so a brand query lists all. */
export const brandGsi2 = (brand: string, variant: string | undefined, capId: string) => ({
  gsi2pk: `BRAND#${normaliseBrand(brand)}`,
  gsi2sk: `VAR#${variant ? normaliseBrand(variant) : '_'}#CAP#${capId}`,
});

/** 30-day TTL for exchange requests (exchange.md § Pending requests), as epoch seconds. */
export const EXCHANGE_TTL_SECONDS = 30 * 24 * 3600;
export const exchangeTtl = (createdAtMs: number) => Math.floor(createdAtMs / 1000) + EXCHANGE_TTL_SECONDS;

/** Attributes projected into GSI1/GSI2 (keys + these). Anything else needs a GetItem. */
export const GSI_PROJECTION = ['capId', 'brand', 'variant', 'images', 'status', 'deletedAt'] as const;
