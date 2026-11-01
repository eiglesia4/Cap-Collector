// Route table of the app shell (CAP-21) and the tab each route belongs to (SCREENS.md § Navigation logic):
// bottom tabs Collection · Scan · Wishlist · Stats; Albums, Exchange and Settings sit behind "⋯" on Collection.

export type TabId = 'collection' | 'scan' | 'wishlist' | 'stats';

export type RouteName =
  | 'collection'
  | 'scan'
  | 'wishlist'
  | 'stats'
  | 'capDetail'
  | 'capEdit'
  | 'newCap'
  | 'albums'
  | 'exchange'
  | 'settings';

export interface RouteDef {
  readonly name: RouteName;
  readonly pattern: string;
  /** Tab highlighted while this route is shown. */
  readonly tab: TabId;
  /** Full-screen over the tabs (form modal): the tab bar is hidden. */
  readonly modal?: true;
}

export const ROUTES: readonly RouteDef[] = [
  { name: 'collection', pattern: '/', tab: 'collection' },
  { name: 'scan', pattern: '/scan', tab: 'scan' },
  { name: 'wishlist', pattern: '/wishlist', tab: 'wishlist' },
  { name: 'stats', pattern: '/stats', tab: 'stats' },
  { name: 'capDetail', pattern: '/cap/:id', tab: 'collection' },
  { name: 'capEdit', pattern: '/cap/:id/edit', tab: 'collection', modal: true },
  { name: 'newCap', pattern: '/new', tab: 'scan', modal: true },
  { name: 'albums', pattern: '/albums', tab: 'collection' },
  { name: 'exchange', pattern: '/exchange', tab: 'collection' },
  { name: 'settings', pattern: '/settings', tab: 'collection' },
];

export interface RouteMatch {
  readonly route: RouteDef;
  readonly params: Readonly<Record<string, string>>;
  readonly path: string;
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** Match a pathname against ROUTES; null when no route matches (the router then falls back to Collection). */
export function matchRoute(pathname: string): RouteMatch | null {
  const parts = segments(pathname);
  for (const route of ROUTES) {
    const pattern = segments(route.pattern);
    if (pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    const ok = pattern.every((seg, i) => {
      const part = parts[i] ?? '';
      if (seg.startsWith(':')) {
        params[seg.slice(1)] = decodeURIComponent(part);
        return true;
      }
      return seg === part;
    });
    if (ok) return { route, params, path: '/' + parts.join('/') };
  }
  return null;
}

/** Fill a route pattern: `pathFor('capDetail', { id })` → `/cap/<id>`. */
export function pathFor(name: RouteName, params: Record<string, string> = {}): string {
  const route = ROUTES.find((r) => r.name === name);
  if (!route) throw new Error(`unknown route ${name}`);
  return route.pattern.replace(/:(\w+)/g, (_, key: string) => {
    const value = params[key];
    if (value === undefined) throw new Error(`missing param ${key} for ${name}`);
    return encodeURIComponent(value);
  });
}
