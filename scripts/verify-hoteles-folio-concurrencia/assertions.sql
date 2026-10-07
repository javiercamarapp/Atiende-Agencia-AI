-- H-P3-01 (P0, dinero) -- FOLIO CERRADO ADMITE CARGO / CIERRE SIN GUARDA DE SALDO. Verifica contra Postgres REAL (nunca el
-- espejo en memoria, que no ejerce triggers/RLS/GRANT) que packages/domain-hoteles/migrations/045_hoteles_folio_cierre_carrera.sql
-- cierra lo que dice cerrar, en UNA conexion (lo que corre el gate de CI). La concurrencia real (dos sesiones + Promise.all,
-- 20 repeticiones) vive en run.sh (local, opt-in): el gate de CI corre cada escenario en una sola conexion.
-- Convenciones: igual que verify-hoteles-grupos (verify_expect_error exige SQLSTATE exacto; alias *_deberia_ser_N en la ULTIMA
-- sentencia del escenario; verify_as(sub) = authenticated; verify_anon(); verify_su() = superusuario).
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
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-fc'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-fc')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble')
on conflict do nothing;
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, total_amount) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-15', 0)
on conflict do nothing;
-- Dos folios abiertos de la misma reserva (el primario y uno secundario) para probar aislamiento entre folios.
insert into hoteles.folio (id, organization_id, property_id, reservation_id, is_primary, label) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000e0001', true, 'Principal'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000e0001', false, 'Secundario')
on conflict do nothing;

create or replace function public.verify_msg(p_sql text) returns text language plpgsql as $$
declare v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_msg = message_text;
    return v_msg;
  end;
  return null;
end;
$$;
grant execute on function public.verify_msg(text) to public;

create or replace function public.verify_cargo(p_folio uuid, p_amount numeric, p_tax numeric default 0) returns void language sql as $$
  insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', p_folio, 'Cargo de prueba', p_amount, p_tax, 'extras')
$$;
create or replace function public.verify_pago(p_folio uuid, p_amount numeric, p_status text default 'capturado') returns void language sql as $$
  insert into hoteles.payment (organization_id, property_id, folio_id, amount, method, status)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', p_folio, p_amount, 'efectivo', p_status)
$$;
create or replace function public.verify_cerrar(p_folio uuid, p_reason text) returns integer language sql as $$
  with u as (
    update hoteles.folio set status = 'cerrado', closed_at = now(), close_reason = p_reason, updated_at = now()
    where id = p_folio and status = 'abierto' returning id
  ) select count(*)::integer from u
$$;
grant execute on function public.verify_cargo(uuid, numeric, numeric), public.verify_pago(uuid, numeric, text), public.verify_cerrar(uuid, text) to public;

\echo '=== 1. un folio abierto sigue admitiendo cargos y pagos (el trigger no rompe el camino normal) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 100, 16);
select public.verify_pago('00000000-0000-0000-0000-0000000f0001', 50);
select count(*) as movimientos_deberia_ser_2 from (select id from hoteles.charge where folio_id = '00000000-0000-0000-0000-0000000f0001' union all select id from hoteles.payment where folio_id = '00000000-0000-0000-0000-0000000f0001') m;
rollback;

\echo '=== 2. folio cerrado: un cargo nuevo se rechaza con P0001 folio_cerrado (owner y frontdesk), sin dejar fila ==='
begin;
select public.verify_su();
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 10)$q$, 'P0001');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 10)$q$, 'P0001');
select public.verify_su();
select count(*) as sin_cargos_deberia_ser_0 from hoteles.charge where folio_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== 3. folio cerrado: un pago nuevo se rechaza con P0001 folio_cerrado, sin dejar fila ==='
begin;
select public.verify_su();
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'cuenta_por_cobrar');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select public.verify_pago('00000000-0000-0000-0000-0000000f0001', 10)$q$, 'P0001');
select public.verify_su();
select count(*) as sin_pagos_deberia_ser_0 from hoteles.payment where folio_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== 4. el mensaje del rechazo es el que la API traduce a 409 (folio_cerrado) ==='
begin;
select public.verify_su();
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero');
select public.verify_assert(
  public.verify_msg($q$select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 10)$q$) like 'folio_cerrado%',
  'el mensaje debe empezar por folio_cerrado');
select 1 as mensaje_ok_deberia_ser_1;
rollback;

