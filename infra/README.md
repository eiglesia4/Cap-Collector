# infra — AWS CDK v2 (CollectorsData · CollectorsApi)

Owned by the integrator (OWNERSHIP.md). **Deploying is Edu's job, never an agent's.** Targets and profiles:
CONVENTIONS.md § Deployment targets; per-target settings: [`config/`](config/README.md).

| Stack            | What                                                                                                                                       | Story                          |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ |
| `CollectorsData` | images + web buckets, CloudFront (+ `domains.web`), the DynamoDB single table, the SSM settings                                            | CAP-13, CAP-15, CAP-29         |
| `CollectorsApi`  | HTTP API (+ `domains.api`), one Lambda per `api/src/handlers/*.ts` routed by [`lib/routes.ts`](lib/routes.ts), authorizer, alarms + budget | CAP-15, CAP-29, CAP-40, CAP-51 |

## Deploy (Edu)

```bash
export CAP_INSTALLATION=naeva CAP_STAGE=dev AWS_PROFILE=naevatecdev   # .envrc.local does this
npm run diff                       # from the repo root (builds shared first)
npm run deploy                     # CollectorsData first, then CollectorsApi
```

**First deploy of `CollectorsApi`:** `CollectorsData` creates its SSM parameters with the value `unset`; the API
reads them at deploy time and must refuse `unset`. Fill them before relying on Sign in with Apple (CAP-19), then run
`npm run deploy` again so CloudFormation resolves the new values:

```bash
aws ssm put-parameter --overwrite --name /cap/naeva/dev/allowed-apple-subs --value '<apple sub>'
aws ssm put-parameter --overwrite --name /cap/naeva/dev/apple-client-ids  --value 'com.naevatec.collectors,<web service id>'
aws ssm put-parameter --overwrite --name /cap/naeva/dev/session-secret    --value "$(openssl rand -base64 48)"
```

**Alerts (CAP-40):** `CollectorsApi` creates the topic `cap-<inst>-<stage>-alerts` and an alarm when Bedrock is
invoked more than 300 times in a day (cost guard). The e-mail comes from `/cap/<inst>/<stage>/alert-email`; while it is
`unset` the topic has no subscription. Set it, redeploy `CollectorsApi`, and confirm the e-mail AWS sends:

```bash
aws ssm put-parameter --overwrite --name /cap/naeva/dev/alert-email --value '<your e-mail>'
```

**Bedrock model (CAP-40):** `ai.modelId` in `config/<inst>.<stage>.json`. Check what the region offers (and enable
model access in the Bedrock console once); in eu-west-1 recent Claude models come as `eu.` inference profiles:

```bash
aws bedrock list-inference-profiles --region eu-west-1 --query "inferenceProfileSummaries[?contains(inferenceProfileId,'haiku')].inferenceProfileId"
aws bedrock list-foundation-models  --region eu-west-1 --by-output-modality TEXT --query "modelSummaries[?contains(modelId,'haiku')].modelId"
```

CloudFormation leaves these values alone as long as the parameter definitions in `collectors-data-stack.ts` do not
change; if one ever does, the parameter is reset to `unset` and has to be filled again.

## Operations (CAP-51): what fires when

Every alarm notifies the topic `cap-<inst>-<stage>-alerts`, so it reaches the `alert-email` above (nothing is sent
while it is `unset`). Missing data never fires (`notBreaching`). Thresholds live in [`lib/ops.ts`](lib/ops.ts).

| Alarm / budget                                    | Fires when                                                                                            | Look first at                                             |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `cap-<inst>-<stage>-api-5xx`                      | the HTTP API returns ≥ 5 `5xx` in 5 min                                                               | the log groups of the functions behind the failing routes |
| `cap-<inst>-<stage>-lambda-errors-<n>`            | any one function of that group has ≥ 3 `Errors` in 5 min (groups of ≤ 9; the description lists them)  | that function's log group                                 |
| `cap-<inst>-<stage>-dynamodb-throttles`           | the table records ≥ 1 read or write throttle event in 5 min                                           | a hot partition or a runaway client (on-demand table)     |
| `cap-<inst>-<stage>-authorizer-throttles`         | the authorizer is throttled at least once in 5 min                                                    | account Lambda concurrency, a client retry loop           |
| `cap-<inst>-<stage>-bedrock-invocations` (CAP-40) | more than 300 Bedrock invocations of `ai.modelId` in a day                                            | Scan items: is the dHash check being skipped?             |
| AWS Budget `cap-<inst>-<stage>-monthly`           | spend tagged `project=EIM_CAP` reaches 80 % of `ops.budgetEur` (actual) or is forecast to reach 100 % | Cost Explorer filtered by `project`                       |

