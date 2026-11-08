// Scans service (CAP-37): POST /scans/analyse and GET /scans behind thin handlers. Spec: ADR-004 (hash first, AI
// second, brand re-check), ADR-003 (every capture ends in one of three outcomes), openapi.yaml /scans/analyse
// ("nothing is saved" except the Scan item), data-model.md § Scan and § dHash comparison (in-memory Hamming over the
// user's live caps). Invariant (CLAUDE.md): the vision adapter is called ONLY when no stored hash is a near-match.
import { type AnalyseRequest, AnalyseResponse, Scan, type ScanOutcome, normaliseBrand } from '@capcollector/shared';
import { z } from 'zod';

import { ServiceUnavailable } from './errors.js';
import { ValidationError } from './http.js';
import { ownsKey } from './images.js';
import type { Page, Repositories } from './repo/types.js';
import { now } from './time.js';
import type { IdentifyResult, VisionAdapter } from './vision/adapter.js';

export const SCANS_DEFAULT_LIMIT = 50;
export const SCANS_MAX_LIMIT = 200;

/** Query of GET /scans (openapi.yaml: limit default 50, max 200; opaque cursor). */
export const ScanListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(SCANS_MAX_LIMIT).default(SCANS_DEFAULT_LIMIT),
  cursor: z.string().optional(),
});
export type ScanListQuery = z.infer<typeof ScanListQuery>;

/** Bits that differ between two 64-bit dHashes given as 16 hex chars (shared `DHash`). */
export function hammingDistance(a: string, b: string): number {
  let x = BigInt(`0x${a}`) ^ BigInt(`0x${b}`);
  let bits = 0;
  while (x > 0n) {
    bits += Number(x & 1n);
    x >>= 1n;
  }
  return bits;
}

interface Nearest {
  capId: string;
  distance: number;
}

/**
 * Closest live cap by image (ADR-004 step 1): the top hash against every stored top hash, and the underside against
 * stored undersides when both sides have one; a cap's distance is the smaller of the two. Ties keep the first found.
 */
export function nearestByHash(
  hashes: readonly { capId: string; dhash?: string; dhashUnderside?: string }[],
  dhash: string,
  dhashUnderside: string | undefined,
): Nearest | undefined {
  let best: Nearest | undefined;
  for (const h of hashes) {
    const ds = [
      ...(h.dhash ? [hammingDistance(dhash, h.dhash)] : []),
      ...(dhashUnderside && h.dhashUnderside ? [hammingDistance(dhashUnderside, h.dhashUnderside)] : []),
    ];
    if (ds.length === 0) continue;
    const distance = Math.min(...ds);
    if (!best || distance < best.distance) best = { capId: h.capId, distance };
  }
  return best;
}

export interface AnalyseDeps {
  repos: Repositories;
  vision: VisionAdapter;
  /** `CAP_DHASH_THRESHOLD` (config): max distance that still counts as a duplicate. */
  threshold: number;
}

/** The image keys must be this user's uploads (`<uid>/<ulid>/<side>.webp`, CAP-20): the adapter reads them from S3. */
function assertOwnImageKeys(uid: string, keys: AnalyseRequest['imageKeys']): void {
  const issues = (['top', 'underside'] as const).flatMap((side) => {
    const key = keys[side];
    return key !== undefined && !ownsKey(uid, key)
      ? [{ code: 'custom' as const, path: ['imageKeys', side], message: 'not an image key of this user', input: key }]
      : [];
  });
  if (issues.length > 0) throw new ValidationError(new z.ZodError(issues), 'body');
}

/** Same normalisation as GSI2 (shared keys.ts) so "Clásica" and "clasica" are one variant; absent = no variant. */
const sameVariant = (a: string | undefined, b: string | undefined) =>
  normaliseBrand(a ?? '') === normaliseBrand(b ?? '');

/**
 * POST /scans/analyse. Writes exactly one item — the `Scan` (`SCAN#<ts>#<scanId>`) — whatever the outcome, including
 * when the model is unavailable (stored with `aiCalled: true`, no `aiModel`, `unidentified`), then answers 503.
 */
