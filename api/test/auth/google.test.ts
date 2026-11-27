// Sign in with Google (CAP-108, ADR-011 §1–2): ID-token verification with the PKCE nonce, the JWKS cache, the
// google-identities mapping, POST /auth/google over the handler, refresh for a Google-mapped uid and log hygiene.
// A locally generated RSA key served by a fake fetch stands in for Google: no network.
import { createHash } from 'node:crypto';

import { SignJWT, exportJWK, generateKeyPair } from 'jose';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { allowedUids, googleClientIds, googleIdentities } from '../../src/auth/config.js';
import {
  type GoogleKeys,
  GoogleTokenError,
  HttpGoogleKeys,
  maxAgeSeconds,
  setGoogleKeys,
  verifyGoogleIdentity,
} from '../../src/auth/google.js';
import { refreshKey } from '../../src/auth/keys.js';
import { refreshSession, signInWithGoogle } from '../../src/auth/service.js';
import { hashToken, verifyAccessToken } from '../../src/auth/session.js';
import { handler as googleH } from '../../src/handlers/auth-google.js';
import { handler as refreshH } from '../../src/handlers/auth-refresh.js';
import { setRepositories } from '../../src/lib/repo/index.js';
import { type InMemoryRefreshTokenRepository, createMemoryRepositories } from '../../src/lib/repo/memory.js';
import type { Repositories } from '../../src/lib/repo/types.js';
import { apiEvent } from '../support/fixtures.js';
import { AUTH_ENV, EDU_SUB, SESSION_SECRET, VERIFIER, nonceB64, nonceHex } from './support.js';

const WEB_CLIENT = '1234-web.apps.googleusercontent.com';
const ANDROID_CLIENT = '1234-android.apps.googleusercontent.com';
const GOOGLE_SUB = '109876543210987654321';
const GOOGLE_ONLY_SUB = '100000000000000000001';
const STRANGER_GOOGLE_SUB = '199999999999999999999';

const GOOGLE_ENV = {
  ...AUTH_ENV,
  CAP_GOOGLE_CLIENT_IDS: `${WEB_CLIENT}, ${ANDROID_CLIENT}`,
  CAP_GOOGLE_IDENTITIES: ` ${GOOGLE_SUB} = ${EDU_SUB} , ${GOOGLE_ONLY_SUB}=${GOOGLE_ONLY_SUB}`,
};

type Pair = Awaited<ReturnType<typeof generateKeyPair>>;
let google: Pair;
let foreign: Pair;
let jwks: { keys: object[] };
let repos: Repositories;
const secret = new TextEncoder().encode(SESSION_SECRET);
const saved = { ...process.env };

