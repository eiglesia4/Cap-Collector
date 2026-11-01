// Typed API client (CAP-21): fetch wrapper with the base URL from config, bearer token from the session store,
// one refresh-and-retry on 401 (then sign-out), bodies parsed with contract schemas (never `as`) and RFC 9457
// problems surfaced as ProblemError. Routes and bodies: doc/spec/openapi.yaml.
import type { SessionStore } from '../session/session-store.js';
import {
  HttpError,
  NetworkError,
  NotConfiguredError,
  ProblemError,
  ResponseValidationError,
  UnauthorizedError,
} from './errors.js';
import { HealthzSchema, ProblemSchema, SessionSchema, type Healthz, type Schema } from './schema.js';

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RequestOptions<T> {
  readonly method?: Method;
  readonly body?: unknown;
  /** Contract schema of the 2xx body (a `@capcollector/shared` zod schema or one of ./schema.ts). */
  readonly schema: Schema<T>;
  /** Send the bearer token and refresh on 401. Default true; false for `/healthz` and `/auth/*`. */
  readonly auth?: boolean;
}

export interface ApiClient {
  request<T>(path: string, options: RequestOptions<T>): Promise<T>;
  healthz(): Promise<Healthz>;
}

export interface ApiClientDeps {
  /** Current base URL (re-read per request so a Settings override applies immediately). */
  readonly baseUrl: () => string | null;
  readonly session: SessionStore;
  readonly fetch?: typeof fetch;
}

export function createApiClient({
  baseUrl,
  session,
  fetch: fetchFn = (...a) => fetch(...a),
}: ApiClientDeps): ApiClient {
  let refreshing: Promise<boolean> | null = null;

  async function send(path: string, method: Method, body: unknown, bearer: string | null): Promise<Response> {
    const base = baseUrl();
    if (base === null) throw new NotConfiguredError('API URL not configured');
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (bearer !== null) headers.Authorization = `Bearer ${bearer}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    try {
      return await fetchFn(base + path, init);
    } catch (error) {
      throw new NetworkError(`${method} ${path} failed`, { cause: error });
    }
  }

  async function readJson(res: Response): Promise<{ ok: true; value: unknown } | { ok: false; error: unknown }> {
    if (res.status === 204) return { ok: true, value: undefined };
    try {
      return { ok: true, value: JSON.parse(await res.text()) };
    } catch (error) {
      return { ok: false, error };
    }
  }

  async function parse<T>(path: string, res: Response, schema: Schema<T>): Promise<T> {
    const json = await readJson(res);
    if (!res.ok) {
      const problem = json.ok ? ProblemSchema.safeParse(json.value) : null;
      if (problem?.success) throw new ProblemError(problem.data);
      throw new HttpError(res.status);
    }
    if (!json.ok) throw new ResponseValidationError(path, json.error);
    const result = schema.safeParse(json.value);
    if (!result.success) throw new ResponseValidationError(path, result.error);
    return result.data;
  }

  // SPEC-GAP CAP-21: openapi.yaml `/auth/refresh` declares no request body; the refresh token is sent as
  // `{ refreshToken }` JSON (the conservative reading of ADR-008 §4). To be confirmed by the architect.
  async function refresh(): Promise<boolean> {
    const current = session.current();
    if (!current) return false;
    const res = await send('/auth/refresh', 'POST', { refreshToken: current.refreshToken }, null);
    if (!res.ok) return false;
    await session.save(await parse('/auth/refresh', res, SessionSchema));
    return true;
  }

  /** Concurrent 401s share one refresh call. */
  function refreshOnce(): Promise<boolean> {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  async function request<T>(path: string, options: RequestOptions<T>): Promise<T> {
    const method = options.method ?? 'GET';
    const auth = options.auth ?? true;
    const bearer = () => (auth ? (session.current()?.accessToken ?? null) : null);
    let res = await send(path, method, options.body, bearer());
    if (auth && res.status === 401) {
      if (!(await refreshOnce())) {
        await session.signOut();
        throw new UnauthorizedError('session expired');
      }
      res = await send(path, method, options.body, bearer());
      if (res.status === 401) {
        await session.signOut();
        throw new UnauthorizedError('session rejected after refresh');
      }
    }
    return parse(path, res, options.schema);
  }

  return {
    request,
    healthz: () => request('/healthz', { schema: HealthzSchema, auth: false }),
  };
}
