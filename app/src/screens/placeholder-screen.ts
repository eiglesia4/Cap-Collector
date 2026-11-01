// Screen stub used by the shell until each screen's own story lands (CAP-23 collection, CAP-24 detail,
// CAP-25 form, EP-05 scan…). Title and body are i18n keys.
import { ScreenHeader } from '../components/screen-header.js';
import type { Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { pathFor, type RouteName } from '../router/routes.js';
import { h } from '../ui/dom.js';

export function placeholderScreen(title: MessageKey, body: MessageKey, closeTo?: RouteName): Screen {
  return () =>
    h(
      'section',
      { class: 'screen' },
      ScreenHeader(
        t(title),
        closeTo &&
          h('a', { class: 'header-action', attrs: { href: pathFor(closeTo), 'data-link': true } }, t('common.close')),
      ),
      h('p', { class: 'muted' }, t(body)),
    );
}
