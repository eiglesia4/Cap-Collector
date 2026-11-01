/**
 * Route manifest of the HTTP API (CAP-15): one entry per operation of doc/spec/openapi.yaml 0.1.0, which T-infra-016
 * keeps identical (paths, methods, auth). Each route is served by `api/src/handlers/<handler>.ts`; handler names follow
 * the dev-api stories (CAP-18 caps-*, CAP-19 auth-*, CAP-20 uploads-create).
 *
 * `grants` and `secrets` are the least-privilege wiring per function (story CAP-15 § IAM): nothing is granted unless
 * listed here. A dev story that needs more asks the integrator, who edits this file.
 */

export type HttpMethodName = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** `table` = read/write on the table and its GSIs; `images-put` / `images-get` = presign PUT / GET on the images bucket. */
export type Grant = 'table' | 'images-put' | 'images-get';

/** SSM-backed settings (CollectorsData creates the parameters, Edu fills them): the env var each one becomes. */
export const SECRET_ENV = {
  allowedAppleSubs: 'CAP_ALLOWED_APPLE_SUBS',
  appleClientIds: 'CAP_APPLE_CLIENT_IDS',
  sessionSecret: 'CAP_SESSION_SECRET',
} as const;
export type SecretName = keyof typeof SECRET_ENV;

export interface Route {
  readonly method: HttpMethodName;
  readonly path: string;
  readonly handler: string;
  /** true = behind the Lambda authorizer (openapi.yaml: everything except `/auth/*` and `/healthz`). */
  readonly auth: boolean;
  readonly grants: readonly Grant[];
  readonly secrets?: readonly SecretName[];
}

const r = (
  method: HttpMethodName,
  path: string,
  handler: string,
  grants: readonly Grant[] = [],
  extra: { auth?: boolean; secrets?: readonly SecretName[] } = {},
): Route => ({
  method,
  path,
  handler,
  auth: extra.auth ?? true,
  grants,
  ...(extra.secrets && { secrets: extra.secrets }),
});

const T: readonly Grant[] = ['table'];

export const ROUTES: readonly Route[] = [
  r('GET', '/healthz', 'healthz', [], { auth: false }),

  // CAP-19: refresh tokens live in the table (USER#/REFRESH#), so auth handlers need it too.
  r('POST', '/auth/apple', 'auth-apple', T, {
    auth: false,
    secrets: ['allowedAppleSubs', 'appleClientIds', 'sessionSecret'],
  }),
  r('POST', '/auth/refresh', 'auth-refresh', T, { auth: false, secrets: ['allowedAppleSubs', 'sessionSecret'] }),

  r('POST', '/uploads', 'uploads-create', ['images-put']),

  // CAP-20: caps-get / caps-list return presigned GET URLs for the images.
  r('GET', '/caps', 'caps-list', ['table', 'images-get']),
  r('POST', '/caps', 'caps-create', T),
  r('GET', '/caps/{capId}', 'caps-get', ['table', 'images-get']),
  r('PATCH', '/caps/{capId}', 'caps-patch', T),
  r('DELETE', '/caps/{capId}', 'caps-delete', T),
  r('GET', '/caps/{capId}/history', 'caps-history', T),
  r('PUT', '/caps/{capId}/location', 'caps-location-put', T),
  r('DELETE', '/caps/{capId}/location', 'caps-location-delete', T),

  // Bedrock access for scans-analyse comes with its V2 story.
  r('POST', '/scans/analyse', 'scans-analyse', T),
  r('GET', '/scans', 'scans-list', T),

  r('GET', '/albums', 'albums-list', T),
  r('POST', '/albums', 'albums-create', T),
  r('PATCH', '/albums/{albumId}', 'albums-patch', T),
  r('GET', '/albums/{albumId}/sheets/{sheet}', 'albums-sheet', T),
  r('GET', '/albums/{albumId}/next-free', 'albums-next-free', T),

  // SPEC-GAP CAP-15: the story grants the table only to cap/album/scan handlers; the exchange handlers get their
  // grants with their own (V3) story.
  r('GET', '/exchange/requests', 'exchange-requests-list'),
  r('POST', '/exchange/requests', 'exchange-requests-create'),
  r('PATCH', '/exchange/requests/{requestId}', 'exchange-requests-patch'),
];

/** The authorizer is not a route but is bundled like one; it only needs the session secret. */
export const AUTHORIZER_SECRETS: readonly SecretName[] = ['sessionSecret'];
