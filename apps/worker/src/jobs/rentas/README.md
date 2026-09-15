# Vertical: rentas (worker)

Ningún job de rentas vive en `apps/worker` — mismo patrón que citas (ver
`../citas/README.md`): la lógica real vive en `@atiende/domain-rentas`
(`RealIcalFeedPort`, `checkin-reminders.ts`, `sync/calendar-sync-port.ts`) y se
expone directo vía rutas internas de `apps/api/src/routes/verticals/rentas/`, sin
una capa `apps/worker` intermedia. Actualizado en el barrido de documentación de
las rondas 13/14/16 — este README decía "reservado, aún no portado", desactualizado
desde que ese sync se conectó como adaptador real (`apps/api/src/production/
deps.ts::rentasIcalFeedPort`, sin credenciales de plataforma pendientes: un feed
iCal de canal es una URL pública, a diferencia de Google Calendar).

**Scheduler: resuelto.** `vercel.json` (raíz del repo) define un cron diario por
cada una de las 4 rutas internas de rentas:

- `/internal/rentas/email-dispatch` — drena `rentas.messaging_outbox`
  (channel='email') vía Resend.
- `/internal/rentas/checkin-recordatorio` — recordatorio de check-in
  (`checkin-reminders.ts`).
- `/internal/rentas/ical-sync` — sincronización real del feed iCal de cada canal
  conectado (`ical-sync-cron.ts`/`ical-sync.ts`).
- `/internal/rentas/checkout-sweep` — barrido de checkouts (`procesarCheckoutsPendientes`).

Mismo mecanismo de autenticación que el resto de crons internos
(`internalOrCronSecretMatches`, `x-atiende-internal-secret` o
`Authorization: Bearer $CRON_SECRET`) — ver `docs/DEPLOY.md`.
