// Scan tab (SCREENS.md #2). On the web build it is "Upload photo" (ADR-001); the capture flow arrives in EP-05.
import { ScreenHeader } from '../components/screen-header.js';
import type { Screen } from '../context.js';
import { t } from '../i18n/i18n.js';
import { h } from '../ui/dom.js';

export const ScanScreen: Screen = (ctx) => {
  const web = ctx.platform.kind === 'web';
  return h(
    'section',
    { class: 'screen' },
    ScreenHeader(t(web ? 'scan.uploadTitle' : 'scan.title')),
    h('p', { class: 'muted' }, t(web ? 'scan.uploadPlaceholder' : 'scan.placeholder')),
  );
};
