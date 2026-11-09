// What a request bundle is about (CAP-45; exchange.md § Flow step 1, scope "this scan/cap · all needsReview · pick
// caps"): the open capture's photos (in memory, CAP-41) or a stored cap's photos (fetched from `imageUrls`) with their
// dHashes, and `known` = what the record already has (`knownFromCap`, CAP-43).
import type { Cap } from '@capcollector/shared';

import type { CaptureSession } from '../capture/context.js';
import { knownFromCap } from '../capture/review.js';
import { storedHash, storedPhoto, type StoredPhotoOptions } from '../images/stored.js';
import type { BundlePhoto, BundleSubject } from './bundle.js';

/** A new scan: its prepared photos and hashes, nothing known yet. Null without an uploaded top photo. */
export function scanSubject(session: CaptureSession | null, scanId: string): BundleSubject | null {
  if (!session || session.scanId !== scanId || !session.top?.ref) return null;
  const photos: BundlePhoto[] = [{ side: 'top', blob: session.top.photo.blob, dhash: session.top.photo.dhash }];
  if (session.underside?.ref) {
    photos.push({ side: 'underside', blob: session.underside.photo.blob, dhash: session.underside.photo.dhash });
  }
  return { scanId: session.scanId, photos, known: {} };
}

/** A stored cap: its photos (GET of the presigned URLs), their hashes (computed when missing) and its fields. */
export async function capSubject(cap: Cap, options: StoredPhotoOptions): Promise<BundleSubject> {
  const photos: BundlePhoto[] = [];
  for (const side of ['top', 'underside'] as const) {
    const blob = await storedPhoto(cap, side, options);
    if (blob === undefined) {
      if (side === 'top') throw new Error('the cap has no top photo URL');
      continue;
    }
    photos.push({ side, blob, dhash: await storedHash(cap, side, options, blob) });
  }
  return { capId: cap.capId, photos, known: knownFromCap(cap) };
}
