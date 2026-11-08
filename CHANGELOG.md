# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
one section per milestone tag (`v0.1.0-v0`, `v0.2.0-v1`, …), closed by the integrator.

## [Unreleased]

### Added

- CAP-57: backups — AWS Backup vault + plan `cap-<inst>-<stage>` with a daily 03:00 UTC rule on the table
  (`ops.backupRetentionDays`, naeva.dev 35; no cold storage; vault follows the stack's removal policy); images bucket
  expires noncurrent versions after 90 days (replaces their IA transition) and keeps the 7-day multipart abort;
  restore runbook in `infra/README.md` § Backups (T-infra-036…038).
- CAP-41: scan screen and capture flow — circular guide, Shoot / Library (web: Upload photo), optional underside, upload, dHash, `POST /scans/analyse`, routing to the three outcomes, 503 sheet, "Use AI identification" setting; manual entry pre-filled from a scan.
- CAP-55: app dependencies for client-side insert-card PDFs — `pdf-lib` ^1.17.1, `qrcode` ^1.5.4 (+ `@types/qrcode` dev); used by CAP-54.
- CAP-51: operations — required `ops` config (`budgetEur`, `logRetentionDays`; naeva.dev 10 / 30); alarms on the
  alerts topic for API 5xx (≥ 5/5 min), Lambda errors (≥ 3/5 min per function, `MAX(METRICS())` in groups of ≤ 9),
  DynamoDB read + write throttles and authorizer throttles; monthly AWS Budget filtered by `project=EIM_CAP` (80 %
  actual, 100 % forecast, e-mail under `HasAlertEmail`); configured retention on every log group, CDK's S3 auto-delete
  provider included (`LogRetention`); the four mandatory tags on CDK's raw provider resources (T-infra-032…035).
- CAP-49: Albums API — list / create / patch (GRANDE 6 × 7 defaults, 409 on taken letter, kind change or shrink below an occupied pocket), sheet view over GSI1 and next free pocket; `DynamoAlbumRepository` with conditional puts.
- CAP-36: client dHash (64-bit, BT.601 luma, 9 × 8 area average, MSB-first hex) of the square inscribed in the cap circle, and the circular crop of the capture photo (ADR-004 §1).
- CAP-39: Bedrock vision adapter (ADR-004 §3, ADR-008 §7) — Converse with `EXCHANGE_INSTRUCTIONS`, top/underside
  WebP and the field schema + `known` (600 tokens, temperature 0, 8 s); the answer goes through the exchange-upload
  parser; brand confidence < 0.4 → `unidentified` with suggestions; throttling/5xx/timeout → 503; tokens and cost on the
  Scan (`prices.ts`, overridable); `CAP_VISION=bedrock|fake|off`, `fake` by default on `api:local` (T-api-058…064).
- CAP-33: `collectors://cap/<capId>` deep links open the cap detail on iPhone — `CFBundleURLTypes` scheme
  `collectors`, `Platform.onDeepLink` (Capacitor `appUrlOpen`, web no-op), id validated with the shared `Ulid`, anything
  else ignored (T-app-062, T-app-063).
- CAP-48: `exchange-requests-{list,create,patch}` get the table grant (closes SPEC-GAP CAP-15); T-infra-016 now
  checks that every handler using the repositories has the table. Deploy together with CAP-44.
- CAP-46: `fflate` ^0.8.3 in `app` (tiny, dependency-free ESM zip) for building `request.zip` exchange bundles on the
  client (CAP-45).
- CAP-44: exchange requests API (ADR-007) — `POST /exchange/requests` registers a downloaded bundle as `waiting` with
  a 30-day `ttl` (409 on a duplicate `requestId`, scan linked in the same transaction), list newest first with
  `expired` computed on read, PATCH `waiting → answered` (needs `provider`) → `reviewed`; real
  `DynamoExchangeRepository` (T-api-051…057). Needs the CAP-48 table grant before deploy.
- CAP-38: `@aws-sdk/client-bedrock-runtime` ^3.1161.0 in `api` (same line as the other `@aws-sdk/*`, one shared
  `@aws-sdk/core`) for the Bedrock vision adapter (CAP-39).
- CAP-37: scans API (ADR-004) — `POST /scans/analyse`: dHash Hamming over the user's live caps (≤ `CAP_DHASH_THRESHOLD`,
  default 10 → `duplicate` with the AI never called), `useAi=false` → `unidentified`, `VisionAdapter` interface with a
  stub (unavailable → Scan stored, 503), brand + variant re-check over GSI2; every call stores a `Scan`; `GET /scans`
  newest first with cursor (T-api-042…050).
