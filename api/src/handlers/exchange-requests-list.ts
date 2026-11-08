// GET /exchange/requests — the user's exchange requests, newest first, optional `status` filter; past-TTL items are
// reported as `expired` (openapi.yaml, exchange.md § Pending requests, CAP-44).
import { ExchangeListQuery, listExchangeRequests } from '../lib/exchange.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, query: ExchangeListQuery }, async (req) =>
  ok(await listExchangeRequests({ repos: getRepositories() }, req.uid, req.query)),
);
