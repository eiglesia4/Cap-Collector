# Conventions

## Language
- Documentation and code in **English**. UI copy in English first; Spanish localisation later (i18n keys from day one).

## Documents
- Markdown everywhere. One topic per file. File names `UPPER_SNAKE.md` for top-level docs, `kebab-case.md` inside `docs/`.
- Architecture decisions go in `docs/decisions/ADR-NNN-slug.md` using the template in `ADR-000-template.md`. Never edit a decided ADR; supersede it with a new one.
- Every spec starts with a **Status** line: `Draft | Agreed | Implemented | Superseded`.
- Dates in ISO `YYYY-MM-DD`.

## Domain vocabulary
| Term | Meaning |
|---|---|
| **Cap** | One record in the collection (a distinct cap design). Physical duplicates are `quantity` on the same cap. |
| **Variant** | A cap of the same brand but a different edition/design; linked via `variantOf`. |
| **Scan** | One capture attempt (photo + AI analysis + outcome). |
| **Exchange request** | A downloaded photo + JSON bundle meant for an external AI; its answer is uploaded back. |
| **Location** | Where the physical cap is: `album · sheet · pocket`, written `A·3·17`. |
| **Album / Box / Frame** | Kinds of physical storage. Only `album` has sheets and pockets. |
| **Insert card** | Printed square card, pocket-sized, placed under the cap in the album. |
| **Needs review** | Cap status when the AI or the user left the record incomplete. |

## Identifiers
- Cap id: ULID (`capId`). Never reuse. Soft-delete with tombstones.
- Location code: `<albumLetter>·<sheet>·<pocket>` — album A–Z, sheet 1-based, pocket 1-based, row-major (6 columns × 7 rows on GRANDE sheets).
- Deep link: `collectors://cap/<capId>`; web mirror `https://<domain>/cap/<capId>`.
- Image keys: `<uid>/<uploadId>/<side>.webp` (`uploadId` = fresh ULID, not the cap id); caps reference images by key only (CAP-20).
- `Cap.source` = how the record was born; `CapHistory.source` = who made each change (CAP-18).
- Exchange format id: `capcollector.exchange`, integer `version`; importer accepts every version ever emitted.

## Code (when it starts)
- App: TypeScript, Vite, Capacitor. Components in PascalCase, files in kebab-case.
- Infra: AWS CDK (TypeScript). Two stacks: `CollectorsData` (S3, DynamoDB) and `CollectorsApi` (Lambda, API Gateway, auth).
- API: Lambda (Node 20/22, TypeScript). One handler per route, shared `lib/`.
- Single-table DynamoDB. Key schema documented in `docs/specs/data-model.md`; never invent keys ad hoc.
- Images: WebP, max 1024 px long edge, uploaded via presigned S3 URLs. dHash computed client-side.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `infra:`).

## AWS tagging (mandatory)
Every taggable resource in every stack carries, applied once at the CDK app level (`Tags.of(app).add(...)`) so no construct can miss them:

| Tag | Value |
|---|---|
| `project` | `EIM_CAP` |
| `UserName` | `eiglesia4` |
| `installation` | `<installation>` (e.g. `naeva`) |
| `stage` | `<stage>` (e.g. `dev`) |

These four are a minimum, not a maximum: extra `cap:*` tags (e.g. `cap:config_version`, the `config/*.json` version a deployment was synthesised from) are welcome. A synth test asserts the four on the table and on every bucket. Cost Explorer filters on `project = EIM_CAP`.

## Deployment targets
| installation.stage | Region | AWS profile (local) | Deployed by |
|---|---|---|---|
| `naeva.dev` | `eu-west-1` | `naevatecdev` | Edu, by hand (`npm run diff` → `npm run deploy`), never an agent |

Region lives in `infra/config/<installation>.<stage>.json`; the profile and the account guard (`CAP_ACCOUNT_NAEVA_DEV`) live only in `.envrc.local` on Edu's machine. Nothing account-specific is ever committed.

## Cost rules
- Stay serverless; no NAT, no VPC, no always-on compute.
- AI (Bedrock) is called only after the local dHash check finds no near-match.
- The Exchange area is the free path: never store third-party AI API keys.
