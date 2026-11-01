// Screen title bar shared by every screen (SCREENS.md § Visual system: Space Grotesk display title).
import type { Child } from '../ui/dom.js';
import { h } from '../ui/dom.js';

export function ScreenHeader(title: string, ...actions: Child[]): HTMLElement {
  return h('header', { class: 'screen-header' }, h('h1', { class: 'screen-title' }, title), ...actions);
}
