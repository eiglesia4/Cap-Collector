// Native Sign in with Apple on iPhone — the in-app AppleSignIn plugin since CAP-65 — and the refused-Apple-ID panel
// (CAP-28, ADR-008 §4; openapi.yaml § AppleSignInRequest).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../src/api/client';
import { HttpError, NetworkError, ProblemError } from '../src/api/errors';
import { renderApp, type AppHandle } from '../src/app';
import { appleSubFromIdentityToken } from '../src/auth/apple-sub';
import { prepareSignIn, signIn } from '../src/auth/sign-in';
import { t } from '../src/i18n/i18n';
import { APPLE_CANCELLED } from '../src/platform/capacitor/apple-sign-in-plugin';
import {
  createCapacitorPlatform,
  isAppleCancel,
  type CapacitorPlugins,
} from '../src/platform/capacitor/capacitor-platform';
import { AppleSignInError } from '../src/platform/platform';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const REQUEST = { nonce: 'nonce-1', state: 'state-1' };
const SUB = '001234.abcdef0123456789abcdef0123456789.1234';

/** base64url of raw bytes given as a binary string. */
const rawB64url = (binary: string) => btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
/** base64url of a string's UTF-8 bytes, as a JWT encodes it. */
const b64url = (s: string) => rawB64url(String.fromCharCode(...new TextEncoder().encode(s)));
/** An unsigned JWT-shaped token with the given payload (the app only ever decodes it). */
const jwt = (payload: unknown) => `${b64url('{"alg":"RS256"}')}.${b64url(JSON.stringify(payload))}.sig`;

function native(authorize: CapacitorPlugins['AppleSignIn']['authorize']) {
  const fallback = fakePlatform('web');
  const platform = createCapacitorPlatform(fallback, { AppleSignIn: { authorize } } as unknown as CapacitorPlugins);
  return { platform, fallback };
}

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const tsFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? tsFiles(path) : path.endsWith('.ts') ? [path] : [];
  });
/** A Capacitor plugin rejection: an Error carrying the native `code`. */
const rejection = (code: string, message = 'native error') => Object.assign(new Error(message), { code });

