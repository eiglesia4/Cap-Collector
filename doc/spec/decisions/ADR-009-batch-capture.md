# ADR-009: Batch capture — tray photo segmented on the device, then one scan per cap

- **Status:** Accepted
- **Date:** 2026-11-21

## Context
The first load is 200+ caps (physical-link.md § Initial layout). One photo per cap works, but it is slow: shoot,
crop and wait for the AI before you can take the next one. ADR-008 left batch mode (tray photo → N caps) for V4
because segmentation is the riskiest vision work in the app. V0–V3 are done, so batch mode can be built now.

Forces:
- ADR-004 is not negotiable: the dHash check comes before the AI, **per cap**. A tray must not become one AI call
  that bypasses the duplicate check.
- Cost (CONVENTIONS): no extra AI calls just to find the caps; no new services; ≈ 2–5 €/month.
- No contract change. `POST /scans/analyse` is already one cap per call.
- Crown caps are near-identical circles (Ø ≈ 26–32 mm). On a plain background of contrasting colour, simple
  classical image processing finds them reliably. We control the photo: the app tells the user how to lay the caps out.

## Decision
1. **Segmentation runs on the device**, in pure TypeScript over RGBA pixels (like `dhash.ts`). It uses no AI, no
   server and no new dependency (no OpenCV/wasm). It works on a downscaled copy (long edge ≤ 1600 px). Crops come
   from the full-resolution photo.
2. **The user confirms the circles** before anything is uploaded. They can remove, add, move or resize a circle.
   Detection only has to be good, not perfect. The tray photo itself is never uploaded or stored.
3. **Each confirmed circle becomes an ordinary scan.** It gets the same crop → dHash → upload → `POST /scans/analyse`
   → AI review / Already in collection / Manual entry as a single capture (ADR-003). The batch is client-side
   orchestration only.
4. **Prefetch with an intra-batch guard.** While the user reviews cap *k*, the app analyses up to the next 2. A cap
   is not analysed early if its dHash is within the guard distance of an **earlier, unresolved** cap of the same batch.
   The server can't see that cap yet, so analysing early would cost an AI call and miss "Already in collection". The
   cap waits until the earlier one is saved or discarded. The guard is a client constant (12), wider than the server's
   default threshold (10) on purpose: a false hold only costs a little waiting.
5. **The batch queue lives on the device and is resumable.** The crops and per-cap state are kept locally until the
   batch ends. Closing the app and coming back continues at the same cap.

## Consequences
- AI cost per cap is unchanged. A tray of 20 costs at most 20 Haiku calls, and fewer when there are duplicates.
- The riskiest part (segmentation) is a pure, testable module with synthetic-image tests (`T-vision-*`), and the
  manual adjust step covers its misses. If real trays show it is not good enough, a server- or AI-side segmenter
  would need a new ADR. It would also break rule 1 of the cost model, so it is not planned.
- Underside photos are not prompted in batch mode. Review keeps its "underside photo" action, and re-identify works
  from Detail.
- Batch saves place caps **without a location** by default, ready for § Initial layout. "Propose next free pocket" is
  an opt-in toggle per batch.
- The exchange bundle's multi-cap request (exchange.md § Batch) is a separate feature and stays out of this scope.
