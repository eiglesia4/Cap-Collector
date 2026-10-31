# Changelog

All notable changes to this project are documented here. Format: [Keep a Changelog](https://keepachangelog.com/);
one section per milestone tag (`v0.1.0-v0`, `v0.2.0-v1`, …), closed by the integrator.

## [Unreleased]

### Added

- CAP-11: repo skeleton — npm workspaces (`shared`, `app`, `api`, `infra`), TypeScript strict, eslint + prettier,
  vitest with per-workspace projects and coverage gate, `TEST.md` catalog; `api` healthz handler; CDK app with empty
  `CollectorsData` / `CollectorsApi` stacks and the synth account guard; `CLAUDE.md`, `OWNERSHIP.md`, agent commands,
  git hooks, CODEOWNERS and CI with `ci-gate`; frozen spec copy in `doc/spec/`.
