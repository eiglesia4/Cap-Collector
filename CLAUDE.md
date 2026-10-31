# CapCollector — colección de chapas de Edu (iPhone + Mac, AWS serverless)

App personal para registrar una colección de chapas de botella: foto → detección de duplicados por dHash → identificación con IA (Bedrock, o cualquier IA externa a mano vía _Exchange_) → revisión obligatoria → registro; y el enlace con la colección física (álbum Leuchtturm GRANDE: `álbum·hoja·bolsillo`, vista de hoja, tarjetas A4 imprimibles).

La especificación vive **fuera** del repo (carpeta `CapCollector/` en OneDrive, del arquitecto) y aquí hay una copia congelada en `doc/spec/`.

## La regla que lo gobierna todo

**El código nunca cambia el contrato.** Si una historia te obliga a cambiar `shared/src/**` (esquemas zod y tipos), `doc/spec/openapi.yaml`, el esquema de claves de DynamoDB (`doc/spec/specs/data-model.md`) o el formato `capcollector.exchange`, NO lo hagas en el código: decisión conservadora, `// SPEC-GAP CAP-<n>: …` en el código, sección **Spec deviations** del comentario de cierre en Jira, y sigue con lo especificado. Los cambios de contrato los publica el **arquitecto** (sesión Cowork).

## Dónde está la especificación (orden de precedencia)

1. `shared/src/**` (zod + tipos) · `doc/spec/openapi.yaml` — contratos.
2. `doc/spec/specs/data-model.md` — tabla única DynamoDB, GSIs, TTL.
3. `doc/spec/specs/*.md` — features, physical-link, exchange.
4. `doc/spec/design/SCREENS.md` — pantallas y navegación (canvas de diseño enlazado).
5. `doc/spec/decisions/ADR-*.md` — decisiones; `doc/spec/method.md` — este método.

## Arquitectura en una pantalla

- **Un bundle** Vite + TypeScript + Capacitor (`app/`): iPhone nativo (cámara, share sheet) y la misma web servida desde S3 para el Mac (Scan → "Upload photo"). Adaptador `app/src/platform/` para lo que depende del dispositivo.
- **API** (`api/`): Lambdas Node 22 detrás de HTTP API; un handler fino por ruta, lógica en `api/src/lib/`; DynamoDB tabla única on-demand; S3 con URLs prefirmadas (WebP ≤ 1024 px, redimensionado en el cliente); Sign in with Apple + PKCE; Bedrock detrás de `VisionAdapter` con fake de fixtures.
- **Infra** (`infra/`): CDK v2, dos stacks `CollectorsData` y `CollectorsApi`; `installation`/`stage` por contexto; sin cuentas ni ARNs en código; guarda de cuenta en `synth`. Sin VPC, sin NAT, sin cómputo permanente. Objetivo < 5 €/mes.
- **Flujo de captura** (ADR-003/004): dHash en el cliente → `POST /scans/analyse` compara con la colección (Hamming ≤ umbral) → si no hay match, IA → siempre una de tres pantallas antes de guardar: _AI review_ · _Already in collection_ (diff opt-in) · _Manual entry_.
- **Exchange** (ADR-007): bundle `photo + request.json` para una IA externa; la respuesta se valida y entra por la misma revisión con `source = external:<proveedor>`.
- **Físico** (ADR-005): `location = {kind, album, sheet, pocket}`, código `A·3·17`; un chapa por bolsillo; tarjetas insertables A4 con `pdf-lib` en el cliente.

## Invariantes

- Nada se guarda sin pasar por la revisión; ningún campo del registro se sobrescribe sin un tick explícito.
- Todo cambio escribe historia (`HIST#<ts>`, con `source`). Borrado = tombstone.
- La IA se llama solo si el dHash no encontró duplicado; con IA apagada, el flujo sigue funcionando (manual / Exchange).
- Un bolsillo, una chapa. Mover o intercambiar son operaciones explícitas con historia.
- El importador de `capcollector.exchange` acepta toda versión emitida alguna vez.
- Sin claves de IA de terceros en el servidor; sin datos personales en logs.
- Los tests nunca tocan la nube: DynamoDB Local + mock S3 (compose), Bedrock fake.

## Estructura y propiedad

