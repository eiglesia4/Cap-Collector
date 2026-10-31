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
- Exchange format id: `capcollector.exchange`, integer `version`; importer accepts every version ever emitted.

## Code (when it starts)
- App: TypeScript, Vite, Capacitor. Components in PascalCase, files in kebab-case.
- Infra: AWS CDK (TypeScript). Two stacks: `CollectorsData` (S3, DynamoDB) and `CollectorsApi` (Lambda, API Gateway, auth).
- API: Lambda (Node 20/22, TypeScript). One handler per route, shared `lib/`.
- Single-table DynamoDB. Key schema documented in `docs/specs/data-model.md`; never invent keys ad hoc.
- Images: WebP, max 1024 px long edge, uploaded via presigned S3 URLs. dHash computed client-side.
- Commits: Conventional Commits (`feat:`, `fix:`, `docs:`, `infra:`).

## Cost rules
- Stay serverless; no NAT, no VPC, no always-on compute.
- AI (Bedrock) is called only after the local dHash check finds no near-match.
- The Exchange area is the free path: never store third-party AI API keys.
