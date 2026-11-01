// Runtime configuration of every Lambda, validated with zod once per cold start; a missing or malformed variable
// fails the first invocation loudly instead of a later DynamoDB call (CLAUDE.md § Stack: "config validada al cargar").
import { z } from 'zod';

const EnvSchema = z.object({
  CAP_TABLE_NAME: z.string().regex(/^[a-zA-Z0-9_.-]{3,255}$/, 'valid DynamoDB table name expected'),
  CAP_IMAGES_BUCKET: z.string().regex(/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/, 'valid S3 bucket name expected'),
  CAP_STAGE: z.string().regex(/^[a-z][a-z0-9-]{0,19}$/, 'lower-case stage name expected'),
  /** Local only: DynamoDB Local endpoint (deploy/docker-compose.yaml). Unset in AWS. */
  CAP_DYNAMODB_ENDPOINT: z.url().optional(),
});

export interface Config {
  readonly tableName: string;
  readonly imagesBucket: string;
  readonly stage: string;
  readonly dynamodbEndpoint?: string;
}

/** Parses `env`; throws one error naming every invalid variable (never their values). */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = EnvSchema.safeParse({
    CAP_TABLE_NAME: env.CAP_TABLE_NAME,
    CAP_IMAGES_BUCKET: env.CAP_IMAGES_BUCKET,
    CAP_STAGE: env.CAP_STAGE,
    CAP_DYNAMODB_ENDPOINT: env.CAP_DYNAMODB_ENDPOINT || undefined,
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
    ...(e.CAP_DYNAMODB_ENDPOINT ? { dynamodbEndpoint: e.CAP_DYNAMODB_ENDPOINT } : {}),
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
