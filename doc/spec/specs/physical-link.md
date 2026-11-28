# Physical ↔ virtual link

**Status:** Agreed (2026-10-12) — see ADR-005 · **amended 2026-11-09** (album geometry measured; insert cards → discs + sheet index; CAP-54)

## The album
Leuchtturm GRANDE binder with COMPART crown-cap sheets: 42 **round** pockets per sheet in a 6 × 7 grid
(6 columns × 7 rows, portrait), black interleaf, ~10 sheets (~420 caps) per binder.
Measured by the owner (2026-11-09, from photos; calliper check pending): pocket inner Ø ≈ 33 mm, centre-to-centre pitch
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

## Inside labels (Ø 25 mm, decided 2026-11-28)
A small paper disc **cut out and placed inside the cap**, so the cap carries its own identity once it is taken out of
the album. It is single-sided and printed from the same Print screen, with the same scopes as the discs.
- **Size:** Ø **25 mm** (a common 25 mm / 1" circle punch), with a grey cut circle. The text stays inside a 21 mm
  circle, 2 mm inside the cut line, so a slightly off cut never clips it.
- **Content**, centred, in the UI language. Four lines, all optional except the brand:
  1. type: small capitals, e.g. "CERVEZA";
  2. brand: bold, the largest size that fits, at most 2 lines;
  3. variant: 1 line, smaller;
  4. country: the localised country name, or the ISO code when the name doesn't fit.
- **Text fitting:** the minimum size is 5 pt, and anything longer still ends in "…". Nothing else is printed: no
  album code (a cap can move pockets, so a printed code would go stale), no QR and no year.
- **Matching labels to caps:**
  - When the album's grid fits A4 at a 28 mm pitch (25 mm + 3 mm gutter, inside 10 mm margins; 6 × 7 fits at
    168 × 196 mm), the labels are laid out as **one page per sheet**, mirroring the sheet's `cols × rows`. A pocket
    out of scope, or an empty one, is left blank. The page header reads "Album A · Sheet 3 · inside labels". The owner
    finds each label at its pocket's position.
  - When the grid doesn't fit, the labels flow densely in pocket order, and each one adds the pocket number in 5 pt
    at the bottom edge.
- **Paper:** plain 80–120 g, single-sided, at **100 %**. The calibration square is on page 1 when the labels are
  printed without the discs.

## Sheet index
One A4 **portrait** page per sheet, kept in the binder's front pocket: the `cols × rows` grid in the physical
sheet's orientation, each cell with pocket number, code, brand and year; empty cells blank; header
`Album A · Sheet 3 · printed <date>`. A full sheet at the real pitch (216 × 252 mm for 6 × 7 at 36 mm) does not fit
A4 at 1 : 1, so the grid is drawn as large as fits inside 10 mm margins (≈ 88 % for 36 mm), proportions kept,
and the page prints its scale ("scale 88 %"). Can be printed with the discs (same PDF, after them) or alone.

## Initial layout (bulk placement)
Decided with the owner on 2026-11-21 (CAP-75). For a first load (hundreds of caps scanned **without a location**), the app plans the physical albums afterwards instead of placing caps one by one.
- Input: every cap with no location (or a filtered subset), and the albums chosen to fill, in order (e.g. `A`, then `B`).
- Order: **type → country → brand** (then variant, then year; ties by `capId`). Unknown values go last within their level.
- Gaps: a new **type** starts on a new sheet; a new **country** starts on a new row (the previous country's row is left partly empty for later additions). Brands within a country follow on without gaps.
- The plan is a preview (sheet by sheet, the same grid as the sheet view) with totals: pockets used, gaps left, sheets needed per album. If capacity runs out, it says how many more sheets or which next album letter is needed, and places nothing.
- Applying writes each location with the existing location API (one change per cap, history `source = manual`, reason "initial layout"). It is resumable: caps already placed are skipped on a re-run.
- Then: print discs + sheet index for the planned sheets (§ Insert discs, § Sheet index) and fill the binder sheet by sheet.

## Keeping them in sync
- Save proposes next free pocket; moves/swaps are explicit actions with history.
- Phase 2 "Sheet photo check": photograph the sheet, dHash per cell vs expected → mismatch list.

## Storage hints beyond the album
- Lindner / SAFE crown-cap pages: equivalent, often cheaper per pocket.
- Foam-board display frames: good on a wall, number the holes if used.
- Trade stock: coin flips (2×2) in a box or tackle boxes → `box` locations, no sheet/pocket.
