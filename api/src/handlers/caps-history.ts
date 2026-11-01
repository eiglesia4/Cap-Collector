// GET /caps/{capId}/history — append-only history, newest first (openapi.yaml, ADR-006, CAP-18).
import { CapIdPath, capHistory } from '../lib/caps.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: CapIdPath }, async (req) =>
  ok(await capHistory(getRepositories(), req.uid, req.path.capId)),
);
