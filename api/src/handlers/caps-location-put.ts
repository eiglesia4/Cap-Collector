// PUT /caps/{capId}/location — move a cap to a pocket/box/frame, or swap with the cap in the pocket (openapi.yaml,
// ADR-005, data-model.md § Invariants: LOCK# in the same transaction; CAP-50). Responses carry `imageUrls`.
import { CapIdPath } from '../lib/caps.js';
import { defineHandler, ok } from '../lib/http.js';
import { withImageUrls } from '../lib/images.js';
import { LocationPutBody, putLocation } from '../lib/location.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: CapIdPath, body: LocationPutBody }, async (req) => {
  const { cap, swapped } = await putLocation(getRepositories(), req.uid, req.path.capId, req.body);
  return ok({ cap: await withImageUrls(cap), ...(swapped ? { swapped: await withImageUrls(swapped) } : {}) });
});
