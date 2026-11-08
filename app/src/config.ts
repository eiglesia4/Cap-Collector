// App configuration, validated at load (CLAUDE.md § conventions): API base URL from VITE_API_URL, optionally
// overridden from Settings in development builds (CAP-21), the build version, and the Sign in with Apple web
// client (CAP-22: VITE_APPLE_SERVICE_ID + VITE_APPLE_REDIRECT_URI, see doc/plans/CAP-22-sign-in.md) and the public
// web origin that share links point at (CAP-31: VITE_WEB_URL, ADR-008 §5 as amended 2026-11-07).

export class ConfigError extends Error {
  override readonly name = 'ConfigError';
}

export interface AppConfig {
  /** Build-time API base URL without trailing slash, or null when the build has none. */
  readonly apiUrl: string | null;
  readonly version: string;
  /** Development build: shows the API URL override in Settings. */
  readonly dev: boolean;
  /** Sign in with Apple web client, or null when the build has none (the sign-in screen then says so). */
  readonly apple: AppleConfig | null;
  /** Public HTTPS origin of the web build (`https://caps.naevatec.com`), or null when the build has none. */
  readonly webUrl: string | null;
}

/** Apple Services ID and the return URL registered for it (the CloudFront web URL, CAP-16). */
export interface AppleConfig {
  readonly serviceId: string;
  readonly redirectUri: string;
}

export interface ConfigEnv {
  readonly VITE_API_URL?: string | undefined;
  readonly VITE_APPLE_SERVICE_ID?: string | undefined;
  readonly VITE_APPLE_REDIRECT_URI?: string | undefined;
  readonly VITE_WEB_URL?: string | undefined;
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

/** Both empty → null; both set → validated (Apple only accepts https return URLs); one without the other throws. */
export function parseAppleConfig(serviceId: string | undefined, redirectUri: string | undefined): AppleConfig | null {
  const id = serviceId?.trim() ?? '';
  const uri = redirectUri?.trim() ?? '';
  if (id === '' && uri === '') return null;
  if (id === '' || uri === '') {
    throw new ConfigError('VITE_APPLE_SERVICE_ID and VITE_APPLE_REDIRECT_URI must be set together');
  }
  let url: URL;
  try {
    url = new URL(uri);
  } catch {
    throw new ConfigError(`Apple return URL is not a valid URL: ${uri}`);
  }
  if (url.protocol !== 'https:') throw new ConfigError(`Apple return URL must be https: ${uri}`);
  return { serviceId: id, redirectUri: url.href };
}

/** `''`/undefined → null; an https origin (a trailing `/` is allowed) → `https://host[:port]`; anything else throws. */
export function parseWebUrl(value: string | undefined): string | null {
  const raw = value?.trim() ?? '';
  if (raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError(`Web URL is not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'https:') throw new ConfigError(`Web URL must be https: ${raw}`);
  // Share links append `/cap/<id>` and the SPA lives at the root, so only a bare origin is accepted.
  if (url.pathname !== '/' || url.search !== '' || url.hash !== '' || url.username !== '' || url.password !== '') {
    throw new ConfigError(`Web URL must be an origin without path, query or credentials: ${raw}`);
  }
  return url.origin;
}

export function loadConfig(env: ConfigEnv, version: string): AppConfig {
  return {
    apiUrl: parseApiUrl(env.VITE_API_URL),
    version,
    dev: env.DEV,
    apple: parseAppleConfig(env.VITE_APPLE_SERVICE_ID, env.VITE_APPLE_REDIRECT_URI),
    webUrl: parseWebUrl(env.VITE_WEB_URL),
  };
}

/** Store key of the development-only API URL override. */
export const DEV_API_URL_KEY = 'cap.devApiUrl';
