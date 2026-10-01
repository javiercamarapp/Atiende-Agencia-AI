-- H-04 (P0) — HOUSEKEEPING COMPLETO (tareas de limpieza, fuera de servicio, estado de
-- habitacion). Verifica contra Postgres REAL (nunca el mirror en memoria de
-- domain-hoteles, que jamas aplica RLS/GRANT/triggers/CHECK) que
-- packages/domain-hoteles/migrations/033_housekeeping_completo.sql cierra lo que dice
-- cerrar. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs
-- (CI, auto-descubierto). Mismo patron que verify-hoteles-boveda-identidad: fixtures
-- persistentes (superusuario) + cada escenario en su propio begin/rollback.
--
-- Convencion de los negativos: public.verify_expect_error(sql, sqlstate) ejecuta la
-- sentencia bajo el rol/auth.uid() activo y EXIGE el SQLSTATE exacto (42501 = RLS o
-- GRANT, 23514 = CHECK/trigger, 23503 = FK, 23505 = unico). Los positivos/filtros
-- silenciosos usan alias *_deberia_ser_N (valor exacto).
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.verify_expect_error(p_sql text, p_sqlstate text) returns void
language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception 'esperaba SQLSTATE %, obtuve % (%) en: %', p_sqlstate, v_state, v_msg, p_sql;
    end if;
    return;
  end;
  raise exception 'esperaba SQLSTATE % pero la sentencia no fallo: %', p_sqlstate, p_sql;
