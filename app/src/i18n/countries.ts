// Countries for the cap form's country select (CAP-25) and the collection chips (CAP-23): the ISO 3166-1 alpha-2
// codes (shared `CountryCode`), named by the runtime's Intl data in the UI language (CAP-97, CONVENTIONS.md § Language),
// sorted with that language's collation; search ignores case and accents.
import type { UiLanguage } from '@capcollector/shared';

import { language } from './i18n.js';

/** Officially assigned ISO 3166-1 alpha-2 codes. */
export const COUNTRY_CODES: readonly string[] = (
  'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ ' +
  'CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO ' +
  'FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE ' +
  'JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO ' +
  'MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW ' +
  'PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM ' +
  'TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'
).split(' ');

const displayNames = new Map<UiLanguage, Intl.DisplayNames | null>();

function namesFor(lang: UiLanguage): Intl.DisplayNames | null {
  let names = displayNames.get(lang);
  if (names === undefined) {
    try {
      names = new Intl.DisplayNames([lang], { type: 'region' });
    } catch {
      names = null;
    }
    displayNames.set(lang, names);
  }
  return names;
}

/** Name of an ISO code in the UI language (`ES` → `España` / `Spain`), or the code when the runtime has no name. */
export function countryName(code: string): string {
  const names = namesFor(language());
  try {
    return names?.of(code) ?? code;
  } catch {
    return code;
  }
}

/** Every country as `{ code, name }`, sorted by name in the UI language (`Á` sorts with `A`). */
export function countryOptions(): { code: string; name: string }[] {
  const collator = new Intl.Collator(language(), { sensitivity: 'base' });
  return COUNTRY_CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) =>
    collator.compare(a.name, b.name),
  );
}

/** Countries whose name or code contains `query` (case/accent-insensitive); all of them for an empty query. */
export function searchCountries(query: string): { code: string; name: string }[] {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  const q = fold(query.trim());
  const all = countryOptions();
  return q === '' ? all : all.filter((c) => fold(c.name).includes(q) || c.code.toLowerCase() === q);
}
