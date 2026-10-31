import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'infra', include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 30_000 },
});
