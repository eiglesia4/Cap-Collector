// Capacitor (iPhone) implementation of the Platform adapter: Camera, Share, Filesystem, Preferences and the native
// Sign in with Apple sheet (ADR-001, ADR-008 §4, CAP-28; in-app plugin since CAP-65). Non-image file picks (e.g. an Exchange answer JSON) fall
// back to the web <input type=file>, which WKWebView presents with the Files app.
import { App } from '@capacitor/app';
import { Camera } from '@capacitor/camera';
import { Directory, Filesystem } from '@capacitor/filesystem';
import { Preferences } from '@capacitor/preferences';
import { Share } from '@capacitor/share';

import { APPLE_CANCELLED, AppleSignIn, type AppleSignInPlugin } from './apple-sign-in-plugin.js';
import {
  AppleSignInError,
  isCancel,
  type AppleCredential,
  type AppleSignInRequest,
  type PickOptions,
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

export interface CapacitorPlugins {
  readonly Camera: Pick<typeof Camera, 'takePhoto' | 'chooseFromGallery'>;
  readonly Share: Pick<typeof Share, 'share'>;
  readonly Filesystem: Pick<typeof Filesystem, 'writeFile'>;
  readonly Preferences: Pick<typeof Preferences, 'get' | 'set' | 'remove'>;
  readonly AppleSignIn: Pick<AppleSignInPlugin, 'authorize'>;
  readonly App: Pick<typeof App, 'addListener'>;
  /** Reads a plugin `webPath` into a Blob. */
  readonly fetch: (input: string) => Promise<Response>;
}

const defaultPlugins = (): CapacitorPlugins => ({
  Camera,
  Share,
  Filesystem,
  Preferences,
  AppleSignIn,
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

export function createCapacitorPlatform(fallback: Platform, plugins: CapacitorPlugins = defaultPlugins()): Platform {
  async function fileFrom(webPath: string | undefined, name: string): Promise<File | null> {
    if (!webPath) return null;
    const blob = await (await plugins.fetch(webPath)).blob();
    return new File([blob], name, { type: blob.type || 'image/jpeg' });
  }

  // Native sheet (ASAuthorizationController, app/ios/App/App/AppleSignInPlugin.swift). The nonce is the PKCE one,
  // exactly as on the web (openapi.yaml § AppleSignInRequest); Apple does not echo `state` natively, so the request's
  // own is returned for the CAP-22 check. A coded failure becomes AppleSignInError, shown with its code (CAP-64).
  async function signInWithApple(request: AppleSignInRequest): Promise<AppleCredential | null> {
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

  return {
    kind: 'native',
    // The native sheet needs no SDK and keeps no popup to protect (CAP-64 is the web flow).
    prepareAppleSignIn: () => Promise.resolve(),
    signInWithApple,
    supportsNativeAppleSignIn: () => true,
    // `appUrlOpen` (CAP-33). The iOS plugin retains the event until a listener consumes it, so the URL a cold launch
    // came with arrives here too (SceneDelegate forwards it through SceneDelegateProxy).
    onDeepLink(listener) {
      const handle = plugins.App.addListener('appUrlOpen', (event) => listener(event.url));
      return () => void handle.then((h) => h.remove());
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
