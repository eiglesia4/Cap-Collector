// Everything a screen may use, built once at startup (main.ts) and passed down — no globals (CAP-21).
import type { ApiClient } from './api/client.js';
import type { ApiUrlSetting } from './api-url.js';
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
  navigate(path: string): void;
}

export type Screen = (ctx: AppContext, route: RouteMatch) => HTMLElement;
