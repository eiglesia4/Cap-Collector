// Settings → Language (CAP-97, SCREENS.md § Language): the UI language chosen on this device, kept in the platform
// key/value store. Nothing stored (or an unknown value) → `DEFAULT_LANGUAGE` (Spanish); the device language is not used.
import { DEFAULT_LANGUAGE, UiLanguage } from '@capcollector/shared';

import type { KeyValueStore } from '../platform/platform.js';
import { setLanguage } from './i18n.js';

export const LANGUAGE_KEY = 'ui.language';

/** The stored language, or the default. */
export async function readLanguage(store: KeyValueStore): Promise<UiLanguage> {
  const parsed = UiLanguage.safeParse(await store.get(LANGUAGE_KEY).catch(() => null));
  return parsed.success ? parsed.data : DEFAULT_LANGUAGE;
}

/** Startup: apply the stored (or default) language before the first render. */
export async function loadLanguage(store: KeyValueStore): Promise<UiLanguage> {
  const lang = await readLanguage(store);
  setLanguage(lang);
  return lang;
}

/** Settings: store the choice and apply it at once. */
export async function chooseLanguage(store: KeyValueStore, lang: UiLanguage): Promise<void> {
  setLanguage(lang);
  await store.set(LANGUAGE_KEY, lang);
}
