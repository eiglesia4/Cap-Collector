# Physical ↔ virtual link

**Status:** Agreed (2026-10-12) — see ADR-005

## The album
Leuchtturm GRANDE binder (ref. 324238 kit) with ENCAP sheets for champagne plaques:
42 pockets per sheet in a 6 × 7 grid, black interleaf, ~10 sheets (~420 caps) per binder.
**TODO:** measure pocket inner size and pitch (mm) and record them in app Settings.
If 32 mm crown caps are tight, switch to Leuchtturm crown-cap (Kronkorken) ENCAP sheets — same binder.

## Location code
`A·3·17` = album A, sheet 3, pocket 17 (row-major: row 3, column 5). Searchable in the app.

## Insert cards (A4)
- One card per pocket, exactly pocket-sized; cap sits on top; corners stay visible.
- Front: code + year (top corners), brand + country ISO code (bottom corners), faint circle guide.
- Back (second pass through the printer): full record + QR (`collectors://cap/<id>`).
- Page 1 carries a 20 mm calibration square; print at 100 %, 160 g paper, cut on grey lines.
- Scopes: this sheet · caps added since last print · whole album.
- Alternative without cutting: 9 mm label-printer tape (code + brand) stuck on the sheet frame.

## Keeping them in sync
- Save proposes next free pocket; moves/swaps are explicit actions with history.
- Phase 2 "Sheet photo check": photograph the sheet, dHash per cell vs expected → mismatch list.

## Storage hints beyond the album
- Lindner / SAFE crown-cap pages: equivalent, often cheaper per pocket.
- Foam-board display frames: good on a wall, number the holes if used.
- Trade stock: coin flips (2×2) in a box or tackle boxes → `box` locations, no sheet/pocket.
