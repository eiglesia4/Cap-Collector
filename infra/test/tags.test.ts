// Cost-allocation tag values from the target config (CAP-102, EP-09 self-hosting): `tags` is required, the app-level
// tags, the budget filter and the `settings:bootstrap` tags follow it, `example` is a template that never synthesises,
// and naeva/dev keeps EIM_CAP / eiglesia4 (CONVENTIONS § AWS tagging).
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import {
  CONFIG_DIR,
  deploymentTags,
  loadInstallationConfig,
  RESERVED_INSTALLATIONS,
  validateDeployment,
} from '../lib/config.js';
import { budgetTagFilter } from '../lib/ops.js';
import { bootstrapSettings, type Command, settingsTarget } from '../lib/settings.js';

const ENV_KEYS = ['CDK_DEFAULT_ACCOUNT', 'CAP_ACCOUNT_JANE_DEV', 'CAP_INSTALLATION', 'CAP_STAGE'];
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

/** Unit tests never run esbuild: the stacks are checked, not the bundles (CI `npm run synth` bundles for real). */
const NO_BUNDLING = { 'aws:cdk:bundling-stacks': [] };

/** "Done when": a copy of example.dev.json renamed to jane.dev.json, with jane as owner. */
function janeConfigDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cap-tags-'));
  copyFileSync(join(CONFIG_DIR, 'example.dev.json'), join(dir, 'jane.dev.json'));
  const raw = JSON.parse(readFileSync(join(dir, 'jane.dev.json'), 'utf8')) as Record<string, unknown>;
  writeFileSync(
    join(dir, 'jane.dev.json'),
    JSON.stringify({ ...raw, tags: { project: 'capcollector', owner: 'jane' } }),
  );
  return dir;
}

/** The tags of every resource carrying them as `[{Key, Value}]`, CDK's usual shape. */
const tagLists = (t: Template): Record<string, string>[] =>
  Object.values(t.toJSON().Resources as Record<string, { Properties?: { Tags?: unknown } }>)
    .map((r) => r.Properties?.Tags)
    .filter((tags): tags is { Key: string; Value: string }[] => Array.isArray(tags))
    .map((tags) => Object.fromEntries(tags.map(({ Key, Value }) => [Key, Value])));

describe('cost-allocation tags from config', () => {
  it('[T-infra-050] config: tags is required, both project and owner, each a valid AWS tag value', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-tags-'));
    const base = JSON.parse(readFileSync(join(CONFIG_DIR, 'example.dev.json'), 'utf8')) as Record<string, unknown>;
    const load = (tags?: unknown) => {
      const { tags: _omitted, ...rest } = base;
      writeFileSync(join(dir, 'jane.dev.json'), JSON.stringify({ ...rest, ...(tags !== undefined && { tags }) }));
      return loadInstallationConfig({ installation: 'jane', stage: 'dev' }, dir);
    };
    expect(load({ project: 'my-caps', owner: 'jane.doe@home' }).tags).toEqual({
      project: 'my-caps',
      owner: 'jane.doe@home',
    });
    expect(() => load()).toThrow(/"tags" is required/);
    expect(() => load(null)).toThrow(/"tags" is required/);
    for (const bad of [{ owner: 'jane' }, { project: '', owner: 'jane' }, { project: 'a$b', owner: 'jane' }]) {
      expect(() => load(bad), JSON.stringify(bad)).toThrow(/"tags\.project"/);
    }
    for (const bad of [{ project: 'p' }, { project: 'p', owner: 7 }, { project: 'p', owner: 'x'.repeat(257) }]) {
      expect(() => load(bad), JSON.stringify(bad)).toThrow(/"tags\.owner"/);
    }
  });

  it('[T-infra-051] a copy of example.dev.json synthesises with its own tags: app-level tags, budget filter and settings:bootstrap', () => {
    const dir = janeConfigDir();
    const built = buildApp(new App({ context: { installation: 'jane', stage: 'dev', ...NO_BUNDLING } }), dir);
    const data = Template.fromStack(built.data);
    const api = Template.fromStack(built.api);

    const expected = { project: 'capcollector', UserName: 'jane', installation: 'jane', stage: 'dev' };
    const dataTags = tagLists(data);
    expect(dataTags.length).toBeGreaterThan(0);
    for (const tags of [...dataTags, ...tagLists(api)]) expect(tags).toMatchObject(expected);

    // The budget watches jane's project tag, and carries jane's tags itself.
    api.hasResourceProperties('AWS::Budgets::Budget', {
      Budget: { CostFilters: { TagKeyValue: ['user:project$capcollector'] } },
    });
    expect(budgetTagFilter('capcollector')).toBe('user:project$capcollector');

    // Nothing of the owner's values leaks into someone else's synth.
    const json = JSON.stringify([data.toJSON(), api.toJSON()]);
    expect(json).not.toMatch(/EIM_CAP|eiglesia4/);

    // settings:bootstrap tags each parameter it creates with the same values.
    const target = settingsTarget({ CAP_INSTALLATION: 'jane', CAP_STAGE: 'dev' }, dir);
    const seen: { Key: string; Value: string }[][] = [];
    const run = (c: Command): string => {
      const arg = c.args[c.args.indexOf('--cli-input-json') + 1] ?? '';
      const input = JSON.parse(readFileSync(arg.slice('file://'.length), 'utf8')) as {
        Tags: { Key: string; Value: string }[];
      };
      seen.push(input.Tags);
      return '';
    };
    expect(bootstrapSettings(target, run).created).toHaveLength(target.names.length);
    for (const tags of seen) {
      expect(Object.fromEntries(tags.map(({ Key, Value }) => [Key, Value]))).toMatchObject(expected);
    }
  });

  it('[T-infra-052] installation "example" is refused: synth, settings and any deployment check', () => {
    expect(RESERVED_INSTALLATIONS).toContain('example');
    // The template itself is a valid config: only its name is reserved.
    expect(loadInstallationConfig({ installation: 'example', stage: 'dev' }).tags).toEqual({
      project: 'capcollector',
      owner: 'me',
    });
    expect(() => validateDeployment('example', 'dev')).toThrow(/"example" is the template/);
    expect(() => buildApp(new App({ context: { installation: 'example', stage: 'dev', ...NO_BUNDLING } }))).toThrow(
      /copy it to <you>\.<stage>\.json/,
    );
    expect(() => settingsTarget({ CAP_INSTALLATION: 'example', CAP_STAGE: 'dev' })).toThrow(/is the template/);
  });

  it('[T-infra-053] naeva/dev keeps project=EIM_CAP and UserName=eiglesia4, and its budget filter', () => {
    const naeva = { installation: 'naeva', stage: 'dev' };
    const config = loadInstallationConfig(naeva);
    expect(config.tags).toEqual({ project: 'EIM_CAP', owner: 'eiglesia4' });
    expect(deploymentTags(naeva, config)).toEqual({
      project: 'EIM_CAP',
      UserName: 'eiglesia4',
      installation: 'naeva',
      stage: 'dev',
      'cap:config_version': config.config_version,
    });
    expect(budgetTagFilter(config.tags.project)).toBe('user:project$EIM_CAP');
  });
});
