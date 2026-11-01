// History-API router without hashes (CAP-21): intercepts same-origin <a data-link> clicks, handles back/forward,
// and sends unknown paths to Collection (replacing the URL). The web host serves index.html for every path (CAP-16).
import { matchRoute, type RouteMatch } from './routes.js';

export interface Router {
  start(): void;
  stop(): void;
  navigate(path: string, options?: { replace?: boolean }): void;
  current(): RouteMatch;
}

export interface RouterOptions {
  readonly window: Window;
  readonly onRoute: (match: RouteMatch) => void;
}

export function createRouter({ window: win, onRoute }: RouterOptions): Router {
  let current: RouteMatch | null = null;

  function resolve(): void {
    let match = matchRoute(win.location.pathname);
    if (!match) {
      win.history.replaceState(null, '', '/');
      match = matchRoute('/');
    }
    if (!match) throw new Error('route table has no "/" route');
    current = match;
    onRoute(match);
  }

  function navigate(path: string, options: { replace?: boolean } = {}): void {
    if (options.replace) win.history.replaceState(null, '', path);
    else if (path !== win.location.pathname) win.history.pushState(null, '', path);
    resolve();
  }

  function onClick(event: MouseEvent): void {
    if (event.defaultPrevented || event.button !== 0) return;
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const target = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('a[data-link]') : null;
    if (!target) return;
    const url = new URL(target.href, win.location.href);
    if (url.origin !== win.location.origin || target.target === '_blank') return;
    event.preventDefault();
    navigate(url.pathname);
  }

  return {
    start() {
      win.addEventListener('popstate', resolve);
      win.document.addEventListener('click', onClick);
      resolve();
    },
    stop() {
      win.removeEventListener('popstate', resolve);
      win.document.removeEventListener('click', onClick);
    },
    navigate,
    current() {
      if (!current) throw new Error('router not started');
      return current;
    },
  };
}
