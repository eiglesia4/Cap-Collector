// POST /auth/google — Google ID token + PKCE verifier → session (openapi.yaml v0.5, ADR-011 §1–2, CAP-108). Public
// route. Body: shared `GoogleSignInRequest`; response: shared `Session`, the same as /auth/apple.
import { GoogleSignInRequest, Session } from '@capcollector/shared';

import { signInWithGoogle } from '../auth/service.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: false, body: GoogleSignInRequest }, async (req) =>
  ok(Session.parse(await signInWithGoogle(req.body, { refreshTokens: getRepositories().refreshTokens }))),
);
