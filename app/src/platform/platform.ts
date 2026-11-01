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
}

export function isCancel(error: unknown): boolean {
  if (error instanceof Error && error.name === 'AbortError') return true;
  const message = error instanceof Error ? error.message : String(error);
  return /cancel/i.test(message);
}
