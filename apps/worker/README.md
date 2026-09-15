# apps/worker

Lógica REAL de jobs de fondo para hoteles/licitaciones/despachos — ya NO es una
carpeta vacía. Actualizado en el barrido de documentación de las rondas 13/14/16:
este README decía "reservado, aún no construido", desactualizado desde la Fase 6 de
hoteles (primer job real de este monorepo).

**No es un proceso de larga duración propio** (nunca corre como daemon/servicio
separado) — cada archivo de `src/jobs/<vertical>/` expone solo la lógica de
orquestación (un barrido puro, testeable sin HTTP), y las rutas internas de
`apps/api/src/routes/internal/`/`apps/api/src/routes/verticals/<vertical>/` la
invocan, gateadas por `INTERNAL_SECRET`/`CRON_SECRET` y disparadas por
`vercel.json::crons`. Ver el README de cada subcarpeta para el detalle exacto de
quién invoca qué:

- `src/jobs/hoteles/` — `night-audit.ts` (Fase 6, primer job real), `no-show.ts`.
- `src/jobs/licitaciones/` — `discover-tenders.ts`, `deadline-reminders.ts`,
  `alert-notifications.ts`.
- `src/jobs/despachos/` — `cobranza-reminders.ts`.
- `src/jobs/citas/`, `src/jobs/rentas/` — sin código propio aquí a propósito: la
  lógica vive en `@atiende/domain-{citas,rentas}` y se expone directo vía rutas de
  `apps/api`, sin capa intermedia (ver el README de cada una para el porqué).
- `src/jobs/restaurantes/` — genuinamente sin job de recordatorio WhatsApp/voz
  todavía (a diferencia de las demás carpetas de este directorio, este SÍ sigue
  pendiente — ver su propio README).
