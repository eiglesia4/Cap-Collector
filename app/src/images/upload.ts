// Upload of one prepared image (openapi.yaml § /uploads, CAP-20/CAP-25): `POST /uploads` for a presigned S3 PUT, then
// the PUT itself with the exact Content-Type and length the URL was signed for. Yields the `ImageRef` a cap stores.
import { UploadResponse, type ImageRef, type UploadRequest } from '@capcollector/shared';

import type { ApiClient } from '../api/client.js';
import { WEBP, type ResizedImage } from './resize.js';

export type Side = UploadRequest['side'];

/** The presigned PUT did not succeed (network or S3 status). */
export class UploadFailedError extends Error {
  override readonly name = 'UploadFailedError';
}

export type PutFn = (url: string, init: RequestInit) => Promise<Response>;

export async function uploadImage(
  api: Pick<ApiClient, 'request'>,
  side: Side,
  image: ResizedImage,
  put: PutFn = (url, init) => fetch(url, init),
): Promise<ImageRef> {
  const body: UploadRequest = { side, contentType: WEBP, bytes: image.blob.size };
  const target = await api.request('/uploads', { method: 'POST', body, schema: UploadResponse });
  let res: Response;
  try {
    // Content-Length comes from the Blob; both headers are part of the signature (api/src/lib/images.ts).
    res = await put(target.url, { method: 'PUT', headers: { 'Content-Type': WEBP }, body: image.blob });
  } catch (error) {
    throw new UploadFailedError('image upload failed', { cause: error });
  }
  if (!res.ok) throw new UploadFailedError(`image upload failed (HTTP ${res.status})`);
  return { key: target.key, width: image.width, height: image.height, bytes: image.blob.size };
}
