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

Explícitamente fuera de esta fase (ver diseño §6): sincronización con Google
Calendar, agente de voz ElevenLabs/WhatsApp con LLM completo, `modificar-cita`
(cambio de proveedor/servicio sin tocar horario), `consultar-disponibilidad`/
`listar-servicios`/`listar-proveedores`/`buscar-citas-cliente` como rutas propias (su
lógica pura ya se porta aquí porque los 3 flujos elegidos la necesitan, pero no se
exponen como endpoint), cron de lista de espera por broadcast simple
(`runListaEsperaCore`), guardia de crisis (`emergency_escalations`), panel de
superadmin/dashboards, integración de `@atiende/core-conversation`.
