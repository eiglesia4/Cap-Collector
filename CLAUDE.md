# capcollector — colección de chapas con captura asistida por IA (Edu · Naevatec)

Este repositorio implementa **CapCollector**: una app personal para catalogar una colección de chapas de botella (iPhone primero, Mac/web después) con un flujo de captura asistido por IA, detección de duplicados antes de gastar en IA y un vínculo con la colección física (álbum Leuchtturm GRANDE, `A·3·17`). Bundle ID `com.naevatec.collectors`.

Se construye contra una especificación que vive **fuera** del repo (carpeta `CapCollector/` en OneDrive) y de la que aquí hay una copia congelada en `doc/spec/`.

## La regla que lo gobierna todo

**El código nunca cambia el contrato.** Si una historia te obliga a cambiar los tipos compartidos (`shared/src/**`: Cap, Location, Exchange v1), el OpenAPI (`doc/spec/openapi.yaml`), el esquema de claves de DynamoDB (`doc/spec/specs/data-model.md`) o el diseño, NO lo hagas en el código: toma la decisión más conservadora, márcala en el código con `// SPEC-GAP CAP-<n>: …`, recógela en la sección **Spec deviations** del comentario de cierre en Jira y sigue con lo que sí está especificado. Los cambios de spec los resuelve el **arquitecto** (sesión de diseño en Cowork), que publica una nueva versión.

## Dónde está la especificación

Orden de precedencia (si dos documentos se contradicen, gana el de arriba):

1. `shared/src/**` (zod + tipos TS) y `doc/spec/openapi.yaml` — los contratos app ↔ api (los publica el arquitecto en EP-01; hoy `shared/` está vacío y no hay OpenAPI).
2. `doc/spec/specs/data-model.md` — tabla única de DynamoDB: PK/SK, GSIs, enums. **Nunca inventes claves.**
3. `doc/spec/decisions/ADR-*.md` — decisiones de arquitectura (ADR-001 Capacitor · 002 serverless · 003 revisión con tres salidas · 004 dHash antes que IA · 005 álbum·hoja·bolsillo · 006 borrado lógico e historial · 007 intercambio con IA externa).
4. `doc/spec/specs/{features,exchange,physical-link}.md` y `doc/spec/design/SCREENS.md` — funcionalidad, formato `capcollector.exchange`, álbum físico, pantallas y navegación.
5. `doc/spec/CONVENTIONS.md` — vocabulario, identificadores, reglas de coste.
6. `doc/spec/method.md` — cómo trabajan el arquitecto, los agentes de desarrollo y el integrador (este fichero es su resumen operativo).

Versión viva, si existe en esta máquina: `$CAP_DOCS` (lo exporta `.envrc` apuntando a `…/MisProyectosOneDrive/CapCollector/docs`). **Lee primero `doc/spec/`; si `$CAP_DOCS` tiene una versión más nueva, anótalo en el comentario de Jira antes de usarla.** `doc/spec/README.md` dice cuándo se copió.

## Arquitectura en una pantalla

- **Cliente** (`app/`): un único bundle Vite + TypeScript; en iPhone envuelto con Capacitor (App Store), en Mac servido estático desde S3 (+ CloudFront opcional). En escritorio «Scan» pasa a «Upload photo» (ADR-001).
- **Captura** (ADR-003/004): foto → recorte → **dHash de 64 bits en el cliente** → Lambda compara con todos los hashes guardados (Hamming ≤ umbral) → si hay casi-coincidencia, «Already in collection» **sin llamar a la IA**; si no, Bedrock (visión, clase Haiku) → segunda comprobación por `brand + variant` normalizados. Toda captura termina en una de tres pantallas antes de guardar: **AI review · Already in collection · Manual entry** (un mismo formulario, modos `ai-prefilled | empty | edit`).
- **API** (`api/`): Lambda (Node 22, TS) detrás de API Gateway HTTP API; un handler por ruta, `lib/` compartida; URLs prefirmadas para subir imágenes WebP ≤ 1024 px; auth con Sign in with Apple + PKCE (sin Cognito).
- **Datos** (`infra/`, stack `CollectorsData`): S3 (imágenes + web) y **DynamoDB de tabla única** on-demand; historial append-only `HIST#<ts>`; borrado lógico con tombstones; GSI de ubicación `LOC#<albumId>#<sheet>` y de marca `BRAND#<normalised>`.
- **Intercambio** (ADR-007): paquete `request.zip` (fotos + `request.json`, `format = capcollector.exchange`, `version` entero) para cualquier IA externa a mano; la respuesta subida se valida y entra en la misma revisión con `source = external:<provider>`.
- **Físico** (ADR-005): `location = { kind: album|box|frame, album, sheet?, pocket? }`, código `A·3·17`, hoja 6 × 7, tarjetas insertables en PDF generadas en cliente.

## Invariantes que no se negocian

