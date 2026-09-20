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
  desde el panel) para el staff. Solo cancelar existía desde el panel al escribir
  este párrafo; solo el agente reagendaba (igual que el origen). **Desactualizado:
  Fase 7 agregó confirmar/completar/marcar no-show desde el panel** (4 acciones
  reales en `appointments-lifecycle.ts`) — ver más abajo.
- `reminders.ts` — `GET`/`POST /internal/citas/confirmacion-cita`: recordatorio
  24h, interna, gateada por `internalOrCronSecretMatches` (acepta
  `x-atiende-internal-secret` o `Authorization: Bearer <CRON_SECRET>`), no un
  job de `apps/worker`. Scheduler real: `vercel.json::crons` (ver
  `apps/worker/src/jobs/citas/README.md` para el detalle completo).
- `citas.ts` — agregador, montado en `apps/api/src/app.ts`.

Fase 2 agregó `voice-tools.ts` (Server Tools de voz) y `whatsapp.ts` (agente de
WhatsApp con LLM real).

Fase 3 agregó (ver diseño Fase 3 citas §4/§5):

- `google-calendar-oauth.ts` — `GET /v1/citas/properties/:propertyId/providers/:providerId/google-calendar/connect`
  (staff panel, mismo guard `requirePropertyMembership` que cancelar) genera la URL
  de consentimiento de Google; `GET /v1/citas/google-calendar/oauth-callback`
  (pública — Google redirige el navegador aquí sin JWT) valida el `state` firmado,
  intercambia el código y conecta `provider_calendar_accounts`.
- `google-calendar-sync.ts` — `GET`/`POST /internal/citas/google-calendar-sync`:
  reconciliación por lote, misma gate `internalOrCronSecretMatches` que
  `reminders.ts`.
- `appointments.ts`/`appointments-lifecycle.ts` ganaron una llamada best-effort a
  `tryTriggerGoogleSync` justo después de que crear/cancelar/reagendar YA
  confirmaron el cambio real — un fallo de Google Calendar nunca puede convertir
  esas respuestas en un error. **Desactualizado: Fase 6 §2 generalizó esta
  llamada a `tryTriggerCalendarSync`**, que despacha a Google, Cal.com o CalDAV
  según lo que el proveedor tenga conectado — `tryTriggerGoogleSync` solo
  sobrevive como wrapper Google-only interno.

Toda la lógica de negocio vive en `@atiende/domain-citas` — ninguna ruta aquí toca
SQL directamente. **Desactualizado: "cualquier proveedor de calendario que no sea
Google... queda reservado para una fase posterior" dejó de ser cierto en la Fase 6
§2** (ver más abajo): `calendar-providers.ts` conecta/desconecta/prueba cuentas
reales de Cal.com y CalDAV, con adaptadores reales (`calcom-port.ts` hace fetch
real contra `https://api.cal.com/v2`; `caldav-port.ts` hace WebDAV real
PUT/DELETE/REPORT). El receptor de webhooks de Google sigue sin construir.
`modificar-cita` (Fase 4) y el panel visual de administración (Fase 5,
ver abajo) ya se construyeron.

Fase 5 agregó `admin.ts` — lecturas paginadas para el panel de administración
visual de `apps/web` (ver su propio README):

- `GET /v1/citas/:orgSlug/admin/branches` — resuelve el/los `propertyId` reales de
  la organización desde el slug (mismo rol que
  `GET /v1/restaurantes/:orgSlug/admin/branches`, mismo guard: `authMiddleware` +
  verificación de membership vía `coreRepo.findMembershipsByUserId`, sin
  `requirePropertyMembership` porque todavía no hay `propertyId` en la ruta).
- `GET /v1/citas/properties/:propertyId/providers(/:providerId)` — expone
  `listActiveProviders`/`findProvider` (ya existían desde Fase 1/2); la ficha de un
  proveedor agrega sus reglas de disponibilidad (`loadAvailabilityRules`, Fase 1) y
  el estado de su conexión de Google Calendar (`findProviderCalendarAccount`, Fase 3).
