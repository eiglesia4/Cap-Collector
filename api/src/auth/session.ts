// Sessions (CAP-19, ADR-008 §4): a short HS256 JWT for every request plus a long-lived refresh token.
// HS256 (not EdDSA): signer and verifier are our own Lambdas sharing CAP_SESSION_SECRET from SSM, so a symmetric key
// is the simplest correct choice and needs no key pair management.
//
// Refresh token = `v1.<base64url(uid)>.<base64url(32 random bytes)>` (256 bits of entropy). The uid part only
// locates the item (`USER#<uid>` / `REFRESH#<sha256>`, auth/keys.ts); the table stores the SHA-256 hash, never the
// token. Every /auth/refresh rotates: the presented token is deleted in the same transaction that stores the new one,
// so a replayed (stolen or already-used) token answers 401.
import { createHash, randomBytes } from 'node:crypto';

import { SignJWT, jwtVerify } from 'jose';

import type { RefreshTokenRepository } from '../lib/repo/types.js';
import { REFRESH_TTL_SECONDS } from './keys.js';

export const SESSION_TTL_SECONDS = 3600;
export const SESSION_ISSUER = 'capcollector';
export const SESSION_AUDIENCE = 'capcollector-api';

/** openapi.yaml § Session. */
export interface Session {
  accessToken: string;
  refreshToken: string;
  expiresAt: string;
}

export const hashToken = (token: string) => createHash('sha256').update(token, 'utf8').digest('hex');

export function newRefreshToken(uid: string): string {
  return `v1.${Buffer.from(uid, 'utf8').toString('base64url')}.${randomBytes(32).toString('base64url')}`;
}

/** The uid a refresh token belongs to, or undefined for anything that is not one of ours. */
export function refreshTokenUid(token: string): string | undefined {
  const m = /^v1\.([A-Za-z0-9_-]{1,512})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return undefined;
  const uid = Buffer.from(m[1]!, 'base64url').toString('utf8');
  return uid.length > 0 ? uid : undefined;
}

export async function signAccessToken(uid: string, secret: Uint8Array, nowSeconds: number): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(uid)
    .setIssuer(SESSION_ISSUER)
    .setAudience(SESSION_AUDIENCE)
    .setIssuedAt(nowSeconds)
    .setExpirationTime(nowSeconds + SESSION_TTL_SECONDS)
    .sign(secret);
}

/** The uid of a valid, unexpired session JWT; undefined otherwise. */
export async function verifyAccessToken(token: string, secret: Uint8Array, now?: Date): Promise<string | undefined> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: SESSION_ISSUER,
      audience: SESSION_AUDIENCE,
      algorithms: ['HS256'],
      ...(now ? { currentDate: now } : {}),
    });
    return typeof payload.sub === 'string' && payload.sub !== '' ? payload.sub : undefined;
  } catch {
    return undefined;
  }
}

export interface SessionDeps {
  refreshTokens: RefreshTokenRepository;
  secret: Uint8Array;
  clock?: () => number;
}

async function build(uid: string, deps: SessionDeps): Promise<{ session: Session; refreshHash: string; ttl: number }> {
  const nowMs = (deps.clock ?? Date.now)();
  const now = Math.floor(nowMs / 1000);
  const refreshToken = newRefreshToken(uid);
  return {
    session: {
      accessToken: await signAccessToken(uid, deps.secret, now),
      refreshToken,
      expiresAt: new Date((now + SESSION_TTL_SECONDS) * 1000).toISOString(),
    },
    refreshHash: hashToken(refreshToken),
    ttl: now + REFRESH_TTL_SECONDS,
  };
}

/** New session after a successful Sign in with Apple. */
export async function startSession(uid: string, deps: SessionDeps): Promise<Session> {
  const { session, refreshHash, ttl } = await build(uid, deps);
  const createdAt = new Date((deps.clock ?? Date.now)()).toISOString();
  await deps.refreshTokens.create(uid, { tokenHash: refreshHash, createdAt, ttl });
  return session;
}

/** Rotates a refresh token; undefined when it is malformed, unknown, used or expired. */
export async function rotateSession(
  refreshToken: string,
  deps: SessionDeps & { isAllowed: (uid: string) => boolean },
): Promise<{ uid: string; session: Session } | undefined> {
  const uid = refreshTokenUid(refreshToken);
  if (!uid || !deps.isAllowed(uid)) return undefined;
  const nowMs = (deps.clock ?? Date.now)();
  const { session, refreshHash, ttl } = await build(uid, deps);
  const ok = await deps.refreshTokens.rotate(
    uid,
    hashToken(refreshToken),
    { tokenHash: refreshHash, createdAt: new Date(nowMs).toISOString(), ttl },
    Math.floor(nowMs / 1000),
  );
  return ok ? { uid, session } : undefined;
}
