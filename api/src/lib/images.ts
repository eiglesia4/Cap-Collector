// Cap images in S3 (CAP-20, ADR-002, ADR-006): the client resizes to WebP ≤ 1024 px and PUTs straight to S3 with a
// presigned URL; the API never proxies image bytes. Keys are `<uid>/<ulid>/<side>.webp`, so ownership is the key
// prefix. Reads are presigned GETs the API adds as `Cap.imageUrls` to every cap it returns (contracts v0.2, CAP-30).
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { type Cap, type ImageUrls, UploadRequest } from '@capcollector/shared';
import { z } from 'zod';

import { type Config, getConfig } from './config.js';
import { ValidationError } from './http.js';
import { newId } from './ids.js';

/** openapi.yaml /uploads: ≤ 1 MiB (shared `UploadRequest.bytes`). */
export const MAX_IMAGE_BYTES = 1024 * 1024;
export const PUT_URL_TTL_SECONDS = 5 * 60;
export const GET_URL_TTL_SECONDS = 15 * 60;
export const IMAGE_SIDES = ['top', 'underside'] as const;
export type ImageSide = (typeof IMAGE_SIDES)[number];

const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;

export interface UploadTicket {
  key: string;
  url: string;
  expiresAt: string;
}

export const imageKey = (uid: string, id: string, side: ImageSide) => `${uid}/${id}/${side}.webp`;

/** True when `key` is a cap image key of this user (`<uid>/<ulid>/<side>.webp`). */
export function ownsKey(uid: string, key: string): boolean {
  if (!key.startsWith(`${uid}/`)) return false;
  const [id, file, ...rest] = key.slice(uid.length + 1).split('/');
  return rest.length === 0 && ULID.test(id ?? '') && IMAGE_SIDES.some((s) => file === `${s}.webp`);
}

/**
 * For POST/PATCH /caps (CAP-18): the API trusts `images.*.key` only under the caller's prefix; anything else is a 422
 * on `body.images.<side>.key`.
 */
export function assertOwnImages(uid: string, images: Partial<Cap['images']> | undefined): void {
  const issues = IMAGE_SIDES.flatMap((side) => {
    const key = images?.[side]?.key;
    return key !== undefined && !ownsKey(uid, key)
      ? [
          {
            code: 'custom' as const,
            path: ['images', side, 'key'],
            message: 'not an image key of this user',
            input: key,
          },
        ]
      : [];
  });
  if (issues.length > 0) throw new ValidationError(new z.ZodError(issues), 'body');
}

export function createS3(config: Pick<Config, 's3Endpoint'>): S3Client {
  return new S3Client(config.s3Endpoint ? { endpoint: config.s3Endpoint, forcePathStyle: true } : {});
}

/**
 * Presigned PUT for one image (body = shared `UploadRequest`, v0.2). `Content-Type` and `Content-Length` are signed
 * headers, so S3 refuses any other type or size; encryption is the bucket default (SSE-S3, CollectorsData). The ULID
 * is a fresh upload id, not a capId: the caps API mints the capId itself (shared http.ts § UploadRequest).
 */
export async function presignUpload(
  s3: S3Client,
  bucket: string,
  uid: string,
  body: UploadRequest,
  clock: () => number = Date.now,
): Promise<UploadTicket> {
  const key = imageKey(uid, newId(), body.side);
  const command = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: body.contentType,
    ContentLength: body.bytes,
  });
  const now = clock();
  const url = await getSignedUrl(s3, command, {
    expiresIn: PUT_URL_TTL_SECONDS,
    signableHeaders: new Set(['content-type', 'content-length']),
    signingDate: new Date(now),
  });
  return { key, url, expiresAt: new Date(now + PUT_URL_TTL_SECONDS * 1000).toISOString() };
}

/** Presigned GETs for a cap's images: one per side present, none for a missing side (shared `ImageUrls`). */
export async function imageUrls(s3: S3Client, bucket: string, images: Cap['images']): Promise<ImageUrls> {
  const sign = (key: string) =>
    getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: GET_URL_TTL_SECONDS });
  const top = await sign(images.top.key);
  return images.underside ? { top, underside: await sign(images.underside.key) } : { top };
}

let s3: S3Client | undefined;

/** The S3 client of this Lambda, created on first use from the validated config. */
export function getS3(): S3Client {
  s3 ??= createS3(getConfig());
  return s3;
}

/** Test seam: forget the memoised S3 client (pair with `resetConfig()`). */
export function resetS3(): void {
  s3 = undefined;
}

/**
 * The cap as every caps-* route returns it (v0.2): the stored record plus `imageUrls` (response-only, never stored).
 * Any `imageUrls` already on the object is replaced, so stale URLs never leak through.
 */
export async function withImageUrls(cap: Cap): Promise<Cap> {
  return { ...cap, imageUrls: await imageUrls(getS3(), getConfig().imagesBucket, cap.images) };
}