- `GET /v1/citas/properties/:propertyId/services(/:serviceId)` — expone
  `listActiveServices`/`findService` (ya existían desde Fase 1/2).
- `GET /v1/citas/properties/:propertyId/appointments?from=&to=&provider_id=` —
  agenda del panel (vista mes/semana). Requirió una función NUEVA en
  `CitasRepository` (`listAppointmentsInRange`) porque el dominio no tenía ningún
  listado de citas por rango de fechas para uso administrativo — sí existían
  `loadBusyIntervals` (solo start/end, sin datos para mostrar) y
  `listActiveAppointmentsForCustomer` (solo de un cliente). Puro
  listado/paginado (acotado por rango de fechas + `limit`) de filas que
  `createAppointmentIdempotent`/`cancelAppointmentFromPanel`/etc. ya escribían —
  ninguna regla de negocio nueva. La ruta enriquece cada fila con
  proveedor/servicio/cliente reales (`findProvider`/`findService`/
  `findCustomerById`) para que la agenda sea legible.
- `GET /v1/citas/properties/:propertyId/customers(/:customerId)` — requirió 2
  funciones nuevas (`listCustomers` paginado + `findCustomerById`) porque el
  dominio solo sabía buscar un cliente por teléfono (`findCustomerByPhone`,
  necesario para el agente) o crearlo/actualizarlo (`upsertCustomer`) — nunca
  listarlos ni buscarlos por id. Mismo criterio que arriba: listar/paginar/buscar
  lo que `upsertCustomer` ya escribía, nunca crear/editar un cliente. La ficha
  reusa `listActiveAppointmentsForCustomer` (Fase 2) para sus citas próximas.

Estas 3 funciones nuevas de `CitasRepository` (`listPropertiesForOrganization`,
`listAppointmentsInRange`, `listCustomers`/`findCustomerById`) están implementadas
en los 2 adaptadores reales (`InMemoryCitasRepository` y `PostgresCitasRepository`,
ver `packages/domain-citas/src/repository.ts`) — nunca solo en memoria.
`listPropertiesForOrganization` lee de `core.property` directo (citas no tiene una
tabla `citas.branch_detail` como restaurantes: sucursal no es un concepto de
negocio propio de esta vertical, ver diseño Fase 1 §2).

El panel de administración deliberadamente NO ofrece crear/editar proveedores,
servicios ni reglas de disponibilidad — `domain-citas` no tiene esa lógica de
escritura todavía, y agregarla habría sido lógica de negocio nueva, fuera del
alcance de "CRUD de UI sobre lógica de dominio que ya existe" de esta fase. Queda
para una fase posterior, cuando el dominio la calcule primero.

(Nota: una fase posterior real -- ver `NewProviderInput`/`NewServiceInput`/
`ProviderPatch`/`ServicePatch`/`TenantConfigPatch` en
`packages/domain-citas/src/repository.ts` -- SÍ agregó alta/edición real de
proveedores/servicios/`citas.tenant_config` a `admin.ts`; el párrafo de arriba
describe el estado en el momento en que se escribió, no el actual.)

(Nota 2: Fase 10 -- ver abajo -- SÍ agregó alta/edición/borrado real de reglas de
disponibilidad y excepciones puntuales a `admin.ts`. El párrafo de arriba, sobre
`citas.availability_rules`/`citas.availability_overrides`, tampoco describe ya el
estado actual.)

## Fase 10 — horarios/excepciones reales desde el panel (cierra el gap MÁS grave de la vertical)

