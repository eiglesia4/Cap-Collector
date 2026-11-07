/**
 * Route manifest of the HTTP API as infra deploys it: the contract's routes (`ROUTES` from `@capcollector/shared`,
 * CAP-26 — paths, methods, handler names, auth; T-shared-006 keeps them identical to doc/spec/openapi.yaml) plus the
 * per-function wiring that only infra decides (CAP-15 § IAM, consumed from shared since CAP-27).
 *
 * `grants` and `secrets` are least privilege: nothing is granted unless listed in WIRING. A dev story that needs more
 * asks the integrator, who edits this file. T-infra-016 fails when a contract route has no WIRING entry (a new route
 * must be wired on purpose) or an entry names a handler the contract does not have.
 */
import { ROUTES as CONTRACT_ROUTES, type RouteDef } from '@capcollector/shared';

/** `table` = read/write on the table and its GSIs; `images-put` / `images-get` = presign PUT / GET on the images bucket. */
export type Grant = 'table' | 'images-put' | 'images-get';

/** SSM-backed settings (CollectorsData creates the parameters, Edu fills them): the env var each one becomes. */
export const SECRET_ENV = {
  allowedAppleSubs: 'CAP_ALLOWED_APPLE_SUBS',
  appleClientIds: 'CAP_APPLE_CLIENT_IDS',
  sessionSecret: 'CAP_SESSION_SECRET',
} as const;
export type SecretName = keyof typeof SECRET_ENV;

/**
 * SSM-backed settings read by the stacks themselves, never by a Lambda (CAP-29): the ACM certificate ARNs of the
 * custom domains. Same `/cap/<inst>/<stage>/<name>` parameters as the secrets, but no env var, so they can never be
 * listed in a route's `secrets` (the type forbids it; T-infra-024 checks the bundles' env).
 * `webCertificateArn` → ACM in us-east-1 (CloudFront); `apiCertificateArn` → ACM in the stack's region (regional API).
 */
export const CERTIFICATE_SETTINGS = ['webCertificateArn', 'apiCertificateArn'] as const;
export type CertificateSettingName = (typeof CERTIFICATE_SETTINGS)[number];

/** Every SSM parameter CollectorsData creates with the `unset` placeholder. */
export type SettingName = SecretName | CertificateSettingName;

export interface Wiring {
  readonly grants: readonly Grant[];
  readonly secrets?: readonly SecretName[];
}

/** A contract route plus its wiring. */
export interface Route extends RouteDef, Wiring {}

const NONE: Wiring = { grants: [] };
const T: Wiring = { grants: ['table'] };

/** Wiring per handler name (the contract's `RouteDef.handler`). */
export const WIRING: Readonly<Record<string, Wiring>> = {
  healthz: NONE,

  // CAP-19: refresh tokens live in the table (USER#/REFRESH#), so auth handlers need it too.
  'auth-apple': { grants: ['table'], secrets: ['allowedAppleSubs', 'appleClientIds', 'sessionSecret'] },
  'auth-refresh': { grants: ['table'], secrets: ['allowedAppleSubs', 'sessionSecret'] },

  'uploads-create': { grants: ['images-put'] },

  // CAP-20: caps-get / caps-list return presigned GET URLs for the images.
  'caps-list': { grants: ['table', 'images-get'] },
  'caps-create': T,
  'caps-get': { grants: ['table', 'images-get'] },
  'caps-patch': T,
  'caps-delete': T,
  'caps-history': T,
  'caps-location-put': T,
  'caps-location-delete': T,

  // Bedrock access for scans-analyse comes with its V2 story.
  'scans-analyse': T,
  'scans-list': T,

  'albums-list': T,
  'albums-create': T,
  'albums-patch': T,
  'albums-sheet': T,
  'albums-next-free': T,

  // SPEC-GAP CAP-15: the story grants the table only to cap/album/scan handlers; the exchange handlers get their
  // grants with their own (V3) story.
  'exchange-requests-list': NONE,
  'exchange-requests-create': NONE,
  'exchange-requests-patch': NONE,
};

/** Contract routes with their wiring; a route missing from WIRING gets nothing (and T-infra-016 fails). */
export function wireRoutes(
  routes: readonly RouteDef[],
  wiring: Readonly<Record<string, Wiring>> = WIRING,
): readonly Route[] {
  return routes.map((r) => {
    const w = wiring[r.handler] ?? NONE;
    return { ...r, grants: w.grants, ...(w.secrets && { secrets: w.secrets }) };
  });
}

export const ROUTES: readonly Route[] = wireRoutes(CONTRACT_ROUTES);

/** The authorizer is not a route but is bundled like one; it only needs the session secret. */
export const AUTHORIZER_SECRETS: readonly SecretName[] = ['sessionSecret'];
