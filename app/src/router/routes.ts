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
  | 'capReidentify'
  | 'newCap'
  | 'scanDuplicate'
  | 'scanReview'
  | 'albums'
  | 'albumSheet'
  | 'exchange'
  | 'settings'
  | 'signIn';

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
  // Detail ⋯ → "Re-identify with AI" (CAP-43).
  { name: 'capReidentify', pattern: '/cap/:id/reidentify', tab: 'collection', modal: true },
  { name: 'newCap', pattern: '/new', tab: 'scan', modal: true },
  // Capture outcomes (CAP-41 routes there; the screens are CAP-42 "Already in collection" and CAP-43 "AI review").
  { name: 'scanDuplicate', pattern: '/scan/duplicate', tab: 'scan', modal: true },
  { name: 'scanReview', pattern: '/scan/review', tab: 'scan', modal: true },
  { name: 'albums', pattern: '/albums', tab: 'collection' },
  // Album sheet view (CAP-52, SCREENS.md #7).
  { name: 'albumSheet', pattern: '/albums/:albumId/sheets/:sheet', tab: 'collection' },
  { name: 'exchange', pattern: '/exchange', tab: 'collection' },
  { name: 'settings', pattern: '/settings', tab: 'collection' },
  // CAP-22: the only route reachable signed out; full screen, no tabs.
  { name: 'signIn', pattern: '/sign-in', tab: 'collection', modal: true },
];

export interface RouteMatch {
  readonly route: RouteDef;
  readonly params: Readonly<Record<string, string>>;
  /** Query string parameters (`/new?scanId=…`, CAP-41). */
  readonly query: Readonly<Record<string, string>>;
  /** Pathname, plus the query string when there is one. */
  readonly path: string;
}

function segments(path: string): string[] {
  return path.split('/').filter((s) => s !== '');
}

/** Match a pathname against ROUTES; null when no route matches (the router then falls back to Collection). */
export function matchRoute(pathname: string, search = ''): RouteMatch | null {
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
    if (ok) {
      const query = Object.fromEntries(new URLSearchParams(search));
      const qs = new URLSearchParams(query).toString();
      return { route, params, query, path: '/' + parts.join('/') + (qs === '' ? '' : `?${qs}`) };
    }
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

/**
 * The Exchange screen for one subject (CAP-45, SCREENS.md § Navigation): `?scanId=` from Review / Manual ("Export for
 * external AI"), `?capId=` from Detail ⋯ ("Ask external AI"), `?requestId=` to upload the answer of that request.
 */
export function exchangePath(params: { scanId?: string; capId?: string; requestId?: string } = {}): string {
  const query = new URLSearchParams();
  for (const key of ['scanId', 'capId', 'requestId'] as const) {
    const value = params[key];
    if (value !== undefined) query.set(key, value);
  }
  const qs = query.toString();
  return pathFor('exchange') + (qs === '' ? '' : `?${qs}`);
}
