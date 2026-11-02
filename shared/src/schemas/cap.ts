// The Cap record, its images and its append-only history (ADR-006, data-model.md). Owned by the architect.
import { z } from 'zod';

import {
  CalendarDate,
  CapStatus,
  CapType,
  Closure,
  Condition,
  Confidence,
  CountryCode,
  DHash,
  Instant,
  Material,
  Source,
  Ulid,
  Year,
} from './enums.js';
import { Location } from './location.js';

/** A stored image: S3 object key relative to the images bucket, plus its pixel size (WebP ≤ 1024 px long edge). */
export const ImageRef = z.object({
  key: z.string().min(1),
  width: z.number().int().min(1).max(1024),
  height: z.number().int().min(1).max(1024),
  bytes: z.number().int().min(1).optional(),
});
export type ImageRef = z.infer<typeof ImageRef>;

export const CapImages = z.object({
  top: ImageRef,
  underside: ImageRef.optional(),
});

/** Presigned GET URLs (≈5 min) the API adds to cap responses (v0.2, CAP-20). Never stored; absent on writes. */
export const ImageUrls = z.object({
  top: z.string().url(),
  underside: z.string().url().optional(),
});
export type ImageUrls = z.infer<typeof ImageUrls>;

/**
 * Fields the user (or an AI) fills in. Shared by the review form, the exchange `response.fields`
 * (nullable variant below) and the API bodies. `brand` is the only required one (features.md).
 */
export const CapFields = z.object({
  brand: z.string().trim().min(1).max(80),
  variant: z.string().trim().min(1).max(80).optional(),
  producer: z.string().trim().min(1).max(120).optional(),
  country: CountryCode.optional(),
  type: CapType.optional(),
  material: Material.optional(),
  closure: Closure.optional(),
  year: Year.optional(),
  description: z.string().trim().max(1000).optional(),
  /** Literal text read on the cap; feeds brand suggestions when identification fails. */
  textOnCap: z.string().trim().max(200).optional(),
});
export type CapFields = z.infer<typeof CapFields>;

/** Collector's own data, never produced by an AI. */
export const CapOwnership = z.object({
  condition: Condition.optional(),
  acquiredWhere: z.string().trim().max(120).optional(),
  acquiredOn: CalendarDate.optional(),
  tags: z.array(z.string().trim().min(1).max(30)).max(20).default([]),
  notes: z.string().trim().max(2000).optional(),
  quantity: z.number().int().min(1).default(1),
  forTrade: z.number().int().min(0).default(0),
  location: Location.optional(),
  /** Another cap of the same brand this one is an edition of (ADR-008: link, not a family record). */
  variantOf: Ulid.optional(),
});

/**
 * Provenance and AI bookkeeping (ADR-004). `source` here = how the record was born; each change's author lives in
 * `CapHistory.source` (decided in CAP-18: a PATCH never rewrites `Cap.source`).
 */
export const CapProvenance = z.object({
  source: Source,
  dhash: DHash.optional(),
  dhashUnderside: DHash.optional(),
  aiModel: z.string().max(120).optional(),
  aiConfidence: Confidence.optional(),
});

export const Cap = z
  .object({
    capId: Ulid,
    status: CapStatus,
    images: CapImages,
    createdAt: Instant,
    updatedAt: Instant,
    /** Tombstone (ADR-006): present → deleted; never physically removed. */
    deletedAt: Instant.optional(),
    /** Response-only: presigned read URLs for `images` (CAP-20 → v0.2). */
    imageUrls: ImageUrls.optional(),
  })
  .extend(CapFields.shape)
  .extend(CapOwnership.shape)
  .extend(CapProvenance.shape)
  .refine((c) => c.forTrade <= c.quantity, { message: 'forTrade cannot exceed quantity', path: ['forTrade'] })
  .refine((c) => c.variantOf !== c.capId, { message: 'a cap cannot be a variant of itself', path: ['variantOf'] });
export type Cap = z.infer<typeof Cap>;

/** Body of `POST /caps` and `PATCH /caps/{id}` — everything the client may set; server fills ids, dates, status rules. */
export const CapInput = CapFields.extend(CapOwnership.shape)
  .extend({
    images: CapImages,
    status: CapStatus.optional(),
    source: Source.default('manual'),
    dhash: DHash.optional(),
    dhashUnderside: DHash.optional(),
    aiModel: z.string().max(120).optional(),
    aiConfidence: Confidence.optional(),
  })
  .strict();
export type CapInput = z.infer<typeof CapInput>;

/**
 * Body of `PATCH /caps/{id}` (v0.2, CAP-18): only the keys present are applied — no defaults are filled in — and an
 * optional field is cleared by sending `null`. `source` names the author of this change (history entry), not a new
 * origin for the record. `images` cannot be nulled; `location` is rejected outright (own route).
 */
const patchOptional = <T extends z.ZodTypeAny>(schema: T) => schema.nullable().optional();
export const CapPatch = z
  .object({
    brand: CapFields.shape.brand.optional(),
    variant: patchOptional(CapFields.shape.variant.unwrap()),
    producer: patchOptional(CapFields.shape.producer.unwrap()),
    country: patchOptional(CountryCode),
    type: patchOptional(CapType),
    material: patchOptional(Material),
    closure: patchOptional(Closure),
    year: patchOptional(Year),
    description: patchOptional(CapFields.shape.description.unwrap()),
    textOnCap: patchOptional(CapFields.shape.textOnCap.unwrap()),
    condition: patchOptional(Condition),
    acquiredWhere: patchOptional(CapOwnership.shape.acquiredWhere.unwrap()),
    acquiredOn: patchOptional(CalendarDate),
    tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
    notes: patchOptional(CapOwnership.shape.notes.unwrap()),
    quantity: z.number().int().min(1).optional(),
    forTrade: z.number().int().min(0).optional(),
    variantOf: patchOptional(Ulid),
    /** Never patchable: location has its own route (`PUT/DELETE /caps/{id}/location`). Present → 422. */
    location: z.never().optional(),
    images: CapImages.optional(),
    status: CapStatus.optional(),
    source: Source.optional(),
    dhash: DHash.optional(),
    dhashUnderside: DHash.optional(),
    aiModel: patchOptional(z.string().max(120)),
    aiConfidence: patchOptional(Confidence),
  })
  .strict();
export type CapPatch = z.infer<typeof CapPatch>;

/** One field change inside a history entry. Values are JSON; `from` is absent on first set. */
export const FieldChange = z.object({
  field: z.string().min(1),
  from: z.unknown().optional(),
  to: z.unknown().optional(),
});

/** Append-only history item `HIST#<ts>` (ADR-006): who/what/when/source. */
export const CapHistory = z.object({
  capId: Ulid,
  ts: Instant,
  source: Source,
  action: z.enum(['created', 'updated', 'located', 'moved', 'swapped', 'deleted', 'restored', 'reidentified']),
  changes: z.array(FieldChange).default([]),
  scanId: Ulid.optional(),
  exchangeRequestId: Ulid.optional(),
  note: z.string().max(500).optional(),
});
export type CapHistory = z.infer<typeof CapHistory>;
