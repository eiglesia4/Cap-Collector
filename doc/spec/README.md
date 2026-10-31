# doc/spec — frozen copy of the specification

Live source: OneDrive `MisProyectosOneDrive/CapCollector/docs/` (`$CAP_DOCS`), plus `CapCollector/CONVENTIONS.md`.
It is copied here **only at milestones**, byte for byte (never reformatted), and this table records when. Agents read
this folder; if `$CAP_DOCS` has a newer version, they note it in the Jira comment before using it.

**Copied: 2026-10-31** (CAP-11, V0 skeleton).

| Document | Status at copy | Code release |
|---|---|---|
| `method.md` | Agreed 2026-10-31 | V0 |
| `CONVENTIONS.md` (from the OneDrive root) | — | V0 |
| `jira-epics.md` | Draft | V0 |
| `specs/features.md` | Agreed 2026-10-18 | V0 |
| `specs/exchange.md` | Agreed 2026-10-18 | V0 |
| `specs/physical-link.md` | Agreed 2026-10-12 | V0 |
| `specs/data-model.md` | Draft — key schema to be finalised before coding | V0 |
| `design/SCREENS.md` | Proposed 2026-10-18 | V0 |
| `decisions/ADR-000…007` | ADR-001…007 Accepted | V0 |

## Contracts (owned by the architect, `OWNERSHIP.md`)

Not yet published; they arrive with the EP-01 contracts story:

- `shared/src/**` — zod schemas + TS types: Cap, Location, Exchange v1.
- `doc/spec/openapi.yaml` — the HTTP API.
- DynamoDB key schema — final version of `specs/data-model.md`.
