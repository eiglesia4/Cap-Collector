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

## Defaults when unsure (decided with Edu, 2026-11-23, CAP-95)
Fill rather than leave blank, but show what is a guess:
- **AI:** best guess with a low confidence instead of null (`exchangeInstructions`): `type` inferred from the
  producer/brand/text (a brewery → beer), crown caps steel + pry-off unless the photo says otherwise; `year` stays null
  unless printed or clearly dated. Fields below the confidence threshold are highlighted as unsure (as today).
- **Form, new cap (AI review, Manual entry, batch):**
  - `acquiredOn` = today when empty, editable, not flagged.
  - `material` = steel and `closure` = pry-off when empty, marked "default — check", not flagged on their own.
  - Manual entry with no AI: `type` pre-selected from the brand/producer/description text when it names a brewery
    (cervecera, brewery, brauerei, brasserie, birra…) → beer, cider maker → cider, winery/bodega → wine; marked
    "guessed — check".
  - `year` is never defaulted (today's year would be wrong data).
- **Status:** a new cap saved while an AI-unsure or text-guessed field is still untouched is saved as `needsReview`
  ("to verify"); touching or confirming the field clears its mark. Defaults for `acquiredOn`, `material` and
  `closure` alone don't make a cap `needsReview`.

## Phase 2 — worth it
- Batch mode (ADR-009, SCREENS.md § Batch mode): tray photo → caps segmented on the device → user adjusts the circles →
  each cap is a normal scan (dHash before AI, three outcomes) with "4 of 11" progress, prefetch of the next 2,
  resume after closing the app, and a summary that leads to § Initial layout. Built 2026-11 for the first load.
- Wishlist tab (+ warning in scan flow when a scanned cap is on the wishlist).
- Trade list (`forTrade > 0`) exportable as a shareable page/PDF.
- Stats tab: by country, brand, decade, additions per month, album occupancy.
- Offline capture queue + sync (tombstones already in place).
- Re-identify button on `needsReview` caps (optionally with underside photo).
- Sheet photo check (audit physical vs virtual).
- QR scan from insert card → cap deep link.

## Out of scope (for now)
Social features, multi-user, iCloud sync, Android.
