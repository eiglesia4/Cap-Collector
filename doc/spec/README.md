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

**Copied: 2026-10-31** (CAP-11, V0 skeleton) · **refreshed 2026-10-31** (CAP-12: data-model Agreed, ADR-008, openapi v0.1) · **refreshed 2026-11-02** (CAP-26: contracts v0.2 — method.md § Refreshing, CONVENTIONS.md tagging/deploy/image-key/source rules, data-model.md REFRESH#/LOCK#/albumId) · **amended in repo 2026-11-09** (CAP-54 review: physical-link.md album geometry, insert discs, sheet index — written here first because the OneDrive copy was not readable; the architect copies it back to `$CAP_DOCS`).

| Document | Status at copy | Code release |
|---|---|---|
| `method.md` | Agreed 2026-10-31 (+ § Refreshing 2026-10-31) | V0 |
| `CONVENTIONS.md` (from the OneDrive root) | — | V0 |
| `jira-epics.md` | Draft | V0 |
| `specs/features.md` | Agreed 2026-10-18 | V0 |
| `specs/exchange.md` | Agreed 2026-10-18 | V0 |
| `specs/physical-link.md` | Agreed 2026-10-12, amended 2026-11-09 (discs + sheet index) | V0 / V3 |
| `specs/data-model.md` | **Agreed 2026-10-31** (CAP-12), v0.2 additions 2026-11-02 | V0–V1 |
| `design/SCREENS.md` | Proposed 2026-10-18 | V0 |
| `decisions/ADR-000…008` | ADR-001…008 Accepted | V0 |
| `openapi.yaml` | v0.2.0 (CAP-26, repo-only) | V1 |

## Contracts (owned by the architect, `OWNERSHIP.md`)

Published in CAP-12 as **contracts v0.1**, bumped to **v0.2** in CAP-26 (`CONTRACTS_VERSION` in `shared/src/index.ts`):

- `shared/src/schemas/*.ts` — zod schemas + inferred types: enums, Location (+ code parser), Cap / CapInput / CapPatch / CapHistory, Scan / AnalyseRequest / AnalyseResponse, Album / SheetView / NextFree, Exchange v1 (`parseExchangeUpload`, `normaliseResponseFields`).
- `shared/src/keys.ts` — the only place DynamoDB keys are built (PK/SK, GSI1 location, GSI2 brand, LOCK markers, REFRESH# tokens, TTL).
- `shared/src/routes.ts` — the single route manifest (method, path, auth, handler); infra and api import it.
- `shared/src/schemas/http.ts` — Problem, Healthz, Session, AppleSignInRequest, RefreshRequest, UploadRequest/Response.
- `doc/spec/openapi.yaml` v0.2.0 — the HTTP API; bodies reference the zod schemas, which are authoritative.
- `specs/data-model.md` — Agreed.
