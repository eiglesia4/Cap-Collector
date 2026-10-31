# Features

**Status:** Agreed (2026-10-18)

## Phase 1 — must have
- Collection grid: search (brand, producer, country, year, tags, location code), filter chips
  (type, country, status, tag), sort (A–Z, newest, country, year).
- Capture flow: Scan → analyse → one of three outcomes (ADR-003) → Detail.
- Manual entry with brand autocomplete from own collection + AI brand suggestions.
- Cap detail: photos (top/underside), fields, quantity/forTrade, variants carousel, history,
  location ("Where is it?" with mini-grid), edit, soft delete, share.
- Album → Sheet view: 6 × 7 grid mirroring the sheet, tap pocket → cap, empty pocket → scan
  pre-assigned, move/swap pockets, propose next free pocket on save.
- Print insert cards (A4 PDF): this sheet / since last print / whole album; calibration square.
- Exchange area: download request bundle (photo + JSON) for an external AI, upload the answer →
  review; pending requests; backup export/import (see exchange.md, ADR-007).
- Settings: album definitions (name, sheets, pocket size & pitch), AI on/off.

## Phase 2 — worth it
- Batch mode: tray photo → segmented caps → each through the review flow with "4 of 11" progress.
- Wishlist tab (+ warning in scan flow when a scanned cap is on the wishlist).
- Trade list (`forTrade > 0`) exportable as a shareable page/PDF.
- Stats tab: by country, brand, decade, additions per month, album occupancy.
- Offline capture queue + sync (tombstones already in place).
- Re-identify button on `needsReview` caps (optionally with underside photo).
- Sheet photo check (audit physical vs virtual).
- QR scan from insert card → cap deep link.

## Out of scope (for now)
Social features, multi-user, iCloud sync, Android.
