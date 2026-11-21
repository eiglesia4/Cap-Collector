// Backup export (CAP-80; features.md § Phase 2 "backup export/import", EP-07; ADR-006): the whole collection as one zip
// the user keeps, independent of AWS Backup. Format `capcollector.backup` v1, defined by CAP-80 (the architect copies
// it into exchange.md):
//   capcollector-backup-<YYYY-MM-DD>.zip
//   ├── backup.json  { format, version: 1, exportedAt, contractsVersion, caps: [Cap…], albums: [Album…],
//   │                  missingImages?: [{capId, side}] }
//   └── images/<capId>-top.webp · images/<capId>-underside.webp
// Caps are every live cap of `GET /caps` (all pages; tombstones are not listed) as the API returns them minus the
// short-lived `imageUrls`; each `images.<side>.key` maps to its file. Photos are downloaded with those presigned URLs,
// 4 at a time, each retried once; a photo that still fails is listed in `missingImages` and the export goes on.
// WebP is stored as is (zip level 0); backup.json is deflated. Above 2 000 caps the photos are left out (memory).
// DOM-free.
import { CONTRACTS_VERSION, type Album, type Cap } from '@capcollector/shared';
import { strToU8, zipSync, type Zippable } from 'fflate';

import type { ApiClient } from '../api/client.js';
import { AlbumListSchema } from '../albums/model.js';
import { fetchAllCaps } from '../collection/all-caps.js';

export const BACKUP_FORMAT = 'capcollector.backup';
export const BACKUP_VERSION = 1;
/** Above this many caps the export leaves the photos out (≈ 150 KB × 2 each, all held in memory). */
export const MAX_CAPS_WITH_PHOTOS = 2000;
/** Photos downloaded at the same time. */
export const PHOTO_CONCURRENCY = 4;
export const ZIP_TYPE = 'application/zip';

export type Side = 'top' | 'underside';

export interface MissingImage {
  readonly capId: string;
  readonly side: Side;
}

/** A cap as stored in backup.json: the API's cap without the presigned `imageUrls`. */
export type BackupCap = Omit<Cap, 'imageUrls'>;

export interface BackupDocument {
  readonly format: typeof BACKUP_FORMAT;
  readonly version: typeof BACKUP_VERSION;
  readonly exportedAt: string;
  readonly contractsVersion: string;
  readonly caps: readonly BackupCap[];
  readonly albums: readonly Album[];
  readonly missingImages?: readonly MissingImage[];
  /**
   * SPEC-GAP CAP-80: the story's format has no field for "photos left out by the 2 000-cap guard"; without one an
   * importer could not tell a deliberate omission from a broken export, so the guard sets `photosOmitted: true`.
   */
  readonly photosOmitted?: true;
}

export interface BackupProgress {
  readonly caps: number;
  readonly photos: number;
  readonly totalPhotos: number;
}

export interface BackupResult {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly document: BackupDocument;
  /** Photos written to the zip. */
  readonly photos: number;
}

export interface BackupDeps {
  readonly api: Pick<ApiClient, 'request'>;
  /** Downloads a presigned image URL (the platform's `fetch`). */
  readonly fetch: (url: string) => Promise<Response>;
  readonly now: Date;
  readonly onProgress?: (progress: BackupProgress) => void;
}

/** `images/<capId>-<side>.webp`. */
export function imagePath(capId: string, side: Side): string {
  return `images/${capId}-${side}.webp`;
}

/** `capcollector-backup-<YYYY-MM-DD>.zip` (UTC date of the export). */
export function backupFileName(now: Date): string {
  return `capcollector-backup-${now.toISOString().slice(0, 10)}.zip`;
}

function withoutUrls(cap: Cap): BackupCap {
  const { imageUrls: _urls, ...rest } = cap;
  return rest;
}

interface PhotoJob {
  readonly capId: string;
  readonly side: Side;
  readonly url: string | undefined;
}

function photoJobs(caps: readonly Cap[]): PhotoJob[] {
  return caps.flatMap((cap) =>
    (['top', 'underside'] as const)
      .filter((side) => cap.images?.[side] !== undefined)
      .map((side) => ({ capId: cap.capId, side, url: cap.imageUrls?.[side] })),
  );
}

async function download(fetchImage: BackupDeps['fetch'], url: string): Promise<Uint8Array> {
  const response = await fetchImage(url);
  if (!response.ok) throw new Error(`image: HTTP ${String(response.status)}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** Every job, `PHOTO_CONCURRENCY` at a time; a job is retried once, then reported missing. */
async function downloadAll(
  jobs: readonly PhotoJob[],
  fetchImage: BackupDeps['fetch'],
  onDone: () => void,
): Promise<{ files: Map<string, Uint8Array>; missing: MissingImage[] }> {
  const files = new Map<string, Uint8Array>();
  const failed = new Set<number>();
  let next = 0;
  const worker = async () => {
    while (next < jobs.length) {
      const index = next++;
      const job = jobs[index];
      if (!job) continue;
      let bytes: Uint8Array | undefined;
      for (let attempt = 0; attempt < 2 && bytes === undefined && job.url !== undefined; attempt++) {
        bytes = await download(fetchImage, job.url).catch(() => undefined);
      }
      if (bytes === undefined) failed.add(index);
      else files.set(imagePath(job.capId, job.side), bytes);
      onDone();
    }
  };
  await Promise.all(Array.from({ length: Math.min(PHOTO_CONCURRENCY, jobs.length) }, worker));
  // In job order, whatever order the downloads finished in.
  const missing = jobs.filter((_, i) => failed.has(i)).map(({ capId, side }) => ({ capId, side }));
  return { files, missing };
}

export async function exportBackup(deps: BackupDeps): Promise<BackupResult> {
  const [caps, albums] = await Promise.all([
    fetchAllCaps(deps.api),
    deps.api.request('/albums', { schema: AlbumListSchema }),
  ]);
  const live = caps.filter((c) => c.deletedAt === undefined);
  const omitPhotos = live.length > MAX_CAPS_WITH_PHOTOS;
  const jobs = omitPhotos ? [] : photoJobs(live);
  let done = 0;
  const progress = () => deps.onProgress?.({ caps: live.length, photos: done, totalPhotos: jobs.length });
  progress();
  const { files, missing } = await downloadAll(jobs, deps.fetch, () => {
    done += 1;
    progress();
  });

  const document: BackupDocument = {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: deps.now.toISOString(),
    contractsVersion: CONTRACTS_VERSION,
    caps: live.map(withoutUrls),
    albums,
    ...(missing.length > 0 ? { missingImages: missing } : {}),
    ...(omitPhotos ? { photosOmitted: true as const } : {}),
  };
  const zip: Zippable = { 'backup.json': strToU8(JSON.stringify(document, null, 2)) };
  for (const [path, bytes] of files) zip[path] = [bytes, { level: 0 }];
  return { fileName: backupFileName(deps.now), bytes: zipSync(zip), document, photos: files.size };
}
