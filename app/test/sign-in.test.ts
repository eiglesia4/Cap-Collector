// Tests for Sign in with Apple (CAP-22, ADR-008 §4): PKCE/nonce, the sign-in flow, the sign-in screen and route
// guard, silent refresh on start, and sign-out.
import { webcrypto } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApiClient, type ApiClient } from '../src/api/client';
import { HttpError, NetworkError, NotConfiguredError, ProblemError } from '../src/api/errors';
import { renderApp, type AppHandle, type ShellContext } from '../src/app';
import { base64url, createPkce, s256 } from '../src/auth/pkce';
import { restoreSession, signIn } from '../src/auth/sign-in';
import { t } from '../src/i18n/i18n';
import { AppleSdkLoadError, AppleSignInUnavailableError, type AppleCredential } from '../src/platform/platform';
import { createSessionStore, SESSION_KEY } from '../src/session/session-store';
import { fakeApi, fakePlatform, flush, json, memoryStore, shellContext, TEST_SESSION } from './support/fakes';

const crypto = webcrypto as unknown as Crypto;
const ROTATED = { accessToken: 'access-2', refreshToken: 'refresh-2', expiresAt: '2031-01-01T00:00:00.000Z' };
const forbidden = new ProblemError({ title: 'Forbidden', status: 403, detail: 'not allowed' });

/** A platform whose Apple sheet echoes the request's state (or a given credential). */
function appleAnswering(answer: (req: { nonce: string; state: string }) => AppleCredential | null | Promise<never>) {
  const platform = fakePlatform('web');
  const sheet = vi.fn(async (req: { nonce: string; state: string }) => answer(req));
  platform.signInWithApple = sheet;
  return { platform, sheet };
}

describe('PKCE', () => {
  it('[T-app-019] generates an RFC 7636 verifier per attempt, nonce = base64url(SHA-256(verifier)), and a random state', async () => {
    // RFC 7636 Appendix B test vector.
    expect(await s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk', crypto)).toBe(
      'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
    );
    expect(base64url(new Uint8Array([251, 255, 191]))).toBe('-_-_');

    const a = await createPkce(crypto);
    const b = await createPkce(crypto);
    for (const p of [a, b]) {
      expect(p.codeVerifier).toMatch(/^[A-Za-z0-9._~-]{43,128}$/);
      expect(p.codeVerifier).toHaveLength(64);
      expect(p.nonce).toBe(await s256(p.codeVerifier, crypto));
      expect(p.state).toMatch(/^[A-Za-z0-9_-]{22}$/);
    }
    expect(a.codeVerifier).not.toBe(b.codeVerifier);
    expect(a.state).not.toBe(b.state);
    // Default crypto is the runtime's WebCrypto.
    expect((await createPkce()).codeVerifier).toHaveLength(64);
  });
});

