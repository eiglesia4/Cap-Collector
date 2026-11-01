# CapCollector

Personal bottle-cap collection app (iPhone first, Mac/web second) with an AI-assisted capture flow, duplicate
detection before any AI cost, and a link to the physical collection (Leuchtturm GRANDE album, `A·3·17`).

Owner: Eduardo de la Iglesia · Bundle ID `com.naevatec.collectors`.

- **Spec:** frozen copy in [`doc/spec/`](doc/spec/README.md) (live source: OneDrive `CapCollector/docs`).
- **How agents work here:** [`CLAUDE.md`](CLAUDE.md) · [`OWNERSHIP.md`](OWNERSHIP.md) ·
  [`doc/spec/method.md`](doc/spec/method.md).
- **Tests:** [`TEST.md`](TEST.md) (generated) · **Changes:** [`CHANGELOG.md`](CHANGELOG.md).
- **Jira:** project `CAP` on `naevatec.atlassian.net`.

## Layout

| Path      | What                                                               | Owner      |
| --------- | ------------------------------------------------------------------ | ---------- |
| `shared/` | Contracts shared by app and api (zod schemas + TS types)           | architect  |
| `app/`    | Vite + TypeScript bundle; Capacitor iOS shell; served on S3 too    | dev-app    |
| `api/`    | Lambda handlers (Node 22) behind API Gateway HTTP API              | dev-api    |
| `infra/`  | AWS CDK v2: `CollectorsData` (S3, DynamoDB) · `CollectorsApi`      | integrator |
| `tools/`  | Repo tooling (test catalog)                                        | integrator |
| `doc/`    | `spec/` frozen spec · `plans/` story plans · `adr/` repo-only ADRs | architect  |

## Quick start

Requires Node 22+.

```bash
npm ci
npm test            # all workspaces, coverage ≥ 80 %
npm run lint        # eslint + prettier
npm run typecheck   # tsc per workspace
npm run catalog     # regenerate TEST.md
npm run synth       # cdk synth naeva/dev (no credentials needed)
npm run dev -w @capcollector/app
```

## Repository setup (once, by Edu)

1. Create the GitHub repo `capcollector` (public on a free personal account — required status checks and CODEOWNERS
   need it; private only with GitHub Pro — see CAP-11 review) and push the first commit to
   `main` with `CAP_ALLOW_DIRECT_PUSH=1 git push -u origin main`.
2. Local hooks: `git config core.hooksPath .githooks` (done by `.envrc` via direnv); `brew install gitleaks`.
3. Branch protection on `main` (Settings → Branches → Add rule, or Rulesets):
   - Require a pull request before merging (approvals: 0 — a single owner cannot approve their own PR).
   - Require status checks to pass → add **`ci-gate`** only; require branches to be up to date.
   - Allow squash merging only; automatically delete head branches.
   - Do not allow bypassing the above settings (uncheck for admins only if the release commit flow needs it).
4. If CODEOWNERS should name a different login than `@eiglesia4`, update `.github/CODEOWNERS`.
5. `cp .envrc.local.example .envrc.local`, set `CAP_AGENT`, `JIRA_TOKEN`; `direnv allow`.
