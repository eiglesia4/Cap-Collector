// Sign in with Google on the web (CAP-111; ADR-011 §1–§3; SCREENS.md § Sign-in): the optional client id, which
// platforms offer the button, the GIS initialisation (nonce = S256 of a fresh verifier per attempt), the POST body,
// the session on success, the refusal (403, with the Google `sub`), the 401 retry, a script that does not load (Apple
// stays usable), and the es/en copy. Google Identity Services is a stub standing in for `window.google.accounts.id`.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../src/api/client';
import { HttpError, ProblemError } from '../src/api/errors';
import { renderApp, type AppHandle, type ShellContext } from '../src/app';
import { s256 } from '../src/auth/pkce';
import { ConfigError, loadConfig, parseGoogleConfig } from '../src/config';
import { setLanguage, t } from '../src/i18n/i18n';
import { createCapacitorPlatform, type CapacitorPlugins } from '../src/platform/capacitor/capacitor-platform';
import { GoogleSdkLoadError } from '../src/platform/platform';
import {
  buttonWidth,
  createGoogleWebSignIn,
  gisLoader,
  GOOGLE_GIS_URL,
  type GoogleAccountsId,
} from '../src/platform/web/google-sign-in';
import { createWebPlatform } from '../src/platform/web/web-platform';
import { fakeApi, fakePlatform, shellContext, TEST_SESSION } from './support/fakes';

const CLIENT_ID = '1234-abc.apps.googleusercontent.com';
const GOOGLE_SUB = '109876543210987654321';

/** An unsigned JWT with the given claims: the screen only decodes `sub`, the API is the judge. */
const idToken = (claims: Record<string, unknown>) =>
  ['e30', btoa(JSON.stringify(claims)).replace(/=+$/, ''), 'sig'].join('.');

type InitConfig = Parameters<GoogleAccountsId['initialize']>[0];

/** A GIS stub: records every `initialize` and renders a plain button standing in for Google's iframe. */
function fakeGis() {
  const inits: InitConfig[] = [];
  const renders: { width: number; locale?: string }[] = [];
  const id: GoogleAccountsId = {
    initialize: (config) => void inits.push(config),
    renderButton: (parent, options) => {
      renders.push(options);
      parent.append(Object.assign(document.createElement('button'), { className: 'gsi-stub' }));
    },
  };
  /** Google's popup returning a credential to the latest initialisation. */
  const answer = (credential: string) => inits.at(-1)?.callback({ credential });
  return { id, inits, renders, answer };
}

function googlePlatform(gis = fakeGis(), load?: () => Promise<GoogleAccountsId>) {
  const platform = fakePlatform('web');
  return {
    platform: { ...platform, google: createGoogleWebSignIn({ clientId: CLIENT_ID }, load ?? (async () => gis.id)) },
    gis,
  };
}

