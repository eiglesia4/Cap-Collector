/**
 * `npm run deploy:web` (CAP-16): build the app, sync `app/dist` to the private web bucket and invalidate CloudFront.
 * Bucket and distribution come from the CollectorsData stack outputs (`aws cloudformation describe-stacks`), the
 * region from infra/config/<installation>.<stage>.json — nothing account- or region-specific in code.
 * Run by Edu with his profile, never by CI or an agent. `--dry-run` resolves everything and prints the plan.
 */
import { type Deployment, loadInstallationConfig, resourceName, validateDeployment } from './config.js';

export interface Command {
  readonly cmd: string;
  readonly args: readonly string[];
}

/** Runs a command and returns its stdout (the CLI uses execFileSync; tests pass a fake). */
export type Runner = (command: Command) => string;

export interface WebTarget {
  readonly deployment: Deployment;
  readonly region: string;
  readonly stackName: string;
}

export interface WebOutputs {
  readonly bucket: string;
  readonly distributionId: string;
  readonly webUrl: string;
}

/** The deployment comes from CAP_INSTALLATION / CAP_STAGE only: no default stage, so a bare run refuses. */
export function webTarget(env: NodeJS.ProcessEnv = process.env, configDir?: string): WebTarget {
  const deployment = validateDeployment(env.CAP_INSTALLATION, env.CAP_STAGE);
  const { region } = loadInstallationConfig(deployment, configDir);
  return { deployment, region, stackName: resourceName(deployment, 'data') };
}

/** Reads WebBucketName / DistributionId / WebUrl from the data stack's outputs. */
export function readWebOutputs(target: WebTarget, run: Runner): WebOutputs {
  const raw = run({
    cmd: 'aws',
    args: ['cloudformation', 'describe-stacks', '--stack-name', target.stackName, '--region', target.region],
  });
  const parsed = JSON.parse(raw) as { Stacks?: { Outputs?: { OutputKey?: string; OutputValue?: string }[] }[] };
  const outputs = new Map((parsed.Stacks?.[0]?.Outputs ?? []).map((o) => [o.OutputKey, o.OutputValue]));
  const need = (key: string) => {
    const value = outputs.get(key);
    if (!value) {
      throw new Error(`${target.stackName} has no output ${key}: deploy CollectorsData (CAP-16 or later) first`);
    }
    return value;
  };
  return { bucket: need('WebBucketName'), distributionId: need('DistributionId'), webUrl: need('WebUrl') };
}

/** Build (shared, then app) → sync (with --delete) → invalidate everything. */
export function webDeployPlan(target: WebTarget, outputs: WebOutputs): Command[] {
  return [
    { cmd: 'npm', args: ['run', 'build:shared'] },
    { cmd: 'npm', args: ['run', 'build', '-w', '@capcollector/app'] },
    {
      cmd: 'aws',
      args: ['s3', 'sync', 'app/dist', `s3://${outputs.bucket}`, '--delete', '--region', target.region],
    },
    {
      cmd: 'aws',
      args: ['cloudfront', 'create-invalidation', '--distribution-id', outputs.distributionId, '--paths', '/*'],
    },
  ];
}

/** Resolves the target and outputs, then runs the plan (or only returns it with dryRun). */
export function deployWeb(opts: { env?: NodeJS.ProcessEnv; run: Runner; dryRun: boolean; configDir?: string }): {
  target: WebTarget;
  outputs: WebOutputs;
  plan: Command[];
} {
  const target = webTarget(opts.env, opts.configDir);
  const outputs = readWebOutputs(target, opts.run);
  const plan = webDeployPlan(target, outputs);
  if (!opts.dryRun) for (const step of plan) opts.run(step);
  return { target, outputs, plan };
}
