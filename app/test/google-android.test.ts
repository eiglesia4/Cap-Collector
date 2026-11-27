// Sign in with Google on Android (CAP-113; ADR-011 §1, §3; SCREENS.md § Sign-in): the app's own Google button opens
// the native Credential Manager plugin (stubbed) with the Web client id and nonce = S256(verifier); an ID token goes
// through the shared POST /auth/google flow to the session; a cancel is silent, an error shows a message; the GIS script
// is never loaded on Android. The Kotlin plugin and its Gradle dependencies are checked as files (no Android SDK in CI).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../src/api/client';
import { renderApp, type AppHandle } from '../src/app';
import { s256 } from '../src/auth/pkce';
import { t } from '../src/i18n/i18n';
import {
  createCapacitorPlatform,
  googleResult,
  type CapacitorPlugins,
} from '../src/platform/capacitor/capacitor-platform';
import { createWebPlatform } from '../src/platform/web/web-platform';
import { fakeApi, shellContext, TEST_SESSION } from './support/fakes';

const CLIENT_ID = '1234-web.apps.googleusercontent.com';
const ANDROID = join(dirname(fileURLToPath(import.meta.url)), '..', 'android');
const read = (...parts: string[]) => readFileSync(join(ANDROID, ...parts), 'utf8');

/** The Android platform with a stubbed GoogleSignIn plugin; the web fallback's GIS loader is a spy. */
function android(answer: (options: { serverClientId: string; nonce: string }) => Record<string, unknown>) {
  const loadGoogleSdk = vi.fn();
  const web = createWebPlatform(window, { google: { clientId: CLIENT_ID }, loadGoogleSdk });
  const signIn = vi.fn(async (options: { serverClientId: string; nonce: string }) => answer(options));
  const plugins = {
    GoogleSignIn: { signIn },
    AppleSignIn: { authorize: vi.fn() },
    App: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })), getLaunchUrl: vi.fn(async () => undefined) },
    Preferences: {
      get: vi.fn(async () => ({ value: null })),
      set: vi.fn(async () => undefined),
      remove: vi.fn(async () => undefined),
    },
  } as unknown as CapacitorPlugins;
  const platform = createCapacitorPlatform(web, plugins, 'android', { googleClientId: CLIENT_ID });
  return { platform, signIn, loadGoogleSdk };
}

