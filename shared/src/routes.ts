// Route manifest of the HTTP API — the single list every workspace reads (contracts v0.2, CAP-26). It mirrors
// doc/spec/openapi.yaml (T-shared-006 keeps them identical: paths, methods, auth) and names the Lambda handler
// `api/src/handlers/<handler>.ts` that serves each operation. Grants/secrets per function stay in infra (integrator).
// Owned by the architect.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface RouteDef {
  readonly method: HttpMethod;
  readonly path: string;
  /** File name under `api/src/handlers/` (without extension) and Lambda name suffix. */
  readonly handler: string;
  /** `true` = behind the session authorizer; `false` = public (`security: []` in openapi.yaml). */
  readonly auth: boolean;
}

const r = (method: HttpMethod, path: string, handler: string, auth = true): RouteDef => ({
  method,
  path,
  handler,
  auth,
});

export const ROUTES: readonly RouteDef[] = [
  r('GET', '/healthz', 'healthz', false),

  r('POST', '/auth/apple', 'auth-apple', false),
  r('POST', '/auth/refresh', 'auth-refresh', false),

  r('POST', '/uploads', 'uploads-create'),

  r('GET', '/caps', 'caps-list'),
  r('POST', '/caps', 'caps-create'),
  r('GET', '/caps/{capId}', 'caps-get'),
  r('PATCH', '/caps/{capId}', 'caps-patch'),
  r('DELETE', '/caps/{capId}', 'caps-delete'),
  r('GET', '/caps/{capId}/history', 'caps-history'),
  r('PUT', '/caps/{capId}/location', 'caps-location-put'),
  r('DELETE', '/caps/{capId}/location', 'caps-location-delete'),

  r('POST', '/scans/analyse', 'scans-analyse'),
  r('GET', '/scans', 'scans-list'),

  r('GET', '/albums', 'albums-list'),
  r('POST', '/albums', 'albums-create'),
  r('PATCH', '/albums/{albumId}', 'albums-patch'),
  r('GET', '/albums/{albumId}/sheets/{sheet}', 'albums-sheet'),
  r('GET', '/albums/{albumId}/next-free', 'albums-next-free'),

  r('GET', '/exchange/requests', 'exchange-requests-list'),
  r('POST', '/exchange/requests', 'exchange-requests-create'),
  r('PATCH', '/exchange/requests/{requestId}', 'exchange-requests-patch'),
];

/** Lookup by handler name; `undefined` for a name that is not a route (e.g. the authorizer). */
export function routeByHandler(handler: string): RouteDef | undefined {
  return ROUTES.find((x) => x.handler === handler);
}

/** Converts an openapi `{param}` path to the `:param` form some routers use. */
export function toColonPath(path: string): string {
  return path.replace(/\{([A-Za-z]+)\}/g, ':$1');
}
