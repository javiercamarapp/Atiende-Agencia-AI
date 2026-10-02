-- H-26 + H-29 hoteles -- HOUSEKEEPING RESIDUAL (config, fotos de inspeccion, conteo de blancos,
-- opt-out de limpieza) y CONFIGURACION DEL CANAL (whatsapp_channel_config, voice_agent_config).
-- Verifica contra Postgres REAL (nunca el mirror en memoria de domain-hoteles, que jamas aplica
-- RLS/GRANT/triggers/CHECK) que packages/domain-hoteles/migrations/039_hoteles_hk_residual_canal.sql
-- cierra lo que dice cerrar. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs
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
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-hkc'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-hkc')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - P1'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - P1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'housekeeping-a@example.com', 'Housekeeping A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a08', 'fnb-a@example.com', 'FNB A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a08', '00000000-0000-0000-0000-00000000a001', null, 'member', 'fnb'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000bc001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble A'),
  ('00000000-0000-0000-0000-0000000bc002', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble B')
on conflict do nothing;
insert into hoteles.room (id, organization_id, property_id, room_type_id, code, status) values
  ('00000000-0000-0000-0000-0000000ab101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bc001', '101', 'sucia'),
  ('00000000-0000-0000-0000-0000000ab103', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bc001', '103', 'disponible'),
  ('00000000-0000-0000-0000-0000000bb201', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000bc002', '201', 'sucia')
on conflict do nothing;
insert into hoteles.housekeeping_task (id, organization_id, property_id, room_id, task_type, status, work_date, created_by) values
  ('00000000-0000-0000-0000-0000000cc101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab101', 'salida', 'pendiente', '2026-03-10', '00000000-0000-0000-0000-0000000a0a03'),
  ('00000000-0000-0000-0000-0000000cc201', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000bb201', 'salida', 'pendiente', '2026-03-10', '00000000-0000-0000-0000-0000000b0b01')
on conflict do nothing;
insert into hoteles.housekeeping_task (id, organization_id, property_id, room_id, task_type, status, work_date, created_by) values
  ('00000000-0000-0000-0000-0000000cc102', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', 'salida', 'cancelada', '2026-03-09', '00000000-0000-0000-0000-0000000a0a03')
on conflict do nothing;
-- Canal de B ya registrado con un numero (para el unico cross-property) y voz de A con secreto.
insert into hoteles.whatsapp_channel_config (property_id, organization_id, phone_number_id, enabled) values
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', '15550009999', true) on conflict do nothing;
insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret, enabled) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'secreto-de-voz-fixture-hkc-a', true) on conflict do nothing;

-- =============================================================================
-- (a) Configuracion de housekeeping
-- =============================================================================

\echo '=== 1. owner crea la config de housekeeping; organization_id se DERIVA por trigger ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.housekeeping_config (property_id, auto_assign_enabled, updated_by) values ('00000000-0000-0000-0000-0000000a1a01', true, '00000000-0000-0000-0000-0000000a0a01');
select count(*) as config_derivada_deberia_ser_1 from hoteles.housekeeping_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and organization_id = '00000000-0000-0000-0000-00000000a001' and auto_assign_enabled and max_tasks_per_camarista = 14;
rollback;

\echo '=== 2. frontdesk/housekeeping/anon NO crean config (42501) y mandar organization_id es rechazado por el GRANT de columna ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_config (property_id) values ('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_config (property_id) values ('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_config (property_id, organization_id) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000b001')$q$, '42501');
set local role anon;
select public.verify_expect_error($q$select count(*) from hoteles.housekeeping_config$q$, '42501');
rollback;

\echo '=== 3. CHECKs de la config: tope de fotos (11) y minutos (0) fuera de rango = 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_config (property_id, max_photos_per_task) values ('00000000-0000-0000-0000-0000000a1a01', 11)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.housekeeping_config (property_id, minutes_salida) values ('00000000-0000-0000-0000-0000000a1a01', 0)$q$, '23514');
rollback;

\echo '=== 4. cross-tenant: owner de B no crea ni edita la config de A (42501 / 0 filas) y no la ve ==='
begin;
insert into hoteles.housekeeping_config (property_id, organization_id) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_config (property_id) values ('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
with u as (update hoteles.housekeeping_config set auto_assign_enabled = true where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_deberia_ser_0 from u;
select count(*) as ajenas_deberia_ser_0 from hoteles.housekeeping_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 5. frontdesk VE la config pero no la edita (0 filas); gm si; property_id es inmutable (42501) ==='
begin;
insert into hoteles.housekeeping_config (property_id, organization_id) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as visible_deberia_ser_1 from hoteles.housekeeping_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
with u as (update hoteles.housekeeping_config set shift_minutes = 300 where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_frontdesk_deberia_ser_0 from u;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
with u as (update hoteles.housekeeping_config set shift_minutes = 300, updated_by = '00000000-0000-0000-0000-0000000a0a02', updated_at = now() where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_gm_deberia_ser_1 from u;
select public.verify_expect_error($q$update hoteles.housekeeping_config set property_id = '00000000-0000-0000-0000-0000000b1b01' where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '42501');
rollback;

-- =============================================================================
-- (b) Fotos de inspeccion
-- =============================================================================

\echo '=== 6. housekeeping sube una foto; organization_id derivado; frontdesk la ve; otro tenant ve 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
select count(*) as foto_derivada_deberia_ser_1 from hoteles.housekeeping_task_photo where task_id = '00000000-0000-0000-0000-0000000cc101' and organization_id = '00000000-0000-0000-0000-00000000a001';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as visible_frontdesk_deberia_ser_1 from hoteles.housekeeping_task_photo where task_id = '00000000-0000-0000-0000-0000000cc101';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajenas_deberia_ser_0 from hoteles.housekeeping_task_photo where task_id = '00000000-0000-0000-0000-0000000cc101';
rollback;

\echo '=== 7. negativos de foto: tipo no permitido, tamano declarado distinto del real y > 1.5 MB = 23514; organization_id = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/gif', 4, '\xffd8ffe0'::bytea);$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 9, '\xffd8ffe0'::bytea);$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 1572865, repeat('a', 1572865)::bytea);$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, organization_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea)$q$, '42501');
rollback;

\echo '=== 8. fnb y anon NO suben fotos (42501); owner de B no sube a una tarea de A (42501) ni a una tarea ajena con property propia (23503) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);$q$, '23503');
set local role anon;
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);$q$, '42501');
rollback;

