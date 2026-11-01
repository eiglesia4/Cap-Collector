// Collection tab (SCREENS.md #1). The shell only provides the title and the "⋯" menu leading to Albums,
// Exchange and Settings; grid, search and filters come with CAP-23.
import { ScreenHeader } from '../components/screen-header.js';
import type { Screen } from '../context.js';
import { t } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

export const CollectionScreen: Screen = () => {
  const link = (route: 'albums' | 'exchange' | 'settings', label: string) =>
    h('a', { class: 'menu-item', attrs: { href: pathFor(route), 'data-link': true } }, label);
  const more = h(
    'details',
    { class: 'more-menu' },
    h(
      'summary',
      { class: 'header-action', attrs: { 'aria-label': t('collection.more') } },
      h('span', { class: 'icon-more', attrs: { 'aria-hidden': 'true' } }),
    ),
    h(
      'div',
      { class: 'menu' },
      link('albums', t('albums.title')),
      link('exchange', t('exchange.title')),
      link('settings', t('settings.title')),
    ),
  );
  return h(
    'section',
    { class: 'screen' },
    ScreenHeader(t('collection.title'), more),
    h('p', { class: 'muted' }, t('collection.empty')),
  );
};
