// Vite build for the single bundle served on iPhone (Capacitor, later) and on the web (S3) — ADR-001.
import { defineConfig } from 'vite';

export default defineConfig({
  build: { outDir: 'dist', target: 'es2022' },
});