end;
$$;
grant execute on function public.verify_expect_error(text, text) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-hk'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-hk')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a04', 'reservations-a@example.com', 'Reservations A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'housekeeping-a@example.com', 'Housekeeping A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a06', 'housekeeping2-a@example.com', 'Housekeeping A2', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a07', 'maintenance-a@example.com', 'Maintenance A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a08', 'fnb-a@example.com', 'FNB A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001', null, 'member', 'reservations'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a06', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a07', '00000000-0000-0000-0000-00000000a001', null, 'member', 'maintenance'),
  ('00000000-0000-0000-0000-0000000a0a08', '00000000-0000-0000-0000-00000000a001', null, 'member', 'fnb'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000bc001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble A'),
  ('00000000-0000-0000-0000-0000000bc002', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble B')
on conflict do nothing;

-- Hotel A: 101 sucia, 102 ocupada, 103 disponible, 104 sucia. Hotel B: 201 sucia.
insert into hoteles.room (id, organization_id, property_id, room_type_id, code, status) values
  ('00000000-0000-0000-0000-0000000ab101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bc001', '101', 'sucia'),
  ('00000000-0000-0000-0000-0000000ab102', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bc001', '102', 'ocupada'),
  ('00000000-0000-0000-0000-0000000ab103', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bc001', '103', 'disponible'),
  ('00000000-0000-0000-0000-0000000ab104', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bc001', '104', 'sucia'),
  ('00000000-0000-0000-0000-0000000bb201', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000bc002', '201', 'sucia')
on conflict do nothing;

-- Tarea fixture (hk1 la tiene asignada, pendiente) y una inhabilitacion activa de la 104
-- pre-existente? No: la 104 queda libre para los escenarios de fuera de servicio.
insert into hoteles.housekeeping_task (id, organization_id, property_id, room_id, task_type, status, work_date, assigned_to, created_by) values
  ('00000000-0000-0000-0000-0000000cc101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab101', 'salida', 'pendiente', '2026-03-10', '00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-0000000a0a03'),
  ('00000000-0000-0000-0000-0000000cc201', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000bb201', 'salida', 'pendiente', '2026-03-10', null, '00000000-0000-0000-0000-0000000b0b01')
on conflict do nothing;

-- =============================================================================
-- (a) Tareas: crear (positivo, trigger, GRANT de columna, cross-tenant, anon)
-- =============================================================================

\echo '=== 1. frontdesk crea una tarea de limpieza en SU property ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.housekeeping_task (property_id, room_id, task_type, work_date, created_by)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', 'profunda', '2026-03-10', '00000000-0000-0000-0000-0000000a0a03')
returning id, status;
select count(*) as tarea_visible_deberia_ser_1 from hoteles.housekeeping_task where room_id = '00000000-0000-0000-0000-0000000ab103' and status = 'pendiente';
rollback;

\echo '=== 2. el trigger DERIVA organization_id desde core.property (el cliente no puede mandarlo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.housekeeping_task (property_id, room_id, work_date)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10');
select count(*) as derivado_deberia_ser_1 from hoteles.housekeeping_task
 where room_id = '00000000-0000-0000-0000-0000000ab103' and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 3. mandar organization_id en el INSERT es rechazado por el GRANT de columna (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (organization_id, property_id, room_id, work_date) values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10')$q$, '42501');
rollback;

\echo '=== 4. housekeeping puede crear tareas; fnb y reservations NO (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.housekeeping_task (property_id, room_id, work_date)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-11');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (property_id, room_id, work_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-12')$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a04', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (property_id, room_id, work_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-12')$q$, '42501');
rollback;

\echo '=== 5. cross-tenant: owner de Hotel B no crea tareas en la property de Hotel A (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (property_id, room_id, work_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10')$q$, '42501');
rollback;

\echo '=== 6. cross-tenant: owner de Hotel B ve 0 tareas de Hotel A (RLS) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajenas_deberia_ser_0 from hoteles.housekeeping_task where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 7. una habitacion de OTRA property es rechazada por la FK compuesta (23503) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (property_id, room_id, work_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bb201', '2026-03-20')$q$, '23503');
rollback;

\echo '=== 8. asignar a staff de OTRA organizacion es rechazado por el trigger (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (property_id, room_id, work_date, assigned_to) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10', '00000000-0000-0000-0000-0000000b0b01')$q$, '23514');
rollback;

\echo '=== 9. anon no puede insertar ni leer tareas (42501) ==='
begin;
set local role anon;
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (property_id, room_id, work_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10')$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.housekeeping_task$q$, '42501');
rollback;

\echo '=== 10. una segunda tarea ACTIVA de la misma habitacion/dia/tipo es rechazada (23505); una cancelada no estorba ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task (property_id, room_id, task_type, work_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab101', 'salida', '2026-03-10')$q$, '23505');
update hoteles.housekeeping_task set status = 'cancelada', updated_at = now() where id = '00000000-0000-0000-0000-0000000cc101';
insert into hoteles.housekeeping_task (property_id, room_id, task_type, work_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab101', 'salida', '2026-03-10');
rollback;

-- =============================================================================
-- (b) Ciclo iniciar -> terminar -> inspeccionar (CHECK, GRANT de columna, roles)
-- =============================================================================

\echo '=== 11. ciclo completo: hk1 inicia y termina; frontdesk inspecciona y aprueba ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
update hoteles.housekeeping_task set status = 'en_progreso', started_at = now(), updated_at = now() where id = '00000000-0000-0000-0000-0000000cc101' and status = 'pendiente';
update hoteles.housekeeping_task set status = 'terminada', finished_at = now(), updated_at = now() where id = '00000000-0000-0000-0000-0000000cc101' and status = 'en_progreso';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.housekeeping_task set status = 'inspeccionada', inspection_result = 'aprobada', inspected_by = '00000000-0000-0000-0000-0000000a0a03', inspected_at = now(), updated_at = now() where id = '00000000-0000-0000-0000-0000000cc101' and status = 'terminada';
update hoteles.room set status = 'disponible' where id = '00000000-0000-0000-0000-0000000ab101';
select count(*) as ciclo_deberia_ser_1 from hoteles.housekeeping_task t join hoteles.room r on r.id = t.room_id where t.id = '00000000-0000-0000-0000-0000000cc101' and t.status = 'inspeccionada' and r.status = 'disponible';
rollback;

\echo '=== 12. el CHECK impide terminar una tarea sin hora de termino (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$update hoteles.housekeeping_task set status = 'terminada' where id = '00000000-0000-0000-0000-0000000cc101'$q$, '23514');
rollback;

\echo '=== 13. quien limpio no puede inspeccionar su propio trabajo (23514, separacion de funciones) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$update hoteles.housekeeping_task set status = 'inspeccionada', finished_at = now(), inspection_result = 'aprobada', inspected_by = '00000000-0000-0000-0000-0000000a0a05', inspected_at = now() where id = '00000000-0000-0000-0000-0000000cc101'$q$, '23514');
rollback;

\echo '=== 14. un estado inspeccionada sin resultado aprobada es rechazado (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$update hoteles.housekeeping_task set status = 'inspeccionada', finished_at = now() where id = '00000000-0000-0000-0000-0000000cc101'$q$, '23514');
rollback;

\echo '=== 15. inspeccion RECHAZADA: la tarea vuelve a pendiente con rejections + 1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.housekeeping_task set status = 'pendiente', inspection_result = 'rechazada', inspected_by = '00000000-0000-0000-0000-0000000a0a03', inspected_at = now(), inspection_note = 'Falta polvo en repisas', rejections = rejections + 1, finished_at = null, updated_at = now() where id = '00000000-0000-0000-0000-0000000cc101';
select count(*) as rechazo_deberia_ser_1 from hoteles.housekeeping_task where id = '00000000-0000-0000-0000-0000000cc101' and status = 'pendiente' and rejections = 1 and inspection_result = 'rechazada';
rollback;

\echo '=== 16. columnas inmutables: room_id, organization_id y work_date no se pueden UPDATE (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$update hoteles.housekeeping_task set room_id = '00000000-0000-0000-0000-0000000ab103' where id = '00000000-0000-0000-0000-0000000cc101'$q$, '42501');
select public.verify_expect_error($q$update hoteles.housekeeping_task set organization_id = '00000000-0000-0000-0000-00000000b001' where id = '00000000-0000-0000-0000-0000000cc101'$q$, '42501');
select public.verify_expect_error($q$update hoteles.housekeeping_task set work_date = '2026-04-01' where id = '00000000-0000-0000-0000-0000000cc101'$q$, '42501');
rollback;

\echo '=== 17. authenticated no puede borrar tareas (42501): se cancelan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$delete from hoteles.housekeeping_task where id = '00000000-0000-0000-0000-0000000cc101'$q$, '42501');
rollback;

\echo '=== 18. fnb no actualiza tareas: la policy filtra en silencio (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
with u as (update hoteles.housekeeping_task set status = 'cancelada', updated_at = now() where id = '00000000-0000-0000-0000-0000000cc101' returning 1)
select count(*) as fnb_actualizadas_deberia_ser_0 from u;
rollback;

\echo '=== 19. cross-tenant: owner de Hotel B no actualiza tareas de Hotel A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
with u as (update hoteles.housekeeping_task set status = 'cancelada', updated_at = now() where id = '00000000-0000-0000-0000-0000000cc101' returning 1)
select count(*) as ajenas_actualizadas_deberia_ser_0 from u;
rollback;

-- =============================================================================
-- (c) Generar el dia / tablero / reporte (el SQL EXACTO que usa el repositorio)
-- =============================================================================

\echo '=== 20. generar el dia: crea tareas para sucias/ocupadas sin tarea activa y es idempotente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.housekeeping_task (property_id, room_id, task_type, priority, work_date, created_by)
select r.property_id, r.id, case when r.status = 'ocupada' then 'estancia' else 'salida' end, 'normal', '2026-03-10'::date, '00000000-0000-0000-0000-0000000a0a03'::uuid
from hoteles.room r
where r.property_id = '00000000-0000-0000-0000-0000000a1a01' and r.status in ('sucia', 'ocupada')
  and not exists (select 1 from hoteles.room_out_of_service o where o.room_id = r.id and o.status = 'activo')
  and not exists (select 1 from hoteles.housekeeping_task t where t.room_id = r.id and t.work_date = '2026-03-10'::date and t.status <> 'cancelada')
on conflict do nothing;
insert into hoteles.housekeeping_task (property_id, room_id, task_type, priority, work_date, created_by)
select r.property_id, r.id, case when r.status = 'ocupada' then 'estancia' else 'salida' end, 'normal', '2026-03-10'::date, '00000000-0000-0000-0000-0000000a0a03'::uuid
from hoteles.room r
where r.property_id = '00000000-0000-0000-0000-0000000a1a01' and r.status in ('sucia', 'ocupada')
  and not exists (select 1 from hoteles.room_out_of_service o where o.room_id = r.id and o.status = 'activo')
  and not exists (select 1 from hoteles.housekeeping_task t where t.room_id = r.id and t.work_date = '2026-03-10'::date and t.status <> 'cancelada')
on conflict do nothing;
select count(*) as generadas_deberia_ser_3 from hoteles.housekeeping_task where property_id = '00000000-0000-0000-0000-0000000a1a01' and work_date = '2026-03-10';
rollback;

\echo '=== 21. tablero: una fila por habitacion con su tarea del dia y su inhabilitacion activa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select count(*) as tablero_deberia_ser_4 from (
  select r.id, r.code, r.status as room_status, rt.name as room_type_name,
         t.id as task_id, t.task_type, t.status as task_status, t.priority, t.assigned_to, t.rejections,
         o.id as oos_id, o.kind as oos_kind, o.reason as oos_reason, o.expected_return_date
  from hoteles.room r
  join hoteles.room_type rt on rt.id = r.room_type_id
  left join lateral (
    select * from hoteles.housekeeping_task x
    where x.room_id = r.id and x.work_date = '2026-03-10'::date and x.status <> 'cancelada'
    order by x.created_at desc limit 1
  ) t on true
  left join hoteles.room_out_of_service o on o.room_id = r.id and o.status = 'activo'
  where r.property_id = '00000000-0000-0000-0000-0000000a1a01'
) tablero;
rollback;