describe('sign-in flow', () => {
  it('[T-app-020] sends the hashed verifier as nonce, checks state, posts the verifier and stores the session; refusals store nothing', async () => {
    const { platform, sheet } = appleAnswering((req) => ({
      identityToken: 'id-token',
      authorizationCode: 'code-1',
      state: req.state,
    }));
    const api = fakeApi();
    const store = memoryStore();
    const session = createSessionStore(store);
    expect(await signIn({ platform, api, session, crypto })).toEqual({ kind: 'signed-in' });
    const body = vi.mocked(api.signInWithApple).mock.calls[0]?.[0];
    expect(body).toEqual({ identityToken: 'id-token', authorizationCode: 'code-1', codeVerifier: expect.any(String) });
    expect(sheet.mock.calls[0]?.[0].nonce).toBe(await s256(body?.codeVerifier ?? '', crypto));
    expect(session.current()).toEqual(TEST_SESSION);
    expect(JSON.parse(store.data.get(SESSION_KEY) ?? '')).toEqual(TEST_SESSION);

    // No authorization code from Apple: the optional field is left out.
    const noCode = appleAnswering((req) => ({ identityToken: 'id-token', state: req.state }));
    const api2 = fakeApi();
    await signIn({ platform: noCode.platform, api: api2, session: createSessionStore(memoryStore()), crypto });
    expect(vi.mocked(api2.signInWithApple).mock.calls[0]?.[0]).not.toHaveProperty('authorizationCode');

    const attempt = async (answer: Parameters<typeof appleAnswering>[0], apiOverrides: Partial<ApiClient> = {}) => {
      const s = memoryStore();
      const a = fakeApi(apiOverrides);
      const result = await signIn({
        platform: appleAnswering(answer).platform,
        api: a,
        session: createSessionStore(s),
        crypto,
      });
      return { result, stored: s.data.has(SESSION_KEY), posted: vi.mocked(a.signInWithApple).mock.calls.length };
    };
    const ok = (req: { state: string }) => ({ identityToken: 'id-token', state: req.state });
    const reject = (error: unknown) => () => Promise.reject(error) as Promise<never>;

    // Cancelled sheet, state mismatch (token never posted), 403, network, not configured, anything else.
    expect(await attempt(() => null)).toEqual({ result: { kind: 'cancelled' }, stored: false, posted: 0 });
    expect(await attempt(() => ({ identityToken: 'x', state: 'other' }))).toEqual({
      result: { kind: 'failed', reason: 'failed' },
      stored: false,
      posted: 0,
    });
    const failed = (reason: string, posted: number) => ({ result: { kind: 'failed', reason }, stored: false, posted });
    expect(await attempt(ok, { signInWithApple: vi.fn(async () => Promise.reject(forbidden)) })).toEqual(
      failed('not-allowed', 1),
    );
    expect(await attempt(ok, { signInWithApple: vi.fn(async () => Promise.reject(new HttpError(403))) })).toEqual(
      failed('not-allowed', 1),
    );
    expect(await attempt(ok, { signInWithApple: vi.fn(async () => Promise.reject(new HttpError(401))) })).toEqual(
      failed('failed', 1),
    );
    expect(await attempt(ok, { signInWithApple: vi.fn(async () => Promise.reject(new NetworkError('x'))) })).toEqual(
      failed('network', 1),
    );
    expect(
      await attempt(ok, { signInWithApple: vi.fn(async () => Promise.reject(new NotConfiguredError('x'))) }),
    ).toEqual(failed('unavailable', 1));
    expect(await attempt(reject(new AppleSdkLoadError('x')))).toEqual(failed('network', 0));
    expect(await attempt(reject(new AppleSignInUnavailableError('x')))).toEqual(failed('unavailable', 0));
    expect(await attempt(reject(new Error('boom')))).toEqual(failed('failed', 0));
  });
});

