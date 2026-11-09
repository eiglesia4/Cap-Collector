// Everything a screen may use, built once at startup (main.ts) and passed down — no globals (CAP-21).
import type { ApiClient } from './api/client.js';
import type { ApiUrlSetting } from './api-url.js';
import type { CaptureStore } from './capture/context.js';
import type { AppConfig } from './config.js';
import type { Platform } from './platform/platform.js';
import type { RouteMatch } from './router/routes.js';
import type { SessionStore } from './session/session-store.js';

export interface AppContext {
  readonly config: AppConfig;
  readonly platform: Platform;
  readonly session: SessionStore;
  readonly api: ApiClient;
  readonly apiUrl: ApiUrlSetting;
  /** Scan context of the capture modal (CAP-41), in memory only. */
  readonly capture: CaptureStore;
  navigate(path: string): void;
  /** Development builds only (CAP-22): enter the app without a session, e.g. against `npm run api:local`. */
  skipSignIn(): void;
  /** Sign-in cancelled: forget the cap link that was waiting for it (CAP-54). Absent outside the shell. */
  cancelPendingRoute?(): void;
}

export type Screen = (ctx: AppContext, route: RouteMatch) => HTMLElement;
