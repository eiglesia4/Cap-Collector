---
description: Coge la siguiente historia Ready de Jira CAP de tu territorio, la implementa contra la spec en el worktree del agente y abre el PR
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, mcp__atlassian__*, mcp__jira__*
---

Trabaja la siguiente historia del Kanban de CapCollector. Sigue los pasos en orden y no te saltes ninguno. Tu identidad es `$CAP_AGENT` (si no está definido, para y pídelo).

**Tu worktree (fijo).** Si eres `dev-*`, trabajas siempre en `../capcollector-wt/$CAP_AGENT` (lo crea Edu con `.claude/scripts/agent-worktrees.sh`): comprueba que `basename "$(git rev-parse --show-toplevel)"` es `$CAP_AGENT`; si no, **para** y dilo. El `integrator` trabaja en el checkout principal y, en sus historias, crea la rama ahí mismo y vuelve a `main` al acabar en vez de aparcar en detached. Nunca trabajes en el worktree de otro agente; un dev nunca trabaja en el checkout principal. En reposo tu worktree está en **detached HEAD sobre `origin/main`** y limpio.

1. **Elegir la historia.** Tu etiqueta de territorio sale de `$CAP_AGENT`: `dev-app` → `area-app` · `dev-api` → `area-api` · `dev-infra` → `area-infra` · `integrator` → `area-integration` (cualquier otro valor: para y dilo). Con el MCP de Atlassian (site `naevatec.atlassian.net`), busca:
   `project = CAP AND status = "Ready" AND issuetype != Epic AND labels = <tu etiqueta> ORDER BY Rank ASC`
   (si el MCP se come las comillas, usa `statusCategory = 2` y filtra `Ready` al leer). Si el usuario pasó `$ARGUMENTS`, usa esa clave (y comprueba que lleva tu etiqueta; si no, para).
   Salta las que lleven `design` (las resuelve el arquitecto) o `needs-human` (esperan a Edu). **Nunca cojas una historia de otra etiqueta**, aunque no quede ninguna de la tuya.
   **Sin "go" por sesión:** la columna Ready ya es el go. Resume en cinco líneas qué vas a hacer y arranca.

   **Guarda de dependencias (obligatoria, antes de arrancar):** lee la historia con sus enlaces (`issuelinks`). Si tiene algún enlace _is blocked by_ cuya historia **no** esté en Done, **no la cojas**: comenta en Jira `[cap-status] agent=$CAP_AGENT ticket=CAP-<n> state=blocked` + "Waiting for CAP-<m> (<status>)", pásala a "Backlog" con "Send back" si estaba en Ready por error, y pasa a la siguiente candidata; si no queda ninguna, dilo al usuario y para (no inventes trabajo). Haz además `git fetch origin` y comprueba que `origin/main` contiene los merges que la historia declara en «Blocked until»; si no, mismo tratamiento.

2. **Leer la especificación referenciada.** La historia cita secciones ("Spec: ADR-004; specs/exchange.md § Flow"). Ábrelas en `doc/spec/` (y en `$CAP_DOCS` si hay versión más nueva; si difiere, anótalo para el comentario final). Lee `CLAUDE.md` (invariantes) y `OWNERSHIP.md` (tus rutas). **No implementes desde el resumen de la historia.**

3. **Arrancar.** Pasa la historia a "In Progress" y comenta en Jira:
   `[cap-status] agent=$CAP_AGENT ticket=CAP-<n> state=in_progress` + una línea con la rama (`CAP-<n>-<slug>` en `capcollector-wt/$CAP_AGENT`).
   Crea la rama **desde `main` en tu propio worktree** (no se crea ningún worktree nuevo):
   `git status --porcelain` debe salir vacío (si no: es trabajo de otra historia → `/handoff` y para).
   `git fetch --prune origin && git switch -c CAP-<n>-<slug> --no-track origin/main && npm ci && git push -u origin CAP-<n>-<slug>`.
   Limpieza de paso: borra las ramas locales ya mergeadas (`git branch -vv | awk '/: gone]/{print $1}' | xargs -r git branch -D`).

4. **Implementar, paso a paso.** Solo en tus rutas de `OWNERSHIP.md`. Si la historia te lleva fuera de ellas (incluido añadir una dependencia a un `package.json`), no edites: anótalo en **Pending** y, si bloquea, etiqueta `needs-human`. Para cada paso: código → tests con ID `[T-<comp>-nnn]` → `npm test` y `npm run lint && npm run typecheck` → `npm run catalog` → commit `CAP-<n>: <what>` (inglés). Los criterios de aceptación son tests o comprobaciones explícitas.

5. **Si la spec no cubre algo o te obliga a cambiarla:** no la cambies. Decisión conservadora, `// SPEC-GAP CAP-<n>: …` en el código, y a la sección "Spec deviations" del paso 7.

6. **PR.** `git fetch origin && git rebase origin/main` y, como la rama ya está en origin, `git push --force-with-lease origin CAP-<n>-<slug>` (solo ramas `CAP-*`; nunca `--force` a secas); luego `gh pr create --base main --title "CAP-<n>: <summary>"`. Cuerpo **en inglés** con: Done · Tests (IDs) · Spec covered · Deviations. Un PR por historia. Sin líneas de coautoría: el autor del commit es Edu (`git config` de la máquina).

7. **Cerrar el bucle en Jira** (comentario **en inglés** con exactamente estas secciones; las lee el dashboard):

   ```
   [cap-status] agent=<agente> ticket=CAP-<n> state=in_review
   **Done:** what was implemented (files).
   **Tests:** IDs passing and how they were run.
   **Spec deviations:** list with affected section and why, or "none".
   **Pending:** what is left out of the PR (including dependencies requested from the integrator).
   **PR:** link.
   **Needs human:** no | yes — why.
   ```

   Pasa la historia a "In Review". No la pases a Done: lo hace el integrador al mergear. Si "Needs human: yes", añade la etiqueta `needs-human`.

8. **Aparca tu worktree**: todo commiteado y empujado, luego `git switch --detach origin/main`. Así el integrador (u otra sesión) puede coger la rama, y tu siguiente `/next` arranca limpio.
9. Resume al usuario en cinco líneas: historia, rama, PR, tests, desviaciones, y **termina sin preguntar** (decidido en CAP-117, 2026-11-27: con `/loop 10m` una pregunta deja la sesión parada). La siguiente ronda o el siguiente `/next` coge la próxima historia. WIP: puedes empezar otra aunque tengas una en In Review; solo espera si el arquitecto o el integrador te han pedido un cambio (entonces toca `/revise`).
