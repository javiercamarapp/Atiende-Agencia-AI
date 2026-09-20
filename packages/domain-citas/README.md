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

## Fase 9 — agente "Lista de espera (simple)": broadcast manual disparado por el staff

Gap real de paridad con el origen
(`citas-reservaciones/supabase/functions/agente-lista-espera/index.ts` +
`_shared/agenda-agents-core.ts::runListaEsperaCore`): `citas.appointment_waitlist`
(`migrations/003_waitlist_and_rate_limit.sql`) ya existía desde la Fase 1, y
`reminders.ts::runOptimizadorCore` ya la usaba — pero solo AUTOMÁTICAMENTE, al
cancelar/reagendar una cita, con match fino FIFO+preferencias de fecha/franja/
servicio/proveedor, y notificando a UN único ganador. No existía ningún
mecanismo de broadcast MANUAL: el caso real del staff que libera un espacio "a
mano" (ej. amplía su propio horario ese día) sin pasar por cancelar-cita/
reagendar-cita, y por lo tanto sin disparar nunca al Optimizador.

- `reminders.ts::runListaEsperaCore` — la pieza nueva de dominio. Notifica, EN
  ORDEN DE POSICIÓN DE LA LISTA (FIFO real: quien se anotó primero, primero —
  mismo criterio de orden que `runOptimizadorCore`, nunca "los más recientes
  primero" como el broadcast del origen), a los primeros `limit` candidatos
  vivos de `loadLiveWaitlistCandidates`, filtrando opcionalmente por
  `providerId`/`serviceId` — SIN matchear fecha ni franja horaria preferida (a
  diferencia del Optimizador: este es el broadcast *simple*). `limit` por
  default `DEFAULT_LISTA_ESPERA_LIMIT` (5), recortado siempre al techo real
  `MAX_LISTA_ESPERA_LIMIT` (20) — un broadcast manual no debe poder vaciar de un
  jalón toda la lista de espera de un negocio grande ni agotar el rate-limit real
  de WhatsApp Business Platform por un solo clic del staff. Reusa, sin
  duplicar, la misma RPC atómica `claim_waitlist_notification_slot` (tope real
  de `MAX_WAITLIST_NOTIFICATIONS` = 3 notificaciones por cliente, nunca una
  condición de carrera leída-luego-escrita) y el mismo `enqueueMessagingOutbox`
  (`citas.messaging_outbox`, `channel='whatsapp'`) que el resto de
  notificaciones de citas — ningún envío directo a la API de WhatsApp desde
  aquí. Un candidato individual que ya llegó a su tope simplemente se salta
  (nunca tumba la corrida completa); un negocio sin WhatsApp configurado nunca
  lanza (`skippedNoWhatsappConfig: true`).
- `sortWaitlistByPosition` — el comparador FIFO extraído como función propia
  (antes vivía inline dentro de `runOptimizadorCore`) para que la ruta HTTP de
  solo-lectura (`GET .../waitlist`, ver abajo) muestre la lista en el MISMO
  orden en que el broadcast de verdad notifica, en vez de reinventar el
  criterio de orden en la capa HTTP.
- Rutas nuevas (`apps/api/src/routes/verticals/citas/admin.ts`, mismo guard JWT +
  `requirePropertyMembership` sin `allowedRoles` que el resto del panel):
  `GET properties/:propertyId/waitlist` (lectura, filtros opcionales
  `?provider_id=&service_id=`) y
  `POST properties/:propertyId/waitlist/broadcast` (dispara el broadcast real;
  body opcional `{provider_id, service_id, limit}`, valida que
  `provider_id`/`service_id` — si vienen — sean de verdad de esta organización
  antes de llamar al dominio).
- Ninguna migración SQL nueva: la tabla, la RPC de rate-limit y el
  `messaging_outbox` ya existían desde la Fase 1 de este vertical — el gap era
  puramente la ausencia del mecanismo de broadcast en la capa de dominio/HTTP,
  no de esquema.
- Fuera de alcance de esta fase: la UI del panel (`apps/web`) para disparar este
  broadcast con un botón — hoy solo existe el mecanismo real (dominio + endpoint
  HTTP), sin superficie visual todavía; ninguna página de `apps/web/.../citas`
  mencionaba "lista de espera" antes de esta fase.

## Fase 10 — panel admin: horarios/excepciones reales (cierra el gap MÁS grave de la vertical)

Hallazgo de auditoría (severidad ALTA, el más grave de citas): hasta esta fase,
`citas.availability_rules` no se podía crear ni editar desde NINGUNA capa —
`CitasRepository` solo exponía `loadAvailabilityRules` (lectura, Fase 1); no había
create/update en dominio, ninguna ruta en `admin.ts`, y
`apps/web/.../Disponibilidad.tsx` era explícitamente de solo lectura ("configurar
horarios/excepciones todavía no está disponible desde el panel"). Sin una fila de
`availability_rules`, `availability.ts::computeAvailableSlots` nunca ofrece un
solo slot — un negocio nuevo dado de alta desde el panel no podía recibir ni una
cita hasta que alguien insertara reglas por SQL directo.

- `createAvailabilityRule`/`updateAvailabilityRule`/`deleteAvailabilityRule`
  (`repository.ts::NewAvailabilityRuleInput`/`AvailabilityRulePatch`) — mismo
  criterio que `setProviderServiceOffering`: reciben `providerId`, nunca
  `organizationId` — el caller (`admin.ts`) ya validó la pertenencia vía
  `findProvider` antes de llamar aquí.
- `listAvailabilityOverrides` (lista TODAS las excepciones de un proveedor, para
  la vista del panel) + `upsertAvailabilityOverride`/`deleteAvailabilityOverride`
  (`AvailabilityOverrideInput`) — upsert/borrado real sobre la unique
  `(provider_id, override_date)` de `001_citas_schema.sql`. A diferencia de
  `loadAvailabilityOverride` (una fecha puntual, el que usa el motor de
  disponibilidad en cada cálculo de slots), `listAvailabilityOverrides` es "listar
  lo que ya existe" para el panel.
- `AvailabilityOverride` (el tipo) ganó el campo `reason` — columna real de
  `citas.availability_overrides.reason` que ninguna capa exponía todavía (el
  motor de disponibilidad nunca la necesitó, solo el panel al editar la
  excepción).
- Rutas nuevas (`apps/api/src/routes/verticals/citas/admin.ts`, mismo guard JWT +
  `requirePropertyMembership` sin `allowedRoles` que el resto del panel):
  `POST`/`PATCH`/`DELETE properties/:propertyId/providers/:providerId/availability-rules(/:ruleId)`
  y `GET properties/:propertyId/providers/:providerId/availability-overrides` +
  `PUT`/`DELETE .../availability-overrides/:overrideDate` (upsert real por fecha,
  el GET solo lista de hoy en adelante). Valida `"HH:MM"`/`"HH:MM:SS"` y
  `end_time > start_time` ANTES de Postgres (mismo criterio que
  `optionalTimeZone`/`optionalNullablePhone` de este archivo) para un 400 claro en
  vez del 500 genérico de un `check` constraint.
- `migrations/013_availability_rules_admin_grants_and_policies.sql`: mismo gap y
  arreglo que `011_citas_admin_backoffice_grants_and_policies.sql` (Fase 8) —
  `citas.availability_rules`/`citas.availability_overrides` solo traían, desde
  `migrations/001`, una policy pública de SELECT; nunca una policy `for all` de
  staff ni un GRANT de escritura al rol `authenticated`. Ninguna de las 2 tablas
  tiene `organization_id` propio (son hijas de `citas.providers` vía
  `provider_id`) — la policy nueva resuelve la organización dueña vía join a
  `citas.providers`, mismo criterio exacto que la policy de `provider_services`
  de la migración 011.
- `apps/web/.../Disponibilidad.tsx` dejó de ser de solo lectura: horario semanal
  editable inline (agregar/editar/quitar regla por día) + sección de excepciones
  (agregar/editar/quitar un cierre u horario especial por fecha, con motivo
  opcional) — ver `apps/web/src/verticals/citas/lib/providers-client.ts`.

## Fix auditoría a3 — SAVEPOINT en el aviso de lista de espera + gap de RLS nuevo (sin migración)

Hallazgo confirmado (severidad ALTA): cancelar una cita desde el panel de staff
respondía 500 y **revertía la propia cancelación** cuando existía un candidato
activo en la lista de espera — `citas.claim_waitlist_notification_slot`
siempre rechaza con 42501 en sesión de staff (`auth.uid()` no nulo, guard
correcto: "solo para la sesión de sistema"), y ese error se tragaba **sin
SAVEPOINT** dentro de `tryNotifyWaitlistOfFreedSlot`/`tryEnqueueAppointmentEmail`
— dejaba la transacción del request abortada (25P02), y el `commit;` de
`managed-postgres-engine.ts` sobre una transacción abortada revertía la
cancelación en silencio. Arreglo: ambas envuelven su `*Core` con
`repo.runWithRowSavepoint` (mismo helper que ya usa
`syncPendingAppointmentsMultiProvider`); la ruta de cancelar del panel además
mueve el aviso a `postCommitTasks` en sesión de sistema
(`runCitasWaitlistNotifyAfterCancel`, mismo patrón que `runCitasEmailDispatch`
de la auditoría a2). El resto de rutas de staff (confirmar/completar/no-show)
no liberan ningún hueco de horario y nunca llamaban este aviso — no comparten
el bug. El loop de recordatorio 24h (`runConfirmacionCitaCore`) también aísla
ahora cada cita con su propio `runWithRowSavepoint` (hallazgo confirmado #7):
una cita con un error real de Postgres ya no revierte los recordatorios de las
demás citas de la misma organización en la misma corrida.

**Corrección a un comentario de una migración YA publicada (inmutable, no se
edita el archivo):** `packages/domain-citas/migrations/015_rpc_anti_duplicado_authenticated_grants.sql`
(línea ~62-63, espejo real en `supabase/migrations/20240101000103_015_...sql`)
afirma que "ninguna de las 10 [RPC de esa migración] tiene una sola ruta de
staff que las invoque". Eso es **falso** para
`citas.claim_waitlist_notification_slot`, y por DOS rutas de staff distintas
(sesión de staff vía `dbSession`, no de sistema), no solo una:
`POST .../appointments/:id/cancel` (`apps/api/.../appointments-lifecycle.ts`,
vía `tryNotifyWaitlistAfterCancel` → `tryNotifyWaitlistOfFreedSlot` →
`runOptimizadorCore`) es la que este PR corrige con SAVEPOINT + `postCommitTasks`;
`POST .../properties/:propertyId/waitlist/broadcast` (`apps/api/.../admin.ts`
→ `runListaEsperaCore` → `claimWaitlistNotificationSlot`, ambas en
`reminders.ts`) es la SEGUNDA — misma causa raíz (42501 determinista cada vez
que hay un candidato visible y `whatsapp_config` activo), preexistente, **fuera
de alcance de este PR** (no cancela ni libera un hueco de horario, así que no
comparte el hallazgo confirmado #1 de "revierte la propia acción"; el test
existente de esta ruta usa `InMemoryCitasRepository` y nunca ve el 42501
real). Ambas quedan documentadas aquí porque las dos invocan la MISMA RPC de
sesión de sistema. Sea cual sea el arreglo, el 42501 confirmado arriba es
real y reproducible, no teórico. El comentario original describía la
*intención* de diseño (una RPC de sesión de sistema, invocada solo por rutas
de sistema); en la práctica, una ruta de staff termina llamándola de forma
indirecta a través de un best-effort compartido. No se corrige el archivo de
migración (inmutable, ya publicado) — esta nota es la corrección.

**Gap de RLS nuevo, descubierto verificando este fix contra Postgres real (NO
corregido en este PR — requiere una migración, fuera del alcance asignado):**
mover el aviso a sesión de sistema evita el 500, pero **no logra que el aviso
salga de verdad**, ni siquiera desde esa sesión de sistema post-commit. La
única policy de `citas.appointment_waitlist`
(`migrations/003_waitlist_and_rate_limit.sql`) exige
`m.user_id = auth.uid()`; bajo sesión de sistema `auth.uid()` es `NULL`
(mismo mecanismo que el gap ya documentado en el `README.md` raíz, "Sesión de
sistema sin acceso a `core.property`") — así que **cualquier lectura directa**
de esa tabla, incluida `loadLiveWaitlistCandidates` (que corre ANTES de
siquiera llegar a `claim_waitlist_notification_slot`), devuelve **cero filas
en silencio** bajo sesión de sistema. A diferencia de `citas.providers`, que
sí tiene una segunda policy pública ("cualquiera puede ver proveedores
activos") pensada exactamente para este caso, `citas.appointment_waitlist` no
la tiene. Esto **ya afectaba, antes de este PR**, a los 2 callers que YA
corrían enteros en sesión de sistema (cancelar/reagendar desde el agente de
voz/WhatsApp, `apps/api/.../appointments-lifecycle.ts`, líneas ~168 y ~182) —
no es una regresión de este fix. Verificado end-to-end contra Postgres real
(no solo leído) en
`scripts/verify-citas-cancelar-con-lista-de-espera/assertions.sql`, escenarios
"GAP RLS": en sesión de staff el candidato es visible (1 fila); en sesión de
sistema, el MISMO candidato es invisible (0 filas). Arreglo sugerido para un
PR futuro CON migración: agregar a `citas.appointment_waitlist` una policy de
sesión de sistema (`using (auth.uid() is null)`, análoga a las funciones
`*_idempotent`) o una función `security definer` de lectura dedicada, en vez
de aflojar el guard de `claim_waitlist_notification_slot`.
