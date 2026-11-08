// Vitest project for infra/. Synth tests bundle every api handler with esbuild, and each new handler or construct
// makes them slower: 120 s leaves room on CI runners, where a full synth is ~2-3× slower than locally (CAP-57).
import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'infra', include: ['test/**/*.test.ts'], environment: 'node', testTimeout: 120_000 },
});
