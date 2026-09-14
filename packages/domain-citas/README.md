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

## Fase 6 — guardia de crisis + Cal.com/CalDAV + notificaciones por correo

Tres piezas independientes, ninguna reescribe lo ya construido en Fases 1-5.

### §1 — guardia de crisis + FAQs por rubro

Capa DETERMINISTA (nunca delegada al LLM) que intercepta un mensaje de crisis real
(autolesión/suicidio) en un rubro de salud (`citas.tenant_config.rubro` en
medico/dental/psicologo/veterinaria) ANTES de que el agente de WhatsApp llame al
LLM: registra `citas.emergency_escalations` (`migrations/007_crisis_guardrail.sql`)
y avisa al dueño por WhatsApp si configuró `owner_notification_phone` — ver
`vertical-config.ts` (rubros, palabras clave, FAQs canónicas) y
`crisis-guardrail.ts` (`runCrisisGuardrail`, conectado en
`whatsapp/inbound.ts` antes de `turnHandler.handleInboundMessage`). Las FAQs
canónicas del rubro se agregan como grounding al prompt del agente
(`whatsapp/llm-turn-handler.ts::verticalFaqsBlock`) — solo aplica hoy al canal de
WhatsApp, igual que el origen.

### §2 — CalendarSyncPort genérico + Cal.com + CalDAV

`calendar-sync-port.ts` generaliza el contrato de Fase 3 (Google sigue exactamente
igual, `GoogleCalendarSyncAdapter` solo lo envuelve) para que Cal.com
(`calcom-port.ts`, API v2 real) y CalDAV (`caldav-port.ts` + `caldav-ics.ts`,
RFC 4791/5545 real — Apple/iCloud, Fastmail, Nextcloud) puedan tratarse de forma
uniforme. Simuladores HTTP reales (`tests/calcom-sim.ts`, `tests/caldav-sim.ts`,
mismo patrón que `FakeGoogleCalendarPort` pero a nivel HTTP) prueban los
adaptadores REALES sin cuenta/credenciales reales de ninguna de las dos
plataformas. Conexión por proveedor vía
`migrations/008_calendar_provider_accounts.sql` (`provider_calcom_accounts`/
`provider_caldav_accounts`, reutilizando el Vault genérico de Fase 3) y
`POST/.../calcom|caldav/connect|disconnect` en
`apps/api/src/routes/verticals/citas/calendar-providers.ts` (staff panel, sin
flujo OAuth — ninguna de las dos plataformas lo necesita). Explícitamente fuera de
esta fase: rewirear `calendar-sync.ts`/`google_sync_*` para soportar Cal.com/CalDAV
en el mismo motor de reconciliación (Google sigue siendo el único conectado al
ciclo de vida real de la cita); esto sí deja el contrato + adaptadores + conexión
completos y probados para que ese rewiring futuro no tenga que construir nada de
protocolo desde cero.

### §3 — notificaciones por correo

Motor de envío real y fail-closed: `email-dispatch.ts::sendEmailOutboxJob` lanza
SIEMPRE sin `RESEND_API_KEY` real (nunca finge éxito) — port de
`email-dispatch-core.ts` del origen. `appointment-email-notifications.ts` arma el
correo real (to/subject/html vía `emails/appointment-templates.ts` +
`emails/layout.ts`) a partir de solo un `appointmentId`, y se encola SIEMPRE por
`citas.messaging_outbox` (`channel='email'`, ya existente desde Fase 1) — cierra un
hueco real que ya traían las rutas de citas desde antes de esta fase: creaban/
cancelaban/reagendaban una cita y encolaban un job de correo con solo
`{appointment_id}`, sin contenido real que ningún dispatcher pudiera enviar
(`modificar-cita` ni siquiera encolaba nada). `migrations/009_email_outbox_dispatch.sql`
agrega `attempts`/`last_error` + `claim_email_outbox_batch`/`complete_email_outbox_job`,
acotados a `channel='email'` (nunca tocan una fila `channel='whatsapp'` — ese
dispatcher es un problema de plataforma compartido que se construye por separado).
`POST /internal/citas/email-dispatch` (mismo patrón que el cron de Google Calendar)
drena el lote real. El recordatorio 24h (`reminders.ts::runConfirmacionCitaCore`)
ahora manda WhatsApp Y correo como canales independientes — un negocio sin
WhatsApp configurado ya no se queda sin ningún recordatorio.

## Fase 8 — panel admin: crear/editar proveedores, servicios y configuración del tenant

Gap real de paridad con el origen (`FichaProveedor.tsx`/`ServiciosSection.tsx`/
`ConfiguracionSection.tsx`): hasta esta fase, `CitasRepository` solo exponía
`listActiveProviders`/`listActiveServices` — ningún método de escritura para
proveedor/servicio/`tenant_config`, por lo que `apps/web/.../Proveedores.tsx`,
`Servicios.tsx` y `Configuracion.tsx` eran explícitamente de solo lectura.

- `createProvider`/`updateProvider` + `setProviderServiceOffering` (el checkbox
  real de `provider_services` — `repository.ts::NewProviderInput`/`ProviderPatch`).
- `createService`/`updateService` (`NewServiceInput`/`ServicePatch`) — `citas.services`
  no tiene columnas `description`/`requirements` como el origen; agregarlas es una
  migración/decisión de producto separada, fuera de esta fase (ver comentario en
  `types.ts::NewServiceInput`).
- `upsertTenantConfig` (`TenantConfigPatch`) edita `citas.tenant_config.rubro` —
  el campo real que usa la guardia de crisis (`vertical-config.ts::requiresCrisisGuardrail`) —
  más `default_timezone` (el mismo que ya leía `findPropertyTimezone`) y
  `owner_notification_phone`. A propósito NO edita `name`/`slug`/`status` del
  negocio (`core.organization`): ese schema es compartido por las 6 verticales y
  ninguna otra edita esos 3 campos desde una ruta de staff todavía — ampliarlo es
  una decisión de plataforma completa, no de esta vertical.
- Rutas (`apps/api/src/routes/verticals/citas/admin.ts`, mismo guard JWT +
  `requirePropertyMembership` sin `allowedRoles` que el resto del panel):
  `POST providers`, `PATCH providers/:id`, `PUT providers/:id/services/:id`
  (`{offered}`), `POST services`, `PATCH services/:id`, `GET`/`PATCH tenant-config`.
- `migrations/011_citas_admin_backoffice_grants_and_policies.sql`: mismo gap y
  arreglo que la Fase 5 de restaurantes — las policies `for all` de `providers`/
  `services`/`tenant_config` (ya desde `migrations/001`) eran letra muerta sin el
  GRANT de escritura al rol `authenticated`; `provider_services` ni siquiera tenía
  policy de escritura.
