# Maintainers: how this repository is built

This is the author's own workflow. It is not needed to build, deploy or use CapCollector (see the
[README](../README.md)).

The app is built by AI coding agents against a written specification: an architect writes the spec and the stories,
three development agents (`dev-app`, `dev-api`, `dev-infra`) each work in their own git worktree, and an integrator
rebases, checks and merges. State lives in a Jira project (`CAP`); every change is one story, one branch `CAP-<n>-…`,
one pull request.

- **Spec:** [`doc/spec/`](spec/README.md) (features, screens, data model, OpenAPI, ADRs).
- **Agent rules:** [`CLAUDE.md`](../CLAUDE.md) and [`OWNERSHIP.md`](../OWNERSHIP.md) (in Spanish), and
  [`doc/spec/method.md`](spec/method.md).
- **Tests:** [`TEST.md`](../TEST.md) (generated) · **Changes:** [`CHANGELOG.md`](../CHANGELOG.md).

## Ownership

| Path      | What                                                            | Owner      |
| --------- | --------------------------------------------------------------- | ---------- |
| `shared/` | Contracts shared by app and api (zod schemas + TS types)        | architect  |
| `app/`    | Vite + TypeScript bundle; Capacitor iOS shell; served on S3 too | dev-app    |
| `api/`    | Lambda handlers (Node 22) behind API Gateway HTTP API           | dev-api    |
| `infra/`  | AWS CDK v2: `CollectorsData` (S3, DynamoDB) · `CollectorsApi`   | dev-infra  |
| `tools/`  | Repo tooling (test catalog, CI helpers)                         | integrator |
| `doc/`    | `spec/` the spec · `plans/` story plans · `adr/` repo-only ADRs | architect  |

## Repository setup (once)

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
