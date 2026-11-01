/**
 * `npm run deploy:web [-- --dry-run]` — publishes the app build to the CloudFront-fronted web bucket (CAP-16).
 * Edu only: needs CAP_INSTALLATION, CAP_STAGE and an AWS profile (.envrc.local). Logic in lib/web-deploy.ts.
 */
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { type Command, deployWeb } from '../lib/web-deploy.js';

const repoRoot = join(import.meta.dirname, '..', '..');
const dryRun = process.argv.includes('--dry-run');

const run = ({ cmd, args }: Command): string => {
  // Only describe-stacks needs its output; build/sync/invalidation stream to the terminal.
  const capture = args[0] === 'cloudformation';
  if (!capture) console.log(`$ ${cmd} ${args.join(' ')}`);
  const out = execFileSync(cmd, [...args], { cwd: repoRoot, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit' });
  return out ?? '';
};

try {
  const { target, outputs, plan } = deployWeb({ run, dryRun });
  const where = `${target.deployment.installation}/${target.deployment.stage}`;
  if (dryRun) {
    console.log(`deploy:web (dry run) for ${where}: bucket ${outputs.bucket}, distribution ${outputs.distributionId}`);
    for (const step of plan) console.log(`  ${step.cmd} ${step.args.join(' ')}`);
  } else {
    console.log(`deploy:web: ${where} published at ${outputs.webUrl}`);
  }
} catch (e) {
  console.error(`deploy:web: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