\echo '=== 5. cerrar como saldo_cero con saldo pendiente se rechaza (P0001 cierre_saldo_distinto_de_cero); el folio sigue abierto ==='
begin;
select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 100, 16);
select public.verify_expect_error($q$select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero')$q$, 'P0001');
select count(*) as sigue_abierto_deberia_ser_1 from hoteles.folio where id = '00000000-0000-0000-0000-0000000f0001' and status = 'abierto';
rollback;

\echo '=== 6. cerrar como saldo_cero con saldo exactamente cero (cargo con impuesto menos pago capturado) SI cierra ==='
begin;
select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 100, 16);
select public.verify_pago('00000000-0000-0000-0000-0000000f0001', 116);
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero') as cerrado_deberia_ser_1;
rollback;

\echo '=== 7. un pago NO capturado (pendiente/fallido) no cuenta para el saldo: no permite cerrar saldo_cero ==='
begin;
select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 100, 0);
select public.verify_pago('00000000-0000-0000-0000-0000000f0001', 100, 'pendiente');
select public.verify_expect_error($q$select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero')$q$, 'P0001');
select count(*) as sigue_abierto_deberia_ser_1 from hoteles.folio where id = '00000000-0000-0000-0000-0000000f0001' and status = 'abierto';
rollback;

\echo '=== 8. cuenta_por_cobrar con saldo pendiente cierra (la guarda de saldo solo aplica a saldo_cero) ==='
begin;
select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 100, 16);
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'cuenta_por_cobrar') as cerrado_deberia_ser_1;
rollback;

\echo '=== 9. doble cierre: el segundo UPDATE ... where status = abierto no toca ninguna fila y no pisa closed_at/close_reason ==='
begin;
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero');
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'cuenta_por_cobrar') as segundo_cierre_deberia_ser_0;
rollback;

\echo '=== 10. el doble cierre conserva el motivo original ==='
begin;
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero');
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'cuenta_por_cobrar');
select count(*) as motivo_original_deberia_ser_1 from hoteles.folio where id = '00000000-0000-0000-0000-0000000f0001' and close_reason = 'saldo_cero';
rollback;

\echo '=== 11. aislamiento: cerrar un folio no bloquea cargos de OTRO folio abierto de la misma reserva ==='
begin;
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero');
select public.verify_cargo('00000000-0000-0000-0000-0000000f0002', 80, 0);
select count(*) as cargo_en_otro_folio_deberia_ser_1 from hoteles.charge where folio_id = '00000000-0000-0000-0000-0000000f0002';
rollback;

\echo '=== 12. otro tenant no inserta cargos en un folio ajeno (RLS, 42501) y anon tampoco ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 10)$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select public.verify_cargo('00000000-0000-0000-0000-0000000f0001', 10)$q$, '42501');
select public.verify_su();
select count(*) as nada_insertado_deberia_ser_0 from hoteles.charge where folio_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== 13. folio inexistente: el trigger responde P0001 folio_no_encontrado antes que el FK ==='
begin;
select public.verify_su();
select public.verify_expect_error($q$select public.verify_cargo('00000000-0000-0000-0000-0000000fffff', 10)$q$, 'P0001');
select 1 as ok_deberia_ser_1;
rollback;

\echo '=== 14. night audit: la lista de en-casa ya no devuelve un folio primario cerrado (folio nulo -> anomalia, no aborto) ==='
begin;
update hoteles.reservation set status = 'check_in' where id = '00000000-0000-0000-0000-0000000e0001';
select public.verify_cerrar('00000000-0000-0000-0000-0000000f0001', 'saldo_cero');
select public.verify_as('');
select count(*) as folio_nulo_deberia_ser_1 from hoteles.system_list_in_house_reservations_for_night_audit('00000000-0000-0000-0000-0000000a1a01', '2031-06-13') where out_reservation_id = '00000000-0000-0000-0000-0000000e0001' and out_folio_id is null;
rollback;

\echo '=== 15. night audit: con el folio primario abierto sigue devolviendolo ==='
begin;
update hoteles.reservation set status = 'check_in' where id = '00000000-0000-0000-0000-0000000e0001';
select public.verify_as('');
select count(*) as folio_abierto_deberia_ser_1 from hoteles.system_list_in_house_reservations_for_night_audit('00000000-0000-0000-0000-0000000a1a01', '2031-06-13') where out_reservation_id = '00000000-0000-0000-0000-0000000e0001' and out_folio_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== 16. las funciones de trigger no son invocables por authenticated ni anon (revoke de public, 42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.charge_payment_reject_on_closed_folio()$q$, '42501');
select public.verify_expect_error($q$select hoteles.folio_reject_inconsistent_close()$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select hoteles.charge_payment_reject_on_closed_folio()$q$, '42501');
select public.verify_su();
select 1 as ok_deberia_ser_1;
rollback;
