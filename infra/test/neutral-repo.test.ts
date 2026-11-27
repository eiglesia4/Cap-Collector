// Neutral repo (CAP-105, EP-09 self-hosting): target configs are local and gitignored, only example.dev.json is
// committed; tests and CI synthesise the fixture through CAP_CONFIG_DIR; a missing config says how to create one; and
// no owner-specific value (domains, tag values) is tracked under infra/.
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { CONFIG_DIR, configDir, loadInstallationConfig } from '../lib/config.js';
import { FIXTURE_CONFIG_DIR } from './fixtures.js';

const ENV_KEYS = ['CDK_DEFAULT_ACCOUNT', 'CAP_CONFIG_DIR', 'CAP_INSTALLATION', 'CAP_STAGE'];
const saved: Record<string, string | undefined> = {};
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

const NO_BUNDLING = { 'aws:cdk:bundling-stacks': [] };
const INFRA_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const git = (...args: string[]): string => execFileSync('git', args, { cwd: INFRA_DIR, encoding: 'utf8' });

describe('neutral repo', () => {
  it('[T-infra-056] CAP_CONFIG_DIR points synth at another directory (CI: the fixture); unset, infra/config/', () => {
    expect(configDir({})).toBe(CONFIG_DIR);
    expect(configDir({ CAP_CONFIG_DIR: '' })).toBe(CONFIG_DIR);
    // A relative path resolves against the working directory, as the CLI sees it.
    expect(configDir({ CAP_CONFIG_DIR: relative(process.cwd(), FIXTURE_CONFIG_DIR) })).toBe(FIXTURE_CONFIG_DIR);

    process.env.CAP_CONFIG_DIR = FIXTURE_CONFIG_DIR;
    const built = buildApp(new App({ context: { installation: 'test', stage: 'dev', ...NO_BUNDLING } }));
    expect(built.data.stackName).toBe('cap-test-dev-data');
    Template.fromStack(built.data).hasResourceProperties('AWS::DynamoDB::Table', { TableName: 'cap-test-dev-table' });
    expect(loadInstallationConfig({ installation: 'test', stage: 'dev' }).domains).toEqual({
      web: 'caps.example.com',
      api: 'api.caps.example.com',
    });
  });

  it('[T-infra-057] a target without a config file fails with how to create it from example.dev.json', () => {
    process.env.CAP_CONFIG_DIR = FIXTURE_CONFIG_DIR;
    const missing = () => buildApp(new App({ context: { installation: 'jane', stage: 'dev', ...NO_BUNDLING } }));
    expect(missing).toThrow(/No config for jane\/dev/);
    expect(missing).toThrow(/Copy infra\/config\/example\.dev\.json to .*jane\.dev\.json/);
    expect(missing).toThrow(/CAP_CONFIG_DIR/);
  });

  it('[T-infra-058] only the template is tracked in infra/config/, and no owner-specific value is tracked in infra/', () => {
    expect(git('ls-files', 'config').trim().split('\n').sort()).toEqual([
      'config/.gitignore',
      'config/README.md',
      'config/example.dev.json',
    ]);
    // The pattern is assembled so this file does not match itself.
    const pattern = ['naeva' + 'tec', 'eiglesia' + '4', 'EIM' + '_CAP'].join('|');
    let found = '';
    try {
      found = git('grep', '-n', '-I', '-i', '-E', pattern, '--', '.');
    } catch (e) {
      // `git grep` exits 1 when nothing matches: the expected outcome.
      if ((e as { status?: number }).status !== 1) throw e;
    }
    expect(found).toBe('');
  });
});
