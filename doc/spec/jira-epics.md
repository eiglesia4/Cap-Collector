# Jira epics for project CAP (draft to be pushed by the architect)

| Epic | Deliverable | Territory | Goal |
|---|---|---|---|
| EP-01 Design & contracts: shared types, zod schemas, OpenAPI, exchange v1, DynamoDB keys, screens | V0 | architect | Fix the vocabulary and the contracts before any product code |
| EP-02 Infrastructure & DevX: repo, CLAUDE.md, OWNERSHIP.md, commands, CDK stacks, CI, test IDs | V0 | integrator | Clone → test → deploy in one command; agents can start |
| EP-03 API: caps CRUD, history, presigned uploads, albums, Sign in with Apple | V1 | dev-api | Postman-level app on real AWS, under 5 €/month |
| EP-04 App shell: collection grid, cap detail, manual form (empty/edit), web build on S3 | V1 | dev-app | Start loading the real collection by hand |
| EP-05 Capture & duplicates: camera, crop, client dHash, hash-check Lambda, "Already in collection" | V2 | dev-app + dev-api | Duplicates caught before any AI cost |
| EP-06 AI identification: Bedrock vision Lambda, AI review screen, confidence, re-identify | V2 | dev-api + dev-app | Photo → pre-filled record |
| EP-07 Exchange with external AI: request/response bundles, upload validation, pending, backup | V2 | dev-app (+ dev-api for pending items) | Free AI path and backups |
| EP-08 Physical album: location model, sheet view, next free pocket, insert-card PDF | V3 | dev-app + dev-api | Virtual ↔ physical link |
| EP-09 Release & operations: TestFlight/App Store, domain, CloudFront, cost alarms, backups | V3 | integrator / Edu | App on the phone, costs watched |
| EP-10 Phase 2: batch mode, wishlist, stats, offline queue, sheet photo check, QR | V4 | mixed | Ordered by use, one flag each |

Full descriptions are created in Jira by the architect (Cowork) with: Goal · Scope · Done when · Deliverable, labels `cap-<slug>` + `deliverable-V<n>`.
