# Screens & navigation

**Status:** Proposed for discussion (2026-10-18)

Live, tappable mockups (Claude Design canvas): https://claude.ai/artifact/GRR9uys91J8RMkJzm3Ktqc

## Screen inventory
| # | Screen | Purpose |
|---|---|---|
| 1 | Collection (tab) | grid, search, filter chips, sort; recently added strip |
| 2 | Scan (tab, full-screen) | camera with circular guide; single / batch; library; "Enter manually" |
| 3 | AI review | pre-filled form, unsure fields highlighted; save / underside photo / ask again |
| 4 | Already in collection | warning, side-by-side photos, opt-in field diff; update / variant / discard |
| 5 | Manual entry | empty form, AI brand suggestions, "save flagged needs review" |
| 6 | Cap detail | photos, chips, quantity/forTrade, fields, variants, history, location |
| 7 | Album sheet | 6 × 7 grid mirroring the physical sheet; move / swap / sheet photo check; print |
| 8 | A4 pocket inserts | print template with calibration square and reverse-side sample |
| 9 | Exchange | download request bundle (photo + JSON) for an external AI, upload its answer, pending list, backup export/import |
| — | Wishlist, Stats, Settings | phase 2 / simple lists |

## Navigation logic
- Bottom tab bar: **Collection · Scan · Wishlist · Stats** (Albums, Exchange and Settings behind "⋯" on Collection).
- Capture flow (2 → 3/4/5 → 6) runs as a full-screen modal over the tabs.
  Retake / Cancel → Scan; Discard → Collection; Save → new cap's Detail.
- Edit from Detail reuses the review form (mode `edit`).
- Album sheet: tap pocket → Detail; tap empty pocket → Scan pre-assigned to that pocket.
- Exchange: reached from Collection ⋯, from Review/Manual ("Export for external AI") and from
  Detail ⋯ ("Ask external AI"); "Continue to review" → screen 3 or 4 with `source = external:<provider>`.
- Batch mode: progress strip "4 of 11"; each cap goes through 3/4/5 in turn.
- Mac/web: identical bundle; Scan becomes "Upload photo"; Exchange gets a drag-and-drop zone;
  bulk edit and export live here.

## Visual system (proposal)
- Ground `#FAFAF7`, ink `#1B1A17`, accent copper `#B8651B`, muted `#5C5A55`, line `#DEDBD2`.
- Display: Space Grotesk 700; body: DM Sans. Caps always drawn as circles; pockets as dark squares.
- Touch targets ≥ 44 px; primary action is a full-width dark button at the bottom.
