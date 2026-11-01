// Local route manifest: `METHOD /path` (openapi.yaml paths) → handler module, for `npm run api:local` (CAP-17, CAP-18).
// SPEC-GAP CAP-17: the deployed route table is infra/lib/routes.ts (CAP-15) and api/ may not import infra/ (OWNERSHIP.md,
// workspace deps check); this list mirrors its entries for the handlers that exist, until infra exposes it via shared.
import type { Handler } from './lib/http.js';

export interface RouteDef {
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  /** OpenAPI path with `{param}` placeholders. */
  path: string;
  load: () => Promise<Handler>;
  /** Mirrors the API Gateway authorizer: public routes skip the fake uid. */
  auth: boolean;
}

export const ROUTES: readonly RouteDef[] = [
  { method: 'GET', path: '/healthz', auth: false, load: async () => (await import('./handlers/healthz.js')).handler },
  { method: 'GET', path: '/caps', auth: true, load: async () => (await import('./handlers/caps-list.js')).handler },
  { method: 'POST', path: '/caps', auth: true, load: async () => (await import('./handlers/caps-create.js')).handler },
  {
    method: 'GET',
    path: '/caps/{capId}',
    auth: true,
    load: async () => (await import('./handlers/caps-get.js')).handler,
  },
  {
    method: 'PATCH',
    path: '/caps/{capId}',
    auth: true,
    load: async () => (await import('./handlers/caps-patch.js')).handler,
  },
  {
    method: 'DELETE',
    path: '/caps/{capId}',
    auth: true,
    load: async () => (await import('./handlers/caps-delete.js')).handler,
  },
  {
    method: 'GET',
    path: '/caps/{capId}/history',
    auth: true,
    load: async () => (await import('./handlers/caps-history.js')).handler,
  },
];
