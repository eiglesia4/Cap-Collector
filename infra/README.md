# infra — AWS CDK v2 (CollectorsData · CollectorsApi)

Owned by the integrator (OWNERSHIP.md). **Deploying is Edu's job, never an agent's.** Targets and profiles:
CONVENTIONS.md § Deployment targets; per-target settings: [`config/`](config/README.md).

| Stack            | What                                                                                                                                         | Story                          |
| ---------------- | -------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------ |
| `CollectorsData` | images + web buckets, CloudFront (+ `domains.web`), the DynamoDB single table + its AWS Backup plan (reads, never creates, the SSM settings) | CAP-13, CAP-29, CAP-57, CAP-60 |
| `CollectorsApi`  | HTTP API (+ `domains.api`), one Lambda per `api/src/handlers/*.ts` routed by [`lib/routes.ts`](lib/routes.ts), authorizer, alarms + budget   | CAP-15, CAP-29, CAP-40, CAP-51 |

## Deploy

**A new target** (your own AWS account): copy [`config/example.dev.json`](config/example.dev.json) to
`config/<inst>.<stage>.json` and set its `region`, `ai.modelId` (an inference profile your region offers) and `tags`
(the values of the `project` / `UserName` cost-allocation tags; the monthly budget filters on `project`). `example`
itself is refused as an installation name, so the template is never deployed by mistake (CAP-102). The installation
goes into resource names: lowercase letters, digits and hyphens.

```bash
export CAP_INSTALLATION=<inst> CAP_STAGE=<stage> AWS_PROFILE=<profile>   # .envrc.local does this
npm run diff                       # from the repo root (builds shared first)
npm run deploy                     # CollectorsData first, then CollectorsApi
```

**Settings first (CAP-60):** the stacks only _read_ the eight `/cap/<inst>/<stage>/*` SSM settings; a deploy fails
with a clear "parameter not found" while one is missing. On a new target run `npm run settings:bootstrap -w
@capcollector/infra` once (creates the missing ones as `unset`; see § Settings). The API must refuse `unset`: fill
the auth ones before relying on Sign in with Apple (CAP-19), then run `npm run deploy` again so CloudFormation
resolves the new values:

```bash
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/allowed-apple-subs --value '<apple sub>'
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/apple-client-ids  --value '<bundle id>,<web service id>'
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/session-secret    --value "$(openssl rand -base64 48)"
```

**Sign in with Google (CAP-109, ADR-011):** optional. While `google-client-ids` and `google-identities` stay `unset`
the API refuses every Google sign-in and Apple keeps working. **An existing target must run
`npm run settings:bootstrap -w @capcollector/infra` once before its next deploy**, which creates the two as `unset`:
otherwise CloudFormation fails with "parameter not found". To turn it on, create the OAuth clients in Google Cloud
(consent screen in testing mode, a Web client and an Android client), then map your Google `sub` to your uid (your
Apple `sub`; a Google-only installation maps the Google `sub` to itself). The first refused sign-in answers 403 with
the `sub` in the body. None of these values are secrets. `auth-google` reads both settings; `auth-refresh` reads
`google-identities` so a Google-mapped uid can refresh:

```bash
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/google-client-ids --value '<web client id>,<android client id>'
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/google-identities --value '<google sub>=<uid>'
```

**Alerts (CAP-40):** `CollectorsApi` creates the topic `cap-<inst>-<stage>-alerts` and an alarm when Bedrock is
invoked more than 300 times in a day (cost guard). The e-mail comes from `/cap/<inst>/<stage>/alert-email`; while it is
`unset` the topic has no subscription. Set it, redeploy `CollectorsApi`, and confirm the e-mail AWS sends:

```bash
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/alert-email --value '<your e-mail>'
```

**Bedrock model (CAP-40, CAP-73):** `ai.modelId` in `config/<inst>.<stage>.json`. For example, **Claude Haiku 5.5**
through the EU cross-region inference profile `eu.anthropic.claude-haiku-5-5`. The stack derives everything else from
that one value: `scans-analyse` may invoke the profile in this account and region plus the foundation model
`anthropic.claude-haiku-5-5` in any region (the profile routes inside the EU), and the daily-invocations alarm watches
`ModelId = eu.anthropic.claude-haiku-5-5`.

- **Before the deploy:** grant model access for **Claude Haiku 5.5** in the Bedrock console (eu-west-1, _Model
  access_). Without it, the deploy succeeds but every scan that reaches the AI fails with `AccessDeniedException`.
