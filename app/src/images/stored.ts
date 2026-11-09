// A stored cap's photos on the client (CAP-43 re-identify, CAP-45 exchange bundle): the GET of an image's presigned URL
// (`Cap.imageUrls`, CAP-26) and the dHash of a side, the stored one or — for a cap saved without one (manual photos,
// CAP-25) — computed from the stored photo with the same circular crop + dHash as a scan (CAP-36).
import type { Cap } from '@capcollector/shared';

import { HttpError } from '../api/errors.js';
import { resizeToWebp, type CapPhoto } from './resize.js';

export interface StoredPhotoOptions {
  /** Circular crop + dHash; tests inject a fake (happy-dom has no canvas). */
  readonly prepare?: (file: Blob) => Promise<CapPhoto>;
  /** GET of the stored photo's presigned URL. */
  readonly fetchImage?: (url: string) => Promise<Blob>;
}

export async function fetchBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) throw new HttpError(res.status);
  return res.blob();
}

export type StoredSide = 'top' | 'underside';

/** The stored photo of one side, or undefined when the cap has none (or no URL for it). */
export async function storedPhoto(cap: Cap, side: StoredSide, options: StoredPhotoOptions): Promise<Blob | undefined> {
  const url = cap.imageUrls?.[side];
  if (!cap.images[side] || url === undefined) return undefined;
  return (options.fetchImage ?? fetchBlob)(url);
}

/** The side's stored hash, or one computed from `blob` (fetched from the stored photo when not given). */
export async function storedHash(
  cap: Cap,
  side: StoredSide,
  options: StoredPhotoOptions,
  blob?: Blob,
): Promise<string> {
  const stored = side === 'top' ? cap.dhash : cap.dhashUnderside;
  if (stored !== undefined) return stored;
  const source = blob ?? (await storedPhoto(cap, side, options));
  if (source === undefined) throw new Error(`no ${side} image to hash`);
  const photo = await (options.prepare ?? ((file: Blob) => resizeToWebp(file, { crop: 'circle' })))(source);
  return photo.dhash;
}
