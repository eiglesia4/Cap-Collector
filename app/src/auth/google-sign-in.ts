// Sign in with Google, the app half (ADR-011 §1–§3; CAP-111): one attempt = a fresh PKCE verifier whose S256 is the
// nonce Google copies into the ID token; the token and the verifier go to POST /auth/google, and the session is
// saved exactly as after Apple (src/auth/sign-in.ts). A 403 means the Google `sub` is not in `google-identities`: it
// is decoded locally from the token (never verified or trusted here) so the owner can add it. Tokens are never logged.
import type { ApiClient } from '../api/client.js';
import { HttpError, NetworkError, ProblemError } from '../api/errors.js';
import type { SessionStore } from '../session/session-store.js';
import { appleSubFromIdentityToken as subFromIdToken } from './apple-sub.js';
import type { Pkce } from './pkce.js';

/** `retry`: the API refused the token (401: expired, wrong audience or nonce) — a fresh attempt usually works. */
export type GoogleSignInFailure = 'not-allowed' | 'retry' | 'network' | 'failed';

export type GoogleSignInResult =
  { kind: 'signed-in' } | { kind: 'failed'; reason: GoogleSignInFailure; googleSub?: string };

export interface GoogleSignInDeps {
  readonly api: Pick<ApiClient, 'signInWithGoogle'>;
  readonly session: Pick<SessionStore, 'save'>;
}

const status = (error: unknown): number | undefined =>
  error instanceof ProblemError || error instanceof HttpError ? error.status : undefined;

function failure(error: unknown): GoogleSignInFailure {
  if (status(error) === 403) return 'not-allowed';
  if (status(error) === 401) return 'retry';
  if (error instanceof NetworkError) return 'network';
  return 'failed';
}

/** Hands Google's ID token for the attempt prepared with `pkce` to the API and stores the session. */
export async function finishGoogleSignIn(
  deps: GoogleSignInDeps,
  pkce: Pick<Pkce, 'codeVerifier'>,
  idToken: string,
): Promise<GoogleSignInResult> {
  try {
    const session = await deps.api.signInWithGoogle({ idToken, codeVerifier: pkce.codeVerifier });
    await deps.session.save(session);
    return { kind: 'signed-in' };
  } catch (error) {
    const reason = failure(error);
    const googleSub = reason === 'not-allowed' ? subFromIdToken(idToken) : null;
    return { kind: 'failed', reason, ...(googleSub !== null && { googleSub }) };
  }
}
