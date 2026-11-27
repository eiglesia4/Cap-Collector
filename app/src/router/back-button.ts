// The Android hardware back button (CAP-112; ADR-011 §4; SCREENS.md § Sign-in): back through the navigation stack,
// and on the Collection (or the sign-in screen, the root while signed out) it leaves the app. A screen opened straight
// from a deep link has no history to go back to, so back lands on the Collection.
import type { Platform } from '../platform/platform.js';
import type { Router } from './router.js';
import { pathFor } from './routes.js';

/** Routes where back leaves the app. */
const ROOTS = new Set(['collection', 'signIn']);

export function handleBackButton(
  platform: Pick<Platform, 'onBackButton' | 'exitApp'>,
  router: Pick<Router, 'current' | 'navigate'>,
  win: Pick<Window, 'history'>,
): () => void {
  return platform.onBackButton(({ canGoBack }) => {
    if (ROOTS.has(router.current().route.name)) return platform.exitApp();
    if (canGoBack) win.history.back();
    else router.navigate(pathFor('collection'), { replace: true });
  });
}
