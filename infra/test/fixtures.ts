// The neutral fixture target every infra test synthesises (CAP-105): test/dev, `caps.example.com`, tags
// capcollector-test / tester. Real target configs are local and gitignored, so no test may read infra/config/ except
// the committed template example.dev.json. CI's `npm run synth` uses the same directory through CAP_CONFIG_DIR.
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_CONFIG_DIR = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'config');