\echo '=== 9. tope por tarea: con el default de 6 la septima foto es 23514; una tarea cancelada no recibe fotos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc102', 'image/jpeg', 4, '\xffd8ffe0'::bytea);$q$, '23514');
rollback;

\echo '=== 10. el tope respeta la config de la property (max_photos_per_task = 1: la segunda es 23514) ==='
begin;
insert into hoteles.housekeeping_config (property_id, organization_id, max_photos_per_task) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 1);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
select public.verify_expect_error($q$insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);$q$, '23514');
rollback;

\echo '=== 11. housekeeping retira una foto (DELETE); fnb no (0 filas); la foto no se edita (UPDATE sin GRANT = 42501) ==='
begin;
insert into hoteles.housekeeping_task_photo (property_id, organization_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
with d as (delete from hoteles.housekeeping_task_photo where task_id = '00000000-0000-0000-0000-0000000cc101' returning 1) select count(*) as borradas_fnb_deberia_ser_0 from d;
select public.verify_expect_error($q$update hoteles.housekeeping_task_photo set caption = 'x'$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
with d as (delete from hoteles.housekeeping_task_photo where task_id = '00000000-0000-0000-0000-0000000cc101' returning 1) select count(*) as borradas_housekeeping_deberia_ser_1 from d;
rollback;

\echo '=== 12. al cancelar en cascada: borrar la tarea borra sus fotos (FK compuesta) ==='
begin;
insert into hoteles.housekeeping_task_photo (property_id, organization_id, task_id, content_type, byte_size, image_data) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea);
delete from hoteles.housekeeping_task where id = '00000000-0000-0000-0000-0000000cc101';
select count(*) as fotos_huerfanas_deberia_ser_0 from hoteles.housekeeping_task_photo where task_id = '00000000-0000-0000-0000-0000000cc101';
rollback;

-- =============================================================================
-- (c) Conteo de blancos
-- =============================================================================

\echo '=== 13. housekeeping registra un conteo y el upsert (ON CONFLICT) lo corrige el mismo dia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'sabanas', 40, 12) on conflict (property_id, count_date, item) do update set qty_clean = excluded.qty_clean, qty_dirty = excluded.qty_dirty, updated_at = now();
insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'sabanas', 55, 3) on conflict (property_id, count_date, item) do update set qty_clean = excluded.qty_clean, qty_dirty = excluded.qty_dirty, updated_at = now();
select count(*) as un_solo_renglon_deberia_ser_1 from hoteles.linen_count where property_id = '00000000-0000-0000-0000-0000000a1a01' and item = 'sabanas' and qty_clean = 55 and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 14. negativos del conteo: cantidad negativa, articulo fuera de lista = 23514; duplicado = 23505; organization_id = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'sabanas', 40, 12);
select public.verify_expect_error($q$insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'sabanas', 40, 12)$q$, '23505');
select public.verify_expect_error($q$insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty, qty_laundry) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'toallas_bano', 40, 12, -1)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'cortinas', 40, 12)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.linen_count (property_id, organization_id, count_date, item) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000b001', '2026-03-10', 'fundas')$q$, '42501');
rollback;

