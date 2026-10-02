-- H-28 CAMBIO DE FECHAS y H-12 LISTA DE ESPERA. Verifica contra Postgres REAL (nunca el mirror en memoria, que jamas aplica
-- RLS/GRANT/triggers/CHECK) que packages/domain-hoteles/migrations/041_hoteles_cambio_fechas_lista_espera.sql cierra lo que
-- dice cerrar: cambio de fechas atomico (inventario, noches posteadas, traslape de habitacion, bitacora), la membresia primero en
-- change_reservation_room y la lista de espera (RLS, GRANT de columna, transiciones). Corre via ./run.sh (local) o
-- scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto). Cada escenario va en su propio begin/rollback.
--
-- Convencion: public.verify_expect_error(sql, sqlstate) EXIGE el SQLSTATE exacto (42501 = RLS/GRANT/rol, 22023 = parametro invalido,
-- 55000 = estado invalido, 55006 = reserva modificada por otro, P0001 = sin disponibilidad, P0002 = no encontrada/otro tenant,
-- 23P01 = traslape de habitacion, 23514 = CHECK). public.verify_assert(cond, msg) falla el escenario si cond no es cierto. Los
-- positivos con valor usan alias con sufijo de valor exacto (..._deberia_ser_N) en la ULTIMA sentencia del escenario.
-- public.verify_as(sub) fija el rol authenticated con auth.uid() = sub; sub vacio = SESION DE SISTEMA (auth.uid() is null).
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

create or replace function public.verify_res_dates(p_res uuid) returns text language sql security definer as $$
  select check_in_date::text || '/' || check_out_date::text || '/' || total_amount::text from hoteles.reservation where id = p_res
$$;
create or replace function public.verify_booked(p_date date) returns integer language sql security definer as $$
  select booked_rooms from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = p_date
$$;
create or replace function public.verify_date_change_count(p_res uuid) returns integer language sql security definer as $$
  select count(*)::integer from hoteles.reservation_date_change where reservation_id = p_res
$$;
grant execute on function public.verify_res_dates(uuid), public.verify_booked(date), public.verify_date_change_count(uuid) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-fl'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-fl')
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
  ('00000000-0000-0000-0000-0000000a0a09', 'accountant-a@example.com', 'Accountant A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001', null, 'member', 'reservations'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000a0a09', '00000000-0000-0000-0000-00000000a001', null, 'member', 'accountant'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble')
on conflict do nothing;
insert into hoteles.room (id, organization_id, property_id, room_type_id, code, status) values
  ('00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '101', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0102', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '102', 'ocupada'),
  ('00000000-0000-0000-0000-0000000f0103', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '103', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', 'B101', 'disponible')
on conflict do nothing;

-- Inventario de Doble (A): 3 habitaciones por noche del 1 al 10 de julio de 2031; reservado segun las reservas de abajo.
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms, booked_rooms)
select '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', d::date, 3,
       case d::date when '2031-07-01' then 1 when '2031-07-02' then 1 when '2031-07-03' then 3 when '2031-07-04' then 2 else 0 end
  from generate_series('2031-07-01'::date, '2031-07-10'::date, interval '1 day') d
on conflict do nothing;
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms, booked_rooms)
select '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', d::date, 3, 1
  from generate_series('2031-07-01'::date, '2031-07-10'::date, interval '1 day') d
on conflict do nothing;

insert into hoteles.guest (id, organization_id, property_id, full_name, email, phone) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Ana Torres', 'ana@example.com', '5511112222')
on conflict do nothing;

