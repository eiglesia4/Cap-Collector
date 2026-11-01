// Uploads (CAP-20, openapi.yaml /uploads, ADR-002): key convention and ownership prefix, presigned PUT conditions and
// expiry (URL inspection, no network), strict body → 422, presigned GET links for caps-get / caps-list.
import { S3Client } from '@aws-sdk/client-s3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { handler as uploadH } from '../src/handlers/uploads-create.js';
import { resetConfig } from '../src/lib/config.js';
import {
  GET_URL_TTL_SECONDS,
  MAX_IMAGE_BYTES,
  PUT_URL_TTL_SECONDS,
  assertOwnImages,
  createS3,
  imageKey,
  imageLinks,
  ownsKey,
  presignUpload,
  withImageLinks,
} from '../src/lib/images.js';
import { newId } from '../src/lib/ids.js';
import { FIXTURE_CAP, apiEvent } from './support/fixtures.js';

const UID = '001234.abcdef0123456789abcdef0123456789.1234';
const BUCKET = 'cap-dev-images';
const ULID = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const s3 = new S3Client({ region: 'eu-west-1', credentials: { accessKeyId: 'AKIDTEST', secretAccessKey: 'secret' } });
const saved = { ...process.env };

beforeEach(() => {
  Object.assign(process.env, {
    CAP_TABLE_NAME: 'cap-dev-table',
    CAP_IMAGES_BUCKET: BUCKET,
    CAP_STAGE: 'dev',
    AWS_REGION: 'eu-west-1',
    AWS_ACCESS_KEY_ID: 'AKIDTEST',
    AWS_SECRET_ACCESS_KEY: 'secret',
  });
  // The SDK ignores env credentials when a profile is set; tests never use the developer's AWS profile.
  delete process.env.AWS_PROFILE;
  resetConfig();
});
afterEach(() => {
  process.env = { ...saved };
  resetConfig();
});

const body = { side: 'top', contentType: 'image/webp', bytes: 182_044 };
const json = <T>(res: { body?: string | undefined }) => JSON.parse(res.body ?? 'null') as T;
const upload = (b: unknown, uid = UID) =>
  uploadH(apiEvent({ ...(uid ? { uid } : {}), routeKey: 'POST /uploads', body: JSON.stringify(b) }));

