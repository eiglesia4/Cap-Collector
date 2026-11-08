// `collectors://` deep links on the iPhone (CAP-33; CONVENTIONS § Domain vocabulary, ADR-008 §5): a link to a cap,
// `collectors://cap/<capId>`, opens its detail. Anything else is ignored, never a crash: the links come from outside
// the app (printed insert cards in V3, Notes, Messages).
import { Ulid } from '@capcollector/shared';

import type { Platform } from '../platform/platform.js';
import { pathFor } from './routes.js';

export const APP_SCHEME = 'collectors';

const CAP_LINK = /^collectors:\/\/cap\/([^/?#]+)\/?(?:[?#].*)?$/i;

/** In-app path a deep link opens (`/cap/<capId>`), or null when it is not a link to a cap with a valid ULID. */
export function deepLinkPath(url: string): string | null {
  const match = CAP_LINK.exec(url.trim());
  const id = match?.[1];
  if (id === undefined || !Ulid.safeParse(id).success) return null;
  return pathFor('capDetail', { id });
}

/** Route every deep link the platform reports; unknown ones are logged at debug level and dropped. */
export function handleDeepLinks(
  platform: Pick<Platform, 'onDeepLink'>,
  navigate: (path: string) => void,
  debug: (message: string) => void = (message) => console.debug(message),
): () => void {
  return platform.onDeepLink((url) => {
    const path = deepLinkPath(url);
    if (path === null) return debug('deep link ignored');
    navigate(path);
  });
}