describe('Sign in with Google (CAP-111)', () => {
  let root: HTMLElement;
  let handle: AppHandle | undefined;

  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });
  afterEach(() => {
    handle?.destroy();
    handle = undefined;
  });

  function mount(ctx: ShellContext): AppHandle {
    window.history.replaceState(null, '', '/');
    handle = renderApp(root, ctx);
    return handle;
  }
  const alert = () => root.querySelector('[role="alert"]')?.textContent;
  const googleRendered = () =>
    vi.waitFor(() => {
      if (root.querySelectorAll('.gsi-stub').length === 0) throw new Error('no Google button yet');
      if (root.querySelector('[data-google][aria-busy]')) throw new Error('Google attempt still running');
    });

  it('[T-app-212] the Google button renders only with a client id on the web, never on iOS; the client id is validated', async () => {
    expect(parseGoogleConfig(undefined)).toBeNull();
    expect(parseGoogleConfig('  ')).toBeNull();
    expect(parseGoogleConfig(` ${CLIENT_ID} `)).toEqual({ clientId: CLIENT_ID });
    expect(() => parseGoogleConfig('my-client')).toThrow(ConfigError);
    expect(loadConfig({ VITE_GOOGLE_CLIENT_ID: CLIENT_ID, DEV: false }, '1').google).toEqual({ clientId: CLIENT_ID });

    // The platform adapter decides: web with a client id → offered; web without, and the iPhone app → not.
    expect(createWebPlatform(window, { google: { clientId: CLIENT_ID } }).google).not.toBeNull();
    expect(createWebPlatform(window, {}).google).toBeNull();
    const ios = createCapacitorPlatform(createWebPlatform(window, { google: { clientId: CLIENT_ID } }), {
      AppleSignIn: { authorize: vi.fn() },
    } as unknown as CapacitorPlugins);
    expect(ios.google).toBeNull();

    mount(await shellContext({ platform: fakePlatform('web'), signedIn: false }));
    expect(root.querySelector('[data-google]')).toBeNull();
    handle?.destroy();

    const { platform, gis } = googlePlatform();
    mount(await shellContext({ platform, signedIn: false }));
    await googleRendered();
    const actions = root.querySelector('.sign-in__actions');
    // Under Apple's button, in the same column.
    expect(actions?.firstElementChild?.classList.contains('button--apple')).toBe(true);
    expect(actions?.children[1]?.hasAttribute('data-google')).toBe(true);
    expect(gis.inits).toHaveLength(1); // loaded and initialised on the first render, not on a tap
    expect(gis.inits[0]).toMatchObject({ client_id: CLIENT_ID, ux_mode: 'popup', use_fedcm_for_prompt: true });
    expect(gis.renders[0]?.width).toBe(320);
    expect(buttonWidth(document.createElement('div'))).toBe(320);
  });

  it('[T-app-213] the nonce is the S256 of a fresh verifier per attempt and the POST body is { idToken, codeVerifier }', async () => {
    const signInWithGoogle = vi
      .fn<ApiClient['signInWithGoogle']>()
      .mockRejectedValueOnce(new HttpError(401))
      .mockResolvedValueOnce(TEST_SESSION);
    const { platform, gis } = googlePlatform();
    mount(await shellContext({ platform, api: fakeApi({ signInWithGoogle }), signedIn: false }));
    await googleRendered();
    gis.answer('token-1');
    await vi.waitFor(() => expect(gis.inits).toHaveLength(2));
    gis.answer('token-2');
    await vi.waitFor(() => expect(signInWithGoogle).toHaveBeenCalledTimes(2));

    const bodies = signInWithGoogle.mock.calls.map(([body]) => body);
    expect(bodies.map((b) => Object.keys(b).sort())).toEqual([
      ['codeVerifier', 'idToken'],
      ['codeVerifier', 'idToken'],
    ]);
    expect(bodies.map((b) => b.idToken)).toEqual(['token-1', 'token-2']);
    for (const [i, body] of bodies.entries()) {
      expect(body.codeVerifier).toMatch(/^[A-Za-z0-9_-]{64}$/);
      expect(gis.inits[i]?.nonce).toBe(await s256(body.codeVerifier, globalThis.crypto));
    }
    expect(bodies[0]?.codeVerifier).not.toBe(bodies[1]?.codeVerifier);
    // An empty credential is ignored.
    gis.inits[1]?.callback({ credential: '' });
    expect(signInWithGoogle).toHaveBeenCalledTimes(2);
  });

  it('[T-app-214] 200 stores the session and opens the Collection', async () => {
    const { platform, gis } = googlePlatform();
    const ctx = await shellContext({ platform, api: fakeApi(), signedIn: false });
    mount(ctx);
    expect(window.location.pathname).toBe('/sign-in');
    await googleRendered();
    gis.answer(idToken({ sub: GOOGLE_SUB }));
    await vi.waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(ctx.session.current()).toEqual(TEST_SESSION);
    expect(root.querySelector('h1')?.textContent).toBe(t('collection.title'));
  });

  it('[T-app-215] 403 shows the refusal with the Google sub and a copy button, and stores nothing', async () => {
    const forbidden = new ProblemError({ title: 'Forbidden', status: 403, detail: 'not allowed' });
    const signInWithGoogle = vi.fn<ApiClient['signInWithGoogle']>().mockRejectedValue(forbidden);
    const { platform, gis } = googlePlatform();
    const ctx = await shellContext({ platform, api: fakeApi({ signInWithGoogle }), signedIn: false });
    mount(ctx);
    await googleRendered();
    gis.answer(idToken({ sub: GOOGLE_SUB, email: 'owner@example.com' }));
    await vi.waitFor(() => expect(alert()).toBe(t('signIn.googleNotAllowed')));
    const panel = root.querySelector('[data-sub-provider="google"]');
    expect(panel?.textContent).toContain(t('signIn.googleNotAllowedSub'));
    expect(panel?.querySelector('code')?.textContent).toBe(GOOGLE_SUB);
    expect(panel?.querySelector('button')?.textContent).toBe(t('signIn.copy'));
    expect(ctx.session.signedIn()).toBe(false);
    expect(window.location.pathname).toBe('/sign-in');
    await vi.waitFor(() => expect(gis.inits).toHaveLength(2)); // ready for another attempt
  });

  it('[T-app-216] 401 shows a generic retry message and renders a fresh attempt', async () => {
    const signInWithGoogle = vi
      .fn<ApiClient['signInWithGoogle']>()
      .mockRejectedValue(new ProblemError({ title: 'Unauthorized', status: 401 }));
    const { platform, gis } = googlePlatform();
    mount(await shellContext({ platform, api: fakeApi({ signInWithGoogle }), signedIn: false }));
    await googleRendered();
    gis.answer('expired-token');
    await vi.waitFor(() => expect(alert()).toBe(t('signIn.googleRetry')));
    expect(root.querySelector('[data-sub-provider]')).toBeNull();
    await vi.waitFor(() => expect(gis.inits).toHaveLength(2));
    expect(gis.inits[1]?.nonce).not.toBe(gis.inits[0]?.nonce);
  });

  it('[T-app-217] a Google script that fails to load says so and leaves Apple usable', async () => {
    // The loader, on a stand-in window (the test environment never fetches the real script): a script error rejects
    // with GoogleSdkLoadError, and the next render injects the script again.
    const scripts: (EventTarget & { src: string; async: boolean })[] = [];
    const win = {
      document: {
        createElement: () => Object.assign(new EventTarget(), { src: '', async: false }),
        head: { append: (el: EventTarget & { src: string; async: boolean }) => scripts.push(el) },
      },
    } as unknown as Window & { google?: unknown };
    const load = gisLoader(win);
    const first = load();
    expect(scripts.at(-1)?.src).toBe(GOOGLE_GIS_URL);
    expect(scripts.at(-1)?.async).toBe(true);
    scripts.at(-1)?.dispatchEvent(new Event('error'));
    await expect(first).rejects.toBeInstanceOf(GoogleSdkLoadError);
    const empty = load();
    scripts.at(-1)?.dispatchEvent(new Event('load'));
    await expect(empty).rejects.toThrow('google.accounts.id missing');
    const third = load();
    expect(scripts).toHaveLength(3);
    const gis = fakeGis();
    win.google = { accounts: { id: gis.id } };
    scripts.at(-1)?.dispatchEvent(new Event('load'));
    await expect(third).resolves.toBe(gis.id);
    expect(await load()).toBe(gis.id); // already loaded: no new script
    expect(scripts).toHaveLength(3);

    const { platform } = googlePlatform(undefined, () => Promise.reject(new GoogleSdkLoadError('blocked')));
    platform.signInWithApple = vi.fn(async (req: { state: string }) => ({ identityToken: 'apple', state: req.state }));
    const ctx = await shellContext({ platform, api: fakeApi(), signedIn: false });
    mount(ctx);
    await vi.waitFor(() =>
      expect(root.querySelector('[data-google-status]')?.textContent).toBe(t('signIn.googleUnavailable')),
    );
    expect(root.querySelector<HTMLElement>('[data-google-status]')?.hidden).toBe(false);
    expect(alert()).toBe('');
    const apple = root.querySelector<HTMLButtonElement>('button.button--apple');
    await vi.waitFor(() => expect(apple?.disabled).toBe(false));
    apple?.click();
    await vi.waitFor(() => expect(ctx.session.current()).toEqual(TEST_SESSION));
  });

  it('[T-app-218] the Google sign-in copy exists in Spanish and English', () => {
    const keys = [
      'signIn.googleNotAllowed',
      'signIn.googleNotAllowedSub',
      'signIn.googleRetry',
      'signIn.googleUnavailable',
    ] as const;
    setLanguage('es');
    const es = keys.map((k) => t(k));
    setLanguage('en');
    const en = keys.map((k) => t(k));
    for (const [i, key] of keys.entries()) {
      expect(es[i]).not.toBe(key);
      expect(en[i]).not.toBe(key);
      expect(es[i]).not.toBe(en[i]);
    }
    expect(en[1]).toContain('google-identities');
    expect(es[1]).toContain('google-identities');
  });
});
