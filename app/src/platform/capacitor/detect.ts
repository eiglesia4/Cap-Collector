// Native detection for platform selection (CAP-21). Lives under platform/capacitor/: the only place Capacitor
// may be imported (eslint no-restricted-imports in app/eslint.config.js).
import { Capacitor } from '@capacitor/core';

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}