\echo '=== 15. fnb y anon no registran (42501); owner de B no registra en A (42501) ni ve los conteos de A; sin DELETE (42501) ==='
begin;
insert into hoteles.linen_count (property_id, organization_id, count_date, item) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '2026-03-10', 'fundas');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select public.verify_expect_error($q$insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'sabanas', 40, 12)$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.linen_count (property_id, count_date, item, qty_clean, qty_dirty) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'sabanas', 40, 12)$q$, '42501');
select count(*) as ajenos_deberia_ser_0 from hoteles.linen_count;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$delete from hoteles.linen_count$q$, '42501');
set local role anon;
select public.verify_expect_error($q$select count(*) from hoteles.linen_count$q$, '42501');
rollback;

-- =============================================================================
-- (d) Opt-out de limpieza
-- =============================================================================

\echo '=== 16. frontdesk registra un opt-out; organization_id derivado; uno activo por habitacion y dia (23505) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10');
select count(*) as optout_deberia_ser_1 from hoteles.cleaning_opt_out where room_id = '00000000-0000-0000-0000-0000000ab103' and organization_id = '00000000-0000-0000-0000-00000000a001' and status = 'activo';
select public.verify_expect_error($q$insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10')$q$, '23505');
rollback;

\echo '=== 17. revertir sella reverted_at/reverted_by en el servidor (040); despues se puede volver a registrar el mismo dia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10');
update hoteles.cleaning_opt_out set status = 'revertido' where room_id = '00000000-0000-0000-0000-0000000ab103' and status = 'activo';
select count(*) as revertido_sellado_deberia_ser_1 from hoteles.cleaning_opt_out where room_id = '00000000-0000-0000-0000-0000000ab103' and status = 'revertido' and reverted_at is not null and reverted_by = '00000000-0000-0000-0000-0000000a0a03';
insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10');
select count(*) as historial_deberia_ser_2 from hoteles.cleaning_opt_out where room_id = '00000000-0000-0000-0000-0000000ab103';
rollback;

\echo '=== 18. negativos: fnb 42501; habitacion de otra property 23503; owner de B 42501 y sin ver nada; anon 42501; organization_id 42501; sin DELETE ==='
begin;
insert into hoteles.cleaning_opt_out (property_id, organization_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000ab103', '2026-03-10');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select public.verify_expect_error($q$insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab999', '2026-03-11')$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000bb201', '2026-03-10')$q$, '23503');
select public.verify_expect_error($q$insert into hoteles.cleaning_opt_out (property_id, organization_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000ab103', '2026-03-12')$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.cleaning_opt_out$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-13')$q$, '42501');
select count(*) as ajenos_deberia_ser_0 from hoteles.cleaning_opt_out;
set local role anon;
select public.verify_expect_error($q$select count(*) from hoteles.cleaning_opt_out$q$, '42501');
rollback;

-- =============================================================================
-- (e) Canal de WhatsApp (H-29)
-- =============================================================================

\echo '=== 19. owner da de alta el canal; organization_id derivado; el webhook lo resuelve por numero (sesion de sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled, updated_by) values ('00000000-0000-0000-0000-0000000a1a01', '15550001234', true, '00000000-0000-0000-0000-0000000a0a01');
select count(*) as canal_deberia_ser_1 from hoteles.whatsapp_channel_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and organization_id = '00000000-0000-0000-0000-00000000a001';
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelve_por_numero_deberia_ser_1 from hoteles.whatsapp_channel_config where phone_number_id = '15550001234' and enabled;
rollback;

