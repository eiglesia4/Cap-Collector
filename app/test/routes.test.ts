// Tests for the route table helpers (CAP-21).
import { describe, expect, it } from 'vitest';

import { createRouter } from '../src/router/router';
import { matchRoute, pathFor, ROUTES } from '../src/router/routes';

describe('routes', () => {
  it('[T-app-008] matches every shell route, decodes params, normalises slashes and builds paths back', () => {
    expect(ROUTES.map((r) => r.pattern)).toEqual([
      '/',
      '/scan',
      '/wishlist',
      '/stats',
      '/cap/:id',
      '/cap/:id/edit',
      '/new',
      '/albums',
      '/exchange',
      '/settings',
    ]);
    expect(matchRoute('/')?.route.name).toBe('collection');
    expect(matchRoute('/settings/')?.route.name).toBe('settings');
    expect(matchRoute('//scan')?.path).toBe('/scan');
    expect(matchRoute('/cap/a%20b/edit')).toMatchObject({ route: { name: 'capEdit' }, params: { id: 'a b' } });
    expect(matchRoute('/cap')).toBeNull();
    expect(matchRoute('/cap/1/edit/more')).toBeNull();

    expect(pathFor('capEdit', { id: 'a b' })).toBe('/cap/a%20b/edit');
    expect(pathFor('stats')).toBe('/stats');
    expect(() => pathFor('capDetail')).toThrow(/missing param id/);
    expect(() => pathFor('nope' as never)).toThrow(/unknown route/);
    expect(() => createRouter({ window, onRoute: () => undefined }).current()).toThrow(/not started/);
  });
});
