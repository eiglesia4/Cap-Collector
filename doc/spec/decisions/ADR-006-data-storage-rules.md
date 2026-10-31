# ADR-006: Soft deletes, history, two photos per cap

- **Status:** Accepted
- **Date:** 2026-10-12 (confirms July 2025 design)

## Decision
- Tombstone soft deletes (needed for Phase 2 offline sync).
- Append-only history items per cap (`HIST#<ts>`).
- Up to two images per cap: `top` (required) and `underside` (optional), WebP ≤1024 px, presigned S3 PUT.
- Fields: brand*, variant, producer, country, type, material, closure, year, description, condition,
  acquiredWhere, acquiredOn, tags[], notes, quantity, forTrade, status, variantOf, location, dhash,
  aiConfidence, aiModel, source.
