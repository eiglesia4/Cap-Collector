---
description: Aplica a un PR abierto los cambios pedidos por el arquitecto o el integrador en el último comentario de Jira, sin abrir historia ni worktree nuevos
allowed-tools: Bash, Read, Edit, Write, Grep, Glob, mcp__atlassian__*, mcp__jira__*
---

Retoca una historia **ya en In Review** (PR abierto) según lo que pide el último comentario `[cap-status]` del arquitecto o del integrador. Tu identidad es `$CAP_AGENT`; la historia es `$ARGUMENTS` (`CAP-<n>`); si falta, usa la rama de tu worktree actual.

1. **Lee la petición.** En Jira, el último comentario de `agent=architect` o `agent=integrator` posterior a tu `state=in_review`. Resume en tres líneas qué cambia. Si dice «CHANGE REQUIRED» o «before merge», es bloqueante; si solo acepta desviaciones, no hay nada que hacer: dilo y para.
2. **Comprueba dependencias.** Si pide «rebase once CAP-<m> is merged» y `git fetch origin && git log origin/main --oneline | grep CAP-<m>` no lo encuentra, **para** y dilo; no rebasees sobre un `main` que no lo tiene.
3. **Vuelve a tu worktree** (`../capcollector-wt/CAP-<n>`, rama `CAP-<n>-…`). Nunca crees otro. `git rebase origin/main` solo si la petición lo pide o si `main` cambió en tus rutas.
4. **Aplica el cambio** en tus rutas de `OWNERSHIP.md`, con tests (IDs nuevos correlativos si hacen falta), `npm test && npm run lint && npm run catalog`. Commit `CAP-<n>: <what> (architect revision)` y push a la misma rama.
5. **Cierra el bucle**: edita **tu** comentario `state=in_review` (mismo comentario, no uno nuevo) añadiendo al principio de **Done** `Revision <fecha>: <qué cambió>` y actualizando **Tests** y **Spec deviations**. Deja la historia en "In Review". Actualiza el cuerpo del PR igual.
6. Resume al usuario en cuatro líneas: qué pedía, qué cambiaste, tests, qué queda para el integrador.
