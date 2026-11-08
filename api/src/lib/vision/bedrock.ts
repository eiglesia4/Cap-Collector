// Bedrock vision adapter (CAP-39, ADR-004 step 2, ADR-008 §7): identifies a cap from its photo(s) through the Converse
// API. Prompt = `EXCHANGE_INSTRUCTIONS` (system) + the photos + `EXCHANGE_FIELD_SCHEMA`, `known` and the empty
// `response` exactly as written into `request.json`; the answer is read by the exchange parser (answer.ts). Called ONLY
// after the dHash check found no near-match (lib/scans.ts, CLAUDE.md § Invariantes). Never logs images or the prompt.
import {
  BedrockRuntimeClient,
  type ContentBlock,
  ConverseCommand,
  type ConverseCommandOutput,
} from '@aws-sdk/client-bedrock-runtime';
import { GetObjectCommand, type GetObjectCommandOutput } from '@aws-sdk/client-s3';
import { EXCHANGE_FIELD_SCHEMA, EXCHANGE_INSTRUCTIONS, emptyExchangeResponse } from '@capcollector/shared';
import { z } from 'zod';

import { ValidationError } from '../http.js';
import type { IdentifyInput, IdentifyResult, VisionAdapter, VisionUsage } from './adapter.js';
import { type ParsedAnswer, parseAnswer, toResult } from './answer.js';
import { type Price, costUsd, priceFor } from './prices.js';

export const MAX_TOKENS = 600;
export const TEMPERATURE = 0;
/** One model call may take this long before the scan answers 503 (CAP-39). */
export const BEDROCK_TIMEOUT_MS = 8000;

/** The slice of the SDK clients the adapter uses, so tests pass a mock and never touch the network. */
export interface Sender<C, O> {
  send(command: C, options?: { abortSignal?: AbortSignal }): Promise<O>;
}

export interface BedrockAdapterOptions {
  bedrock: Sender<ConverseCommand, ConverseCommandOutput>;
  s3: Sender<GetObjectCommand, GetObjectCommandOutput>;
  bucket: string;
  modelId: string;
  /** Config override of the price table (`CAP_BEDROCK_PRICE_IN` / `_OUT`). */
  price?: Price;
  timeoutMs?: number;
  log?: (entry: Record<string, unknown>) => void;
}

const defaultLog = (entry: Record<string, unknown>) =>
  (entry.level === 'error' ? console.error : console.warn)(JSON.stringify(entry));

/** The text block next to the photos: schema, known fields and the `response` to fill (request.json, ADR-008 §7). */
export function promptText(input: IdentifyInput): string {
  const sides = input.imageKeys.underside ? 'top, underside' : 'top';
  return [
    `Photos attached in this order: ${sides}.`,
    `Field schema (\`schema\`): ${JSON.stringify(EXCHANGE_FIELD_SCHEMA)}`,
    `Already known, do not contradict (\`known\`): ${JSON.stringify(input.known ?? {})}`,
    `The \`response\` object to fill and return: ${JSON.stringify(emptyExchangeResponse())}`,
  ].join('\n');
}

export class BedrockVisionAdapter implements VisionAdapter {
  private readonly timeoutMs: number;
  private readonly log: (entry: Record<string, unknown>) => void;

  constructor(private readonly opts: BedrockAdapterOptions) {
    this.timeoutMs = opts.timeoutMs ?? BEDROCK_TIMEOUT_MS;
    this.log = opts.log ?? defaultLog;
  }