/** A fake fetch serving `jwks` with the given Cache-Control; counts calls. */
function fakeFetch(cacheControl = 'public, max-age=21600, must-revalidate') {
  const calls = { n: 0 };
  const fetch = (async () => {
    calls.n++;
    return new Response(JSON.stringify(jwks), { headers: { 'cache-control': cacheControl } });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

async function idToken(
  claims: Record<string, unknown> = {},
  opts: { kid?: string; key?: Pair; expSeconds?: number } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ nonce: nonceB64(), email: 'edu@example.invalid', email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: opts.kid ?? 'google-1' })
    .setIssuer(String(claims.iss ?? 'https://accounts.google.com'))
    .setAudience(String(claims.aud ?? WEB_CLIENT))
    .setSubject(String(claims.sub ?? GOOGLE_SUB))
    .setIssuedAt(now)
    .setExpirationTime(now + (opts.expSeconds ?? 600))
    .sign((opts.key ?? google).privateKey);
}

let keys: GoogleKeys;
beforeAll(async () => {
  google = await generateKeyPair('RS256');
  foreign = await generateKeyPair('RS256');
  jwks = { keys: [{ ...(await exportJWK(google.publicKey)), kid: 'google-1', alg: 'RS256', use: 'sig' }] };
});
beforeEach(() => {
  repos = createMemoryRepositories();
  setRepositories(repos);
  Object.assign(process.env, GOOGLE_ENV);
  keys = new HttpGoogleKeys({ fetch: fakeFetch().fetch });
  setGoogleKeys(keys);
});
afterEach(() => {
  process.env = { ...saved };
  setRepositories(undefined);
  setGoogleKeys(undefined);
  vi.restoreAllMocks();
});

const deps = (env: NodeJS.ProcessEnv = GOOGLE_ENV) => ({ refreshTokens: repos.refreshTokens, env, googleKeys: keys });
const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;
const quiet = () => {
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
};

describe('Google ID token', () => {
  it('[T-api-096] valid token + PKCE verifier → sub; bad signature, iss, aud, exp, email_verified, nonce or unknown kid rejected', async () => {
    const opts = () => ({ clientIds: [WEB_CLIENT, ANDROID_CLIENT], keys });
    const verify = async (token: string, codeVerifier = VERIFIER) =>
      verifyGoogleIdentity({ idToken: token, codeVerifier }, opts());
    const reason = async (p: Promise<unknown>) => {
      try {
        await p;
        return 'accepted';
      } catch (e) {
        expect(e).toBeInstanceOf(GoogleTokenError);
        return (e as GoogleTokenError).reason;
      }
    };

    expect(await verify(await idToken())).toBe(GOOGLE_SUB);
    expect(await verify(await idToken({ iss: 'accounts.google.com' }))).toBe(GOOGLE_SUB); // both issuers
    expect(await verify(await idToken({ aud: ANDROID_CLIENT }))).toBe(GOOGLE_SUB); // Android client id
    expect(await verify(await idToken({ nonce: nonceHex() }))).toBe(GOOGLE_SUB); // hex S256 also accepted
    expect(await verify(await idToken({}, { expSeconds: -30 }))).toBe(GOOGLE_SUB); // within the 60 s skew

    expect(await reason(verify(await idToken({}, { key: foreign })))).toBe('invalid-token');
    expect(await reason(verify(await idToken({ iss: 'https://evil.example' })))).toBe('invalid-token');
    expect(await reason(verify(await idToken({ aud: 'someone-else.apps.googleusercontent.com' })))).toBe(
      'invalid-token',
    );
    expect(await reason(verify(await idToken({}, { expSeconds: -120 })))).toBe('invalid-token');
    expect(await reason(verify('not.a.jwt'))).toBe('invalid-token');
    expect(await reason(verify(await idToken({ email_verified: false })))).toBe('email-unverified');
    expect(await reason(verify(await idToken({ email_verified: undefined })))).toBe('email-unverified');
    expect(await reason(verify(await idToken({ email_verified: 'true' })))).toBe('email-unverified');
    expect(await reason(verify(await idToken(), 'x'.repeat(43)))).toBe('nonce-mismatch');
    expect(await reason(verify(await idToken({ nonce: undefined })))).toBe('nonce-mismatch');
    expect(await reason(verify(await idToken({}, { kid: 'rotated-away' })))).toBe('unknown-kid');
    expect(await reason(verify(await idToken({ sub: '' })))).toBe('no-sub');
    // No client id configured: nothing can match.
    expect(
      await reason(verifyGoogleIdentity({ idToken: await idToken(), codeVerifier: VERIFIER }, { clientIds: [], keys })),
    ).toBe('invalid-token');
    // JWKS down or slow → refused, not a crash.
    const down: GoogleKeys = { key: () => Promise.reject(new Error('timeout')) };
    expect(
      await reason(
        verifyGoogleIdentity({ idToken: await idToken(), codeVerifier: VERIFIER }, { ...opts(), keys: down }),
      ),
    ).toBe('jwks-unavailable');
  });

  it('[T-api-097] JWKS cache honours Cache-Control max-age; an unknown kid refetches once; HTTP errors and the 3 s timeout throw', async () => {
    expect(maxAgeSeconds('public, max-age=21600, must-revalidate')).toBe(21600);
    expect(maxAgeSeconds('no-store')).toBe(0);
    expect(maxAgeSeconds(null)).toBe(0);

    let now = 1_000_000;
    const { fetch, calls } = fakeFetch('public, max-age=100');
    const k = new HttpGoogleKeys({ fetch, clock: () => now });
    expect(await k.key('google-1')).toMatchObject({ kty: 'RSA' });
    expect(await k.key('google-1')).toBeDefined();
    expect(calls.n).toBe(1); // cached
    now += 99_000;
    await k.key('google-1');
    expect(calls.n).toBe(1); // still within max-age
    now += 2_000;
    await k.key('google-1');
    expect(calls.n).toBe(2); // expired → refetched

    now += 60_000; // past the minimum refetch interval, cache still fresh
    expect(await k.key('unknown')).toBeUndefined();
    expect(calls.n).toBe(3); // exactly one refetch for the unknown kid

    // Google rotates: the new kid appears in the next allowed refetch and is found.
    const rotated = await generateKeyPair('RS256');
    jwks = { keys: [...jwks.keys, { ...(await exportJWK(rotated.publicKey)), kid: 'google-2', alg: 'RS256' }] };
    now += 60_000;
    expect(await k.key('google-2')).toMatchObject({ kty: 'RSA' });
    expect(calls.n).toBe(4);
    const token = await idToken({}, { kid: 'google-2', key: rotated });
    expect(
      await verifyGoogleIdentity({ idToken: token, codeVerifier: VERIFIER }, { clientIds: [WEB_CLIENT], keys: k }),
    ).toBe(GOOGLE_SUB);
    jwks = { keys: jwks.keys.slice(0, 1) };

    // No max-age → never cached.
    const nc = fakeFetch('no-cache');
    const k2 = new HttpGoogleKeys({ fetch: nc.fetch });
    await k2.key('google-1');
    await k2.key('google-1');
    expect(nc.calls.n).toBe(2);

    const failing = new HttpGoogleKeys({
      fetch: (async () => new Response('oops', { status: 503 })) as typeof globalThis.fetch,
    });
    await expect(failing.key('google-1')).rejects.toThrow('503');
    const noKeys = new HttpGoogleKeys({
      fetch: (async () => new Response('{}', { status: 200 })) as typeof globalThis.fetch,
    });
    await expect(noKeys.key('google-1')).rejects.toThrow('no keys');

    // The request carries an abort signal that fires after the timeout.
    let seen: AbortSignal | undefined;
    const hanging = new HttpGoogleKeys({
      timeoutMs: 20,
      fetch: ((_url: string, init?: RequestInit) => {
        seen = init?.signal ?? undefined;
        return new Promise((_, reject) => seen?.addEventListener('abort', () => reject(seen?.reason)));
      }) as typeof globalThis.fetch,
    });
    await expect(hanging.key('google-1')).rejects.toBeDefined();
    expect(seen?.aborted).toBe(true);
    expect(new HttpGoogleKeys()).toBeInstanceOf(HttpGoogleKeys); // defaults: Google URL, 3 s
  });
});

describe('JWKS refetch floor', () => {
  it('[T-api-101] a flood of unknown kids within 60 s of the last fetch is answered from the cache, not from Google', async () => {
    let now = 5_000_000;
    const { fetch, calls } = fakeFetch('public, max-age=21600');
    const k = new HttpGoogleKeys({ fetch, clock: () => now });
    expect(await k.key('google-1')).toBeDefined();
    expect(calls.n).toBe(1);
    for (let i = 0; i < 50; i++) expect(await k.key(`junk-${i}`)).toBeUndefined();
    expect(calls.n).toBe(1); // no call to Google for junk within the floor
    now += 59_999;
    expect(await k.key('junk-late')).toBeUndefined();
    expect(calls.n).toBe(1);
    now += 1;
    expect(await k.key('junk-after-floor')).toBeUndefined();
    expect(calls.n).toBe(2); // one refetch once the floor has passed…
    expect(await k.key('junk-again')).toBeUndefined();
    expect(calls.n).toBe(2); // …and the floor restarts from it
    expect(await k.key('google-1')).toBeDefined(); // known kids keep being served

    // Through the verifier: unknown-kid tokens are still 401 `unknown-kid`.
    const token = await idToken({}, { kid: 'junk-kid' });
    await expect(
      verifyGoogleIdentity({ idToken: token, codeVerifier: VERIFIER }, { clientIds: [WEB_CLIENT], keys: k }),
    ).rejects.toMatchObject({ reason: 'unknown-kid' });
    expect(calls.n).toBe(2);

    // An expired cache is always refetched, floor or not (max-age 0).
    const nc = fakeFetch('no-cache');
    const k2 = new HttpGoogleKeys({ fetch: nc.fetch, clock: () => now, minRefetchMs: 60_000 });
    await k2.key('junk');
    await k2.key('junk');
    expect(nc.calls.n).toBe(2);
  });
});

describe('POST /auth/google', () => {
  it('[T-api-098] mapped sub → session for the uid, refresh works; unmapped → 403 with the sub; unset settings → 401/403; bad body → 422', async () => {
    quiet();
    // Mapped to the Apple uid: one collection across providers (ADR-011 §2).
    const s1 = await signInWithGoogle({ idToken: await idToken(), codeVerifier: VERIFIER }, deps());
    expect(await verifyAccessToken(s1.accessToken, secret)).toBe(EDU_SUB);
    const table = (repos.refreshTokens as InMemoryRefreshTokenRepository).table;
    expect(table.get(refreshKey(EDU_SUB, hashToken(s1.refreshToken)))).toMatchObject({ pk: `USER#${EDU_SUB}` });
    const s2 = await refreshSession({ refreshToken: s1.refreshToken }, deps());
    expect(await verifyAccessToken(s2.accessToken, secret)).toBe(EDU_SUB);

    // Google-only installation: no Apple subs at all, the Google sub maps to itself, refresh still works.
    const googleOnly = { ...GOOGLE_ENV, CAP_ALLOWED_APPLE_SUBS: 'unset', CAP_APPLE_CLIENT_IDS: 'unset' };
    const g1 = await signInWithGoogle(
      { idToken: await idToken({ sub: GOOGLE_ONLY_SUB }), codeVerifier: VERIFIER },
      deps(googleOnly),
    );
    expect(await verifyAccessToken(g1.accessToken, secret)).toBe(GOOGLE_ONLY_SUB);
    const g2 = await refreshSession({ refreshToken: g1.refreshToken }, deps(googleOnly));
    expect(await verifyAccessToken(g2.accessToken, secret)).toBe(GOOGLE_ONLY_SUB);
    // Unmapping the sub revokes its refresh.
    await expect(
      refreshSession({ refreshToken: g2.refreshToken }, deps({ ...googleOnly, CAP_GOOGLE_IDENTITIES: 'unset' })),
    ).rejects.toMatchObject({ status: 401 });

    // Over HTTP.
    const okRes = await googleH(
      apiEvent({ body: JSON.stringify({ idToken: await idToken(), codeVerifier: VERIFIER }) }),
    );
    expect(okRes.statusCode).toBe(200);
    const session = json<{ accessToken: string; refreshToken: string }>(okRes);
    expect(await verifyAccessToken(session.accessToken, secret)).toBe(EDU_SUB);
    expect(
      (await refreshH(apiEvent({ body: JSON.stringify({ refreshToken: session.refreshToken }) }))).statusCode,
    ).toBe(200);

    const stranger = await googleH(
      apiEvent({
        body: JSON.stringify({ idToken: await idToken({ sub: STRANGER_GOOGLE_SUB }), codeVerifier: VERIFIER }),
      }),
    );
    expect(stranger.statusCode).toBe(403);
    expect(json<{ title: string; detail: string }>(stranger)).toMatchObject({ title: 'Forbidden' });
    expect(json<{ detail: string }>(stranger).detail).toContain(STRANGER_GOOGLE_SUB);

    for (const bad of [
      await idToken({}, { key: foreign }),
      await idToken({ email_verified: false }),
      await idToken({}, { kid: 'rotated-away' }),
    ]) {
      const r = await googleH(apiEvent({ body: JSON.stringify({ idToken: bad, codeVerifier: VERIFIER }) }));
      expect(r.statusCode).toBe(401);
      expect(json<{ title: string }>(r).title).toBe('Unauthorized');
    }

    for (const body of [
      '{}',
      JSON.stringify({ idToken: 'x', codeVerifier: 'short' }),
      JSON.stringify({ idToken: '', codeVerifier: VERIFIER }),
      JSON.stringify({ idToken: 'x', codeVerifier: VERIFIER, extra: 1 }),
    ]) {
      expect((await googleH(apiEvent({ body }))).statusCode).toBe(422);
    }

    // Unset settings disable the route cleanly: no client ids → 401, no identities → 403; never 500.
    const valid = JSON.stringify({ idToken: await idToken(), codeVerifier: VERIFIER });
    process.env.CAP_GOOGLE_CLIENT_IDS = 'unset';
    expect((await googleH(apiEvent({ body: valid }))).statusCode).toBe(401);
    delete process.env.CAP_GOOGLE_CLIENT_IDS;
    expect((await googleH(apiEvent({ body: valid }))).statusCode).toBe(401);
    process.env.CAP_GOOGLE_CLIENT_IDS = GOOGLE_ENV.CAP_GOOGLE_CLIENT_IDS;
    process.env.CAP_GOOGLE_IDENTITIES = 'unset';
    expect((await googleH(apiEvent({ body: valid }))).statusCode).toBe(403);
  });

  it('[T-api-099] google-identities: pairs trimmed, unset → empty, malformed or conflicting pair fails config naming the variable only', () => {
    expect([...googleIdentities(GOOGLE_ENV)]).toEqual([
      [GOOGLE_SUB, EDU_SUB],
      [GOOGLE_ONLY_SUB, GOOGLE_ONLY_SUB],
    ]);
    expect(googleClientIds(GOOGLE_ENV)).toEqual([WEB_CLIENT, ANDROID_CLIENT]);
    for (const v of [undefined, '', '  ', 'unset']) {
      expect(googleIdentities({ CAP_GOOGLE_IDENTITIES: v }).size).toBe(0);
      expect(googleClientIds({ CAP_GOOGLE_CLIENT_IDS: v })).toEqual([]);
    }
    // The same pair twice is harmless.
    expect(googleIdentities({ CAP_GOOGLE_IDENTITIES: 'a=b,a=b' }).size).toBe(1);

    const msg = (v: string) => {
      try {
        googleIdentities({ CAP_GOOGLE_IDENTITIES: v });
        return '';
      } catch (e) {
        return (e as Error).message;
      }
    };
    for (const bad of [
      'secretsub',
      'secretsub=',
      '=uid',
      'secretsub=u=v',
      'secret sub=uid',
      'secretsub=uid,secretsub=other',
      ' , ',
    ]) {
      const m = msg(bad);
      expect(m).toContain('CAP_GOOGLE_IDENTITIES');
      expect(m).not.toContain('secretsub');
    }

    // Refresh allow-list = Apple subs ∪ mapped uids; each side may be unset.
    expect([...allowedUids(GOOGLE_ENV)].sort()).toEqual([EDU_SUB, GOOGLE_ONLY_SUB, 'other-device-is-same-sub'].sort());
    expect([...allowedUids({ CAP_ALLOWED_APPLE_SUBS: 'unset' })]).toEqual([]);
    expect([...allowedUids(AUTH_ENV)].sort()).toEqual([EDU_SUB, 'other-device-is-same-sub'].sort());
  });

  it('[T-api-100] no Google ID token, Google sub, verifier or session token ever reaches the logs', async () => {
    const lines: string[] = [];
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
        lines.push(args.map(String).join(' '));
      });
    }
    const good = await idToken();
    const strangerToken = await idToken({ sub: STRANGER_GOOGLE_SUB });
    const forged = await idToken({}, { key: foreign });
    const unverified = await idToken({ email_verified: false });
    const ok = await googleH(apiEvent({ body: JSON.stringify({ idToken: good, codeVerifier: VERIFIER }) }));
    const session = json<{ accessToken: string; refreshToken: string }>(ok);
    for (const t of [strangerToken, forged, unverified]) {
      await googleH(apiEvent({ body: JSON.stringify({ idToken: t, codeVerifier: VERIFIER }) }));
    }
    process.env.CAP_GOOGLE_IDENTITIES = 'secretsub'; // malformed → config error (500), logged without the value
    await googleH(apiEvent({ body: JSON.stringify({ idToken: good, codeVerifier: VERIFIER }) }));

    expect(lines.length).toBeGreaterThan(0);
    const all = lines.join('\n');
    for (const v of [
      good,
      strangerToken,
      forged,
      unverified,
      session.accessToken,
      session.refreshToken,
      GOOGLE_SUB,
      STRANGER_GOOGLE_SUB,
      EDU_SUB,
      VERIFIER,
      SESSION_SECRET,
      'secretsub',
    ]) {
      expect(all).not.toContain(v);
    }
    expect(all).toContain('sub-not-mapped');
    expect(all).toContain('email-unverified');
    expect(all).toContain('auth.google.rejected');
    expect(createHash('sha256').update(VERIFIER).digest('base64url')).toBe(nonceB64()); // kit sanity
  });
});
