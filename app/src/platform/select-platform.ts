// Chooses the Platform implementation at startup (CAP-21): Capacitor on the iPhone app, web otherwise.
// The Capacitor implementation is loaded lazily so the Mac/web bundle does not carry the native plugin code paths.
import { isNativePlatform } from './capacitor/detect.js';
import type { Platform } from './platform.js';
import { createWebPlatform } from './web/web-platform.js';

export async function selectPlatform(win: Window): Promise<Platform> {
  const web = createWebPlatform(win);
  if (!isNativePlatform()) return web;
  const { createCapacitorPlatform } = await import('./capacitor/capacitor-platform.js');
  return createCapacitorPlatform(web);
}
