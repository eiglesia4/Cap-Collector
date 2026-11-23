// `acquiredWhere` default (CAP-100, features.md § Defaults when unsure and § Place from GPS): on the iPhone, the place
// where the phone is now ("Talavera de la Reina, Toledo"), asked once per form and once per batch; on the web (Mac), the last
// place used on this device, stored when a cap is saved with one. Only names are kept: never coordinates.
import type { AppContext } from '../context.js';
import { countryName } from '../i18n/countries.js';
import type { KeyValueStore, PlaceName } from '../platform/platform.js';

/** Per-device store key of the last `acquiredWhere` saved (web default). */
export const LAST_PLACE_KEY = 'form.lastPlace';
/** `CapOwnership.acquiredWhere` max length. */
export const PLACE_MAX_LENGTH = 120;

/** ISO region of a BCP 47 tag (`es-ES` → `ES`), if it has one. */
export function regionOf(tag: string | undefined): string | undefined {
  if (!tag) return undefined;
  try {
    return new Intl.Locale(tag).region;
  } catch {
    return undefined;
  }
}

/**
 * "Locality, Region" (a region equal to the locality is not repeated), plus the country name in the UI language only
 * when the place is outside the device's region; cut to 120 characters. Empty when nothing is named.
 */
export function formatPlace(place: PlaceName, deviceRegion: string | undefined): string {
  const parts: string[] = [];
  for (const part of [place.locality, place.region]) {
    const name = part?.trim();
    if (name && !parts.some((p) => p.localeCompare(name, undefined, { sensitivity: 'base' }) === 0)) parts.push(name);
  }
  const code = place.countryCode?.trim().toUpperCase();
  if (code && (parts.length === 0 || (deviceRegion !== undefined && code !== deviceRegion.toUpperCase()))) {
    parts.push(countryName(code));
  }
  return parts.join(', ').slice(0, PLACE_MAX_LENGTH).trim();
}

/** Keep `place` as this device's last place used (on save of a cap with an `acquiredWhere`). Never throws. */
export async function rememberPlace(store: KeyValueStore, place: string): Promise<void> {
  const value = place.trim();
  if (value === '') return;
  try {
    await store.set(LAST_PLACE_KEY, value.slice(0, PLACE_MAX_LENGTH));
  } catch {
    // A full or blocked store only loses the default.
  }
}

async function lookUp(ctx: Pick<AppContext, 'platform'>): Promise<string | null> {
  const { platform } = ctx;
  try {
    if (platform.kind === 'web') return (await platform.store.get(LAST_PLACE_KEY))?.trim() || null;
    const place = await platform.currentPlace();
    if (!place) return null;
    const region = place.deviceRegion ?? regionOf(globalThis.navigator?.language);
    return formatPlace(place, region) || null;
  } catch {
    return null;
  }
}

// Once per batch (features.md § Place from GPS): the answer of the batch being worked through, reused by every item.
let batchPlace: { readonly batchId: string; readonly place: Promise<string | null> } | null = null;

/** The `acquiredWhere` default for a new cap's form; null when there is none. Never rejects. */
export function defaultPlace(ctx: Pick<AppContext, 'platform'>, batchId?: string): Promise<string | null> {
  if (batchId === undefined) return lookUp(ctx);
  if (batchPlace?.batchId !== batchId) batchPlace = { batchId, place: lookUp(ctx) };
  return batchPlace.place;
}

/** Forget the batch's place (tests; a new batch replaces it anyway). */
export function resetBatchPlace(): void {
  batchPlace = null;
}
