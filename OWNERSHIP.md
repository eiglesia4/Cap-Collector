# OWNERSHIP.md — quién escribe dónde

Regla: **cada agente o persona escribe solo en sus rutas.** Un PR que toque rutas de otro dueño necesita su aprobación (CODEOWNERS) y, si es de contrato, pasa antes por el arquitecto. Una historia que necesite dos territorios se parte en dos.

| Ruta                                                                                                                                           | Dueño                        | `CAP_AGENT`  | Notas                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/**` · `doc/spec/**`                                                                                                                    | **Arquitecto** (Cowork, Edu) | `architect`  | Contratos: esquemas zod/tipos, OpenAPI, modelo de datos, formato exchange. Solo cambian por versión publicada desde Cowork                   |
| `app/**`                                                                                                                                       | Dev app                      | `dev-app`    | UI Vite + Capacitor, `platform/`, dHash en cliente (`app/src/vision/`), PDF de tarjetas, bundles de Exchange, tests `app/test/**`            |
| `api/**`                                                                                                                                       | Dev API                      | `dev-api`    | Lambdas, repositorio DynamoDB, presigned S3, auth Apple, `VisionAdapter` Bedrock, tests `api/test/**`                                        |
| `infra/**` · `deploy/**` · `.github/**` · `.githooks/**`                                                                                       | **Integrador / Edu**         | `integrator` | CDK, compose local, CI, hooks. Nadie más los toca                                                                                            |
| `package.json` raíz · `package-lock.json` · `app/package.json` · `api/package.json` · `infra/package.json` · `CHANGELOG.md` · `TEST.md` · tags | Integrador                   | `integrator` | Un dev que necesite una dependencia la **pide** en _Pending_ del comentario Jira; el integrador la agrupa en una historia `area-infra` corta |
| `CLAUDE.md` · `OWNERSHIP.md` · `.claude/commands/**`                                                                                           | Arquitecto + Edu             | `architect`  | Cambios de método, no de código                                                                                                              |
| `doc/plans/**`                                                                                                                                 | El agente de la historia     | —            | Un plan por historia grande                                                                                                                  |

## Cómo se aplica

1. `CAP_AGENT` (en `.envrc.local`) dice quién eres; `/next` solo elige historias con etiqueta `area-<agente sin dev->`.
2. Antes de editar, comprueba la ruta en esta tabla. Fuera de tu territorio no edites: anótalo en **Pending** y, si bloquea, etiqueta `needs-human`.
3. `.github/CODEOWNERS` es la versión mecánica.

## Etiquetas Jira

`area-app` · `area-api` · `area-infra` · `design` (la resuelve el arquitecto) · `needs-human` (dashboard de Edu) · `deliverable-V0…V4` · `cap-<epic>`.