  async identify(input: IdentifyInput): Promise<IdentifyResult> {
    const images = await this.readImages(input.imageKeys);
    const command = new ConverseCommand({
      modelId: this.opts.modelId,
      system: [{ text: EXCHANGE_INSTRUCTIONS }],
      messages: [{ role: 'user', content: [...images, { text: promptText(input) }] }],
      inferenceConfig: { maxTokens: MAX_TOKENS, temperature: TEMPERATURE },
    });

    const tokens = { inputTokens: 0, outputTokens: 0 };
    let parsed: ParsedAnswer | undefined;
    // Malformed answer → one retry with the same request, then `unidentified` (CAP-39).
    for (let attempt = 1; attempt <= 2; attempt++) {
      let out: ConverseCommandOutput;
      try {
        out = await this.opts.bedrock.send(command, { abortSignal: AbortSignal.timeout(this.timeoutMs) });
      } catch (e) {
        return this.unavailable(e);
      }
      tokens.inputTokens += out.usage?.inputTokens ?? 0;
      tokens.outputTokens += out.usage?.outputTokens ?? 0;
      parsed = parseAnswer(answerText(out));
      if (parsed.ok) break;
      this.log({ level: 'warn', event: 'vision.malformed', attempt, problem: parsed.problem });
    }

    const result = toResult(parsed!, this.opts.modelId, this.usage(tokens));
    if (result.problems?.length || result.ignored?.length) {
      this.log({
        level: 'warn',
        event: 'vision.normalise',
        status: result.status,
        ignored: result.ignored ?? [],
        problems: result.problems ?? [],
      });
    }
    return result;
  }

  /** Throttling, 5xx, the 8 s timeout, or a misconfiguration: the client falls back to manual / exchange (503). */
  private unavailable(e: unknown): IdentifyResult {
    const name = e instanceof Error ? e.name : 'Error';
    const status = (e as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
    const transient =
      TRANSIENT.has(name) ||
      (status !== undefined && status >= 500) ||
      name === 'TimeoutError' ||
      name === 'AbortError';
    this.log({ level: transient ? 'warn' : 'error', event: 'vision.unavailable', error: name, httpStatus: status });
    return { status: 'unavailable', reason: transient ? `bedrock ${name}` : `bedrock misconfigured: ${name}` };
  }

  private usage(tokens: { inputTokens: number; outputTokens: number }): VisionUsage {
    const cost = costUsd(priceFor(this.opts.modelId, this.opts.price), tokens.inputTokens, tokens.outputTokens);
    return { ...tokens, ...(cost === undefined ? {} : { costEstimateUsd: cost }) };
  }

  /**
   * The stored WebP bytes (≤ 1024 px, CAP-20) of each side, top first. SPEC-GAP CAP-39: openapi /scans/analyse has no
   * answer for an owned key that was never uploaded; it is the client's mistake, so 422 (like a foreign key, CAP-37),
   * and Bedrock is not called. Any other S3 failure propagates (500).
   */
  private async readImages(keys: IdentifyInput['imageKeys']): Promise<ContentBlock[]> {
    const sides = (['top', 'underside'] as const).flatMap((side) => {
      const key = keys[side];
      return key ? [{ side, key }] : [];
    });
    return Promise.all(
      sides.map(async ({ side, key }): Promise<ContentBlock> => {
        let bytes: Uint8Array | undefined;
        try {
          const obj = await this.opts.s3.send(new GetObjectCommand({ Bucket: this.opts.bucket, Key: key }));
          bytes = await obj.Body?.transformToByteArray();
        } catch (e) {
          if (!(e instanceof Error && (e.name === 'NoSuchKey' || e.name === 'NotFound'))) throw e;
        }
        if (!bytes) {
          const issue = {
            code: 'custom' as const,
            path: ['imageKeys', side],
            message: 'image not uploaded',
            input: key,
          };
          throw new ValidationError(new z.ZodError([issue]), 'body');
        }
        return { image: { format: 'webp', source: { bytes } } };
      }),
    );
  }
}

const TRANSIENT = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'InternalServerException',
  'ModelTimeoutException',
  'ModelNotReadyException',
]);

/** Concatenated text blocks of the assistant message (Converse may split the answer). */
function answerText(out: ConverseCommandOutput): string {
  return (out.output?.message?.content ?? [])
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

/** The SDK client for the deployed Lambda: region and credentials from the environment. */
export function createBedrockClient(): BedrockRuntimeClient {
  return new BedrockRuntimeClient({});
}
