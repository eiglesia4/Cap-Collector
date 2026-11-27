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

// Google settings (CAP-108, ADR-011 §1–2). Unlike the Apple ones, an unset Google setting is not an error: it
// disables Sign in with Google (no client id → every token 401, no identity → every sub 403), never a 500.
const unsetOrEmpty = (v: string | undefined) => v === undefined || v.trim() === '' || v.trim() === UNSET;

/** Accepted `aud` of Google ID tokens (web and Android OAuth client ids); empty when unset. */
export function googleClientIds(env: NodeJS.ProcessEnv = process.env): string[] {
  const v = env.CAP_GOOGLE_CLIENT_IDS;
  return unsetOrEmpty(v) ? [] : parse(list('CAP_GOOGLE_CLIENT_IDS'), v);
}

const PAIR = /^([^=\s]+)\s*=\s*([^=\s]+)$/;

/**
 * Google `sub` → uid (`googleSub=uid` pairs, comma-separated, whitespace trimmed): the Google allow-list. A malformed
 * pair, or a sub mapped twice to different uids, is a configuration error naming the variable only (never a sub).
 * Empty when unset.
 */
export function googleIdentities(env: NodeJS.ProcessEnv = process.env): ReadonlyMap<string, string> {
  const v = env.CAP_GOOGLE_IDENTITIES;
  const map = new Map<string, string>();
  if (unsetOrEmpty(v)) return map;
  const pairs = parse(list('CAP_GOOGLE_IDENTITIES'), v);
  pairs.forEach((pair, i) => {
    const m = PAIR.exec(pair);
    if (!m) throw new Error(`Invalid auth configuration: CAP_GOOGLE_IDENTITIES pair ${i + 1} is not googleSub=uid`);
    const [, sub, uid] = m as unknown as [string, string, string];
    if (map.has(sub) && map.get(sub) !== uid) {
      throw new Error(`Invalid auth configuration: CAP_GOOGLE_IDENTITIES maps pair ${i + 1}'s sub twice`);
    }
    map.set(sub, uid);
  });
  return map;
}

/**
 * Every uid allowed to hold a session: the Apple subs plus the uids Google subs map to (ADR-011 §2: one collection
 * across providers; a Google-only installation has no Apple subs). Used by /auth/refresh.
 */
export function allowedUids(env: NodeJS.ProcessEnv = process.env): ReadonlySet<string> {
  const apple = unsetOrEmpty(env.CAP_ALLOWED_APPLE_SUBS) ? [] : [...allowedAppleSubs(env)];
  return new Set([...apple, ...googleIdentities(env).values()]);
}
