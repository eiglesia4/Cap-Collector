// App import boundary in the root ESLint config (CAP-21 rule, moved to the root in CAP-27): Capacitor packages are only
// imported under app/src/platform/capacitor/. Lints fixture text with the real config; no fixture file is written.
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const root = resolve(import.meta.dirname, '..', '..');

async function restrictedImports(code: string, filePath: string): Promise<string[]> {
  const eslint = new ESLint({ cwd: root });
  const [result] = await eslint.lintText(code, { filePath: resolve(root, filePath) });
  return (result?.messages ?? []).filter((m) => m.ruleId === 'no-restricted-imports').map((m) => m.message);
}

describe('root eslint config', () => {
  it('[T-infra-023] root eslint rejects a @capacitor/* import outside app/src/platform/capacitor/', async () => {
    const code = [
      "import { Capacitor } from '@capacitor/core';",
      "import { SignInWithApple } from '@capacitor-community/apple-sign-in';",
      'export const x = [Capacitor, SignInWithApple];',
      '',
    ].join('\n');

    // Outside the platform folder: both imports rejected, with the adapter hint.
    const outside = await restrictedImports(code, 'app/src/features/collection/fixture.ts');
    expect(outside).toHaveLength(2);
    for (const m of outside) expect(m).toMatch(/only imported in app\/src\/platform\/capacitor\//);

    // Inside the platform folder and in the Capacitor CLI config: allowed.
    expect(await restrictedImports(code, 'app/src/platform/capacitor/fixture.ts')).toEqual([]);
    expect(await restrictedImports(code, 'app/capacitor.config.ts')).toEqual([]);

    // The rule is app-only, and there is a single config: no workspace config overrides the root one.
    expect(await restrictedImports(code, 'api/src/lib/fixture.ts')).toEqual([]);
    for (const ws of ['shared', 'app', 'api', 'infra']) {
      expect({ ws, config: existsSync(resolve(root, ws, 'eslint.config.js')) }).toEqual({ ws, config: false });
    }
  });
});
