// PATCH /caps/{capId} — partial update; every changed field lands in the `updated` history entry (openapi.yaml, ADR-006, CAP-18).
import { CapIdPath, CapPatchBody, patchCap, sentKeys } from '../lib/caps.js';
import { defineHandler, ok } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: CapIdPath, body: CapPatchBody }, async (req) =>
  ok(await patchCap(getRepositories(), req.uid, req.path.capId, req.body, sentKeys(req.rawBody))),
);
