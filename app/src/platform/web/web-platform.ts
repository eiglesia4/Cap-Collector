// Browser implementation of the Platform adapter: <input type=file> for camera and files, Web Share API,
// localStorage (with an in-memory fallback when storage is blocked) — ADR-001, CAP-21 — and Sign in with Apple JS
// (CAP-22; prepared before the tap since CAP-64), plus Google Identity Services when configured (CAP-111).
import type { AppleConfig, GoogleConfig } from '../../config.js';
import { createAppleWebSignIn, scriptLoader, type AppleIdAuth } from './apple-sign-in.js';
import { language } from '../../i18n/i18n.js';
import { createGoogleWebSignIn, gisLoader, type GoogleAccountsId } from './google-sign-in.js';
import { isCancel, type KeyValueStore, type PickOptions, type Platform, type ShareRequest } from '../platform.js';

const IMAGES = 'image/*';

export function createWebStore(win: Window): KeyValueStore {
  const memory = new Map<string, string>();
  const storage = (): Storage | null => {
    try {
      return win.localStorage;
    } catch {
      return null;
    }
  };
  return {
    async get(key) {
      try {
        return storage()?.getItem(key) ?? memory.get(key) ?? null;
      } catch {
        return memory.get(key) ?? null;
      }
    },
    async set(key, value) {
      memory.set(key, value);
      try {
        storage()?.setItem(key, value);
      } catch {
        // Storage full or blocked (private mode): the in-memory copy keeps this session working.
      }
    },
    async remove(key) {
      memory.delete(key);
      try {
        storage()?.removeItem(key);
      } catch {
        // See set().
      }
    },
  };
}

function chooseFiles(win: Window, accept: string, multiple: boolean, capture?: string): Promise<File[]> {
  return new Promise((resolve) => {
    const input = win.document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.multiple = multiple;
    if (capture) input.setAttribute('capture', capture);
    input.addEventListener('change', () => resolve(Array.from(input.files ?? [])), { once: true });
    input.addEventListener('cancel', () => resolve([]), { once: true });
    input.click();
  });
}

export interface WebPlatformOptions {
  readonly apple?: AppleConfig | null;
  /** Loads `AppleID.auth` (tests inject a fake; default injects Apple's script). */
  readonly loadAppleSdk?: () => Promise<AppleIdAuth>;
  /** Google web client (CAP-111); without it the web offers no Google button. */
  readonly google?: GoogleConfig | null;
  /** Loads `google.accounts.id` (tests inject a fake; default injects Google's script). */
  readonly loadGoogleSdk?: () => Promise<GoogleAccountsId>;
}

export function createWebPlatform(win: Window, options: WebPlatformOptions = {}): Platform {
  const apple = createAppleWebSignIn(options.apple ?? null, options.loadAppleSdk ?? scriptLoader(win));
  return {
    kind: 'web',
    os: 'web',
    features: { camera: false, appleSignIn: true, nativePlace: false, batch: true },
    prepareAppleSignIn: apple.prepare,
    signInWithApple: apple.signIn,
    supportsNativeAppleSignIn: () => false,
    google: options.google
      ? createGoogleWebSignIn(options.google, options.loadGoogleSdk ?? gisLoader(win), language)
      : null,
    onDeepLink: () => () => undefined,
    onBackButton: () => () => undefined,
    exitApp: () => undefined,
    // No geolocation on the web (features.md § Place from GPS): the form uses the last place used instead.
    currentPlace: () => Promise.resolve(null),
    async camera() {
      const [file] = await chooseFiles(win, IMAGES, false, 'environment');
      return file ?? null;
    },
    pickFiles(options: PickOptions = {}) {
      return chooseFiles(win, options.accept ?? IMAGES, options.multiple ?? false);
    },
    async share(request: ShareRequest) {
      const nav = win.navigator;
      if (typeof nav.share !== 'function') return false;
      const data: ShareData = {};
      if (request.title !== undefined) data.title = request.title;
      if (request.text !== undefined) data.text = request.text;
      if (request.url !== undefined) data.url = request.url;
      if (request.files?.length) {
        data.files = [...request.files];
        if (typeof nav.canShare === 'function' && !nav.canShare(data)) return false;
      }
      try {
        await nav.share(data);
        return true;
      } catch (error) {
        if (isCancel(error)) return false;
        throw error;
      }
    },
    store: createWebStore(win),
  };
}
