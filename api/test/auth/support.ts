// Auth test kit (CAP-19): a fake Apple signing key + local JWKS (jose generateKeyPair, no network), identity-token
// builder, PKCE verifier/nonce pair and the env the auth Lambdas get from SSM.
import { createHash } from 'node:crypto';

import { type JWTVerifyGetKey, SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from 'jose';

import { APPLE_ISSUER } from '../../src/auth/apple.js';

export const BUNDLE_ID = 'com.naevatec.collectors';
export const WEB_SERVICE_ID = 'com.naevatec.collectors.web';
export const EDU_SUB = '001234.abcdef0123456789abcdef0123456789.1234';
export const STRANGER_SUB = '009999.ffffffffffffffffffffffffffffffff.9999';
export const SESSION_SECRET = 'test-session-secret-0123456789abcdef-XYZ';

export const AUTH_ENV = {
  CAP_ALLOWED_APPLE_SUBS: `${EDU_SUB}, other-device-is-same-sub`,
  CAP_APPLE_CLIENT_IDS: `${BUNDLE_ID},${WEB_SERVICE_ID}`,
  CAP_SESSION_SECRET: SESSION_SECRET,
};

export const VERIFIER = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk-0123';
export const nonceB64 = (v = VERIFIER) => createHash('sha256').update(v).digest('base64url');
export const nonceHex = (v = VERIFIER) => createHash('sha256').update(v).digest('hex');

export interface AppleKit {
  getKey: JWTVerifyGetKey;
  /** Signs an Apple-like identity token; override any claim, or sign with a foreign key. */
  token(claims?: Record<string, unknown>, opts?: { foreign?: boolean; expSeconds?: number }): Promise<string>;
}

export async function appleKit(): Promise<AppleKit> {
  const apple = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(apple.publicKey)), kid: 'apple-test', alg: 'RS256', use: 'sig' };
  const getKey = createLocalJWKSet({ keys: [jwk] });
  return {
    getKey,
    async token(claims = {}, opts = {}) {
      const now = Math.floor(Date.now() / 1000);
      return new SignJWT({ nonce: nonceB64(), nonce_supported: true, email: 'edu@example.invalid', ...claims })
        .setProtectedHeader({ alg: 'RS256', kid: 'apple-test' })
        .setIssuer(String(claims.iss ?? APPLE_ISSUER))
        .setAudience(String(claims.aud ?? BUNDLE_ID))
        .setSubject(String(claims.sub ?? EDU_SUB))
        .setIssuedAt(now)
        .setExpirationTime(now + (opts.expSeconds ?? 600))
        .sign(opts.foreign ? foreign.privateKey : apple.privateKey);
    },
  };
}