- CAP-31: the share link is the HTTPS mirror `<VITE_WEB_URL>/cap/<capId>` on iPhone and Mac (amended ADR-008 §5);
  new optional `VITE_WEB_URL` (bare https origin, validated at load); without it the web falls back to
  `location.origin` and the iPhone shares text only; `collectors://` share branch removed (T-app-060, T-app-061).
- CAP-40: infra for scans — required `ai: { modelId, dhashThreshold }` in `infra/config/*.json` (naeva/dev:
  `eu.anthropic.claude-haiku-4-5-20251001-v1:0`, threshold 10); new grant `bedrock` (`bedrock:InvokeModel` on the
  configured model / inference profile only) for `scans-analyse`, which also gets `images-get`, `CAP_BEDROCK_MODEL_ID`,
  `CAP_DHASH_THRESHOLD` and 1024 MB / 20 s; cost guard: daily Bedrock invocations alarm (> 300) on the new
  `cap-<inst>-<stage>-alerts` topic, e-mail from SSM `alert-email` (T-infra-028…031).
- CAP-32: `@capacitor/app` 8.1.2 in `app` (same major as `@capacitor/core`) for `collectors://` deep links (CAP-33);
  SPM `Package.swift` synced; the root Capacitor import boundary already covers `@capacitor/*`.
