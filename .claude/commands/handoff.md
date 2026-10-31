---
description: Cierra la sesión dejando el estado en Jira y en el repo para que otro agente, el integrador o Cowork puedan continuar
allowed-tools: Bash, Read, Grep, Glob, mcp__atlassian__*, mcp__jira__*
---

Deja el trabajo en un estado del que cualquiera pueda continuar:

1. `git status` y `git log origin/main..HEAD --oneline` en tu worktree. Si hay cambios sin commit, haz un commit WIP en inglés `CAP-<n>: WIP — <what remains>` en tu rama (nunca en `main`) y súbela.
2. Identifica la historia (rama `CAP-<n>-…` o `$ARGUMENTS`). Comenta en Jira (en inglés):
   ```
   [cap-status] agent=$CAP_AGENT ticket=CAP-<n> state=<in_progress|blocked>
   **Status:** what is done and what is not, against the story criteria.
   **Next concrete step:** the first thing someone would do when resuming (file, test, command).
   **Spec deviations:** found so far, or "none".
   **Questions for design:** if any (they become `design` stories under EP-01).
   **Needs human:** no | yes — why.
   ```
3. Si está bloqueada por diseño: crea una Story en CAP con parent EP-01 (CAP-1), etiqueta `design`, enlázala en el comentario y pon la historia en "Blocked" con `needs-human`.
4. Resume al usuario en tres líneas: historia, rama/worktree, siguiente paso.
