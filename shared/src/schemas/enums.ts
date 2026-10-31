// Enumerations shared by every entity (doc/spec/CONVENTIONS.md § Domain vocabulary, ADR-006). Owned by the architect.
import { z } from 'zod';

/** Lifecycle of a cap record (data-model.md). */
export const CapStatus = z.enum(['complete', 'needsReview', 'unidentified']);
export type CapStatus = z.infer<typeof CapStatus>;

/** Kind of physical storage; only `album` has sheets and pockets (ADR-005). */
export const LocationKind = z.enum(['album', 'box', 'frame']);
export type LocationKind = z.infer<typeof LocationKind>;

/** Drink category printed on the cap (exchange.md § request.json schema). */
export const CapType = z.enum(['beer', 'soft drink', 'water', 'cider', 'wine', 'other']);
export type CapType = z.infer<typeof CapType>;

export const Material = z.enum(['steel', 'aluminium', 'plastic']);
export type Material = z.infer<typeof Material>;

export const Closure = z.enum(['pry-off', 'twist-off']);
export type Closure = z.infer<typeof Closure>;

export const Condition = z.enum(['mint', 'good', 'worn', 'damaged']);
export type Condition = z.infer<typeof Condition>;

/**
 * Provenance of a record or a change (data-model.md): `manual`, `import`, `bedrock:<modelId>` or
 * `external:<provider>`. Kept as a pattern, not an enum, so new models/providers need no contract bump.
 */
export const Source = z
  .string()
  .regex(/^(manual|import|bedrock:[A-Za-z0-9._:-]+|external:[a-z0-9][a-z0-9._-]*)$/, 'invalid source');
export type Source = z.infer<typeof Source>;

/** ISO 3166-1 alpha-2, upper case. */
export const CountryCode = z.string().regex(/^[A-Z]{2}$/, 'ISO 3166-1 alpha-2 expected');

/** ULID: 26 Crockford base32 chars (CONVENTIONS.md § Identifiers). */
export const Ulid = z.string().regex(/^[0-9A-HJKMNP-TV-Z]{26}$/, 'ULID expected');

/** 64-bit difference hash as 16 lower-case hex chars (ADR-004). */
export const DHash = z.string().regex(/^[0-9a-f]{16}$/, '16 hex chars expected');

/** ISO 8601 instant. */
export const Instant = z.iso.datetime({ offset: true });

/** Calendar date `YYYY-MM-DD`. */
export const CalendarDate = z.iso.date();

export const Year = z.number().int().min(1850).max(2100);
export const Confidence = z.number().min(0).max(1);
