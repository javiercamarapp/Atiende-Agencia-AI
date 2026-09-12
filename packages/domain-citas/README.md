# @atiende/domain-citas

Fase 1 de la migración del vertical citas-reservaciones — construido (ver
`docs/REQUISITOS.md` y el diseño Fase 1 citas del commit que lo introdujo).

Tipos, roles, lógica de negocio (motor de disponibilidad por timezone real,
anti-doble-reserva de 3 capas, crear/cancelar/reagendar citas de forma idempotente,
recordatorio 24h con el fix de timezone real preservado, aviso best-effort a lista de
espera) portados de `citas-reservaciones/supabase/functions/_shared/*`, adaptados al
modelo de tenancy de `@atiende/core-tenancy` (`core.organization`/`core.property`, no
una tabla `tenants` aislada).

Adaptadores duales (mismo patrón que `@atiende/domain-restaurantes`/
`@atiende/domain-hoteles`): `InMemoryCitasRepository` (tests, dev sin Postgres real) y
`PostgresCitasRepository` (producción, sobre `TenantDbSession`).

Migraciones SQL reales en `migrations/` (schema `citas.*`, requiere
`packages/db/migrations/0001_core_schema.sql` aplicada antes).

Guardias de negocio reales preservadas literal (no rediseñadas):

- **Anti-doble-reserva de 3 capas**: `EXCLUDE USING gist (provider_id,
  tstzrange(starts_at,ends_at))` a nivel Postgres (autoridad final) +
  `isSlotWithinAvailability` en TS (horario de atención real) +
  `create_appointment_idempotent`/`pg_advisory_xact_lock` (idempotencia de reintento
  del mismo intento del agente).
- **Reagendar preserva el mismo `appointment.id`** — nunca cancela+recrea (perdería
  historial/recordatorios).
- **Fix de timezone real**: la hora que ve el cliente (recordatorio 24h) SIEMPRE se
  calcula con el timezone de la sucursal/negocio, nunca con el del host (UTC).

Explícitamente fuera de Fase 1 (ver diseño §6): agente de voz ElevenLabs/WhatsApp
con LLM completo (construido en Fase 2), sincronización con Google Calendar
(construida en Fase 3, ver abajo), `modificar-cita` (cambio de proveedor/servicio
sin tocar horario, sigue fuera), `consultar-disponibilidad`/`listar-servicios`/
`listar-proveedores`/`buscar-citas-cliente` como rutas propias (su lógica pura ya se
porta aquí porque los 3 flujos elegidos la necesitan, pero no se exponen como
endpoint), cron de lista de espera por broadcast simple (`runListaEsperaCore`),
guardia de crisis (`emergency_escalations`), panel de superadmin/dashboards,
integración de `@atiende/core-conversation`.

## Fase 3 — sincronización real con Google Calendar

Conecta el Google Calendar PERSONAL de cada proveedor/profesional (`citas.providers`,
nunca un calendario compartido de organización/property — ver diseño Fase 3 §2) y lo
mantiene sincronizado, en un solo sentido (software -> Google, NUNCA al revés, ver
§6), con las citas reales de la base de datos.

- **OAuth por proveedor**: `google-calendar-oauth-state.ts` (firma/verifica el
  `state` con el mismo secreto de plataforma que WhatsApp) +
  `apps/api/src/routes/verticals/citas/google-calendar-oauth.ts` (connect/callback).
- **Puerto de Google Calendar**: `google-calendar-port.ts` — `GoogleCalendarPort`
  (createEvent/updateEvent/deleteEvent, deliberadamente SIN lectura — ver §6),
  `RealGoogleCalendarPort` (REST real, refresh de token cacheado) y
  `FakeGoogleCalendarPort` (captura en memoria, para pruebas).
- **Fábrica**: `google-calendar-factory.ts` — resuelve el puerto real por
  `provider_id`, vía Supabase Vault (pendiente de habilitar en el proyecto real, ver
  diseño §4/§9 — `resolveProviderCalendarRefreshToken` trata "Vault no disponible"
  igual que "sin conectar", nunca lanza).
- **Motor de sincronización**: `calendar-sync.ts` — `tryTriggerGoogleSync` (intento
  inmediato best-effort tras crear/cancelar/reagendar, nunca propaga una excepción
  al caller HTTP) y `syncPendingAppointments` (reconciliación por lote, backoff
  exponencial 1-16 min, `MAX_SYNC_ATTEMPTS=5`).
- **Transiciones atómicas**: `migrations/005_google_calendar_sync.sql` reescribe
  `create/cancel/reschedule_appointment_idempotent` para dejar `google_sync_status`
  en `pending`/`pending_cancel` en la MISMA transacción que el cambio real de la
  cita — nunca en un job separado que pueda perderse.

Explícitamente fuera de Fase 3 (ver diseño §9): cualquier proveedor de calendario
que no sea Google, el receptor de webhooks de Google (watch channels quedan sin
consumidor — opción A del diseño §7), el panel visual de conexión en `apps/web`, y
habilitar Vault/pgsodium en el proyecto Supabase real (paso de infraestructura de
despliegue, no de este código).
