// Native Sign in with Apple on iPhone and the refused-Apple-ID panel (CAP-28, ADR-008 §4; openapi.yaml §
// AppleSignInRequest).
import { afterEach, describe, expect, it, vi } from 'vitest';

import capacitorConfig from '../capacitor.config';
import type { ApiClient } from '../src/api/client';
import { HttpError, NetworkError, ProblemError } from '../src/api/errors';
import { renderApp, type AppHandle } from '../src/app';
import { appleSubFromIdentityToken } from '../src/auth/apple-sub';
import { signIn } from '../src/auth/sign-in';
import { t } from '../src/i18n/i18n';
import {
  createCapacitorPlatform,
  IOS_BUNDLE_ID,
  isAppleCancel,
  type CapacitorPlugins,
} from '../src/platform/capacitor/capacitor-platform';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const REQUEST = { nonce: 'nonce-1', state: 'state-1' };
const SUB = '001234.abcdef0123456789abcdef0123456789.1234';

/** base64url of raw bytes given as a binary string. */
const rawB64url = (binary: string) => btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** base64url of a string's UTF-8 bytes, as a JWT encodes it. */
const b64url = (s: string) => rawB64url(String.fromCharCode(...new TextEncoder().encode(s)));
/** An unsigned JWT-shaped token with the given payload (the app only ever decodes it). */
const jwt = (payload: unknown) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(payload))}.sig`;

function native(authorize: CapacitorPlugins['SignInWithApple']['authorize']) {
  const fallback = fakePlatform('web');
  const platform = createCapacitorPlatform(fallback, { SignInWithApple: { authorize } } as unknown as CapacitorPlugins);
  return { platform, fallback };
}

describe('native Sign in with Apple', () => {
  it('[T-app-044] calls the native sheet with the bundle id, PKCE nonce and state, and maps the answer to a credential', async () => {
    expect(IOS_BUNDLE_ID).toBe(capacitorConfig.appId);
    const authorize = vi.fn(async () => ({
      response: {
        user: SUB,
        email: null,
        givenName: null,
        familyName: null,
        identityToken: 'id-token',
        authorizationCode: 'code-1',
      },
    }));
    const { platform, fallback } = native(authorize);
    expect(platform.supportsNativeAppleSignIn()).toBe(true);
    expect(await platform.signInWithApple(REQUEST)).toEqual({
      identityToken: 'id-token',
      authorizationCode: 'code-1',
      state: 'state-1',
    });
    expect(authorize).toHaveBeenCalledWith({
      clientId: 'com.naevatec.collectors',
      redirectURI: '',
      scopes: 'email',
      nonce: 'nonce-1',
      state: 'state-1',
    });
    // Never the web popup (it cannot open in WKWebView), and no Services ID needed.
    expect(fallback.signInWithApple).not.toHaveBeenCalled();

    // An empty authorization code is left out rather than sent.
    authorize.mockResolvedValueOnce({
      response: {
        user: SUB,
        email: null,
        givenName: null,
        familyName: null,
        identityToken: 't',
        authorizationCode: '',
      },
    });
    expect(await platform.signInWithApple(REQUEST)).toEqual({ identityToken: 't', state: 'state-1' });
  });

  it('[T-app-045] a cancelled native sheet resolves null; other plugin errors propagate', async () => {
    const canceled = new Error(
      'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)',
    );
    expect(await native(vi.fn(async () => Promise.reject(canceled))).platform.signInWithApple(REQUEST)).toBeNull();
    expect(
      await native(vi.fn(async () => Promise.reject(new Error('User cancelled')))).platform.signInWithApple(REQUEST),
    ).toBeNull();

    const failed = new Error(
      'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)',
    );
    expect(isAppleCancel(failed)).toBe(false);
    expect(isAppleCancel('AuthorizationError error 10010')).toBe(false);
    // The code wins over the (localised) message: 1001 is cancel whatever the text says; another code is not.
    const coded = (code: unknown, message: string) => Object.assign(new Error(message), { code });
    expect(isAppleCancel(coded('1001', 'Vorgang abgebrochen'))).toBe(true);
    expect(isAppleCancel(coded(1001, 'Operación fallida'))).toBe(true);
    expect(isAppleCancel(coded('1000', 'Unknown failure'))).toBe(false);
    expect(isAppleCancel({ code: '1001' })).toBe(true);
    expect(isAppleCancel(null)).toBe(false);
    await expect(native(vi.fn(async () => Promise.reject(failed))).platform.signInWithApple(REQUEST)).rejects.toBe(
      failed,
    );
  });
});

describe('refused Apple ID', () => {
  it('[T-app-046] decodes the Apple user id (sub) from the identity token payload, never failing on bad tokens', () => {
    expect(appleSubFromIdentityToken(jwt({ iss: 'https://appleid.apple.com', sub: SUB }))).toBe(SUB);
    // base64url alphabet and UTF-8 in other claims are handled.
    expect(appleSubFromIdentityToken(jwt({ sub: 'a', name: 'Ñandú ~~~ ???' }))).toBe('a');
    for (const bad of [
      'id-token',
      'a.b',
      'a..c',
      'a.!!!.c',
      `x.${b64url('not json')}.y`,
      jwt(null),
      jwt({ sub: 42 }),
      jwt({ sub: '' }),
      jwt({ email: 'x@y' }),
      `x.${rawB64url('\xff\xfe')}.y`,
    ]) {
      expect(appleSubFromIdentityToken(bad)).toBeNull();
    }
  });

  it('[T-app-047] on 403 the sign-in screen shows the decoded sub with a copy action; other failures show none', async () => {
    const token = jwt({ sub: SUB });
    const platform = fakePlatform('native');
    platform.signInWithApple = vi.fn(async (req) => ({ identityToken: token, state: req.state }));
    const signInWithApple = vi
      .fn<ApiClient['signInWithApple']>()
      .mockRejectedValueOnce(new ProblemError({ title: 'Forbidden', status: 403 }))
      .mockRejectedValueOnce(new NetworkError('offline'))
      .mockRejectedValueOnce(new HttpError(403));
    const ctx = await shellContext({ platform, api: fakeApi({ signInWithApple }), signedIn: false });

    // The flow result carries the sub only for "not allowed".
    expect(
      await signIn({
        platform,
        api: { signInWithApple: async () => Promise.reject(new HttpError(403)) },
        session: ctx.session,
      }),
    ).toEqual({
      kind: 'failed',
      reason: 'not-allowed',
      appleSub: SUB,
    });

    window.history.replaceState(null, '', '/');
    const root = document.createElement('div');
    document.body.replaceChildren(root);
    const handle: AppHandle = renderApp(root, ctx);
    const button = () => root.querySelector<HTMLButtonElement>('.button--apple');
    const settle = async () => {
      for (let i = 0; i < 5; i++) await flush();
    };

    button()?.click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(t('signIn.notAllowed'));
    expect(root.querySelector('.apple-sub p')?.textContent).toBe(t('signIn.notAllowedSub'));
    expect(root.querySelector('.apple-sub__value')?.textContent).toBe(SUB);

    // Copy: Clipboard API when present…
    const writeText = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, 'clipboard', { value: { writeText }, configurable: true });
    const copy = root.querySelector<HTMLButtonElement>('.apple-sub__copy');
    expect(copy?.textContent).toBe(t('signIn.copy'));
    copy?.click();
    await flush();
    expect(writeText).toHaveBeenCalledWith(SUB);
    expect(copy?.textContent).toBe(t('signIn.copied'));
    // …a refused clipboard or none at all selects the id instead.
    const selectAllChildren = vi.fn();
    vi.spyOn(window, 'getSelection').mockReturnValue({ selectAllChildren } as unknown as Selection);
    writeText.mockRejectedValueOnce(new Error('denied'));
    copy?.click();
    await flush();
    Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true });
    copy?.click();
    expect(selectAllChildren).toHaveBeenCalledTimes(2);

    // Another failure clears the panel; a 403 whose token has no readable sub shows only the message.
    button()?.click();
    expect(root.querySelector('.apple-sub')).toBeNull();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(t('signIn.network'));
    expect(root.querySelector('.apple-sub')).toBeNull();

    platform.signInWithApple = vi.fn(async (req) => ({ identityToken: 'opaque', state: req.state }));
    button()?.click();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(t('signIn.notAllowed'));
    expect(root.querySelector('.apple-sub')).toBeNull();
    handle.destroy();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});
