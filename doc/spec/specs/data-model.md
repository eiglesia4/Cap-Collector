# Data model (DynamoDB single table)

**Status:** Agreed (2026-10-31, CAP-12) — keys are built only by `shared/src/keys.ts`; a key written any other way is a contract violation.

One table, on-demand capacity, PITR on, TTL attribute `ttl`. Attribute names: `pk`, `sk`, `gsi1pk`, `gsi1sk`, `gsi2pk`, `gsi2sk`, `ttl`.

## Items

| Entity | PK | SK | Notes |
|---|---|---|---|
| Cap | `USER#<uid>` | `CAP#<capId>` | all fields of `Cap` (ADR-006); tombstone = `deletedAt` present |
| Cap history | `CAP#<capId>` | `HIST#<ts>` | append-only; `ts` = ISO instant, newest last |
| Scan | `USER#<uid>` | `SCAN#<ts>#<scanId>` | outcome, dhash, threshold, aiCalled, model, tokens, cost |
| Exchange request | `USER#<uid>` | `EXCHANGE#<requestId>` | status waiting/answered/reviewed/expired; `ttl` = created + 30 d |
| Album | `USER#<uid>` | `ALBUM#<albumId>` | letter, name, kind, sheets, cols, rows, pocketMm, pitchMm |
| Wishlist item | `USER#<uid>` | `WISH#<id>` | V4 |

`uid` = Apple `sub` of the single allowed user. Listing a user's caps = `Query pk = USER#<uid>, begins_with(sk, 'CAP#')`; same prefix pattern for scans, exchange requests and albums.

## Indexes

| Index | PK | SK | Purpose | Projection |
|---|---|---|---|---|
| `GSI1` location | `LOC#<albumId>#<sheet>` | `POCKET#<nn>` (2-digit zero-padded) | sheet view in one query; `next-free` by walking sheets | keys + `capId`, `brand`, `variant`, `images`, `status`, `deletedAt` |
| `GSI2` brand | `BRAND#<normalisedBrand>` | `VAR#<normalisedVariant|_>#CAP#<capId>` | variants of a brand; name-based duplicate check (ADR-004 step 3) | same |

`normaliseBrand` = NFD, strip accents, lower-case, keep `[a-z0-9]` only (`"Estrella Galicia 1906"` → `estrellagalicia1906`). GSI attributes are written only for caps with a location (GSI1) and for every live cap (GSI2); a tombstoned cap has its GSI attributes removed so pockets free up.

## dHash comparison

Not an index: `Query pk = USER#<uid>, begins_with(sk,'CAP#')` with a projection of `capId, dhash, dhashUnderside` and compare in Lambda memory (a few thousand 64-bit values is trivial). Move to a prefix-bucketed GSI only past ~20k caps.

## Invariants enforced by the API

- One cap per pocket: writing a `location` of kind `album` is a transaction that conditionally puts a `LOCK#<albumId>#<sheet>#<pocket>` marker item (`pk = USER#<uid>`, `sk = LOCK#…`, `capId`) — conflict → 409. Moves and swaps update the markers in the same transaction.
- Every write to a cap appends a `HIST#` item in the same transaction.
- `forTrade ≤ quantity`; `variantOf ≠ capId` (also in the zod schema).

## Enums

Status: `complete | needsReview | unidentified`. Location kind: `album | box | frame`.
`source` on cap/history: `manual | import | bedrock:<modelId> | external:<provider>`.
Exchange status: `waiting | answered | reviewed | expired`. Scan outcome: `duplicate | identified | unidentified`.
