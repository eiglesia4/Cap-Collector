// One cap in the Collection grid and the "Recently added" strip (CAP-23, SCREENS.md § Visual system: caps are always
// drawn as circles). Round thumbnail from the presigned `imageUrls.top` (contracts v0.2, CAP-20); without it — or
// when the ≈5 min URL has expired — a placeholder circle tinted by a hash of the brand. Lines: brand · variant and
// country · year; a "!" badge marks `needsReview`. Tapping opens the cap's detail (`/cap/:id`, CAP-24).
import type { Cap } from '@capcollector/shared';

import { t } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

/** Stable hue 0–359 for a brand (FNV-1a over the lower-cased name), so a brand keeps its colour across screens. */
export function brandHue(brand: string): number {
  let hash = 0x811c9dc5;
  for (const ch of brand.trim().toLowerCase()) {
    hash ^= ch.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % 360;
}

function placeholder(cap: Cap, className = 'cap-thumb'): HTMLElement {
  return h('span', {
    class: `${className} cap-thumb--placeholder`,
    attrs: { style: `--cap-hue: ${String(brandHue(cap.brand))}`, 'aria-hidden': 'true' },
  });
}

/**
 * A round cap image for `side` (presigned `imageUrls`, contracts v0.2), or the brand-hued placeholder when the URL is
 * missing or has expired. Shared by the grid tiles and the detail screen (CAP-24).
 */
export function capImage(cap: Cap, side: 'top' | 'underside' = 'top', className = 'cap-thumb'): HTMLElement {
  const url = cap.imageUrls?.[side];
  if (url === undefined) return placeholder(cap, className);
  const img = h('img', { class: className, attrs: { src: url, loading: 'lazy', decoding: 'async', alt: '' } });
  img.addEventListener('error', () => img.replaceWith(placeholder(cap, className)), { once: true });
  return img;
}

const thumbnail = (cap: Cap) => capImage(cap);

export function capTitle(cap: Cap): string {
  return [cap.brand, cap.variant].filter(Boolean).join(t('collection.separator'));
}

export function capSubtitle(cap: Cap): string {
  return [cap.country, cap.year === undefined ? undefined : String(cap.year)]
    .filter(Boolean)
    .join(t('collection.separator'));
}

export function CapTile(cap: Cap): HTMLElement {
  const review = cap.status === 'needsReview';
  const subtitle = capSubtitle(cap);
  return h(
    'li',
    { class: 'cap-tile' },
    h(
      'a',
      { class: 'cap-link', attrs: { href: pathFor('capDetail', { id: cap.capId }), 'data-link': true } },
      h(
        'span',
        { class: 'cap-thumb-wrap' },
        thumbnail(cap),
        review &&
          h(
            'span',
            {
              class: 'cap-badge',
              attrs: { title: t('collection.needsReview'), 'aria-label': t('collection.needsReview') },
            },
            t('collection.needsReviewBadge'),
          ),
      ),
      h('span', { class: 'cap-title' }, capTitle(cap)),
      subtitle !== '' && h('span', { class: 'cap-subtitle muted' }, subtitle),
    ),
  );
}