- **Switch back:** change the one line in the config (the previous model was
  `"modelId": "eu.anthropic.claude-haiku-4-5-20251001-v1:0"`) and redeploy `CollectorsApi`; grant, env and alarm
  follow. The api adapter already prices that model; a model it does not know (price entry, thinking settings,
  `api/src/lib/vision/`, CAP-72) needs a dev-api story first.

Check what the region offers; in eu-west-1 recent Claude models come as `eu.` inference profiles:

```bash
aws bedrock list-inference-profiles --region eu-west-1 --query "inferenceProfileSummaries[?contains(inferenceProfileId,'haiku')].inferenceProfileId"
aws bedrock list-foundation-models  --region eu-west-1 --by-output-modality TEXT --query "modelSummaries[?contains(modelId,'haiku')].modelId"
```

No stack owns these parameters (CAP-60), so no deploy can reset or delete a value.

## Settings (CAP-60)

The eight settings — `allowed-apple-subs`, `apple-client-ids`, `google-client-ids`, `google-identities`,
`session-secret`, `web-certificate-arn`, `api-certificate-arn`, `alert-email` under `/cap/<inst>/<stage>/` — are Edu's: created once, filled by hand, read by
the stacks at deploy time (`AWS::SSM::Parameter::Value<String>` template parameters). Scripts (target from
`CAP_INSTALLATION` / `CAP_STAGE`, profile from the environment; logic in [`lib/settings.ts`](lib/settings.ts)):

```bash
npm run settings:bootstrap -w @capcollector/infra   # creates the missing ones as `unset` (tagged); never overwrites
npm run settings:show      -w @capcollector/infra   # name + set / unset / missing — never the values
npm run settings:restore   -w @capcollector/infra -- infra/.local/settings-backup.json   # overwrite from a backup
```

Values reach the AWS CLI through a private temp file (`$TMPDIR/cap-settings-*/input.json`, mode 0600, deleted right
after each call, also on error), never through argv or stdin (CAP-67: the CLI cannot read `file:///dev/stdin` on
macOS).

**New target: bootstrap comes first, before the first `deploy`.** Every deploy reads all eight settings, so on a target
with none of them CloudFormation fails with "parameter not found":

```bash
# 1. Create the eight settings as `unset`.
npm run settings:bootstrap -w @capcollector/infra
# 2. Fill the auth ones (and alert-email, certificates when ready) — Deploy above, Custom domains below.
# 3. Check, then deploy.
npm run settings:show -w @capcollector/infra
npm run deploy
```

**Migration, once per target that was deployed before CAP-60.** The deployed `CollectorsData` template still owns
the parameters, so the first deploy after CAP-60 _deletes_ them. Check first:

```bash
aws cloudformation describe-stack-resources --stack-name cap-<inst>-<stage>-data \
  --query "StackResources[?ResourceType=='AWS::SSM::Parameter'].PhysicalResourceId"
```

If that lists nothing (e.g. the stack never got that far — the "already exists" failure this story fixes), skip
steps 1 and 4. Otherwise:

```bash
# 1. Back up the values (infra/.local/ is gitignored; delete the file once restored).
mkdir -p infra/.local
aws ssm get-parameters --with-decryption --output json --names \
  /cap/<inst>/<stage>/allowed-apple-subs /cap/<inst>/<stage>/apple-client-ids /cap/<inst>/<stage>/session-secret \
  /cap/<inst>/<stage>/web-certificate-arn /cap/<inst>/<stage>/api-certificate-arn /cap/<inst>/<stage>/alert-email \
  > infra/.local/settings-backup.json
# 2. Deploy only the data stack: it drops the parameters from the template, and SSM deletes them. (A full deploy
#    would then fail in CollectorsApi, which reads them.)
npm run cdk -w @capcollector/infra -- deploy -e CollectorsData \
  --context installation=$CAP_INSTALLATION --context stage=$CAP_STAGE
# 3. Recreate the missing ones as `unset`.
npm run settings:bootstrap -w @capcollector/infra
# 4. Put the saved values back, check, and deploy everything (the API re-reads them).
npm run settings:restore -w @capcollector/infra -- infra/.local/settings-backup.json
npm run settings:show -w @capcollector/infra
npm run deploy && rm infra/.local/settings-backup.json
```

