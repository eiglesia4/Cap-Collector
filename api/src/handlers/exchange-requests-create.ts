// POST /exchange/requests — register a downloaded request bundle as `waiting` (openapi.yaml, exchange.md § Pending
// requests, CAP-44). The zip is built on the client; this only records it, and links the originating scan if given.
import { ExchangeCreateBody, createExchangeRequest } from '../lib/exchange.js';
import { created, defineHandler } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, body: ExchangeCreateBody }, async (req) =>
  created(await createExchangeRequest({ repos: getRepositories() }, req.uid, req.body)),
);
