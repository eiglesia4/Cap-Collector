# ADR-007: Manual exchange with external AI via request/response JSON

- **Status:** Accepted
- **Date:** 2026-10-18

## Context
The built-in Bedrock identification costs money per call and will sometimes fail. The owner wants
to be able to hand a photo + JSON to any external AI by hand and feed the answer back.

## Decision
Add an **Exchange** area: download `request.zip` (photos + `request.json` with instructions, schema,
known fields and an empty `response`), upload the photo + filled JSON (or the bare `response`).
The upload is validated (format, requestId, photo dHash, enum normalisation) and then enters the
same three-outcome review as a built-in scan, tagged `source = external:<provider>`.

## Consequences
- One schema (`capcollector.exchange` v1) shared by built-in AI output, external AI output and
  backup export, so the review form has a single input shape.
- Pending requests are tracked (`EXCHANGE#<requestId>`), so answers can arrive days later.
- No API keys for third-party AIs are stored; the loop is deliberately manual and free.
- Schema is versioned; the importer must accept every version it has ever emitted.
