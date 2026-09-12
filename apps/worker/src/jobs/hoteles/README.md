# Vertical: hoteles (worker)

`night-audit.ts` (Fase 6, REQ-REV-013) — el PRIMER job real de `apps/worker` en todo
el monorepo. Ver el comentario de cabecera de ese archivo para la decisión de
mecanismo de invocación (endpoint HTTP interno gateado por secreto compartido,
invocado por un cron externo — mismo patrón que
`apps/api/src/routes/verticals/citas/reminders.ts` — en vez de un scheduler en
proceso dentro de `apps/worker`, que todavía no existe).

El resto del batch nocturno del origen (GM Copilot/Revenue/CFO, purga de preauth)
sigue sin portar — ver `docs/REQUISITOS.md`.
