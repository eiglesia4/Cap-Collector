// Runtime configuration of every Lambda, validated with zod once per cold start; a missing or malformed variable
// fails the first invocation loudly instead of a later DynamoDB call (CLAUDE.md § Stack: "config validada al cargar").
import { z } from 'zod';

const EnvSchema = z
  .object({
    CAP_TABLE_NAME: z.string().regex(/^[a-zA-Z0-9_.-]{3,255}$/, 'valid DynamoDB table name expected'),
    CAP_IMAGES_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'valid S3 bucket name expected'),
    CAP_STAGE: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/, 'lower-case stage name expected'),
    /** Local only: DynamoDB Local endpoint (deploy/docker-compose.yaml). Unset in AWS. */
    CAP_DYNAMODB_ENDPOINT: z.url().optional(),
    /** Local only: S3 mock endpoint (deploy/docker-compose.yaml, path-style). Unset in AWS. */
    CAP_S3_ENDPOINT: z.url().optional(),
    /** ADR-004 step 1: max Hamming distance (of 64 bits) that still counts as "already in collection" (CAP-37). */
    CAP_DHASH_THRESHOLD: z.coerce.number().int().min(0).max(64).default(10),
    /** Bedrock vision model (CAP-39); unused by the CAP-37 stub, validated when present. */
    CAP_BEDROCK_MODEL_ID: z
      .string()
      .regex(/^[A-Za-z0-9][A-Za-z0-9.:_/-]{0,199}$/, 'Bedrock model id or inference profile expected')
      .optional(),
    /** Which vision adapter scans-analyse uses (CAP-39): `bedrock` (deployed), `fake` (fixtures, api:local), `off` (503). */
    CAP_VISION: z.enum(['bedrock', 'fake', 'off']).default('bedrock'),
    /** USD per 1k input / output tokens, overriding the price table (CAP-39, vision/prices.ts). Both or neither. */
    CAP_BEDROCK_PRICE_IN: z.coerce.number().min(0).optional(),
    CAP_BEDROCK_PRICE_OUT: z.coerce.number().min(0).optional(),
  })
  .refine((e) => (e.CAP_BEDROCK_PRICE_IN === undefined) === (e.CAP_BEDROCK_PRICE_OUT === undefined), {
    message: 'set both CAP_BEDROCK_PRICE_IN and CAP_BEDROCK_PRICE_OUT, or neither',
    path: ['CAP_BEDROCK_PRICE_IN'],
  });

export interface Config {
  readonly tableName: string;
  readonly imagesBucket: string;
  readonly stage: string;
  readonly dynamodbEndpoint?: string;
  readonly s3Endpoint?: string;
  readonly dhashThreshold: number;
  readonly bedrockModelId?: string;
  readonly vision: 'bedrock' | 'fake' | 'off';
  /** Price override, USD per 1k tokens; absent → the built-in table. */
  readonly bedrockPrice?: { inPer1k: number; outPer1k: number };
}

/** Parses `env`; throws one error naming every invalid variable (never their values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse({
    CAP_TABLE_NAME: env.CAP_TABLE_NAME,
    CAP_IMAGES_BUCKET: env.CAP_IMAGES_BUCKET,
    CAP_STAGE: env.CAP_STAGE,
    CAP_DYNAMODB_ENDPOINT: env.CAP_DYNAMODB_ENDPOINT || undefined,
    CAP_S3_ENDPOINT: env.CAP_S3_ENDPOINT || undefined,
    CAP_DHASH_THRESHOLD: env.CAP_DHASH_THRESHOLD || undefined,
    CAP_BEDROCK_MODEL_ID: env.CAP_BEDROCK_MODEL_ID || undefined,
    CAP_VISION: env.CAP_VISION || undefined,
    CAP_BEDROCK_PRICE_IN: env.CAP_BEDROCK_PRICE_IN || undefined,
    CAP_BEDROCK_PRICE_OUT: env.CAP_BEDROCK_PRICE_OUT || undefined,
  });
  if (!parsed.success) {
    const vars = parsed.error.issues.map((i) => `${i.path.join('.')} (${i.message})`).join(', ');
    throw new Error(`Invalid API configuration: ${vars}`);
  }
  const e = parsed.data;
  return {
    tableName: e.CAP_TABLE_NAME,
    imagesBucket: e.CAP_IMAGES_BUCKET,
    stage: e.CAP_STAGE,
    dhashThreshold: e.CAP_DHASH_THRESHOLD,
    vision: e.CAP_VISION,
    ...(e.CAP_BEDROCK_PRICE_IN !== undefined && e.CAP_BEDROCK_PRICE_OUT !== undefined
      ? { bedrockPrice: { inPer1k: e.CAP_BEDROCK_PRICE_IN, outPer1k: e.CAP_BEDROCK_PRICE_OUT } }
      : {}),
    ...(e.CAP_BEDROCK_MODEL_ID ? { bedrockModelId: e.CAP_BEDROCK_MODEL_ID } : {}),
    ...(e.CAP_DYNAMODB_ENDPOINT ? { dynamodbEndpoint: e.CAP_DYNAMODB_ENDPOINT } : {}),
    ...(e.CAP_S3_ENDPOINT ? { s3Endpoint: e.CAP_S3_ENDPOINT } : {}),
  };
}

let cached: Config | undefined;

/** Memoised `loadConfig()` for handlers: validated on first use in a cold start. */
export function getConfig(): Config {
  cached ??= loadConfig();
  return cached;
}

/** Test seam: forget the memoised config. */
export function resetConfig(): void {
  cached = undefined;
}
