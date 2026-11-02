// GET /caps/{capId} — one live cap; unknown or tombstoned → 404 (openapi.yaml /caps/{capId} get, CAP-18).
import { CapIdPath, getCap } from '../lib/caps.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: CapIdPath }, async (req) =>
  ok(await getCap(getRepositories(), req.uid, req.path.capId)),
);
