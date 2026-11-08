// POST /scans/analyse — dHash duplicate check, then (optionally) AI identification and brand re-check (ADR-004,
// openapi.yaml /scans/analyse, CAP-37). Stores only the Scan item; the AI adapter is a stub until CAP-39 (→ 503).
import { AnalyseRequest } from '@capcollector/shared';

import { getConfig } from '../lib/config.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';
import { analyse } from '../lib/scans.js';
import { getVisionAdapter } from '../lib/vision/adapter.js';

export const handler = defineHandler({ auth: true, body: AnalyseRequest }, async (req) =>
  ok(
    await analyse(
      { repos: getRepositories(), vision: getVisionAdapter(), threshold: getConfig().dhashThreshold },
      req.uid,
      req.body,
    ),
  ),
);
