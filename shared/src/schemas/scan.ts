// Scan = one capture attempt and its outcome (ADR-003, ADR-004) and the /scans/analyse request/response. Owned by the architect.
import { z } from 'zod';

import { CapFields } from './cap.js';
import { Confidence, DHash, Instant, Ulid } from './enums.js';

/** The three outcomes every scan ends in (ADR-003). */
export const ScanOutcome = z.enum(['duplicate', 'identified', 'unidentified']);
export type ScanOutcome = z.infer<typeof ScanOutcome>;

/** Per-field confidence; keys are `CapFields` names. */
export const FieldConfidence = z.record(z.string(), Confidence);

/** What the client sends after shooting: hashes first, image keys already uploaded via presigned PUT. */
export const AnalyseRequest = z
  .object({
    scanId: Ulid,
    dhash: DHash,
    dhashUnderside: DHash.optional(),
    imageKeys: z.object({ top: z.string().min(1), underside: z.string().min(1).optional() }),
    /** What the record already has, when re-identifying an existing cap. */
    known: CapFields.partial().optional(),
    capId: Ulid.optional(),
    /** Pre-assigned pocket when the scan started from an empty cell of the sheet view. */
    targetLocationCode: z.string().optional(),
    /** `false` skips Bedrock (settings "AI off"): duplicate check only, then manual / exchange. */
    useAi: z.boolean().default(true),
  })
  .strict();
export type AnalyseRequest = z.infer<typeof AnalyseRequest>;

export const DuplicateMatch = z.object({
  capId: Ulid,
  hammingDistance: z.number().int().min(0).max(64),
  /** `dhash` = image near-match (step 1); `brand` = normalised brand+variant match after identification (step 3). */
  by: z.enum(['dhash', 'brand']),
});

/** Result of `POST /scans/analyse`. Exactly one of `match` / `fields` is relevant per outcome. */
export const AnalyseResponse = z.object({
  scanId: Ulid,
  outcome: ScanOutcome,
  match: DuplicateMatch.optional(),
  fields: CapFields.partial().optional(),
  confidence: FieldConfidence.optional(),
  aiModel: z.string().optional(),
  /** Brand suggestions for the manual form when `unidentified` (from `textOnCap`). */
  suggestions: z.array(z.string()).max(5).default([]),
});
export type AnalyseResponse = z.infer<typeof AnalyseResponse>;

/** Stored `SCAN#<ts>#<scanId>` item: everything needed to tune the threshold and watch AI cost later. */
export const Scan = z.object({
  scanId: Ulid,
  ts: Instant,
  dhash: DHash,
  dhashUnderside: DHash.optional(),
  outcome: ScanOutcome,
  match: DuplicateMatch.optional(),
  bestDistance: z.number().int().min(0).max(64).optional(),
  threshold: z.number().int().min(0).max(64),
  aiCalled: z.boolean(),
  aiModel: z.string().optional(),
  aiConfidence: Confidence.optional(),
  inputTokens: z.number().int().min(0).optional(),
  outputTokens: z.number().int().min(0).optional(),
  costEstimateUsd: z.number().min(0).optional(),
  /** Set when the scan was saved as a cap, or resolved into an existing one. */
  resultCapId: Ulid.optional(),
  exchangeRequestId: Ulid.optional(),
});
export type Scan = z.infer<typeof Scan>;
