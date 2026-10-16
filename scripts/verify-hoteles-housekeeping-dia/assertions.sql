-- H-P3-04 (P1) -- EL DIA DE HOUSEKEEPING ARRANCA SOLO. Verifica contra Postgres REAL que
-- packages/domain-hoteles/migrations/045_hoteles_folio_cierre_carrera.sql (seccion 4) deja: la columna `start_hour` (CHECK 0..23, GRANT de
-- columna), el ledger `housekeeping_day_run` (RLS, sin escritura directa) y las funciones de SOLO SISTEMA `system_hk_*` (guard
-- auth.uid() is null, idempotencia por (property, fecha), opt-out, fuera de servicio, asignacion con guarda de estado, aislamiento entre
-- properties/tenants, anon). Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto).
-- Convenciones: igual que verify-hoteles-grupos (verify_expect_error exige SQLSTATE exacto; alias *_deberia_ser_N en la ULTIMA sentencia
-- del escenario; verify_as(sub) = authenticated; verify_as('') = SESION DE SISTEMA; verify_anon(); verify_su()).
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

create or replace function public.verify_assert(p_cond boolean, p_msg text) returns void language plpgsql as $$
begin
  if p_cond is not true then
    raise exception 'asercion fallida: %', p_msg;
  end if;
end;
$$;
grant execute on function public.verify_assert(boolean, text) to public;

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
create or replace function public.verify_su() returns void language plpgsql as $$
begin
  perform set_config('role', 'none', true);
  perform set_config('request.jwt.claim.sub', '', true);
end;
$$;
grant execute on function public.verify_as(text), public.verify_anon(), public.verify_su() to public;

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
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'hk1-a@example.com', 'Camarista Ana', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a06', 'hk2-a@example.com', 'Camarista Beto', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b05', 'hk-b@example.com', 'Camarista de B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a06', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000b0b05', '00000000-0000-0000-0000-00000000b001', null, 'member', 'housekeeping')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble')
on conflict do nothing;
insert into hoteles.room (id, organization_id, property_id, room_type_id, code, status) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '101', 'sucia'),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '102', 'ocupada'),
  ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '103', 'disponible'),
  ('00000000-0000-0000-0000-0000000c0004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '104', 'sucia'),
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', '201', 'sucia')
on conflict do nothing;
-- La 104 esta fuera de servicio (activa): no debe recibir tarea.
insert into hoteles.room_out_of_service (organization_id, property_id, room_id, kind, reason, from_date) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0004', 'fuera_de_orden', 'Fuga en el bano', '2031-06-01')
on conflict do nothing;

\echo '=== 1. sin fila propia, la configuracion efectiva para el cron esta vacia (el codigo usa los defaults: asignacion apagada, 07:00) ==='
begin;
select public.verify_as('');
select count(*) as sin_config_deberia_ser_0 from hoteles.system_hk_config('00000000-0000-0000-0000-0000000a1a01');
rollback;

\echo '=== 2. owner guarda hora de arranque y asignacion; la sesion de sistema la lee (RLS no la oculta) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.housekeeping_config (property_id, auto_assign_enabled, max_tasks_per_camarista, shift_minutes, minutes_salida, minutes_estancia, minutes_profunda, minutes_repaso, photos_required_on_inspection, max_photos_per_task, updated_by)
values ('00000000-0000-0000-0000-0000000a1a01', true, 14, 480, 40, 20, 90, 10, false, 6, '00000000-0000-0000-0000-0000000a0a01');
update hoteles.housekeeping_config set start_hour = 6 where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_as('');
select (out_auto_assign_enabled and out_start_hour = 6)::int as config_de_sistema_deberia_ser_1 from hoteles.system_hk_config('00000000-0000-0000-0000-0000000a1a01');
rollback;

\echo '=== 3. start_hour fuera de 0..23 se rechaza (23514, CHECK); frontdesk no puede cambiarla (RLS: 0 filas) ==='
begin;
select public.verify_su();
insert into hoteles.housekeeping_config (property_id) values ('00000000-0000-0000-0000-0000000a1a01');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$update hoteles.housekeeping_config set start_hour = 24 where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '23514');
select public.verify_expect_error($q$update hoteles.housekeeping_config set start_hour = -1 where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '23514');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
update hoteles.housekeeping_config set start_hour = 5 where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_su();
select count(*) as frontdesk_no_cambio_deberia_ser_1 from hoteles.housekeeping_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and start_hour = 7;
rollback;

