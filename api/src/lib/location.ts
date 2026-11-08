// Cap location service (CAP-50): PUT/DELETE /caps/{capId}/location behind thin handlers. Spec: ADR-005, ADR-006 (a
// history entry on every change), physical-link.md § Keeping them in sync ("moves/swaps are explicit actions with
// history"), openapi.yaml /caps/{capId}/location, data-model.md § Invariants (LOCK# markers in the cap's transaction).
import { type Cap, type CapHistory, Location } from '@capcollector/shared';
import { z } from 'zod';

import { albumIdOf, liveCap, sameLocation } from './caps.js';
import { occupantOf, occupied, resolveLocation } from './pockets.js';
import type { Repositories } from './repo/types.js';
import { after } from './time.js';

/** PUT body (openapi.yaml): `location` required, `swap` false by default. */
export const LocationPutBody = z.object({ location: Location, swap: z.boolean().default(false) }).strict();
export type LocationPutBody = z.infer<typeof LocationPutBody>;

export interface LocationResult {
  cap: Cap;
  /** The cap that was in the target pocket, now at this cap's previous location (or none). */
  swapped?: Cap;
}

// SPEC-GAP CAP-50: the story says history `source` = caller, but the PUT/DELETE bodies carry no `source`; every
// location change made through these endpoints is recorded as `manual`.
const SOURCE = 'manual' as const;

function withLocation(cap: Cap, location: Location | undefined, ts: string): Cap {
  const next: Cap = { ...cap, updatedAt: ts };
  delete next.location;
  return location ? { ...next, location } : next;
}

function locationChange(from: Location | undefined, to: Location | undefined): CapHistory['changes'] {
  return [{ field: 'location', ...(from ? { from } : {}), ...(to ? { to } : {}) }];
}

/**
 * PUT /caps/{capId}/location. An occupied target pocket is 409 naming the occupant, unless `swap`: then one
 * transaction moves both caps (the occupant takes this cap's previous location, or none) with two `swapped` entries.
 */
export async function putLocation(
  repos: Repositories,
  uid: string,
  capId: string,
  body: LocationPutBody,
): Promise<LocationResult> {
  const prev = await liveCap(repos, uid, capId);
  const target = await resolveLocation(repos, uid, body.location);
  if (prev.location && sameLocation(prev.location, target.location)) return { cap: prev };

  const prevAlbumId = await albumIdOf(repos, uid, prev);
  const occupant = await occupantOf(repos, uid, target);
  const ts = after(prev.updatedAt);
  const cap = withLocation(prev, target.location, ts);
  const change = locationChange(prev.location, target.location);
  const lock = target.lockAlbumId ? { albumId: target.lockAlbumId } : {};

  if (occupant && occupant !== capId) {
    if (!body.swap) throw occupied(target, occupant);
    const other = await liveCap(repos, uid, occupant);
    const otherAlbumId = await albumIdOf(repos, uid, other);
    // The occupant takes exactly the location this cap leaves, with its album id filled like any stored location.
    const vacated =
      prev.location && prevAlbumId && prev.location.kind === 'album'
        ? { ...prev.location, albumId: prevAlbumId }
        : prev.location;
    const otherTs = after(other.updatedAt);
    const swapped = withLocation(other, vacated, otherTs);
    await repos.caps.swap(
      uid,
      {
        prev: { cap: prev, ...(prevAlbumId ? { albumId: prevAlbumId } : {}) },
        write: { cap, ...lock, history: { capId, ts, source: SOURCE, action: 'swapped', changes: change } },
      },
      {
        prev: { cap: other, ...(otherAlbumId ? { albumId: otherAlbumId } : {}) },
        write: {
          cap: swapped,
          ...(prevAlbumId ? { albumId: prevAlbumId } : {}),
          history: {
            capId: other.capId,
            ts: otherTs,
            source: SOURCE,
            action: 'swapped',
            changes: locationChange(other.location, vacated),
          },
        },
      },
    );
    return { cap, swapped };
  }

  // SPEC-GAP CAP-50: the story names the history action `move`; the shared enum has `located` (first placement)
  // and `moved` (a change of location), so those are used.
  const action = prev.location ? 'moved' : 'located';
  await repos.caps.patch(
    uid,
    { cap: prev, ...(prevAlbumId ? { albumId: prevAlbumId } : {}) },
    { cap, ...lock, history: { capId, ts, source: SOURCE, action, changes: change } },
  );
  return { cap };
}

/** DELETE /caps/{capId}/location: clears location, GSI1 keys and the pocket lock; idempotent when already clear. */
export async function deleteLocation(repos: Repositories, uid: string, capId: string): Promise<void> {
  const prev = await liveCap(repos, uid, capId);
  if (!prev.location) return;
  const prevAlbumId = await albumIdOf(repos, uid, prev);
  const ts = after(prev.updatedAt);
  await repos.caps.patch(
    uid,
    { cap: prev, ...(prevAlbumId ? { albumId: prevAlbumId } : {}) },
    {
      cap: withLocation(prev, undefined, ts),
      history: { capId, ts, source: SOURCE, action: 'moved', changes: locationChange(prev.location, undefined) },
    },
  );
}
