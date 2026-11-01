// App shell (CAP-21, SCREENS.md § Navigation logic): the view outlet plus the bottom tab bar, driven by the
// history router. Modal routes (cap form) cover the tabs.
import type { AppContext } from './context.js';
import { TabBar } from './components/tab-bar.js';
import { t } from './i18n/i18n.js';
import { createRouter, type Router } from './router/router.js';
import { SCREENS } from './screens/index.js';
import { h } from './ui/dom.js';

export type ShellContext = Omit<AppContext, 'navigate'>;

export interface AppHandle {
  readonly router: Router;
  destroy(): void;
}

export function renderApp(root: HTMLElement, ctx: ShellContext, win: Window = window): AppHandle {
  const view = h('main', { class: 'view' });
  const tabs = TabBar(ctx.platform.kind);
  const shell = h('div', { class: 'shell' }, view, tabs.el);
  root.replaceChildren(shell);
  win.document.title = t('app.name');

  const router = createRouter({
    window: win,
    onRoute: (match) => {
      view.replaceChildren(SCREENS[match.route.name](full, match));
      tabs.setActive(match.route.tab);
      tabs.el.hidden = match.route.modal === true;
      shell.dataset.route = match.route.name;
    },
  });
  const full: AppContext = { ...ctx, navigate: (path) => router.navigate(path) };
  router.start();
  return { router, destroy: () => router.stop() };
}