Between steps 2 and 4 the deployed functions keep the values they were deployed with; only a deploy re-reads SSM.
If the target already uses its custom domains, keep them on in step 2: the data stack resolves the web certificate
ARN before the parameters are removed.

## Operations (CAP-51): what fires when

Every alarm notifies the topic `cap-<inst>-<stage>-alerts`, so it reaches the `alert-email` above (nothing is sent
while it is `unset`). Missing data never fires (`notBreaching`). Thresholds live in [`lib/ops.ts`](lib/ops.ts).

| Alarm / budget                                      | Fires when                                                                                                   | Look first at                                             |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `cap-<inst>-<stage>-api-5xx`                        | the HTTP API returns ≥ 5 `5xx` in 5 min                                                                      | the log groups of the functions behind the failing routes |
| `cap-<inst>-<stage>-lambda-errors-<n>`              | any one function of that group has ≥ 3 `Errors` in 5 min (groups of ≤ 9; the description lists them)         | that function's log group                                 |
| `cap-<inst>-<stage>-dynamodb-throttles`             | the table records ≥ 1 read or write throttle event in 5 min                                                  | a hot partition or a runaway client (on-demand table)     |
| `cap-<inst>-<stage>-authorizer-throttles`           | the authorizer is throttled at least once in 5 min                                                           | account Lambda concurrency, a client retry loop           |
| `cap-<inst>-<stage>-bedrock-invocations` (CAP-40)   | more than 300 Bedrock invocations of `ai.modelId` in a day                                                   | Scan items: is the dHash check being skipped?             |
| AWS Budget tagged `Name=cap-<inst>-<stage>-monthly` | spend tagged `project=<tags.project>` reaches 80 % of `ops.budgetEur` (actual) or is forecast to reach 100 % | Cost Explorer filtered by `project`                       |

The budget filters on the **cost allocation tag** `project`: activate it once in Billing → Cost allocation tags (it
takes up to 24 h to apply), or the budget sees no spend. Its two e-mail notifications follow the same rule as the
topic: they exist only while `alert-email` is not `unset`.

The budget has **no fixed name** (CAP-69): CloudFormation generates it, because setting or changing `alert-email`
(and most other budget changes) **replaces** the budget, creating the new one before deleting the old, and a fixed
name collides. Find it in Billing → Budgets by the `Name` tag `cap-<inst>-<stage>-monthly`, or read the stack output:

```bash
aws cloudformation describe-stacks --profile <profile> --stack-name cap-<inst>-<stage>-api \
  --query "Stacks[0].Outputs[?OutputKey=='MonthlyBudgetName'].OutputValue" --output text
```

Each replacement starts a fresh budget (its history in Billing restarts); nothing else depends on it.

Log groups: every Lambda keeps its logs `ops.logRetentionDays` (config). CDK's own helper Lambda for emptying the
buckets of `dev` gets the same retention through a `LogRetention` resource, which also works on a stack deployed
before CAP-51 whose log group already exists.

## Backups (CAP-57): what is kept and how to restore

Backups are the last line against a **bug** that corrupts or wipes data, not against the user: a deleted cap is a
tombstone with its history (ADR-006), restored from the app.

| What                        | Kept                                                                                   | Where                                                 |
| --------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| Table, any second           | point-in-time recovery, last 35 days (DynamoDB PITR, on since CAP-13)                  | the table itself                                      |
| Table, daily                | AWS Backup at 03:00 UTC, `ops.backupRetentionDays` days (example: 35), no cold storage | vault `cap-<inst>-<stage>`, plan `cap-<inst>-<stage>` |
| Overwritten / deleted photo | the noncurrent version, 90 days (images bucket is versioned)                           | the images bucket (`ListObjectVersions`)              |

Cost: a table well under 1 GB costs cents a month in Backup storage; the noncurrent photos are bounded at 90 days.
On `dev` the vault is `DESTROY` like the rest of the stack, but CloudFormation cannot delete a vault that still holds
recovery points: delete them first (console, or `aws backup delete-recovery-point`) before `cdk destroy`.

**Every restore goes to a NEW table; never overwrite the live one.** Both paths below create `<live name>-restored-<date>`:

