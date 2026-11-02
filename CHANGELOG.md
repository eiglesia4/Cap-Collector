# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
one section per milestone tag (`v0.1.0-v0`, `v0.2.0-v1`, …), closed by the integrator.

## [Unreleased]

### Added

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
