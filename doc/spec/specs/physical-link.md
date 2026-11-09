# Physical ↔ virtual link

**Status:** Agreed (2026-10-12) — see ADR-005 · **amended 2026-11-09** (album geometry measured; insert cards → discs + sheet index; CAP-54)

## The album
Leuchtturm GRANDE binder with COMPART crown-cap sheets: 42 **round** pockets per sheet in a 6 × 7 grid
(6 columns × 7 rows, portrait), black interleaf, ~10 sheets (~420 caps) per binder.
Measured by Edu (2026-11-09, from photos; calliper check pending): pocket inner Ø ≈ 33 mm, centre-to-centre pitch
≈ 36 mm. Stored per album as `pocketMm` / `pitchMm` (asked for before the first print; suggestion 33 / 36).
A 32 mm crown cap fills the pocket: nothing placed under it is readable while the cap is in place.

## Location code
`A·3·17` = album A, sheet 3, pocket 17 (row-major: row 3, column 5). Searchable in the app.

## Insert discs (A4)
A pocket-sized card would be hidden by the cap, so the insert is a **disc read by lifting the cap**; identification
at a glance moves to the app's sheet view and the printed sheet index (below).
- One disc per pocket, Ø = `pocketMm − 3` (30 mm for a 33 mm pocket), so it sits flat under the cap.
- Laid out densely on A4 with 3 mm gutters; a grey cut circle per disc is the guide for a 30 mm circle punch.
- Front: code `A·3·17` large (top half), brand + country ISO code (bottom half), year small.
- Back (duplex, long-edge flip; or print odd pages then even pages by hand): brand · variant, producer,
  type · material, acquired on, 12 mm QR `collectors://cap/<id>`. Back pages mirror the column order.
- Page 1 carries a 20 mm calibration square ("20 mm — print at 100 %"); 160 g paper.
- Scopes: this sheet · caps changed since last print (per-album timestamp, set by "mark as printed") · whole album.
- Alternative without cutting: 9 mm label-printer tape (code + brand) stuck on the sheet frame.

## Sheet index
One A4 **portrait** page per sheet, kept in the binder's front pocket: the `cols × rows` grid in the physical
sheet's orientation, each cell with pocket number, code, brand and year; empty cells blank; header
`Album A · Sheet 3 · printed <date>`. A full sheet at the real pitch (216 × 252 mm for 6 × 7 at 36 mm) does not fit
A4 at 1 : 1, so the grid is drawn as large as fits inside 10 mm margins (≈ 88 % for 36 mm), proportions kept,
and the page prints its scale ("scale 88 %"). Can be printed with the discs (same PDF, after them) or alone.

## Keeping them in sync
- Save proposes next free pocket; moves/swaps are explicit actions with history.
- Phase 2 "Sheet photo check": photograph the sheet, dHash per cell vs expected → mismatch list.

## Storage hints beyond the album
- Lindner / SAFE crown-cap pages: equivalent, often cheaper per pocket.
- Foam-board display frames: good on a wall, number the holes if used.
- Trade stock: coin flips (2×2) in a box or tackle boxes → `box` locations, no sheet/pocket.