\echo '=== 22. reporte diario: agrega por responsable sin error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as reporte_deberia_ser_1 from (
  select t.assigned_to, count(*) as total,
         count(*) filter (where t.status = 'pendiente') as pendientes,
         count(*) filter (where t.status = 'en_progreso') as en_progreso,
         count(*) filter (where t.status = 'terminada') as por_inspeccionar,
         count(*) filter (where t.status = 'inspeccionada') as inspeccionadas,
         coalesce(sum(t.rejections), 0)::int as rechazos,
         round(avg(extract(epoch from (t.finished_at - t.started_at)) / 60) filter (where t.started_at is not null and t.finished_at is not null))::int as minutos_promedio
  from hoteles.housekeeping_task t
  where t.property_id = '00000000-0000-0000-0000-0000000a1a01' and t.work_date = '2026-03-10'::date and t.status <> 'cancelada'
  group by t.assigned_to
) rep;
rollback;

-- =============================================================================
-- (d) Estado de habitacion (GRANT por columna + policy por rol)
-- =============================================================================

\echo '=== 23. housekeeping y maintenance mueven room.status; el CHECK de valores sigue mandando ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
update hoteles.room set status = 'disponible' where id = '00000000-0000-0000-0000-0000000ab101';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a07', true);
update hoteles.room set status = 'mantenimiento' where id = '00000000-0000-0000-0000-0000000ab103';
select public.verify_expect_error($q$update hoteles.room set status = 'inventado' where id = '00000000-0000-0000-0000-0000000ab103'$q$, '23514');
select count(*) as estado_deberia_ser_2 from hoteles.room where id in ('00000000-0000-0000-0000-0000000ab101', '00000000-0000-0000-0000-0000000ab103') and status in ('disponible', 'mantenimiento');
rollback;

