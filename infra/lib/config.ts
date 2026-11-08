/**
 * Deployment identity: installation, stage, per-target config file and the account guard.
 *
 * Adapted from CCS_MRV `infra/lib/config.ts` (CCSMRV-32), as Seshet does. Hard rule: **no account, region, ARN or
 * endpoint in code or tests**. `installation` and `stage` come from CDK context (or CAP_INSTALLATION / CAP_STAGE);
 * the region from `config/<installation>.<stage>.json`; the expected account from `.envrc.local`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { App } from 'aws-cdk-lib';

/** Lowercase, digits, hyphens: it goes into bucket and table names. */
const INSTALLATION_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
/** scheme://host[:port], no path — what a browser sends in `Origin`. */
const ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/[^/\s]+$/;
/** Free text (dev, prod, test…); only its shape is checked. */
const STAGE_RE = /^[a-z0-9][a-z0-9-]{0,15}$/;
/** A bare DNS name (no scheme, no path, no trailing dot), lowercase: what CloudFront and API Gateway accept. */
/**
 * A Bedrock model id (`anthropic.claude-…-v1:0`) or a cross-region inference profile id (`eu.anthropic.…`); never an
 * ARN, which would carry an account or a region (CONVENTIONS: nothing account-specific is committed).
 */
const MODEL_ID_RE = /^([a-z]{2,6}\.)?[a-z0-9-]+\.[a-z0-9][a-z0-9.:-]*$/;
/** Geography prefixes of Bedrock cross-region inference profiles (`eu.`, `us.`, `apac.`, `global.`…). */
const INFERENCE_PROFILE_PREFIX_RE = /^(eu|us|us-gov|apac|jp|au|ca|global)\./;
/** A 64-bit dHash: Hamming distances go from 0 to 64 (ADR-004). */
export const DHASH_BITS = 64;
const HOSTNAME_RE = /^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * AWS tagging (CONVENTIONS.md § AWS tagging, decided in CAP-13 revision, 2026-11-01): every taggable resource carries
 * `project`, `UserName`, `installation` and `stage`, applied once at app level in app.ts. `project` and `UserName`
 * never vary per installation/stage, so they are constants here and not in config/*.json. Cost Explorer filters on
 * `project = EIM_CAP`. `cap:config_version` is kept as well (which config file a resource came from).
 */
export const TAG_KEYS = {
  project: 'project',
  userName: 'UserName',
  installation: 'installation',
  stage: 'stage',
  configVersion: 'cap:config_version',
} as const;
export const PROJECT_TAG_VALUE = 'EIM_CAP';
export const USER_NAME_TAG_VALUE = 'eiglesia4';

/** Directory holding `<installation>.<stage>.json` files. */
export const CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'config');

export interface Deployment {
  readonly installation: string;
  readonly stage: string;
}

export interface InstallationConfig {
  readonly config_version: string;
  readonly region: string;
  /** Origins allowed to PUT images with a presigned URL (CORS on the images bucket, CAP-13). Optional, default none. */
  readonly app_origins: readonly string[];
  /**
   * Custom domains (ADR-008 §5 as amended 2026-11-02, CAP-29). Optional: without it the web build and the API keep
   * their default CloudFront / API Gateway URLs. DNS stays at GoDaddy; the certificates come from SSM.
   */
  readonly domains?: Domains;
  /** Vision identification and duplicate detection (ADR-004, ADR-008 §7, CAP-40). Required: scans-analyse needs it. */
  readonly ai: AiConfig;
}

export interface AiConfig {
  /** Bedrock model id or cross-region inference profile id (Claude Haiku-class vision model, ADR-002/ADR-008 §7). */
  readonly modelId: string;
  /** Hamming distance ≤ this → "Already in collection", no AI call (ADR-004; start at 10, tuned from Scan items). */
  readonly dhashThreshold: number;
}

