# OWNERSHIP.md — quién escribe dónde

Regla: **cada agente o persona escribe solo en sus rutas.** Un PR que toque rutas de otro dueño necesita su aprobación (CODEOWNERS) y, si el cambio es de contrato, pasa antes por el arquitecto. Una historia que necesite dos territorios se parte en dos.

| Ruta                                                                                                                                          | Dueño                        | Agente (`CAP_AGENT`) | Etiqueta Jira      | Notas                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------- | -------------------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/src/**` · `doc/spec/**` (incl. `openapi.yaml`, esquema de claves DynamoDB)                                                            | **Arquitecto** (Cowork, Edu) | `architect`          | `design`           | Contratos: Cap, Location, Exchange v1. Solo cambian por versión nueva publicada desde Cowork                                            |
| `app/**` (salvo `app/package.json`)                                                                                                           | App                          | `dev-app`            | `area-app`         | UI Vite + Capacitor, dHash en cliente, PDF de tarjetas, paquetes de exchange, adaptador `platform/`, y sus tests                        |
| `api/**` (salvo `api/package.json`)                                                                                                           | API                          | `dev-api`            | `area-api`         | Handlers Lambda, acceso a DynamoDB, llamada a Bedrock, URLs prefirmadas, auth, y sus tests                                              |
| `infra/**` · `deploy/**`                                                                                                                      | Infra                        | `dev-infra`          | `area-infra`       | CDK (CollectorsData · CollectorsApi), scripts de despliegue, y sus tests. Despliega Edu, nunca el agente (desde CAP-34, 2026-11-07)     |
| `.github/**` · `.githooks/**` · `tools/**`                                                                                                    | **Integrador**               | `integrator`         | `area-integration` | CI, hooks, catálogo de tests. Nadie más toca CI                                                                                         |
| `package.json` · `package-lock.json` · `*/package.json` · `tsconfig.base.json` · `vitest.config.ts` · `eslint.config.js` · `.prettierrc.json` | Integrador                   | `integrator`         | `area-integration` | Un agente que necesite una dependencia nueva la **pide** en _Pending_ del comentario Jira o en una historia aparte; no edita el fichero |
| `main` · `CHANGELOG.md` · `TEST.md` · tags de release                                                                                         | Integrador                   | `integrator`         | —                  | `TEST.md` es generado (cada dev lo regenera en su PR con `npm run catalog`); `CHANGELOG.md` lo cierra el integrador                     |
| `CLAUDE.md` · `OWNERSHIP.md` · `.claude/commands/**` · `doc/plans/_PLANTILLA.md` · `doc/adr/**`                                               | Arquitecto + Edu             | `architect`          | `design`           | Cambios de método, no de código                                                                                                         |
| `doc/plans/CAP-<n>-*.md`                                                                                                                      | El agente de la historia     | —                    | —                  | Plan de historias grandes                                                                                                               |

## Cómo se aplica en una sesión

1. `CAP_AGENT` (en `.envrc.local`) dice quién eres; `/next` solo elige historias con la etiqueta de tu territorio (columna «Etiqueta Jira»).
2. Antes de editar, el agente comprueba la ruta contra esta tabla. Si la historia le obliga a salir de su territorio, no edita: lo anota en **Pending** y, si bloquea, pone la etiqueta `needs-human`.
3. `.github/CODEOWNERS` es la versión mecánica de esta tabla: GitHub exige la aprobación del dueño cuando un PR cruza fronteras.
4. Excepción: la historia de arranque (CAP-11) escribe en todas las rutas; desde su merge rige esta tabla.

## Mapa de etiquetas Jira

`area-app` · `area-api` · `area-infra` · `area-integration` (dependencias, CI, housekeeping: las hace el integrador con `/next`) · `design` (la resuelve el arquitecto) · `needs-human` (aparece en el dashboard de Edu) · `deliverable-V0…V4` · `cap-<epic slug>`.