-- R1 confirmada 3-5 jul con la 101 (noches 3 y 4); R2 confirmada 3-5 jul sin habitacion; R3 en_estancia 1-4 jul con la 102 (noches 1,
-- 2 y 3; las noches 1 y 2 YA posteadas por el night-audit); R4 cancelada; R5 de otro hotel; R6 confirmada 6-8 jul con la 101 (traslapa
-- una extension de R1).
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, room_id, check_in_date, check_out_date, status, total_amount) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000f0101', '2031-07-03', '2031-07-05', 'confirmada', 2000),
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', null, null, '2031-07-03', '2031-07-05', 'confirmada', 2000),
  ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', null, '00000000-0000-0000-0000-0000000f0102', '2031-07-01', '2031-07-04', 'en_estancia', 3000),
  ('00000000-0000-0000-0000-0000000e0004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', null, null, '2031-07-03', '2031-07-05', 'cancelada', 2000),
  ('00000000-0000-0000-0000-0000000e0005', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', null, null, '2031-07-03', '2031-07-05', 'confirmada', 2000),
  ('00000000-0000-0000-0000-0000000e0006', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', null, '00000000-0000-0000-0000-0000000f0101', '2031-07-06', '2031-07-08', 'confirmada', 3000)
on conflict do nothing;
-- R6 no se refleja en el inventario del fixture a proposito (solo se usa para el traslape de habitacion de la 101).

insert into hoteles.folio (id, organization_id, property_id, reservation_id) values
  ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000e0003')
on conflict do nothing;
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000aa001', 'Hospedaje 2031-07-01', 1000, 160, 'hospedaje', '2031-07-01'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000aa001', 'Hospedaje 2031-07-02', 1000, 160, 'hospedaje', '2031-07-02')
on conflict do nothing;

-- =============================================================================
-- (a) Cambio de fechas
-- =============================================================================

\echo '=== 1. frontdesk extiende una reserva confirmada: fechas, total, inventario (solo la noche agregada) y bitacora ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select out_noches_reservadas, out_noches_liberadas from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, 'Extiende una noche');
select public.verify_assert(public.verify_res_dates('00000000-0000-0000-0000-0000000e0001') = '2031-07-03/2031-07-06/3000.00', 'fechas y total nuevos');
select public.verify_assert(public.verify_booked('2031-07-05') = 1 and public.verify_booked('2031-07-04') = 2 and public.verify_booked('2031-07-03') = 3, 'solo la noche agregada se reservo');
select public.verify_date_change_count('00000000-0000-0000-0000-0000000e0001') as bitacora_deberia_ser_1;
rollback;

\echo '=== 2. mover la llegada una noche antes y la salida una antes: libera y reserva por noche ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-02', '2031-07-04', 1800, 0, null);
select public.verify_assert(public.verify_booked('2031-07-02') = 2 and public.verify_booked('2031-07-04') = 1 and public.verify_booked('2031-07-03') = 3, 'noche 2 reservada, noche 4 liberada, noche 3 intacta');
select count(*) as fechas_ok_deberia_ser_1 from hoteles.reservation
 where id = '00000000-0000-0000-0000-0000000e0001' and check_in_date = '2031-07-02' and check_out_date = '2031-07-04' and total_amount = 1800;
rollback;

\echo '=== 3. sin cupo en una noche agregada: P0001 y NADA cambia (ni inventario ni fechas ni bitacora) ==='
begin;
update hoteles.availability set booked_rooms = 3 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-07-05';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, 'P0001');
select public.verify_assert(public.verify_res_dates('00000000-0000-0000-0000-0000000e0001') = '2031-07-03/2031-07-05/2000.00', 'fechas intactas');
select public.verify_date_change_count('00000000-0000-0000-0000-0000000e0001') as sin_bitacora_deberia_ser_0;
rollback;

\echo '=== 4. dos cambios compiten por la ultima habitacion de una noche: el primero entra, el segundo no sobrevende (P0001) ==='
begin;
update hoteles.availability set total_rooms = 1, booked_rooms = 0 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-07-05';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null);
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0002', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, 'P0001');
select public.verify_booked('2031-07-05') as noche_llena_deberia_ser_1;
rollback;

\echo '=== 5. fechas esperadas desactualizadas (otro cambio ya las movio): 55006 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-04', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, '55006');
select public.verify_date_change_count('00000000-0000-0000-0000-0000000e0001') as sin_bitacora_deberia_ser_0;
rollback;

\echo '=== 6. huesped en casa: acortar la salida libera solo noches futuras y respeta las posteadas ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0003', '2031-07-01', '2031-07-04', '2031-07-01', '2031-07-03', 2000, 150.50, 'Se va antes');
select public.verify_assert(public.verify_booked('2031-07-03') = 2 and public.verify_booked('2031-07-01') = 1 and public.verify_booked('2031-07-02') = 1, 'solo la noche 3 se libero');
select count(*) as penalidad_deberia_ser_1 from hoteles.reservation_date_change where reservation_id = '00000000-0000-0000-0000-0000000e0003' and penalty_amount = 150.50;
rollback;

