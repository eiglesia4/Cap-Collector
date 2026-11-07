// GET /healthz — liveness probe, no auth (openapi.yaml § /healthz, shared `Healthz`). Built on defineHandler (CAP-17).
import { Healthz } from '@capcollector/shared';

import { defineHandler, ok } from '../lib/http.js';

export const handler = defineHandler({ auth: false }, async () => ok(Healthz.parse({ status: 'ok' })));
