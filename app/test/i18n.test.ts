// @vitest-environment node
// i18n: t() interpolation, the message catalogue, and the raw-string check over screens/components (CAP-21).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import en from '../src/i18n/en.json';
import { interpolate, t } from '../src/i18n/i18n';
import { findRawStrings } from './support/i18n-lint';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));

function tsFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return tsFiles(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

describe('i18n', () => {
  it('[T-app-006] screens and components contain no user-visible raw string literals (everything goes through t)', () => {
    const files = [...tsFiles(join(SRC, 'screens')), ...tsFiles(join(SRC, 'components')), join(SRC, 'app.ts')];
    expect(files.length).toBeGreaterThan(5);
    const violations = files.flatMap((file) =>
      findRawStrings(readFileSync(file, 'utf8'), file).map((v) => `${relative(SRC, file)}:${v.line} ${v.text}`),
    );
    expect(violations).toEqual([]);

    // The checker itself catches each pattern it is meant to catch.
    const bad = `
      h('p', {}, 'Hello');
      h('p', {}, flag && 'Maybe', \`Total: \${n}\`);
      h('input', { attrs: { placeholder: 'Type here', 'aria-label': ok ? t('x') : 'Raw' } });
      ScreenHeader('Title');
      el.textContent = 'Saved';
      el.setAttribute('title', 'Tip');
      el.append('More');
    `;
    expect(findRawStrings(bad).map((v) => v.text)).toEqual([
      "'Hello'",
      "'Maybe'",
      '`Total: ${n}`',
      "'Type here'",
      "'Raw'",
      "'Title'",
      "'Saved'",
      "'Tip'",
      "'More'",
    ]);
    const good = `
      h('a', { class: 'tab', attrs: { href: '/scan', 'data-link': true } }, t('tabs.scan'), ' ');
      el.setAttribute('aria-current', 'page');
      el.textContent = t('settings.apiOk');
    `;
    expect(findRawStrings(good)).toEqual([]);
  });

  it('[T-app-014] translates keys from en.json and fills {placeholders}', () => {
    expect(t('tabs.collection')).toBe('Collection');
    expect(Object.values(en).every((v) => typeof v === 'string' && v.trim() !== '')).toBe(true);
    expect(Object.keys(en).every((k) => /^[a-z][A-Za-z]*(\.[a-z][A-Za-z]*)+$/.test(k))).toBe(true);
    expect(t('app.name', { unused: 1 })).toBe('CapCollector');
    expect(interpolate('{done} of {total}', { done: 4, total: 11 })).toBe('4 of 11');
    expect(interpolate('{missing} left', {})).toBe('{missing} left');
  });
});
