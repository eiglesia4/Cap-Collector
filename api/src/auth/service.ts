// POST /auth/apple and POST /auth/refresh (CAP-19, openapi.yaml § auth, ADR-008 §4). Rejections are logged as reason
// codes only: never the identity token, the refresh token, the session secret or the Apple `sub` (CLAUDE.md: no
// secrets or personal data in logs).
import type { JWTVerifyGetKey } from 'jose';
import type { AppleSignInRequest, RefreshRequest } from '@capcollector/shared';

import { Forbidden, Unauthorized } from '../lib/errors.js';
import type { RefreshTokenRepository } from '../lib/repo/types.js';
import { AppleTokenError, verifyAppleIdentity } from './apple.js';
import { allowedAppleSubs, appleClientIds, sessionSecret } from './config.js';
import { type Session, rotateSession, startSession } from './session.js';

export interface AuthDeps {
  refreshTokens: RefreshTokenRepository;
  env?: NodeJS.ProcessEnv;
  getKey?: JWTVerifyGetKey;
  clock?: () => number;
}

const warn = (event: string, reason: string) => console.warn(JSON.stringify({ level: 'warn', event, reason }));

export async function signInWithApple(body: AppleSignInRequest, deps: AuthDeps): Promise<Session> {
  const env = deps.env ?? process.env;
  const clientIds = appleClientIds(env);
  const allowed = allowedAppleSubs(env);
  const secret = sessionSecret(env);
  let sub: string;
  try {
    sub = await verifyAppleIdentity(body, {
      clientIds,
      ...(deps.getKey ? { getKey: deps.getKey } : {}),
      ...(deps.clock ? { currentDate: new Date(deps.clock()) } : {}),
    });
  } catch (e) {
    if (!(e instanceof AppleTokenError)) throw e;
    warn('auth.apple.rejected', e.reason);
    throw new Unauthorized('Apple identity token rejected');
  }
  if (!allowed.has(sub)) {
    warn('auth.apple.rejected', 'sub-not-allowed');
    throw new Forbidden('This Apple account may not use this installation');
  }
  return startSession(sub, { refreshTokens: deps.refreshTokens, secret, ...(deps.clock ? { clock: deps.clock } : {}) });
}

export async function refreshSession(body: RefreshRequest, deps: AuthDeps): Promise<Session> {
  const env = deps.env ?? process.env;
  const allowed = allowedAppleSubs(env);
  const r = await rotateSession(body.refreshToken, {
    refreshTokens: deps.refreshTokens,
    secret: sessionSecret(env),
    isAllowed: (uid) => allowed.has(uid),
    ...(deps.clock ? { clock: deps.clock } : {}),
  });
  if (!r) {
    warn('auth.refresh.rejected', 'invalid-or-reused');
    throw new Unauthorized('Refresh token invalid or revoked');
  }
  return r.session;
}