/** True for an inference profile id (`eu.anthropic.…`): IAM must allow the profile and the models it routes to. */
export const isInferenceProfile = (modelId: string): boolean => INFERENCE_PROFILE_PREFIX_RE.test(modelId);

/** The foundation model behind a model id: the inference profile prefix removed, if any. */
export const foundationModelId = (modelId: string): string => modelId.replace(INFERENCE_PROFILE_PREFIX_RE, '');

export interface Domains {
  /** Host of the web build on CloudFront, e.g. `caps.naevatec.com` (certificate in us-east-1). */
  readonly web: string;
  /** Host of the HTTP API, e.g. `api.caps.naevatec.com` (regional certificate, same region as the stack). */
  readonly api: string;
}

function fromContext(app: App, key: string, envVar: string): string | undefined {
  const value = (app.node.tryGetContext(key) as string | undefined) ?? process.env[envVar];
  return value === undefined || value === '' ? undefined : value;
}

/** Reads `installation` and `stage` from CDK context or env. Neither is ever guessed. */
export function resolveDeployment(app: App): Deployment {
  return validateDeployment(
    fromContext(app, 'installation', 'CAP_INSTALLATION'),
    fromContext(app, 'stage', 'CAP_STAGE'),
  );
}

/** Validates an installation/stage pair from any source (CDK context, env, a script's own variables). */
export function validateDeployment(installation: string | undefined, stage: string | undefined): Deployment {
  if (installation === undefined || installation === '') {
    throw new Error('Missing installation: pass --context installation=<id> or set CAP_INSTALLATION');
  }
  if (!INSTALLATION_RE.test(installation)) {
    throw new Error(
      `Invalid installation "${installation}": lowercase letters, digits and hyphens, 3-32 chars, ` +
        'not starting or ending with a hyphen (it goes into resource names)',
    );
  }
  if (stage === undefined || stage === '') {
    throw new Error('Missing stage: pass --context stage=<id> or set CAP_STAGE');
  }
  if (!STAGE_RE.test(stage)) {
    throw new Error(`Invalid stage "${stage}": lowercase letters, digits and hyphens, up to 16 chars`);
  }
  return { installation, stage };
}

/**
 * Loads `config/<installation>.<stage>.json`. A target without a file is not a deployable target: synth fails
 * here instead of inventing a region or creating a parallel set of resources (T-infra-002).
 */
export function loadInstallationConfig(deployment: Deployment, dir: string = CONFIG_DIR): InstallationConfig {
  const file = join(dir, `${deployment.installation}.${deployment.stage}.json`);
  if (!existsSync(file)) {
    throw new Error(
      `No config for ${deployment.installation}/${deployment.stage}: ${file} does not exist.\n` +
        '  Only targets declared in infra/config/ can be synthesized.',
    );
  }
  const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<InstallationConfig>;
  if (typeof raw.region !== 'string' || raw.region === '') {
    throw new Error(`${file}: "region" is required`);
  }
  if (typeof raw.config_version !== 'string' || raw.config_version === '') {
    throw new Error(`${file}: "config_version" is required`);
  }
  const origins = raw.app_origins ?? [];
  if (!Array.isArray(origins) || origins.some((o) => typeof o !== 'string' || !ORIGIN_RE.test(o))) {
    throw new Error(
      `${file}: "app_origins" must be a list of origins like "https://example.org" or "capacitor://localhost"`,
    );
  }
  const domains = raw.domains === undefined ? undefined : validateDomains(file, raw.domains);
  return {
    region: raw.region,
    config_version: raw.config_version,
    app_origins: origins,
    ...(domains && { domains }),
    ai: validateAi(file, raw.ai),
  };
}