\echo '=== 24. fnb y reservations no mueven room.status (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
with u as (update hoteles.room set status = 'disponible' where id = '00000000-0000-0000-0000-0000000ab101' returning 1)
select count(*) as fnb_actualizadas_deberia_ser_0 from u;
rollback;

\echo '=== 25. cross-tenant: owner de Hotel B no mueve el estado de una habitacion de Hotel A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
with u as (update hoteles.room set status = 'disponible' where id = '00000000-0000-0000-0000-0000000ab101' returning 1)
select count(*) as ajenas_actualizadas_deberia_ser_0 from u;
rollback;

\echo '=== 26. solo la columna status es actualizable en hoteles.room (code/room_type_id: 42501); anon rechazado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$update hoteles.room set code = 'X' where id = '00000000-0000-0000-0000-0000000ab101'$q$, '42501');
select public.verify_expect_error($q$update hoteles.room set property_id = '00000000-0000-0000-0000-0000000b1b01' where id = '00000000-0000-0000-0000-0000000ab101'$q$, '42501');
set local role anon;
select public.verify_expect_error($q$update hoteles.room set status = 'disponible' where id = '00000000-0000-0000-0000-0000000ab101'$q$, '42501');
rollback;

-- =============================================================================
-- (e) Fuera de servicio / fuera de orden
-- =============================================================================

\echo '=== 27. maintenance inhabilita una habitacion; housekeeping y fnb NO (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a07', true);
insert into hoteles.room_out_of_service (property_id, room_id, kind, reason, from_date, expected_return_date, created_by)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab104', 'fuera_de_orden', 'Fuga en el bano', '2026-03-10', '2026-03-14', '00000000-0000-0000-0000-0000000a0a07');
update hoteles.room set status = 'fuera_de_servicio' where id = '00000000-0000-0000-0000-0000000ab104';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', 'Pintura', '2026-03-10')$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select public.verify_expect_error($q$insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', 'Pintura', '2026-03-10')$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select count(*) as inhabilitada_visible_deberia_ser_1 from hoteles.room_out_of_service where room_id = '00000000-0000-0000-0000-0000000ab104' and status = 'activo';
rollback;

