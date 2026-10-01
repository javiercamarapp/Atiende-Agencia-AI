-- H-27 / H-28 -- RECEPCION y FICHA DE HUESPED. Verifica contra Postgres REAL (nunca el mirror en memoria, que jamas aplica
-- RLS/GRANT/triggers/CHECK) que packages/domain-hoteles/migrations/038_hoteles_recepcion_ficha_huesped.sql cierra lo que dice
-- cerrar: notas del huesped con minimizacion y bloqueo por ARCO, cambio de habitacion atomico sin traslape, bitacora
-- append-only y bandera ARCO sin fuga. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI,
-- auto-descubierto). Mismo patron que verify-hoteles-grupos: fixtures persistentes (superusuario) + cada escenario en su
-- propio begin/rollback.
--
-- Convencion: public.verify_expect_error(sql, sqlstate) EXIGE el SQLSTATE exacto (42501 = RLS/GRANT/guard,
-- 22023 = parametro invalido, 55000 = estado invalido, P0002 = no encontrada/otro tenant, 23P01 = traslape de habitacion,
-- 23503 = referencia invalida). public.verify_assert(cond, msg) falla el escenario si cond no es cierto. Los positivos con
-- valor usan alias con sufijo de valor exacto (..._deberia_ser_N) en la ULTIMA sentencia del escenario (una sola por
-- escenario). public.verify_as(sub) fija el rol authenticated con auth.uid() = sub; sub vacio = SESION DE SISTEMA
-- (auth.uid() is null). public.verify_su() vuelve al superusuario.
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

-- Estado de una habitacion / reserva leido sin RLS (security definer) para aserciones entre roles.
create or replace function public.verify_room_status(p_room uuid) returns text language sql security definer as $$
  select status from hoteles.room where id = p_room
$$;
create or replace function public.verify_res_room(p_res uuid) returns uuid language sql security definer as $$
  select room_id from hoteles.reservation where id = p_res
$$;
create or replace function public.verify_change_count(p_res uuid) returns integer language sql security definer as $$
  select count(*)::integer from hoteles.reservation_room_change where reservation_id = p_res
$$;
grant execute on function public.verify_room_status(uuid), public.verify_res_room(uuid), public.verify_change_count(uuid) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-rf'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-rf')
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
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Suite'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble')
on conflict do nothing;

-- Habitaciones: 101-103 y 106 dobles libres; 104 doble fuera de servicio (marca); 105 doble sucia; 107 doble con una
-- inhabilitacion activa (registro); 201 suite; B-101 doble de otro hotel.
insert into hoteles.room (id, organization_id, property_id, room_type_id, code, status) values
  ('00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '101', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0102', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '102', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0103', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '103', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0104', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '104', 'fuera_de_servicio'),
  ('00000000-0000-0000-0000-0000000f0105', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '105', 'sucia'),
  ('00000000-0000-0000-0000-0000000f0106', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '106', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0107', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '107', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0201', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0002', '201', 'disponible'),
  ('00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', 'B101', 'disponible')
on conflict do nothing;

insert into hoteles.room_out_of_service (property_id, room_id, kind, reason, from_date)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000f0107', 'fuera_de_servicio', 'Fuga de agua', '2031-06-01')
on conflict do nothing;

insert into hoteles.guest (id, organization_id, property_id, full_name, email, phone) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Ana Torres', 'ana@example.com', '5511112222'),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Beto Ruiz', null, null),
  ('00000000-0000-0000-0000-0000000c0b01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Huesped B', null, null)
on conflict do nothing;

