// Settings (CAP-60): the stacks never create /cap/<inst>/<stage>/* parameters, they only read them; the bootstrap
// script creates the missing ones (`unset`, tagged), `show` reports state without values, `restore` overwrites from a
// backup. The AWS CLI is faked: nothing here touches the cloud.
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../lib/app.js';
import { settingParameterName, UNSET_PARAMETER_VALUE } from '../lib/collectors-data-stack.js';
import { PROJECT_TAG_VALUE, USER_NAME_TAG_VALUE } from '../lib/config.js';
import { SETTINGS } from '../lib/routes.js';
import {
  bootstrapSettings,
  type Command,
  formatShow,
  restoreSettings,
  settingsTarget,
  showSettings,
} from '../lib/settings.js';

const ENV_KEYS = ['CDK_DEFAULT_ACCOUNT', 'CAP_ACCOUNT_NAEVA_DEV', 'CAP_INSTALLATION', 'CAP_STAGE'];
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

const deployment = { installation: 'naeva', stage: 'dev' };
const SIX = [
  '/cap/naeva/dev/allowed-apple-subs',
  '/cap/naeva/dev/apple-client-ids',
  '/cap/naeva/dev/session-secret',
  '/cap/naeva/dev/web-certificate-arn',
  '/cap/naeva/dev/api-certificate-arn',
  '/cap/naeva/dev/alert-email',
];
const target = () => settingsTarget({ CAP_INSTALLATION: 'naeva', CAP_STAGE: 'dev' });

/** A fake SSM behind the CLI: `put-parameter` from stdin JSON, `get-parameters` from --names. */
function fakeSsm(initial: Record<string, string>) {
  const store = new Map(Object.entries(initial));
  const calls: Command[] = [];
  const tags = new Map<string, unknown>();
  const run = (c: Command): string => {
    calls.push(c);
    if (c.args[1] === 'put-parameter') {
      const p = JSON.parse(c.input ?? '{}') as { Name: string; Value: string; Overwrite: boolean; Tags?: unknown };
      if (store.has(p.Name) && !p.Overwrite) {
        throw new Error(`An error occurred (ParameterAlreadyExists) when calling the PutParameter operation`);
      }
      store.set(p.Name, p.Value);
      if (p.Tags) tags.set(p.Name, p.Tags);
      return '{"Version":1}';
    }
    if (c.args[1] === 'get-parameters') {
      const names = c.args.slice(c.args.indexOf('--names') + 1, c.args.indexOf('--output'));
      return JSON.stringify({
        Parameters: names.filter((n) => store.has(n)).map((Name) => ({ Name, Value: store.get(Name) })),
        InvalidParameters: names.filter((n) => !store.has(n)),
      });
    }
    throw new Error(`unexpected ${c.args.join(' ')}`);
  };
  return { store, calls, tags, run };
}

