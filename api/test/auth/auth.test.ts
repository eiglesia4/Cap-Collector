// Auth API (CAP-19, ADR-008 §4): Apple identity-token verification with PKCE proof, single-user allow-list, session JWT,
// refresh rotation with replay detection, the Lambda authorizer, auth settings and log hygiene.
import type { AddressInfo } from 'node:net';

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AppleTokenError, cHash, setAppleJwks, verifyAppleIdentity } from '../../src/auth/apple.js';
import { bearerToken, handler as authorizer, resetAuthorizer } from '../../src/auth/authorizer.js';
import { allowedAppleSubs, appleClientIds, sessionSecret } from '../../src/auth/config.js';
import { refreshKey } from '../../src/auth/keys.js';
import { refreshSession, signInWithApple } from '../../src/auth/service.js';
import {
  SESSION_TTL_SECONDS,
  hashToken,
  newRefreshToken,
  refreshTokenUid,
  signAccessToken,
  verifyAccessToken,
} from '../../src/auth/session.js';
import { handler as appleH } from '../../src/handlers/auth-apple.js';
import { handler as refreshH } from '../../src/handlers/auth-refresh.js';
import { defineHandler, ok } from '../../src/lib/http.js';
import { setRepositories } from '../../src/lib/repo/index.js';
import { InMemoryRefreshTokenRepository, createMemoryRepositories } from '../../src/lib/repo/memory.js';
import type { Repositories } from '../../src/lib/repo/types.js';
import { createLocalServer, localAuthFor } from '../../scripts/local-server.js';
import { runRefreshContract } from '../repo/cap-contract.js';
import { apiEvent } from '../support/fixtures.js';
import {
  AUTH_ENV,
  type AppleKit,
  BUNDLE_ID,
  EDU_SUB,
  SESSION_SECRET,
  STRANGER_SUB,
  VERIFIER,
  WEB_SERVICE_ID,
  appleKit,
  nonceHex,
} from './support.js';

let kit: AppleKit;
let repos: Repositories;
const secret = new TextEncoder().encode(SESSION_SECRET);
const saved = { ...process.env };

beforeAll(async () => {
  kit = await appleKit();
});
beforeEach(() => {
  repos = createMemoryRepositories();
  setRepositories(repos);
  Object.assign(process.env, AUTH_ENV);
  resetAuthorizer();
  setAppleJwks(kit.getKey);
});
afterEach(() => {
  process.env = { ...saved };
  setRepositories(undefined);
  setAppleJwks(undefined);
  vi.restoreAllMocks();
});

const deps = () => ({ refreshTokens: repos.refreshTokens, env: AUTH_ENV, getKey: kit.getKey });
const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

describe('Apple identity token', () => {
  it('[T-api-025] valid token + PKCE verifier → sub; expired, wrong aud/iss, foreign key, nonce or c_hash mismatch rejected', async () => {
    const opts = { clientIds: [BUNDLE_ID, WEB_SERVICE_ID], getKey: kit.getKey };
    const verify = async (identityToken: string, extra: { codeVerifier?: string; authorizationCode?: string } = {}) =>
      verifyAppleIdentity({ identityToken, codeVerifier: VERIFIER, ...extra }, opts);
    const reason = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(AppleTokenError);
        return (e as AppleTokenError).reason;
      }
    };

    expect(await verify(await kit.token())).toBe(EDU_SUB);
    expect(await verify(await kit.token({ aud: WEB_SERVICE_ID }))).toBe(EDU_SUB); // web Service ID
    expect(await verify(await kit.token({ nonce: nonceHex() }))).toBe(EDU_SUB); // hex S256 also accepted
    const code = 'c0de.authorization.code';
    expect(await verify(await kit.token({ c_hash: cHash(code) }), { authorizationCode: code })).toBe(EDU_SUB);

    expect(await reason(verify(await kit.token({}, { expSeconds: -60 })))).toBe('invalid-token');
    expect(await reason(verify(await kit.token({ aud: 'com.someone.else' })))).toBe('invalid-token');
    expect(await reason(verify(await kit.token({ iss: 'https://evil.example' })))).toBe('invalid-token');
    expect(await reason(verify(await kit.token({}, { foreign: true })))).toBe('invalid-token');
    expect(await reason(verify('not.a.jwt'))).toBe('invalid-token');
    expect(await reason(verify(await kit.token(), { codeVerifier: 'x'.repeat(43) }))).toBe('nonce-mismatch');
    expect(await reason(verify(await kit.token({ nonce: undefined })))).toBe('nonce-mismatch');
    expect(await reason(verify(await kit.token({ c_hash: cHash('other') }), { authorizationCode: code }))).toBe(
      'c-hash-mismatch',
    );
    expect(await reason(verify(await kit.token({ sub: '' })))).toBe('no-sub');

    // Through the service: an Apple account outside the allow-list is 403, a bad token 401.
    quiet();
    await expect(
      signInWithApple({ identityToken: await kit.token({ sub: STRANGER_SUB }), codeVerifier: VERIFIER }, deps()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      signInWithApple({ identityToken: await kit.token({}, { foreign: true }), codeVerifier: VERIFIER }, deps()),
    ).rejects.toMatchObject({ status: 401 });
  });
});

