// DELETE /caps/{capId} — tombstone, idempotent, 204 (openapi.yaml, ADR-006, CAP-18).
import { CapIdPath, deleteCap } from '../lib/caps.js';
import { defineHandler, noContent } from '../lib/http.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: CapIdPath }, async (req) => {
  await deleteCap(getRepositories(), req.uid, req.path.capId);
  return noContent();
});
