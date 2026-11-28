# ADR-012: Multi-import from an external AI — one tray photo in, a zip of cut-out caps out, saved as "needs review"

- **Status:** Accepted
- **Date:** 2026-11-28

## Context
On 2026-11-28 the owner gave a tray photo to an external chat AI. The prompt asked it to cut out each cap and fill
one `response` object per cap. It came back with a zip of 6 pairs: `<brand>_<variant>.png`, with the background
removed, and a `.json` of the same name. The result was good enough to import. He wants the app to:

- give him that prompt, a reminder of the photo format and an **empty** template (his test reused a request that
  already carried another cap's `known` fields);
- accept the zip and enter **every cap at once as "needs review"**, then show a summary;
- leave about **2 mm of margin** around the rim, because the cut-outs were too tight;
- rename the area: "Exchange / Intercambio" sounds like swapping caps with other collectors.

Forces:
- **ADR-003:** nothing is saved without one of the three review screens. For a first load of 200+ caps, reviewing
  each one before it is saved is what batch mode (ADR-009) already offers. This path exists to skip that step and
  review later.
- **ADR-004:** the duplicate check must not be bypassed. Here it costs nothing, because no built-in AI is called at
  all.
- **ADR-007:** the external path stays manual and free. No API keys are stored.
- The cost model is unchanged: no Bedrock call, the existing routes, and one more S3 object per cap.

## Decision
1. **A multi-import saves directly, with `status = needsReview`.** This is an explicit exception to ADR-003,
   limited to this path. The owner reviews later from the Collection's "Por revisar" filter, and the
   `needsReview` flag is the review gate. Each cap is created with `source = external:<provider>`, the AI's
   `model` and the brand confidence. The server writes history as for any create. Nothing existing is ever
   changed by an import.
2. **The duplicate checks still run per cap, before saving, with no AI:**
   - **Inside the zip:** a pair within the batch guard (12, ADR-009) of an earlier pair of the same zip is not saved.
   - **dHash against the collection:** `POST /scans/analyse` with `useAi: false`. A near-match is not saved; the
     summary links to the existing cap.
   - **Brand + variant (normalised):** the cap is still saved, because the external guess may be wrong. It is flagged
     "possible duplicate" in the summary and in its `notes`.
3. **The image is used as received:** a cut-out with a transparent background, about 2 mm of margin, PNG, WebP or
   JPEG.
   - **Stored copy:** it is resized to ≤ 1024 px and encoded to WebP, and its alpha is kept.
   - **dHash:** it is computed on a copy flattened onto the neutral background that `cropCircle` uses. This keeps
     the hash as comparable with scans as the different crop allows.
4. **The prompt and the template live in `shared`:** `multiImportInstructions(language)` and `MULTI_IMPORT_TEMPLATE`.
   - The prompt uses the same field rules as `exchangeInstructions`, plus the cut-out, naming and zip rules.
   - The template is the bare `response` object with every value null. It has no `requestId` and no `known`, so no
     other cap's data can leak into the answer.
   - Each JSON in the zip is validated with `parseExchangeUpload`, so the format is still `capcollector.exchange`
     v1 and no new format version is needed.
5. **Limits:** at most 50 pairs and 50 MB per zip.
6. **The UI says "Import / Importar"** wherever it said "Exchange / Intercambio". The code, the route path `/exchange`,
   the i18n key prefixes and the `capcollector.exchange` format keep their names.

## Consequences
- A tray of 20 caps becomes 20 "Por revisar" caps in about a minute, with **zero Bedrock cost**.
- The review moves after the save. It is done with the existing edit form, and fixing the fields clears the
  flag, as with any `needsReview` cap.
- An external AI can misread or invent a field, and nothing catches that before the save. That is the price of
  skipping review, and why every imported cap starts as `needsReview` and keeps the AI's notes.
- A re-upload of the same zip is idempotent in practice: the dHash check turns every cap already saved into
  "already in collection".
- An AI cut-out and a later scan of the same cap are cropped differently, so their dHash distance may be larger than
  between two scans. If real imports show missed duplicates, the threshold tuning of ADR-004 covers it; it is not a
  reason to call the AI.
- Batch mode (ADR-009) stays the path for reviewing each cap before saving. Multi-import is the fast path.