\echo '=== 7. huesped en casa: no se puede dejar fuera una noche ya posteada por el night-audit (55000) ni mover la llegada (22023) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0003', '2031-07-01', '2031-07-04', '2031-07-01', '2031-07-02', 1000, 0, null)$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0003', '2031-07-01', '2031-07-04', '2031-07-02', '2031-07-04', 2000, 0, null)$q$, '22023');
select public.verify_booked('2031-07-01') as intacto_deberia_ser_1;
rollback;

\echo '=== 8. huesped en casa: extender la salida reserva la noche nueva ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0003', '2031-07-01', '2031-07-04', '2031-07-01', '2031-07-06', 5000, 0, null);
select public.verify_booked('2031-07-05') as noche_reservada_deberia_ser_1;
rollback;

\echo '=== 9. estados no modificables (cancelada) y parametros invalidos ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0004', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-05', 2000, 0, null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-06', '2031-07-05', 2000, 0, null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', -1, 0, null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, -5, null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2033-07-06', 3000, 0, null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, 'x')$q$, '22023');
select public.verify_date_change_count('00000000-0000-0000-0000-0000000e0001') as sin_bitacora_deberia_ser_0;
rollback;

\echo '=== 10. habitacion asignada con otra reserva en las fechas nuevas: 23P01 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-07', 3000, 0, null)$q$, '23P01');
select public.verify_booked('2031-07-05') as inventario_intacto_deberia_ser_0;
rollback;

\echo '=== 11. roles: housekeeping y contabilidad no cambian fechas (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, '42501');
select count(*) as intacta_deberia_ser_1 from hoteles.reservation
 where id = '00000000-0000-0000-0000-0000000e0001' and check_in_date = '2031-07-03' and check_out_date = '2031-07-05' and total_amount = 2000;
rollback;

\echo '=== 12. cross-tenant: el owner de otro hotel recibe "no encontrada" (P0002) y no toca el inventario ajeno ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000f9999', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, 'P0002');
select public.verify_booked('2031-07-05') as intacto_deberia_ser_0;
rollback;

\echo '=== 13. anon y sesion de sistema no ejecutan el cambio (42501) ==='
begin;
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null)$q$, '42501');
select 1 as ok_anon_y_sistema_rechazados;
rollback;

\echo '=== 14. bitacora: visible para staff de reservas, no para housekeeping ni otro tenant; sin escritura directa ni UPDATE/DELETE (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_dates('00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 3000, 0, null);
select public.verify_assert((select count(*) from hoteles.reservation_date_change) = 1, 'frontdesk ve la bitacora');
select public.verify_expect_error($q$insert into hoteles.reservation_date_change (organization_id, property_id, reservation_id, old_check_in, old_check_out, new_check_in, new_check_out, old_total, new_total) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000e0001', '2031-07-03', '2031-07-05', '2031-07-03', '2031-07-06', 1, 1)$q$, '42501');
select public.verify_expect_error($q$update hoteles.reservation_date_change set reason = 'reescrita'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.reservation_date_change$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert((select count(*) from hoteles.reservation_date_change) = 0, 'housekeeping no la ve');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert((select count(*) from hoteles.reservation_date_change) = 0, 'otro tenant no la ve');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.reservation_date_change set reason = 'reescrita'$q$, '42501');
select public.verify_date_change_count('00000000-0000-0000-0000-0000000e0001') as sigue_1_deberia_ser_1;
rollback;

-- =============================================================================
-- (b) Seguimiento #302: change_reservation_room con la membresia primero
-- =============================================================================

\echo '=== 15. cambio de habitacion: frontdesk reasigna la 101 -> 103 y queda la bitacora ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0103', 'Prefiere la 103');
select count(*) as cambio_deberia_ser_1 from hoteles.reservation_room_change where reservation_id = '00000000-0000-0000-0000-0000000e0001' and to_room_id = '00000000-0000-0000-0000-0000000f0103';
rollback;