\echo '=== 4. arrancar el dia: reclama el ledger y genera salida (sucia) y estancia (ocupada); NO la disponible ni la fuera de servicio ==='
begin;
select public.verify_as('');
select out_claimed::int as reclamado_deberia_ser_1 from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select public.verify_su();
select count(*) as tareas_generadas_deberia_ser_2 from hoteles.housekeeping_task where property_id = '00000000-0000-0000-0000-0000000a1a01' and work_date = '2031-06-12' and status = 'pendiente' and created_by is null;
rollback;

\echo '=== 5. tipos: la sucia es salida y la ocupada estancia ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select public.verify_su();
select count(*) as tipos_correctos_deberia_ser_2 from hoteles.housekeeping_task
 where property_id = '00000000-0000-0000-0000-0000000a1a01' and work_date = '2031-06-12' and ((room_id = '00000000-0000-0000-0000-0000000c0001' and task_type = 'salida') or (room_id = '00000000-0000-0000-0000-0000000c0002' and task_type = 'estancia'));
rollback;

\echo '=== 6. idempotente por (property, fecha): la segunda llamada no reclama ni genera nada ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select out_claimed::int + out_generated as segunda_corrida_deberia_ser_0 from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
rollback;

\echo '=== 7. la segunda corrida no duplica tareas ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select public.verify_su();
select count(*) as sin_duplicados_deberia_ser_2 from hoteles.housekeeping_task where property_id = '00000000-0000-0000-0000-0000000a1a01' and work_date = '2031-06-12';
rollback;

\echo '=== 8. un dia distinto vuelve a arrancar (el ledger es por fecha) ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select out_claimed::int as otro_dia_reclamado_deberia_ser_1 from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-13');
rollback;

\echo '=== 9. opt-out activo: la ocupada no recibe tarea de estancia, la sucia (salida) si ==='
begin;
select public.verify_su();
insert into hoteles.cleaning_opt_out (organization_id, property_id, room_id, opt_out_date, source) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0002', '2031-06-12', 'recepcion');
select public.verify_as('');
select out_generated as generadas_deberia_ser_1 from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
rollback;

\echo '=== 10. un opt-out de OTRO dia no afecta ==='
begin;
select public.verify_su();
insert into hoteles.cleaning_opt_out (organization_id, property_id, room_id, opt_out_date, source) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0002', '2031-06-14', 'recepcion');
select public.verify_as('');
select out_generated as generadas_deberia_ser_2 from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
rollback;

\echo '=== 11. el ledger guarda lo generado y el cierre registra asignadas/sin asignar ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select hoteles.system_hk_finish_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', 1, 1);
select public.verify_su();
select count(*) as ledger_deberia_ser_1 from hoteles.housekeeping_day_run where property_id = '00000000-0000-0000-0000-0000000a1a01' and work_date = '2031-06-12' and tasks_generated = 2 and tasks_assigned = 1 and tasks_unassigned = 1;
rollback;

\echo '=== 12. camaristas: solo las de housekeeping de ESA property/organizacion (no las de otro tenant ni otros roles) ==='
begin;
select public.verify_as('');
select count(*) as camaristas_deberia_ser_2 from hoteles.system_hk_list_camaristas('00000000-0000-0000-0000-0000000a1a01');
rollback;

\echo '=== 13. camaristas de otra property/tenant no se mezclan ==='
begin;
select public.verify_as('');
select count(*) as camarista_de_b_deberia_ser_1 from hoteles.system_hk_list_camaristas('00000000-0000-0000-0000-0000000b1b01') where out_user_id = '00000000-0000-0000-0000-0000000b0b05';
rollback;

