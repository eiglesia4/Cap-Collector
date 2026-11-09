// "Continue to review" for an external AI's answer (CAP-45; exchange.md § Flow step 4; ADR-003 three outcomes; ADR-004
// duplicate checks; SCREENS.md § Navigation "Continue to review → screen 3 or 4 with source = external:<provider>"):
// the answer's photos become a capture context, `POST /scans/analyse` runs with `useAi: false` and `known` = the
// answer's fields (the dHash step), the brand + variant re-check runs here, and the outcome routes to Already in
// collection (CAP-42) or AI review (CAP-43). The pending request goes `reviewed` once the review saves.
import {
  AnalyseResponse,
  ExchangeRequestItem,
  normaliseBrand,
  type AnalyseRequest,
  type Cap,
  type PartialCapFields,
  type ImageRef,
  type Source,
} from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import type { CaptureSession, CaptureStore } from '../capture/context.js';
import { OUTCOME_PATHS } from '../capture/flow.js';
import { CapPageSchema } from '../collection/cap-page.js';
import { hammingDistance } from '../images/dhash.js';
import type { CapPhoto } from '../images/resize.js';
import type { Side } from '../images/upload.js';

/** Caps fetched for the brand re-check (`GET /caps?q=<brand>`). */
export const BRAND_CHECK_LIMIT = 60;

export interface ReviewPhotos {
  readonly top: { readonly photo: CapPhoto; readonly ref?: ImageRef };
  readonly underside?: { readonly photo: CapPhoto; readonly ref?: ImageRef };
}

export interface ContinueDeps {
  readonly api: Pick<ApiClient, 'request'>;
  readonly capture: CaptureStore;
  upload(side: Side, photo: CapPhoto): Promise<ImageRef>;
  newId(): string;
}

export interface ContinueInput {
  readonly photos: ReviewPhotos;
  readonly fields: PartialCapFields;
  readonly confidence: Readonly<Record<string, number>>;
  readonly source: Source;
  readonly requestId?: string;
  /** The answer's notes and ignored fields, pre-filled in the review's notes. */
  readonly notes?: string;
}

const sameVariant = (a: string | undefined, b: string | undefined) =>
  normaliseBrand(a ?? '') === normaliseBrand(b ?? '');

/**
 * ADR-004 step 3 for an answer that skipped the AI: a live cap with the same normalised brand + variant.
 * SPEC-GAP CAP-45: the story says the brand step "runs server-side without AI", but `POST /scans/analyse` with
 * `useAi: false` stops after the dHash step (api/src/lib/scans.ts); the same rule runs here over `GET /caps?q=<brand>`.
 */
export async function brandMatch(
  api: Pick<ApiClient, 'request'>,
  fields: PartialCapFields,
  dhash: string,
): Promise<AnalyseResponse['match'] | undefined> {
  const brand = fields.brand;
  if (brand === undefined || normaliseBrand(brand) === '') return undefined;
  const query = new URLSearchParams({ q: brand, limit: String(BRAND_CHECK_LIMIT) });
  const page = await api.request(`/caps?${query.toString()}`, { schema: CapPageSchema });
  const hit: Cap | undefined = page.items.find(
    (c) => normaliseBrand(c.brand) === normaliseBrand(brand) && sameVariant(c.variant, fields.variant),
  );
  if (!hit) return undefined;
  // Same rule as CAP-37: the image distance to the matched cap, or 64 when it has no stored hash.
  const distance = hit.dhash !== undefined ? hammingDistance(dhash, hit.dhash) : 64;
  return { capId: hit.capId, hammingDistance: distance, by: 'brand' };
}

/** Uploads what is not uploaded, opens the capture context, analyses without AI and returns the review route. */
export async function continueToReview(deps: ContinueDeps, input: ContinueInput): Promise<string> {
  const { photos } = input;
  const topRef = photos.top.ref ?? (await deps.upload('top', photos.top.photo));
  const underside = photos.underside;
  const undersideRef = underside ? (underside.ref ?? (await deps.upload('underside', underside.photo))) : undefined;
  const session: CaptureSession = deps.capture.start({
    scanId: deps.newId(),
    useAi: false,
    top: { photo: photos.top.photo, ref: topRef },
    ...(underside && undersideRef ? { underside: { photo: underside.photo, ref: undersideRef } } : {}),
    exchange: {
      source: input.source,
      ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
    },
  });
  const body: AnalyseRequest = {
    scanId: session.scanId,
    dhash: photos.top.photo.dhash,
    imageKeys: { top: topRef.key },
    known: { ...input.fields },
    useAi: false,
  };
  if (underside && undersideRef) {
    body.dhashUnderside = underside.photo.dhash;
    body.imageKeys.underside = undersideRef.key;
  }
  const response = await deps.api.request('/scans/analyse', { method: 'POST', body, schema: AnalyseResponse });
  const match =
    response.outcome === 'duplicate' ? response.match : await brandMatch(deps.api, input.fields, body.dhash);
  session.response = {
    scanId: session.scanId,
    outcome: match ? 'duplicate' : 'identified',
    ...(match ? { match } : {}),
    fields: { ...input.fields },
    confidence: { ...input.confidence },
    suggestions: [],
  };
  return match ? OUTCOME_PATHS.duplicate : OUTCOME_PATHS.identified;
}

/** After the review saved: the pending request is `reviewed` (best effort — the cap is saved either way). */
export async function markReviewed(
  api: Pick<ApiClient, 'request'>,
  session: CaptureSession | undefined,
): Promise<void> {
  await markRequest(api, session?.exchange?.requestId, { status: 'reviewed' });
}

export async function markRequest(
  api: Pick<ApiClient, 'request'>,
  requestId: string | undefined,
  body: { status: 'answered'; provider: string } | { status: 'reviewed' },
): Promise<boolean> {
  if (requestId === undefined) return false;
  try {
    await api.request(`/exchange/requests/${encodeURIComponent(requestId)}`, {
      method: 'PATCH',
      body,
      schema: ExchangeRequestItem,
    });
    return true;
  } catch {
    return false;
  }
}