describe('uploads', () => {
  it('[T-api-034] keys are <uid>/<ulid>/<side>.webp; ownership is the caller prefix; foreign keys in images → 422', async () => {
    const fresh = await presignUpload(s3, BUCKET, UID, { side: 'top', contentType: 'image/webp', bytes: 10 });
    const [uid, id, file] =
      fresh.key.split('/').length === 3 ? [UID, ...fresh.key.slice(UID.length + 1).split('/')] : [];
    expect(uid).toBe(UID);
    expect(id).toMatch(ULID);
    expect(file).toBe('top.webp');

    const capId = newId();
    const existing = await presignUpload(s3, BUCKET, UID, {
      side: 'underside',
      contentType: 'image/webp',
      bytes: 10,
      capId,
    });
    expect(existing.key).toBe(imageKey(UID, capId, 'underside'));

    expect(ownsKey(UID, existing.key)).toBe(true);
    for (const key of [
      `someone-else/${capId}/top.webp`,
      `${UID}x/${capId}/top.webp`,
      `${UID}/${capId}/side.webp`,
      `${UID}/not-a-ulid/top.webp`,
      `${UID}/${capId}/top.webp/extra`,
      `${UID}/${capId}/top.png`,
      `../${UID}/${capId}/top.webp`,
    ]) {
      expect(ownsKey(UID, key), key).toBe(false);
    }

    expect(() => assertOwnImages(UID, { top: { key: existing.key, width: 1, height: 1 } })).not.toThrow();
    expect(() => assertOwnImages(UID, undefined)).not.toThrow();
    let paths: string[] = [];
    try {
      assertOwnImages(UID, {
        top: { key: `other/${capId}/top.webp`, width: 1, height: 1 },
        underside: { key: `other/${capId}/underside.webp`, width: 1, height: 1 },
      });
    } catch (e) {
      paths = (e as { zod: { issues: { path: string[] }[] } }).zod.issues.map((i) => i.path.join('.'));
    }
    expect(paths).toEqual(['images.top.key', 'images.underside.key']);
  });

  it('[T-api-035] presigned PUT signs Content-Type and Content-Length, expires in 5 min, targets the images bucket', async () => {
    const now = Date.parse('2026-11-01T10:00:00.000Z');
    const t = await presignUpload(
      s3,
      BUCKET,
      UID,
      { side: 'top', contentType: 'image/webp', bytes: 182_044 },
      () => now,
    );
    const url = new URL(t.url);
    expect(url.protocol).toBe('https:');
    expect(url.hostname).toBe(`${BUCKET}.s3.eu-west-1.amazonaws.com`);
    expect(decodeURIComponent(url.pathname)).toBe(`/${t.key}`);
    const q = url.searchParams;
    expect(q.get('X-Amz-Expires')).toBe(String(PUT_URL_TTL_SECONDS));
    expect(q.get('X-Amz-Date')).toBe('20261101T100000Z');
    expect(q.get('X-Amz-SignedHeaders')?.split(';')).toEqual(['content-length', 'content-type', 'host']);
    expect(q.get('X-Amz-Signature')).toMatch(/^[0-9a-f]{64}$/);
    expect(t.expiresAt).toBe('2026-11-01T10:05:00.000Z');
    // A different size yields a different signature: the length is part of what S3 verifies.
    const other = await presignUpload(
      s3,
      BUCKET,
      UID,
      { side: 'top', contentType: 'image/webp', bytes: 182_045, capId: t.key.split('/').at(-2)! },
      () => now,
    );
    expect(new URL(other.url).searchParams.get('X-Amz-Signature')).not.toBe(q.get('X-Amz-Signature'));

    // Through the handler (config from env, real S3 client config, still no network).
    const res = await upload(body);
    expect(res.statusCode).toBe(200);
    const ticket = json<{ key: string; url: string; expiresAt: string }>(res);
    expect(Object.keys(ticket).sort()).toEqual(['expiresAt', 'key', 'url']);
    expect(ownsKey(UID, ticket.key)).toBe(true);
    expect(new URL(ticket.url).searchParams.get('X-Amz-SignedHeaders')).toContain('content-length');

    // Local S3 mock: path-style URLs on the configured endpoint.
    const local = createS3({ s3Endpoint: 'http://localhost:9090' });
    expect(local.config.forcePathStyle).toBe(true);
  });

  it('[T-api-036] oversize, wrong type, bad side, unknown field or bad capId → 422; no session → 401', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ ...body, bytes: MAX_IMAGE_BYTES + 1 }, 'body.bytes'],
      [{ ...body, bytes: 0 }, 'body.bytes'],
      [{ ...body, bytes: 1.5 }, 'body.bytes'],
      [{ ...body, contentType: 'image/jpeg' }, 'body.contentType'],
      [{ ...body, side: 'rim' }, 'body.side'],
      [{ ...body, capId: 'nope' }, 'body.capId'],
      [{ ...body, key: 'mine.webp' }, 'body'],
    ];
    for (const [b, path] of cases) {
      const res = await upload(b);
      expect(res.statusCode, JSON.stringify(b)).toBe(422);
      expect(json<{ errors: { path: string }[] }>(res).errors.map((e) => e.path)).toContain(path);
    }
    expect((await upload({ ...body, bytes: MAX_IMAGE_BYTES })).statusCode).toBe(200);
    expect((await upload(body, '')).statusCode).toBe(401);
  });

  it('[T-api-037] presigned GET links for both sides (15 min) under _links.images; the cap fields stay untouched', async () => {
    const links = await imageLinks(s3, BUCKET, FIXTURE_CAP.images);
    const top = new URL(links.top);
    expect(decodeURIComponent(top.pathname)).toBe(`/${FIXTURE_CAP.images.top.key}`);
    expect(top.searchParams.get('X-Amz-Expires')).toBe(String(GET_URL_TTL_SECONDS));
    expect(links.underside).toContain('underside.webp');
    const onlyTop = await imageLinks(s3, BUCKET, { top: FIXTURE_CAP.images.top });
    expect(onlyTop).not.toHaveProperty('underside');

    const out = await withImageLinks(s3, BUCKET, FIXTURE_CAP);
    const { _links, ...rest } = out;
    expect(rest).toEqual(FIXTURE_CAP);
    expect(Object.keys(_links.images)).toEqual(['top', 'underside']);
  });
});