export async function analyse(deps: AnalyseDeps, uid: string, req: AnalyseRequest): Promise<AnalyseResponse> {
  assertOwnImageKeys(uid, req.imageKeys);
  const { repos, vision, threshold } = deps;
  // Re-identify (`capId` present) must not find the cap being re-identified.
  const hashes = (await repos.caps.hashes(uid)).filter((h) => h.capId !== req.capId);
  const nearest = nearestByHash(hashes, req.dhash, req.dhashUnderside);

  const base = {
    scanId: req.scanId,
    ts: now(),
    dhash: req.dhash,
    ...(req.dhashUnderside ? { dhashUnderside: req.dhashUnderside } : {}),
    ...(nearest ? { bestDistance: nearest.distance } : {}),
    threshold,
  };
  const store = (scan: Omit<Scan, keyof typeof base>) => repos.scans.put(uid, Scan.parse({ ...base, ...scan }));
  const answer = (r: Omit<AnalyseResponse, 'scanId' | 'suggestions'> & { suggestions?: string[] }) =>
    AnalyseResponse.parse({ scanId: req.scanId, ...r });

  // Step 1 — near-match by image: duplicate, the AI is never called.
  if (nearest && nearest.distance <= threshold) {
    const match = { capId: nearest.capId, hammingDistance: nearest.distance, by: 'dhash' as const };
    await store({ outcome: 'duplicate', match, aiCalled: false });
    return answer({ outcome: 'duplicate', match });
  }

  // "AI off": duplicate check only, then manual / exchange.
  if (!req.useAi) {
    await store({ outcome: 'unidentified', aiCalled: false });
    return answer({ outcome: 'unidentified', suggestions: [] });
  }

  // Step 2 — the vision model.
  const known = req.known;
  const result: IdentifyResult = await vision.identify({ imageKeys: req.imageKeys, ...(known ? { known } : {}) });
  if (result.status === 'unavailable') {
    await store({ outcome: 'unidentified', aiCalled: true });
    throw new ServiceUnavailable('AI identification is unavailable; continue with manual entry or exchange');
  }
  const ai = {
    aiCalled: true,
    aiModel: result.aiModel,
    ...(result.aiConfidence === undefined ? {} : { aiConfidence: result.aiConfidence }),
    ...(result.usage ?? {}),
  };
  if (result.status === 'unidentified') {
    await store({ outcome: 'unidentified', ...ai });
    return answer({ outcome: 'unidentified', aiModel: result.aiModel, suggestions: result.suggestions.slice(0, 5) });
  }

  // Step 3 — normalised brand + variant re-check over GSI2, limited to this user's live caps.
  const mine = new Map(hashes.map((h) => [h.capId, h]));
  const { brand, variant } = result.fields;
  const hit = (await repos.caps.listGsi2(brand, variant)).find(
    (e) => mine.has(e.capId) && sameVariant(e.variant, variant),
  );
  const outcome: ScanOutcome = hit ? 'duplicate' : 'identified';
  if (hit) {
    // SPEC-GAP CAP-37: `DuplicateMatch.hammingDistance` is required even for `by: brand`; we report the image distance
    // to the matched cap, or 64 (maximally different) when that cap has no stored hash.
    const stored = mine.get(hit.capId);
    const d = nearestByHash(stored ? [stored] : [], req.dhash, req.dhashUnderside)?.distance ?? 64;
    const match = { capId: hit.capId, hammingDistance: d, by: 'brand' as const };
    await store({ outcome, match, ...ai });
    return answer({ outcome, match, fields: result.fields, aiModel: result.aiModel, ...confidenceOf(result) });
  }
  await store({ outcome, ...ai });
  return answer({ outcome, fields: result.fields, aiModel: result.aiModel, ...confidenceOf(result) });
}

const confidenceOf = (r: { confidence?: Record<string, number> }) => (r.confidence ? { confidence: r.confidence } : {});

/** GET /scans: newest first, cursor-paged (openapi.yaml /scans). */
export async function listScans(repos: Repositories, uid: string, q: ScanListQuery): Promise<Page<Scan>> {
  return repos.scans.list(uid, { limit: q.limit, ...(q.cursor ? { cursor: q.cursor } : {}) });
}
