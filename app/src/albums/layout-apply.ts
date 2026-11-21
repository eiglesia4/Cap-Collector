// Applying an initial layout (CAP-75; physical-link.md § Initial layout: "one change per cap … resumable"): one
// `PUT /caps/{id}/location` per placement, sequentially and in plan order (no parallel storm), stopping on the first
// error so the screen can say which cap failed. Caps already placed are skipped, so a re-run resumes where it stopped.
// SPEC-GAP CAP-75: the spec wants the history reason "initial layout", but `PUT /caps/{id}/location` takes no note
// (openapi.yaml), so nothing extra is sent; the history entry is the API's own location change (source manual).
import type { ApiClient } from '../api/client.js';
import type { Placement } from './layout-plan.js';
import { putLocation } from './place.js';

export interface ApplyProgress {
  /** Placements handled so far (written or skipped). */
  readonly done: number;
  readonly total: number;
}

export type ApplyResult =
  | { readonly ok: true; readonly placed: number; readonly skipped: number }
  | {
      readonly ok: false;
      readonly placed: number;
      readonly skipped: number;
      readonly failed: Placement;
      readonly error: unknown;
    };

export async function applyLayout(
  api: ApiClient,
  placements: readonly Placement[],
  isPlaced: (capId: string) => boolean,
  onProgress: (progress: ApplyProgress) => void = () => undefined,
): Promise<ApplyResult> {
  let placed = 0;
  let skipped = 0;
  const total = placements.length;
  for (const placement of placements) {
    if (isPlaced(placement.capId)) {
      skipped += 1;
    } else {
      try {
        await putLocation(api, placement.capId, placement.location);
      } catch (error) {
        return { ok: false, placed, skipped, failed: placement, error };
      }
      placed += 1;
    }
    onProgress({ done: placed + skipped, total });
  }
  return { ok: true, placed, skipped };
}
