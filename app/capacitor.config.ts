// Capacitor shell for the iPhone build: the same Vite bundle (dist/) wrapped as a native app (ADR-001).
// Bundle ID from CLAUDE.md; the Mac/web build ignores this file.
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.naevatec.collectors',
  appName: 'CapCollector',
  webDir: 'dist',
};

export default config;
