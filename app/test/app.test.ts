// Tests for the app shell: mounting, router + tab bar, modal routes, platform-dependent labels (CAP-21).
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderApp, type AppHandle } from '../src/app';
import { t } from '../src/i18n/i18n';
import { shellContext } from './support/fakes';

let handle: AppHandle | undefined;
let root: HTMLElement;

function mount(path: string, kind: 'web' | 'native' = 'native'): AppHandle {
  window.history.replaceState(null, '', path);
  handle = renderApp(root, shellContext({ kind }));
  return handle;
}

const tabs = () => [...root.querySelectorAll<HTMLAnchorElement>('.tab-bar a')];
const activeTab = () => root.querySelector('.tab-bar a[aria-current="page"]')?.getAttribute('data-tab');
const title = () => root.querySelector('h1')?.textContent;

beforeEach(() => {
  root = document.createElement('div');
  document.body.replaceChildren(root);
});
afterEach(() => handle?.destroy());

describe('app shell', () => {
  it('[T-app-001] renders the shell into the root element, replacing previous content', () => {
    root.innerHTML = '<p>stale</p>';
    mount('/');
    expect(root.textContent).not.toContain('stale');
    expect(root.querySelector('.shell > main.view')).not.toBeNull();
    expect(root.querySelector('.shell > nav.tab-bar')).not.toBeNull();
    expect(document.title).toBe(t('app.name'));
  });

  it('[T-app-002] routes paths to screens and keeps the bottom tab bar in sync (clicks, back, unknown → Collection)', () => {
    const app = mount('/');
    expect(tabs().map((a) => a.textContent)).toEqual([
      t('tabs.collection'),
      t('tabs.scan'),
      t('tabs.wishlist'),
      t('tabs.stats'),
    ]);
    expect(tabs().map((a) => a.getAttribute('href'))).toEqual(['/', '/scan', '/wishlist', '/stats']);
    expect(activeTab()).toBe('collection');
    expect(title()).toBe(t('collection.title'));

    // Tab click is intercepted: history entry pushed, no reload, screen + active tab updated.
    tabs()[2]?.querySelector('span')?.click();
    expect(window.location.pathname).toBe('/wishlist');
    expect(activeTab()).toBe('wishlist');
    expect(title()).toBe(t('wishlist.title'));

    app.router.navigate('/stats');
    expect(activeTab()).toBe('stats');

    // Back button.
    window.history.replaceState(null, '', '/wishlist');
    window.dispatchEvent(new PopStateEvent('popstate'));
    expect(title()).toBe(t('wishlist.title'));

    // Secondary routes keep their owning tab highlighted; params reach the route.
    app.router.navigate('/cap/01JBCDEFGHJKMNPQRSTVWXYZ01');
    expect(app.router.current().route.name).toBe('capDetail');
    expect(app.router.current().params).toEqual({ id: '01JBCDEFGHJKMNPQRSTVWXYZ01' });
    expect(activeTab()).toBe('collection');

    // Unknown route → Collection, URL replaced.
    app.router.navigate('/nope/really');
    expect(window.location.pathname).toBe('/');
    expect(app.router.current().route.name).toBe('collection');
    expect(title()).toBe(t('collection.title'));
  });

  it('[T-app-016] hides the tab bar on modal form routes and shows "Upload photo" for Scan on the web build', () => {
    const app = mount('/new', 'web');
    expect(root.querySelector<HTMLElement>('.tab-bar')?.hidden).toBe(true);
    root.querySelector<HTMLAnchorElement>('a.header-action')?.click();
    expect(window.location.pathname).toBe('/scan');
    expect(root.querySelector<HTMLElement>('.tab-bar')?.hidden).toBe(false);
    expect(tabs()[1]?.textContent).toBe(t('tabs.upload'));
    expect(title()).toBe(t('scan.uploadTitle'));
    app.destroy();

    mount('/scan', 'native');
    expect(tabs()[1]?.textContent).toBe(t('tabs.scan'));
    expect(title()).toBe(t('scan.title'));
  });

  it('[T-app-017] leaves modified, external and non-router link clicks to the browser', () => {
    const app = mount('/');
    const click = (el: Element, init: MouseEventInit = {}) => {
      const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
      el.dispatchEvent(event);
      return event.defaultPrevented;
    };
    const tab = tabs()[1];
    if (!tab) throw new Error('no tab');
    expect(click(tab, { metaKey: true })).toBe(false);
    expect(click(tab, { button: 1 })).toBe(false);

    const external = document.createElement('a');
    external.href = 'https://example.invalid/x';
    external.dataset.link = '';
    root.append(external);
    expect(click(external)).toBe(false);

    const plain = document.createElement('a');
    plain.href = '/stats';
    root.append(plain);
    expect(click(plain)).toBe(false);
    expect(app.router.current().route.name).toBe('collection');

    // The "⋯" menu on Collection links to Albums, Exchange and Settings.
    const menu = [...root.querySelectorAll<HTMLAnchorElement>('.menu a')].map((a) => a.getAttribute('href'));
    expect(menu).toEqual(['/albums', '/exchange', '/settings']);

    app.destroy();
    expect(() => app.router.current()).not.toThrow();
  });
});