The budget filters on the **cost allocation tag** `project`: activate it once in Billing → Cost allocation tags (it
takes up to 24 h to apply), or the budget sees no spend. Its two e-mail notifications follow the same rule as the
topic: they exist only while `alert-email` is not `unset`.

Log groups: every Lambda keeps its logs `ops.logRetentionDays` (config). CDK's own helper Lambda for emptying the
buckets of `dev` gets the same retention through a `LogRetention` resource, which also works on a stack deployed
before CAP-51 whose log group already exists.

## Custom domains (CAP-29, once per target)

`config/<installation>.<stage>.json` → `domains: { web, api }` puts the web build on `https://<web>` and the API on
`https://<api>`. DNS stays at GoDaddy (no Route 53). The certificates are requested by hand; the stacks only read
their ARNs from SSM (`/cap/<inst>/<stage>/web-certificate-arn`, `…/api-certificate-arn`), never from the repo.
Example for naeva/dev (`caps.naevatec.com`, `api.caps.naevatec.com`):

```bash
# 1. Certificates: CloudFront needs us-east-1; the regional API needs the stack's region (eu-west-1).
aws acm request-certificate --region us-east-1 --domain-name caps.naevatec.com     --validation-method DNS
aws acm request-certificate --region eu-west-1 --domain-name api.caps.naevatec.com --validation-method DNS
aws acm describe-certificate --region <region> --certificate-arn <arn>   # → ResourceRecord for validation
# 2. GoDaddy: add both validation CNAMEs; wait until both certificates are ISSUED.

# 3. Only the first time: create the two `unset` parameters without turning the domains on (a stack cannot read
#    a parameter it creates in the same deploy).
npm run cdk -w @capcollector/infra -- deploy -e CollectorsData \
  --context installation=$CAP_INSTALLATION --context stage=$CAP_STAGE --context domains=off
aws ssm put-parameter --overwrite --name /cap/naeva/dev/web-certificate-arn --value '<us-east-1 cert ARN>'
aws ssm put-parameter --overwrite --name /cap/naeva/dev/api-certificate-arn --value '<eu-west-1 cert ARN>'

# 4. Deploy order the first time domains are on: the API first (drops its import of WebUrl), then the data stack
#    (changes the WebUrl export). CloudFormation refuses to change an export another stack still imports.
npm run cdk -w @capcollector/infra -- deploy -e CollectorsApi  --context installation=$CAP_INSTALLATION --context stage=$CAP_STAGE
npm run cdk -w @capcollector/infra -- deploy -e CollectorsData --context installation=$CAP_INSTALLATION --context stage=$CAP_STAGE
npm run deploy                     # --all, as usual from now on
npm run deploy:web                 # prints the final web URL
```

5. GoDaddy: CNAME `caps` → output `WebDomainTarget` (`…cloudfront.net`), CNAME `api.caps` → output `ApiDomainTarget`
   (`d-….execute-api.<region>.amazonaws.com`).
6. Check: `curl https://api.caps.naevatec.com/healthz` → 200; `https://caps.naevatec.com` serves the SPA and signs in
   without a CORS error. The app's `VITE_API_URL` is the new `ApiUrl` output.

With `domains` set, the API's CORS origins are `app_origins` + `https://<domains.web>` from config (no import); without
it, the CloudFront `WebUrl` is imported from CollectorsData (CAP-27). The default `*.cloudfront.net` and
`execute-api` URLs keep working, but only the custom web origin is allowed by CORS.

## Routes and handlers

- `lib/routes.ts` mirrors `doc/spec/openapi.yaml` (T-infra-016). A dev story that adds a handler only adds
  `api/src/handlers/<name>.ts`; the next deploy swaps the 501 stub for it. Grants and settings per handler are in the
  manifest — ask the integrator to change them.
- Until `api/src/auth/authorizer.ts` exists, every protected route is denied by a stub authorizer; without an
  `Authorization` header API Gateway answers 401 itself.
- `npm run synth -w @capcollector/infra -- -c requireAllHandlers=true` fails if any route has no handler yet (use it
  before a release).
