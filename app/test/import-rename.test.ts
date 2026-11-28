// "Exchange / Intercambio" is "Import / Importar" in the UI (CAP-120; SCREENS.md #9, § Multi-import; ADR-012 §6): the
// screen title and the Collection ⋯ entry in both languages, and no visible copy names the old screen. The route
// `/exchange`, the `exchange.*` keys and the `capcollector.exchange` format are unchanged.
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient } from '../src/api/client';
import type { AppContext } from '../src/context';
import en from '../src/i18n/en.json';
import es from '../src/i18n/es.json';
import { setLanguage } from '../src/i18n/i18n';
import { matchRoute, pathFor } from '../src/router/routes';
import { CollectionScreen } from '../src/screens/collection-screen';
import { ExchangeView } from '../src/screens/exchange-screen';
import { fakeApi, flush, shellContext } from './support/fakes';

async function context(): Promise<AppContext> {
  const request = vi.fn(async (path: string) => (path.startsWith('/caps') ? { items: [] } : []));
  const api = fakeApi({ request: request as unknown as ApiClient['request'] });
  return { ...(await shellContext({ api })), navigate: vi.fn(), skipSignIn: vi.fn() };
}

const heading = (el: HTMLElement) => el.querySelector('h1')?.textContent;

afterEach(() => {
  setLanguage('en');
  document.body.replaceChildren();
});

describe('Import, formerly Exchange (CAP-120)', () => {
  it('[T-app-237] the screen heading reads "Importar" in Spanish and "Import" in English; the route stays /exchange', async () => {
    const ctx = await context();
    expect(pathFor('exchange')).toBe('/exchange');
    expect(matchRoute('/exchange')?.route.name).toBe('exchange');
    setLanguage('es');
    const spanish = ExchangeView(ctx, {});
    expect(heading(spanish)).toBe('Importar');
    setLanguage('en');
    const english = ExchangeView(ctx, {});
    expect(heading(english)).toBe('Import');
  });

  it('[T-app-238] the Collection ⋯ entry reads "Importar" and still opens /exchange', async () => {
    const ctx = await context();
    setLanguage('es');
    const route = matchRoute('/');
    if (!route) throw new Error('no route');
    const el = CollectionScreen(ctx, route);
    document.body.replaceChildren(el);
    await flush();
    const entry = el.querySelector<HTMLAnchorElement>('.more-menu .menu a[href="/exchange"]');
    expect(entry?.textContent).toBe('Importar');
  });

  it('[T-app-239] no visible copy calls the screen "Exchange" or "Intercambio" in either language', () => {
    // Other meanings stay: swapping two caps between pockets ("intercambiar") and caps kept for trade
    // ("Para intercambio").
    const english = Object.entries(en).filter(([, v]) => /\bexchange\b/i.test(v));
    const spanish = Object.entries(es).filter(
      ([k, v]) => /\bintercambio\b/i.test(v) && k !== 'form.forTrade' && k !== 'form.errorForTrade',
    );
    expect(english).toEqual([]);
    expect(spanish).toEqual([]);
  });
});