\echo '=== 20. frontdesk/fnb NO dan de alta el canal (42501); organization_id = 42501; anon = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '15550001234', true)$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a08', true);
select public.verify_expect_error($q$insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '15550001234', true)$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$insert into hoteles.whatsapp_channel_config (property_id, organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000b001', '15550001234')$q$, '42501');
set local role anon;
select public.verify_expect_error($q$insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '15550001234', true)$q$, '42501');
rollback;

\echo '=== 21. numero con formato invalido = 23514 (letras / muy corto); numero ya usado por otra property = 23505 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled) values ('00000000-0000-0000-0000-0000000a1a01', 'abc12345', true)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '123', true)$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '15550009999', true)$q$, '23505');
rollback;

\echo '=== 22. gm edita numero y habilitado; frontdesk no (0 filas); owner de B no (0 filas); property_id inmutable (42501) ==='
begin;
insert into hoteles.whatsapp_channel_config (property_id, organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '15550001234');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
with u as (update hoteles.whatsapp_channel_config set enabled = false where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_frontdesk_deberia_ser_0 from u;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
with u as (update hoteles.whatsapp_channel_config set enabled = false where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_otro_tenant_deberia_ser_0 from u;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
with u as (update hoteles.whatsapp_channel_config set phone_number_id = '15550007777', enabled = false, updated_by = '00000000-0000-0000-0000-0000000a0a02', updated_at = now() where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_gm_deberia_ser_1 from u;
select public.verify_expect_error($q$update hoteles.whatsapp_channel_config set property_id = '00000000-0000-0000-0000-0000000b1b01' where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '42501');
rollback;

-- =============================================================================
-- (f) Voz (H-29): el secreto ya no es legible ni editable por cualquier staff
-- =============================================================================

\echo '=== 23. owner ve el estado (enabled) pero NO puede leer el secreto (42501 por GRANT de columna) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select count(*) as estado_visible_deberia_ser_1 from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and enabled;
select public.verify_expect_error($q$select tool_webhook_secret from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '42501');
rollback;

\echo '=== 24. frontdesk/fnb ya NO ven la voz de la property (0 filas) ni la editan (0 filas) ni la crean (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as visible_frontdesk_deberia_ser_0 from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
with u as (update hoteles.voice_agent_config set enabled = false where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_frontdesk_deberia_ser_0 from u;
select public.verify_expect_error($q$insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'otro-secreto-de-voz-0001') on conflict (property_id) do update set tool_webhook_secret = excluded.tool_webhook_secret$q$, '42501');
rollback;

\echo '=== 25. owner rota el secreto con el upsert real del repositorio (parametros, sin excluded.*); la sesion de sistema ve el secreto nuevo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'secreto-rotado-0123456789', true) on conflict (property_id) do update set tool_webhook_secret = 'secreto-rotado-0123456789', enabled = true, updated_at = now();
select set_config('request.jwt.claim.sub', '', true);
select (out_tool_webhook_secret = 'secreto-rotado-0123456789')::int as sistema_ve_secreto_nuevo_deberia_ser_1 from hoteles.system_find_voice_agent_config('00000000-0000-0000-0000-0000000a1a01');
rollback;

\echo '=== 26. el owner crea la voz de una property sin fila previa; organization_id se deriva aunque mande el de otro tenant ==='
begin;
delete from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000b001', 'secreto-nuevo-0123456789', true);
select count(*) as org_derivada_deberia_ser_1 from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 27. owner de B no ve ni edita la voz de A; property_id es inmutable (42501); anon 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajenas_deberia_ser_0 from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
with u as (update hoteles.voice_agent_config set enabled = false where property_id = '00000000-0000-0000-0000-0000000a1a01' returning 1) select count(*) as editadas_deberia_ser_0 from u;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$update hoteles.voice_agent_config set property_id = '00000000-0000-0000-0000-0000000b1b01' where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '42501');
set local role anon;
select public.verify_expect_error($q$select count(*) from hoteles.voice_agent_config$q$, '42501');
rollback;

-- =============================================================================
-- (g) Compatibilidad con la base SIN migrar: el repositorio degrada con SAVEPOINT
-- =============================================================================

\echo '=== 28. con hoteles.linen_count ELIMINADA (42P01) el SAVEPOINT recupera la transaccion ==='
begin;
drop table hoteles.linen_count cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
savepoint sp_verify_linen_missing;
do $$
declare
  v_state text;
begin
  begin
    perform count(*) from hoteles.linen_count;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_linen_missing;
release savepoint sp_verify_linen_missing;
select count(*) as sesion_sigue_viva_deberia_ser_2 from hoteles.room where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

-- =============================================================================
-- (h) Endurecimiento 040: autoria fijada por el servidor, opt-out revertido terminal, voz
-- =============================================================================

\echo '=== 29. autoria de config: el cliente manda OTRO updated_by (y updated_at falso) y se ignora: queda auth.uid() ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.housekeeping_config (property_id, updated_by) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000a0a02');
select count(*) as insert_updated_by_deberia_ser_1 from hoteles.housekeeping_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and updated_by = '00000000-0000-0000-0000-0000000a0a01';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
update hoteles.housekeeping_config set shift_minutes = 300, updated_by = '00000000-0000-0000-0000-0000000a0a01', updated_at = '2001-01-01' where property_id = '00000000-0000-0000-0000-0000000a1a01';
select count(*) as update_updated_by_deberia_ser_1 from hoteles.housekeeping_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and updated_by = '00000000-0000-0000-0000-0000000a0a02' and updated_at > now() - interval '1 minute';
rollback;

\echo '=== 30. autoria de canal WhatsApp: updated_by ajeno ignorado en alta y en edicion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.whatsapp_channel_config (property_id, phone_number_id, updated_by) values ('00000000-0000-0000-0000-0000000a1a01', '15550001234', '00000000-0000-0000-0000-0000000a0a02');
select count(*) as alta_deberia_ser_1 from hoteles.whatsapp_channel_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and updated_by = '00000000-0000-0000-0000-0000000a0a01';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
update hoteles.whatsapp_channel_config set enabled = false, updated_by = '00000000-0000-0000-0000-0000000a0a01', updated_at = '2001-01-01' where property_id = '00000000-0000-0000-0000-0000000a1a01';
select count(*) as edicion_deberia_ser_1 from hoteles.whatsapp_channel_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and updated_by = '00000000-0000-0000-0000-0000000a0a02' and updated_at > now() - interval '1 minute';
rollback;

\echo '=== 31. autoria de foto y de conteo: taken_by / counted_by ajenos ignorados; el conteo re-sella al corregir ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
insert into hoteles.housekeeping_task_photo (property_id, task_id, content_type, byte_size, image_data, taken_by) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000cc101', 'image/jpeg', 4, '\xffd8ffe0'::bytea, '00000000-0000-0000-0000-0000000a0a01');
select count(*) as foto_taken_by_deberia_ser_1 from hoteles.housekeeping_task_photo where task_id = '00000000-0000-0000-0000-0000000cc101' and taken_by = '00000000-0000-0000-0000-0000000a0a05';
insert into hoteles.linen_count (property_id, count_date, item, qty_clean, counted_by) values ('00000000-0000-0000-0000-0000000a1a01', '2026-03-10', 'sabanas', 10, '00000000-0000-0000-0000-0000000a0a01');
select count(*) as conteo_alta_deberia_ser_1 from hoteles.linen_count where item = 'sabanas' and counted_by = '00000000-0000-0000-0000-0000000a0a05';
update hoteles.linen_count set qty_clean = 11, counted_by = '00000000-0000-0000-0000-0000000a0a01', updated_at = '2001-01-01' where item = 'sabanas';
select count(*) as conteo_edicion_deberia_ser_1 from hoteles.linen_count where item = 'sabanas' and counted_by = '00000000-0000-0000-0000-0000000a0a05' and updated_at > now() - interval '1 minute';
rollback;

\echo '=== 32. autoria de opt-out: created_by ajeno ignorado al registrar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date, created_by) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10', '00000000-0000-0000-0000-0000000a0a01');
select count(*) as created_by_deberia_ser_1 from hoteles.cleaning_opt_out where room_id = '00000000-0000-0000-0000-0000000ab103' and created_by = '00000000-0000-0000-0000-0000000a0a03';
rollback;

