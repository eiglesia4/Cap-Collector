// POST /uploads — presigned S3 PUT for one WebP cap image, 5 min (openapi.yaml /uploads, ADR-002, CAP-20).
// Body/response: shared `UploadRequest` / `UploadResponse` (v0.2, CAP-30). The Lambda only holds s3:PutObject on the
// images bucket (CAP-15): no table access, ownership is the `<uid>/` prefix.
import { UploadRequest, UploadResponse } from '@capcollector/shared';

import { getConfig } from '../lib/config.js';
import { defineHandler, ok } from '../lib/http.js';
import { getS3, presignUpload } from '../lib/images.js';

export const handler = defineHandler({ auth: true, body: UploadRequest }, async (req) =>
  ok(UploadResponse.parse(await presignUpload(getS3(), getConfig().imagesBucket, req.uid, req.body))),
);