describe('sign-in screen and guard', () => {
  let root: HTMLElement;
  let handle: AppHandle | undefined;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });
  afterEach(() => handle?.destroy());

  function mount(path: string, ctx: ShellContext): AppHandle {
    window.history.replaceState(null, '', path);
    handle = renderApp(root, ctx);
    return handle;
  }
  const appleButton = () => root.querySelector<HTMLButtonElement>('button.button--apple');
  const alert = () => root.querySelector('[role="alert"]')?.textContent;
  /** Wait until the attempt has finished (the button is re-enabled or gone): hashing is truly async. */
  const settled = () =>
    vi.waitFor(() => {
      if (appleButton()?.disabled) throw new Error('sign-in still running');
    });

  it('[T-app-021] signed out, every route shows the sign-in screen; success stores the session and lands on Collection', async () => {
    const { platform } = appleAnswering((req) => ({ identityToken: 'id-token', state: req.state }));
    const ctx = await shellContext({ platform, api: fakeApi(), signedIn: false });
    const app = mount('/settings', ctx);
    expect(window.location.pathname).toBe('/sign-in');
    expect(app.router.current().route.name).toBe('signIn');
    expect(root.querySelector<HTMLElement>('.tab-bar')?.hidden).toBe(true);
    expect(root.querySelector('h1')?.textContent).toBe(t('app.name'));
    expect(appleButton()?.textContent).toBe(t('signIn.button'));
    expect(root.querySelector('.apple-logo')?.getAttribute('aria-hidden')).toBe('true');

    app.router.navigate('/stats');
    expect(window.location.pathname).toBe('/sign-in');

    appleButton()?.click();
    expect(appleButton()?.disabled).toBe(true);
    await settled();
    expect(ctx.session.current()).toEqual(TEST_SESSION);
    expect(window.location.pathname).toBe('/');
    expect(root.querySelector('h1')?.textContent).toBe(t('collection.title'));
    expect(root.querySelector<HTMLElement>('.tab-bar')?.hidden).toBe(false);

    // Signed in, /sign-in redirects to Collection.
    app.router.navigate('/sign-in');
    expect(window.location.pathname).toBe('/');
  });

  it('[T-app-022] 403 shows "not allowed" and stores nothing; network and unconfigured builds have their own message; cancel is silent', async () => {
    const { platform } = appleAnswering((req) => ({ identityToken: 'id-token', state: req.state }));
    const signInWithApple = vi
      .fn<ApiClient['signInWithApple']>()
      .mockRejectedValueOnce(forbidden)
      .mockRejectedValueOnce(new NetworkError('offline'));
    const ctx = await shellContext({ platform, api: fakeApi({ signInWithApple }), signedIn: false });
    mount('/', ctx);

    appleButton()?.click();
    await settled();
    expect(alert()).toBe(t('signIn.notAllowed'));
    expect(ctx.session.signedIn()).toBe(false);
    expect(await ctx.platform.store.get(SESSION_KEY)).toBeNull();
    expect(window.location.pathname).toBe('/sign-in');
    expect(appleButton()?.disabled).toBe(false);

    appleButton()?.click();
    expect(alert()).toBe('');
    await settled();
    expect(alert()).toBe(t('signIn.network'));

    handle?.destroy();
    const unconfigured = fakePlatform('web');
    unconfigured.signInWithApple = vi.fn(async () => Promise.reject(new AppleSignInUnavailableError('x')));
    mount('/', await shellContext({ platform: unconfigured, signedIn: false }));
    appleButton()?.click();
    await settled();
    expect(alert()).toBe(t('signIn.unavailable'));

    handle?.destroy();
    const cancelling = appleAnswering(() => null);
    mount('/', await shellContext({ platform: cancelling.platform, signedIn: false }));
    appleButton()?.click();
    await settled();
    expect(alert()).toBe('');
    expect(window.location.pathname).toBe('/sign-in');
  });

  it('[T-app-023] Settings → Sign out clears the stored session and returns to sign-in; so does a refused refresh', async () => {
    const ctx = await shellContext({ api: fakeApi() });
    const app = mount('/settings', ctx);
    const signOut = root.querySelector<HTMLButtonElement>('button[name="sign-out"]');
    expect(signOut?.textContent).toBe(t('settings.signOut'));
    signOut?.click();
    await flush();
    expect(ctx.session.signedIn()).toBe(false);
    expect(await ctx.platform.store.get(SESSION_KEY)).toBeNull();
    expect(window.location.pathname).toBe('/sign-in');
    expect(appleButton()).not.toBeNull();
    app.destroy();

    // A request whose refresh is refused signs out through the API client → the shell shows sign-in.
    const platform = fakePlatform();
    const session = createSessionStore(platform.store);
    await session.save(TEST_SESSION);
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(401, undefined));
    const base = await shellContext({ platform });
    const api = createApiClient({ baseUrl: () => 'https://api.test', session, fetch });
    mount('/stats', { ...base, session, api });
    expect(window.location.pathname).toBe('/stats');
    await expect(
      api.request('/caps', { schema: { safeParse: (d) => ({ success: true, data: d }) } }),
    ).rejects.toThrow();
    expect(window.location.pathname).toBe('/sign-in');

    // Sign out is not offered without a session (development skip).
    handle?.destroy();
    const skipped = await shellContext({ signedIn: false });
    mount('/settings', skipped);
    root.querySelector<HTMLButtonElement>('.sign-in button.button--secondary')?.click();
    expect(window.location.pathname).toBe('/');
    handle?.router.navigate('/settings');
    expect(root.querySelector('button[name="sign-out"]')).toBeNull();
  });

  it('[T-app-024] the development skip exists only in development builds', async () => {
    const prodConfig = { apiUrl: 'https://api.test', version: '1', dev: false, apple: null };
    const ctx = await shellContext({ config: prodConfig, signedIn: false });
    const app = mount('/', ctx);
    expect(root.querySelector('.sign-in button.button--secondary')).toBeNull();
    expect(root.querySelectorAll('.sign-in button')).toHaveLength(1);
    app.destroy();

    const dev = await shellContext({ signedIn: false });
    mount('/', dev);
    const skip = root.querySelector<HTMLButtonElement>('.sign-in button.button--secondary');
    expect(skip?.textContent).toBe(t('signIn.skip'));
    skip?.click();
    expect(window.location.pathname).toBe('/');
    expect(dev.session.signedIn()).toBe(false);
  });
});