describe('native Sign in with Apple', () => {
  it('[T-app-114] calls the in-app AppleSignIn plugin with the PKCE nonce only and maps the answer, with the request state', async () => {
    const authorize = vi.fn<CapacitorPlugins['AppleSignIn']['authorize']>(async () => ({
      identityToken: 'id-token',
      authorizationCode: 'code-1',
      user: SUB,
    }));
    const { platform, fallback } = native(authorize);
    expect(platform.supportsNativeAppleSignIn()).toBe(true);
    // Nothing to prepare natively (CAP-64 is the web flow).
    await expect(platform.prepareAppleSignIn(REQUEST)).resolves.toBeUndefined();
    expect(await platform.signInWithApple(REQUEST)).toEqual({
      identityToken: 'id-token',
      authorizationCode: 'code-1',
      state: 'state-1',
    });
    // No scopes, client id or redirect: the nonce as received is all the plugin takes (ADR-008 §4).
    expect(authorize).toHaveBeenCalledWith({ nonce: 'nonce-1' });
    // Never the web popup (it cannot open in WKWebView), and no Services ID needed.
    expect(fallback.signInWithApple).not.toHaveBeenCalled();

    // An absent or empty authorization code is left out rather than sent.
    authorize.mockResolvedValueOnce({ identityToken: 't', user: SUB });
    expect(await platform.signInWithApple(REQUEST)).toEqual({ identityToken: 't', state: 'state-1' });
    authorize.mockResolvedValueOnce({ identityToken: 't', authorizationCode: '', user: SUB });
    expect(await platform.signInWithApple(REQUEST)).toEqual({ identityToken: 't', state: 'state-1' });
  });

  it('[T-app-115] a `cancelled` rejection resolves null (silent); any other code rejects with that code', async () => {
    const run = (error: unknown) => native(vi.fn(async () => Promise.reject(error))).platform.signInWithApple(REQUEST);
    expect(APPLE_CANCELLED).toBe('cancelled');
    expect(await run(rejection('cancelled', 'The operation couldn’t be completed.'))).toBeNull();

    for (const code of ['failed', 'invalidResponse', 'notHandled', 'unknown']) {
      const failure = run(rejection(code));
      await expect(failure).rejects.toBeInstanceOf(AppleSignInError);
      await expect(failure).rejects.toMatchObject({ code });
    }
    // The code wins over the (localised) message; an uncoded error is a cancel only if it says so.
    expect(isAppleCancel(rejection('failed', 'User cancelled'))).toBe(false);
    expect(isAppleCancel(rejection('cancelled', 'Vorgang abgebrochen'))).toBe(true);
    expect(isAppleCancel({ code: 'cancelled' })).toBe(true);
    expect(isAppleCancel(new Error('User cancelled'))).toBe(true);
    expect(isAppleCancel(null)).toBe(false);
    const uncoded = new Error('bridge gone');
    await expect(run(uncoded)).rejects.toBe(uncoded);

    // On the sign-in flow, a coded failure shows the generic message with the code (as on the web, CAP-64).
    const platform = fakePlatform('native');
    platform.signInWithApple = native(vi.fn(async () => Promise.reject(rejection('failed')))).platform.signInWithApple;
    const deps = { platform, api: fakeApi(), session: (await shellContext({ signedIn: false })).session };
    const prep = await prepareSignIn(deps);
    if (prep.kind !== 'ready') throw new Error('not prepared');
    expect(await signIn(deps, prep.prepared)).toEqual({ kind: 'failed', reason: 'failed', appleError: 'failed' });
  });

  it('[T-app-116] no app source imports @capacitor-community/apple-sign-in; the iOS target builds and registers the in-app plugin', () => {
    const offenders = tsFiles(join(APP, 'src'))
      .filter((file) =>
        /(from|import)\s*\(?\s*['"]@capacitor-community\/apple-sign-in['"]/.test(readFileSync(file, 'utf8')),
      )
      .map((file) => relative(APP, file));
    expect(offenders).toEqual([]);
    const importRe = /(from|import)\s*\(?\s*['"]@capacitor-community\/apple-sign-in['"]/;
    expect(importRe.test("import { SignInWithApple } from '@capacitor-community/apple-sign-in';")).toBe(true);
    expect(importRe.test("await import('@capacitor-community/apple-sign-in')")).toBe(true);

    const ios = (path: string) => readFileSync(join(APP, 'ios', 'App', path), 'utf8');
    const plugin = ios('App/AppleSignInPlugin.swift');
    expect(plugin).toContain('jsName = "AppleSignIn"');
    expect(plugin).toContain('CAPPluginMethod(name: "authorize"');
    expect(plugin).toContain('request.requestedScopes = []');
    expect(plugin).toContain('request.nonce = nonce');
    expect(plugin).toContain('case .canceled: return "cancelled"');
    expect(ios('App/MainViewController.swift')).toContain('bridge?.registerPluginInstance(AppleSignInPlugin())');
    expect(ios('App/SceneDelegate.swift')).toContain('rootViewController = MainViewController()');
    expect(ios('App/Base.lproj/Main.storyboard')).toContain('customClass="MainViewController" customModule="App"');
    const pbx = ios('App.xcodeproj/project.pbxproj');
    for (const file of ['AppleSignInPlugin.swift', 'MainViewController.swift']) {
      expect(pbx).toContain(`/* ${file} in Sources */ = {isa = PBXBuildFile;`);
      expect(pbx.match(new RegExp(`/\\* ${file} in Sources \\*/,`, 'g'))).toHaveLength(1);
    }
    // The capability stays.
    expect(ios('App/App.entitlements')).toContain('com.apple.developer.applesignin');
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
    const deps = {
      platform,
      api: { signInWithApple: async () => Promise.reject(new HttpError(403)) },
      session: ctx.session,
    };
    const prep = await prepareSignIn(deps);
    if (prep.kind !== 'ready') throw new Error('not prepared');
    expect(await signIn(deps, prep.prepared)).toEqual({
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
    // Each attempt is prepared first (CAP-64): the button is enabled once that is done.
    const ready = () =>
      vi.waitFor(() => {
        if (button()?.disabled !== false) throw new Error('not prepared');
      });

    await ready();
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
    await ready();
    button()?.click();
    expect(root.querySelector('.apple-sub')).toBeNull();
    await settle();
    expect(root.querySelector('[role="alert"]')?.textContent).toBe(t('signIn.network'));
    expect(root.querySelector('.apple-sub')).toBeNull();

    platform.signInWithApple = vi.fn(async (req) => ({ identityToken: 'opaque', state: req.state }));
    await ready();
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
