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

/**
 * `table` = read/write on the table and its GSIs; `images-put` / `images-get` = presign PUT / GET on the images bucket;
 * `bedrock` = `bedrock:InvokeModel` on the configured model only (config `ai.modelId`, CAP-40).
 */
export type Grant = 'table' | 'images-put' | 'images-get' | 'bedrock';

/**
 * SSM-backed settings (Edu creates them once with `npm run settings:bootstrap` and fills them; the stacks only read
 * them, CAP-60): the env var each one becomes.
 */
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

/**
 * SSM-backed settings for notifications (CAP-40), read by CollectorsApi, never by a Lambda: the e-mail subscribed to
 * the alerts topic. `unset` → the topic exists without a subscription.
 */
export const NOTIFICATION_SETTINGS = ['alertEmail'] as const;
export type NotificationSettingName = (typeof NOTIFICATION_SETTINGS)[number];

/** Every `/cap/<inst>/<stage>/*` SSM setting. The stacks never create them (CAP-60); the bootstrap script does. */
export type SettingName = SecretName | CertificateSettingName | NotificationSettingName;

/** All six settings, in the order `settings:bootstrap` / `settings:show` list them (CAP-60). */
export const SETTINGS: readonly SettingName[] = [
  ...(Object.keys(SECRET_ENV) as SecretName[]),
  ...CERTIFICATE_SETTINGS,
  ...NOTIFICATION_SETTINGS,
];

/** Values from `config.ai` a function may receive (CAP-40), and the env var each one becomes. */
export const AI_ENV = {
  bedrockModelId: 'CAP_BEDROCK_MODEL_ID',
  dhashThreshold: 'CAP_DHASH_THRESHOLD',
} as const;
export type AiEnvName = keyof typeof AI_ENV;

export interface Wiring {
  readonly grants: readonly Grant[];
  readonly secrets?: readonly SecretName[];
  /** Config values passed as env vars (CAP-40). */
  readonly config?: readonly AiEnvName[];
  /** Overrides of the default sizing (FUNCTION_MEMORY_MB / FUNCTION_TIMEOUT_SECONDS) for a heavier handler. */
  readonly memoryMb?: number;
  readonly timeoutSeconds?: number;
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

  // CAP-20: every handler that returns a Cap presigns GET URLs for its images (`Cap.imageUrls`); CAP-35 adds
  // caps-create and caps-patch, which return the Cap since CAP-30. T-infra-027 keeps the list complete.
  'caps-list': { grants: ['table', 'images-get'] },
  'caps-create': { grants: ['table', 'images-get'] },
  'caps-get': { grants: ['table', 'images-get'] },
  'caps-patch': { grants: ['table', 'images-get'] },
  'caps-delete': T,
  'caps-history': T,
  'caps-location-put': T,
  'caps-location-delete': T,

  // CAP-40 (ADR-004, ADR-008 §7): scans-analyse reads the photos, compares dHashes against the table and only then
  // calls Bedrock; 1024 MB / 20 s for the model call plus two S3 reads.
  'scans-analyse': {
    grants: ['table', 'images-get', 'bedrock'],
    config: ['bedrockModelId', 'dhashThreshold'],
    memoryMb: 1024,
    timeoutSeconds: 20,
  },
  'scans-list': T,

  'albums-list': T,
  'albums-create': T,
  'albums-patch': T,
  'albums-sheet': T,
  'albums-next-free': T,

  // CAP-48 (ADR-007): exchange requests live in the table; create also writes the Scan link in the same transaction.
  'exchange-requests-list': T,
  'exchange-requests-create': T,
  'exchange-requests-patch': T,
};

/** Contract routes with their wiring; a route missing from WIRING gets nothing (and T-infra-016 fails). */
export function wireRoutes(
  routes: readonly RouteDef[],
  wiring: Readonly<Record<string, Wiring>> = WIRING,
): readonly Route[] {
  return routes.map((r) => ({ ...r, ...(wiring[r.handler] ?? NONE) }));
}

export const ROUTES: readonly Route[] = wireRoutes(CONTRACT_ROUTES);

/** The authorizer is not a route but is bundled like one; it only needs the session secret. */
export const AUTHORIZER_SECRETS: readonly SecretName[] = ['sessionSecret'];
