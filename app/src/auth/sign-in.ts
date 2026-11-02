// Sign-in and session restore (ADR-008 §4, CAP-22). signIn: PKCE → Apple (native sheet or JS popup) → state check →
// POST /auth/apple → session saved via platform.store. restoreSession: at app start, an access token that has
// expired (or is about to) is refreshed silently; a refused refresh signs out, an unreachable API keeps the session.
// Tokens and the Apple identity token are never logged.
import type { ApiClient } from '../api/client.js';
import { ApiError, HttpError, NetworkError, NotConfiguredError, ProblemError } from '../api/errors.js';
import { AppleSdkLoadError, AppleSignInUnavailableError, type Platform } from '../platform/platform.js';
import type { SessionStore } from '../session/session-store.js';
import { createPkce, type PkceCrypto } from './pkce.js';

/** Why a sign-in attempt failed; the screen maps each to a message. */
export type SignInFailure = 'not-allowed' | 'network' | 'unavailable' | 'failed';

export type SignInResult = { kind: 'signed-in' } | { kind: 'cancelled' } | { kind: 'failed'; reason: SignInFailure };

export interface SignInDeps {
  readonly platform: Pick<Platform, 'signInWithApple'>;
  readonly api: Pick<ApiClient, 'signInWithApple'>;
  readonly session: Pick<SessionStore, 'save'>;
  readonly crypto?: PkceCrypto;
}

function failure(error: unknown): SignInFailure {
  if ((error instanceof ProblemError || error instanceof HttpError) && error.status === 403) return 'not-allowed';
  if (error instanceof NetworkError || error instanceof AppleSdkLoadError) return 'network';
  if (error instanceof NotConfiguredError || error instanceof AppleSignInUnavailableError) return 'unavailable';
  return 'failed';
}

export async function signIn(deps: SignInDeps): Promise<SignInResult> {
  try {
    const pkce = await createPkce(deps.crypto);
    const credential = await deps.platform.signInWithApple({ nonce: pkce.nonce, state: pkce.state });
    if (credential === null) return { kind: 'cancelled' };
    // A response for another attempt (or a forged one) is dropped before the token is sent anywhere.
    if (credential.state !== pkce.state) return { kind: 'failed', reason: 'failed' };
    const session = await deps.api.signInWithApple({
      identityToken: credential.identityToken,
      ...(credential.authorizationCode !== undefined && { authorizationCode: credential.authorizationCode }),
      codeVerifier: pkce.codeVerifier,
    });
    await deps.session.save(session);
    return { kind: 'signed-in' };
  } catch (error) {
    return { kind: 'failed', reason: failure(error) };
  }
}

export type RestoreResult = 'signed-out' | 'valid' | 'refreshed' | 'rejected' | 'offline';

export interface RestoreDeps {
  readonly session: Pick<SessionStore, 'current' | 'signOut'>;
  readonly api: Pick<ApiClient, 'refresh'>;
  readonly now?: () => number;
  /** Refresh this long before `expiresAt` so the first requests do not race the expiry. */
  readonly skewMs?: number;
}

export const REFRESH_SKEW_MS = 60_000;

export async function restoreSession({
  session,
  api,
  now = Date.now,
  skewMs = REFRESH_SKEW_MS,
}: RestoreDeps): Promise<RestoreResult> {
  const current = session.current();
  if (!current) return 'signed-out';
  const expiresAt = Date.parse(current.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt - skewMs > now()) return 'valid';
  try {
    if (await api.refresh()) return 'refreshed';
  } catch (error) {
    // Offline or API unreachable: keep the session; the next request retries the refresh on its 401.
    if (error instanceof ApiError) return 'offline';
    throw error;
  }
  // Refresh token rotated, replayed or revoked (openapi.yaml § /auth/refresh 401): back to sign-in.
  await session.signOut();
  return 'rejected';
}
