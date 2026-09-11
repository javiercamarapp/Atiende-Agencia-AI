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

Toda la lógica de negocio vive en `@atiende/domain-citas` — ninguna ruta aquí toca
SQL directamente. Google Calendar, agente de voz/WhatsApp completo, `modificar-cita`,
`consultar-disponibilidad`/`listar-servicios`/`listar-proveedores` como endpoints
propios y el panel visual quedan reservados para una fase posterior (ver diseño Fase
1 citas §6).