\echo '=== 16. cambio de habitacion: otro tenant recibe P0002, rol ajeno 42501, anon/sistema 42501 (la membresia se revisa antes de bloquear) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0103', null)$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0103', null)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0103', null)$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0103', null)$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0103', null)$q$, '42501');
select 1 as ok_rechazos;
rollback;

-- =============================================================================
-- (c) Lista de espera
-- =============================================================================

\echo '=== 17. frontdesk agrega una entrada: organizacion, autor y estado los deriva la base ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guests, guest_name, contact_phone)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 2, 'Carla Mena', '5599998888');
select count(*) as entrada_deberia_ser_1 from hoteles.waitlist_entry
 where guest_name = 'Carla Mena' and organization_id = '00000000-0000-0000-0000-00000000a001' and created_by = '00000000-0000-0000-0000-0000000a0a03' and status = 'activa';
rollback;

\echo '=== 18. el cliente no falsifica organizacion/estado/oferta (GRANT de columna, 42501) ni usa un tipo de habitacion ajeno (22023) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (organization_id, property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone) values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Falsa', '5599998888')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone, status) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Falsa', '5599998888', 'ofrecida')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0004', '2031-07-03', '2031-07-05', 'Cruzada', '5599998888')$q$, '22023');
select count(*) as nada_creado_deberia_ser_0 from hoteles.waitlist_entry;
rollback;

\echo '=== 19. CHECK: sin contacto, fechas invertidas, nombre vacio, huespedes fuera de rango (23514) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Sin contacto')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-05', '2031-07-03', 'Invertida', '5599998888')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', ' ', '5599998888')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone, guests) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Muchos', '5599998888', 99)$q$, '23514');
select count(*) as nada_creado_deberia_ser_0 from hoteles.waitlist_entry;
rollback;

\echo '=== 20. roles y tenants: housekeeping/contabilidad no ven ni escriben (42501); otro tenant no ve; anon y sistema 42501 ==='
begin;
insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Carla Mena', '5599998888');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Intruso', '5599998888')$q$, '42501');
select public.verify_assert((select count(*) from hoteles.waitlist_entry) = 0, 'housekeeping no ve la lista');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_assert((select count(*) from hoteles.waitlist_entry) = 0, 'contabilidad no ve la lista');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert((select count(*) from hoteles.waitlist_entry) = 0, 'otro tenant no la ve');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Cruzada', '5599998888')$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$insert into hoteles.waitlist_entry (property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Sistema', '5599998888')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select count(*) from hoteles.waitlist_entry$q$, '42501');
select 1 as ok_rechazos;
rollback;

\echo '=== 21. transiciones: activa -> ofrecida (con vencimiento) -> aceptada con una reserva de la property; el resto se rechaza ==='
begin;
insert into hoteles.waitlist_entry (id, property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone)
values ('00000000-0000-0000-0000-0000000bb001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Carla Mena', '5599998888');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$update hoteles.waitlist_entry set status = 'aceptada' where id = '00000000-0000-0000-0000-0000000bb001'$q$, '55000');
select public.verify_expect_error($q$update hoteles.waitlist_entry set status = 'ofrecida' where id = '00000000-0000-0000-0000-0000000bb001'$q$, '22023');
select public.verify_expect_error($q$update hoteles.waitlist_entry set status = 'ofrecida', offer_expires_at = now() + interval '30 days' where id = '00000000-0000-0000-0000-0000000bb001'$q$, '22023');
update hoteles.waitlist_entry set status = 'ofrecida', offer_expires_at = now() + interval '24 hours' where id = '00000000-0000-0000-0000-0000000bb001';
select public.verify_expect_error($q$update hoteles.waitlist_entry set status = 'expirada' where id = '00000000-0000-0000-0000-0000000bb001'$q$, '55000');
select public.verify_expect_error($q$update hoteles.waitlist_entry set status = 'aceptada', reservation_id = '00000000-0000-0000-0000-0000000e0005' where id = '00000000-0000-0000-0000-0000000bb001'$q$, '22023');
update hoteles.waitlist_entry set status = 'aceptada', reservation_id = '00000000-0000-0000-0000-0000000e0002' where id = '00000000-0000-0000-0000-0000000bb001';
select public.verify_expect_error($q$update hoteles.waitlist_entry set status = 'cancelada' where id = '00000000-0000-0000-0000-0000000bb001'$q$, '55000');
select count(*) as aceptada_deberia_ser_1 from hoteles.waitlist_entry where id = '00000000-0000-0000-0000-0000000bb001' and status = 'aceptada' and offered_by = '00000000-0000-0000-0000-0000000a0a04' and offered_at is not null;
rollback;

