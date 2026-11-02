// GET /caps — list / search with filters, sort and cursor; `total` for collections ≤ 5 000 (openapi.yaml CapPage, CAP-18).
import { CapListQuery, listCaps } from '../lib/caps.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, query: CapListQuery }, async (req) =>
  ok(await listCaps(getRepositories(), req.uid, req.query)),
);
