# ADR-010: WebP on WebKit, and a crop check before every single capture

- **Status:** Accepted
- **Date:** 2026-11-22

## Context
These problems came out of Edu's first real use (web on Safari, macOS 26, and the iPhone, 2026-11-22):

1. **WebKit cannot encode WebP from a canvas.** `canvas.toBlob(…, 'image/webp')` silently returns a PNG in Safari
   (macOS and iOS) and in WKWebView, so it fails in the Capacitor app as well. Every capture path ends in
   `WebpUnsupportedError`: single scan ("the photo can't be used"), manual entry ("This browser can't save WebP
   images…"), batch crops, re-identify and exchange. The tests run in happy-dom with a stub codec, so they never saw it.
   The contract stays as it is: images are WebP ≤ 1024 px (CONVENTIONS, `POST /uploads` `contentType: image/webp`).
2. **The single capture crops a centred square blindly.** The "circular guide" is a static drawing; neither the
   native camera nor a file picker shows it while shooting. A normal photo (cap at about a quarter of the frame, as
   in Edu's sample) is cropped to mostly background, so the dHash and the AI see cloth, not the cap.

## Decision
1. **WebP encoding has a fallback.** The codec first tries the canvas. If the blob that comes back is not
   `image/webp`, it encodes the same RGBA pixels with **libwebp compiled to WebAssembly** (`@jsquash/webp`, added to
   `app/` by the integrator). The fallback is lazy-loaded on first need, so Chrome and Firefox never download it.
   Quality steps stay as they are (0.85 → 0.7 → 0.55, `encodeWithin`). It runs on the device: no server, no new
   service, no contract change. `WebpUnsupportedError` remains only for "neither the canvas nor wasm worked".
2. **A crop check comes before every single capture** (camera, library or upload, on every platform):
   - the photo is shown with one circle placed by the CAP-82 detector (`detectCaps`): the most central confident
     circle, or a centred circle of 40 % of the short edge when nothing is found;
   - the user can move or resize it (the same interactions as Tray adjust), then taps **Use photo**;
   - the crop, dHash and upload are then exactly as in a batch crop (`cropCircle` from the full-resolution photo).
   The underside photo gets the same check.
3. **Cancel on Scan leaves the capture.** It goes back to where the user came from: Collection, or the album sheet
   for a pocket scan. Cancel on screens 3/4/5 still goes back to Scan.

## Consequences
- The capture works on Safari and in the iPhone app.
- The app bundle grows by about 300 KB of wasm, loaded only on WebKit. Capacitor serves it locally, and it caches on
  the web.
- Single and batch captures share one crop path, so their dHashes stay comparable (ADR-004).
- The single capture gets one extra tap (Use photo). It also gets a better crop, so the AI and the duplicate check
  see the cap.
- Real-browser coverage is still missing: the CI only runs happy-dom. We accept that for now. Device checks stay in
  Edu's checklist until a Playwright smoke test on WebKit is worth adding.
