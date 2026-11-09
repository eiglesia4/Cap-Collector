// Tests for the Sign in with Apple web adapter and its configuration (CAP-22, ADR-008 §4), and the prepare-then-tap
// flow that keeps Safari's user gesture (CAP-64).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderApp, type AppHandle } from '../src/app';

import { ConfigError, loadConfig, parseAppleConfig } from '../src/config';
import { AppleSdkLoadError, AppleSignInError, AppleSignInUnavailableError } from '../src/platform/platform';
import { APPLE_SDK_URL, createAppleWebSignIn, scriptLoader, type AppleIdAuth } from '../src/platform/web/apple-sign-in';
import { createWebPlatform } from '../src/platform/web/web-platform';
import { t } from '../src/i18n/i18n';
import { fakeApi, shellContext } from './support/fakes';

const APPLE = { serviceId: 'com.naevatec.collectors.web', redirectUri: 'https://d111.cloudfront.net/' };
const REQUEST = { nonce: 'nonce-1', state: 'state-1' };

function fakeSdk(signIn: AppleIdAuth['signIn']) {
  return { init: vi.fn(), signIn };
}

describe('Apple web sign-in', () => {
  it('[T-app-026] prepare inits AppleID.auth in popup mode with Service ID, return URL, nonce and state; signIn maps the answer; cancel → null; Apple codes → AppleSignInError', async () => {
    const sdk = fakeSdk(async () => ({ authorization: { id_token: 'id-token', code: 'code-1', state: 'state-1' } }));
    const apple = createAppleWebSignIn(APPLE, async () => sdk);
    await apple.prepare(REQUEST);
    await apple.prepare(REQUEST); // idempotent for the same attempt
    expect(sdk.init).toHaveBeenCalledTimes(1);
    expect(sdk.init).toHaveBeenCalledWith({
      clientId: 'com.naevatec.collectors.web',
      scope: '',
      redirectURI: 'https://d111.cloudfront.net/',
      state: 'state-1',
      nonce: 'nonce-1',
      usePopup: true,
    });
    expect(await apple.signIn(REQUEST)).toEqual({
      identityToken: 'id-token',
      authorizationCode: 'code-1',
      state: 'state-1',
    });
    // A prepared attempt is used once; an unprepared or other attempt is refused without opening anything.
    await expect(apple.signIn(REQUEST)).rejects.toThrow('not prepared');
    await apple.prepare(REQUEST);
    await expect(apple.signIn({ nonce: 'n', state: 'other' })).rejects.toThrow('not prepared');
    expect(sdk.init).toHaveBeenCalledTimes(2);

    const answering = async (signIn: AppleIdAuth['signIn']) => {
      const web = createAppleWebSignIn(APPLE, async () => fakeSdk(signIn));
      await web.prepare(REQUEST);
      return web.signIn(REQUEST);
    };
    // Optional fields absent or empty are left out.
    expect(await answering(async () => ({ authorization: { id_token: 't', code: '' } }))).toEqual({
      identityToken: 't',
    });
    for (const error of ['popup_closed_by_user', 'user_cancelled_authorize']) {
      expect(await answering(async () => Promise.reject({ error }))).toBeNull();
    }
    for (const code of ['invalid_client', 'popup_blocked_by_browser']) {
      const failure = answering(async () => Promise.reject({ error: code }));
      await expect(failure).rejects.toBeInstanceOf(AppleSignInError);
      await expect(failure).rejects.toMatchObject({ code });
    }
    await expect(answering(async () => Promise.reject(new Error('x')))).rejects.toThrow('unknown error');
    await expect(
      answering(() => {
        throw { error: 'invalid_request' };
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
    await expect(answering(async () => ({}))).rejects.toThrow('no identity token');

    // No configuration: refused before loading anything.
    const load = vi.fn();
    const none = createAppleWebSignIn(null, load);
    await expect(none.prepare(REQUEST)).rejects.toBeInstanceOf(AppleSignInUnavailableError);
    await expect(none.signIn(REQUEST)).rejects.toBeInstanceOf(AppleSignInUnavailableError);
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

  it('[T-app-028] web platform uses the web flow (the iPhone uses the native sheet since CAP-28, T-app-045)', async () => {
    const sdk = fakeSdk(async () => ({ authorization: { id_token: 'id-token', state: 'state-1' } }));
    const web = createWebPlatform(window, { apple: APPLE, loadAppleSdk: async () => sdk });
    expect(web.supportsNativeAppleSignIn()).toBe(false);
    await web.prepareAppleSignIn(REQUEST);
    expect(await web.signInWithApple(REQUEST)).toEqual({ identityToken: 'id-token', state: 'state-1' });
    await expect(createWebPlatform(window).prepareAppleSignIn(REQUEST)).rejects.toBeInstanceOf(
      AppleSignInUnavailableError,
    );
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

describe('web sign-in keeps the user gesture (CAP-64)', () => {
  let root: HTMLElement;
  let handle: AppHandle | undefined;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
    window.history.replaceState(null, '', '/sign-in');
  });
  afterEach(() => handle?.destroy());

  const button = () => root.querySelector<HTMLButtonElement>('button.button--apple');
  const alert = () => root.querySelector('[role="alert"]')?.textContent;
  const code = () => root.querySelector<HTMLElement>('[data-apple-error]');
  const retry = () => root.querySelector<HTMLButtonElement>('[data-action="retry"]');
  const ready = () =>
    vi.waitFor(() => {
      if (button()?.disabled !== false) throw new Error('not prepared');
    });

  /** A fake SDK whose popup answers with `answer()`, recording whether it was opened inside the click. */
  function sdk(answer: () => Promise<Awaited<ReturnType<AppleIdAuth['signIn']>>>) {
    const state = { inClick: false, openedInClick: [] as boolean[] };
    const auth = {
      init: vi.fn<AppleIdAuth['init']>(),
      signIn: vi.fn(() => {
        state.openedInClick.push(state.inClick);
        return answer();
      }),
    };
    /** The click, as the user's gesture: synchronous code inside it sees `inClick`. */
    const tap = () => {
      state.inClick = true;
      button()?.click();
      state.inClick = false;
    };
    return { auth, state, tap };
  }

  async function mount(auth: AppleIdAuth, load: () => Promise<AppleIdAuth> = async () => auth, api = fakeApi()) {
    const platform = createWebPlatform(window, { apple: APPLE, loadAppleSdk: load });
    const ctx = await shellContext({ platform, api, signedIn: false });
    handle = renderApp(root, ctx);
    return ctx;
  }

  const lastInit = (auth: { init: ReturnType<typeof vi.fn<AppleIdAuth['init']>> }) => auth.init.mock.calls.at(-1)?.[0];

  it("[T-app-109] the tap opens Apple's popup synchronously; init ran before it with the prepared state and nonce", async () => {
    const fake = sdk(() => new Promise(() => undefined));
    await mount(fake.auth);
    // Before preparation the button is disabled and says so.
    expect(button()?.disabled).toBe(true);
    expect(button()?.textContent).toBe(t('signIn.loading'));
    await ready();
    expect(button()?.textContent).toBe(t('signIn.button'));
    expect(fake.auth.init).toHaveBeenCalledTimes(1);
    const init = lastInit(fake.auth);
    expect(init).toMatchObject({ usePopup: true, clientId: APPLE.serviceId, redirectURI: APPLE.redirectUri });
    expect(init?.state).toMatch(/^[\w-]{16,}$/);
    expect(init?.nonce).toMatch(/^[\w-]{43}$/);

    fake.tap();
    expect(fake.state.openedInClick).toEqual([true]);
    expect(button()?.disabled).toBe(true);
  });

  it('[T-app-110] after every attempt (success, cancel, error) the next one is prepared with a fresh state and nonce', async () => {
    const answers = [
      async () => Promise.reject({ error: 'popup_closed_by_user' }),
      async () => Promise.reject({ error: 'invalid_client' }),
    ];
    const fake = sdk(() => (answers.shift() ?? (() => Promise.reject({ error: 'x' })))());
    await mount(fake.auth);
    const seen = new Set<string>();
    const nonces = new Set<string>();
    for (let attempt = 0; attempt < 2; attempt++) {
      await ready();
      const init = lastInit(fake.auth);
      seen.add(init?.state ?? '');
      nonces.add(init?.nonce ?? '');
      fake.tap();
      await vi.waitFor(() => expect(fake.auth.init).toHaveBeenCalledTimes(attempt + 2));
    }
    await ready();
    seen.add(lastInit(fake.auth)?.state ?? '');
    nonces.add(lastInit(fake.auth)?.nonce ?? '');
    expect(seen.size).toBe(3);
    expect(nonces.size).toBe(3);
    expect(fake.state.openedInClick).toEqual([true, true]);

    // Success: the identity token for the prepared state is posted and the next attempt is prepared too.
    handle?.destroy();
    root.replaceChildren();
    window.history.replaceState(null, '', '/sign-in');
    let posted = '';
    const ok = sdk(() => Promise.resolve({ authorization: { id_token: 'id-token', state: posted } }));
    const api = fakeApi();
    const ctx = await mount(ok.auth, async () => ok.auth, api);
    await ready();
    posted = lastInit(ok.auth)?.state ?? '';
    ok.tap();
    await vi.waitFor(() => expect(ctx.session.signedIn()).toBe(true));
    expect(api.signInWithApple).toHaveBeenCalledTimes(1);
    expect(ok.state.openedInClick).toEqual([true]);
    await vi.waitFor(() => expect(ok.auth.init).toHaveBeenCalledTimes(2));
    expect(lastInit(ok.auth)?.state).not.toBe(posted);
  });

  it('[T-app-111] popup_blocked_by_browser shows the pop-up message for this host', async () => {
    const fake = sdk(async () => Promise.reject({ error: 'popup_blocked_by_browser' }));
    await mount(fake.auth);
    await ready();
    fake.tap();
    await ready();
    expect(alert()).toBe(t('signIn.popupBlocked', { host: window.location.host }));
    expect(alert()).toContain(window.location.host);
    expect(code()?.hidden).toBe(true);
  });

  it('[T-app-112] any other Apple error shows the generic message with the code in small print; cancel stays silent', async () => {
    const answers = [
      async () => Promise.reject({ error: 'invalid_client' }),
      async () => Promise.reject({ error: 'user_cancelled_authorize' }),
    ];
    const fake = sdk(() => (answers.shift() ?? (() => Promise.reject({ error: 'x' })))());
    await mount(fake.auth);
    await ready();
    fake.tap();
    await ready();
    expect(alert()).toBe(t('signIn.failed'));
    expect(code()?.hidden).toBe(false);
    expect(code()?.textContent).toBe(t('signIn.appleError', { code: 'invalid_client' }));
    expect(code()?.textContent).toContain('invalid_client');

    fake.tap();
    expect(code()?.hidden).toBe(true);
    await ready();
    expect(alert()).toBe('');
    expect(code()?.hidden).toBe(true);
  });

  it('[T-app-113] an SDK that fails to load keeps the button disabled and offers Retry, which prepares again', async () => {
    const fake = sdk(async () => Promise.reject({ error: 'popup_closed_by_user' }));
    const load = vi
      .fn<() => Promise<AppleIdAuth>>()
      .mockRejectedValueOnce(new AppleSdkLoadError('blocked'))
      .mockResolvedValue(fake.auth);
    await mount(fake.auth, load);
    await vi.waitFor(() => expect(retry()).not.toBeNull());
    expect(button()?.disabled).toBe(true);
    expect(alert()).toBe(t('signIn.network'));
    expect(retry()?.textContent).toBe(t('common.retry'));
    fake.tap();
    expect(fake.auth.signIn).not.toHaveBeenCalled();

    retry()?.click();
    expect(retry()).toBeNull();
    expect(alert()).toBe('');
    await ready();
    expect(load).toHaveBeenCalledTimes(2);
    expect(fake.auth.init).toHaveBeenCalledTimes(1);
    fake.tap();
    expect(fake.state.openedInClick).toEqual([true]);
  });
});
