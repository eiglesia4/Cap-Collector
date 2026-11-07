// POST /auth/refresh — rotate the refresh token, issue a new session; replay → 401 (openapi.yaml, CAP-19). Public route.
// Body: shared `RefreshRequest`; response: shared `Session` (v0.2, CAP-30).
import { RefreshRequest, Session } from '@capcollector/shared';

import { refreshSession } from '../auth/service.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: false, body: RefreshRequest }, async (req) =>
  ok(Session.parse(await refreshSession(req.body, { refreshTokens: getRepositories().refreshTokens }))),
);
