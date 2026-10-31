# ADR-001: Native iPhone app via Capacitor, same bundle served as web for the Mac

- **Status:** Accepted
- **Date:** 2026-10-12 (confirms July 2025 design)

## Context
Owner has an Apple developer licence, an iPhone and a Mac. Wants native camera quality for
capturing caps and a desktop view for bulk editing/exporting. Wants one codebase.

## Decision
One Vite + TypeScript bundle wrapped with Capacitor for iOS (App Store install), and the same
bundle served statically from S3 (+ optional CloudFront) for the Mac browser. No PWA-only route,
no separate web view. On desktop the Scan screen becomes "Upload photo".

## Consequences
- One UI codebase, two deployment targets.
- Camera, haptics and share sheet via Capacitor plugins; web falls back to `<input type=file>`.
- Android is possible later at near-zero cost but is out of scope.
