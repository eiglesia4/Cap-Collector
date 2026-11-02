// Tests for the Sign in with Apple web adapter, its configuration and the iPhone fallback (CAP-22, ADR-008 §4).
import { describe, expect, it, vi } from 'vitest';

import { ConfigError, loadConfig, parseAppleConfig } from '../src/config';
import { createCapacitorPlatform, type CapacitorPlugins } from '../src/platform/capacitor/capacitor-platform';
import { AppleSdkLoadError, AppleSignInUnavailableError } from '../src/platform/platform';
import { APPLE_SDK_URL, createAppleWebSignIn, scriptLoader, type AppleIdAuth } from '../src/platform/web/apple-sign-in';
import { createWebPlatform } from '../src/platform/web/web-platform';
import { fakePlatform } from './support/fakes';

const APPLE = { serviceId: 'com.naevatec.collectors.web', redirectUri: 'https://d111.cloudfront.net/' };
const REQUEST = { nonce: 'nonce-1', state: 'state-1' };

function fakeSdk(signIn: AppleIdAuth['signIn']) {
  return { init: vi.fn(), signIn };
}

describe('Apple web sign-in', () => {
  it('[T-app-026] inits AppleID.auth in popup mode with Service ID, return URL, nonce and state; maps the answer; cancel → null', async () => {
    const sdk = fakeSdk(async () => ({ authorization: { id_token: 'id-token', code: 'code-1', state: 'state-1' } }));
    const signIn = createAppleWebSignIn(APPLE, async () => sdk);
    expect(await signIn(REQUEST)).toEqual({ identityToken: 'id-token', authorizationCode: 'code-1', state: 'state-1' });
    expect(sdk.init).toHaveBeenCalledWith({
      clientId: 'com.naevatec.collectors.web',
      scope: '',
      redirectURI: 'https://d111.cloudfront.net/',
      state: 'state-1',
      nonce: 'nonce-1',
      usePopup: true,
    });

    // Optional fields absent or empty are left out.
    const bare = createAppleWebSignIn(APPLE, async () =>
      fakeSdk(async () => ({ authorization: { id_token: 't', code: '' } })),
    );
    expect(await bare(REQUEST)).toEqual({ identityToken: 't' });

    for (const error of ['popup_closed_by_user', 'user_cancelled_authorize']) {
      const cancelled = createAppleWebSignIn(APPLE, async () => fakeSdk(async () => Promise.reject({ error })));
      expect(await cancelled(REQUEST)).toBeNull();
    }
    const denied = createAppleWebSignIn(APPLE, async () =>
      fakeSdk(async () => Promise.reject({ error: 'invalid_client' })),
    );
    await expect(denied(REQUEST)).rejects.toThrow('invalid_client');
    const odd = createAppleWebSignIn(APPLE, async () => fakeSdk(async () => Promise.reject(new Error('x'))));
    await expect(odd(REQUEST)).rejects.toThrow('unknown error');
    const empty = createAppleWebSignIn(APPLE, async () => fakeSdk(async () => ({})));
    await expect(empty(REQUEST)).rejects.toThrow('no identity token');

    // No configuration: refused before loading anything.
    const load = vi.fn();
    await expect(createAppleWebSignIn(null, load)(REQUEST)).rejects.toBeInstanceOf(AppleSignInUnavailableError);
    expect(load).not.toHaveBeenCalled();
  });

  it("[T-app-027] loads Apple's SDK script once on demand, retries after a failed load, and reports load failures", async () => {
    // A stand-in window: the test environment never fetches the real script.
    const scripts: (EventTarget & { src: string; async: boolean })[] = [];
    const win = {
      document: {
        createElement: () => Object.assign(new EventTarget(), { src: '', async: false }),
        head: { append: (el: EventTarget & { src: string; async: boolean }) => scripts.push(el) },
      },
    } as unknown as Window & { AppleID?: unknown };
    const load = scriptLoader(win);
    const last = () => scripts.at(-1);

    // Failed load → AppleSdkLoadError; the next attempt injects again.
    const first = load();
    expect(last()?.src).toBe(APPLE_SDK_URL);
    expect(last()?.async).toBe(true);
    last()?.dispatchEvent(new Event('error'));
    await expect(first).rejects.toBeInstanceOf(AppleSdkLoadError);

    // Loads but defines nothing.
    const second = load();
    expect(scripts).toHaveLength(2);
    last()?.dispatchEvent(new Event('load'));
    await expect(second).rejects.toThrow('AppleID.auth missing');

    // Loads and defines AppleID.auth; concurrent callers share one script.
    const sdk = fakeSdk(async () => ({}));
    const third = load();
    const concurrent = load();
    expect(scripts).toHaveLength(3);
    win.AppleID = { auth: sdk };
    last()?.dispatchEvent(new Event('load'));
    expect(await third).toBe(sdk);
    expect(await concurrent).toBe(sdk);
    // Already present: no new script.
    expect(await load()).toBe(sdk);
    expect(scripts).toHaveLength(3);
  });

  it('[T-app-028] web platform uses the web flow; the iPhone falls back to it until the native plugin is installed', async () => {
    const sdk = fakeSdk(async () => ({ authorization: { id_token: 'id-token', state: 'state-1' } }));
    const web = createWebPlatform(window, { apple: APPLE, loadAppleSdk: async () => sdk });
    expect(web.supportsNativeAppleSignIn()).toBe(false);
    expect(await web.signInWithApple(REQUEST)).toEqual({ identityToken: 'id-token', state: 'state-1' });
    await expect(createWebPlatform(window).signInWithApple(REQUEST)).rejects.toBeInstanceOf(
      AppleSignInUnavailableError,
    );

    const fallback = fakePlatform('web');
    const native = createCapacitorPlatform(fallback, {} as CapacitorPlugins);
    expect(native.supportsNativeAppleSignIn()).toBe(false);
    expect(await native.signInWithApple(REQUEST)).toBeNull();
    expect(fallback.signInWithApple).toHaveBeenCalledWith(REQUEST);
  });

  it('[T-app-029] Apple config: both values or neither, https return URL only', () => {
    expect(parseAppleConfig(undefined, undefined)).toBeNull();
    expect(parseAppleConfig(' ', '')).toBeNull();
    expect(parseAppleConfig(' com.naevatec.collectors.web ', 'https://d111.cloudfront.net')).toEqual({
      serviceId: 'com.naevatec.collectors.web',
      redirectUri: 'https://d111.cloudfront.net/',
    });
    expect(() => parseAppleConfig('id', '')).toThrow(/set together/);
    expect(() => parseAppleConfig('', 'https://x.test')).toThrow(ConfigError);
    expect(() => parseAppleConfig('id', 'not a url')).toThrow(/not a valid URL/);
    expect(() => parseAppleConfig('id', 'http://localhost:5173')).toThrow(/https/);
    expect(
      loadConfig(
        { DEV: false, VITE_APPLE_SERVICE_ID: 'id', VITE_APPLE_REDIRECT_URI: 'https://d111.cloudfront.net/' },
        '1',
      ).apple,
    ).toEqual({ serviceId: 'id', redirectUri: 'https://d111.cloudfront.net/' });
  });
});
