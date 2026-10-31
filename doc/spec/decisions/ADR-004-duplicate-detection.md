# ADR-004: Two-stage duplicate detection, hash first, AI second

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
Duplicates are the main data-quality risk and AI calls are the main variable cost.

## Decision
1. Client computes a 64-bit dHash of the cropped cap before upload and sends it with the request.
2. Lambda compares against all stored hashes (in-memory scan; thousands of hashes is trivial).
   Hamming distance ≤ threshold (start at 10, tune) → "Already in collection" outcome, no AI call.
3. Otherwise call Bedrock vision; after identification run a second check on normalised
   `brand + variant` to catch same cap / different lighting.

## Consequences
- AI is called only for caps that are new by image.
- Store `dhash`, `aiConfidence`, `aiModel` on each cap so low-confidence caps can be re-identified later.
- Underside photo optional; when present, hash it too (helps year/manufacturer).
