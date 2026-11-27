// Device adapter (CLAUDE.md § app, ADR-001): everything that differs between the iPhone (Capacitor) and the
// Mac browser goes through this interface, so screens and the web build are testable without native plugins.

export interface KeyValueStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}

export interface PickOptions {
  /** `accept` attribute syntax, e.g. `image/*` or `.json,application/json`. Default: images. */
  readonly accept?: string;
  readonly multiple?: boolean;
}

export interface ShareRequest {
  readonly title?: string;
  readonly text?: string;
  readonly url?: string;
  readonly files?: readonly File[];
}

/** What the app hands the Apple sheet / popup for one attempt (src/auth/pkce.ts). */
export interface AppleSignInRequest {
  /** base64url(SHA-256(codeVerifier)); Apple copies it into the identity token's `nonce` claim. */
  readonly nonce: string;
  readonly state: string;
}

/** What Apple returns on success; the identity token is never logged. */
export interface AppleCredential {
  readonly identityToken: string;
  readonly authorizationCode?: string;
  /** `state` as echoed by Apple; must equal the request's. */
  readonly state?: string;
}

/** Sign in with Apple cannot run in this build (no Service ID / return URL configured). */
export class AppleSignInUnavailableError extends Error {
  override readonly name = 'AppleSignInUnavailableError';
}

/** The Apple JS SDK could not be loaded (offline, blocked). */
export class AppleSdkLoadError extends Error {
  override readonly name = 'AppleSdkLoadError';
}

/**
 * Apple's popup reported an error that is not a cancel (CAP-64): `code` is Apple's `error` string, e.g.
 * `popup_blocked_by_browser` or `invalid_client`, shown to the user so a config error can be told from a browser one.
 */
export class AppleSignInError extends Error {
  override readonly name = 'AppleSignInError';
  constructor(readonly code: string) {
    super(`Sign in with Apple failed: ${code}`);
  }
}

/**
 * The place the phone is at, as names only (CAP-100, features.md § Place from GPS): reverse-geocoded on the device
 * from a reduced-accuracy fix. Coordinates never leave the native plugin.
 */
export interface PlaceName {
  readonly locality?: string;
  /** Province or region (`subAdministrativeArea ?? administrativeArea`), e.g. `Segovia`. */
  readonly region?: string;
  /** ISO 3166-1 alpha-2 of the place. */
  readonly countryCode?: string;
  /** ISO region of the device's settings (`Locale.current`), to leave out the country when it is the same. */
  readonly deviceRegion?: string;
}

/** Google Identity Services could not be loaded (offline, blocked) — CAP-111. */
export class GoogleSdkLoadError extends Error {
  override readonly name = 'GoogleSdkLoadError';
}

/** Sign in with Google where this platform offers it (ADR-011 §3; CAP-111 on the web). */
export interface GoogleSignIn {
  /**
   * Load Google's script (once) and render its button into `parent` for one attempt: the ID token Google returns
   * carries `nonce`, and `onCredential` receives it. Render again with a fresh nonce after every attempt. Rejects
   * with GoogleSdkLoadError when the script cannot be loaded.
   */
  renderButton(
    parent: HTMLElement,
    request: { readonly nonce: string },
    onCredential: (idToken: string) => void,
  ): Promise<void>;
}

/** Where the bundle runs (ADR-001, ADR-011 §4): the browser, or the Capacitor shell on iOS or Android. */
export type PlatformOs = 'web' | 'ios' | 'android';

/** What each platform offers (CAP-112, ADR-011 §3–§4). */
export interface PlatformFeatures {
  /** Takes photos with the camera; the web uploads a photo instead ("Upload photo", ADR-001). */
  readonly camera: boolean;
  /** Sign in with Apple is offered: the JS popup on the web, the native sheet on iOS; never on Android. */
  readonly appleSignIn: boolean;
  /** "Where acquired" from the device's location (features.md § Place from GPS): the native place plugins. */
  readonly nativePlace: boolean;
  /** Batch capture of a tray (ADR-009), on every platform ("Upload tray photo" on the web). */
  readonly batch: boolean;
}

export interface Platform {
  /** `native` = Capacitor app (iPhone or Android); `web` = browser (Mac: Scan becomes "Upload photo", ADR-001). */
  readonly kind: 'web' | 'native';
  readonly os: PlatformOs;
  readonly features: PlatformFeatures;
  /** Take one photo; null when the user cancels. */
  camera(): Promise<File | null>;
  /** Pick files; empty when the user cancels. */
  pickFiles(options?: PickOptions): Promise<File[]>;
  /** Open the share sheet; false when sharing is unavailable or the user cancels. */
  share(request: ShareRequest): Promise<boolean>;
  /** Small persistent key/value store (Preferences on iOS, localStorage on web). */
  readonly store: KeyValueStore;
  /**
   * Everything Sign in with Apple needs before the tap (CAP-64): on the web, load Apple's SDK and `init` it with this
   * attempt's state and nonce, so the tap can open the popup without losing the user gesture. Idempotent per request;
   * call it again with a fresh request after every attempt. Rejects with AppleSignInUnavailableError /
   * AppleSdkLoadError. Nothing to do on iOS.
   */
  prepareAppleSignIn(request: AppleSignInRequest): Promise<void>;
  /**
   * Sign in with Apple (ADR-008 §4): the native sheet on iOS, otherwise the Apple JS popup for the request given to
   * prepareAppleSignIn. Starts synchronously, so it must be called straight from the tap handler (Safari blocks a
   * popup opened after an `await`). Resolves null when the user cancels; rejects with AppleSignInError,
   * AppleSignInUnavailableError or AppleSdkLoadError.
   */
  signInWithApple(request: AppleSignInRequest): Promise<AppleCredential | null>;
  /** True when signInWithApple uses the native iOS sheet rather than the web flow. */
  supportsNativeAppleSignIn(): boolean;
  /**
   * Sign in with Google, or null where it is not offered (ADR-011 §3): the web with a Google client id configured;
   * never on iOS; Android brings its own native flow in CAP-113.
   */
  readonly google: GoogleSignIn | null;
  /**
   * URLs that opened the app (`collectors://…` on iOS, CAP-33), also the one it was cold-launched with. Returns an
   * unsubscribe. The web build never receives any: its links are ordinary HTTPS URLs.
   */
  onDeepLink(listener: (url: string) => void): () => void;
  /**
   * The Android hardware back button (CAP-112, SCREENS.md § Sign-in): `canGoBack` is the WebView's history. Returns an
   * unsubscribe. Never fires on the web or iOS.
   */
  onBackButton(listener: (event: { readonly canGoBack: boolean }) => void): () => void;
  /** Leave the app (Android back on the Collection); does nothing on the web and iOS. */
  exitApp(): void;
  /**
   * Where the phone is now (CAP-100): asks for "when in use" location the first time, ≈ 3 s at most. Null on denial,
   * timeout, error or no result, and always on the web (no geolocation there). Never rejects.
   */
  currentPlace(): Promise<PlaceName | null>;
}

export function isCancel(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}
