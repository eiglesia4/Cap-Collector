// POST /auth/refresh — rotate the refresh token, issue a new session; replay → 401 (openapi.yaml, CAP-19). Public route.
import { RefreshBody, refreshSession } from '../auth/service.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: false, body: RefreshBody }, async (req) =>
  ok(await refreshSession(req.body, { refreshTokens: getRepositories().refreshTokens })),
);
