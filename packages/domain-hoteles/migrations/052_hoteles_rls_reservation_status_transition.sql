-- Ola 2 (seguridad), arreglo F.3 — RLS en hoteles.reservation_status_transition, una de las dos únicas tablas de
-- los schemas del repo sin RLS habilitado.
--
-- Qué es: catálogo GLOBAL y estático de las 8 transiciones válidas de la máquina de estados de reservas
-- (005_reservas_estado; espejo de packages/domain-hoteles/src/reservationStateMachine.ts::VALID_TRANSITIONS). Sin
-- organization_id/property_id: no es dato de tenant. La lee el trigger SECURITY INVOKER
-- hoteles.reservation_validate_transition bajo el rol del caller (`authenticated`, con o sin auth.uid():
-- staff y sesión de sistema del cron de no-show), por eso 025_reserva_lifecycle_staff_grants le dio SELECT a
-- `authenticated`. Nadie la escribe fuera de migraciones.
--
-- Hasta hoy su único control era el GRANT. Con RLS:
--   * SELECT para `authenticated` con un predicado que enumera el dominio cerrado del catálogo (no `using (true)`):
--     la app sigue viendo exactamente las 8 filas, y una fila agregada fuera de una migración revisada no la ve.
--   * Sin policy de INSERT/UPDATE/DELETE: aunque un GRANT futuro abriera escritura a `authenticated`, la RLS la
--     niega. `anon` no tiene GRANT (sin cambio). El dueño y `service_role` (BYPASSRLS) no cambian.
-- Al agregar una transición en una migración futura, amplía esta policy en la MISMA migración
-- (scripts/verify-rls-catalogos-globales, escenario 6, se pone rojo si una fila sembrada queda oculta).
--
-- Numeración: 052 = siguiente libre de hoteles (main llega a 050; 044 y 046 en PRs abiertos; 051 la usa el PR de
-- revoke de security definer de esta misma ola). Espejo: supabase/migrations/20240101000835_052_hoteles_rls_reservation_status_transition.sql.
-- Compatibilidad: no cambia columnas ni filas; el código no cambia.

alter table hoteles.reservation_status_transition enable row level security;

drop policy if exists "catálogo de transiciones: lectura de la app" on hoteles.reservation_status_transition;
create policy "catálogo de transiciones: lectura de la app" on hoteles.reservation_status_transition
  for select to authenticated
  using (
    (from_status, to_status) in (
      ('cotizada'::hoteles.reservation_status, 'confirmada'::hoteles.reservation_status),
      ('cotizada', 'cancelada'),
      ('confirmada', 'check_in'),
      ('confirmada', 'cancelada'),
      ('confirmada', 'no_show'),
      ('check_in', 'en_estancia'),
      ('en_estancia', 'check_out'),
      ('check_out', 'cerrada')
    )
  );
