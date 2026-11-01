// Auth settings (CAP-19, ADR-008 §4). Only the auth Lambdas receive these variables (infra/lib/routes.ts `secrets`),
// so they are validated here, not in lib/config.ts. They come from SSM parameters that CollectorsData creates with
// the placeholder `unset` until Edu fills them: a placeholder or a short secret is refused, never used.
import { z } from 'zod';

/** Value CollectorsData writes into a parameter Edu has not filled yet (infra UNSET_PARAMETER_VALUE). */
export const UNSET = 'unset';
export const MIN_SECRET_LENGTH = 32;

const set = (name: string) =>
  z
    .string({ error: `${name} is missing` })
    .trim()
    .refine((v) => v !== '' && v !== UNSET, { message: `${name} is not set (SSM placeholder)` });

const list = (name: string) =>
  set(name)
    .transform((v) =>
      v
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    )
    .refine((v) => v.length > 0, { message: `${name} lists nothing` });

const SessionSecret = set('CAP_SESSION_SECRET').refine((v) => v.length >= MIN_SECRET_LENGTH, {
  message: `CAP_SESSION_SECRET must be at least ${MIN_SECRET_LENGTH} characters`,
});

function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const r = schema.safeParse(value);
  // Messages name the variable and the rule, never the value.
  if (!r.success) throw new Error(`Invalid auth configuration: ${r.error.issues.map((i) => i.message).join('; ')}`);
  return r.data;
}

/** HS256 key material for session JWTs. */
export function sessionSecret(env: NodeJS.ProcessEnv = process.env): Uint8Array {
  return new TextEncoder().encode(parse(SessionSecret, env.CAP_SESSION_SECRET));
}

/** Apple `sub`s allowed to use the API (single user, two devices). */
export function allowedAppleSubs(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  return new Set(parse(list('CAP_ALLOWED_APPLE_SUBS'), env.CAP_ALLOWED_APPLE_SUBS));
}

/** Accepted `aud` of Apple identity tokens: the iOS bundle id and the web Service ID. */
export function appleClientIds(env: NodeJS.ProcessEnv = process.env): string[] {
  return parse(list('CAP_APPLE_CLIENT_IDS'), env.CAP_APPLE_CLIENT_IDS);
}
