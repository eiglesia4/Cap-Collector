// UI language (CAP-97, CONVENTIONS.md § Language, SCREENS.md § Language, contracts v0.4): the Spanish catalogue, the
// stored choice with Spanish as default, the instant switch, localised labels, and the language sent to the AI, written
// into exchange bundles and printed in the PDF.
import { AnalyseRequest, Cap, DEFAULT_LANGUAGE, exchangeInstructions } from '@capcollector/shared';
import { PDFDocument } from 'pdf-lib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { renderApp, type AppHandle } from '../src/app';
import { analyseBody } from '../src/capture/flow';
import { reidentifyBody } from '../src/capture/review';
import { requestDocument } from '../src/exchange/bundle';
import { countryName, countryOptions, searchCountries } from '../src/i18n/countries';
import en from '../src/i18n/en.json';
import es from '../src/i18n/es.json';
import { language, locale, onLanguageChange, setLanguage, t } from '../src/i18n/i18n';
import { CONDITION_LABEL, TYPE_LABEL } from '../src/i18n/labels';
import { chooseLanguage, LANGUAGE_KEY, loadLanguage, readLanguage } from '../src/i18n/language-setting';
import { buildInsertsPdf } from '../src/print/inserts';
import { ulid, wireCap } from './support/caps';
import { fakePlatform, memoryStore, shellContext } from './support/fakes';

const HASH = '0123456789abcdef';
const placeholders = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

