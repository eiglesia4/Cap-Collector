# infra — AWS CDK v2 (CollectorsData · CollectorsApi)

Owned by the integrator (OWNERSHIP.md). **Deploying is Edu's job, never an agent's.** Targets and profiles:
CONVENTIONS.md § Deployment targets; per-target settings: [`config/`](config/README.md).

| Stack            | What                                                                                                                    | Story          |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------- |
| `CollectorsData` | images + web buckets, the DynamoDB single table, the API's SSM settings                                                 | CAP-13, CAP-15 |
| `CollectorsApi`  | HTTP API, one Lambda per `api/src/handlers/*.ts` routed by [`lib/routes.ts`](lib/routes.ts), Lambda authorizer, outputs | CAP-15         |

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

## Routes and handlers

- `lib/routes.ts` mirrors `doc/spec/openapi.yaml` (T-infra-016). A dev story that adds a handler only adds
  `api/src/handlers/<name>.ts`; the next deploy swaps the 501 stub for it. Grants and settings per handler are in the
  manifest — ask the integrator to change them.
- Until `api/src/auth/authorizer.ts` exists, every protected route is denied by a stub authorizer; without an
  `Authorization` header API Gateway answers 401 itself.
- `npm run synth -w @capcollector/infra -- -c requireAllHandlers=true` fails if any route has no handler yet (use it
  before a release).
