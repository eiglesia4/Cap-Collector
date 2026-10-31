# ADR-003: Mandatory review step with three outcomes

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
Photo → record must never silently create wrong or duplicate data.

## Decision
Every scan ends in exactly one of three screens before anything is saved:
1. **AI review** — pre-filled form, low-confidence fields highlighted; user edits and saves.
2. **Already in collection** — side-by-side photos + field diff; user ticks which fields to copy
   into the existing record, declares a variant, or discards.
3. **Manual entry** — empty form with AI brand suggestions when identification failed.
Edit of an existing cap reuses the same form component (third mode).

## Consequences
- One form component, three modes: `ai-prefilled | empty | edit`.
- Every change to a record writes a history entry (who/what/when/source).
- Nothing in a stored record is overwritten without an explicit tick.
