// Synth guards (CAP-11): a target must be declared in infra/config/ and the active account must match it.
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { accountVarName, loadInstallationConfig, resolveDeployment } from '../lib/config.js';

// Fake account ids with the right shape, built rather than written (no 12-digit literals in the repo).
const fakeAccount = (n: number) => String(n).padStart(12, '0');
const ACCOUNT_A = fakeAccount(1);
const ACCOUNT_B = fakeAccount(2);

const ENV_KEYS = ['CDK_DEFAULT_ACCOUNT', 'CAP_ACCOUNT_NAEVA_DEV', 'CAP_INSTALLATION', 'CAP_STAGE', 'AWS_PROFILE'];
const saved: Record<string, string | undefined> = {};

const appFor = (installation: string, stage: string) => new App({ context: { installation, stage } });

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('synth guard', () => {
  it('[T-infra-002] synth fails for an installation/stage or account not declared in config/', () => {
    // Target without a config file → refused, whatever the credentials.
    expect(() => buildApp(appFor('naeva', 'prod'))).toThrow(/No config for naeva\/prod/);
    expect(() => buildApp(appFor('acme', 'dev'))).toThrow(/No config for acme\/dev/);

    // Declared target, but the profile resolves a different account → refused, naming both accounts.
    process.env.CAP_ACCOUNT_NAEVA_DEV = ACCOUNT_A;
    process.env.CDK_DEFAULT_ACCOUNT = ACCOUNT_B;
    process.env.AWS_PROFILE = 'some-profile';
    expect(() => buildApp(appFor('naeva', 'dev'))).toThrow(
      new RegExp(`Wrong account for naeva/dev[\\s\\S]*${ACCOUNT_A}[\\s\\S]*some-profile[\\s\\S]*${ACCOUNT_B}`),
    );
  });

  it('[T-infra-003] synth passes for a declared target, matching account or no credentials (CI)', () => {
    // No credentials at all: the guard has nothing to compare and stays silent.
    const ci = buildApp(appFor('naeva', 'dev'));
    expect(ci.data.stackName).toBe('cap-naeva-dev-data');
    expect(ci.api.stackName).toBe('cap-naeva-dev-api');
    expect(ci.data.region).toBe('eu-west-1');
    Template.fromStack(ci.data);
    Template.fromStack(ci.api);

    // Matching account.
    process.env.CAP_ACCOUNT_NAEVA_DEV = ACCOUNT_A;
    process.env.CDK_DEFAULT_ACCOUNT = ACCOUNT_A;
    expect(() => buildApp(appFor('naeva', 'dev'))).not.toThrow();
  });

  it('[T-infra-004] installation and stage are required and validated, from context or env', () => {
    expect(() => resolveDeployment(new App())).toThrow(/Missing installation/);
    expect(() => resolveDeployment(new App({ context: { installation: 'naeva' } }))).toThrow(/Missing stage/);
    expect(() => resolveDeployment(appFor('Naeva_X', 'dev'))).toThrow(/Invalid installation/);
    expect(() => resolveDeployment(appFor('naeva', 'DEV'))).toThrow(/Invalid stage/);

    process.env.CAP_INSTALLATION = 'naeva';
    process.env.CAP_STAGE = 'dev';
    expect(resolveDeployment(new App())).toEqual({ installation: 'naeva', stage: 'dev' });
    expect(accountVarName({ installation: 'naeva', stage: 'pre-prod' })).toBe('CAP_ACCOUNT_NAEVA_PRE_PROD');
  });

  it('[T-infra-005] a config file without region or config_version is rejected', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-config-'));
    const target = { installation: 'naeva', stage: 'dev' };
    writeFileSync(join(dir, 'naeva.dev.json'), JSON.stringify({ config_version: '2026-10-31' }));
    expect(() => loadInstallationConfig(target, dir)).toThrow(/"region" is required/);
    writeFileSync(join(dir, 'naeva.dev.json'), JSON.stringify({ region: 'r' }));
    expect(() => loadInstallationConfig(target, dir)).toThrow(/"config_version" is required/);
  });
});
