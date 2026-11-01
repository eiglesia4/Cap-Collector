// GET /healthz — liveness probe, no auth (openapi.yaml § /healthz). Built on defineHandler like every route (CAP-17).
import { defineHandler, ok } from '../lib/http.js';

export interface HealthzBody {
  status: 'ok';
}

export const handler = defineHandler({ auth: false }, async () => ok({ status: 'ok' } satisfies HealthzBody));
