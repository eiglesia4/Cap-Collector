// Sign in with Google ID-token verification (CAP-108, ADR-011 §1–2), the twin of apple.ts (same PKCE binding).
//
// The client asks Google for an ID token with `nonce = S256(codeVerifier)` and posts the token and the verifier to
// `POST /auth/google`. The API checks
//   1. the RS256 signature against Google's JWKS (GoogleKeys: in-memory cache honouring Cache-Control max-age, one
//      refetch on an unknown `kid`, 3 s timeout; public keys imported with node:crypto, no new dependency),
//   2. `iss` ∈ {accounts.google.com, https://accounts.google.com}, `aud` ∈ CAP_GOOGLE_CLIENT_IDS, `exp` (60 s skew),
//   3. `email_verified === true`,
//   4. `nonce` = S256(codeVerifier), base64url or lower-case hex (nonceCandidates, as for Apple),
// and returns Google's `sub`. Mapping the sub to a uid (`google-identities`) is the caller's job (service.ts).
import { type JsonWebKey, type KeyObject, createPublicKey } from 'node:crypto';

import { type JWTHeaderParameters, jwtVerify } from 'jose';

import { nonceCandidates } from './apple.js';

export const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
export const GOOGLE_JWKS_TIMEOUT_MS = 3000;
export const GOOGLE_CLOCK_SKEW_SECONDS = 60;
/** Minimum gap between refetches caused by an unknown `kid` (architect review of CAP-108, 2026-11-27). */
export const GOOGLE_JWKS_MIN_REFETCH_MS = 60_000;

/** Why a token was refused; logged as a reason code, never with the token. */
export type GoogleRejection =
  'invalid-token' | 'unknown-kid' | 'jwks-unavailable' | 'email-unverified' | 'nonce-mismatch' | 'no-sub';

export class GoogleTokenError extends Error {
  constructor(readonly reason: GoogleRejection) {
    super(`Google ID token rejected: ${reason}`);
    this.name = 'GoogleTokenError';
  }
}

/** Google's signing keys by `kid`. */
export interface GoogleKeys {
  /** The public JWK for `kid`, or undefined when Google does not publish it. Throws when the JWKS can't be read. */
  key(kid: string): Promise<JsonWebKey | undefined>;
}

export interface HttpGoogleKeysOptions {
  url?: string;
  fetch?: typeof globalThis.fetch;
  /** Epoch milliseconds. */
  clock?: () => number;
  timeoutMs?: number;
  minRefetchMs?: number;
}

/** `max-age` of a Cache-Control header in seconds; 0 (don't cache) when absent or unparsable. */
export function maxAgeSeconds(cacheControl: string | null): number {
  const m = /(?:^|[,\s])max-age=(\d+)/i.exec(cacheControl ?? '');
  return m ? Number(m[1]) : 0;
}

/**
 * Google's JWKS over HTTPS, cached in the container for as long as Google's Cache-Control allows. An unknown `kid`
 * refetches at most once per GOOGLE_JWKS_MIN_REFETCH_MS, so a flood of junk tokens is answered from the cache instead
 * of calling Google every time.
 */
export class HttpGoogleKeys implements GoogleKeys {
  private cache: { keys: Map<string, JsonWebKey>; expiresAt: number; fetchedAt: number } | undefined;
  private readonly url: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly clock: () => number;
  private readonly timeoutMs: number;
  private readonly minRefetchMs: number;

  constructor(opts: HttpGoogleKeysOptions = {}) {
    this.url = opts.url ?? GOOGLE_JWKS_URL;
    this.fetchFn = opts.fetch ?? globalThis.fetch;
    this.clock = opts.clock ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? GOOGLE_JWKS_TIMEOUT_MS;
    this.minRefetchMs = opts.minRefetchMs ?? GOOGLE_JWKS_MIN_REFETCH_MS;
  }

