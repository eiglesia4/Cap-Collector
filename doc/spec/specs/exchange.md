# Exchange with external AI (download / upload area)

**Status:** Agreed (2026-10-18) — see ADR-007

## Purpose
Let the owner use any AI (ChatGPT, Claude.ai, Gemini, a local model…) by hand: download a
request bundle (photo + JSON), paste both into the external AI, upload the photo + the JSON it
returns. Zero Bedrock cost, works when the built-in AI fails or is switched off, and gives a
second opinion for `needsReview` caps.

## Flow
1. **Download request** — from the Exchange screen, from a scan outcome (Review/Manual: "Export for
   external AI") or from Cap detail (⋯ → "Ask external AI"). Scope: this scan/cap · all `needsReview` ·
   pick caps. Produces `cap-<capId|scanId>-request.zip` with `top.webp`, `underside.webp` (if any)
   and `request.json`. On iPhone it goes to the share sheet / Files; on Mac it is a download.
   "Copy prompt" and "Copy JSON" shortcuts for chat UIs that take pasted text + an image.
2. **External AI** — the user pastes `request.json` (its `instructions` tell the model to return
   only the `response` object) and attaches the photo(s).
3. **Upload answer** — drop zone (Mac) / file picker (iPhone). Accepts the zip back, or loose files
   (`*.json` + images). Validation:
   - JSON parses and `format == "capcollector.exchange"`, `version` supported.
   - `requestId` matches a pending request; else offer to attach it to a cap chosen manually.
   - Photo dHash matches the request's photo (tolerance as ADR-004); mismatch → warning, not a block.
   - Unknown fields are not dropped silently: appended to `notes` and listed as "ignored".
   - Enum values normalised (country name → ISO code, "aluminum" → aluminium, etc.).
4. **Review** — the validated answer enters the normal three-outcome review (ADR-003) with
   `source = external:<provider>`; the dHash/brand duplicate checks still run. Nothing is saved
   without the review.

## request.json
```json
{
  "format": "capcollector.exchange",
  "version": 1,
  "kind": "request",
  "requestId": "01J9…",
  "createdAt": "2026-10-18T10:14:00Z",
  "photos": [{ "file": "top.webp", "side": "top", "dhash": "a3f0…" }],
  "instructions": "You are helping identify a bottle cap. Look at the attached photo(s). Fill the `response` object below. Use null when unsure and give a confidence 0–1 per field. Return ONLY the JSON of `response`.",
  "schema": {
    "brand": "string", "variant": "string|null", "producer": "string|null",
    "country": "ISO 3166-1 alpha-2|null", "type": "beer|soft drink|water|cider|wine|other",
    "material": "steel|aluminium|plastic|null", "closure": "pry-off|twist-off|null",
    "year": "integer|null", "description": "string", "textOnCap": "string|null"
  },
  "known": { "brand": "Asahi", "country": "JP" },
  "response": {
    "provider": null, "model": null,
    "fields": { "brand": null, "variant": null, "producer": null, "country": null, "type": null,
                "material": null, "closure": null, "year": null, "description": null, "textOnCap": null },
    "confidence": { "brand": null, "variant": null, "year": null },
    "notes": null
  }
}
```
`known` carries what the record already has so the model confirms or corrects instead of guessing.
The upload accepts either the whole document with `response` filled or the bare `response` object.

## Pending requests
Each download creates a `Scan`-like item `EXCHANGE#<requestId>` (status `waiting | answered |
reviewed | expired`) so the screen can list what is still out. Expire after 30 days.

## Batch
A multi-cap request zips one folder per cap plus `requests.json` (array). The answer may come
back as one JSON array or one file per cap; each item is matched by `requestId`.

## Also covered by this area
- Whole-collection export (JSON + CSV + images zip) and import (merge by `capId`, dry-run diff
  first) live on the same screen under "Backup". Import never deletes; it only adds or proposes updates.
