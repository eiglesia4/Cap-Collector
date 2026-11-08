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
   * Sign in with Apple (ADR-008 §4): the native sheet on iOS once the plugin is installed, otherwise the Apple JS
   * popup. Resolves null when the user cancels; throws AppleSignInUnavailableError / AppleSdkLoadError.
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
