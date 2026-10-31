---
description: Coge la siguiente historia Ready de Jira CAP de tu territorio, la implementa contra la spec en su propio worktree y abre el PR
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, mcp__atlassian__*, mcp__jira__*
---

Trabaja la siguiente historia del Kanban de CapCollector. Sigue los pasos en orden y no te saltes ninguno. Tu identidad es `$CAP_AGENT` (si no está definido, para y pídelo).

1. **Elegir la historia.** Tu etiqueta de territorio sale de `$CAP_AGENT`: `dev-app` → `area-app` · `dev-api` → `area-api` · `integrator` → `area-infra` (cualquier otro valor: para y dilo). Con el MCP de Atlassian (site `naevatec.atlassian.net`), busca:
   `project = CAP AND status = "Ready" AND issuetype != Epic AND labels = <tu etiqueta> ORDER BY Rank ASC`
   (si el MCP se come las comillas, usa `statusCategory = 2` y filtra `Ready` al leer). Si el usuario pasó `$ARGUMENTS`, usa esa clave (y comprueba que lleva tu etiqueta; si no, para).
   Salta las que lleven `design` (las resuelve el arquitecto) o `needs-human` (esperan a Edu). **Nunca cojas una historia de otra etiqueta**, aunque no quede ninguna de la tuya.
   **Sin "go" por sesión:** la columna Ready ya es el go. Resume en cinco líneas qué vas a hacer y arranca.

   **Guarda de dependencias (obligatoria, antes de arrancar):** lee la historia con sus enlaces (`issuelinks`). Si tiene algún enlace _is blocked by_ cuya historia **no** esté en Done, **no la cojas**: comenta en Jira `[cap-status] agent=$CAP_AGENT ticket=CAP-<n> state=blocked` + "Waiting for CAP-<m> (<status>)", pásala a "Backlog" con "Send back" si estaba en Ready por error, y pasa a la siguiente candidata; si no queda ninguna, dilo al usuario y para (no inventes trabajo). Haz además `git fetch origin` y comprueba que `origin/main` contiene los merges que la historia declara en «Blocked until»; si no, mismo tratamiento.

2. **Leer la especificación referenciada.** La historia cita secciones ("Spec: ADR-004; specs/exchange.md § Flow"). Ábrelas en `doc/spec/` (y en `$CAP_DOCS` si hay versión más nueva; si difiere, anótalo para el comentario final). Lee `CLAUDE.md` (invariantes) y `OWNERSHIP.md` (tus rutas). **No implementes desde el resumen de la historia.**

3. **Arrancar.** Pasa la historia a "In Progress" y comenta en Jira:
   `[cap-status] agent=$CAP_AGENT ticket=CAP-<n> state=in_progress` + una línea con el worktree.
   Crea rama y worktree **desde `main`**:
   `git fetch origin && git worktree add -b CAP-<n>-<slug> ../capcollector-wt/CAP-<n> origin/main && cd ../capcollector-wt/CAP-<n> && npm ci && git push -u origin CAP-<n>-<slug>`.
   Nunca trabajes en el directorio principal ni en un worktree de otro agente.

4. **Implementar, paso a paso.** Solo en tus rutas de `OWNERSHIP.md`. Si la historia te lleva fuera de ellas (incluido añadir una dependencia a un `package.json`), no edites: anótalo en **Pending** y, si bloquea, etiqueta `needs-human`. Para cada paso: código → tests con ID `[T-<comp>-nnn]` → `npm test` y `npm run lint && npm run typecheck` → `npm run catalog` → commit `CAP-<n>: <what>` (inglés). Los criterios de aceptación son tests o comprobaciones explícitas.

5. **Si la spec no cubre algo o te obliga a cambiarla:** no la cambies. Decisión conservadora, `// SPEC-GAP CAP-<n>: …` en el código, y a la sección "Spec deviations" del paso 7.

6. **PR.** `git fetch origin && git rebase origin/main`, luego `gh pr create --base main --title "CAP-<n>: <summary>"`. Cuerpo **en inglés** con: Done · Tests (IDs) · Spec covered · Deviations. Un PR por historia. Sin líneas de coautoría: el autor del commit es Edu (`git config` de la máquina).

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

8. Resume al usuario en cinco líneas: historia, rama/worktree, PR, tests, desviaciones. Luego **pregunta si continúas con la siguiente** (WIP: no cojas otra si ya tienes una en In Review sin revisar).