\echo '=== 33. opt-out revertido es TERMINAL: no vuelve a activo (23514), no se re-sella, y el cliente no fija reverted_by/reverted_at falsos al revertir ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.cleaning_opt_out (property_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000ab103', '2026-03-10');
update hoteles.cleaning_opt_out set status = 'revertido', reverted_by = '00000000-0000-0000-0000-0000000a0a01', reverted_at = '2001-01-01' where room_id = '00000000-0000-0000-0000-0000000ab103';
select count(*) as sello_servidor_deberia_ser_1 from hoteles.cleaning_opt_out where room_id = '00000000-0000-0000-0000-0000000ab103' and status = 'revertido' and reverted_by = '00000000-0000-0000-0000-0000000a0a03' and reverted_at > now() - interval '1 minute';
select public.verify_expect_error($q$update hoteles.cleaning_opt_out set status = 'activo', reverted_at = null where room_id = '00000000-0000-0000-0000-0000000ab103'$q$, '23514');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select public.verify_expect_error($q$update hoteles.cleaning_opt_out set status = 'activo', reverted_by = null, reverted_at = null where room_id = '00000000-0000-0000-0000-0000000ab103'$q$, '23514');
update hoteles.cleaning_opt_out set reverted_by = '00000000-0000-0000-0000-0000000a0a02', reverted_at = now() + interval '1 day' where room_id = '00000000-0000-0000-0000-0000000ab103';
select count(*) as sello_intacto_deberia_ser_1 from hoteles.cleaning_opt_out where room_id = '00000000-0000-0000-0000-0000000ab103' and status = 'revertido' and reverted_by = '00000000-0000-0000-0000-0000000a0a03' and reverted_at < now() + interval '1 minute';
rollback;

