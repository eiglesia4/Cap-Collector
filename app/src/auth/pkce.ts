// PKCE material for Sign in with Apple (ADR-008 §4; contract decision relayed in CAP-22 from CAP-19): a fresh
// RFC 7636 code verifier per attempt, `nonce = base64url(SHA-256(codeVerifier))` handed to Apple (which copies it
// into the identity token), and a random `state` echoed back by Apple and checked before the token is used.
// POST /auth/apple then sends the verifier; the API recomputes the nonce (api/src/auth/apple.ts).

export interface Pkce {
  /** RFC 7636 §4.1 code verifier: 64 unreserved characters (48 random bytes, base64url). */
  readonly codeVerifier: string;
  /** base64url(SHA-256(codeVerifier)), the S256 challenge, passed to Apple as `nonce`. */
  readonly nonce: string;
  /** Opaque anti-CSRF value Apple returns unchanged. */
  readonly state: string;
}

/** The subset of WebCrypto used here (window.crypto in the app, a stub in tests). */
export type PkceCrypto = Pick<Crypto, 'getRandomValues'> & { readonly subtle: Pick<SubtleCrypto, 'digest'> };

export function base64url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function randomString(crypto: PkceCrypto, bytes: number): string {
  return base64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

/** S256 transform of RFC 7636 §4.2: base64url(SHA-256(ASCII(verifier))). */
export async function s256(verifier: string, crypto: PkceCrypto): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64url(new Uint8Array(digest));
}

export async function createPkce(crypto: PkceCrypto = globalThis.crypto): Promise<Pkce> {
  const codeVerifier = randomString(crypto, 48);
  return { codeVerifier, nonce: await s256(codeVerifier, crypto), state: randomString(crypto, 16) };
}
