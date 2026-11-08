/**
 * `npm run settings:bootstrap | settings:show | settings:restore -- <backup.json>` (CAP-60) — creates, inspects and
 * restores the `/cap/<inst>/<stage>/*` settings the stacks only read. Edu only: needs CAP_INSTALLATION, CAP_STAGE
 * and an AWS profile (.envrc.local). Logic in lib/settings.ts. Never prints a value.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  bootstrapSettings,
  type Command,
  formatShow,
  restoreSettings,
  settingsTarget,
  showSettings,
} from '../lib/settings.js';

const run = ({ cmd, args, input }: Command): string => {
  try {
    return execFileSync(cmd, [...args], { encoding: 'utf8', stdio: 'pipe', ...(input !== undefined && { input }) });
  } catch (e) {
    // Only the CLI's stderr: the command's stdin (which may hold a value) is never echoed.
    const stderr = (e as { stderr?: unknown }).stderr;
    throw new Error(typeof stderr === 'string' && stderr ? stderr.trim() : `${cmd} ${args[0] ?? ''} failed`, {
      cause: e,
    });
  }
};

const [action, file] = process.argv.slice(2);
try {
  const target = settingsTarget();
  const where = `${target.deployment.installation}/${target.deployment.stage}`;
  if (action === 'bootstrap') {
    const { created, skipped } = bootstrapSettings(target, run);
    for (const n of created) console.log(`created  ${n} (unset)`);
    for (const n of skipped) console.log(`exists   ${n} (left as is)`);
    console.log(`settings:bootstrap ${where}: ${created.length} created, ${skipped.length} already there`);
  } else if (action === 'show') {
    console.log(formatShow(showSettings(target, run)));
  } else if (action === 'restore') {
    if (!file) throw new Error('usage: npm run settings:restore -- <get-parameters backup.json>');
    // npm runs the script in infra/; a path is relative to where Edu typed the command.
    const path = resolve(process.env.INIT_CWD ?? process.cwd(), file);
    const { restored, skipped } = restoreSettings(target, readFileSync(path, 'utf8'), run);
    for (const n of restored) console.log(`restored ${n}`);
    for (const n of skipped) console.log(`skipped  ${n} (unset in the backup)`);
    console.log(`settings:restore ${where}: ${restored.length} restored`);
  } else {
    throw new Error('usage: settings.ts bootstrap | show | restore <backup.json>');
  }
} catch (e) {
  console.error(`settings: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
}
