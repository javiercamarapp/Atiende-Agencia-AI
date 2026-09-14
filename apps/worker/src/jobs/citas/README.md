# Vertical: citas (worker)

Ningún job de citas vive en `apps/worker` — a diferencia de hoteles/licitaciones,
toda la lógica de barrido de citas (recordatorio 24h, dispatcher de correo,
reconciliación de Google Calendar) vive en `@atiende/domain-citas`
(`reminders.ts`/`email-dispatch.ts`/`google-calendar-sync.ts`) y se expone
directo vía las rutas internas de `apps/api/src/routes/verticals/citas/`
(`reminders.ts`/`email-dispatch.ts`/`google-calendar-sync.ts`), sin una capa
`apps/worker` intermedia. Ver diseño Fase 1 citas §0.4.

**Scheduler: resuelto.** `vercel.json` (raíz del repo) define un `cron` real por
cada una de las 3 rutas internas de arriba, disparado por Vercel Cron una vez al
día (única frecuencia que permite el plan Hobby de Vercel — ver
`docs/DEPLOY.md#resumen-de-costo-por-plataforma`):

- `/internal/citas/confirmacion-cita` — recordatorio 24h.
- `/internal/citas/email-dispatch` — drena `citas.messaging_outbox` (channel='email')
  vía Resend.
- `/internal/citas/google-calendar-sync` — reconciliación por lote de
  `google_sync_status`.

Vercel dispara un Cron Job con GET (nunca POST) y solo sabe mandar el secreto
como `Authorization: Bearer <CRON_SECRET>` — las 3 rutas aceptan esa forma
además del header manual `x-atiende-internal-secret` que ya usaban los tests
(ver `apps/api/src/http-security.ts::internalOrCronSecretMatches`). Antes de un
deploy real hace falta configurar, en el dashboard de Vercel, la variable de
entorno `CRON_SECRET` con el MISMO valor que `INTERNAL_SECRET` — sin eso Vercel
sigue disparando el cron, pero la ruta responde 401 (fail-closed, nunca finge
que despachó nada).

**Limitación real conocida, no resuelta por este cambio:** el plan Hobby de
Vercel solo permite cron diario. Para `email-dispatch` eso significa que un
correo de confirmación de cita puede tardar hasta ~24h en salir si el drenado
síncrono al encolar (fuera del alcance de este archivo — no existe hoy) sigue
sin construirse; para `confirmacion-cita`/`google-calendar-sync` una cadencia
diaria es razonable de por sí (recordatorio "24h antes", reconciliación con
backoff). Subir a Vercel Pro permite bajar `schedule` a cada pocos minutos sin
tocar el código de las rutas, solo `vercel.json`.