\echo '=== 22. oferta vencida: no se acepta (55000) y si se puede marcar expirada; cancelar una activa; sin DELETE ni reescribir datos (42501) ==='
begin;
insert into hoteles.waitlist_entry (id, property_id, room_type_id, check_in_date, check_out_date, guest_name, contact_phone)
values ('00000000-0000-0000-0000-0000000bb002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Dora Paz', '5599997777'),
       ('00000000-0000-0000-0000-0000000bb003', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-07-03', '2031-07-05', 'Eva Rey', '5599996666');
set local session_replication_role = replica;
update hoteles.waitlist_entry set status = 'ofrecida', offer_expires_at = now() - interval '1 hour' where id = '00000000-0000-0000-0000-0000000bb002';
set local session_replication_role = origin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$update hoteles.waitlist_entry set status = 'aceptada', reservation_id = '00000000-0000-0000-0000-0000000e0002' where id = '00000000-0000-0000-0000-0000000bb002'$q$, '55000');
update hoteles.waitlist_entry set status = 'expirada' where id = '00000000-0000-0000-0000-0000000bb002';
update hoteles.waitlist_entry set status = 'cancelada' where id = '00000000-0000-0000-0000-0000000bb003';
select public.verify_expect_error($q$delete from hoteles.waitlist_entry where id = '00000000-0000-0000-0000-0000000bb003'$q$, '42501');
select public.verify_expect_error($q$update hoteles.waitlist_entry set guest_name = 'Otro nombre' where id = '00000000-0000-0000-0000-0000000bb003'$q$, '42501');
select count(*) as cerradas_deberia_ser_2 from hoteles.waitlist_entry where status in ('expirada', 'cancelada');
rollback;

\echo '=== 23. privilegios: las funciones no son ejecutables por anon, son security definer con search_path fijo ==='
begin;
select public.verify_assert(not has_function_privilege('anon', 'hoteles.change_reservation_dates(uuid, date, date, date, date, numeric, numeric, text)', 'execute'), 'anon sin EXECUTE en change_reservation_dates');
select public.verify_assert(not has_function_privilege('anon', 'hoteles.change_reservation_room(uuid, uuid, text)', 'execute'), 'anon sin EXECUTE en change_reservation_room');
select public.verify_assert(has_function_privilege('authenticated', 'hoteles.change_reservation_dates(uuid, date, date, date, date, numeric, numeric, text)', 'execute'), 'authenticated con EXECUTE');
select public.verify_assert(not has_function_privilege('anon', 'hoteles.waitlist_entry_before_insert()', 'execute'), 'anon sin EXECUTE en el trigger de insercion');
select public.verify_assert(not has_function_privilege('anon', 'hoteles.waitlist_entry_before_update()', 'execute'), 'anon sin EXECUTE en el trigger de actualizacion');
select public.verify_assert((select p.prosecdef from pg_proc p where p.oid = 'hoteles.change_reservation_dates(uuid, date, date, date, date, numeric, numeric, text)'::regprocedure), 'security definer');
select public.verify_assert((select 'search_path=core, hoteles, pg_temp' = any (p.proconfig) from pg_proc p where p.oid = 'hoteles.change_reservation_dates(uuid, date, date, date, date, numeric, numeric, text)'::regprocedure), 'search_path fijo');
select public.verify_assert((select 'search_path=core, hoteles, pg_temp' = any (p.proconfig) from pg_proc p where p.oid = 'hoteles.waitlist_entry_before_update()'::regprocedure), 'search_path fijo en el trigger');
select 1 as ok_privilegios;
rollback;

\echo 'Fin: los escenarios que terminan en ERROR por diseno estan envueltos en verify_expect_error; el resto devuelve filas con sufijo de valor exacto.'
