// POST /uploads — presigned S3 PUT for one WebP cap image, 5 min (openapi.yaml /uploads, ADR-002, CAP-20).
// The Lambda only holds s3:PutObject on the images bucket (CAP-15): no table access, ownership is the `<uid>/` prefix.
import { getConfig } from '../lib/config.js';
import { defineHandler, ok } from '../lib/http.js';
import { UploadBody, createS3, presignUpload } from '../lib/images.js';

let s3: ReturnType<typeof createS3> | undefined;

export const handler = defineHandler({ auth: true, body: UploadBody }, async (req) => {
  const config = getConfig();
  s3 ??= createS3(config);
  return ok(await presignUpload(s3, config.imagesBucket, req.uid, req.body));
});
