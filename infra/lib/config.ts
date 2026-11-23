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
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

/** Lowercase, digits, hyphens: it goes into bucket and table names. */
const INSTALLATION_RE = /^[a-z0-9][a-z0-9-]{1,30}[a-z0-9]$/;
/**
 * `app_origins` feeds only the images bucket CORS (the API allows `*`, CAP-62). Accepted: `http(s)://host[:port]`,
 * lowercase, no path or trailing slash — what a browser sends in `Origin` — plus exactly `capacitor://localhost`, the
 * iOS WKWebView origin, which cannot be http(s) (CAP-61 declined; architect decision 2026-11-09, ADR-008 note).
 */
const ORIGIN_RE = /^(?:https?:\/\/[a-z0-9.-]+(?::\d{1,5})?|capacitor:\/\/localhost)$/;
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
 * `project`, `UserName`, `installation` and `stage`, applied once at app level in app.ts, plus `cap:config_version`
 * (which config file a resource came from). The keys are fixed (they are the cost-allocation keys activated in
 * Billing); the `project` and `UserName` values come from the target's `tags` in config (CAP-102, 2026-11-23), so a
 * self-hosted copy never tags its resources with the owner's values. naeva/dev keeps `EIM_CAP` / `eiglesia4`.
 */
export const TAG_KEYS = {
  project: 'project',
  userName: 'UserName',
  installation: 'installation',
  stage: 'stage',
  configVersion: 'cap:config_version',
} as const;

/**
 * Installation names `cdk synth` (and every script that validates a deployment) refuses: `example` is the template
 * in `config/example.dev.json`, to be copied, never deployed (CAP-102).
 */
export const RESERVED_INSTALLATIONS: readonly string[] = ['example'];

/** An AWS tag value: 1–256 chars of letters, digits, spaces and `_ . : / = + - @` (what every service accepts). */
const TAG_VALUE_RE = /^[\p{L}\p{N} _.:/=+\-@]{1,256}$/u;

/** The tags every taggable resource carries (CONVENTIONS § AWS tagging), applied once in app.ts. */
export function deploymentTags(
  deployment: Deployment,
  config: Pick<InstallationConfig, 'config_version' | 'tags'>,
): Readonly<Record<string, string>> {
  return {
    [TAG_KEYS.project]: config.tags.project,
    [TAG_KEYS.userName]: config.tags.owner,
    [TAG_KEYS.installation]: deployment.installation,
    [TAG_KEYS.stage]: deployment.stage,
    [TAG_KEYS.configVersion]: config.config_version,
  };
}

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
  /**
   * Operations (CAP-51, CAP-57, EP-09): monthly budget, log retention and table backups. Required: every deployment
   * has logs, costs and data.
   */
  readonly ops: OpsConfig;
  /**
   * Values of the cost-allocation tags (CAP-102). Required: without them a copy of the repo would inherit someone
   * else's values, and the monthly budget would watch someone else's spend.
   */
  readonly tags: TagsConfig;
}

export interface TagsConfig {
  /** Value of the `project` tag; the monthly budget filters on it (`user:project$<project>`). */
  readonly project: string;
  /** Value of the `UserName` tag: who owns the deployment. */
  readonly owner: string;
}

export interface OpsConfig {
  /** Monthly AWS Budget, filtered by the `project` tag value of `tags`. Sent to the Budgets API as USD (config README). */
  readonly budgetEur: number;
  /** Retention of every Lambda log group: one of the values CloudWatch Logs accepts (1, 3, 5, 7, 14, 30…). */
  readonly logRetentionDays: RetentionDays;
  /** Days AWS Backup keeps each daily recovery point of the table (CAP-57; naeva.dev: 35). Whole days, ≥ 1. */
  readonly backupRetentionDays: number;
}

/** Retention values CloudWatch Logs accepts, "never expire" excluded (the one cost that grows for ever). */
export const LOG_RETENTION_DAYS: readonly number[] = Object.values(RetentionDays)
  .filter((v): v is number => typeof v === 'number' && v !== RetentionDays.INFINITE)
  .sort((a, b) => a - b);

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
  if (RESERVED_INSTALLATIONS.includes(installation)) {
    throw new Error(
      `Installation "${installation}" is the template (infra/config/${installation}.<stage>.json): ` +
        'copy it to <you>.<stage>.json and pass --context installation=<you>',
    );
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
      `${file}: "app_origins" must be a list of http(s) origins without a path (or "capacitor://localhost"), like "http://localhost:5173"`,
    );
  }
  const domains = raw.domains === undefined ? undefined : validateDomains(file, raw.domains);
  return {
    region: raw.region,
    config_version: raw.config_version,
    app_origins: origins,
    ...(domains && { domains }),
    ai: validateAi(file, raw.ai),
    ops: validateOps(file, raw.ops),
    tags: validateTags(file, raw.tags),
  };
}

/** `tags` is required: both values, each a valid AWS tag value (T-infra-047). */
function validateTags(file: string, value: unknown): TagsConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `${file}: "tags" is required: { "project": "capcollector", "owner": "<you>" } (cost-allocation tags)`,
    );
  }
  const t = value as Record<string, unknown>;
  for (const key of ['project', 'owner'] as const) {
    const v = t[key];
    if (typeof v !== 'string' || !TAG_VALUE_RE.test(v)) {
      throw new Error(`${file}: "tags.${key}" must be a tag value: 1-256 letters, digits, spaces or _ . : / = + - @`);
    }
  }
  return { project: t.project as string, owner: t.owner as string };
}

/** `ops` is required: a positive budget, a retention CloudWatch accepts and whole backup days (T-infra-032/036). */
function validateOps(file: string, value: unknown): OpsConfig {
  if (typeof value !== 'object' || value === null) {
    throw new Error(
      `${file}: "ops" is required: { "budgetEur": 10, "logRetentionDays": 30, "backupRetentionDays": 35 }`,
    );
  }
  const { budgetEur, logRetentionDays, backupRetentionDays } = value as Record<string, unknown>;
  if (typeof budgetEur !== 'number' || !Number.isFinite(budgetEur) || budgetEur <= 0) {
    throw new Error(`${file}: "ops.budgetEur" must be a positive number (monthly budget)`);
  }
  if (typeof logRetentionDays !== 'number' || !LOG_RETENTION_DAYS.includes(logRetentionDays)) {
    throw new Error(
      `${file}: "ops.logRetentionDays" must be one of ${LOG_RETENTION_DAYS.join(', ')} (CloudWatch Logs)`,
    );
  }
  if (typeof backupRetentionDays !== 'number' || !Number.isInteger(backupRetentionDays) || backupRetentionDays < 1) {
    throw new Error(`${file}: "ops.backupRetentionDays" must be a whole number of days ≥ 1 (AWS Backup retention)`);
  }
  return { budgetEur, logRetentionDays: logRetentionDays as RetentionDays, backupRetentionDays };
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
        '"eu.anthropic.claude-haiku-5-5" (never an ARN)',
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
 * The certificate ARNs live in SSM settings that no stack creates (CAP-60: `settings:bootstrap` makes them `unset`),
 * and a certificate cannot be imported from `unset`. So until Edu has filled both ARNs, deploys pass `domains=off`;
 * then the domains go on (README § Custom domains). Any other value of the flag is refused.
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
