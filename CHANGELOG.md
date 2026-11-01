# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
one section per milestone tag (`v0.1.0-v0`, `v0.2.0-v1`, …), closed by the integrator.

## [Unreleased]

### Added

- CAP-13: `CollectorsData` stack — private versioned images bucket (IA after 90 d, CORS for presigned PUT), public
  S3 website bucket for V1, single DynamoDB table (on-demand, PITR, TTL, GSI1/GSI2) from one table definition shared
  with `npm run db:create`; `deploy/docker-compose.yaml` with DynamoDB Local + S3 mock; optional `app_origins` config.
- CAP-12: contracts v0.1 — `@capcollector/shared` zod schemas and types (enums, Location + `A·3·17` parser, Cap /
  CapInput / CapPatch / CapHistory, Scan / Analyse, Album / SheetView / NextFree, `capcollector.exchange` v1 with upload
  parser and field normalisation), `keys.ts` as the single source of DynamoDB keys; `doc/spec/openapi.yaml` 0.1.0;
  `specs/data-model.md` Agreed; ADR-008 (variants as links, batch in V4, web in V1, Sign in with Apple, domain later).
- CAP-11: repo skeleton — npm workspaces (`shared`, `app`, `api`, `infra`), TypeScript strict, eslint + prettier,
  vitest with per-workspace projects and coverage gate, `TEST.md` catalog; `api` healthz handler; CDK app with empty
  `CollectorsData` / `CollectorsApi` stacks and the synth account guard; `CLAUDE.md`, `OWNERSHIP.md`, agent commands,
  git hooks, CODEOWNERS and CI with `ci-gate`; frozen spec copy in `doc/spec/`.
