-- Defensa en profundidad: `mcp_cfdi.folio_stamp_reservation` era la única tabla de
-- aplicación sin RLS (advisor de seguridad de Supabase y auditoría de plataforma del
-- 7-nov-2026) y conservaba DML completo para `authenticated` (ver
-- 001_folio_stamp_reservation.sql).
--
-- Quién la usa (verificado con `rg folio_stamp_reservation`): ÚNICAMENTE
-- `ProductionCfdiFolioReservationStore` (`apps/api/src/production/cfdi-folio-reservation-store.ts`),
-- y SIEMPRE bajo `engine.withAppSession({ userId: null }, ...)`: rol `authenticated`
-- con `request.jwt.claim.sub` vacío, es decir `auth.uid() is null` (sesión de
-- SISTEMA). Ninguna ruta HTTP ni sesión de staff/tenant la lee o escribe.
--
-- Por eso el GRANT no se puede revocar (la sesión de sistema también corre como
-- `authenticated`, ver `packages/db/src/managed-postgres-engine.ts`), pero sí se
-- puede restringir quién pasa la RLS: solo la sesión de sistema, la misma convención
-- que la casa usa para tablas de "solo sistema" (`auth.uid() is null`, ver
-- packages/db/migrations/0015_core_rls_sesion_sistema.sql). Cualquier sesión con un
-- usuario real (staff de cualquier tenant, o un JWT de usuario por PostgREST) ve 0
-- filas y no puede insertar, actualizar ni borrar reservas de folio.
--
-- `anon` no tiene ni tenía ningún GRANT (nunca `GRANT` a `anon`).
--
-- Rollback (solo si hiciera falta volver al estado anterior, sin pérdida de datos):
--   drop policy if exists "solo sesion de sistema reserva folios" on mcp_cfdi.folio_stamp_reservation;
--   alter table mcp_cfdi.folio_stamp_reservation disable row level security;
alter table mcp_cfdi.folio_stamp_reservation enable row level security;

-- Seguridad: `for all` cubre el `insert ... on conflict do update ... returning`,
-- el `select`, el `update` y el `delete` del store; `auth.uid() is null` en USING y
-- WITH CHECK limita las cuatro operaciones a la sesión de sistema. Nunca `using (true)`.
drop policy if exists "solo sesion de sistema reserva folios" on mcp_cfdi.folio_stamp_reservation;
create policy "solo sesion de sistema reserva folios" on mcp_cfdi.folio_stamp_reservation
  for all to authenticated
  using (auth.uid() is null)
  with check (auth.uid() is null);

comment on table mcp_cfdi.folio_stamp_reservation is
  'Reserva atómica por folio ANTES de invocar a un PAC de timbrado CFDI (dedupe real de un efecto externo no idempotente, ver DualPacCfdiPort.timbrar) -- nunca datos de negocio. RLS: solo la sesión de sistema (auth.uid() is null), ver 002_folio_stamp_reservation_rls.sql.';