describe('sessions', () => {
  it('[T-api-026] sign-in issues a 1 h session; refresh rotates; replaying an old refresh token → 401', async () => {
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    const s1 = await signInWithApple({ identityToken: await kit.token(), codeVerifier: VERIFIER }, deps());
    expect(await verifyAccessToken(s1.accessToken, secret)).toBe(EDU_SUB);
    expect(Date.parse(s1.expiresAt) - Date.now()).toBeGreaterThan((SESSION_TTL_SECONDS - 5) * 1000);
    expect(refreshTokenUid(s1.refreshToken)).toBe(EDU_SUB);

    // Only the hash is stored.
    const table = (repos.refreshTokens as InMemoryRefreshTokenRepository).table;
    const stored = table.get(refreshKey(EDU_SUB, hashToken(s1.refreshToken)));
    expect(stored).toMatchObject({ pk: `USER#${EDU_SUB}`, sk: `REFRESH#${hashToken(s1.refreshToken)}` });
    expect(JSON.stringify(stored)).not.toContain(s1.refreshToken);

    quiet();
    const s2 = await refreshSession({ refreshToken: s1.refreshToken }, deps());
    expect(s2.refreshToken).not.toBe(s1.refreshToken);
    expect(await verifyAccessToken(s2.accessToken, secret)).toBe(EDU_SUB);
    await expect(refreshSession({ refreshToken: s1.refreshToken }, deps())).rejects.toMatchObject({ status: 401 });
    const s3 = await refreshSession({ refreshToken: s2.refreshToken }, deps());
    expect(table.get(refreshKey(EDU_SUB, hashToken(s2.refreshToken)))).toBeUndefined();

    // Expired (TTL not yet swept), forged, malformed, or a sub removed from the allow-list → 401.
    const late = () => t0 + 91 * 24 * 3600 * 1000;
    const s4 = await signInWithApple(
      { identityToken: await kit.token(), codeVerifier: VERIFIER },
      { ...deps(), clock: () => t0 },
    );
    await expect(refreshSession({ refreshToken: s4.refreshToken }, { ...deps(), clock: late })).rejects.toMatchObject({
      status: 401,
    });
    for (const bad of [newRefreshToken(EDU_SUB), 'v1.garbage', s3.accessToken]) {
      await expect(refreshSession({ refreshToken: bad }, deps())).rejects.toMatchObject({ status: 401 });
    }
    await expect(
      refreshSession(
        { refreshToken: s3.refreshToken },
        { ...deps(), env: { ...AUTH_ENV, CAP_ALLOWED_APPLE_SUBS: 'x' } },
      ),
    ).rejects.toMatchObject({ status: 401 });

    // Over HTTP: /auth/apple → 200 Session; /auth/refresh rotates; replay → 401 Problem; bad bodies → 422.
    const signedIn = await appleH(
      apiEvent({ body: JSON.stringify({ identityToken: await kit.token(), codeVerifier: VERIFIER }) }),
    );
    expect(signedIn.statusCode).toBe(200);
    expect(await verifyAccessToken(json<{ accessToken: string }>(signedIn).accessToken, secret)).toBe(EDU_SUB);
    const stranger = await appleH(
      apiEvent({
        body: JSON.stringify({ identityToken: await kit.token({ sub: STRANGER_SUB }), codeVerifier: VERIFIER }),
      }),
    );
    expect(stranger.statusCode).toBe(403);
    expect(json<{ title: string }>(stranger).title).toBe('Forbidden');
    const viaRefresh = await refreshH(apiEvent({ body: JSON.stringify({ refreshToken: s3.refreshToken }) }));
    expect(viaRefresh.statusCode).toBe(200);
    expect(Object.keys(json<object>(viaRefresh)).sort()).toEqual(['accessToken', 'expiresAt', 'refreshToken']);
    expect((await refreshH(apiEvent({ body: JSON.stringify({ refreshToken: s3.refreshToken }) }))).statusCode).toBe(
      401,
    );
    expect((await refreshH(apiEvent({ body: '{}' }))).statusCode).toBe(422);
    expect(
      (await appleH(apiEvent({ body: JSON.stringify({ identityToken: 'x', codeVerifier: 'short' }) }))).statusCode,
    ).toBe(422);
  });
});