-- Reservas: R1 confirmada sin habitacion; R2 confirmada con 102 (12-15 jun); R3 en_estancia con 103 (10-13 jun);
-- R4 CANCELADA con 101 (12-15 jun: no cuenta como traslape); R5 de otro hotel; R6 check_out con 106 (10-13 jun: ya salio).
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, room_id, check_in_date, check_out_date, status, total_amount) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0001', null, '2031-06-12', '2031-06-15', 'confirmada', 3000),
  ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-0000000f0102', '2031-06-12', '2031-06-15', 'confirmada', 3000),
  ('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-0000000f0103', '2031-06-10', '2031-06-13', 'en_estancia', 3000),
  ('00000000-0000-0000-0000-0000000e0004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', null, '00000000-0000-0000-0000-0000000f0101', '2031-06-12', '2031-06-15', 'cancelada', 3000),
  ('00000000-0000-0000-0000-0000000e0005', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-0000000c0b01', null, '2031-06-12', '2031-06-15', 'confirmada', 3000),
  ('00000000-0000-0000-0000-0000000e0006', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', null, '00000000-0000-0000-0000-0000000f0106', '2031-06-10', '2031-06-13', 'check_out', 3000)
on conflict do nothing;

-- =============================================================================
-- (a) Notas y preferencias del huesped
-- =============================================================================

\echo '=== 1. frontdesk agrega una nota: organizacion, autor y fecha los deriva la base ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'preferencia', 'Prefiere piso alto y almohada extra');
select count(*) as nota_deberia_ser_1 from hoteles.guest_note
 where guest_id = '00000000-0000-0000-0000-0000000c0001' and kind = 'preferencia'
   and organization_id = '00000000-0000-0000-0000-00000000a001' and created_by = '00000000-0000-0000-0000-0000000a0a03' and archived_at is null;
rollback;

\echo '=== 2. el cliente no puede falsificar organizacion ni autor (GRANT de columna, 42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.guest_note (organization_id, property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'x')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body, created_by) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'x', '00000000-0000-0000-0000-0000000a0a01')$q$, '42501');
select count(*) as nada_creado_deberia_ser_0 from hoteles.guest_note;
rollback;

\echo '=== 3. roles sin acceso al CRM (housekeeping, contabilidad) no ven ni escriben notas (RLS) ==='
begin;
set local session_replication_role = replica;
insert into hoteles.guest_note (organization_id, property_id, guest_id, kind, body, created_by) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'Nota previa', null);
set local session_replication_role = origin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'intruso')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'intruso')$q$, '42501');
select count(*) as no_ve_nada_deberia_ser_0 from hoteles.guest_note;
rollback;

\echo '=== 4. cross-tenant: el owner de otro hotel no ve notas ni puede escribir sobre un huesped ajeno ==='
begin;
set local session_replication_role = replica;
insert into hoteles.guest_note (organization_id, property_id, guest_id, kind, body, created_by) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'Nota previa', null);
set local session_replication_role = origin;
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'ajena')$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'huesped de otra property')$q$, '23503');
select count(*) as no_ve_nada_deberia_ser_0 from hoteles.guest_note;
rollback;

\echo '=== 5. anon y sesion de sistema no escriben notas ==='
begin;
select public.verify_anon();
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'anon')$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'sistema')$q$, '42501');
select 1 as ok_anon_y_sistema_rechazados;
rollback;

\echo '=== 6. minimizacion: una nota con numero de tarjeta o de documento (13 a 19 digitos) se rechaza (22023) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'Tarjeta 4111 1111 1111 1111 vence 12/30')$q$, '22023');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'Pasaporte 1234-5678-9012-345')$q$, '22023');
insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'Llamar a la habitacion 1203 y pedir ext 2200');
select count(*) as solo_la_corta_deberia_ser_1 from hoteles.guest_note;
rollback;

\echo '=== 7. CHECK: cuerpo vacio o de mas de 500 caracteres, tipo invalido (23514) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', '   ')$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', repeat('a', 501))$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'secreto', 'x')$q$, '23514');
select count(*) as nada_creado_deberia_ser_0 from hoteles.guest_note;
rollback;

\echo '=== 8. archivar: solo archived_at, una vez; el cuerpo es inmutable y no hay DELETE ==='
begin;
set local session_replication_role = replica;
insert into hoteles.guest_note (id, organization_id, property_id, guest_id, kind, body, created_by) values ('00000000-0000-0000-0000-0000000aaa01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'Nota archivable', null);
set local session_replication_role = origin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$update hoteles.guest_note set body = 'reescrita' where id = '00000000-0000-0000-0000-0000000aaa01'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.guest_note where id = '00000000-0000-0000-0000-0000000aaa01'$q$, '42501');
update hoteles.guest_note set archived_at = now() where id = '00000000-0000-0000-0000-0000000aaa01';
select public.verify_expect_error($q$update hoteles.guest_note set archived_at = now() where id = '00000000-0000-0000-0000-0000000aaa01'$q$, '42501');
select count(*) as archivada_por_frontdesk_deberia_ser_1 from hoteles.guest_note where id = '00000000-0000-0000-0000-0000000aaa01' and archived_by = '00000000-0000-0000-0000-0000000a0a03' and archived_at is not null;
rollback;

\echo '=== 9. ARCO: con cancelacion/oposicion en curso no se agregan notas (55000); una improcedente o un acceso no bloquean ==='
begin;
insert into hoteles.arco_request (organization_id, property_id, folio, right_type, guest_id, requester_name, channel, received_on, response_due_on, status)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-RF-1', 'oposicion', '00000000-0000-0000-0000-0000000c0001', 'Ana Torres', 'mostrador', '2031-06-01', '2031-06-21', 'recibida'),
       ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-RF-2', 'cancelacion', '00000000-0000-0000-0000-0000000c0002', 'Beto Ruiz', 'mostrador', '2031-06-01', '2031-06-21', 'recibida');
