# Data model (DynamoDB single table)

**Status:** Draft — key schema to be finalised before coding

| Entity | PK | SK | Notes |
|---|---|---|---|
| Cap | `USER#<uid>` | `CAP#<capId>` | all cap fields (ADR-006) |
| Cap history | `CAP#<capId>` | `HIST#<ts>` | append-only |
| Scan | `USER#<uid>` | `SCAN#<ts>#<scanId>` | outcome, dhash, aiModel, confidence, cost |
| Exchange request | `USER#<uid>` | `EXCHANGE#<requestId>` | status waiting/answered/reviewed/expired, capIds, TTL 30 d |
| Album | `USER#<uid>` | `ALBUM#<albumId>` | name, kind, sheets, pocketMm, pitchMm, cols, rows |
| Wishlist item | `USER#<uid>` | `WISH#<id>` | phase 2 |

GSIs
- `GSI1` location: PK `LOC#<albumId>#<sheet>`, SK `POCKET#<nn>` → sheet view in one query.
- `GSI2` brand: PK `BRAND#<normalisedBrand>`, SK `CAP#<capId>` → variants + name-based duplicate check.
- dHash comparison: scan all caps' `dhash` (projected attribute) in Lambda memory; move to a
  prefix-bucketed GSI only if the collection passes ~20k caps.

Status enum: `complete | needsReview | unidentified`. Location kind: `album | box | frame`.
`source` enum on cap/history: `manual | bedrock:<model> | external:<provider> | import`.