- CAP-25: cap form (SCREENS.md #5, ADR-003 modes `empty | edit`) on `/new` and `/cap/:id/edit` — brand autocomplete,
  ISO country search, enum selects, tag chips, inline `CapInput` validation and 422 `Problem.errors[]` per field;
  photos resized client-side to WebP ≤ 1024 px and uploaded via presigned PUT with retry; `POST /caps` or a PATCH with
  only the changed fields; in edit mode a "Needs review" toggle sends `status` only when it changes (T-app-048…059).
- CAP-28: native Sign in with Apple sheet on iPhone (`@capacitor-community/apple-sign-in`, `clientId` = bundle id,
  PKCE nonce/state; cancel by error code 1001, message as fallback); on 403 the sign-in screen shows the Apple `sub`
  decoded locally with Copy for the allow-list; `App.entitlements` + Xcode `CODE_SIGN_ENTITLEMENTS` and
  `DEVELOPMENT_TEAM` committed (T-app-044…047).
- CAP-35: `caps-create` and `caps-patch` get `images-get` (`s3:GetObject` on the images bucket) so the presigned
  `imageUrls` they return since CAP-30 download; T-infra-027 requires it for every Cap-returning handler.
- CAP-30: API adopts contracts v0.2 — `Cap.imageUrls = { top, underside? }` (15-minute presigned GETs) on caps
  list/get/create/patch, shared `AppleSignInRequest`/`RefreshRequest`/`Session`/`Healthz`/`UploadRequest`/
  `UploadResponse`/`Problem` schemas, local server on shared `ROUTES`, `refreshSk()`, `CapPatch` `null` clears a field.
- CAP-29: custom domains — optional `domains: { web, api }` in `infra/config/*.json` (naeva/dev:
  `caps.naevatec.com`, `api.caps.naevatec.com`); CloudFront alias + us-east-1 ACM certificate and a regional API
  Gateway domain + mapping, both ARNs read from new SSM settings `web-certificate-arn` / `api-certificate-arn`
  (never passed to a Lambda); outputs `WebDomainTarget` / `ApiDomainTarget` for the GoDaddy CNAMEs; with domains the
  API CORS origin comes from config instead of importing `WebUrl`; `--context domains=off` for the first rollout;
  runbook in `infra/README.md` (T-infra-024…026).
- CAP-24: cap detail screen (SCREENS.md #6) — top/underside photo swap, chips, Quantity · For trade · Added tiles,
  fields card (incl. `textOnCap`), "Where is it?" row, same-brand variants carousel, history newest first, Share
  (`collectors://cap/<id>` until CAP-31 switches to the HTTPS link) and soft Delete with confirm sheet and toast.
- CAP-27: integrator housekeeping — `zod` declared in `api`, `@capacitor-community/apple-sign-in` 7.1.0 in `app` (SPM
  `Package.swift` synced; native sheet wiring is CAP-28); Capacitor import boundary moved to the root `eslint.config.js`
  (`app/eslint.config.js` removed, T-infra-023); `.prettierignore` covers `cap sync` output; API CORS allows the
  CloudFront `WebUrl` imported from CollectorsData; `infra/lib/routes.ts` = shared `ROUTES` + per-handler wiring
  (T-infra-016 now checks wiring; openapi parity only in T-shared-006); internal workspace deps declared `"*"`
  (T-infra-015).
- CAP-23: collection screen (SCREENS.md #1) — count header, sort sheet, debounced search, type/country/needs-review
  chips (AND), recently-added strip, 3-column round tiles (`imageUrls.top` or brand-hued placeholder), cursor infinite
  scroll, iOS pull-to-refresh, empty states, query/scroll restored on back navigation.
- CAP-26: contracts v0.2 — `shared/src/routes.ts` (single route manifest), `schemas/http.ts` (Problem, Healthz, Session,
  AppleSignInRequest, RefreshRequest, UploadRequest/Response), `Cap.imageUrls`, `Location.albumId` (server-filled),
  `CapPatch` without defaults and with `null` to clear, `refreshSk()`; `openapi.yaml` 0.2.0 (security markers, auth and
  upload bodies, sort rules, examples); `doc/spec/` refreshed from OneDrive (method § Refreshing, CONVENTIONS tagging /
  deploy / image keys / source semantics, data-model REFRESH#, LOCK#, albumId).
- CAP-22: Sign in with Apple screen — PKCE verifier per attempt with `nonce = base64url(SHA-256(verifier))`, Apple JS
  popup flow on web (and for now on iOS), state check, 403/network/cancel/not-configured states, route guard, silent
  session restore at start, Sign out in Settings; `VITE_APPLE_SERVICE_ID` / `VITE_APPLE_REDIRECT_URI` config.
- CAP-20: uploads API — `POST /uploads` returns a 5-minute presigned S3 PUT for `<uid>/<uploadId>/<side>.webp`
  (`image/webp`, ≤ 1 MiB, signed Content-Type/Length, SSE-S3); ownership helpers for image keys and 15-minute presigned
  GET links (`_links.images`) ready for the caps handlers.
- CAP-19: auth API — `POST /auth/apple` (Apple JWKS verification, `aud` allow-list, PKCE nonce = S256(codeVerifier),
  single-user `sub` allow-list → 403), HS256 session JWT (1 h), hashed refresh tokens (`REFRESH#<hash>`, ttl 90 d)
  rotated on every `POST /auth/refresh` with replay → 401, simple-response Lambda authorizer emitting `uid`; refuses the
  `unset` SSM placeholder and short secrets.
- CAP-18: caps API — `POST/GET/PATCH/DELETE /caps`, `/caps/{capId}/history` and `GET /caps` (filters, accent-insensitive
  `q`, location-code search, sort brand/newest/country/year, cursor, `total` up to 5 000); history `HIST#` written in
  the same transaction, GSI2 kept in step, tombstone delete, PATCH applies only the fields sent.
- CAP-21: app foundation — Capacitor iOS project (`com.naevatec.collectors`), vanilla-TS shell with history router
  (10 routes) and tab bar Collection · Scan · Wishlist · Stats, `platform/` adapter (web + Capacitor, Capacitor imports
  fenced by lint), design tokens with self-hosted fonts, typed i18n, typed API client (401 → refresh → retry once),
  session store, Settings skeleton.
- CAP-17: API foundation — `defineHandler` (zod in, RFC 9457 Problem out, authorizer `uid`, no-store JSON, no bodies
  in logs), env config validated at cold start, ULID ids, `CapRepository` with an in-memory single-table emulator and
  a DynamoDB implementation (one `TransactWriteItems` plan for cap + `HIST#` + `LOCK#`, keys only from `shared`),
  Album/Scan/Exchange interfaces, `npm run api:local`; contract suite on both repositories (DynamoDB Local opt-in).
- CAP-16: the web build is served over HTTPS by CloudFront (default `*.cloudfront.net` domain, Origin Access Control,
  price class 100, HTTP/2+3, SPA fallback 403/404 → `/index.html`); the web bucket is private again (no website
  hosting, TLS only); images CORS allows the CloudFront origin; outputs `WebUrl` and `DistributionId` replace
  `WebsiteUrl`; `npm run deploy:web [-- --dry-run]` builds, syncs and invalidates from the stack outputs.
- CAP-15: `CollectorsApi` stack — HTTP API routed by `infra/lib/routes.ts` (identical to `openapi.yaml`), one arm64
  Node 22 Lambda per handler file (256 MB, 10 s, JSON logs 30 d), a shared 501 stub for routes not merged yet, Lambda
  authorizer (deny-all stub until CAP-19), per-function IAM, CORS from `app_origins`, throttling 10 rps; SSM settings
  (`allowed-apple-subs`, `apple-client-ids`, `session-secret`) created `unset` in `CollectorsData`; `infra/README.md`.
- CAP-14: V1 dependency batch — Capacitor 8 (core, cli, ios, camera, share, filesystem, preferences) and
  `@testing-library/dom` for `app`; AWS SDK v3 (DynamoDB, lib-dynamodb, S3, presigner), `jose`, `ulid` and
  `aws-sdk-client-mock` for `api`; root `diff` / `deploy` / `api:local` scripts; T-infra-015 checks that every declared
  dependency resolves and that workspaces only share code through `@capcollector/shared`.
- CAP-13: `CollectorsData` stack — private versioned images bucket (IA after 90 d, CORS for presigned PUT), public
  S3 website bucket for V1, single DynamoDB table (on-demand, PITR, TTL, GSI1/GSI2) from one table definition shared
  with `npm run db:create`; `deploy/docker-compose.yaml` with DynamoDB Local + S3 mock; optional `app_origins` config.
- CAP-13 (architect revision): AWS tags `project=EIM_CAP`, `UserName=eiglesia4`, `installation`, `stage` applied once
  at CDK app level, so every stack and taggable resource inherits them (CONVENTIONS.md § AWS tagging); they replace the
  `cap:project` / `cap:installation` / `cap:stage` tags (`cap:config_version` stays).
- CAP-12: contracts v0.1 — `@capcollector/shared` zod schemas and types (enums, Location + `A·3·17` parser, Cap /
  CapInput / CapPatch / CapHistory, Scan / Analyse, Album / SheetView / NextFree, `capcollector.exchange` v1 with upload
  parser and field normalisation), `keys.ts` as the single source of DynamoDB keys; `doc/spec/openapi.yaml` 0.1.0;
  `specs/data-model.md` Agreed; ADR-008 (variants as links, batch in V4, web in V1, Sign in with Apple, domain later).
- CAP-11: repo skeleton — npm workspaces (`shared`, `app`, `api`, `infra`), TypeScript strict, eslint + prettier,
  vitest with per-workspace projects and coverage gate, `TEST.md` catalog; `api` healthz handler; CDK app with empty
  `CollectorsData` / `CollectorsApi` stacks and the synth account guard; `CLAUDE.md`, `OWNERSHIP.md`, agent commands,
  git hooks, CODEOWNERS and CI with `ci-gate`; frozen spec copy in `doc/spec/`.

### Changed

- CAP-47 (method): after rebasing a `CAP-*` branch, push with `git push --force-with-lease origin CAP-<n>-<slug>`
  (never plain `--force`, never `main`); `/revise` keeps both sides of additive conflicts (`app.css`, `CHANGELOG.md`)
  and regenerates `TEST.md` with `npm run catalog`.
- CAP-34: method — `dev-infra` (`area-infra`) owns `infra/**` and `deploy/**`; `integrator` keeps merges, releases,
  dependencies, root configs, CI, hooks, tools, CHANGELOG and TEST.md under the new label `area-integration`
  (OWNERSHIP.md, CLAUDE.md, CODEOWNERS, `/next`, method.md).
