// The in-app native place plugin (CAP-100, features.md § Place from GPS): app/ios/App/App/PlaceNamePlugin.swift,
// registered by MainViewController under the JS name `PlaceName` (same pattern as AppleSignInPlugin, CAP-65; no npm
// dependency). One call, `currentPlace()`: "when in use" location with reduced accuracy, one fix, reverse-geocoded
// on the device with CLGeocoder. Resolves the names only (never coordinates), or `{}` on denial, error or timeout.
import { registerPlugin } from '@capacitor/core';

/** The plugin gives up after this long (location + geocoding, from the moment location is authorised). */
export const PLACE_TIMEOUT_MS = 3000;
/**
 * JS-side guard for a bridge that never answers. Longer than the plugin's own timeout because the one-time permission
 * alert is not timed natively (a slow tap there must not lose the first place).
 */
export const PLACE_GUARD_MS = 30_000;

export interface PlaceNamePlugin {
  /** `{ locality?, region?, countryCode?, deviceRegion? }`; empty when there is no place. Never rejects. */
  currentPlace(): Promise<Record<string, unknown>>;
}

export const PlaceName = registerPlugin<PlaceNamePlugin>('PlaceName');