describe('Sign in with Google on Android (CAP-113)', () => {
  let handle: AppHandle | undefined;
  let root: HTMLElement;
  afterEach(() => {
    handle?.destroy();
    handle = undefined;
    document.body.replaceChildren();
  });

  async function mount(platform: ReturnType<typeof android>['platform'], api = fakeApi()) {
    root = document.body.appendChild(document.createElement('div'));
    window.history.replaceState(null, '', '/');
    const ctx = await shellContext({ platform, api, signedIn: false });
    handle = renderApp(root, ctx);
    return ctx;
  }
  const googleButton = () => root.querySelector<HTMLButtonElement>('button.button--google');
  const ready = () => vi.waitFor(() => expect(googleButton()).not.toBeNull());

  it('[T-app-231] the Google button calls the native plugin with the Web client id and nonce = S256(verifier)', async () => {
    const signInWithGoogle = vi.fn<ApiClient['signInWithGoogle']>().mockResolvedValue(TEST_SESSION);
    const { platform, signIn } = android(() => ({ idToken: 'google-id-token' }));
    expect(platform.google?.kind).toBe('native');
    await mount(platform, fakeApi({ signInWithGoogle }));
    await ready();
    expect(root.querySelector('button.button--apple')).toBeNull(); // Google only on Android
    expect(root.querySelector('[data-no-provider]')).toBeNull();
    expect(googleButton()?.textContent).toBe(t('signIn.googleButton'));
    googleButton()?.click();
    await vi.waitFor(() => expect(signInWithGoogle).toHaveBeenCalledOnce());
    const [options] = signIn.mock.calls[0] ?? [];
    expect(options?.serverClientId).toBe(CLIENT_ID);
    const body = signInWithGoogle.mock.calls[0]?.[0];
    expect(options?.nonce).toBe(await s256(body?.codeVerifier ?? '', globalThis.crypto));

    // Without a client id the Android build offers no Google either (and says no provider is available).
    const bare = createCapacitorPlatform(createWebPlatform(window), {} as CapacitorPlugins, 'android');
    expect(bare.google).toBeNull();
    expect(
      createCapacitorPlatform(createWebPlatform(window), {} as CapacitorPlugins, 'ios', { googleClientId: CLIENT_ID })
        .google,
    ).toBeNull();
  });

  it('[T-app-232] an ID token is posted to /auth/google with the verifier and opens the session', async () => {
    const signInWithGoogle = vi.fn<ApiClient['signInWithGoogle']>().mockResolvedValue(TEST_SESSION);
    const { platform } = android(() => ({ idToken: 'google-id-token' }));
    const ctx = await mount(platform, fakeApi({ signInWithGoogle }));
    await ready();
    googleButton()?.click();
    await vi.waitFor(() => expect(window.location.pathname).toBe('/'));
    expect(signInWithGoogle).toHaveBeenCalledWith({ idToken: 'google-id-token', codeVerifier: expect.any(String) });
    expect(Object.keys(signInWithGoogle.mock.calls[0]?.[0] ?? {}).sort()).toEqual(['codeVerifier', 'idToken']);
    expect(ctx.session.current()).toEqual(TEST_SESSION);
  });

  it('[T-app-233] a cancelled sheet stays on the sign-in screen without an error', async () => {
    const signInWithGoogle = vi.fn<ApiClient['signInWithGoogle']>();
    const { platform, signIn } = android(() => ({ cancelled: true }));
    await mount(platform, fakeApi({ signInWithGoogle }));
    await ready();
    googleButton()?.click();
    await vi.waitFor(() => expect(signIn).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(googleButton()?.disabled).toBe(false));
    expect(window.location.pathname).toBe('/sign-in');
    expect(root.querySelector('[role="alert"]')?.textContent).toBe('');
    expect(signInWithGoogle).not.toHaveBeenCalled();
  });

  it('[T-app-234] a plugin error shows the message with its code and stores nothing', async () => {
    const { platform } = android(() => ({ error: 'android.credentials.GetCredentialException.TYPE_UNKNOWN' }));
    const ctx = await mount(platform);
    await ready();
    googleButton()?.click();
    await vi.waitFor(() => expect(root.querySelector('[role="alert"]')?.textContent).toBe(t('signIn.failed')));
    expect(root.querySelector('[data-apple-error]')?.textContent).toBe(
      t('signIn.googleError', { code: 'android.credentials.GetCredentialException.TYPE_UNKNOWN' }),
    );
    expect(ctx.session.signedIn()).toBe(false);
    // The wrapper turns anything unexpected into an error, never a throw.
    expect(googleResult({ idToken: '' })).toEqual({ error: 'unknown' });
    expect(googleResult(null)).toEqual({ error: 'unknown' });
    expect(googleResult({ cancelled: true })).toEqual({ cancelled: true });
    const rejecting = android(() => {
      throw new Error('bridge');
    });
    await expect(
      rejecting.platform.google?.kind === 'native' && rejecting.platform.google.signIn({ nonce: 'n' }),
    ).resolves.toEqual({
      error: 'Error',
    });
  });

  it('[T-app-235] no Google Identity Services script is loaded on Android', async () => {
    const { platform, loadGoogleSdk } = android(() => ({ cancelled: true }));
    await mount(platform);
    await ready();
    expect(loadGoogleSdk).not.toHaveBeenCalled();
    expect(document.querySelector('script[src*="accounts.google.com"]')).toBeNull();
    expect(root.querySelector('.gsi-stub, iframe')).toBeNull();
  });

  it('[T-app-236] the Kotlin plugin uses Credential Manager (Google ID, then the Sign in with Google sheet) and never logs the token', () => {
    const kotlin = read('app', 'src', 'main', 'java', 'com', 'naevatec', 'collectors', 'GoogleSignInPlugin.kt');
    expect(kotlin).toContain('@CapacitorPlugin(name = "GoogleSignIn")');
    for (const call of [
      '.setServerClientId(serverClientId)',
      '.setNonce(nonce)',
      '.setFilterByAuthorizedAccounts(false)',
      '.setAutoSelectEnabled(true)',
      'GetSignInWithGoogleOption.Builder(serverClientId).setNonce(nonce)',
      'NoCredentialException',
    ]) {
      expect(kotlin).toContain(call);
    }
    expect(kotlin).not.toMatch(/\bLog\.|println|Logger/);
    expect(read('app', 'src', 'main', 'java', 'com', 'naevatec', 'collectors', 'MainActivity.java')).toContain(
      'registerPlugin(GoogleSignInPlugin.class)',
    );
    const gradle = read('app', 'build.gradle');
    for (const dep of [
      'androidx.credentials:credentials:',
      'androidx.credentials:credentials-play-services-auth:',
      'com.google.android.libraries.identity.googleid:googleid:',
    ]) {
      expect(gradle).toContain(dep);
    }
  });
});
