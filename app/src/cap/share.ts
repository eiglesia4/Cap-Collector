// What "Share" on the cap detail hands the share sheet (CAP-24): `brand · variant · country · year` plus a link to the
// cap — the app deep link `collectors://cap/<id>` on iPhone, the web URL `/cap/<id>` in the browser.
import type { Cap } from '@capcollector/shared';

import { t } from '../i18n/i18n.js';
import type { ShareRequest } from '../platform/platform.js';
import { pathFor } from '../router/routes.js';

/** URL scheme of the iOS app (bundle `com.naevatec.collectors`). */
export const APP_SCHEME = 'collectors';

export function shareText(cap: Cap): string {
  return [cap.brand, cap.variant, cap.country, cap.year === undefined ? undefined : String(cap.year)]
    .filter(Boolean)
    .join(t('collection.separator'));
}

export function capLink(cap: Cap, kind: 'web' | 'native', origin: string): string {
  const path = pathFor('capDetail', { id: cap.capId });
  // SPEC-GAP CAP-24: the story names `collectors://cap/<id>`, but no spec registers the scheme in Info.plist or says
  // how the app opens it (needs @capacitor/app); the link is shared as specified and opening it is left for later.
  return kind === 'native' ? `${APP_SCHEME}:/${path}` : `${origin}${path}`;
}

export function shareRequest(cap: Cap, kind: 'web' | 'native', origin: string): ShareRequest {
  return { title: cap.brand, text: shareText(cap), url: capLink(cap, kind, origin) };
}
