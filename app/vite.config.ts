// Vite build for the single bundle served on iPhone (Capacitor, webDir dist/) and on the web (S3) — ADR-001.
// The app version is injected at build time for the Settings screen (CAP-21). `@jsquash/webp` (WebP wasm fallback,
// ADR-010 §1, CAP-88) is kept out of the dev server's pre-bundling, which breaks its `new URL('*.wasm',
// import.meta.url)` lookup; `vite build` emits the wasm as hashed assets loaded only by the dynamic import.
import { readFileSync } from 'node:fs';

import { defineConfig } from 'vite';

const pkg: unknown = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'));
const version =
  typeof pkg === 'object' && pkg && 'version' in pkg && typeof pkg.version === 'string' ? pkg.version : '';

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(version) },
  build: { outDir: 'dist', target: 'es2022' },
  optimizeDeps: { exclude: ['@jsquash/webp'] },
});