- Nada se guarda sin pasar por una de las tres pantallas de revisión; nada de un registro existente se sobrescribe sin un tick explícito.
- La IA (Bedrock) se llama **solo** si la comprobación local de dHash no encuentra casi-coincidencia.
- Todo cambio en un registro escribe historial (quién/qué/cuándo/`source`). Borrado = tombstone, nunca físico.
- `capId` es ULID y nunca se reutiliza. El importador de exchange acepta **todas** las versiones emitidas.
- Nunca se guardan claves de API de IAs de terceros: el camino externo es manual y gratuito.
- Serverless y barato (≈ 2–5 €/mes): sin VPC, sin NAT, sin cómputo siempre encendido.
- Las claves de DynamoDB son las de `data-model.md`; los contratos son los de `shared/`. Un cambio incompatible es una versión nueva del arquitecto.

## Estructura del repositorio y propiedad

```
capcollector/
├── CLAUDE.md · OWNERSHIP.md · README.md · CHANGELOG.md · TEST.md (generado)
├── doc/spec/ (copia congelada) · doc/plans/ (historias grandes) · doc/adr/
├── shared/   contratos: zod + tipos (Cap, Location, Exchange v1)   → arquitecto
├── app/      Vite + TS (+ Capacitor) · UI, dHash cliente, PDF       → dev-app
├── api/      Lambdas TS · DynamoDB · Bedrock · prefirmadas · auth   → dev-api
├── infra/    CDK v2: CollectorsData · CollectorsApi                 → integrador / Edu
├── tools/    catálogo de tests (TEST.md)                            → integrador
├── .claude/commands/ next · revise · handoff · integrate
└── .github/ CI · CODEOWNERS      .githooks/ pre-commit · pre-push
```

**`OWNERSHIP.md` manda:** cada agente escribe solo en sus rutas. `shared/src/**` y `doc/spec/**` son del arquitecto; nadie más los edita. Un cambio que necesite dos territorios se parte en dos historias.

## Stack y convenciones de código