```
capcollector/
├── CLAUDE.md · OWNERSHIP.md · README.md · CHANGELOG.md · TEST.md (generado)
├── doc/spec/ (copia congelada) · doc/plans/ · doc/adr/
├── shared/   zod + tipos (contratos)                 → arquitecto
├── app/      Vite + Capacitor                         → dev-app
├── api/      Lambdas                                  → dev-api
├── infra/    CDK · deploy/ compose local · .github/   → integrador
└── .claude/commands/ next · revise · handoff · integrate
```

**`OWNERSHIP.md` manda.** Un cambio que necesite dos territorios se parte en dos historias.

## Stack y convenciones

- TypeScript estricto en todo; Node 22; npm workspaces; `eslint` + `prettier` + `tsc --noEmit`; `vitest` (proyectos por workspace) con cobertura ≥ 80 % por paquete.
- Cada fichero empieza con un comentario de para qué sirve y cita la spec (`specs/exchange.md §Flow`, `ADR-004`).
- Config validada al cargar; sin valores de entorno hardcodeados. Sin shims ni compatibilidad temporal mientras no haya producción.
- Idioma: commits, PR, código, README, Jira en **inglés**; `CLAUDE.md`, `OWNERSHIP.md`, planes y `doc/spec/` como estén (inglés hoy).

## Tests

- Título con ID: `[T-<COMP>-nnn] <qué comprueba>`, `<COMP>` ∈ `shared · app · api · infra · vision · print · exchange`. Correlativo, **nunca se reutiliza**.
- `TEST.md` es generado (`npm run catalog`), se regenera en el mismo commit. Los criterios de aceptación son tests o comprobaciones explícitas.

## Git y ramas (Kanban)

| Elemento | Convención                                                                                                                        |
| -------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Rama     | `CAP-<n>-<slug>` desde `main`: `git fetch origin && git worktree add -b CAP-<n>-<slug> ../capcollector-wt/CAP-<n> origin/main`    |
| Worktree | Uno por agente; nunca dos sesiones en el mismo directorio                                                                         |
| Commit   | Inglés, imperativo: `CAP-<n>: <what>`. Autor = Edu (git config); **sin líneas de coautoría del agente**                           |
| PR       | `gh pr create --base main`; cuerpo: Done · Tests · Spec covered · Deviations. Una historia = un PR. Squash solo por el integrador |
| Hooks    | `.githooks/pre-push` rechaza push a `main` (`CAP_ALLOW_DIRECT_PUSH=1` escotilla); `pre-commit` con gitleaks. Nunca `--no-verify`  |
| Releases | Tag por hito: `v0.1.0-v0` · `v0.2.0-v1` · `v0.5.0-v2` · `v0.8.0-v3` · `v1.0.0-v4` + `CHANGELOG.md`                                |

## Cómo se trabaja (Cowork → Jira → agentes Code → integrador)

- **Fuente de estado: Jira `CAP`.** Columnas Backlog · **Ready** · In Progress · In Review · Blocked · Done. Un agente solo coge historias en Ready de su territorio (`labels = area-<agente sin dev->`). Ready = puede empezar ahora; las dependencias van en enlaces _is blocked by_ y las comprueba `/next`; `/integrate` pasa a Ready las desbloqueadas.
- `/next` · `/revise CAP-<n>` · `/handoff` · `/integrate [--auto] [--release <tag>]`.
- Comentario de cierre (inglés, lo lee el dashboard): `[cap-status] agent=<nombre> ticket=CAP-<n> state=<in_progress|in_review|blocked|done>` + **Done · Tests · Spec deviations · Pending · PR · Needs human**. Etiqueta `needs-human` cuando espera a Edu.
- Orden de arranque: integrador primero (`/next` de su historia `area-infra`, luego `/integrate`); los devs cuando el informe diga qué quedó Ready. WIP: 2 devs + 1 en revisión.
- Historias grandes: plan en `doc/plans/CAP-<n>-<slug>.md`.

## Comandos habituales

```bash
npm ci && npm test && npm run lint && npm run catalog
docker compose -f deploy/docker-compose.yaml up -d      # DynamoDB Local + S3 mock
npm run db:create                                        # tabla local desde la definición compartida
npm -w app run dev                                       # web en el navegador
npm -w app run ios                                       # cap sync + abre Xcode
cd infra && npx cdk synth --context installation=naeva --context stage=dev   # despliega Edu, nunca un agente
```

## Configuración de Claude Code (una vez)

```bash
claude mcp add --transport http atlassian https://mcp.atlassian.com/v1/mcp
brew install direnv && cp .envrc.local.example .envrc.local   # CAP_AGENT, JIRA_*
direnv allow && git config core.hooksPath .githooks
```