  async key(kid: string): Promise<JsonWebKey | undefined> {
    const now = this.clock();
    const cache = this.cache && this.cache.expiresAt > now ? this.cache : undefined;
    if (cache?.keys.has(kid)) return cache.keys.get(kid);
    // A fresh cache that lacks the kid was fetched less than minRefetchMs ago: the kid is junk, not a rotation.
    if (cache && now - cache.fetchedAt < this.minRefetchMs) return undefined;
    // Expired, never fetched, or an unknown kid (Google rotated its keys): fetch once, then answer from that.
    await this.refresh();
    return this.cache!.keys.get(kid);
  }

  private async refresh(): Promise<void> {
    const res = await this.fetchFn(this.url, { signal: AbortSignal.timeout(this.timeoutMs) });
    if (!res.ok) throw new Error(`Google JWKS answered ${res.status}`);
    const body = (await res.json()) as { keys?: unknown };
    if (!Array.isArray(body.keys)) throw new Error('Google JWKS has no keys');
    const keys = new Map<string, JsonWebKey>();
    for (const k of body.keys as (JsonWebKey & { kid?: unknown })[]) {
      if (typeof k.kid === 'string' && k.kty === 'RSA') keys.set(k.kid, k);
    }
    const fetchedAt = this.clock();
    this.cache = { keys, fetchedAt, expiresAt: fetchedAt + maxAgeSeconds(res.headers.get('cache-control')) * 1000 };
  }
}

let googleKeys: GoogleKeys | undefined;
/** The container-wide GoogleKeys (one cache per Lambda container). */
export const defaultGoogleKeys = (): GoogleKeys => (googleKeys ??= new HttpGoogleKeys());

/** Test / api:local seam: replace Google's JWKS (undefined restores the real one). Tests never reach the network. */
export function setGoogleKeys(keys: GoogleKeys | undefined): void {
  googleKeys = keys;
}

export interface GoogleVerifyInput {
  idToken: string;
  codeVerifier: string;
}

export interface GoogleVerifyOptions {
  clientIds: string[];
  keys?: GoogleKeys;
  currentDate?: Date;
}

/** Verifies the ID token and the PKCE proof; returns Google's `sub`. Throws GoogleTokenError. */
export async function verifyGoogleIdentity(input: GoogleVerifyInput, opts: GoogleVerifyOptions): Promise<string> {
  const keys = opts.keys ?? defaultGoogleKeys();
  // jose checks the claims; the key comes from GoogleKeys so its cache and refetch rules are ours.
  const getKey = async (header: JWTHeaderParameters): Promise<KeyObject> => {
    if (header.alg !== 'RS256' || typeof header.kid !== 'string') throw new GoogleTokenError('invalid-token');
    let jwk: JsonWebKey | undefined;
    try {
      jwk = await keys.key(header.kid);
    } catch {
      throw new GoogleTokenError('jwks-unavailable');
    }
    if (!jwk) throw new GoogleTokenError('unknown-kid');
    return createPublicKey({ key: jwk, format: 'jwk' });
  };

  let payload: Record<string, unknown>;
  try {
    if (opts.clientIds.length === 0) throw new Error('no client ids');
    ({ payload } = await jwtVerify(input.idToken, getKey, {
      issuer: GOOGLE_ISSUERS,
      audience: opts.clientIds,
      algorithms: ['RS256'],
      clockTolerance: GOOGLE_CLOCK_SKEW_SECONDS,
      requiredClaims: ['exp'],
      ...(opts.currentDate ? { currentDate: opts.currentDate } : {}),
    }));
  } catch (e) {
    throw e instanceof GoogleTokenError ? e : new GoogleTokenError('invalid-token');
  }
  if (payload.email_verified !== true) throw new GoogleTokenError('email-unverified');
  if (typeof payload.nonce !== 'string' || !nonceCandidates(input.codeVerifier).includes(payload.nonce)) {
    throw new GoogleTokenError('nonce-mismatch');
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') throw new GoogleTokenError('no-sub');
  return payload.sub;
}
