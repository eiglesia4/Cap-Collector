// POST /auth/apple — Apple identity token + PKCE verifier → session (openapi.yaml, ADR-008 §4, CAP-19). Public route.
// Body: shared `AppleSignInRequest`; response: shared `Session` (v0.2, CAP-30).
import { AppleSignInRequest, Session } from '@capcollector/shared';

import { signInWithApple } from '../auth/service.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: false, body: AppleSignInRequest }, async (req) =>
  ok(Session.parse(await signInWithApple(req.body, { refreshTokens: getRepositories().refreshTokens }))),
);