```bash
# A. Point in time (any second of the last 35 days)
aws dynamodb restore-table-to-point-in-time --profile <profile> \
  --source-table-name cap-<inst>-<stage>-table \
  --target-table-name cap-<inst>-<stage>-table-restored-<yyyymmdd> \
  --restore-date-time <ISO-8601 UTC>

# B. A daily recovery point of the vault
aws backup list-recovery-points-by-backup-vault --profile <profile> --backup-vault-name cap-<inst>-<stage>
aws backup get-recovery-point-restore-metadata --profile <profile> \
  --backup-vault-name cap-<inst>-<stage> --recovery-point-arn <arn>
aws backup start-restore-job --profile <profile> --recovery-point-arn <arn> \
  --iam-role-arn <a role with AWSBackupServiceRolePolicyForRestores, e.g. AWSBackupDefaultServiceRole> \
  --metadata '{"TargetTableName":"cap-<inst>-<stage>-table-restored-<yyyymmdd>"}'
```

The stack's selection role can only back up, not restore; the console's "Restore" creates
`AWSBackupDefaultServiceRole` the first time. A restored table has the keys and GSIs but **not** PITR, TTL, deletion protection or tags; it is not part of any
stack. Then, either:

- **Copy back what was lost** (usual case: a few items): read them from the restored table and write them to the live
  one, then delete the restored table; or
- **Repoint the API** to it: the functions read `CAP_TABLE_NAME`, which today is the `CollectorsData` table's name
  and not a config setting, so the only way is `aws lambda update-function-configuration` on each function — the
  next deploy puts the live table back. A config override for this is a follow-up (CAP-57 PR, Pending).

## Custom domains (CAP-29, once per target)

`config/<installation>.<stage>.json` → `domains: { web, api }` puts the web build on `https://<web>` and the API on
`https://<api>`. DNS stays at GoDaddy (no Route 53). The certificates are requested by hand; the stacks only read
their ARNs from SSM (`/cap/<inst>/<stage>/web-certificate-arn`, `…/api-certificate-arn`), never from the repo.
Example with `caps.example.com` and `api.caps.example.com` (replace with your hosts):

```bash
# 1. Certificates: CloudFront needs us-east-1; the regional API needs the stack's region (eu-west-1).
aws acm request-certificate --region us-east-1 --domain-name caps.example.com     --validation-method DNS
aws acm request-certificate --region eu-west-1 --domain-name api.caps.example.com --validation-method DNS
aws acm describe-certificate --region <region> --certificate-arn <arn>   # → ResourceRecord for validation
# 2. GoDaddy: add both validation CNAMEs; wait until both certificates are ISSUED.

# 3. The two certificate settings exist (`settings:bootstrap`, § Settings); fill them. Until they hold real ARNs,
#    deploy with `--context domains=off`: a certificate cannot be imported from `unset`.
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/web-certificate-arn --value '<us-east-1 cert ARN>'
aws ssm put-parameter --overwrite --name /cap/<inst>/<stage>/api-certificate-arn --value '<eu-west-1 cert ARN>'

# 4. Deploy as usual: no stack imports WebUrl since CAP-62, so no special order.
npm run deploy                     # --all
npm run deploy:web                 # prints the final web URL
```

5. GoDaddy: CNAME `caps` → output `WebDomainTarget` (`…cloudfront.net`), CNAME `api.caps` → output `ApiDomainTarget`
   (`d-….execute-api.<region>.amazonaws.com`).
6. Check: `curl https://api.caps.example.com/healthz` → 200; `https://caps.example.com` serves the SPA and signs in
   without a CORS error. The app's `VITE_API_URL` is the new `ApiUrl` output.

The API's CORS allows any origin (`*`) without credentials (CAP-62): the session is a bearer token, not a cookie, and
the iOS origin `capacitor://localhost` is not an http(s) origin, which API Gateway refuses. The images bucket keeps
an explicit list: `app_origins` + the web origin (`https://<domains.web>` with `domains`, else the CloudFront URL).

## Routes and handlers

- `lib/routes.ts` mirrors `doc/spec/openapi.yaml` (T-infra-016). A dev story that adds a handler only adds
  `api/src/handlers/<name>.ts`; the next deploy swaps the 501 stub for it. Grants and settings per handler are in the
  manifest — ask the integrator to change them.
- Until `api/src/auth/authorizer.ts` exists, every protected route is denied by a stub authorizer; without an
  `Authorization` header API Gateway answers 401 itself.
- `npm run synth -w @capcollector/infra -- -c requireAllHandlers=true` fails if any route has no handler yet (use it
  before a release).
