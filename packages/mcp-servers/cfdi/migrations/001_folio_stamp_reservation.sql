-- Fix hallazgo auditoría (rubro 6, ALTA) — reserva atómica por folio para
-- `DualPacCfdiPort.timbrar` (`packages/mcp-servers/cfdi/src/adapters/
-- dual-pac-cfdi-port.ts`). Antes de esta migración la idempotencia por folio vivía
-- ÚNICAMENTE en un `Map` de proceso (`InMemoryIdempotencyStore`): un TOCTOU real
-- (dos llamadas concurrentes a `timbrar()` con el mismo folio pasan el chequeo de
-- caché ANTES de que cualquiera termine de escribir, y ambas llaman al PAC de
-- verdad -- doble timbrado fiscal real ante el SAT), agravado porque este monorepo
-- corre en Vercel con Fluid Compute (una misma instancia -- y por tanto el mismo
-- `Map` -- se reutiliza entre requests concurrentes de tenants DISTINTOS) y porque
-- el `Map` no sobrevive un reinicio de proceso ni se comparte entre instancias
-- separadas.
--
-- Esta tabla es la reserva REAL: `mcp_cfdi.folio_stamp_reservation.folio` es la
-- llave primaria (constraint único a nivel de Postgres), y `INSERT ... ON CONFLICT`
-- (ver `apps/api/src/production/cfdi-folio-reservation-store.ts`) es la única forma
-- de reservarla -- nunca un check-then-insert en dos pasos desde la aplicación.
-- Mismo criterio ya usado en este monorepo para el mismo tipo de problema:
-- `hoteles.idempotency_key` (`packages/domain-hoteles/migrations/001_hoteles_schema.sql`,
-- ver `PostgresHotelesRepository.withIdempotency` en `postgres-repository.ts`) e
-- `insertReservation` (`hoteles.reservation`, `ON CONFLICT ... DO NOTHING`).
--
-- Schema propio (`mcp_cfdi`), no uno de los 7 schemas por-vertical (core, citas,
-- hoteles, restaurantes, despachos, licitaciones, rentas): `DualPacCfdiPort` es un
-- singleton de proceso COMPARTIDO entre TODAS las verticales que timbran CFDI (ver
-- `apps/api/src/production/deps.ts` -- hoy solo hoteles lo invoca de verdad, pero
-- `apps/api/tests/{despachos,rentas,citas,licitaciones,restaurantes-admin-kpis}-fixtures.ts`
-- ya lo construyen igual para las demás), así que esta tabla NUNCA debe acoplarse a
-- un solo vertical.
--
-- SIN RLS a propósito: esta tabla es infraestructura pura de deduplicación de un
-- efecto externo (llamar al PAC), nunca datos de negocio expuestos a una ruta HTTP
-- ni a una sesión de tenant real -- el único código que la toca es
-- `ProductionCfdiFolioReservationStore`, que corre siempre bajo la sesión de
-- SISTEMA (`engine.admin`, sin `auth.uid()`/claims de tenant, ver comentario de
-- cabecera de `managed-postgres-engine.ts`). Habilitar RLS aquí solo agregaría
-- policies que emular una noción de "dueño" que este dato no tiene, sin ganar
-- ningún aislamiento real.
create schema if not exists mcp_cfdi;

create table mcp_cfdi.folio_stamp_reservation (
  folio text primary key,
  status text not null default 'pending' check (status in ('pending', 'completed')),
  reserved_at timestamptz not null default now(),
  completed_at timestamptz,
  -- Resultado ya persistido (`{ timbrado, usedSecondary }`, ver `StampedFolio` en
  -- dual-pac-cfdi-port.ts) una vez `status = 'completed'` -- nunca se recalcula ni
  -- se vuelve a llamar al PAC mientras esta fila exista con este status.
  result jsonb,
  constraint folio_stamp_reservation_completed_has_result
    check (status <> 'completed' or result is not null)
);

comment on table mcp_cfdi.folio_stamp_reservation is
  'Reserva atómica por folio ANTES de invocar a un PAC de timbrado CFDI (dedupe real de un efecto externo no idempotente, ver DualPacCfdiPort.timbrar) -- nunca datos de negocio, sin RLS a propósito (ver cabecera de la migración).';

-- El rol de conexión de producción es siempre `authenticated` (nunca `service_role`,
-- ver packages/db/src/managed-postgres-engine.ts) -- sin este GRANT, `set role
-- authenticated; select 1 from mcp_cfdi.folio_stamp_reservation;` falla con
-- "permiso denegado al esquema mcp_cfdi" incluso desde la sesión de sistema (mismo
-- hallazgo que packages/db/migrations/0005_grant_schema_usage.sql documenta para
-- los otros 7 schemas).
grant usage on schema mcp_cfdi to authenticated;
grant select, insert, update, delete on mcp_cfdi.folio_stamp_reservation to authenticated;
