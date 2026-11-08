// Bedrock on-demand prices for the cost estimate stored on each Scan (CAP-39, data-model.md § Scan `costEstimateUsd`).
// USD per 1k tokens, by foundation model id (a cross-region inference profile `eu.` / `us.` / `apac.` / `global.`
// prefix is stripped). Config `CAP_BEDROCK_PRICE_IN` / `_OUT` overrides the table; an unknown model gets NO cost —
// an estimate is never guessed. Source: AWS Bedrock pricing page (Anthropic models), checked 2026-11-08.

export interface Price {
  inPer1k: number;
  outPer1k: number;
}

export const PRICE_TABLE: Readonly<Record<string, Price>> = {
  'anthropic.claude-haiku-4-5-20251001-v1:0': { inPer1k: 0.001, outPer1k: 0.005 },
  'anthropic.claude-3-5-haiku-20241022-v1:0': { inPer1k: 0.0008, outPer1k: 0.004 },
  'anthropic.claude-3-haiku-20240307-v1:0': { inPer1k: 0.00025, outPer1k: 0.00125 },
  'anthropic.claude-sonnet-4-5-20250929-v1:0': { inPer1k: 0.003, outPer1k: 0.015 },
};

const PROFILE_PREFIX = /^(eu|us|apac|global|us-gov|jp|au|ca)\./;

/** The price of `modelId`: the override when given, else the table entry, else undefined. */
export function priceFor(modelId: string, override?: Price): Price | undefined {
  return override ?? PRICE_TABLE[modelId.replace(PROFILE_PREFIX, '')];
}

/** Rounded to 6 decimals (micro-dollars); undefined when the price is unknown. */
export function costUsd(price: Price | undefined, inputTokens: number, outputTokens: number): number | undefined {
  if (!price) return undefined;
  const usd = (inputTokens / 1000) * price.inPer1k + (outputTokens / 1000) * price.outPer1k;
  return Math.round(usd * 1e6) / 1e6;
}
