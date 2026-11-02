// HTTP-level shapes shared by app and api (contracts v0.2, CAP-26): problem details, auth bodies, session, healthz.
// Replaces the hand-written validators of app/src/api/schema.ts (CAP-21) and the local bodies of api/src/auth (CAP-19).
import { z } from 'zod';

import { Instant } from './enums.js';

/**
 * RFC 9457 problem details as the API emits them (api/src/lib/http.ts, CAP-17): `errors[]` for 422 validation
 * issues; on 500 the request id travels in `detail` and in the `x-request-id` header — never a new member.
 */
export const Problem = z.object({
  type: z.string().optional(),
  title: z.string(),
  status: z.number().int().min(100).max(599),
  detail: z.string().optional(),
  errors: z.array(z.object({ path: z.string().optional(), message: z.string().optional() })).optional(),
});
export type Problem = z.infer<typeof Problem>;

/** `GET /healthz` body. */
export const Healthz = z.object({ status: z.literal('ok') });
export type Healthz = z.infer<typeof Healthz>;

/** Session issued by `/auth/apple` and `/auth/refresh`. */
export const Session = z.object({
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  expiresAt: Instant,
});
export type Session = z.infer<typeof Session>;

/** RFC 7636 code verifier: 43–128 chars of the unreserved set. */
export const CodeVerifier = z.string().regex(/^[A-Za-z0-9\-._~]{43,128}$/, 'RFC 7636 code verifier expected');

/**
 * Body of `POST /auth/apple` (ADR-008 §4, decided in CAP-19/CAP-22). PKCE binding: the app sends Apple
 * `nonce = base64url(SHA-256(codeVerifier))` (lower-case hex also accepted by the API) and posts the verifier; the API
 * checks the id token's `nonce` claim against it.
 */
export const AppleSignInRequest = z
  .object({
    identityToken: z.string().min(1).max(8192),
    authorizationCode: z.string().min(1).max(1024).optional(),
    codeVerifier: CodeVerifier,
  })
  .strict();
export type AppleSignInRequest = z.infer<typeof AppleSignInRequest>;

/** Body of `POST /auth/refresh` (decided in CAP-19/CAP-21): the refresh token as JSON, not a cookie or header. */
export const RefreshRequest = z.object({ refreshToken: z.string().min(1).max(1024) }).strict();
export type RefreshRequest = z.infer<typeof RefreshRequest>;

/** Body of `POST /uploads` (CAP-20): the key is minted by the API as `<uid>/<uploadId>/<side>.webp`. */
export const UploadRequest = z
  .object({
    side: z.enum(['top', 'underside']),
    contentType: z.literal('image/webp'),
    bytes: z.number().int().min(1).max(1_048_576),
  })
  .strict();
export type UploadRequest = z.infer<typeof UploadRequest>;

export const UploadResponse = z.object({
  key: z.string().min(1),
  url: z.string().url(),
  expiresAt: Instant,
});
export type UploadResponse = z.infer<typeof UploadResponse>;
