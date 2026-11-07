// PATCH /caps/{capId} — partial update; every changed field lands in the `updated` history entry (openapi.yaml, ADR-006, CAP-18).
// Response carries `imageUrls` (presigned GETs, v0.2, CAP-30).
import { CapIdPath, CapPatchBody, patchCap } from '../lib/caps.js';
import { defineHandler, ok } from '../lib/http.js';
import { withImageUrls } from '../lib/images.js';
import { getRepositories } from '../lib/repo/index.js';

export const handler = defineHandler({ auth: true, path: CapIdPath, body: CapPatchBody }, async (req) =>
  ok(await withImageUrls(await patchCap(getRepositories(), req.uid, req.path.capId, req.body))),
);