describe('UI language (CAP-97)', () => {
  let handle: AppHandle | undefined;
  let root: HTMLElement;
  beforeEach(() => {
    root = document.createElement('div');
    document.body.replaceChildren(root);
  });
  afterEach(() => {
    handle?.destroy();
    handle = undefined;
  });

  it('[T-app-185] es.json has exactly the keys of en.json, no empty value and the same {placeholders}', () => {
    expect(Object.keys(es)).toEqual(Object.keys(en));
    const english: Record<string, string> = en;
    for (const [key, value] of Object.entries(es as Record<string, string>)) {
      expect(value.trim(), key).not.toBe('');
      expect(placeholders(value), key).toEqual(placeholders(english[key] ?? ''));
    }
    // Spain's Spanish with the collection's own words.
    expect(es['tabs.collection']).toBe('Colección');
    expect(es['collection.gridAll']).toBe('Todas');
  });

  it('[T-app-186] Spanish is the default with nothing stored; a stored choice wins; the device language is ignored', async () => {
    expect(DEFAULT_LANGUAGE).toBe('es');
    expect(await readLanguage(memoryStore())).toBe('es');
    expect(await readLanguage(memoryStore({ [LANGUAGE_KEY]: 'en' }))).toBe('en');
    expect(await readLanguage(memoryStore({ [LANGUAGE_KEY]: 'fr' }))).toBe('es');
    const broken = { ...memoryStore(), get: () => Promise.reject(new Error('io')) };
    expect(await readLanguage(broken)).toBe('es');

    // navigator.language is English in the test DOM; startup still applies Spanish.
    setLanguage('en');
    expect(await loadLanguage(memoryStore())).toBe('es');
    expect(language()).toBe('es');
    expect(t('tabs.scan')).toBe(es['tabs.scan']);

    const store = memoryStore();
    await chooseLanguage(store, 'en');
    expect(store.data.get(LANGUAGE_KEY)).toBe('en');
    expect(language()).toBe('en');
  });

  it('[T-app-187] switching the language re-renders the current screen and the tabs at once and sets html[lang]', async () => {
    setLanguage('es');
    window.history.replaceState(null, '', '/settings');
    const platform = fakePlatform('native');
    handle = renderApp(root, await shellContext({ platform }));
    const h1 = () => root.querySelector('h1')?.textContent;
    const firstTab = () => root.querySelector('.tab-bar a')?.textContent;
    expect(h1()).toBe(es['settings.title']);
    expect(firstTab()).toBe(es['tabs.collection']);
    expect(document.documentElement.lang).toBe('es');

    // Settings → Language → English: same route, no reload, stored per device.
    const select = root.querySelector<HTMLSelectElement>('select#language');
    expect([...(select?.options ?? [])].map((o) => [o.value, o.textContent])).toEqual([
      ['es', 'Español'],
      ['en', 'English'],
    ]);
    expect(select?.value).toBe('es');
    select!.value = 'en';
    select!.dispatchEvent(new Event('change'));
    await Promise.resolve();
    expect(h1()).toBe(en['settings.title']);
    expect(firstTab()).toBe(en['tabs.collection']);
    expect(document.documentElement.lang).toBe('en');
    expect(window.location.pathname).toBe('/settings');
    expect(await platform.store.get(LANGUAGE_KEY)).toBe('en');
    expect(root.querySelector<HTMLSelectElement>('select#language')?.value).toBe('en');
    expect(root.querySelectorAll('.tab-bar')).toHaveLength(1);

    // Setting the same language again does not notify; unsubscribing stops the calls.
    let calls = 0;
    const stop = onLanguageChange(() => calls++);
    setLanguage('en');
    setLanguage('es');
    stop();
    setLanguage('en');
    expect(calls).toBe(1);
  });

  it('[T-app-188] country names, enum labels, dates and numbers come out in Spanish; country search ignores accents', () => {
    setLanguage('es');
    expect(countryName('ES')).toBe('España');
    expect(countryName('DE')).toBe('Alemania');
    expect(t(TYPE_LABEL.beer)).toBe('Cerveza');
    expect(t(CONDITION_LABEL.mint)).toBe(es['condition.mint']);
    expect(locale()).toBe('es-ES');
    expect(locale('number')).toBe('es-ES');
    // Spanish collation: names with an accented first letter sort with their base letter.
    const names = countryOptions().map((c) => c.name);
    const collator = new Intl.Collator('es', { sensitivity: 'base' });
    expect([...names].sort((a, b) => collator.compare(a, b))).toEqual(names);
    expect(searchCountries('espana').map((c) => c.code)).toContain('ES');
    expect(searchCountries('japon').map((c) => c.code)).toContain('JP');

    setLanguage('en');
    expect(countryName('ES')).toBe('Spain');
    expect(t(TYPE_LABEL.beer)).toBe('Beer');
    expect([locale(), locale('number')]).toEqual(['en-GB', 'en-US']);
  });

  it('[T-app-189] every analyse body carries the UI language (single scan, ask again, re-identify)', () => {
    setLanguage('es');
    const ref = (side: string) => ({ key: `u1/${ulid(1)}/${side}.webp`, width: 1024, height: 1024 });
    const photo = { blob: new Blob(), width: 1024, height: 1024, dhash: HASH };
    const single = analyseBody({ scanId: ulid(2), useAi: true, top: { photo, ref: ref('top') } });
    expect(single.language).toBe('es');
    expect(AnalyseRequest.parse(single)).toEqual(single);

    const cap = Cap.parse(wireCap(3, { brand: 'Mahou' }));
    expect(reidentifyBody(cap, ulid(4), HASH).language).toBe('es');

    setLanguage('en');
    expect(reidentifyBody(cap, ulid(4), HASH).language).toBe('en');
  });

  it('[T-app-190] exchange request bundles carry the instructions in the UI language', () => {
    const subject = { photos: [{ side: 'top' as const, blob: new Blob(), dhash: HASH }], known: {} };
    setLanguage('es');
    const spanish = requestDocument(subject, ulid(5), '2026-11-23T10:00:00.000Z');
    expect(spanish.instructions).toBe(exchangeInstructions('es'));
    expect(spanish.instructions).toMatch(/Spanish/);
    setLanguage('en');
    expect(requestDocument(subject, ulid(5), '2026-11-23T10:00:00.000Z').instructions).toBe(exchangeInstructions('en'));
  });

  it('[T-app-191] the insert PDF is titled in the UI language', async () => {
    const TS = '2026-11-09T10:00:00.000Z';
    const album = {
      albumId: ulid(9),
      letter: 'A',
      name: 'Leuchtturm GRANDE',
      kind: 'album',
      sheets: 10,
      cols: 6,
      rows: 7,
      pocketMm: 33,
      pitchMm: 36,
      createdAt: TS,
      updatedAt: TS,
    };
    const cap = Cap.parse(wireCap(1, { brand: 'Mahou', location: { kind: 'album', album: 'A', sheet: 1, pocket: 1 } }));
    const input = {
      album: album as never,
      discs: [cap],
      sheets: [{ sheet: 1, caps: [cap] }],
      what: 'both' as const,
      printedOn: new Date(TS),
    };
    setLanguage('es');
    const spanish = await PDFDocument.load(await buildInsertsPdf(input));
    expect(spanish.getTitle()).toBe(t('print.pdfTitle', { letter: 'A' }));
    expect(spanish.getTitle()).not.toBe(en['print.pdfTitle'].replace('{letter}', 'A'));
    setLanguage('en');
    const english = await PDFDocument.load(await buildInsertsPdf(input));
    expect(english.getTitle()).toBe(en['print.pdfTitle'].replace('{letter}', 'A'));
  });
});
