// PATCH /exchange/requests/{requestId} — mark answered (with provider) or reviewed (openapi.yaml, exchange.md § Pending
// requests, CAP-44). Any other transition is 409 with the current status in the Problem detail.
import { ExchangePatchBody, ExchangeRequestIdPath, patchExchangeRequest } from '../lib/exchange.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler(
  { auth: true, path: ExchangeRequestIdPath, body: ExchangePatchBody },
  async (req) => ok(await patchExchangeRequest({ repos: getRepositories() }, req.uid, req.path.requestId, req.body)),
);
