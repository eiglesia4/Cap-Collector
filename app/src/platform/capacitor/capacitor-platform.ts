// Capacitor implementation of the Platform adapter, for the iPhone and (CAP-112, ADR-011 §4) Android: Camera, Share,
// Filesystem, Preferences, the native place plugin, deep links, and on iOS the native Sign in with Apple sheet
// (ADR-001, ADR-008 §4, CAP-28; in-app plugin since CAP-65). Android offers no Apple sign-in (ADR-011 §3; Google comes
// in CAP-113) and adds the hardware back button. Non-image file picks (e.g. an Exchange answer JSON) fall back to the
// web <input type=file> (the Files app on iOS, the system picker on Android).
import { App } from '@capacitor/app';
import { Camera } from '@capacitor/camera';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';

import { APPLE_CANCELLED, AppleSignIn, type AppleSignInPlugin } from './apple-sign-in-plugin.js';
import {
  PLACE_GUARD_MS,
  PlaceName as PlaceNamePlugin,
  type PlaceNamePlugin as PlaceNameApi,
} from './place-name-plugin.js';
import {
  AppleSignInError,
  AppleSignInUnavailableError,
  isCancel,
  type AppleCredential,
  type AppleSignInRequest,
  type PickOptions,
  type PlaceName,
  type Platform,
  type ShareRequest,
} from '../platform.js';

/** The plugin's rejection code, when it has one (a Capacitor `CapacitorException.code`). */
function errorCode(error: unknown): string | undefined {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : undefined;
  return typeof code === 'string' && code !== '' ? code : undefined;
}

/**
 * Cancel of the native sheet: the plugin's `cancelled` code (CAP-65). A coded rejection is never read as a cancel from
 * its (localised) message; an uncoded one falls back to `isCancel`.
 */
export function isAppleCancel(error: unknown): boolean {
  const code = errorCode(error);
  return code === undefined ? isCancel(error) : code === APPLE_CANCELLED;
}

/** The plugin's answer as a PlaceName: only non-empty strings, null when it named nothing. */
function placeFrom(raw: Record<string, unknown> | null | undefined): PlaceName | null {
  if (!raw) return null;
  const out: Record<string, string> = {};
  for (const key of ['locality', 'region', 'countryCode', 'deviceRegion'] as const) {
    const value = raw[key];
    if (typeof value === 'string' && value.trim() !== '') out[key] = value.trim();
  }
  return out.locality || out.region || out.countryCode ? (out as PlaceName) : null;
}

export interface CapacitorPlugins {
  readonly Camera: Pick<typeof Camera, 'takePhoto' | 'chooseFromGallery'>;
  readonly Share: Pick<typeof Share, 'share'>;
  readonly Filesystem: Pick<typeof Filesystem, 'writeFile'>;
  readonly Preferences: Pick<typeof Preferences, 'get' | 'set' | 'remove'>;
  readonly AppleSignIn: Pick<AppleSignInPlugin, 'authorize'>;
  readonly PlaceName: Pick<PlaceNameApi, 'currentPlace'>;
  readonly App: Pick<typeof App, 'addListener' | 'exitApp' | 'getLaunchUrl'>;
  /** Reads a plugin `webPath` into a Blob. */
  readonly fetch: (input: string) => Promise<Response>;
}

export const defaultPlugins = (): CapacitorPlugins => ({
  Camera,
  Share,
  Filesystem,
  Preferences,
  AppleSignIn,
  PlaceName: PlaceNamePlugin,
  App,
  fetch: (input) => fetch(input),
});

function isImageAccept(accept: string | undefined): boolean {
  return accept === undefined || accept.split(',').every((a) => a.trim().startsWith('image/'));
}

