// Capacitor shell for the iPhone build: the same Vite bundle (dist/) wrapped as a native app (ADR-001).
// Bundle ID from CLAUDE.md; the Mac/web build ignores this file. The Xcode project file and its `App/` folder keep
// Capacitor's hardcoded names; the target, product and shared scheme are `CapCollector` (CAP-94).
import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.naevatec.collectors',
  appName: 'CapCollector',
  webDir: 'dist',
  ios: { scheme: 'CapCollector' },
};

export default config;
