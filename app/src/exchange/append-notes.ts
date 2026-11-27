// Appending an external AI's notes to a stored cap's notes (CAP-114; exchange.md § Flow: answer notes and ignored
// values go to notes, never dropped silently). The edit form offers them as a tickable suggestion; ticked, they are
// appended under a `<source> (<date>):` header, after a blank line, within the cap's `notes` limit.
import { CapOwnership } from '@capcollector/shared';

/** The cap's `notes` limit, read from the shared schema (`shared/src/schemas/cap.ts`). */
export const NOTES_MAX = CapOwnership.shape.notes.unwrap().maxLength ?? 2000;

const ELLIPSIS = '…';

export interface AppendedNotes {
  /** The cap's notes with the addition appended (the existing notes untouched). */
  readonly text: string;
  /** The addition was cut (with "…") to fit `max`. */
  readonly truncated: boolean;
}

/**
 * `existing` + blank line + `<header>` line + `addition`, trimmed like the schema does. When the result would pass
 * `max`, only the addition is cut and ends with "…". `null` when not even the header and "…" fit.
 */
export function appendNotes(existing: string, addition: string, header: string, max = NOTES_MAX): AppendedNotes | null {
  const before = existing.trim();
  const added = addition.trim();
  const prefix = `${before === '' ? '' : `${before}\n\n`}${header}\n`;
  const room = max - prefix.length;
  if (added.length <= room) return { text: prefix + added, truncated: false };
  if (room <= ELLIPSIS.length) return null;
  let cut = added.slice(0, room - ELLIPSIS.length);
  // Never leave half of a surrogate pair before the ellipsis.
  if (/[\uD800-\uDBFF]$/.test(cut)) cut = cut.slice(0, -1);
  return { text: `${prefix}${cut.trimEnd()}${ELLIPSIS}`, truncated: true };
}

/** The header line of an appended block, e.g. `external:anthropic (2026-11-27):`. */
export function notesHeader(source: string, date: string): string {
  return `${source} (${date}):`;
}
