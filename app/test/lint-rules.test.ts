// @vitest-environment node
// The Capacitor import boundary is enforced by ESLint (app/eslint.config.js, CAP-21).
import { fileURLToPath } from 'node:url';

import { ESLint } from 'eslint';
import { describe, expect, it } from 'vitest';

const APP = fileURLToPath(new URL('../', import.meta.url));

describe('lint rules', () => {
  it('[T-app-007] rejects @capacitor/* imports outside src/platform/capacitor/ and allows them inside', async () => {
    const eslint = new ESLint({ cwd: APP });
    const code = "import { Camera } from '@capacitor/camera';\nexport const c = Camera;\n";
    const lint = async (filePath: string) => {
      const [result] = await eslint.lintText(code, { filePath });
      return (result?.messages ?? []).map((m) => m.ruleId);
    };
    expect(await lint('src/screens/scan-screen.ts')).toContain('no-restricted-imports');
    expect(await lint('src/platform/web/x.ts')).toContain('no-restricted-imports');
    expect(await lint('src/platform/capacitor/x.ts')).not.toContain('no-restricted-imports');
  }, 30_000);
});