describe('Settings', () => {
  it('[T-infra-039] no stack creates an SSM parameter; the six settings appear only as SSM-typed template parameters', () => {
    expect(SETTINGS.map((n) => settingParameterName(deployment, n))).toEqual(SIX);
    // With domains on (the committed naeva.dev config) every setting is read by one of the two stacks.
    const built = buildApp(new App({ context: { ...deployment, 'aws:cdk:bundling-stacks': [] } }));
    const read = new Set<string>();
    for (const stack of [built.data, built.api]) {
      const t = Template.fromStack(stack);
      t.resourceCountIs('AWS::SSM::Parameter', 0);
      const json = t.toJSON() as { Parameters?: Record<string, { Type: string; Default?: string }> };
      for (const p of Object.values(json.Parameters ?? {})) {
        if (p.Default?.startsWith('/cap/')) {
          expect(p.Type, p.Default).toBe('AWS::SSM::Parameter::Value<String>');
          read.add(p.Default);
        }
      }
      // A setting name is never written anywhere else in the template (no resource property, no output).
      const { Parameters: _params, ...rest } = json;
      expect(JSON.stringify(rest)).not.toMatch(/\/cap\/naeva\/dev\//);
    }
    expect([...read].sort()).toEqual([...SIX].sort());
  });

  it('[T-infra-040] bootstrap creates only the missing settings (unset, tagged) and leaves existing ones; restore overwrites from a backup', () => {
    const ssm = fakeSsm({ '/cap/naeva/dev/session-secret': 'real-secret', '/cap/naeva/dev/alert-email': 'unset' });
    const t = target();
    expect(t.region).toBe('eu-west-1');

    const first = bootstrapSettings(t, ssm.run);
    expect(first.skipped).toEqual(['/cap/naeva/dev/session-secret', '/cap/naeva/dev/alert-email']);
    expect(first.created).toEqual(SIX.filter((n) => !first.skipped.includes(n)));
    expect(ssm.store.get('/cap/naeva/dev/session-secret')).toBe('real-secret');
    for (const n of first.created) {
      expect(ssm.store.get(n)).toBe(UNSET_PARAMETER_VALUE);
      expect(ssm.tags.get(n)).toEqual(
        expect.arrayContaining([
          { Key: 'project', Value: PROJECT_TAG_VALUE },
          { Key: 'UserName', Value: USER_NAME_TAG_VALUE },
          { Key: 'installation', Value: 'naeva' },
          { Key: 'stage', Value: 'dev' },
        ]),
      );
    }
    // Every put is a creation (no Overwrite), in the stack's region, with the value on stdin, never in argv.
    for (const c of ssm.calls) {
      expect(JSON.parse(c.input ?? '{}')).toMatchObject({ Overwrite: false, Type: 'String' });
      expect(c.args).toEqual(expect.arrayContaining(['--region', 'eu-west-1', '--cli-input-json']));
      expect(c.args.join(' ')).not.toMatch(/unset|real-secret/);
    }
    // Idempotent: a second run creates nothing.
    expect(bootstrapSettings(t, ssm.run)).toEqual({ created: [], skipped: SIX });
    // Any other CLI error is not swallowed.
    expect(() =>
      bootstrapSettings(t, () => {
        throw new Error('AccessDeniedException');
      }),
    ).toThrow(/AccessDenied/);

    // Restore: get-parameters JSON → overwrite; a saved `unset` is skipped; another target's name is refused.
    const backup = {
      Parameters: [
        { Name: '/cap/naeva/dev/apple-client-ids', Type: 'String', Value: 'com.naevatec.collectors' },
        { Name: '/cap/naeva/dev/web-certificate-arn', Type: 'String', Value: 'unset' },
      ],
      InvalidParameters: [],
    };
    ssm.calls.length = 0;
    expect(restoreSettings(t, JSON.stringify(backup), ssm.run)).toEqual({
      restored: ['/cap/naeva/dev/apple-client-ids'],
      skipped: ['/cap/naeva/dev/web-certificate-arn'],
    });
    expect(ssm.store.get('/cap/naeva/dev/apple-client-ids')).toBe('com.naevatec.collectors');
    expect(ssm.calls).toHaveLength(1);
    expect(JSON.parse(ssm.calls[0]?.input ?? '{}')).toMatchObject({ Overwrite: true });
    expect(ssm.calls[0]?.args.join(' ')).not.toContain('com.naevatec.collectors');
    const foreign = { Parameters: [{ Name: '/cap/naeva/prod/session-secret', Value: 'x' }] };
    expect(() => restoreSettings(t, JSON.stringify(foreign), ssm.run)).toThrow(/not a setting of naeva\/dev/);
    expect(() => restoreSettings(t, '{}', ssm.run)).toThrow(/no "Parameters" list/);

    // The target comes from CAP_INSTALLATION / CAP_STAGE only.
    expect(() => settingsTarget({ CAP_STAGE: 'dev' })).toThrow(/Missing installation/);
  });

  it('[T-infra-041] show reports set / unset / missing for each setting and never prints a value', () => {
    const secret = 'super-secret-value-123';
    const ssm = fakeSsm({
      '/cap/naeva/dev/session-secret': secret,
      '/cap/naeva/dev/allowed-apple-subs': '001234.abcdef',
      '/cap/naeva/dev/alert-email': 'unset',
    });
    const rows = showSettings(target(), ssm.run);
    expect(rows).toEqual([
      { name: '/cap/naeva/dev/allowed-apple-subs', state: 'set' },
      { name: '/cap/naeva/dev/apple-client-ids', state: 'missing' },
      { name: '/cap/naeva/dev/session-secret', state: 'set' },
      { name: '/cap/naeva/dev/web-certificate-arn', state: 'missing' },
      { name: '/cap/naeva/dev/api-certificate-arn', state: 'missing' },
      { name: '/cap/naeva/dev/alert-email', state: 'unset' },
    ]);
    const out = formatShow(rows);
    expect(out).not.toContain(secret);
    expect(out).not.toContain('001234.abcdef');
    expect(out.split('\n')).toHaveLength(6);
    expect(out).toMatch(/\/cap\/naeva\/dev\/session-secret\s+set/);
    // It asks for the six names, without decryption.
    expect(ssm.calls[0]?.args).not.toContain('--with-decryption');
    expect(ssm.calls[0]?.args).toEqual(expect.arrayContaining(SIX));
  });
});
