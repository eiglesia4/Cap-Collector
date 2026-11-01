// Local route manifest: `METHOD /path` (openapi.yaml paths) → handler module, for `npm run api:local` (CAP-17).
// SPEC-GAP CAP-17: the deployed route table lives in infra/lib/routes.ts (CAP-15, not merged yet) and api/ may not import
// infra/ (OWNERSHIP.md, T-infra deps check); keep this list in step with it until infra exposes it through shared.
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
];
