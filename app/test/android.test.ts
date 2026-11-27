// The Android shell (CAP-112; ADR-011 §3–§5; ADR-001; SCREENS.md § Sign-in; features.md § Place from GPS). CI has no
// Android SDK, so the native project is checked as files (Gradle names, strings, manifest, icons, gitignore) and the
// Android side of the platform adapter as JS: detection, feature flags, back button, deep links, place plugin, and no
// Apple sign-in. The XML files are small and Capacitor-shaped, so they are read with regular expressions (the test
// environment's DOMParser does not handle Android's namespaced attributes).
import { readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { renderApp, type AppHandle } from '../src/app';
import { t } from '../src/i18n/i18n';
import { createCapacitorPlatform, type CapacitorPlugins } from '../src/platform/capacitor/capacitor-platform';
import { AppleSignInUnavailableError, type Platform } from '../src/platform/platform';
import { createWebPlatform } from '../src/platform/web/web-platform';
import { handleBackButton } from '../src/router/back-button';
import { matchRoute } from '../src/router/routes';
import { fakePlatform, shellContext } from './support/fakes';

const APP_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const ANDROID = join(APP_DIR, 'android');
const MAIN = join(ANDROID, 'app', 'src', 'main');
const RES = join(MAIN, 'res');

const read = (...parts: string[]) => readFileSync(join(...parts), 'utf8');
/** Every `<tag …>` opening element of `text`, as its attribute source. */
const tags = (text: string, tag: string) =>
  [...text.matchAll(new RegExp(`<${tag}\\b([^>]*)>`, 'g'))].map((m) => m[1] ?? '');
/** `android:<name>="…"` (or a plain `name="…"`) of one element's attribute source. */
const attr = (attrs: string | undefined, name: string) =>
  new RegExp(`(?:android:)?\\b${name}="([^"]*)"`).exec(attrs ?? '')?.[1] ?? null;
/** Text of `<tag name="key">text</tag>`. */
const named = (text: string, tag: string, key: string) =>
  new RegExp(`<${tag} name="${key}">([^<]*)</${tag}>`).exec(text)?.[1];

type Listener = (event: never) => void;

/** Capacitor plugins for the Android adapter: App events can be fired by name; PlaceName answers `place`. */
function androidPlugins(options: { launchUrl?: string; place?: Record<string, unknown> } = {}) {
  const listeners = new Map<string, Listener>();
  const remove = vi.fn(async () => undefined);
  const App = {
    addListener: vi.fn((name: string, cb: Listener) => {
      listeners.set(name, cb);
      return Promise.resolve({ remove });
    }),
    exitApp: vi.fn(async () => undefined),
    getLaunchUrl: vi.fn(async () => (options.launchUrl === undefined ? undefined : { url: options.launchUrl })),
  };
  const PlaceName = { currentPlace: vi.fn(async () => options.place ?? {}) };
  const AppleSignIn = { authorize: vi.fn() };
  const plugins = { App, PlaceName, AppleSignIn } as unknown as CapacitorPlugins;
  const fire = (name: string, event: unknown) => listeners.get(name)?.(event as never);
  return { plugins, App, PlaceName, AppleSignIn, remove, fire };
}

const flushAll = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe('Android shell (CAP-112)', () => {
  let handle: AppHandle | undefined;
  afterEach(() => {
    handle?.destroy();
    handle = undefined;
    document.body.replaceChildren();
  });

  it('[T-app-223] the Gradle root project and the app name are CapCollector; applicationId is the bundle id', () => {
    expect(read(ANDROID, 'settings.gradle')).toMatch(/^rootProject\.name = 'CapCollector'$/m);
    // The module stays `app`, which Capacitor's CLI expects (as App.xcodeproj on iOS, CAP-94).
    expect(read(ANDROID, 'settings.gradle')).toMatch(/^include ':app'$/m);
    const strings = read(RES, 'values', 'strings.xml');
    expect(named(strings, 'string', 'app_name')).toBe('CapCollector');
    expect(named(strings, 'string', 'title_activity_main')).toBe('CapCollector');

    const appId = /appId: '([^']+)'/.exec(read(APP_DIR, 'capacitor.config.ts'))?.[1];
    expect(appId).toBe('com.naevatec.collectors');
    const gradle = read(ANDROID, 'app', 'build.gradle');
    expect(/applicationId "([^"]+)"/.exec(gradle)?.[1]).toBe(appId);
    expect(/namespace = "([^"]+)"/.exec(gradle)?.[1]).toBe(appId);
  });

  it('[T-app-224] the manifest asks only for internet, camera and coarse location, opens collectors://cap links and turns backup off', () => {
    const manifest = read(MAIN, 'AndroidManifest.xml');
    const declared = tags(manifest, 'uses-permission');
    // CAP-113: permissions merged in by libraries are stripped with tools:node="remove".
    const removed = declared.filter((p) => p.includes('tools:node="remove"')).map((p) => attr(p, 'name'));
    expect(removed.sort()).toEqual(['android.permission.USE_BIOMETRIC', 'android.permission.USE_FINGERPRINT']);
    const permissions = declared.filter((p) => !p.includes('tools:node="remove"')).map((p) => attr(p, 'name'));
    expect(permissions.sort()).toEqual([
      'android.permission.ACCESS_COARSE_LOCATION',
      'android.permission.CAMERA',
      'android.permission.INTERNET',
    ]);
    expect(attr(tags(manifest, 'application')[0], 'allowBackup')).toBe('false');

    expect(attr(tags(manifest, 'activity')[0], 'name')).toBe('.MainActivity');
    const filters = [...manifest.matchAll(/<intent-filter>([\s\S]*?)<\/intent-filter>/g)].map((m) => m[1] ?? '');
    const view = filters.find((f) => f.includes('android.intent.action.VIEW'));
    expect(view).toBeDefined();
    expect(
      tags(view ?? '', 'category')
        .map((c) => attr(c, 'name'))
        .sort(),
    ).toEqual(['android.intent.category.BROWSABLE', 'android.intent.category.DEFAULT']);
    const data = tags(view ?? '', 'data')[0];
    expect([attr(data, 'scheme'), attr(data, 'host')]).toEqual(['collectors', 'cap']);
  });

  it('[T-app-225] the platform adapter detects Android and its feature flags are right', async () => {
    const { plugins } = androidPlugins();
    const android = createCapacitorPlatform(fakePlatform('web'), plugins, 'android');
    expect([android.kind, android.os]).toEqual(['native', 'android']);
    expect(android.features).toEqual({ camera: true, appleSignIn: false, nativePlace: true, batch: true });
    expect(android.supportsNativeAppleSignIn()).toBe(false);
    expect(android.google).toBeNull(); // Google on Android is the native flow of CAP-113

    const ios = createCapacitorPlatform(fakePlatform('web'), plugins);
    expect([ios.os, ios.features.appleSignIn, ios.supportsNativeAppleSignIn()]).toEqual(['ios', true, true]);
    const web = createWebPlatform(window);
    expect([web.kind, web.os]).toEqual(['web', 'web']);
    expect(web.features).toEqual({ camera: false, appleSignIn: true, nativePlace: false, batch: true });

    // Startup: the Capacitor platform named by Capacitor.getPlatform().
    vi.resetModules();
    vi.doMock('@capacitor/core', async (importOriginal) => {
      const actual = await importOriginal<typeof import('@capacitor/core')>();
      return {
        ...actual,
        Capacitor: { ...actual.Capacitor, isNativePlatform: () => true, getPlatform: () => 'android' },
      };
    });
    try {
      const { selectPlatform } = await import('../src/platform/select-platform');
      expect((await selectPlatform(window)).os).toBe('android');
      const { nativeOs } = await import('../src/platform/capacitor/detect');
      expect(nativeOs()).toBe('android');
    } finally {
      vi.doUnmock('@capacitor/core');
      vi.resetModules();
    }
  });

  it('[T-app-226] the hardware back button goes back, lands on the Collection without history, and exits on the root', async () => {
    const platform = { onBackButton: vi.fn<Platform['onBackButton']>(), exitApp: vi.fn() };
    let route = matchRoute('/cap/01JABCDEFGHJKMNPQRSTVWXYZ0');
    const router = { current: () => route!, navigate: vi.fn() };
    const history = { back: vi.fn() } as unknown as History;
    const stop = vi.fn();
    platform.onBackButton.mockReturnValue(stop);
    expect(handleBackButton(platform, router, { history })).toBe(stop);
    const press = platform.onBackButton.mock.calls[0]![0];

    press({ canGoBack: true });
    expect(history.back).toHaveBeenCalledOnce();
    press({ canGoBack: false }); // opened from a deep link: nothing behind it
    expect(router.navigate).toHaveBeenCalledWith('/', { replace: true });
    route = matchRoute('/');
    press({ canGoBack: true });
    expect(platform.exitApp).toHaveBeenCalledOnce();
    route = matchRoute('/sign-in');
    press({ canGoBack: false });
    expect(platform.exitApp).toHaveBeenCalledTimes(2);
    expect(history.back).toHaveBeenCalledOnce();

    // The Android adapter wires Capacitor's backButton and exitApp; iOS never subscribes.
    const native = androidPlugins();
    const android = createCapacitorPlatform(fakePlatform('web'), native.plugins, 'android');
    const listener = vi.fn();
    const unsubscribe = android.onBackButton(listener);
    native.fire('backButton', { canGoBack: false });
    expect(listener).toHaveBeenCalledWith({ canGoBack: false });
    android.exitApp();
    expect(native.App.exitApp).toHaveBeenCalledOnce();
    unsubscribe();
    await flushAll();
    expect(native.remove).toHaveBeenCalled();
    const iosPlugins = androidPlugins();
    const ios = createCapacitorPlatform(fakePlatform('web'), iosPlugins.plugins, 'ios');
    ios.onBackButton(vi.fn());
    ios.exitApp();
    expect(iosPlugins.App.addListener).not.toHaveBeenCalledWith('backButton', expect.anything());
    expect(iosPlugins.App.exitApp).not.toHaveBeenCalled();

    // The shell installs it: back on the Collection leaves the app.
    const shellPlatform = fakePlatform('native');
    let shellPress: Parameters<Platform['onBackButton']>[0] = () => undefined;
    shellPlatform.onBackButton = vi.fn((l) => {
      shellPress = l;
      return () => undefined;
    });
    window.history.replaceState(null, '', '/');
    handle = renderApp(
      document.body.appendChild(document.createElement('div')),
      await shellContext({ platform: shellPlatform }),
    );
    shellPress({ canGoBack: false });
    expect(shellPlatform.exitApp).toHaveBeenCalledOnce();
  });

  it('[T-app-227] on Android the place comes from the native PlaceName plugin', async () => {
    const native = androidPlugins({
      place: { locality: 'Segovia', region: 'Segovia', countryCode: 'ES', deviceRegion: 'ES' },
    });
    const android = createCapacitorPlatform(fakePlatform('web'), native.plugins, 'android');
    expect(await android.currentPlace()).toEqual({
      locality: 'Segovia',
      region: 'Segovia',
      countryCode: 'ES',
      deviceRegion: 'ES',
    });
    expect(native.PlaceName.currentPlace).toHaveBeenCalledOnce();
    // Nothing named → no place.
    native.PlaceName.currentPlace.mockResolvedValueOnce({});
    expect(await android.currentPlace()).toBeNull();
    // The Kotlin twin is registered by MainActivity under the JS name the wrapper uses, without Play services.
    const kotlin = read(MAIN, 'java', 'com', 'naevatec', 'collectors', 'PlaceNamePlugin.kt');
    expect(kotlin).toMatch(/@CapacitorPlugin\(\s*name = "PlaceName"/);
    expect(kotlin).toContain('fun currentPlace(call: PluginCall)');
    expect(kotlin).toContain('ACCESS_COARSE_LOCATION');
    expect(kotlin).not.toMatch(/ACCESS_FINE_LOCATION|com\.google\.android\.gms/);
    expect(read(MAIN, 'java', 'com', 'naevatec', 'collectors', 'MainActivity.java')).toContain(
      'registerPlugin(PlaceNamePlugin.class)',
    );
    // Place needs no Play services (CAP-113's Google sign-in brings credentials-play-services-auth, not location).
    expect(read(ANDROID, 'app', 'build.gradle')).not.toContain('play-services-location');
  });

  it('[T-app-228] no Apple button on Android: the sign-in screen says no provider is available yet', async () => {
    const native = androidPlugins();
    const android = createCapacitorPlatform(fakePlatform('web'), native.plugins, 'android');
    await expect(android.signInWithApple({ nonce: 'n', state: 's' })).rejects.toBeInstanceOf(
      AppleSignInUnavailableError,
    );
    await expect(android.prepareAppleSignIn({ nonce: 'n', state: 's' })).rejects.toBeInstanceOf(
      AppleSignInUnavailableError,
    );
    expect(native.AppleSignIn.authorize).not.toHaveBeenCalled();

    const platform = { ...fakePlatform('native'), os: 'android' as const };
    const shown = { ...platform, features: { ...platform.features, appleSignIn: false } };
    window.history.replaceState(null, '', '/');
    const root = document.body.appendChild(document.createElement('div'));
    handle = renderApp(root, await shellContext({ platform: shown, signedIn: false }));
    expect(window.location.pathname).toBe('/sign-in');
    expect(root.querySelector('button.button--apple')).toBeNull();
    expect(root.querySelector('[data-no-provider]')?.textContent).toBe(t('signIn.noProvider'));
    expect(shown.prepareAppleSignIn).not.toHaveBeenCalled();
  });

  it('[T-app-229] a collectors:// link reaches the app once on Android, also from a cold launch', async () => {
    const url = 'collectors://cap/01JABCDEFGHJKMNPQRSTVWXYZ0';
    const native = androidPlugins({ launchUrl: url });
    const android = createCapacitorPlatform(fakePlatform('web'), native.plugins, 'android');
    const listener = vi.fn();
    const unsubscribe = android.onDeepLink(listener);
    await flushAll();
    expect(listener).toHaveBeenCalledWith(url);
    native.fire('appUrlOpen', { url }); // the same launch intent reported twice
    expect(listener).toHaveBeenCalledOnce();
    native.fire('appUrlOpen', { url: `${url}/` });
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();

    // iOS keeps relying on appUrlOpen alone.
    const ios = androidPlugins({ launchUrl: url });
    createCapacitorPlatform(fakePlatform('web'), ios.plugins, 'ios').onDeepLink(vi.fn());
    expect(ios.App.getLaunchUrl).not.toHaveBeenCalled();
  });

  it('[T-app-230] the adaptive icon is brand mark B (ink, copper cap, monochrome layer); keystores never reach git', () => {
    for (const name of ['ic_launcher', 'ic_launcher_round']) {
      const icon = read(RES, 'mipmap-anydpi-v26', `${name}.xml`);
      expect(attr(tags(icon, 'background')[0], 'drawable')).toBe('@color/ic_launcher_background');
      expect(attr(tags(icon, 'foreground')[0], 'drawable')).toBe('@drawable/ic_launcher_foreground');
      expect(attr(tags(icon, 'monochrome')[0], 'drawable')).toBe('@drawable/ic_launcher_monochrome');
    }
    const colours = read(RES, 'values', 'ic_launcher_background.xml');
    expect(named(colours, 'color', 'ic_launcher_background')).toBe('#1B1A17');
    expect(named(colours, 'color', 'splash_background')).toBe('#FAFAF7');
    // The foreground is the cap of the brand icon (generated by app/design/render.ts from icon.svg).
    const cap = /<path d="([^"]+)" fill="url\(#g\)"\/>/.exec(read(APP_DIR, 'design', 'icon.svg'))?.[1];
    expect(cap).toBeDefined();
    expect(read(RES, 'drawable', 'ic_launcher_foreground.xml')).toContain(`android:pathData="${cap ?? ''}"`);
    expect(read(RES, 'drawable', 'ic_launcher_monochrome.xml')).toContain(cap ?? '');
    for (const [density, size] of Object.entries({ mdpi: 48, hdpi: 72, xhdpi: 96, xxhdpi: 144, xxxhdpi: 192 })) {
      for (const name of ['ic_launcher', 'ic_launcher_round']) {
        const png = readFileSync(join(RES, `mipmap-${density}`, `${name}.png`));
        expect([png.readUInt32BE(16), png.readUInt32BE(20)], `${density}/${name}`).toEqual([size, size]);
      }
    }
    expect(statSync(join(RES, 'drawable', 'splash.xml')).isFile()).toBe(true);
    const ignored = read(ANDROID, '.gitignore');
    for (const pattern of ['keystore.properties', '*.jks', '*.keystore', 'local.properties', 'build/']) {
      expect(ignored.split('\n')).toContain(pattern);
    }
  });
});
