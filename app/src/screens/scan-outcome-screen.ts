// Stand-ins for the two capture outcomes CAP-41 routes to before their stories land: "Already in collection"
// (SCREENS.md #4, CAP-42) and "AI review" (SCREENS.md #3, CAP-43). Full-screen modal; Discard → Collection and clears
// the scan context (SCREENS.md § Navigation). Each story replaces its entry in screens/index.ts.
import type { Screen } from '../context.js';
import { t, type MessageKey } from '../i18n/i18n.js';
import { pathFor } from '../router/routes.js';
import { h } from '../ui/dom.js';

export function scanOutcomePlaceholder(title: MessageKey): Screen {
  return (ctx) =>
    h(
      'section',
      { class: 'screen' },
      h(
        'header',
        { class: 'screen-header' },
        h('h1', { class: 'screen-title' }, t(title)),
        h(
          'a',
          {
            class: 'header-action',
            attrs: { href: pathFor('collection'), 'data-link': true, 'data-action': 'discard' },
            on: { click: () => ctx.capture.clear() },
          },
          t('scan.discard'),
        ),
      ),
      h('p', { class: 'muted' }, t('scanOutcome.placeholder')),
    );
}