\echo '=== 34. la regla terminal tambien rige para la sesion de sistema (sin auth.uid()); reactivar exige un opt-out NUEVO ==='
begin;
insert into hoteles.cleaning_opt_out (property_id, organization_id, room_id, opt_out_date, status, reverted_at) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000ab103', '2026-03-10', 'revertido', now());
select public.verify_expect_error($q$update hoteles.cleaning_opt_out set status = 'activo', reverted_at = null where room_id = '00000000-0000-0000-0000-0000000ab103'$q$, '23514');
insert into hoteles.cleaning_opt_out (property_id, organization_id, room_id, opt_out_date) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000ab103', '2026-03-10');
select count(*) as historial_deberia_ser_2 from hoteles.cleaning_opt_out where room_id = '00000000-0000-0000-0000-0000000ab103';
rollback;

\echo '=== 35. sesion de sistema (auth.uid() nulo): la autoria recibida se respeta ==='
begin;
insert into hoteles.linen_count (property_id, organization_id, count_date, item, counted_by) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', '2026-03-10', 'fundas', '00000000-0000-0000-0000-0000000a0a02');
select count(*) as sistema_respeta_deberia_ser_1 from hoteles.linen_count where item = 'fundas' and counted_by = '00000000-0000-0000-0000-0000000a0a02';
rollback;

\echo '=== 36. voz: ninguna policy `for all`, sobre voice_agent_config; solo owner/gm via can_configure_property ==='
select count(*) as policies_for_all_deberia_ser_0 from pg_policies where schemaname = 'hoteles' and tablename = 'voice_agent_config' and cmd = 'ALL';
select count(*) as policies_sin_can_configure_deberia_ser_0 from pg_policies where schemaname = 'hoteles' and tablename = 'voice_agent_config' and coalesce(qual, '') || coalesce(with_check, '') not like '%can_configure_property%';

\echo '=== 37. voz: organization_id ajeno en el INSERT del owner se sobreescribe (trigger); al rotar por upsert tampoco cambia la org ==='
begin;
delete from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.voice_agent_config (property_id, organization_id, tool_webhook_secret, enabled) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000b001', 'secreto-nuevo-0123456789', true)
  on conflict (property_id) do update set tool_webhook_secret = 'secreto-nuevo-0123456789', enabled = true, updated_at = now();
select count(*) as org_propia_deberia_ser_1 from hoteles.voice_agent_config where property_id = '00000000-0000-0000-0000-0000000a1a01' and organization_id = '00000000-0000-0000-0000-00000000a001';
select count(*) as org_ajena_deberia_ser_0 from hoteles.voice_agent_config where organization_id = '00000000-0000-0000-0000-00000000b001';
select public.verify_expect_error($q$update hoteles.voice_agent_config set organization_id = '00000000-0000-0000-0000-00000000b001' where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '42501');
rollback;
