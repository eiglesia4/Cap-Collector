# infra — AWS CDK v2 (CollectorsData · CollectorsApi)

Owned by the integrator (OWNERSHIP.md). **Deploying is Edu's job, never an agent's.** Targets and profiles:
CONVENTIONS.md § Deployment targets; per-target settings: [`config/`](config/README.md).

| Stack            | What                                                                                                                      | Story                  |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `CollectorsData` | images + web buckets, CloudFront (+ `domains.web`), the DynamoDB single table, the SSM settings                           | CAP-13, CAP-15, CAP-29 |
| `CollectorsApi`  | HTTP API (+ `domains.api`), one Lambda per `api/src/handlers/*.ts` routed by [`lib/routes.ts`](lib/routes.ts), authorizer | CAP-15, CAP-29         |

## Deploy (Edu)

```bash
export CAP_INSTALLATION=naeva CAP_STAGE=dev AWS_PROFILE=naevatecdev   # .envrc.local does this
npm run diff                       # from the repo root (builds shared first)
npm run deploy                     # CollectorsData first, then CollectorsApi
```

**First deploy of `CollectorsApi`:** `CollectorsData` creates three SSM parameters with the value `unset`; the API
reads them at deploy time and must refuse `unset`. Fill them before relying on Sign in with Apple (CAP-19), then run
`npm run deploy` again so CloudFormation resolves the new values:

```bash
aws ssm put-parameter --overwrite --name /cap/naeva/dev/allowed-apple-subs --value '<apple sub>'
aws ssm put-parameter --overwrite --name /cap/naeva/dev/apple-client-ids  --value 'com.naevatec.collectors,<web service id>'
aws ssm put-parameter --overwrite --name /cap/naeva/dev/session-secret    --value "$(openssl rand -base64 48)"
```

CloudFormation leaves these values alone as long as the parameter definitions in `collectors-data-stack.ts` do not
change; if one ever does, the parameter is reset to `unset` and has to be filled again.

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
