// Defaults when unsure (CAP-98, features.md § Defaults when unsure, decided with Edu 2026-11-23): what a new cap gets
// rather than a blank. `acquiredOn` = today (not marked), `year` = the current year, crown caps steel + pry-off and the
// device's place (marked "default — check"), and `type` guessed from the cap's text (marked "guessed — check").
// CAP-124: one function, `newCapDefaults`, for every capture path — the form (built-in AI review, single exchange,
// Manual entry, batch) and multi-import — so they never drift. Editing an existing cap never gets defaults. DOM-free.
import type { CapType, Closure, Material } from '@capcollector/shared';

export const DEFAULT_MATERIAL: Material = 'steel';
export const DEFAULT_CLOSURE: Closure = 'pry-off';

/** How a value the user did not type got into a field. */
export type Mark = 'default' | 'guessed';

/** Today as the form's `acquiredOn` value (`YYYY-MM-DD`, the device's local date). */
export function localDate(now: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${String(now.getFullYear())}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Lower case without accents (`Bräu` → `brau`, `Tónica` → `tonica`); `ø` is kept, as NFD does not split it. */
function fold(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

interface Rule {
  readonly type: CapType;
  /** Matched anywhere in the text: also inside compounds (`Weissbier`, `Hofbräu`, `Cervecería`). */
  readonly anywhere: readonly string[];
  /** Matched only as a whole word: short words that hide inside others (`chocolate`, `Beaujolais`, `aguardiente`). */
  readonly word: readonly string[];
}

/** First rule wins, beer first (CAP-98). Keywords are already folded. */
const RULES: readonly Rule[] = [
  {
    type: 'beer',
    anywhere: [
      'cervecera',
      'cerveceria',
      'cerveza',
      'brewery',
      'brewing',
      'brauerei',
      'brau',
      'brasserie',
      'birrificio',
    ],
    word: ['birra', 'bier', 'beer', 'øl'],
  },
  { type: 'cider', anywhere: ['sidra', 'cider', 'cidre', 'sagardoa'], word: [] },
  { type: 'wine', anywhere: ['bodega', 'winery'], word: ['vino', 'wine', 'cava'] },
  { type: 'water', anywhere: ['mineral'], word: ['agua', 'water', 'eau'] },
  { type: 'soft drink', anywhere: ['refresco', 'tonica', 'lemonade', 'limonada'], word: ['cola', 'soda'] },
];

/** Cap type named by the text (brand, producer, description, text on the cap), or undefined when nothing matches. */
export function guessType(text: string): CapType | undefined {
  const folded = fold(text);
  const words = new Set(folded.split(/[^\p{L}\p{N}]+/u).filter(Boolean));
  for (const rule of RULES) {
    // Compound words keep `bier` at the end (`Weissbier`, `Pilsbier`): a word ending in it counts too.
    if (rule.anywhere.some((k) => folded.includes(k))) return rule.type;
    if (rule.word.some((k) => words.has(k) || (k === 'bier' && [...words].some((w) => w.endsWith(k))))) {
      return rule.type;
    }
  }
  return undefined;
}

/** The fields a new cap may get by default (CAP-124). */
export type DefaultField = 'acquiredOn' | 'year' | 'type' | 'material' | 'closure' | 'acquiredWhere';

/** What is known of a new cap; a missing key is an empty field. */
export interface NewCapFields {
  readonly acquiredOn?: string;
  readonly year?: number;
  readonly material?: Material;
  readonly closure?: Closure;
  readonly type?: CapType;
  readonly acquiredWhere?: string;
}

export interface DefaultsInput {
  readonly now: Date;
  /** The cap's text the type is guessed from: brand, producer, description, text on the cap. */
  readonly text: string;
  /** The device's place (features.md § Place from GPS), when known. */
  readonly place?: string | null;
}

export interface FilledDefaults {
  /** Only the fields that were empty and got a value. */
  readonly values: { -readonly [K in keyof NewCapFields]: NewCapFields[K] };
  /** How each filled field got its value (`acquiredOn` is filled but never marked). */
  readonly marks: ReadonlyMap<DefaultField, Mark>;
  /** The filled fields, in the order above. */
  readonly filled: readonly DefaultField[];
}

/**
 * features.md § Defaults when unsure for a new cap: fills only what is empty, never a value given (by the AI or the
 * user), and says how each one was filled. `type` stays empty when the text names nothing.
 */
export function newCapDefaults(given: NewCapFields, input: DefaultsInput): FilledDefaults {
  const values: FilledDefaults['values'] = {};
  const marks = new Map<DefaultField, Mark>();
  const filled: DefaultField[] = [];
  const fill = <K extends DefaultField>(field: K, value: NewCapFields[K] | undefined, mark?: Mark) => {
    if (given[field] !== undefined || value === undefined) return;
    values[field] = value;
    filled.push(field);
    if (mark) marks.set(field, mark);
  };
  fill('acquiredOn', localDate(input.now));
  fill('year', input.now.getFullYear(), 'default');
  fill('type', given.type === undefined ? guessType(input.text) : undefined, 'guessed');
  fill('material', DEFAULT_MATERIAL, 'default');
  fill('closure', DEFAULT_CLOSURE, 'default');
  fill('acquiredWhere', input.place ? input.place : undefined, 'default');
  return { values, marks, filled };
}
