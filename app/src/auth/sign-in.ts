// Sign-in and session restore (ADR-008 §4, CAP-22). prepareSignIn (screen mount, and again after every attempt,
// CAP-64): fresh PKCE + platform.prepareAppleSignIn, so the tap does no async work before Apple's popup opens.
// signIn (from the tap): Apple (native sheet or JS popup) → state check → POST /auth/apple → session saved via
// platform.store. restoreSession: at app start, an access token that has
// expired (or is about to) is refreshed silently; a refused refresh signs out, an unreachable API keeps the session.
// Tokens and the Apple identity token are never logged.
import type { ApiClient } from '../api/client.js';
import { ApiError, HttpError, NetworkError, NotConfiguredError, ProblemError } from '../api/errors.js';
import {
  AppleSdkLoadError,
  AppleSignInError,
  AppleSignInUnavailableError,
  type AppleCredential,
  type Platform,
} from '../platform/platform.js';
import type { SessionStore } from '../session/session-store.js';
import { appleSubFromIdentityToken } from './apple-sub.js';
import { createPkce, type Pkce, type PkceCrypto } from './pkce.js';

/**
 * Why a sign-in attempt failed; the screen maps each to a message. `popup-blocked`: Apple's
 * `popup_blocked_by_browser` (CAP-64).
 */
export type SignInFailure = 'not-allowed' | 'network' | 'unavailable' | 'popup-blocked' | 'failed';

/**
 * `appleSub` (CAP-28): on `not-allowed`, the Apple user id decoded from the identity token, so the user can hand it to
 * the server allow-list. Absent when the token cannot be decoded.
 */
/** `appleError` (CAP-64): any other Apple error code, shown in small print with the generic message. */
export type SignInResult =
  | { kind: 'signed-in' }
  | { kind: 'cancelled' }
  | { kind: 'failed'; reason: SignInFailure; appleSub?: string; appleError?: string };

export interface SignInDeps {
  readonly platform: Pick<Platform, 'prepareAppleSignIn' | 'signInWithApple'>;
  readonly api: Pick<ApiClient, 'signInWithApple'>;
  readonly session: Pick<SessionStore, 'save'>;
  readonly crypto?: PkceCrypto;
}

const POPUP_BLOCKED = 'popup_blocked_by_browser';

function failure(error: unknown): SignInFailure {
  if (error instanceof AppleSignInError) return error.code === POPUP_BLOCKED ? 'popup-blocked' : 'failed';
  if ((error instanceof ProblemError || error instanceof HttpError) && error.status === 403) return 'not-allowed';
  if (error instanceof NetworkError || error instanceof AppleSdkLoadError) return 'network';
  if (error instanceof NotConfiguredError || error instanceof AppleSignInUnavailableError) return 'unavailable';
  return 'failed';
}

/** One attempt's PKCE material, already handed to the platform. */
export interface PreparedSignIn {
  readonly pkce: Pkce;
}

export type PrepareResult = { kind: 'ready'; prepared: PreparedSignIn } | { kind: 'failed'; reason: SignInFailure };

export async function prepareSignIn(deps: Pick<SignInDeps, 'platform' | 'crypto'>): Promise<PrepareResult> {
  try {
    const pkce = await createPkce(deps.crypto);
    await deps.platform.prepareAppleSignIn({ nonce: pkce.nonce, state: pkce.state });
    return { kind: 'ready', prepared: { pkce } };
  } catch (error) {
    return { kind: 'failed', reason: failure(error) };
  }
}

/**
 * Not `async`: the platform call happens before this returns, inside the caller's tap handler (CAP-64). A prepared
 * attempt is used once; prepare again for the next one.
 */
export function signIn(deps: SignInDeps, prepared: PreparedSignIn): Promise<SignInResult> {
  const { pkce } = prepared;
  let started: Promise<AppleCredential | null>;
  try {
    started = deps.platform.signInWithApple({ nonce: pkce.nonce, state: pkce.state });
  } catch (error) {
    started = Promise.reject(error);
  }
  return finish(deps, pkce, started);
}

async function finish(deps: SignInDeps, pkce: Pkce, started: Promise<AppleCredential | null>): Promise<SignInResult> {
  let identityToken: string | null = null;
  try {
    const credential = await started;
    if (credential === null) return { kind: 'cancelled' };
    // A response for another attempt (or a forged one) is dropped before the token is sent anywhere.
    if (credential.state !== pkce.state) return { kind: 'failed', reason: 'failed' };
    identityToken = credential.identityToken;
    const session = await deps.api.signInWithApple({
      identityToken: credential.identityToken,
      ...(credential.authorizationCode !== undefined && { authorizationCode: credential.authorizationCode }),
      codeVerifier: pkce.codeVerifier,
    });
    await deps.session.save(session);
    return { kind: 'signed-in' };
  } catch (error) {
    const reason = failure(error);
    const appleSub =
      reason === 'not-allowed' && identityToken !== null ? appleSubFromIdentityToken(identityToken) : null;
    const appleError = reason === 'failed' && error instanceof AppleSignInError ? error.code : null;
    return {
      kind: 'failed',
      reason,
      ...(appleSub !== null && { appleSub }),
      ...(appleError !== null && { appleError }),
    };
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
