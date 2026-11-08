// Brand matching shared by the detail's "Same brand" carousel (CAP-24) and the form's brand autocomplete (CAP-25):
// case-, accent- and space-insensitive, like the API's normalised `BRAND#` key (data-model.md).

export function normaliseBrand(s: string): string {
  return s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** True when `a` and `b` name the same brand. */
export function sameBrand(a: string, b: string): boolean {
  return normaliseBrand(a) === normaliseBrand(b);
}

/**
 * Distinct brands of `caps` that contain what was typed, those starting with it first, at most `max`; the typed
 * brand itself is left out (nothing to complete).
 */
export function brandSuggestions(typed: string, caps: readonly { brand: string }[], max = 6): string[] {
  const q = normaliseBrand(typed);
  if (q === '') return [];
  const seen = new Set<string>([q]);
  const starts: string[] = [];
  const contains: string[] = [];
  for (const { brand } of caps) {
    const n = normaliseBrand(brand);
    if (seen.has(n) || !n.includes(q)) continue;
    seen.add(n);
    (n.startsWith(q) ? starts : contains).push(brand);
  }
  return [...starts, ...contains].slice(0, max);
}