Hasta esta fase, `citas.availability_rules` (horario recurrente semanal por
proveedor, `001_citas_schema.sql`) no se podía crear ni editar desde NINGUNA capa:
`CitasRepository` solo exponía `loadAvailabilityRules` (lectura, Fase 1), y
`Disponibilidad.tsx` (`apps/web`) era de solo lectura ("configurar horarios/
excepciones todavía no está disponible desde el panel"). Sin una fila de
`availability_rules`, `availability.ts::computeAvailableSlots` nunca ofrece un
solo slot — un negocio nuevo dado de alta desde el panel no podía recibir ni una
cita hasta que alguien insertara reglas por SQL directo.

`CitasRepository` agregó (`packages/domain-citas/src/repository.ts`,
implementadas en los 2 adaptadores reales):

- `createAvailabilityRule`/`updateAvailabilityRule`/`deleteAvailabilityRule` —
  mismo criterio que `setProviderServiceOffering`: reciben `providerId` (nunca
  `organizationId`), porque el caller (`admin.ts`) ya validó la pertenencia vía
  `findProvider` antes de llamar aquí.
- `listAvailabilityOverrides` — a diferencia de `loadAvailabilityOverride` (una
  fecha puntual, el que usa el motor de disponibilidad en cada cálculo de slots),
  lista TODAS las excepciones de un proveedor para la vista del panel.
- `upsertAvailabilityOverride`/`deleteAvailabilityOverride` — upsert/borrado real
  sobre la unique `(provider_id, override_date)`.
- `AvailabilityOverride` (el tipo) ganó el campo `reason` — columna real de
  `citas.availability_overrides.reason` (001_citas_schema.sql) que ninguna capa
  exponía todavía (el motor de disponibilidad nunca la necesitó).

`admin.ts` agregó, con el mismo guard `requirePropertyMembership` que el resto del
panel:

- `POST/PATCH/DELETE /v1/citas/properties/:propertyId/providers/:providerId/availability-rules(/:ruleId)`
- `GET /v1/citas/properties/:propertyId/providers/:providerId/availability-overrides`
  (solo hoy en adelante — el panel edita el futuro, nunca reescribe un cierre ya
  pasado) y `PUT/DELETE .../availability-overrides/:overrideDate` (upsert real por
  fecha).

Validación de "HH:MM"/"HH:MM:SS" y `end_time > start_time` ANTES de Postgres
(mismo criterio que `optionalTimeZone`/`optionalNullablePhone` de este archivo)
para un 400 claro en vez del 500 genérico de un `check` constraint — el `check`
real de `001_citas_schema.sql` sigue como última línea de defensa.

`Disponibilidad.tsx` (`apps/web`) dejó de ser de solo lectura: horario semanal
editable inline (agregar/editar/quitar por día) + sección de excepciones
(agregar/editar/quitar un cierre u horario especial por fecha, con motivo
opcional) — ver `apps/web/src/verticals/citas/lib/providers-client.ts`.

## Fase 9 — agente "Lista de espera (simple)": broadcast manual disparado por el staff

Gap real de paridad cerrado: `citas.appointment_waitlist` (migración
`003_waitlist_and_rate_limit.sql`) ya existía, y `reminders.ts::runOptimizadorCore`
(`@atiende/domain-citas`) ya la usaba para notificar AUTOMÁTICAMENTE al cancelar/
reagendar una cita — pero con match fino FIFO+preferencias y solo a UN ganador. No
existía ningún mecanismo para que el staff dispare un broadcast MANUAL a varios
clientes en la lista de espera cuando libera un espacio "a mano" (ej. amplía su
propio horario ese día, un caso que nunca pasa por cancelar-cita/reagendar-cita).

`admin.ts` agregó, con el mismo guard `requirePropertyMembership` que el resto del
panel:

- `GET /v1/citas/properties/:propertyId/waitlist` — lectura de la lista de espera
  viva, en el MISMO orden FIFO ("posición en la lista") en que el broadcast
  notifica de verdad, con filtros opcionales `?provider_id=&service_id=`.
- `POST /v1/citas/properties/:propertyId/waitlist/broadcast` — dispara
  `runListaEsperaCore` (`reminders.ts`): notifica, en orden de posición, a los
  primeros `limit` candidatos vivos (filtro opcional por `provider_id`/
  `service_id` en el body, `limit` por default 5, techo real 20 —
  `MAX_LISTA_ESPERA_LIMIT`), SIN matchear fecha/franja preferida (a diferencia del
  Optimizador). Reusa la misma RPC atómica `claim_waitlist_notification_slot`
  (tope real de `MAX_WAITLIST_NOTIFICATIONS` = 3 por cliente) y el mismo
  `citas.messaging_outbox` (`enqueueMessagingOutbox`) que el resto de
  notificaciones de citas — ningún envío directo a la API de WhatsApp desde aquí.
  Nunca lanza por un negocio sin WhatsApp configurado (`skipped_no_whatsapp_config:
  true` en la respuesta) ni por un candidato individual que ya llegó a su tope
  (se salta y sigue con el siguiente).

  **f2-citas-lista-de-espera (hallazgo B):** `claim_waitlist_notification_slot`
  exige sesión de SISTEMA desde la migración 015 (`auth.uid() is null`) — esta
  ruta corre en sesión de STAFF (`dbSession`/JWT/`requirePropertyMembership`),
  así que el efecto real (`runListaEsperaCore`) se movió a `postCommitTasks`,
  en una sesión de sistema nueva abierta DESPUÉS del commit
  (`runCitasListaEsperaBroadcastAfterCommit`, mismo patrón que
  `runCitasWaitlistNotifyAfterCancel`). La ruta solo valida (provider_id/
  service_id de esta organización) y calcula una vista previa de solo lectura
  en sesión de staff (`previewListaEspera`) antes de encolar el efecto. **La
  respuesta ya NO incluye `notified`** (el número real solo se sabe después
  del commit) — devuelve `{ queued: true, candidates_considered,
  skipped_no_whatsapp_config }`, con el mismo conteo de candidatos que
  procesará el efecto real (`filterAndRankWaitlistForBroadcast`, compartida
  por ambas funciones). Ver `packages/domain-citas/README.md` para el gap de
  RLS de `citas.appointment_waitlist` que este mismo cambio cierra con
  migración (`020_appointment_waitlist_sistema_lectura.sql`).

Ninguna migración SQL nueva para el mecanismo de broadcast en sí: la tabla, la
RPC de rate-limit y el outbox ya existían desde la Fase 1 de este vertical — el
gap era puramente la ausencia del mecanismo de broadcast en la capa de
dominio/HTTP (la migración 020, arriba, es de f2-citas-lista-de-espera, para el
gap de RLS de lectura bajo sesión de sistema). Fuera de alcance de esta fase:
la UI del panel (`apps/web`) para disparar este broadcast con un botón — hoy solo
existe el mecanismo real (dominio + endpoint HTTP), sin superficie visual todavía.

## Fases 6/7/12 — no documentadas hasta este barrido, ya construidas

- **Fase 6 §1** — `admin.ts` gana la guardia de crisis (`citas.emergency_escalations`).
- **Fase 6 §2** — `calendar-providers.ts` (nuevo archivo): conectar/desconectar/
  consultar-estado/probar-conexión reales de cuentas de Cal.com y CalDAV por
  proveedor (credencial DEL PROVEEDOR, en Postgres — nunca una variable de
  entorno global, ver `docs/CREDENCIALES.md`). `calcom-port.ts`/`caldav-port.ts`
  en `packages/domain-citas` son adaptadores reales, no stubs.
- **Fase 6 §3** — `email-dispatch.ts` (nuevo archivo): dispatcher real de correo
  transaccional de citas (`/internal/citas/email-dispatch`), con disparo inline
  best-effort desde `appointments.ts`/`appointments-lifecycle.ts`/`whatsapp.ts`
  además del cron diario.
- **Fase 7** — `appointments-lifecycle.ts` gana 3 acciones más desde el panel de
  staff (además de cancelar, ya existente): confirmar, completar y marcar
  no-show, cada una con su propio evento de auditoría.
- **Fase 10** — ver la sección dedicada arriba (horarios/excepciones editables).
- **Fase 12** — `admin-staff.ts` (nuevo archivo): alta/gestión real de staff de
  citas (primer consumidor de `roles.ts::PLATFORM_ROLE_BY_VERTICAL_ROLE`), más
  `POST /v1/citas/properties/:propertyId/appointments` (alta manual de una cita
  desde el panel, sin pasar por el agente).
