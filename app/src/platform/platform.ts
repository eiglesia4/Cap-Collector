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

export interface Platform {
  /** `native` = Capacitor iPhone app; `web` = browser (Mac: Scan becomes "Upload photo", ADR-001). */
  readonly kind: 'web' | 'native';
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
   * URLs that opened the app (`collectors://…` on iOS, CAP-33), also the one it was cold-launched with. Returns an
   * unsubscribe. The web build never receives any: its links are ordinary HTTPS URLs.
   */
  onDeepLink(listener: (url: string) => void): () => void;
}

export function isCancel(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}
