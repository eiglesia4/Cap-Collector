// Vision adapter (ADR-004 step 2, CAP-37): the only door from the API to an AI that identifies a cap from its photos.
// Handlers and lib/scans.ts depend on this interface; the Bedrock implementation lands in CAP-39. Until then the
// deployed Lambda uses `StubVisionAdapter`, which always answers `unavailable` (→ 503, openapi.yaml /scans/analyse).
import type { AnalyseRequest, CapFields } from '@capcollector/shared';

/** What the adapter is given: the uploaded image keys and, on re-identify, what the record already has. */
export interface IdentifyInput {
  imageKeys: AnalyseRequest['imageKeys'];
  known?: NonNullable<AnalyseRequest['known']>;
}

/** Token use and cost of one model call, stored on the Scan item (data-model.md § Scan). */
export interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
  costEstimateUsd: number;
}

export type IdentifyResult =
  /** The model could not be reached (not configured, throttled, down). The client falls back to manual / exchange. */
  | { status: 'unavailable'; reason: string }
  /** The model named the cap: `fields.brand` is what step 3 re-checks. */
  | {
      status: 'identified';
      aiModel: string;
      fields: Partial<CapFields> & { brand: string };
      confidence?: Record<string, number>;
      aiConfidence?: number;
      usage?: VisionUsage;
    }
  /** The model answered but could not name the cap; `suggestions` are brands read from the text on it. */
  | { status: 'unidentified'; aiModel: string; suggestions: string[]; aiConfidence?: number; usage?: VisionUsage };

export interface VisionAdapter {
  identify(input: IdentifyInput): Promise<IdentifyResult>;
}

/** CAP-37 placeholder: no model wired yet. CAP-39 replaces it with the Bedrock adapter. */
export class StubVisionAdapter implements VisionAdapter {
  async identify(): Promise<IdentifyResult> {
    return { status: 'unavailable', reason: 'no vision model configured' };
  }
}

let adapter: VisionAdapter | undefined;

/** The adapter of this Lambda (memoised per cold start). */
export function getVisionAdapter(): VisionAdapter {
  adapter ??= new StubVisionAdapter();
  return adapter;
}

/** Test seam: inject a fake adapter, or `undefined` to go back to the default. */
export function setVisionAdapter(next: VisionAdapter | undefined): void {
  adapter = next;
}
