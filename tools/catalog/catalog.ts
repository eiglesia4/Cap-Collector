// `npm run catalog` — regenerates TEST.md from the test titles of every workspace. `--check` fails if it is stale.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCatalog, renderTestMd, type ListedTest } from './catalog-lib.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const testMd = join(root, 'TEST.md');
const check = process.argv.includes('--check');

const raw = execFileSync('npx', ['vitest', 'list', '--json'], { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });
const { entries, errors } = buildCatalog(JSON.parse(raw) as ListedTest[], root);

if (errors.length > 0) {
  console.error(`catalog: ${errors.length} problem(s):\n  ${errors.join('\n  ')}`);
  process.exit(1);
}

const rendered = renderTestMd(entries);
if (check) {
  const current = existsSync(testMd) ? readFileSync(testMd, 'utf8') : '';
  if (current !== rendered) {
    console.error('catalog: TEST.md is stale. Run `npm run catalog` and commit the result.');
    process.exit(1);
  }
  console.log(`catalog: TEST.md up to date (${entries.length} tests).`);
} else {
  writeFileSync(testMd, rendered);
  console.log(`catalog: wrote TEST.md (${entries.length} tests).`);
}