- **Un solo lenguaje, npm workspaces** (`shared`, `app`, `api`, `infra`): Node 22, TypeScript estricto (`tsconfig.base.json`: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`), ESM. Una dependencia nueva la añade el integrador (el `package.json` raíz y los de cada workspace son suyos); el dev la **pide** en _Pending_.
- `eslint` (flat config raíz, `typescript-eslint`) + `prettier` + `tsc --noEmit` por workspace. `vitest` en la raíz con un proyecto por workspace (+ `tools`).
- `app/`: componentes en PascalCase, ficheros en kebab-case; código solo-Capacitor detrás de un adaptador fino `platform/` para que el build web lo pruebe; claves i18n desde el día uno (copy en inglés primero).
- `api/`: un handler por ruta en `src/handlers/`, lógica en `src/lib/`; DynamoDB detrás de un repositorio con interfaz; Bedrock detrás de un adaptador.
- `infra/`: CDK v2 TS; `installation` y `stage` por contexto; región en `infra/config/<installation>.<stage>.json`; **ninguna cuenta, ARN ni región en código**; guarda de cuenta en `synth` como en CCS_MRV (`CAP_ACCOUNT_<INST>_<STAGE>` en `.envrc.local`).
- Cada fichero fuente empieza con un comentario breve de para qué sirve. Los comentarios citan la spec (`ADR-004`, `exchange.md § Flow`) y decisiones (`decidido en CAP-<n>, 2026-11-02`).
- Sin valores de entorno hardcodeados: config validada al cargar, overridable por variables.
- Mientras no haya producción: cambios limpios, sin shims ni compatibilidad temporal.
- Secretos y datos personales fuera de los logs.

## Herramientas locales (sin Docker)

Proyecto de un solo lenguaje y una sola persona: todo corre con el toolchain local (`npm ci` en la raíz). Docker solo como respaldo del hook de `gitleaks` si el binario no está instalado. Los tests no tocan la nube: DynamoDB Local o repositorio en memoria detrás de una interfaz, S3 simulado, Bedrock con fixtures.

## Tests

- Todo test lleva ID al inicio del título: `[T-<comp>-nnn] <qué comprueba>`, con `<comp>` ∈ `app · api · shared · infra · vision · print · exchange`. Numeración correlativa por componente, **nunca se reutiliza** un ID.
- `TEST.md` es **generado** (`npm run catalog`, que recorre `vitest list`), no se edita a mano; se regenera en el mismo commit que añade o quita tests. El catálogo falla si un test no lleva ID, usa un componente desconocido o repite un ID; la CI ejecuta `npm run catalog:check`.
- Los criterios de aceptación de la historia son tests o comprobaciones explícitas. Incluye los rechazos (duplicado → sin llamada a IA, exchange con `format` desconocido → rechazado…).
- Cobertura mínima 80 % (líneas, ramas, funciones); una ejecución por debajo falla.
- Tests nunca tocan la nube ni Internet.

## Git y ramas (Kanban, sin sprints)

| Elemento      | Convención                                                                                                                                                                                                           |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Rama          | `CAP-<n>-<slug-corto>` **desde `main`**: `git fetch origin && git switch -c CAP-<n>-<slug> --no-track origin/main && git push -u origin CAP-<n>-<slug>`                                                              |
| Worktree      | **Un worktree por agente**, nunca dos sesiones sobre el mismo directorio: `git worktree add ../capcollector-wt/CAP-<n> CAP-<n>-<slug>`                                                                               |
| Commit        | Inglés, imperativo: `CAP-<n>: <what>`; el cuerpo cita secciones de spec e IDs de test. Una historia = un PR; sin mezclar historias. **Autor = Edu** (`git config` de la máquina); sin líneas de coautoría del agente |
| Commit sin OK | El agente commitea y abre el PR por su cuenta; **el GO lo da la revisión del PR** (Edu). Nunca commit directo en `main`                                                                                              |
| PR            | `gh pr create --base main`; título = commit; **cuerpo en inglés**: Done · Tests · Spec covered · Deviations. Un PR por historia. Squash merge solo por el integrador                                                 |
| Hooks         | `.githooks/pre-push` rechaza push directo a `main` (`CAP_ALLOW_DIRECT_PUSH=1` como escotilla, solo integrador); pre-commit con `gitleaks`. Nunca `--no-verify`                                                       |
| Releases      | Tag en `main` por hito: `v0.1.0-v0`, `v0.2.0-v1`, `v0.5.0-v2`, `v0.8.0-v3`, `v1.0.0-v4` + `CHANGELOG.md` (lo cierra el integrador)                                                                                   |

## Cómo se trabaja aquí (Cowork → Jira → agentes Code → integrador)

- **Fuente de estado: Jira `CAP`** (site `naevatec.atlassian.net`). Columnas Backlog · **Ready** · In Progress · In Review · Blocked · Done. Un agente solo coge historias en **Ready** (el arquitecto las pone ahí con spec referenciada, rutas permitidas, IDs de test y criterios). Rank = orden.
- **Ready significa «puede empezar ahora»**: una historia con dependencias pendientes se queda en Backlog con enlaces _is blocked by_; `/integrate` pasa a Ready las bloqueadas cuyo último bloqueador acaba de entrar en `main`. `/next` comprueba los enlaces antes de coger nada.
- **Territorio → etiqueta**: `CAP_AGENT=dev-app` → `area-app` · `dev-api` → `area-api` · `integrator` → `area-infra`. `/next` solo mira la etiqueta de su territorio.
- `/next` coge la siguiente historia Ready de su territorio, la pasa a In Progress, crea rama + worktree, implementa contra la spec, tests, PR, comenta en Jira y la deja en In Review. `/revise CAP-<n>` aplica a un PR abierto lo que pide el último comentario del arquitecto o del integrador. `/handoff` cierra una sesión a medias. `/integrate` (integrador) rebasea, pasa los checks completos, mergea lo verde con el GO de Edu y desbloquea las historias enlazadas.
- **Orden de arranque de una tanda**: primero el integrador (`/next` de su historia `area-infra` si la hay, luego `/integrate`), y los devs solo cuando `/integrate` haya informado de qué historias ha desbloqueado.
- **Comentario de cierre en Jira** (en inglés) con secciones fijas (las lee el dashboard): primera línea `[cap-status] agent=<nombre> ticket=CAP-<n> state=<in_progress|in_review|blocked|done>`, y después **Done · Tests · Spec deviations · Pending · PR · Needs human** (yes/no + why). La etiqueta `needs-human` es lo que aparece en el dashboard de Edu.
- WIP: 2 devs activos + 1 en revisión (una sola persona revisa).
- Historias grandes (>1 día o con decisiones): plan en `doc/plans/CAP-<n>-<slug>.md` (plantilla `_PLANTILLA.md`). Las pequeñas, solo el comentario Jira.
- Idioma: commits, PR, código, README y Jira en **inglés**; `CLAUDE.md`, `OWNERSHIP.md`, `.claude/commands/` y `doc/plans/` en **español**; `doc/spec/` tal como lo publica el arquitecto (inglés).

## Comandos habituales

```bash
npm ci                    # instala todos los workspaces
npm test                  # vitest de todos los workspaces + cobertura ≥ 80 %
npm run lint              # eslint + prettier --check
npm run typecheck         # tsc --noEmit por workspace (+ tools)
npm run catalog           # regenera TEST.md   (catalog:check en CI)
npm run synth             # cdk synth naeva/dev, sin credenciales
npm run dev -w @capcollector/app    # servidor Vite local
# despliegue: lo hace Edu, nunca un agente
cd infra && npx cdk deploy --all --context installation=naeva --context stage=dev
```

## Configuración de Claude Code (una vez)

```bash
claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp
brew install direnv gitleaks && echo 'eval "$(direnv hook zsh)"' >> ~/.zshrc
cd <repo> && cp .envrc.local.example .envrc.local   # JIRA_TOKEN, CAP_AGENT
direnv allow && git config core.hooksPath .githooks
```
