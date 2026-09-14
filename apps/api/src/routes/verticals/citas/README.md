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
SQL directamente. Cualquier proveedor de calendario que no sea Google y el receptor
de webhooks de Google quedan reservados para una fase posterior (ver diseño Fase 3
citas §9). `modificar-cita` (Fase 4) y el panel visual de administración (Fase 5,
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

Ninguna migración SQL nueva: la tabla, la RPC de rate-limit y el outbox ya
existían desde la Fase 1 de este vertical — el gap era puramente la ausencia del
mecanismo de broadcast en la capa de dominio/HTTP. Fuera de alcance de esta fase:
la UI del panel (`apps/web`) para disparar este broadcast con un botón — hoy solo
existe el mecanismo real (dominio + endpoint HTTP), sin superficie visual todavía.