describe('authorizer', () => {
  it('[T-api-027] allows a valid session with context.uid; denies missing, malformed, expired, foreign or unconfigured', async () => {
    const now = Math.floor(Date.now() / 1000);
    const good = await signAccessToken(EDU_SUB, secret, now);
    expect(await authorizer({ headers: { authorization: `Bearer ${good}` } })).toEqual({
      isAuthorized: true,
      context: { uid: EDU_SUB },
    });
    expect(await authorizer({ headers: { Authorization: `bearer ${good}` } })).toMatchObject({ isAuthorized: true });

    const expired = await signAccessToken(EDU_SUB, secret, now - 2 * SESSION_TTL_SECONDS);
    const foreign = await signAccessToken(
      EDU_SUB,
      new TextEncoder().encode('another-secret-that-is-long-enough!!'),
      now,
    );
    for (const headers of [
      {},
      { authorization: good },
      { authorization: 'Bearer ' },
      { authorization: 'Bearer not.a.jwt' },
      { authorization: `Bearer ${expired}` },
      { authorization: `Bearer ${foreign}` },
      { authorization: `Basic ${good}` },
    ]) {
      expect(await authorizer({ headers })).toEqual({ isAuthorized: false });
    }
    expect(bearerToken(undefined)).toBeUndefined();

    // The route sees the uid the authorizer put in the context.
    const echo = defineHandler({ auth: true }, async (req) => ok({ uid: req.uid }));
    expect(json<{ uid: string }>(await echo(apiEvent({ uid: EDU_SUB })))).toEqual({ uid: EDU_SUB });

    // Secret still the SSM placeholder → deny everything, log the configuration problem only.
    resetAuthorizer();
    process.env.CAP_SESSION_SECRET = 'unset';
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await authorizer({ headers: { authorization: `Bearer ${good}` } })).toEqual({ isAuthorized: false });
    expect(String(err.mock.calls[0]?.[0])).toContain('auth.authorizer.config');
  });

  it('[T-api-029] auth settings refuse the SSM placeholder, empty lists and short secrets, naming the variable only', () => {
    expect([...allowedAppleSubs(AUTH_ENV)]).toEqual([EDU_SUB, 'other-device-is-same-sub']);
    expect(appleClientIds(AUTH_ENV)).toEqual([BUNDLE_ID, WEB_SERVICE_ID]);
    expect(sessionSecret(AUTH_ENV)).toEqual(secret);
    const msg = (f: () => unknown) => {
      try {
        f();
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    expect(msg(() => sessionSecret({ CAP_SESSION_SECRET: 'unset' }))).toContain('CAP_SESSION_SECRET is not set');
    expect(msg(() => sessionSecret({}))).toContain('CAP_SESSION_SECRET is missing');
    const short = msg(() => sessionSecret({ CAP_SESSION_SECRET: 'tooShortSecret' }));
    expect(short).toContain('at least 32');
    expect(short).not.toContain('tooShortSecret');
    expect(msg(() => allowedAppleSubs({ CAP_ALLOWED_APPLE_SUBS: ' , ' }))).toContain('lists nothing');
    expect(msg(() => appleClientIds({ CAP_APPLE_CLIENT_IDS: 'unset' }))).toContain('CAP_APPLE_CLIENT_IDS is not set');
  });
});

describe('log hygiene', () => {
  it('[T-api-028] no identity token, refresh/access token, session secret or Apple sub ever reaches the logs', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const strangerToken = await kit.token({ sub: STRANGER_SUB });
    const forged = await kit.token({}, { foreign: true });
    const session = await signInWithApple({ identityToken: await kit.token(), codeVerifier: VERIFIER }, deps());
    await signInWithApple({ identityToken: strangerToken, codeVerifier: VERIFIER }, deps()).catch(() => undefined);
    await signInWithApple({ identityToken: forged, codeVerifier: VERIFIER }, deps()).catch(() => undefined);
    await refreshSession({ refreshToken: session.refreshToken }, deps());
    await refreshSession({ refreshToken: session.refreshToken }, deps()).catch(() => undefined); // replay
    await refreshH(apiEvent({ body: JSON.stringify({ refreshToken: session.refreshToken }) }));
    await appleH(apiEvent({ body: JSON.stringify({ identityToken: strangerToken, codeVerifier: VERIFIER }) }));
    await authorizer({ headers: { authorization: `Bearer ${session.accessToken}x` } });
    process.env.CAP_SESSION_SECRET = 'unset';
    resetAuthorizer();
    await authorizer({ headers: { authorization: `Bearer ${session.accessToken}` } });
    await refreshH(apiEvent({ body: JSON.stringify({ refreshToken: session.refreshToken }) })); // config error → 500

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const secretValue of [
      strangerToken,
      forged,
      session.accessToken,
      session.refreshToken,
      SESSION_SECRET,
      EDU_SUB,
      STRANGER_SUB,
      VERIFIER,
    ]) {
      expect(all).not.toContain(secretValue);
    }
    expect(all).toContain('sub-not-allowed');
    expect(all).toContain('invalid-or-reused');
  });
});

