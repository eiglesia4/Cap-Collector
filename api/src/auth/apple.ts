// Sign in with Apple identity-token verification (CAP-19, ADR-008 §4: Apple + PKCE, single user, no Cognito).
//
// The app runs the Apple authorization itself with a PKCE-style proof: it draws a random `codeVerifier`
// (RFC 7636 charset, 43–128 chars), sends `nonce = S256(codeVerifier)` to Apple, and Apple copies that nonce into
// the identity token it signs. `POST /auth/apple` then carries the token and the verifier; the API checks
//   1. signature against Apple's JWKS (https://appleid.apple.com/auth/keys, cached per container by jose),
//   2. `iss` = https://appleid.apple.com, `aud` ∈ CAP_APPLE_CLIENT_IDS (iOS bundle id, web Service ID), `exp`,
//   3. `nonce` = S256(codeVerifier) — base64url (RFC 7636) or lower-case hex (Apple's sample code) both accepted,
//      so a stolen identity token is useless without the verifier that never left the device,
//   4. `c_hash`, when the token has one and the app sent `authorizationCode`: left half of SHA-256(code), base64url,
// and returns the token's `sub` (the uid of data-model.md). The allow-list is checked by the caller.
import { createHash } from 'node:crypto';

import { type JWTVerifyGetKey, createRemoteJWKSet, jwtVerify } from 'jose';

export const APPLE_ISSUER = 'https://appleid.apple.com';
export const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys';

/** Why a token was refused; logged as a reason code, never with the token. */
export type AppleRejection = 'invalid-token' | 'nonce-mismatch' | 'c-hash-mismatch' | 'no-sub';

export class AppleTokenError extends Error {
  constructor(readonly reason: AppleRejection) {
    super(`Apple identity token rejected: ${reason}`);
    this.name = 'AppleTokenError';
  }
}

let appleKeys: JWTVerifyGetKey | undefined;
/** Apple's JWKS, fetched lazily and cached by jose for the life of the container. */
export const appleJwks = (): JWTVerifyGetKey => (appleKeys ??= createRemoteJWKSet(new URL(APPLE_JWKS_URL)));

/** Test / api:local seam: replace Apple's JWKS (undefined restores the real one). Tests never reach the network. */
export function setAppleJwks(getKey: JWTVerifyGetKey | undefined): void {
  appleKeys = getKey;
}

const sha256 = (v: string) => createHash('sha256').update(v, 'utf8').digest();

/** Both encodings of S256(verifier) that a client may have put in the nonce. */
export function nonceCandidates(codeVerifier: string): string[] {
  const d = sha256(codeVerifier);
  return [d.toString('base64url'), d.toString('hex')];
}

export function cHash(authorizationCode: string): string {
  return sha256(authorizationCode).subarray(0, 16).toString('base64url');
}

export interface AppleVerifyInput {
  identityToken: string;
  codeVerifier: string;
  authorizationCode?: string | undefined;
}

export interface AppleVerifyOptions {
  clientIds: string[];
  getKey?: JWTVerifyGetKey;
  /** Test seam: verification time, epoch seconds. */
  currentDate?: Date;
}

/** Verifies the identity token and the PKCE proof; returns Apple's `sub`. Throws AppleTokenError. */
export async function verifyAppleIdentity(input: AppleVerifyInput, opts: AppleVerifyOptions): Promise<string> {
  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(input.identityToken, opts.getKey ?? appleJwks(), {
      issuer: APPLE_ISSUER,
      audience: opts.clientIds,
      algorithms: ['RS256'],
      clockTolerance: 5,
      ...(opts.currentDate ? { currentDate: opts.currentDate } : {}),
    }));
  } catch {
    throw new AppleTokenError('invalid-token');
  }
  if (typeof payload.nonce !== 'string' || !nonceCandidates(input.codeVerifier).includes(payload.nonce)) {
    throw new AppleTokenError('nonce-mismatch');
  }
  if (
    input.authorizationCode &&
    typeof payload.c_hash === 'string' &&
    payload.c_hash !== cHash(input.authorizationCode)
  ) {
    throw new AppleTokenError('c-hash-mismatch');
  }
  if (typeof payload.sub !== 'string' || payload.sub === '') throw new AppleTokenError('no-sub');
  return payload.sub;
}
