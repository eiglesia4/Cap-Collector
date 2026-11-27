// Chooses the Platform implementation at startup (CAP-21): Capacitor on the iPhone and Android apps (CAP-112), web
// otherwise.
// The Capacitor implementation is loaded lazily so the Mac/web bundle does not carry the native plugin code paths.
import { isNativePlatform, nativeOs } from './capacitor/detect.js';
import type { AppleConfig, GoogleConfig } from '../config.js';
import type { Platform } from './platform.js';
import { createWebPlatform } from './web/web-platform.js';

export async function selectPlatform(
  win: Window,
  apple: AppleConfig | null = null,
  google: GoogleConfig | null = null,
): Promise<Platform> {
  const web = createWebPlatform(win, { apple, google });
  if (!isNativePlatform()) return web;
  const { createCapacitorPlatform, defaultPlugins } = await import('./capacitor/capacitor-platform.js');
  return createCapacitorPlatform(web, defaultPlugins(), nativeOs(), { googleClientId: google?.clientId ?? null });
}
