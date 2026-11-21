// Backup export (CAP-80; features.md § Phase 2 backup export, EP-07; ADR-006): backup.json (format, version, contracts
// version, every page of live caps without `imageUrls`, the albums), one zip entry per image key with retries and
// `missingImages`, the share (iPhone) vs download (Mac) path with the last export date, and the 2 000-cap guard.
import { CONTRACTS_VERSION } from '@capcollector/shared';
import { strFromU8, unzipSync } from 'fflate';
import { describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import {
  BACKUP_FORMAT,
  exportBackup,
  imagePath,
  MAX_CAPS_WITH_PHOTOS,
  PHOTO_CONCURRENCY,
  type BackupDocument,
} from '../src/backup/export';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import { BackupSection, LAST_BACKUP_KEY } from '../src/screens/settings-screen';
import { ulid, wireCap, wirePage } from './support/caps';
import { fakeApi, fakePlatform, flush, memoryStore, shellContext } from './support/fakes';

const NOW = new Date('2026-11-21T18:30:00.000Z');
const TS = '2026-11-01T10:00:00.000Z';
const album = {
  albumId: ulid(900),
  letter: 'A',
  name: 'Leuchtturm GRANDE',
  kind: 'album',
  sheets: 10,
  cols: 6,
  rows: 7,
  createdAt: TS,
  updatedAt: TS,
};

/** A cap with presigned URLs for its photos (as `GET /caps` returns it). */
function capWithPhotos(n: number, underside = false): Record<string, unknown> {
  const id = ulid(n);
  return wireCap(n, {
    images: {
      top: { key: `u1/${id}/top.webp`, width: 1024, height: 1024 },
      ...(underside ? { underside: { key: `u1/${id}/underside.webp`, width: 1024, height: 1024 } } : {}),
    },
    imageUrls: {
      top: `https://img.test/${id}/top.webp`,
      ...(underside ? { underside: `https://img.test/${id}/underside.webp` } : {}),
    },
  });
}

/** Fake API: `GET /caps` in pages of `pageSize`, `GET /albums`. */
function backupApi(caps: Record<string, unknown>[], pageSize = 200) {
  const paths: string[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    paths.push(path);
    let answer: unknown;
    if (path === '/albums') answer = [album];
    else if (path.startsWith('/caps?')) {
      const start = Number(new URL(path, 'https://x').searchParams.get('cursor') ?? '0');
      const end = start + pageSize;
      answer = wirePage(caps.slice(start, end), end < caps.length ? { cursor: String(end) } : {});
    }
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  return { api: fakeApi({ request: request as ApiClient['request'] }), paths };
}

/** Image server: the bytes of the URL's path, failing `failures[url]` times first. */
function imageServer(failures: Record<string, number> = {}) {
  const left = { ...failures };
  let inFlight = 0;
  let maxInFlight = 0;
  const fetchImage = vi.fn(async (url: string) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await flush();
    inFlight -= 1;
    if ((left[url] ?? 0) > 0) {
      left[url] = (left[url] ?? 0) - 1;
      return new Response('nope', { status: 503 });
    }
    return new Response(new TextEncoder().encode(`webp:${new URL(url).pathname}`));
  });
  return { fetchImage, maxInFlight: () => maxInFlight };
}

function readZip(bytes: Uint8Array) {
  const files = unzipSync(bytes);
  const document = JSON.parse(strFromU8(files['backup.json'] ?? new Uint8Array())) as BackupDocument;
  return { files, document };
}

describe('backup export', () => {
  it('[T-app-136] backup.json has format, version, contractsVersion, every page of live caps without imageUrls, and the albums', async () => {
    const caps = [capWithPhotos(1), capWithPhotos(2), capWithPhotos(3), { ...capWithPhotos(4), deletedAt: TS }];
    const { api, paths } = backupApi(caps, 2);
    const { fetchImage } = imageServer();
    const result = await exportBackup({ api, fetch: fetchImage, now: NOW });

    expect(result.fileName).toBe('capcollector-backup-2026-11-21.zip');
    expect(paths.filter((p) => p.startsWith('/caps?'))).toHaveLength(2); // the cursor was followed
    expect(new URL(paths.find((p) => p.startsWith('/caps?')) ?? '', 'https://x').searchParams.get('limit')).toBe('200');
    const { document } = readZip(result.bytes);
    expect(document).toMatchObject({
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: NOW.toISOString(),
      contractsVersion: CONTRACTS_VERSION,
    });
    expect(document.caps.map((c) => c.capId)).toEqual([ulid(1), ulid(2), ulid(3)]);
    for (const cap of document.caps) {
      expect(cap).not.toHaveProperty('imageUrls');
      expect(cap.images?.top.key).toBe(`u1/${cap.capId}/top.webp`);
    }
    expect(document.albums.map((a) => a.letter)).toEqual(['A']);
    expect(document).not.toHaveProperty('missingImages');
    expect(document).not.toHaveProperty('photosOmitted');
  });

  it('[T-app-137] one zip entry per image key (stored, 4 at a time); a photo failing twice is listed in missingImages without aborting', async () => {
    const caps = [capWithPhotos(1, true), capWithPhotos(2), capWithPhotos(3, true), capWithPhotos(4), capWithPhotos(5)];
    const { api } = backupApi(caps);
    const flaky = `https://img.test/${ulid(2)}/top.webp`; // fails once, then works
    const broken = `https://img.test/${ulid(3)}/underside.webp`; // fails twice
    const { fetchImage, maxInFlight } = imageServer({ [flaky]: 1, [broken]: 2 });
    const progress = vi.fn();
    const result = await exportBackup({ api, fetch: fetchImage, now: NOW, onProgress: progress });

    const { files, document } = readZip(result.bytes);
    const images = Object.keys(files)
      .filter((f) => f.startsWith('images/'))
      .sort();
    expect(images).toEqual(
      [
        imagePath(ulid(1), 'top'),
        imagePath(ulid(1), 'underside'),
        imagePath(ulid(2), 'top'),
        imagePath(ulid(3), 'top'),
        imagePath(ulid(4), 'top'),
        imagePath(ulid(5), 'top'),
      ].sort(),
    );
    expect(strFromU8(files[imagePath(ulid(2), 'top')] ?? new Uint8Array())).toBe(`webp:/${ulid(2)}/top.webp`);
    expect(document.missingImages).toEqual([{ capId: ulid(3), side: 'underside' }]);
    expect(result.photos).toBe(6);
    // 7 photos: 5 + 1 retry + 2 attempts for the broken one; never more than 4 in flight.
    expect(fetchImage).toHaveBeenCalledTimes(9);
    expect(maxInFlight()).toBeLessThanOrEqual(PHOTO_CONCURRENCY);
    expect(maxInFlight()).toBeGreaterThan(1);
    expect(progress).toHaveBeenLastCalledWith({ caps: 5, photos: 7, totalPhotos: 7 });
  });

  it('[T-app-138] Settings → Export backup: the share sheet on the iPhone, a download on the Mac; the last export date is kept', async () => {
    const caps = [capWithPhotos(1)];
    const mount = async (kind: 'web' | 'native', store = memoryStore()) => {
      const { api } = backupApi(caps);
      const platform = fakePlatform(kind, store);
      const share = vi.fn(async () => true);
      platform.share = share;
      const ctx: AppContext = {
        ...(await shellContext({ api, platform })),
        navigate: vi.fn(),
        skipSignIn: vi.fn(),
        now: () => NOW,
      };
      const download = vi.fn();
      const el = BackupSection(ctx, { fetch: imageServer().fetchImage, download });
      document.body.replaceChildren(el);
      await flush();
      return { el, share, download, store };
    };
    const settle = async () => {
      for (let i = 0; i < 30; i++) await flush();
    };

    const web = await mount('web');
    expect(web.el.querySelector('[data-backup="last"]')?.textContent).toBe(t('settings.backup.never'));
    web.el.querySelector<HTMLButtonElement>('[data-action="export-backup"]')?.click();
    await settle();
    expect(web.download).toHaveBeenCalledTimes(1);
    expect(web.share).not.toHaveBeenCalled();
    const file = web.download.mock.calls[0]?.[0] as File;
    expect([file.name, file.type]).toEqual(['capcollector-backup-2026-11-21.zip', 'application/zip']);
    expect(readZip(new Uint8Array(await file.arrayBuffer())).document.caps).toHaveLength(1);
    expect(web.el.querySelector('[data-backup="status"]')?.textContent).toBe(
      t('settings.backup.done', { caps: 1, photos: 1 }),
    );
    expect(web.store.data.get(LAST_BACKUP_KEY)).toBe(NOW.toISOString());
    expect(web.el.querySelector('[data-backup="last"]')?.textContent).toBe(
      t('settings.backup.last', { date: '21 Nov 2026' }),
    );

    const ios = await mount('native', memoryStore({ [LAST_BACKUP_KEY]: '2026-10-02T08:00:00.000Z' }));
    expect(ios.el.querySelector('[data-backup="last"]')?.textContent).toBe(
      t('settings.backup.last', { date: '2 Oct 2026' }),
    );
    ios.el.querySelector<HTMLButtonElement>('[data-action="export-backup"]')?.click();
    await settle();
    expect(ios.share).toHaveBeenCalledTimes(1);
    expect(ios.download).not.toHaveBeenCalled();
    const shared = (ios.share.mock.calls[0] as unknown as [{ title: string; files: File[] }])[0];
    expect(shared.files[0]?.name).toBe('capcollector-backup-2026-11-21.zip');

    // A failed export (the API is down) says so, re-enables the button and keeps the last date.
    const store = memoryStore();
    const ctx: AppContext = {
      ...(await shellContext({
        api: fakeApi({ request: vi.fn(async () => Promise.reject(new Error('offline'))) as ApiClient['request'] }),
        platform: fakePlatform('web', store),
      })),
      navigate: vi.fn(),
      skipSignIn: vi.fn(),
      now: () => NOW,
    };
    const failing = BackupSection(ctx, { fetch: imageServer().fetchImage, download: vi.fn() });
    document.body.replaceChildren(failing);
    const button = failing.querySelector<HTMLButtonElement>('[data-action="export-backup"]');
    button?.click();
    await settle();
    expect(failing.querySelector('[data-backup="status"]')?.textContent).toBe(t('settings.backup.failed'));
    expect(button?.disabled).toBe(false);
    expect(store.data.has(LAST_BACKUP_KEY)).toBe(false);
  });

  it('[T-app-139] above 2 000 caps the backup leaves the photos out, says so, and downloads none', async () => {
    const caps = Array.from({ length: MAX_CAPS_WITH_PHOTOS + 1 }, (_, i) => capWithPhotos(i + 1));
    const { api } = backupApi(caps);
    const { fetchImage } = imageServer();
    const result = await exportBackup({ api, fetch: fetchImage, now: NOW });
    expect(fetchImage).not.toHaveBeenCalled();
    const { files, document: backup } = readZip(result.bytes);
    expect(Object.keys(files)).toEqual(['backup.json']);
    expect(backup.caps).toHaveLength(MAX_CAPS_WITH_PHOTOS + 1);
    expect(backup.photosOmitted).toBe(true);
    expect(backup).not.toHaveProperty('missingImages');

    // At the limit, photos are still included.
    const atLimit = backupApi(caps.slice(0, MAX_CAPS_WITH_PHOTOS));
    const server = imageServer();
    const included = await exportBackup({ api: atLimit.api, fetch: server.fetchImage, now: NOW });
    expect(included.photos).toBe(MAX_CAPS_WITH_PHOTOS);
    expect(included.document).not.toHaveProperty('photosOmitted');

    // The Settings line says it.
    const ctx: AppContext = {
      ...(await shellContext({ api, platform: fakePlatform('web') })),
      navigate: vi.fn(),
      skipSignIn: vi.fn(),
      now: () => NOW,
    };
    const el = BackupSection(ctx, { fetch: fetchImage, download: vi.fn() });
    document.body.replaceChildren(el);
    el.querySelector<HTMLButtonElement>('[data-action="export-backup"]')?.click();
    await vi.waitFor(() =>
      expect(el.querySelector('[data-backup="status"]')?.textContent).toBe(
        [
          t('settings.backup.done', { caps: MAX_CAPS_WITH_PHOTOS + 1, photos: 0 }),
          t('settings.backup.photosOmitted', { max: MAX_CAPS_WITH_PHOTOS }),
        ].join(' '),
      ),
    );
  });
});
