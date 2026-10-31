# doc/spec — frozen copy of the specification

Live source: OneDrive `MisProyectosOneDrive/CapCollector/docs/` (`$CAP_DOCS`), plus `CapCollector/CONVENTIONS.md`.
It is copied here **only at milestones**, byte for byte (never reformatted), and this table records when. Agents read
this folder; if `$CAP_DOCS` has a newer version, they note it in the Jira comment before using it.

Refresh procedure (method.md § Refreshing the frozen copy) — the *contents* of `docs/`, never the folder itself:

```bash
rsync -a --delete --exclude README.md --exclude openapi.yaml "$CAP_DOCS/docs/" doc/spec/
cp "$CAP_DOCS/CONVENTIONS.md" doc/spec/CONVENTIONS.md
```

`README.md` (this file) and `openapi.yaml` live only in the repo: they are the architect's contract outputs, published by PR.

**Copied: 2026-10-31** (CAP-11, V0 skeleton) · **refreshed 2026-10-31** (CAP-12: data-model Agreed, ADR-008, openapi v0.1).

| Document | Status at copy | Code release |
|---|---|---|
| `method.md` | Agreed 2026-10-31 | V0 |
| `CONVENTIONS.md` (from the OneDrive root) | — | V0 |
| `jira-epics.md` | Draft | V0 |
| `specs/features.md` | Agreed 2026-10-18 | V0 |
| `specs/exchange.md` | Agreed 2026-10-18 | V0 |
| `specs/physical-link.md` | Agreed 2026-10-12 | V0 |
| `specs/data-model.md` | **Agreed 2026-10-31** (CAP-12) | V0 |
| `design/SCREENS.md` | Proposed 2026-10-18 | V0 |
| `decisions/ADR-000…008` | ADR-001…008 Accepted | V0 |
| `openapi.yaml` | v0.1.0 (CAP-12, repo-only) | V0 |

## Contracts (owned by the architect, `OWNERSHIP.md`)

Published in CAP-12 as **contracts v0.1** (`CONTRACTS_VERSION` in `shared/src/index.ts`):

- `shared/src/schemas/*.ts` — zod schemas + inferred types: enums, Location (+ code parser), Cap / CapInput / CapPatch / CapHistory, Scan / AnalyseRequest / AnalyseResponse, Album / SheetView / NextFree, Exchange v1 (`parseExchangeUpload`, `normaliseResponseFields`).
- `shared/src/keys.ts` — the only place DynamoDB keys are built (PK/SK, GSI1 location, GSI2 brand, LOCK markers, TTL).
- `doc/spec/openapi.yaml` v0.1.0 — the HTTP API; bodies reference the zod schemas, which are authoritative.
- `specs/data-model.md` — Agreed.
