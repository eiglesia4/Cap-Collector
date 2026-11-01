# infra/config

One file per deployment target: `<installation>.<stage>.json`. `cdk synth` refuses any installation/stage pair
without a file here (T-infra-002), so a typo in `--context` never creates a parallel set of resources.

| Key              | Meaning                                                                                                                                                                     |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `config_version` | ISO date of the last change; tagged on every resource as `cap:config_version`                                                                                               |
| `region`         | AWS region of the deployment                                                                                                                                                |
| `app_origins`    | Optional. Origins allowed to upload images with presigned PUT (images bucket CORS), e.g. `capacitor://localhost`. The stack's own CloudFront URL (`WebUrl`) is always added |

The **account number never goes in the repo**. Declare it in `.envrc.local` as `CAP_ACCOUNT_<INSTALLATION>_<STAGE>`
(e.g. `CAP_ACCOUNT_NAEVA_DEV`); synth fails when the active profile resolves to a different account. Without the
variable or without credentials (CI) the guard stays silent, so synth keeps working on every PR.
