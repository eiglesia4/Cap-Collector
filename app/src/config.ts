// App configuration, validated at load (CLAUDE.md § conventions): API base URL from VITE_API_URL, optionally
// overridden from Settings in development builds (CAP-21), and the build version.

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface AppConfig {
  /** Build-time API base URL without trailing slash, or null when the build has none. */
  readonly apiUrl: string | null;
  readonly version: string;
  /** Development build: shows the API URL override in Settings. */
  readonly dev: boolean;
}

export interface ConfigEnv {
  readonly VITE_API_URL?: string | undefined;
  readonly DEV: boolean;
}

/** `''`/undefined → null; an http(s) URL → normalised without trailing slash; anything else throws. */
export function parseApiUrl(value: string | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`API URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`API URL must be http or https: ${raw}`);
  }
  return url.href.replace(/\/+$/, '');
}

export function loadConfig(env: ConfigEnv, version: string): AppConfig {
  return { apiUrl: parseApiUrl(env.VITE_API_URL), version, dev: env.DEV };
}

/** Store key of the development-only API URL override. */
export const DEV_API_URL_KEY = 'cap.devApiUrl';