describe('api:local auth', () => {
  it('[T-api-030] fake uid only when CAP_STAGE=local; otherwise the real authorizer (401 no header, 403 denied)', async () => {
    expect(localAuthFor({ CAP_STAGE: 'local' })).toEqual({ mode: 'fake', defaultUid: 'local-user' });
    expect(localAuthFor({ CAP_STAGE: 'local', CAP_LOCAL_UID: 'edu' })).toEqual({ mode: 'fake', defaultUid: 'edu' });
    expect(localAuthFor({ CAP_STAGE: 'dev' })).toEqual({ mode: 'authorizer' });
    expect(localAuthFor({})).toEqual({ mode: 'authorizer' });

    const whoami = {
      method: 'GET' as const,
      path: '/whoami',
      auth: true,
      load: async () => defineHandler({ auth: true }, async (req) => ok({ uid: req.uid })),
    };
    const serve = async (auth: Parameters<typeof createLocalServer>[0]) => {
      const server = createLocalServer(auth, [whoami]);
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      return { base, close: () => new Promise((r) => server.close(r)) };
    };

    const real = await serve({ mode: 'authorizer' });
    const token = await signAccessToken(EDU_SUB, secret, Math.floor(Date.now() / 1000));
    expect((await fetch(`${real.base}/whoami`)).status).toBe(401);
    expect((await fetch(`${real.base}/whoami`, { headers: { 'x-cap-uid': 'mallory' } })).status).toBe(401);
    expect((await fetch(`${real.base}/whoami`, { headers: { authorization: 'Bearer nope' } })).status).toBe(403);
    const okRes = await fetch(`${real.base}/whoami`, { headers: { authorization: `Bearer ${token}` } });
    expect(await okRes.json()).toEqual({ uid: EDU_SUB });
    await real.close();

    const fake = await serve({ mode: 'fake' });
    expect((await fetch(`${fake.base}/whoami`)).status).toBe(401); // no default uid, no header
    expect(await (await fetch(`${fake.base}/whoami`, { headers: { 'x-cap-uid': 'edu' } })).json()).toEqual({
      uid: 'edu',
    });
    await fake.close();
  });
});

describe('refresh token repository', () => {
  it('[T-api-031] in memory: create refuses duplicates; rotate is single-use, per user and honours expiry', async () => {
    await runRefreshContract(new InMemoryRefreshTokenRepository());
  });
});
