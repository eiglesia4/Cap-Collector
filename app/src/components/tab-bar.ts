// Bottom tab bar: Collection · Scan · Wishlist · Stats (SCREENS.md § Navigation logic). On the web build the
// Scan tab reads "Upload photo" (ADR-001).
import { t, type MessageKey } from '../i18n/i18n.js';
import { pathFor, type RouteName, type TabId } from '../router/routes.js';
import { h } from '../ui/dom.js';

interface TabDef {
  readonly id: TabId;
  readonly route: RouteName;
  readonly label: MessageKey;
  readonly webLabel?: MessageKey;
}

const TABS: readonly TabDef[] = [
  { id: 'collection', route: 'collection', label: 'tabs.collection' },
  { id: 'scan', route: 'scan', label: 'tabs.scan', webLabel: 'tabs.upload' },
  { id: 'wishlist', route: 'wishlist', label: 'tabs.wishlist' },
  { id: 'stats', route: 'stats', label: 'tabs.stats' },
];

export interface TabBarHandle {
  readonly el: HTMLElement;
  setActive(tab: TabId): void;
}

export function TabBar(kind: 'web' | 'native'): TabBarHandle {
  const links = TABS.map((tab) =>
    h(
      'a',
      { class: 'tab', attrs: { href: pathFor(tab.route), 'data-link': true, 'data-tab': tab.id } },
      h('span', { class: `tab-icon tab-icon--${tab.id}`, attrs: { 'aria-hidden': 'true' } }),
      h('span', { class: 'tab-label' }, t(kind === 'web' && tab.webLabel ? tab.webLabel : tab.label)),
    ),
  );
  const el = h('nav', { class: 'tab-bar', attrs: { 'aria-label': t('tabs.label') } }, ...links);
  return {
    el,
    setActive(active) {
      for (const link of links) {
        if (link.dataset.tab === active) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      }
    },
  };
}
