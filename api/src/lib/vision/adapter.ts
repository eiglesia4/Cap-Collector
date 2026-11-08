// Vision adapter (ADR-004 step 2, CAP-37): the only door from the API to an AI that identifies a cap from its photos.
// Handlers and lib/scans.ts depend on this interface; `CAP_VISION` picks the implementation: Bedrock (CAP-39, deployed),
// fixtures (api:local) or none (`StubVisionAdapter` → 503, openapi.yaml /scans/analyse).
import type { AnalyseRequest, CapFields } from '@capcollector/shared';

import { type Config, getConfig } from '../config.js';
import { getS3 } from '../images.js';
import { BedrockVisionAdapter, createBedrockClient } from './bedrock.js';
import { FakeVisionAdapter } from './fake.js';

/** What the adapter is given: the uploaded image keys and, on re-identify, what the record already has. */
export interface IdentifyInput {
  imageKeys: AnalyseRequest['imageKeys'];
  known?: NonNullable<AnalyseRequest['known']>;
}

/** Token use and cost of one identification, stored on the Scan item (data-model.md § Scan). */
export interface VisionUsage {
  inputTokens: number;
  outputTokens: number;
  /** Absent when the model has no known price (vision/prices.ts): never a guess (CAP-39). */
  costEstimateUsd?: number;
}

/** What normalising the answer left out (exchange.md § Upload answer): unknown keys and unparseable values. */
interface AnswerNotes {
  ignored?: string[];
  problems?: string[];
}

export type IdentifyResult =
  /** The model could not be reached (not configured, throttled, down). The client falls back to manual / exchange. */
  | { status: 'unavailable'; reason: string }
  /** The model named the cap: `fields.brand` is what step 3 re-checks. */
  | ({
      status: 'identified';
      aiModel: string;
      fields: Partial<CapFields> & { brand: string };
      confidence?: Record<string, number>;
      aiConfidence?: number;
      usage?: VisionUsage;
    } & AnswerNotes)
  /** The model answered but could not name the cap; `suggestions` are brands read from the text on it. */
  | ({
      status: 'unidentified';
      aiModel: string;
      suggestions: string[];
      aiConfidence?: number;
      usage?: VisionUsage;
    } & AnswerNotes);

export interface VisionAdapter {
  identify(input: IdentifyInput): Promise<IdentifyResult>;
}

/** `CAP_VISION=off`: no model; every identification is unavailable (→ 503, the client goes manual / exchange). */
export class StubVisionAdapter implements VisionAdapter {
  async identify(): Promise<IdentifyResult> {
    return { status: 'unavailable', reason: 'no vision model configured' };
  }
}

let adapter: VisionAdapter | undefined;

/**
 * The adapter `CAP_VISION` selects (CAP-39): `bedrock` (default; `CAP_BEDROCK_MODEL_ID` required, set by infra on
 * scans-analyse, CAP-40), `fake` (fixtures, api:local) or `off` (always unavailable → 503).
 */
export function createVisionAdapter(config: Config = getConfig()): VisionAdapter {
  if (config.vision === 'off') return new StubVisionAdapter();
  if (config.vision === 'fake') return new FakeVisionAdapter();
  if (!config.bedrockModelId) {
    throw new Error('Invalid API configuration: CAP_BEDROCK_MODEL_ID is required when CAP_VISION=bedrock');
  }
  return new BedrockVisionAdapter({
    bedrock: createBedrockClient(),
    s3: getS3(),
    bucket: config.imagesBucket,
    modelId: config.bedrockModelId,
    ...(config.bedrockPrice ? { price: config.bedrockPrice } : {}),
  });
}

/** The adapter of this Lambda (memoised per cold start). */
export function getVisionAdapter(): VisionAdapter {
  adapter ??= createVisionAdapter();
  return adapter;
}

/** Test seam: inject a fake adapter, or `undefined` to go back to the default. */
export function setVisionAdapter(next: VisionAdapter | undefined): void {
  adapter = next;
}