describe('session restore', () => {
  it('[T-app-025] on start, an expired access token is refreshed silently; refused → signed out; unreachable → kept', async () => {
    const now = () => Date.parse('2030-01-01T00:00:00.000Z');
    const at = (expiresAt: string) => {
      const store = memoryStore({ [SESSION_KEY]: JSON.stringify({ ...TEST_SESSION, expiresAt }) });
      return { store, session: createSessionStore(store) };
    };

    // Real API client: expired token → POST /auth/refresh with the refresh token → rotated session stored.
    const expired = at('2029-12-31T23:59:00.000Z');
    await expired.session.load();
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(200, ROTATED));
    const api = createApiClient({ baseUrl: () => 'https://api.test', session: expired.session, fetch });
    expect(await restoreSession({ session: expired.session, api, now })).toBe('refreshed');
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(String(fetch.mock.calls[0]?.[0])).toBe('https://api.test/auth/refresh');
    expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toEqual({ refreshToken: 'refresh-1' });
    expect(JSON.parse(expired.store.data.get(SESSION_KEY) ?? '')).toEqual(ROTATED);

    // Within the skew window counts as expired; comfortably valid does not call the API.
    const soon = at('2030-01-01T00:00:30.000Z');
    await soon.session.load();
    const refresh = vi.fn(async () => true);
    expect(await restoreSession({ session: soon.session, api: { refresh }, now })).toBe('refreshed');
    const valid = at('2030-01-01T01:00:00.000Z');
    await valid.session.load();
    expect(await restoreSession({ session: valid.session, api: { refresh }, now })).toBe('valid');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(await restoreSession({ session: createSessionStore(memoryStore()), api: { refresh } })).toBe('signed-out');

    // Refresh refused (401 rotated/replayed) → signed out.
    const refused = at('2029-01-01T00:00:00.000Z');
    await refused.session.load();
    const refusing = createApiClient({
      baseUrl: () => 'https://api.test',
      session: refused.session,
      fetch: vi.fn<typeof globalThis.fetch>().mockResolvedValue(json(401, undefined)),
    });
    expect(await restoreSession({ session: refused.session, api: refusing, now })).toBe('rejected');
    expect(refused.session.signedIn()).toBe(false);
    expect(refused.store.data.has(SESSION_KEY)).toBe(false);

    // Offline or a server fault (5xx) keeps the session for a later retry.
    for (const outcome of [() => Promise.reject(new TypeError('offline')), async () => json(503, undefined)]) {
      const kept = at('2029-01-01T00:00:00.000Z');
      await kept.session.load();
      const flaky = createApiClient({
        baseUrl: () => 'https://api.test',
        session: kept.session,
        fetch: vi.fn<typeof globalThis.fetch>(outcome),
      });
      expect(await restoreSession({ session: kept.session, api: flaky, now })).toBe('offline');
      expect(kept.session.signedIn()).toBe(true);
    }

    // Anything that is not an API failure is a bug and surfaces.
    const broken = at('2029-01-01T00:00:00.000Z');
    await broken.session.load();
    await expect(
      restoreSession({ session: broken.session, api: { refresh: async () => Promise.reject(new Error('bug')) }, now }),
    ).rejects.toThrow('bug');
  });
});