\echo '=== 14. lista de tareas del dia: solo las de esa property y fecha ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000b1b01', '2031-06-12');
select count(*) as tareas_de_p_deberia_ser_2 from hoteles.system_hk_list_day_tasks('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
rollback;

\echo '=== 15. asignar: una tarea pendiente sin responsable se asigna; la segunda asignacion (carrera con una manual) devuelve false ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select hoteles.system_hk_assign_task('00000000-0000-0000-0000-0000000a1a01', (select out_task_id from hoteles.system_hk_list_day_tasks('00000000-0000-0000-0000-0000000a1a01', '2031-06-12') order by out_room_code limit 1), '00000000-0000-0000-0000-0000000a0a05')::int as primera_deberia_ser_1;
rollback;

\echo '=== 16. la segunda asignacion de la misma tarea no la pisa ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select hoteles.system_hk_assign_task('00000000-0000-0000-0000-0000000a1a01', (select out_task_id from hoteles.system_hk_list_day_tasks('00000000-0000-0000-0000-0000000a1a01', '2031-06-12') order by out_room_code limit 1), '00000000-0000-0000-0000-0000000a0a05');
select hoteles.system_hk_assign_task('00000000-0000-0000-0000-0000000a1a01', (select out_task_id from hoteles.system_hk_list_day_tasks('00000000-0000-0000-0000-0000000a1a01', '2031-06-12') order by out_room_code limit 1), '00000000-0000-0000-0000-0000000a0a06')::int as segunda_deberia_ser_0;
rollback;

\echo '=== 17. asignar a alguien que NO es staff de la property se rechaza (23514 por el trigger existente) ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select public.verify_expect_error($q$select hoteles.system_hk_assign_task('00000000-0000-0000-0000-0000000a1a01', (select out_task_id from hoteles.system_hk_list_day_tasks('00000000-0000-0000-0000-0000000a1a01', '2031-06-12') limit 1), '00000000-0000-0000-0000-0000000b0b05')$q$, '23514');
select 1 as ok_deberia_ser_1;
rollback;

\echo '=== 18. asignar una tarea de OTRA property (id cruzado) no hace nada: devuelve false ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select hoteles.system_hk_assign_task('00000000-0000-0000-0000-0000000b1b01', (select out_task_id from hoteles.system_hk_list_day_tasks('00000000-0000-0000-0000-0000000a1a01', '2031-06-12') limit 1), '00000000-0000-0000-0000-0000000b0b05')::int as cruzado_deberia_ser_0;
rollback;

\echo '=== 19. SOLO SISTEMA: ningun staff (owner, frontdesk, housekeeping, otro tenant) ejecuta las funciones system_hk_* (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.system_hk_config('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.system_hk_list_day_tasks('00000000-0000-0000-0000-0000000a1a01', '2031-06-12')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.system_hk_list_camaristas('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_expect_error($q$select hoteles.system_hk_assign_task('00000000-0000-0000-0000-0000000a1a01', gen_random_uuid(), '00000000-0000-0000-0000-0000000a0a05')$q$, '42501');
select public.verify_expect_error($q$select hoteles.system_hk_finish_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', 1, 1)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12')$q$, '42501');
select public.verify_su();
select count(*) as nada_generado_deberia_ser_0 from hoteles.housekeeping_task where property_id = '00000000-0000-0000-0000-0000000a1a01' and work_date = '2031-06-12';
rollback;

\echo '=== 20. anon no ejecuta las funciones (42501, revoke de public/anon) ==='
begin;
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12')$q$, '42501');
select public.verify_expect_error($q$select * from hoteles.system_hk_config('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_su();
select 1 as ok_deberia_ser_1;
rollback;

\echo '=== 21. property inexistente: P0002, sin ledger huerfano ==='
begin;
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000fffff', '2031-06-12')$q$, 'P0002');
select public.verify_su();
select count(*) as sin_ledger_deberia_ser_0 from hoteles.housekeeping_day_run;
rollback;

\echo '=== 22. ledger: el staff de la property lo lee (RLS), el de otro tenant no, y nadie escribe directo (42501) ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select count(*) from hoteles.housekeeping_day_run;
select public.verify_expect_error($q$insert into hoteles.housekeeping_day_run (property_id, work_date, organization_id) values ('00000000-0000-0000-0000-0000000a1a01', '2031-06-20', '00000000-0000-0000-0000-00000000a001')$q$, '42501');
select public.verify_expect_error($q$update hoteles.housekeeping_day_run set tasks_generated = 99$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.housekeeping_day_run$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select count(*) as otro_tenant_no_ve_deberia_ser_0 from hoteles.housekeeping_day_run;
rollback;

\echo '=== 23. el dueño de A ve su ledger ==='
begin;
select public.verify_as('');
select * from hoteles.system_hk_start_day('00000000-0000-0000-0000-0000000a1a01', '2031-06-12');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select count(*) as ledger_visible_deberia_ser_1 from hoteles.housekeeping_day_run;
rollback;

\echo '=== 24. anon no lee el ledger (42501) ==='
begin;
select public.verify_anon();
select public.verify_expect_error($q$select count(*) from hoteles.housekeeping_day_run$q$, '42501');
select public.verify_su();
select 1 as ok_deberia_ser_1;
rollback;
