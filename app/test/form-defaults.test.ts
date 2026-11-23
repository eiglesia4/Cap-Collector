// Defaults when unsure (CAP-98, features.md § Defaults when unsure): today / steel / pry-off on a new cap, the type
// guessed from the cap's text, the marks and the "to verify" status on save; nothing of it in edit mode.
import { Cap, type AnalyseResponse, type ImageRef } from '@capcollector/shared';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ApiClient, RequestOptions } from '../src/api/client';
import type { CaptureSession } from '../src/capture/context';
import { guessType, localDate } from '../src/capture/defaults';
import type { AppContext } from '../src/context';
import { t } from '../src/i18n/i18n';
import type { CapPhoto } from '../src/images/resize';
import { CapForm, type CapFormOptions } from '../src/screens/cap-form-screen';
import { ulid, wireCap } from './support/caps';
import { fakeApi, fakePlatform, flush, shellContext } from './support/fakes';

const SCAN_ID = ulid(60);
const HASH = 'f0f0f03030f0f0f0';
/** Pinned clock: 5 March 2026, local time. */
const NOW = new Date(2026, 2, 5, 10, 30);

const photo: CapPhoto = {
  blob: new Blob([new Uint8Array(900)], { type: 'image/webp' }),
  width: 1024,
  height: 1024,
  dhash: HASH,
};
const ref: ImageRef = { key: `u1/${SCAN_ID}/top.webp`, width: 1024, height: 1024, bytes: 900 };

function session(response: AnalyseResponse): CaptureSession {
  return { scanId: SCAN_ID, useAi: true, top: { photo, ref }, response };
}
const unidentified = (): AnalyseResponse => ({ scanId: SCAN_ID, outcome: 'unidentified', suggestions: [] });

interface Call {
  path: string;
  method: string;
  body: unknown;
}

async function mount(options: CapFormOptions) {
  const calls: Call[] = [];
  const request = vi.fn(async <T>(path: string, opts: RequestOptions<T>): Promise<T> => {
    const method = opts.method ?? 'GET';
    calls.push({ path, method, body: opts.body });
    const answer =
      path === '/caps' || path.startsWith('/caps/') ? { ...wireCap(9), ...(opts.body as object) } : undefined;
    const parsed = opts.schema.safeParse(answer);
    if (!parsed.success) throw parsed.error;
    return parsed.data;
  });
  const ctx: AppContext = {
    ...(await shellContext({ api: fakeApi({ request: request as ApiClient['request'] }), platform: fakePlatform() })),
    navigate: vi.fn(),
    skipSignIn: vi.fn(),
    now: () => NOW,
  };
  const el = CapForm(ctx, options);
  document.body.replaceChildren(el);
  const saved = async () => {
    el.querySelector('form')?.dispatchEvent(new Event('submit', { cancelable: true }));
    for (let i = 0; i < 8; i++) await flush();
    return calls.find((c) => c.method === 'POST' || c.method === 'PATCH')?.body as Record<string, unknown> | undefined;
  };
  return { el, saved };
}

const control = (el: ParentNode, name: string) =>
  el.querySelector<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(`#cap-${name}`);
const fieldEl = (el: ParentNode, name: string) => el.querySelector(`.field[data-field="${name}"]`);
const markOf = (el: ParentNode, name: string) =>
  el.querySelector(`[data-hint-for="${name}"] [data-mark]`)?.getAttribute('data-mark') ?? null;
function type(el: ParentNode, name: string, value: string): void {
  const input = control(el, name);
  if (!input) throw new Error(`missing #cap-${name}`);
  input.value = value;
  input.dispatchEvent(new Event(input instanceof HTMLSelectElement ? 'change' : 'input'));
}

afterEach(() => document.body.replaceChildren());

