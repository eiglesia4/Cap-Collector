// Per-model request capabilities of the Bedrock vision call (CAP-72, ADR-008 §7): how each Claude model must be asked so
// the JSON answer fits in `maxTokens`. Keyed by foundation model id; the inference-profile prefix (`eu.` / `us.` / …)
// is stripped first, as in the price table. A model not listed is treated as a classic one (no thinking by default).

export type ThinkingDefault = 'adaptive' | 'none';

export interface ModelCapabilities {
  /**
   * `adaptive`: the model thinks unless told not to (Claude Haiku 5.5); thinking tokens count against `maxTokens`, so
   * the adapter turns thinking off. It also rejects a non-default `temperature`, so none is sent.
   * `none`: thinks only when asked (Claude Haiku 4.5 and older); the request keeps `temperature: 0`.
   */
  thinkingDefault: ThinkingDefault;
}

export const MODEL_CAPABILITIES: Readonly<Record<string, ModelCapabilities>> = {
  'anthropic.claude-haiku-5-5': { thinkingDefault: 'adaptive' },
};

const CLASSIC: ModelCapabilities = { thinkingDefault: 'none' };

const PROFILE_PREFIX = /^(eu|us|apac|global|us-gov|jp|au|ca)\./;

/** `eu.anthropic.claude-haiku-5-5` → `anthropic.claude-haiku-5-5` (cross-region inference profile prefix removed). */
export function foundationModelId(modelId: string): string {
  return modelId.replace(PROFILE_PREFIX, '');
}

export function capabilitiesFor(modelId: string): ModelCapabilities {
  return MODEL_CAPABILITIES[foundationModelId(modelId)] ?? CLASSIC;
}
