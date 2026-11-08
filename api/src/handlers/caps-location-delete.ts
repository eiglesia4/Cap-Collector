// DELETE /caps/{capId}/location — clear the location (the cap is out of any storage); 204, idempotent (openapi.yaml,
// ADR-005, CAP-50). The pocket lock and GSI1 keys go in the same transaction as the cap and its history entry.
import { CapIdPath } from '../lib/caps.js';
import { defineHandler, noContent } from '../lib/http.js';
import { deleteLocation } from '../lib/location.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: CapIdPath }, async (req) => {
  await deleteLocation(getRepositories(), req.uid, req.path.capId);
  return noContent();
});
