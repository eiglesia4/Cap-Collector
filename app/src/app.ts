// App shell (CAP-21, SCREENS.md § Navigation logic): the view outlet plus the bottom tab bar, driven by the
// history router. Modal routes (cap form, sign-in) cover the tabs. Signed out, every route leads to the sign-in
// screen; signing in lands on Collection, signing out (Settings, or a refused refresh) returns to sign-in (CAP-22).
import type { AppContext } from './context.js';
import { TabBar } from './components/tab-bar.js';
import { t } from './i18n/i18n.js';
import { handleDeepLinks } from './router/deep-link.js';
import { createRouter, type Router } from './router/router.js';
import { pathFor } from './router/routes.js';
import { SCREENS } from './screens/index.js';
import { h } from './ui/dom.js';

export type ShellContext = Omit<AppContext, 'navigate' | 'skipSignIn'>;

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

  let skipped = false;
  const allowed = () => skipped || ctx.session.signedIn();

  const router = createRouter({
    window: win,
    onRoute: (match) => {
      const onSignIn = match.route.name === 'signIn';
      if (!allowed() && !onSignIn) return router.navigate(pathFor('signIn'), { replace: true });
      if (allowed() && onSignIn) return router.navigate(pathFor('collection'), { replace: true });
      view.replaceChildren(SCREENS[match.route.name](full, match));
      tabs.setActive(match.route.tab);
      tabs.el.hidden = match.route.modal === true;
      shell.dataset.route = match.route.name;
    },
  });
  // Re-run the guard on the current path whenever the session appears or goes away.
  const reroute = () => router.navigate(router.current().path, { replace: true });
  const full: AppContext = {
    ...ctx,
    navigate: (path) => router.navigate(path),
    // Only offered by the sign-in screen in development builds.
    skipSignIn: () => {
      skipped = true;
      reroute();
    },
  };
  router.start();
  const unsubscribe = ctx.session.subscribe(reroute);
  // `collectors://cap/<id>` opens the cap (CAP-33); signed out, the guard above still sends it to Sign in.
  const stopDeepLinks = handleDeepLinks(ctx.platform, full.navigate);
  return {
    router,
    destroy: () => {
      stopDeepLinks();
      unsubscribe();
      router.stop();
    },
  };
}
