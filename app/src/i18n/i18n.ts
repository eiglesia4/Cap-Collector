// i18n from day one (CLAUDE.md § app): every user-visible string goes through t('key').
// Keys are typed from en.json, so a missing key is a compile error; T-app-006 checks screens use no raw strings.
// UI language (CAP-97, CONVENTIONS.md § Language, contracts v0.4): Spanish by default (`DEFAULT_LANGUAGE`), English
// available; the choice is made in Settings and kept per device (i18n/language-setting.ts), never taken from the
// device or browser language. `setLanguage` switches at once: listeners (the shell) re-render the current screen.
import { DEFAULT_LANGUAGE, UiLanguage } from '@capcollector/shared';

import en from './en.json';
import es from './es.json';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const CATALOGUES: Readonly<Record<UiLanguage, Messages>> = { en, es: es satisfies Messages };

export const LANGUAGES: readonly UiLanguage[] = UiLanguage.options;

let current: UiLanguage = DEFAULT_LANGUAGE;
let messages: Messages = CATALOGUES[current];
const listeners = new Set<(language: UiLanguage) => void>();

/** The UI language in use. */
export function language(): UiLanguage {
  return current;
}

/**
 * BCP 47 locale for `Intl` in the current language: Spain's Spanish, and for English the British dates / US numbers
 * the app has used since V0 (CAP-23 counts, CAP-24 dates).
 */
export function locale(kind: 'date' | 'number' = 'date'): string {
  if (current === 'es') return 'es-ES';
  return kind === 'date' ? 'en-GB' : 'en-US';
}

/** Switch the UI language: sets `<html lang>` and tells the listeners (no reload). */
export function setLanguage(next: UiLanguage, doc: Document | undefined = globalThis.document): void {
  const changed = next !== current;
  current = next;
  messages = CATALOGUES[next];
  if (doc) doc.documentElement.lang = next;
  if (changed) for (const listener of [...listeners]) listener(next);
}

/** Called after every language change; returns an unsubscribe. */
export function onLanguageChange(listener: (language: UiLanguage) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export type Params = Record<string, string | number>;

/** Replace `{name}` placeholders with `params.name`; unknown placeholders stay visible. */
export function interpolate(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Translate `key` in the current language, filling its placeholders from `params`. */
export function t(key: MessageKey, params: Params = {}): string {
  return interpolate(messages[key], params);
}
