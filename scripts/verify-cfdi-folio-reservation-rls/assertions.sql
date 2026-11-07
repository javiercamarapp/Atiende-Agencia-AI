-- Verifica contra Postgres REAL la migración
-- packages/mcp-servers/cfdi/migrations/002_folio_stamp_reservation_rls.sql
-- (espejo supabase/migrations/20240101000630_002_folio_stamp_reservation_rls.sql):
-- `mcp_cfdi.folio_stamp_reservation` con RLS y acceso SOLO para la sesión de sistema
-- (rol authenticated + auth.uid() null), que es exactamente como la usa
-- ProductionCfdiFolioReservationStore (engine.withAppSession({ userId: null })).
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail`
-- = el escenario debe terminar en ERROR; `*_deberia_ser_N` = la última sentencia devuelve N;
-- cualquier otro escenario debe terminar sin error.
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.verify_as(p_sub text) returns void language plpgsql as $$
begin
  perform set_config('role', 'authenticated', true);
  perform set_config('request.jwt.claim.sub', coalesce(p_sub, ''), true);
end;
$$;
create or replace function public.verify_anon() returns void language plpgsql as $$
begin
  perform set_config('role', 'anon', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function public.verify_as(text), public.verify_anon() to public;

-- Fixture (superusuario, fuera de RLS): una reserva completada ya existente.
insert into mcp_cfdi.folio_stamp_reservation (folio, status, result, completed_at)
values ('FIX-COMPLETADO', 'completed', '{"usedSecondary": false}'::jsonb, now())
on conflict do nothing;

\echo '--- 1. la tabla tiene RLS activa'
begin;
select count(*) as rls_activa_deberia_ser_1 from pg_class where oid = 'mcp_cfdi.folio_stamp_reservation'::regclass and relrowsecurity;
rollback;

\echo '--- 2. sesion de sistema: reserva un folio nuevo (mismo SQL que reserve())'
begin;
select public.verify_as('');
with c as (
  insert into mcp_cfdi.folio_stamp_reservation (folio, reserved_at, status)
  values ('F-NUEVO', now(), 'pending')
  on conflict (folio) do update set reserved_at = now(), status = 'pending', result = null, completed_at = null
    where mcp_cfdi.folio_stamp_reservation.status = 'pending'
      and mcp_cfdi.folio_stamp_reservation.reserved_at < now() - ('120000' || ' milliseconds')::interval
  returning folio
) select count(*) as reserva_sistema_deberia_ser_1 from c;
rollback;

\echo '--- 3. sesion de sistema: lee la reserva completada (peek/reserve)'
begin;
select public.verify_as('');
select count(*) as lectura_sistema_deberia_ser_1 from mcp_cfdi.folio_stamp_reservation where folio = 'FIX-COMPLETADO' and status = 'completed';
rollback;

\echo '--- 4. sesion de sistema: complete() actualiza'
begin;
select public.verify_as('');
insert into mcp_cfdi.folio_stamp_reservation (folio) values ('F-COMPLETE');
with u as (
  update mcp_cfdi.folio_stamp_reservation set status = 'completed', result = '{"usedSecondary": true}'::jsonb, completed_at = now()
  where folio = 'F-COMPLETE' returning 1
) select count(*) as complete_sistema_deberia_ser_1 from u;
rollback;

\echo '--- 5. sesion de sistema: fail() borra'
begin;
select public.verify_as('');
insert into mcp_cfdi.folio_stamp_reservation (folio) values ('F-FAIL');
with d as (delete from mcp_cfdi.folio_stamp_reservation where folio = 'F-FAIL' returning 1)
select count(*) as fail_sistema_deberia_ser_1 from d;
rollback;

\echo '--- 6. usuario autenticado (staff de cualquier tenant): no ve reservas'
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select count(*) as lectura_usuario_deberia_ser_0 from mcp_cfdi.folio_stamp_reservation;
rollback;

\echo '--- 7. usuario autenticado: no puede insertar (violación de RLS)'
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into mcp_cfdi.folio_stamp_reservation (folio) values ('F-USUARIO') returning folio as should_fail;
rollback;

\echo '--- 8. usuario autenticado: update no toca la reserva existente'
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
with u as (update mcp_cfdi.folio_stamp_reservation set status = 'pending', result = null where folio = 'FIX-COMPLETADO' returning 1)
select count(*) as update_usuario_deberia_ser_0 from u;
rollback;

\echo '--- 9. usuario autenticado: delete no borra la reserva existente'
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
with d as (delete from mcp_cfdi.folio_stamp_reservation where folio = 'FIX-COMPLETADO' returning 1)
select count(*) as delete_usuario_deberia_ser_0 from d;
rollback;

\echo '--- 10. anon: sin GRANT, falla'
begin;
select public.verify_anon();
select count(*) as should_fail from mcp_cfdi.folio_stamp_reservation;
rollback;

\echo '--- 11. ninguna tabla de aplicación nueva queda sin RLS'
-- Trinquete: hoy, aplicando SOLO las migraciones del repo, quedan sin RLS dos catálogos
-- estáticos sin columnas de tenant (hoteles.reservation_status_transition: los pares
-- from/to de la máquina de estados; rentas.canal: catálogo de canales OTA), ambos con
-- solo GRANT SELECT a authenticated. En producción ya tienen RLS + policy de lectura
-- aplicadas fuera de migración (deriva documentada en el README de esta carpeta). Toda
-- tabla NUEVA sin RLS hace fallar este escenario.
begin;
select count(*) as tablas_sin_rls_deberia_ser_0
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where c.relkind in ('r', 'p') and not c.relrowsecurity
  and n.nspname not in ('pg_catalog', 'information_schema', 'pg_toast', 'auth', 'public')
  and (n.nspname, c.relname) not in (('hoteles', 'reservation_status_transition'), ('rentas', 'canal'));
rollback;