/** `ai` is required: a bare model id or inference profile id, and an integer threshold 0…64 (T-infra-030). */
function validateAi(file: string, value: unknown): AiConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(`${file}: "ai" is required: { "modelId": "<bedrock model id>", "dhashThreshold": 10 }`);
  }
  const { modelId, dhashThreshold } = value as Record<string, unknown>;
  if (typeof modelId !== 'string' || !MODEL_ID_RE.test(modelId)) {
    throw new Error(
      `${file}: "ai.modelId" must be a Bedrock model id or inference profile id like ` +
        '"eu.anthropic.claude-haiku-4-5-20251001-v1:0" (never an ARN)',
    );
  }
  if (
    typeof dhashThreshold !== 'number' ||
    !Number.isInteger(dhashThreshold) ||
    dhashThreshold < 0 ||
    dhashThreshold > DHASH_BITS
  ) {
    throw new Error(`${file}: "ai.dhashThreshold" must be an integer from 0 to ${DHASH_BITS} (Hamming distance)`);
  }
  return { modelId, dhashThreshold };
}

/** `domains` is all or nothing: both hosts, both bare lowercase DNS names (T-infra-026). */
function validateDomains(file: string, value: unknown): Domains {
  const d = (typeof value === 'object' && value !== null ? value : {}) as Record<string, unknown>;
  for (const key of ['web', 'api'] as const) {
    const host = d[key];
    if (typeof host !== 'string' || !HOSTNAME_RE.test(host)) {
      throw new Error(
        `${file}: "domains.${key}" must be a bare host name like "caps.example.org" ` +
          '("domains" needs both "web" and "api")',
      );
    }
  }
  return { web: d.web as string, api: d.api as string };
}

/**
 * The config with its `domains` removed when CDK context `domains=off` is passed.
 * SPEC-GAP CAP-29: the certificate ARNs live in SSM parameters that CollectorsData itself creates (story), but a stack
 * cannot read at deploy time a parameter it creates in the same deploy. So the very first rollout deploys
 * CollectorsData once with `domains=off` (creates the `unset` parameters, nothing else changes), Edu fills them, and
 * only then deploys with the domains on (README § Custom domains). Any other value of the flag is refused.
 */
export function applyDomainsSwitch(app: App, config: InstallationConfig): InstallationConfig {
  const flag: unknown = app.node.tryGetContext('domains');
  if (flag === undefined || flag === 'on') return config;
  if (flag !== 'off') throw new Error(`Invalid context domains="${String(flag)}": use "off" (or omit it)`);
  const { domains: _omitted, ...rest } = config;
  return rest;
}

/** `CAP_ACCOUNT_<INSTALLATION>_<STAGE>`, uppercase, hyphens → underscores. The account belongs to the pair. */
export function accountVarName(deployment: Deployment): string {
  const norm = (v: string) => v.replace(/-/g, '_').toUpperCase();
  return `CAP_ACCOUNT_${norm(deployment.installation)}_${norm(deployment.stage)}`;
}

/**
 * Fails when the active profile's account is not the one this deployment declares (T-infra-002).
 * Checked at synth, before touching AWS, and **only when there is something to compare**: without the variable or
 * without CDK_DEFAULT_ACCOUNT (no credentials, as in CI) it stays silent so credential-less synth keeps working.
 */
export function assertAccountMatchesDeployment(deployment: Deployment): void {
  const variable = accountVarName(deployment);
  const expected = process.env[variable];
  const actual = process.env.CDK_DEFAULT_ACCOUNT;
  if (!expected || !actual || expected === actual) return;

  const profile = process.env.AWS_PROFILE ?? '(no AWS_PROFILE)';
  throw new Error(
    `Wrong account for ${deployment.installation}/${deployment.stage}: ` +
      `${variable} says ${expected} and profile "${profile}" resolves ${actual}.\n` +
      '  Check --profile, or fix the variable in .envrc.local if the target is right.',
  );
}

/** Resource / stack name: `cap-<installation>-<stage>-<resource>`. */
export function resourceName(deployment: Deployment, resource: string): string {
  return `cap-${deployment.installation}-${deployment.stage}-${resource}`;
}
