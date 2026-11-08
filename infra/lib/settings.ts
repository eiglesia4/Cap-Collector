/**
 * `/cap/<inst>/<stage>/*` settings (CAP-60): the stacks only read them, so they are created once, by hand, with
 * `npm run settings:bootstrap` and inspected with `settings:show`; `settings:restore` puts back a backup taken before
 * the CAP-60 migration (infra/README.md § Settings). Same shape as lib/web-deploy.ts: the AWS CLI behind an injected
 * runner, target from CAP_INSTALLATION / CAP_STAGE, region from config. Values are never printed or put in argv.
 */
import { type Deployment, deploymentTags, loadInstallationConfig, validateDeployment } from './config.js';
import { settingParameterName, UNSET_PARAMETER_VALUE } from './collectors-data-stack.js';
import { SETTINGS } from './routes.js';

export interface Command {
  readonly cmd: string;
  readonly args: readonly string[];
  /** Sent on stdin (`--cli-input-json file:///dev/stdin`): how a value reaches the CLI without showing in `ps`. */
  readonly input?: string;
}

/** Runs a command and returns its stdout; throws with the CLI's stderr in the message on a non-zero exit. */
export type Runner = (command: Command) => string;

export interface SettingsTarget {
  readonly deployment: Deployment;
  readonly region: string;
  readonly configVersion: string;
  /** The six parameter names of this target, in SETTINGS order. */
  readonly names: readonly string[];
}

export type SettingState = 'set' | 'unset' | 'missing';

/** The deployment comes from CAP_INSTALLATION / CAP_STAGE only: no default, so a bare run refuses. */
export function settingsTarget(env: NodeJS.ProcessEnv = process.env, configDir?: string): SettingsTarget {
  const deployment = validateDeployment(env.CAP_INSTALLATION, env.CAP_STAGE);
  const { region, config_version } = loadInstallationConfig(deployment, configDir);
  return {
    deployment,
    region,
    configVersion: config_version,
    names: SETTINGS.map((n) => settingParameterName(deployment, n)),
  };
}

const putInput = (name: string, value: string, overwrite: boolean, tags?: Readonly<Record<string, string>>) =>
  JSON.stringify({
    Name: name,
    Value: value,
    Type: 'String',
    Overwrite: overwrite,
    // put-parameter refuses Tags together with Overwrite; only a creation carries them.
    ...(tags && { Tags: Object.entries(tags).map(([Key, Value]) => ({ Key, Value })) }),
  });

const put = (target: SettingsTarget, input: string): Command => ({
  cmd: 'aws',
  args: ['ssm', 'put-parameter', '--region', target.region, '--cli-input-json', 'file:///dev/stdin'],
  input,
});

/**
 * Creates each missing setting with `unset` and the mandatory tags; an existing one is left exactly as it is
 * (no `Overwrite`, `ParameterAlreadyExists` → skipped). Safe to run any number of times.
 */
export function bootstrapSettings(
  target: SettingsTarget,
  run: Runner,
): { created: readonly string[]; skipped: readonly string[] } {
  const tags = deploymentTags(target.deployment, target.configVersion);
  const created: string[] = [];
  const skipped: string[] = [];
  for (const name of target.names) {
    try {
      run(put(target, putInput(name, UNSET_PARAMETER_VALUE, false, tags)));
      created.push(name);
    } catch (e) {
      if (!/ParameterAlreadyExists/.test(e instanceof Error ? e.message : String(e))) throw e;
      skipped.push(name);
    }
  }
  return { created, skipped };
}

/** Whether each setting is set, still `unset` or missing. The values themselves never leave this function. */
export function showSettings(target: SettingsTarget, run: Runner): { name: string; state: SettingState }[] {
  const raw = run({
    cmd: 'aws',
    args: ['ssm', 'get-parameters', '--region', target.region, '--names', ...target.names, '--output', 'json'],
  });
  const parsed = JSON.parse(raw) as { Parameters?: { Name?: string; Value?: string }[] };
  const values = new Map((parsed.Parameters ?? []).map((p) => [p.Name, p.Value]));
  return target.names.map((name) => {
    const value = values.get(name);
    return { name, state: value === undefined ? 'missing' : value === UNSET_PARAMETER_VALUE ? 'unset' : 'set' };
  });
}

/** One line per setting, e.g. `/cap/naeva/dev/session-secret  set`. */
export const formatShow = (rows: readonly { name: string; state: SettingState }[]): string => {
  const width = Math.max(...rows.map((r) => r.name.length));
  return rows.map((r) => `${r.name.padEnd(width)}  ${r.state}`).join('\n');
};

/**
 * Overwrites settings from the JSON of `aws ssm get-parameters --with-decryption` (CAP-60 migration, step 4). Only
 * this target's six names are accepted; a saved `unset` is skipped (nothing to restore).
 */
export function restoreSettings(
  target: SettingsTarget,
  backupJson: string,
  run: Runner,
): { restored: readonly string[]; skipped: readonly string[] } {
  const parsed = JSON.parse(backupJson) as { Parameters?: { Name?: unknown; Value?: unknown }[] };
  if (!Array.isArray(parsed.Parameters)) {
    throw new Error('not a `aws ssm get-parameters` result: no "Parameters" list');
  }
  const known = new Set(target.names);
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const p of parsed.Parameters) {
    if (typeof p.Name !== 'string' || typeof p.Value !== 'string') throw new Error('a parameter has no Name or Value');
    if (!known.has(p.Name)) {
      throw new Error(`${p.Name} is not a setting of ${target.deployment.installation}/${target.deployment.stage}`);
    }
    if (p.Value === UNSET_PARAMETER_VALUE) {
      skipped.push(p.Name);
      continue;
    }
    run(put(target, putInput(p.Name, p.Value, true)));
    restored.push(p.Name);
  }
  return { restored, skipped };
}
