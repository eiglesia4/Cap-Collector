// What "Share" on the cap detail hands the share sheet (CAP-24): `brand · variant · country · year` plus a link to the
// cap. The link is the HTTPS mirror `<VITE_WEB_URL>/cap/<id>` on the iPhone and the Mac alike (ADR-008 §5 as amended
// 2026-11-07, CAP-31); the `collectors://` scheme is V2 (CAP-32/33).
import type { Cap } from '@capcollector/shared';

import { t } from '../i18n/i18n.js';
import type { Platform, ShareRequest } from '../platform/platform.js';
import { pathFor } from '../router/routes.js';

export function shareText(cap: Cap): string {
  return [cap.brand, cap.variant, cap.country, cap.year === undefined ? undefined : String(cap.year)]
    .filter(Boolean)
    .join(t('collection.separator'));
}

/**
 * Origin the link points at: the configured web URL; without one, the web build's own origin (it is the mirror), and
 * nothing on the iPhone, whose own origin (`capacitor://localhost`) means nothing to the person it is shared with.
 */
export function linkOrigin(kind: Platform['kind'], webUrl: string | null, origin: string): string | null {
  return webUrl ?? (kind === 'web' ? origin : null);
}

/** `<origin>/cap/<id>`, or undefined when there is no origin to link to. */
export function capLink(cap: Cap, origin: string | null): string | undefined {
  return origin === null ? undefined : `${origin}${pathFor('capDetail', { id: cap.capId })}`;
}

export function shareRequest(cap: Cap, origin: string | null): ShareRequest {
  const url = capLink(cap, origin);
  return url === undefined
    ? { title: cap.brand, text: shareText(cap) }
    : { title: cap.brand, text: shareText(cap), url };
}
