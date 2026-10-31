# ADR-008: Decisions closed for V0 — variants, batch mode, web in V1, auth, domain, contract ownership

- **Status:** Accepted
- **Date:** 2026-10-31 (CAP-12, confirmed by Edu)

## Context
Five questions were left open after the October design sessions and had to be settled before the contracts (`shared/`, `openapi.yaml`, data model) could be published.

## Decisions
1. **Variants are a link, not a family record.** `Cap.variantOf: capId` points at the cap this one is an edition of. A "family" is derived (the cap with no `variantOf` plus everything pointing at it). A family record can be introduced later by migration if family-level fields ever appear.
2. **Batch mode (tray photo → N caps) is V4.** Single-cap scan must be right first; segmentation is the riskiest vision work in the app.
3. **The Mac/web build ships in V1, read-mostly.** Same bundle on S3; camera-dependent features hide on desktop; the Exchange drop zone and bulk editing live there.
4. **Auth = Sign in with Apple + PKCE.** The API keeps a single-user allow-list by Apple `sub`; session JWT + long-lived refresh token; no Cognito.
5. **Domain: decided later (EP-09).** Until then the web build and the API use the CloudFront/S3 and API Gateway default URLs; `openapi.yaml` carries a placeholder server variable. Deep links use the `collectors://` scheme on the phone; the HTTPS mirror waits for the domain.
6. **Contract ownership made concrete.** `shared/src/**` (zod schemas + inferred types + `keys.ts`) and `doc/spec/openapi.yaml` are the contracts. zod is authoritative where both exist; the OpenAPI names the zod schema for each body. The same `response` object of `capcollector.exchange` v1 is the output shape required from Bedrock (one shape for both AI paths).
7. **Bedrock prompt.** The system prompt sent to the vision model is `EXCHANGE_INSTRUCTIONS` + the field schema `EXCHANGE_FIELD_SCHEMA` + `known` fields, exactly as written into `request.json`; the model must return the `response` object only. Model id lives in API config (start with a Claude Haiku-class vision model); tuning is a config change, not a contract change.

## Consequences
- Open-decision list in `PROJECT_MEMORY.md` is cleared except pocket measurements (physical) and dHash threshold (tuned from `Scan` items, config value, start at 10).
- `data-model.md` is Agreed; `CollectorsData` (CAP-13) can be defined.
- V1 stories for `dev-api` (EP-03) and `dev-app` (EP-04) can be written against `@capcollector/shared` 0.1.0.
