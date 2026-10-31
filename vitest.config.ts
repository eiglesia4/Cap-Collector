// Root vitest config: one project per workspace (+ repo tooling), coverage gate for the whole repo (method.md § Tests).
import { defineConfig } from 'vitest/config';

/** Every npm workspace must appear here; T-infra-001 checks it against package.json. */
export const PROJECTS = ['shared', 'app', 'api', 'infra', 'tools'] as const;

export default defineConfig({
  test: {
    passWithNoTests: true,
    projects: PROJECTS.map((dir) => `${dir}/vitest.config.ts`),
    coverage: {
      provider: 'v8',
      include: ['shared/src/**', 'app/src/**', 'api/src/**', 'infra/lib/**', 'tools/**/*.ts'],
      exclude: ['**/*.d.ts', '**/*.test.ts', 'app/src/main.ts', 'tools/catalog/catalog.ts', '**/vitest.config.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      reportsDirectory: 'coverage',
      thresholds: { lines: 80, functions: 80, branches: 80, statements: 80 },
    },
  },
});
