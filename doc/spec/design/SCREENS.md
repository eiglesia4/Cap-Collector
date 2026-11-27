# Screens & navigation

**Status:** Proposed for discussion (2026-10-18)

Live, tappable mockups (Claude Design canvas): https://claude.ai/artifact/GRR9uys91J8RMkJzm3Ktqc

## Screen inventory
| # | Screen | Purpose |
|---|---|---|
| 1 | Collection (tab) | grid, search, filter chips, sort; recently added strip (only past 12 caps, unfiltered; a horizontal row of small thumbnails on a tinted band, visibly not part of the grid); the grid has its own heading "All · N" (CAP-115) |
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
  Retake / Cancel on 3/4/5 → Scan; Cancel on Scan → where the user came from (Collection, or the album sheet for a
  pocket scan; ADR-010 §3); Discard → Collection; Save → new cap's Detail.
- Single capture (ADR-010 §2): after the shot, pick or upload, a **crop check** shows the photo with one circle placed
  by the detector (drag / resize as in Tray adjust) → **Use photo** → underside? (same check) → analyse.
- "⋯" and sort menus close on a tap outside them or on Escape.
- Edit from Detail reuses the review form (mode `edit`).
- Album sheet: tap pocket → Detail; tap empty pocket → Scan pre-assigned to that pocket.
- Exchange: reached from Collection ⋯, from Review/Manual ("Export for external AI") and from
  Detail ⋯ ("Ask external AI"); "Continue to review" → screen 3 or 4 with `source = external:<provider>`.
- Batch mode (ADR-009, § Batch mode below): progress strip "4 of 11"; each cap goes through 3/4/5 in turn.
- Mac/web: identical bundle; Scan becomes "Upload photo"; Exchange gets a drag-and-drop zone;
  bulk edit and export live here.

## Language (CAP-95)
- Settings → **Language**: Español (default) · English. Applies immediately, without reloading the page or the app.

## Batch mode (ADR-009, decided 2026-11-21)
- **Entry:** Scan has a **Single · Batch** switch (remembered per device). On Mac/web it reads "Upload tray photo".
  Batch shows a one-line hint over the camera: "Plain dark background · caps face up · a finger's width apart · up to 30".
- **2b Tray adjust** (after the shot or pick): the photo fills the screen with one numbered circle per detected cap,
  in reading order (rows top → bottom, left → right). Uncertain detections are drawn dashed.
  - Tap a circle to select it. Selected: drag to move, corner handle or slider to resize, "Remove".
  - Tap an empty spot to add a circle there at the median size.
  - The header counts caps ("11 caps"). Buttons: **Retake** and **Start (11)**, plus a toggle
    "Propose next free pocket" (off by default: caps are saved without a location, for § Initial layout).
  - Zero caps found → "No caps found. Use a plain, dark background and spread them out", with Retake and Add by hand.
- **Batch run:** screens 3/4/5 as in a single capture, with a strip on top: "4 of 11", a thumbnail row (done ✓,
  current, waiting, skipped), and **Skip** (keep for later) and **Stop**. After Save/Update/Discard the next cap
  opens directly; Detail is not shown in between.
- **Resume:** while a batch is unfinished, Scan and Collection show a banner "Batch: 4 of 11 — Continue · Abandon".
  Abandon asks for confirmation; saved caps stay saved.
- **Summary** at the end: added n · already in collection n (updated / discarded) · manual n · skipped n
  (with "Review skipped"), plus a button **Plan albums** (§ Initial layout) when there are caps without a location.

## Visual system (proposal)
- Ground `#FAFAF7`, ink `#1B1A17`, accent copper `#B8651B`, muted `#5C5A55`, line `#DEDBD2`.
- Display: Space Grotesk 700; body: DM Sans. Caps always drawn as circles; pockets as dark squares.
- Touch targets ≥ 44 px; primary action is a full-width dark button at the bottom.
