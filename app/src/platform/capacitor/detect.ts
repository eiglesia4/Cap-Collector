// Native detection for platform selection (CAP-21). Lives under platform/capacitor/: the only place Capacitor
// may be imported (eslint no-restricted-imports in app/eslint.config.js).
import { Capacitor } from '@capacitor/core';

export function isNativePlatform(): boolean {
  return Capacitor.isNativePlatform();
}

/** Which native shell this is (ADR-011 §4); only meaningful when isNativePlatform(). */
export function nativeOs(): 'ios' | 'android' {
  return Capacitor.getPlatform() === 'android' ? 'android' : 'ios';
}
