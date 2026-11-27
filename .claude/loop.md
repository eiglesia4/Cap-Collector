Ronda periódica de un agente de CapCollector (la lanza `/loop 10m`; decidido en CAP-116, 2026-11-27). Tu identidad es
`$CAP_AGENT`. Haz **una sola** de estas cosas, la primera que aplique, y termina en una línea si no hay nada:

1. **Trabajo a medias en esta sesión** (una historia en curso que no llegó a PR): sigue con ella hasta el PR o, si está
   bloqueada, haz `/handoff`. No empieces nada nuevo mientras tanto.
2. **Si eres `integrator`:** ejecuta `/integrate --auto`. Si después no quedan PR que mergear y hay una historia Ready
   con `area-integration`, ejecuta `/next`.
3. **Si eres `dev-*`: revisiones pendientes.** Busca en Jira tus historias en In Review (`labels = <tu etiqueta>`) cuyo
   último comentario `[cap-status]` sea del arquitecto o del integrador y pida un cambio (no solo un GO o una
   aceptación de desviaciones) **posterior** a tu último commit en el PR. Si hay alguna, ejecuta `/revise CAP-<n>` con
   la más antigua.
4. **Si eres `dev-*`: trabajo nuevo.** Si no hay revisiones, ejecuta `/next`. Respeta sus guardas (dependencias,
   `needs-human`, `design`, worktree limpio); si no hay nada Ready para ti, no inventes trabajo.
5. **Nada que hacer:** responde solo `[loop] $CAP_AGENT: nada pendiente (<hora>)`, sin más llamadas.

Reglas de la ronda:

- Nunca más de una historia por ronda. Una ronda que abre un PR o aplica un `/revise` termina ahí.
- Las búsquedas en Jira de los pasos 3–4 son baratas: no leas ficheros del repo hasta saber que hay trabajo.
- Si una herramienta pide un permiso que la sesión no tiene, no reintentes: deja la petición a la vista y termina la
  ronda (Edu la verá en Remote Control).
- No toques nada fuera de tu territorio (`OWNERSHIP.md`), ni en la ronda ni fuera de ella.