update hoteles.arco_request set status = 'en_revision' where folio = 'ARCO-RF-2';
update hoteles.arco_request set status = 'improcedente', decided_on = '2031-06-03', decision_note = 'No es titular' where folio = 'ARCO-RF-2';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0001', 'nota', 'no deberia entrar')$q$, '55000');
insert into hoteles.guest_note (property_id, guest_id, kind, body) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000c0002', 'nota', 'Solicitud improcedente: si se permite');
select count(*) as solo_beto_deberia_ser_1 from hoteles.guest_note;
rollback;

-- =============================================================================
-- (b) Bandera ARCO sin fuga
-- =============================================================================

\echo '=== 10. guest_has_arco_restriction: frontdesk ve verdadero/falso sin leer la tabla ARCO; roles ajenos y anon reciben falso ==='
begin;
insert into hoteles.arco_request (organization_id, property_id, folio, right_type, guest_id, requester_name, channel, received_on, response_due_on, status)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-RF-3', 'cancelacion', '00000000-0000-0000-0000-0000000c0001', 'Ana Torres', 'mostrador', '2031-06-01', '2031-06-21', 'recibida');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert(hoteles.guest_has_arco_restriction('00000000-0000-0000-0000-0000000c0001') is true, 'frontdesk ve la bandera de Ana');
select public.verify_assert(hoteles.guest_has_arco_restriction('00000000-0000-0000-0000-0000000c0002') is false, 'Beto no tiene solicitud');
select public.verify_assert((select count(*) from hoteles.arco_request) = 0, 'frontdesk no lee la tabla ARCO (solo la bandera)');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert(hoteles.guest_has_arco_restriction('00000000-0000-0000-0000-0000000c0001') is false, 'housekeeping no recibe la bandera');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert(hoteles.guest_has_arco_restriction('00000000-0000-0000-0000-0000000c0001') is false, 'otro tenant no recibe la bandera');
select public.verify_anon();
select public.verify_expect_error($q$select hoteles.guest_has_arco_restriction('00000000-0000-0000-0000-0000000c0001')$q$, '42501');
select 1 as ok_bandera_sin_fuga;
rollback;

-- =============================================================================
-- (c) Cambio / asignacion de habitacion atomico
-- =============================================================================

\echo '=== 11. frontdesk asigna 101 a una reserva sin habitacion: queda asignada y con bitacora (la cancelada R4 no traslapa) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', 'Asignacion al llegar');
select public.verify_su();
select count(*) as asignada_y_con_bitacora_deberia_ser_1 from hoteles.reservation_room_change
 where reservation_id = '00000000-0000-0000-0000-0000000e0001' and from_room_id is null and to_room_id = '00000000-0000-0000-0000-0000000f0101'
   and changed_by = '00000000-0000-0000-0000-0000000a0a03' and reason = 'Asignacion al llegar'
   and public.verify_res_room('00000000-0000-0000-0000-0000000e0001') = '00000000-0000-0000-0000-0000000f0101';
rollback;

\echo '=== 12. traslape: 102 ya esta asignada a otra reserva activa en las mismas fechas (23P01) y no cambia nada ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0102', null)$q$, '23P01');
select public.verify_su();
select public.verify_assert(public.verify_res_room('00000000-0000-0000-0000-0000000e0001') is null, 'la reserva sigue sin habitacion');
select public.verify_change_count('00000000-0000-0000-0000-0000000e0001') as sin_bitacora_deberia_ser_0;
rollback;

\echo '=== 13. una reserva que ya salio (check_out) no bloquea la habitacion: 106 se puede asignar ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0106', null);
select public.verify_su();
select public.verify_change_count('00000000-0000-0000-0000-0000000e0001') as una_entrada_deberia_ser_1;
rollback;

\echo '=== 14. cambio con el huesped en casa: la anterior queda sucia, la nueva ocupada y el traslape se evalua en las fechas de la reserva ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000f0101', 'Ruido en la 103');
select public.verify_su();
select public.verify_assert(public.verify_room_status('00000000-0000-0000-0000-0000000f0103') = 'sucia', 'la 103 queda sucia');
select public.verify_assert(public.verify_room_status('00000000-0000-0000-0000-0000000f0101') = 'ocupada', 'la 101 queda ocupada');
select public.verify_change_count('00000000-0000-0000-0000-0000000e0003') as cambio_registrado_deberia_ser_1;
rollback;

\echo '=== 15. habitacion fuera de servicio (marca o inhabilitacion activa) o sucia con el huesped en casa se rechaza (55000) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0104', null)$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0107', null)$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0003', '00000000-0000-0000-0000-0000000f0105', null)$q$, '55000');
select 1 as ok_no_aptas;
rollback;