\echo '=== 28. dos inhabilitaciones ACTIVAS de la misma habitacion: 23505; reason corta/fechas incoherentes: 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab104', 'Renovacion', '2026-03-10');
select public.verify_expect_error($q$insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab104', 'Otra vez', '2026-03-10')$q$, '23505');
select public.verify_expect_error($q$insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', 'x', '2026-03-10')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date, expected_return_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', 'Pintura', '2026-03-10', '2026-03-01')$q$, '23514');
rollback;

\echo '=== 29. cerrar la inhabilitacion exige closed_at (23514 sin ella); con ella la habitacion regresa a sucia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab104', 'Renovacion', '2026-03-10');
select public.verify_expect_error($q$update hoteles.room_out_of_service set status = 'cerrado' where room_id = '00000000-0000-0000-0000-0000000ab104'$q$, '23514');
update hoteles.room_out_of_service set status = 'cerrado', closed_by = '00000000-0000-0000-0000-0000000a0a03', closed_at = now() where room_id = '00000000-0000-0000-0000-0000000ab104' and status = 'activo';
update hoteles.room set status = 'sucia' where id = '00000000-0000-0000-0000-0000000ab104';
select count(*) as cerrada_deberia_ser_1 from hoteles.room_out_of_service o join hoteles.room r on r.id = o.room_id where o.room_id = '00000000-0000-0000-0000-0000000ab104' and o.status = 'cerrado' and r.status = 'sucia';
rollback;

\echo '=== 30. cross-tenant y anon sobre fuera de servicio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', 'Pintura', '2026-03-10')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.room_out_of_service (property_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000ab103', 'Pintura', '2026-03-10')$q$, '23503');
set local role anon;
select public.verify_expect_error($q$select count(*) from hoteles.room_out_of_service$q$, '42501');
rollback;

\echo '=== 31. la inhabilitacion de otra property no es visible (RLS): owner B ve 0 ==='
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a07', true);
insert into hoteles.room_out_of_service (property_id, organization_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000ab104', 'Fixture', '2026-03-10');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajenas_deberia_ser_0 from hoteles.room_out_of_service where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 32. generar el dia salta habitaciones con inhabilitacion activa ==='
begin;
insert into hoteles.room_out_of_service (property_id, organization_id, room_id, reason, from_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000ab104', 'Fixture', '2026-03-10');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.housekeeping_task (property_id, room_id, task_type, priority, work_date, created_by)
select r.property_id, r.id, case when r.status = 'ocupada' then 'estancia' else 'salida' end, 'normal', '2026-03-10'::date, '00000000-0000-0000-0000-0000000a0a03'::uuid
from hoteles.room r
where r.property_id = '00000000-0000-0000-0000-0000000a1a01' and r.status in ('sucia', 'ocupada')
  and not exists (select 1 from hoteles.room_out_of_service o where o.room_id = r.id and o.status = 'activo')
  and not exists (select 1 from hoteles.housekeeping_task t where t.room_id = r.id and t.work_date = '2026-03-10'::date and t.status <> 'cancelada')
on conflict do nothing;
select count(*) as para_104_deberia_ser_0 from hoteles.housekeeping_task where room_id = '00000000-0000-0000-0000-0000000ab104' and work_date = '2026-03-10';
rollback;

-- =============================================================================
-- (f) Compatibilidad con la base SIN migrar: el repositorio degrada con SAVEPOINT
-- =============================================================================

\echo '=== 33. con hoteles.housekeeping_task ELIMINADA (42P01) el SAVEPOINT recupera la transaccion ==='
begin;
drop table hoteles.housekeeping_task cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
savepoint sp_verify_task_missing;
do $$
declare
  v_state text;
begin
  begin
    perform count(*) from hoteles.housekeeping_task;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_task_missing;
release savepoint sp_verify_task_missing;
select count(*) as tablero_sin_tareas_deberia_ser_4 from hoteles.room where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 34. control: tras los DDL destructivos revertidos las tablas siguen intactas ==='
begin;
select count(*) as tareas_intactas_deberia_ser_2 from hoteles.housekeeping_task;
rollback;