async function toBase64(file: Blob): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function createCapacitorPlatform(
  fallback: Platform,
  plugins: CapacitorPlugins = defaultPlugins(),
  os: 'ios' | 'android' = 'ios',
): Platform {
  const android = os === 'android';
  async function fileFrom(webPath: string | undefined, name: string): Promise<File | null> {
    if (!webPath) return null;
    const blob = await (await plugins.fetch(webPath)).blob();
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  }

  // Native sheet (ASAuthorizationController, app/ios/App/App/AppleSignInPlugin.swift). The nonce is the PKCE one,
  // exactly as on the web (openapi.yaml § AppleSignInRequest); Apple does not echo `state` natively, so the request's
  // own is returned for the CAP-22 check. A coded failure becomes AppleSignInError, shown with its code (CAP-64).
  async function signInWithApple(request: AppleSignInRequest): Promise<AppleCredential | null> {
    if (android) throw new AppleSignInUnavailableError('Sign in with Apple is not offered on Android (ADR-011 §3)');
    try {
      const { identityToken, authorizationCode } = await plugins.AppleSignIn.authorize({ nonce: request.nonce });
      return {
        identityToken,
        ...(authorizationCode ? { authorizationCode } : {}),
        state: request.state,
      };
    } catch (error) {
      if (isAppleCancel(error)) return null;
      const code = errorCode(error);
      throw code === undefined ? error : new AppleSignInError(code);
    }
  }

  // CAP-100 (features.md § Place from GPS): the plugin answers within its own ≈ 3 s once location is authorised; the
  // JS guard only covers a bridge that never answers. Any failure is "no place".
  async function currentPlace(): Promise<PlaceName | null> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<null>((resolve) => {
      timer = setTimeout(() => resolve(null), PLACE_GUARD_MS);
    });
    try {
      return await Promise.race([plugins.PlaceName.currentPlace().then(placeFrom), timeout]);
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Every URL once: Android reports a cold-launch link through getLaunchUrl, and may also send it as appUrlOpen. */
  function onDeepLink(listener: (url: string) => void): () => void {
    const seen = new Set<string>();
    const deliver = (url: string) => {
      if (seen.has(url)) return;
      seen.add(url);
      listener(url);
    };
    let active = true;
    // `appUrlOpen` (CAP-33). The iOS plugin retains the event until a listener consumes it, so the URL a cold launch
    // came with arrives here too (SceneDelegate forwards it through SceneDelegateProxy).
    const handle = plugins.App.addListener('appUrlOpen', (event) => deliver(event.url));
    // Android (CAP-112): the intent the app was started with is read once.
    if (android) {
      void plugins.App.getLaunchUrl()
        .then((launch) => {
          if (active && launch?.url) deliver(launch.url);
        })
        .catch(() => undefined);
    }
    return () => {
      active = false;
      void handle.then((h) => h.remove());
    };
  }

  return {
    kind: 'native',
    os,
    features: { camera: true, appleSignIn: !android, nativePlace: true, batch: true },
    currentPlace,
    // The native sheet needs no SDK and keeps no popup to protect (CAP-64 is the web flow).
    prepareAppleSignIn: () =>
      android ? Promise.reject(new AppleSignInUnavailableError('no Apple on Android')) : Promise.resolve(),
    signInWithApple,
    supportsNativeAppleSignIn: () => !android,
    // ADR-011 §3: no Google on iOS; Android's native Credential Manager flow is CAP-113.
    google: null,
    onDeepLink,
    // Android only (CAP-112): iOS has no back button, so the listener simply never fires there.
    onBackButton(listener) {
      if (!android) return () => undefined;
      const handle = plugins.App.addListener('backButton', (event) => listener({ canGoBack: event.canGoBack }));
      return () => void handle.then((h) => h.remove());
    },
    exitApp() {
      if (android) void plugins.App.exitApp();
    },
    async camera() {
      try {
        const result = await plugins.Camera.takePhoto({ quality: 90, correctOrientation: true });
        return await fileFrom(result.webPath, `photo-${Date.now()}.jpg`);
      } catch (error) {
        if (isCancel(error)) return null;
        throw error;
      }
    },
    async pickFiles(options: PickOptions = {}) {
      if (!isImageAccept(options.accept)) return fallback.pickFiles(options);
      try {
        const { results } = await plugins.Camera.chooseFromGallery({
          allowMultipleSelection: options.multiple ?? false,
        });
        const files = await Promise.all(results.map((r, i) => fileFrom(r.webPath, `photo-${Date.now()}-${i}.jpg`)));
        return files.filter((f): f is File => f !== null);
      } catch (error) {
        if (isCancel(error)) return [];
        throw error;
      }
    },
    async share(request: ShareRequest) {
      try {
        const files: string[] = [];
        for (const file of request.files ?? []) {
          const written = await plugins.Filesystem.writeFile({
            path: `share/${file.name}`,
            data: await toBase64(file),
            directory: Directory.Cache,
            recursive: true,
          });
          files.push(written.uri);
        }
        await plugins.Share.share({
          ...(request.title !== undefined && { title: request.title }),
          ...(request.text !== undefined && { text: request.text }),
          ...(request.url !== undefined && { url: request.url }),
          ...(files.length > 0 && { files }),
        });
        return true;
      } catch (error) {
        if (isCancel(error)) return false;
        throw error;
      }
    },
    store: {
      async get(key) {
        return (await plugins.Preferences.get({ key })).value;
      },
      async set(key, value) {
        await plugins.Preferences.set({ key, value });
      },
      async remove(key) {
        await plugins.Preferences.remove({ key });
      },
    },
  };
}
