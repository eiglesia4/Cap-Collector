// i18n from day one (CLAUDE.md § app): every user-visible string goes through t('key'); English copy first.
// Keys are typed from en.json, so a missing key is a compile error; T-app-006 checks screens use no raw strings.
import en from './en.json';

export type MessageKey = keyof typeof en;
export type Messages = Record<MessageKey, string>;

const messages: Messages = en;

export type Params = Record<string, string | number>;

/** Replace `{name}` placeholders with `params.name`; unknown placeholders stay visible. */
export function interpolate(template: string, params: Params): string {
  return template.replace(/\{(\w+)\}/g, (match, name: string) => (name in params ? String(params[name]) : match));
}

/** Translate `key`, filling its placeholders from `params`. */
export function t(key: MessageKey, params: Params = {}): string {
  return interpolate(messages[key], params);
}
