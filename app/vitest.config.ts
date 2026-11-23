import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'app',
    include: ['test/**/*.test.ts'],
    environment: 'happy-dom',
    // CAP-97: run the tests in English (the app default is Spanish).
    setupFiles: ['test/setup-language.ts'],
  },
});
