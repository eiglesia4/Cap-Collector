import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'api', include: ['test/**/*.test.ts'], environment: 'node' },
});
