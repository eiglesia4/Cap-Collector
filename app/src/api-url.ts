// Effective API base URL (CAP-21): the build value (VITE_API_URL) unless a development build stored an override
// from Settings. Production builds ignore any stored override.
import { DEV_API_URL_KEY, parseApiUrl, type AppConfig } from './config.js';
import type { KeyValueStore } from './platform/platform.js';

export interface ApiUrlSetting {
  load(): Promise<void>;
  current(): string | null;
  override(): string | null;
  /** Validate and store an override; `''` clears it. Throws ConfigError on an invalid URL. */
  setOverride(value: string): Promise<void>;
}

export function createApiUrlSetting(config: AppConfig, store: KeyValueStore): ApiUrlSetting {
  let override: string | null = null;
  return {
    async load() {
      if (!config.dev) return;
      try {
        override = parseApiUrl((await store.get(DEV_API_URL_KEY)) ?? undefined);
      } catch {
        override = null;
        await store.remove(DEV_API_URL_KEY);
      }
    },
    current: () => (config.dev && override !== null ? override : config.apiUrl),
    override: () => override,
    async setOverride(value) {
      const parsed = parseApiUrl(value);
      if (parsed === null) await store.remove(DEV_API_URL_KEY);
      else await store.set(DEV_API_URL_KEY, parsed);
      override = parsed;
    },
  };
}
