import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'app', include: ['test/**/*.test.ts'], environment: 'happy-dom' },
});