\echo '=== 16. una habitacion sucia SI se puede pre-asignar a una llegada futura (confirmada) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0105', null);
select public.verify_su();
select public.verify_change_count('00000000-0000-0000-0000-0000000e0001') as preasignada_deberia_ser_1;
rollback;

\echo '=== 17. tipo distinto, misma habitacion, otra property o inexistente se rechazan (22023 / P0002) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0201', null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000f0102', null)$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0b01', null)$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000dead', null)$q$, 'P0002');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', 'x')$q$, '22023');
select 1 as ok_validaciones;
rollback;

\echo '=== 18. estados no modificables: cancelada o check_out no cambian de habitacion (55000) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0004', '00000000-0000-0000-0000-0000000f0107', null)$q$, '55000');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0006', '00000000-0000-0000-0000-0000000f0101', null)$q$, '55000');
select 1 as ok_estados;
rollback;

\echo '=== 19. roles: reservations, housekeeping y accountant no asignan (42501); otro tenant ve "no encontrada" (P0002); anon y sistema (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', null)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', null)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', null)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', null)$q$, 'P0002');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', null)$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', null)$q$, '42501');
select public.verify_su();
select public.verify_change_count('00000000-0000-0000-0000-0000000e0001') as sin_bitacora_deberia_ser_0;
rollback;

-- =============================================================================
-- (d) Bitacora append-only
-- =============================================================================

\echo '=== 20. la bitacora no se escribe ni se edita desde el cliente (42501) y ni el superusuario la altera ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select * from hoteles.change_reservation_room('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101', 'Primera asignacion');
select public.verify_expect_error($q$insert into hoteles.reservation_room_change (organization_id, property_id, reservation_id, to_room_id) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000f0101')$q$, '42501');
select public.verify_expect_error($q$update hoteles.reservation_room_change set reason = 'editado'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.reservation_room_change$q$, '42501');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.reservation_room_change set reason = 'editado por superusuario'$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.reservation_room_change$q$, '42501');
select 1 as ok_append_only;
rollback;

\echo '=== 21. RLS de la bitacora: frontdesk ve los cambios de su property; housekeeping y otro tenant no ven nada ==='
begin;
insert into hoteles.reservation_room_change (organization_id, property_id, reservation_id, from_room_id, to_room_id, changed_by)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000e0002', null, '00000000-0000-0000-0000-0000000f0102', null);
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert((select count(*) from hoteles.reservation_room_change) = 0, 'housekeeping no ve la bitacora');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert((select count(*) from hoteles.reservation_room_change) = 0, 'otro tenant no ve la bitacora');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select count(*) as frontdesk_ve_1_deberia_ser_1 from hoteles.reservation_room_change;
rollback;

\echo '=== 22. anon no tiene acceso a las tablas nuevas (42501) ==='
begin;
select public.verify_anon();
select public.verify_expect_error($q$select count(*) from hoteles.guest_note$q$, '42501');
select public.verify_expect_error($q$select count(*) from hoteles.reservation_room_change$q$, '42501');
select 1 as ok_anon_sin_acceso;
rollback;

\echo '=== 23. la funcion de cambio y el trigger de notas no son ejecutables por public/anon (privilegios) ==='
begin;
select public.verify_assert(not has_function_privilege('anon', 'hoteles.change_reservation_room(uuid, uuid, text)', 'execute'), 'anon sin EXECUTE en change_reservation_room');
select public.verify_assert(not has_function_privilege('anon', 'hoteles.guest_has_arco_restriction(uuid)', 'execute'), 'anon sin EXECUTE en guest_has_arco_restriction');
select public.verify_assert(has_function_privilege('authenticated', 'hoteles.change_reservation_room(uuid, uuid, text)', 'execute'), 'authenticated con EXECUTE');
select public.verify_assert(not has_function_privilege('anon', 'hoteles.guest_note_guard()', 'execute'), 'anon sin EXECUTE en el guard');
select public.verify_assert((select p.prosecdef from pg_proc p where p.oid = 'hoteles.change_reservation_room(uuid, uuid, text)'::regprocedure), 'security definer');
select public.verify_assert((select 'search_path=core, hoteles, pg_temp' = any (p.proconfig) from pg_proc p where p.oid = 'hoteles.change_reservation_room(uuid, uuid, text)'::regprocedure), 'search_path fijo');
select 1 as ok_privilegios;
rollback;

\echo 'Fin: los escenarios que terminan en ERROR por diseno estan envueltos en verify_expect_error; el resto devuelve filas con sufijo de valor exacto.'
