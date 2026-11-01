// POST /auth/apple — Apple identity token + PKCE verifier → session (openapi.yaml, ADR-008 §4, CAP-19). Public route.
import { AppleSignInBody, signInWithApple } from '../auth/service.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: false, body: AppleSignInBody }, async (req) =>
  ok(await signInWithApple(req.body, { refreshTokens: getRepositories().refreshTokens })),
);
