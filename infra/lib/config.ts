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
}

function fromContext(app: App, key: string, envVar: string): string | undefined {
  const value = (app.node.tryGetContext(key) as string | undefined) ?? process.env[envVar];
  return value === undefined || value === '' ? undefined : value;
}

/** Reads `installation` and `stage` from CDK context or env. Neither is ever guessed. */
export function resolveDeployment(app: App): Deployment {
  const installation = fromContext(app, 'installation', 'CAP_INSTALLATION');
  if (installation === undefined) {
    throw new Error('Missing installation: pass --context installation=<id> or set CAP_INSTALLATION');
  }
  if (!INSTALLATION_RE.test(installation)) {
    throw new Error(
      `Invalid installation "${installation}": lowercase letters, digits and hyphens, 3-32 chars, ` +
        'not starting or ending with a hyphen (it goes into resource names)',
    );
  }
  const stage = fromContext(app, 'stage', 'CAP_STAGE');
  if (stage === undefined) {
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
  return { region: raw.region, config_version: raw.config_version, app_origins: origins };
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
