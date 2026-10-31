# ADR-005: Physical location as album · sheet · pocket, with insert cards

- **Status:** Accepted
- **Date:** 2026-10-12

## Context
Caps live in a Leuchtturm GRANDE binder with ENCAP sheets for champagne plaques: 42 square
pockets per sheet (6 × 7), black interleaf, ~10 sheets per binder. Pockets are square, caps round,
so the pocket corners are visible around the cap. Pocket size not yet measured (champagne-plaque
sheets may be tight for 32 mm crown caps; Leuchtturm sells crown-cap ENCAP sheets for the same binder).

## Decision
- `location = { kind: album|box|frame, album, sheet?, pocket? }`; code rendered `A·3·17`.
- One cap per pocket; moves and swaps write history. Deleting a cap frees its pocket.
- App shows a **Sheet view** mirroring the physical sheet; empty pockets start a scan pre-assigned.
- On save the app proposes the next free pocket.
- Printable **insert cards**, exactly pocket-sized: code + year top corners, brand + country bottom
  corners (visible around the cap); back side carries the full record and a QR deep link.
  PDF generated client-side (`pdf-lib`), with a 20 mm calibration square on page 1.
- Phase 2: "Sheet photo check" — photograph a sheet, dHash per cell vs expected cap, flag mismatches.

## Consequences
- Pocket pitch and size are user settings; template scales from them.
- GSI on `album#sheet` for "show me sheet 3" in one query.
- Trade stock goes in `box` locations (coin flips / tackle box) without sheet/pocket.
