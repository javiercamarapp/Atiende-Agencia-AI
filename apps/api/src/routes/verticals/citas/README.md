# Vertical: citas (api)

Fase 1 construida — los 3 flujos elegidos (ver diseño Fase 1 citas):

- `appointments.ts` — `POST /v1/citas/:orgSlug/appointments`: crear cita. Pública/de
  sistema (checkout web público + Server Tool del agente), SIN `authMiddleware` —
  mismo criterio que `restaurantesPublicRoutes`. Protegida por `originAllowed()`
  (web) o `x-atiende-tool-secret` (voz/WhatsApp), con rate-limit distinto por canal.
- `appointments-lifecycle.ts` — cancelar + reagendar, con 2 entradas de
  autenticación distintas (como en el origen): `x-atiende-tool-secret` para el
  agente, y `authMiddleware` + `dbSession` + `requirePropertyMembership("propertyId")`
  (sin `allowedRoles` de plataforma — el origen no restringe por rol quién cancela
  desde el panel) para el staff. Solo cancelar existe desde el panel; solo el agente
  reagenda hoy (igual que el origen).
- `reminders.ts` — `POST /internal/citas/confirmacion-cita`: recordatorio 24h,
  interna, gateada por `x-atiende-internal-secret` (análogo a `CRON_SECRET`),
  pensada para un scheduler externo (Vercel Cron/Supabase cron), no un job de
  `apps/worker`.
- `citas.ts` — agregador, montado en `apps/api/src/app.ts`.

Fase 2 agregó `voice-tools.ts` (Server Tools de voz) y `whatsapp.ts` (agente de
WhatsApp con LLM real).

Fase 3 agregó (ver diseño Fase 3 citas §4/§5):

- `google-calendar-oauth.ts` — `GET /v1/citas/properties/:propertyId/providers/:providerId/google-calendar/connect`
  (staff panel, mismo guard `requirePropertyMembership` que cancelar) genera la URL
  de consentimiento de Google; `GET /v1/citas/google-calendar/oauth-callback`
  (pública — Google redirige el navegador aquí sin JWT) valida el `state` firmado,
  intercambia el código y conecta `provider_calendar_accounts`.
- `google-calendar-sync.ts` — `POST /internal/citas/google-calendar-sync`:
  reconciliación por lote, misma gate `x-atiende-internal-secret` que
  `reminders.ts`.
- `appointments.ts`/`appointments-lifecycle.ts` ganaron una llamada best-effort a
  `tryTriggerGoogleSync` justo después de que crear/cancelar/reagendar YA
  confirmaron el cambio real — un fallo de Google Calendar nunca puede convertir
  esas respuestas en un error.

Toda la lógica de negocio vive en `@atiende/domain-citas` — ninguna ruta aquí toca
SQL directamente. Cualquier proveedor de calendario que no sea Google, el receptor
de webhooks de Google, `modificar-cita`, `consultar-disponibilidad`/
`listar-servicios`/`listar-proveedores` como endpoints propios, y el panel visual de
conexión en `apps/web` quedan reservados para una fase posterior (ver diseño Fase 3
citas §9).
