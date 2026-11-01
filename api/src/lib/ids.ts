// Identifiers: every entity id is a ULID that is never reused (CONVENTIONS.md § Identifiers, CLAUDE.md invariants).
import { monotonicFactory } from 'ulid';

const factory = monotonicFactory();

/** A new ULID; monotonic within one Lambda instance so ids minted in the same millisecond still sort. */
export function newId(): string {
  return factory();
}