describe('defaults when unsure (CAP-98)', () => {
  it('[T-app-192] guessType: one case per rule, accents and case ignored, beer first, no match → undefined', () => {
    expect(guessType('Cervecería La Virgen')).toBe('beer');
    expect(guessType('HOFBRÄU München')).toBe('beer');
    expect(guessType('Paulaner Weissbier')).toBe('beer');
    expect(guessType('Brasserie Dupont')).toBe('beer');
    expect(guessType('Carlsberg Øl')).toBe('beer');
    expect(guessType('Sidra El Gaitero')).toBe('cider');
    expect(guessType('Sagardoa Zapiain')).toBe('cider');
    expect(guessType('Bodegas Torres')).toBe('wine');
    expect(guessType('Cava brut nature')).toBe('wine');
    expect(guessType('Agua de Solán de Cabras')).toBe('water');
    expect(guessType('Eau minérale naturelle')).toBe('water');
    expect(guessType('Tónica Schweppes')).toBe('soft drink');
    expect(guessType('Coca-Cola')).toBe('soft drink');
    // First rule wins: a brewery that also makes lemonade is a beer.
    expect(guessType('Brewery lemonade')).toBe('beer');
    // Short words only as whole words.
    expect(guessType('Chocolate factory')).toBeUndefined();
    expect(guessType('Beaujolais')).toBeUndefined();
    expect(guessType('Aguardiente')).toBeUndefined();
    expect(guessType('Mahou')).toBeUndefined();
    expect(guessType('')).toBeUndefined();
    expect(localDate(NOW)).toBe('2026-03-05');
  });

  it('[T-app-193] a new manual cap gets today, steel and pry-off (marked, not flagged) and never a year', async () => {
    const { el, saved } = await mount({ mode: 'empty', scan: session(unidentified()) });
    expect(control(el, 'acquiredOn')?.value).toBe('2026-03-05');
    expect(markOf(el, 'acquiredOn')).toBeNull();
    expect(control(el, 'material')?.value).toBe('steel');
    expect(control(el, 'closure')?.value).toBe('pry-off');
    expect(markOf(el, 'material')).toBe('default');
    expect(fieldEl(el, 'closure')?.classList.contains('field--default')).toBe(true);
    expect(el.querySelector('[data-hint-for="material"] .unsure-label')?.textContent).toBe(t('form.markDefault'));
    expect(control(el, 'year')?.value).toBe('');
    expect(control(el, 'type')?.value).toBe('');

    type(el, 'brand', 'Mahou');
    const body = await saved();
    expect(body).toMatchObject({
      brand: 'Mahou',
      acquiredOn: '2026-03-05',
      material: 'steel',
      closure: 'pry-off',
      status: 'complete',
    });
    expect(body).not.toHaveProperty('year');
    expect(body).not.toHaveProperty('type');
  });

  it('[T-app-194] manual entry: a producer "Cervecera X" guesses beer (marked); unchecked → needsReview, checked → complete', async () => {
    const first = await mount({ mode: 'empty', scan: session(unidentified()) });
    type(first.el, 'brand', 'Rosita');
    type(first.el, 'producer', 'Cervecera X');
    expect(control(first.el, 'type')?.value).toBe('beer');
    expect(markOf(first.el, 'type')).toBe('guessed');
    expect(fieldEl(first.el, 'type')?.classList.contains('field--guessed')).toBe(true);
    // The guess follows the text: without a brewery word it goes away again.
    type(first.el, 'producer', 'X');
    expect(control(first.el, 'type')?.value).toBe('');
    expect(markOf(first.el, 'type')).toBeNull();
    type(first.el, 'producer', 'Cervecera X');
    expect(await first.saved()).toMatchObject({ type: 'beer', status: 'needsReview' });

    // "Looks right" clears the mark: saved complete.
    const second = await mount({ mode: 'empty', scan: session(unidentified()) });
    type(second.el, 'brand', 'Rosita');
    type(second.el, 'producer', 'Cervecera X');
    second.el.querySelector<HTMLButtonElement>('[data-confirm="type"]')?.click();
    expect(markOf(second.el, 'type')).toBeNull();
    // A confirmed type is the user's: later text no longer changes it.
    type(second.el, 'description', 'Agua mineral');
    expect(control(second.el, 'type')?.value).toBe('beer');
    expect(await second.saved()).toMatchObject({ type: 'beer', status: 'complete' });

    // Changing the field also clears it.
    const third = await mount({ mode: 'empty', scan: session(unidentified()) });
    type(third.el, 'brand', 'Rosita');
    type(third.el, 'producer', 'Cervecera X');
    type(third.el, 'type', 'cider');
    expect(await third.saved()).toMatchObject({ type: 'cider', status: 'complete' });
  });

  it('[T-app-195] AI review: no type + a brewery description → beer guessed; unsure values unchecked → needsReview', async () => {
    const response: AnalyseResponse = {
      scanId: SCAN_ID,
      outcome: 'identified',
      // The AI left `type` empty (absent from `fields`).
      fields: { brand: 'Alhambra', description: 'Lager from a Granada brewery' },
      confidence: { brand: 0.95, description: 0.9, type: 0.3 },
      aiModel: 'haiku-vision',
      suggestions: [],
    };
    const { el, saved } = await mount({ mode: 'ai-prefilled', scan: session(response) });
    expect(control(el, 'type')?.value).toBe('beer');
    // The guess mark wins over the unsure highlight of the same field.
    expect(markOf(el, 'type')).toBe('guessed');
    expect(fieldEl(el, 'type')?.classList.contains('field--unsure')).toBe(false);
    expect(control(el, 'material')?.value).toBe('steel');
    // Empty unsure fields (variant, year…) have nothing to verify; only the guess flags the cap.
    expect(await saved()).toMatchObject({ type: 'beer', status: 'needsReview', material: 'steel' });

    // Unsure AI value with no guess: still `needsReview` until checked.
    const unsureCountry: AnalyseResponse = {
      scanId: SCAN_ID,
      outcome: 'identified',
      fields: { brand: 'Mahou', country: 'ES', type: 'beer' },
      confidence: { brand: 0.95, country: 0.4, type: 0.9 },
      aiModel: 'haiku-vision',
      suggestions: [],
    };
    const again = await mount({ mode: 'ai-prefilled', scan: session(unsureCountry) });
    expect(markOf(again.el, 'type')).toBeNull();
    again.el.querySelector<HTMLButtonElement>('[data-confirm="country"]')?.click();
    expect(again.el.querySelector('[data-hint-for="country"]')?.hasAttribute('hidden')).toBe(true);
    expect(await again.saved()).toMatchObject({ country: 'ES', status: 'complete' });
  });

  it('[T-app-196] edit mode: no defaults, no marks and no automatic status', async () => {
    const cap = Cap.parse(wireCap(5, { brand: 'Cervecera Rosita', status: 'complete' }));
    expect(cap.material).toBeUndefined();
    const { el, saved } = await mount({ mode: 'edit', cap });
    expect(control(el, 'material')?.value).toBe('');
    expect(control(el, 'closure')?.value).toBe('');
    expect(control(el, 'type')?.value).toBe(cap.type ?? '');
    expect(control(el, 'acquiredOn')?.value).toBe(cap.acquiredOn ?? '');
    expect(el.querySelectorAll('[data-mark], .field--default, .field--guessed')).toHaveLength(0);
    type(el, 'producer', 'Brewery Y');
    expect(markOf(el, 'type')).toBeNull();
    const patch = await saved();
    expect(patch).toEqual({ producer: 'Brewery Y', source: 'manual' });
  });
});
