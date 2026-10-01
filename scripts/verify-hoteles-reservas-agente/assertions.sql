-- H-25 (P0) hoteles -- AGENTE DE RESERVAS: disponibilidad, cotizacion con guardia de precio, hold con expiracion, aprobacion
-- humana o registro de link de pago, estado/cancelacion por el huesped. Verifica contra Postgres REAL (nunca el mirror en memoria,
-- que jamas aplica RLS/GRANT/triggers/CHECK) que packages/domain-hoteles/migrations/037_hoteles_agente_reservas.sql cierra lo
-- que dice cerrar. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto).
-- Convencion: igual que verify-hoteles-grupos (verify_expect_error exige el SQLSTATE exacto; los positivos con valor usan alias
-- ..._deberia_ser_N en la ULTIMA sentencia de cada escenario). verify_as('') = SESION DE SISTEMA (auth.uid() is null).
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

-- Cuartos retenidos (booked_rooms) de un tipo en una noche, sin RLS (security definer).
create or replace function public.verify_booked(p_rt uuid, p_date date) returns integer language sql security definer as $$
  select booked_rooms from hoteles.availability where room_type_id = p_rt and date = p_date
$$;
grant execute on function public.verify_booked(uuid, date) to public;

-- Hold de atajo (corre con el rol activo del escenario: sistema = verify_as('')). Doble A1 2031-06-12 -> 06-14 = 357000 centavos.
create or replace function public.verify_hold(
  p_key text, p_phone text default '5215550000001', p_rt uuid default '00000000-0000-0000-0000-0000000d0001',
  p_in date default '2031-06-12', p_out date default '2031-06-14', p_total bigint default 357000, p_guests integer default 2,
  p_prop uuid default '00000000-0000-0000-0000-0000000a1a01', p_now timestamptz default '2031-06-01T12:00:00Z'
) returns uuid language sql as $$
  select id from hoteles.booking_hold_create(p_prop, p_rt, p_in, p_out, p_guests, 'Ana', p_phone, 'whatsapp', p_key, p_total, p_now)
$$;
grant execute on function public.verify_hold(text, text, uuid, date, date, bigint, integer, uuid, timestamptz) to public;

-- Habilita la politica (como owner) y vuelve a sesion de sistema.
create or replace function public.verify_enable(p_mode text default 'aprobacion_humana') returns void language plpgsql as $$
begin
  perform public.verify_as('00000000-0000-0000-0000-0000000a0a01');
  insert into hoteles.booking_agent_policy (property_id, holds_enabled, mode) values ('00000000-0000-0000-0000-0000000a1a01', true, p_mode)
    on conflict (property_id) do update set holds_enabled = true, mode = p_mode;
  perform public.verify_as('');
end;
$$;
grant execute on function public.verify_enable(text) to public;

create or replace function public.verify_hid() returns table (id uuid) language sql security definer as $$ select h.id from hoteles.booking_hold h order by h.created_at limit 1 $$;
grant execute on function public.verify_hid() to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-ra'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-ra')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1 (CDMX)'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 2 (Tijuana)'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a04', 'reservations-a@example.com', 'Reservations A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'housekeeping-a@example.com', 'Housekeeping A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001', null, 'member', 'reservations'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;
insert into hoteles.property_config (property_id, organization_id, timezone) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'America/Tijuana')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name, max_occupancy) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble', 2),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Suite', 4),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a02', 'Doble', 2),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble', 2)
on conflict do nothing;
-- Inventario noches 12 y 13 de junio de 2031 (y 11 para Tijuana). Doble A1 = 2 cuartos, Suite A1 = 1, Doble A2 = 2, B1 = 2.
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms)
select o, p, rt, d::date, t
  from (values
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a01'::uuid, '00000000-0000-0000-0000-0000000d0001'::uuid, 2),
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a01'::uuid, '00000000-0000-0000-0000-0000000d0002'::uuid, 1),
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a02'::uuid, '00000000-0000-0000-0000-0000000d0003'::uuid, 2),
    ('00000000-0000-0000-0000-00000000b001'::uuid, '00000000-0000-0000-0000-0000000b1b01'::uuid, '00000000-0000-0000-0000-0000000d0004'::uuid, 2)
  ) as t(o, p, rt, t)
 cross join generate_series('2031-06-11'::date, '2031-06-13'::date, interval '1 day') d
on conflict do nothing;
-- Tarifas reales por noche: Doble 1500.00, Suite 5000.00 (con piso/techo 1000-3000 => fuera de guardia), Doble A2 900.00.
insert into hoteles.rate_plan (organization_id, property_id, room_type_id, date, price, min_stay)
select o, p, rt, d::date, price, ms
  from (values
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a01'::uuid, '00000000-0000-0000-0000-0000000d0001'::uuid, 1500.00, 1),
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a01'::uuid, '00000000-0000-0000-0000-0000000d0002'::uuid, 5000.00, 1),
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a02'::uuid, '00000000-0000-0000-0000-0000000d0003'::uuid, 900.00, 1),
    ('00000000-0000-0000-0000-00000000b001'::uuid, '00000000-0000-0000-0000-0000000b1b01'::uuid, '00000000-0000-0000-0000-0000000d0004'::uuid, 800.00, 1)
  ) as t(o, p, rt, price, ms)
 cross join generate_series('2031-06-11'::date, '2031-06-13'::date, interval '1 day') d
on conflict do nothing;
insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 0.16, 0.03)
on conflict do nothing;
insert into hoteles.pricing_rule (organization_id, property_id, room_type_id, floor_price, ceiling_price, day_of_week_multiplier) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0002', 1000, 3000, array[1,1,1,1,1,1,1]::numeric[]),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', 1000, 3000, array[1,1,1,1,1,1,1]::numeric[])
on conflict do nothing;

-- =============================================================================
-- (a) Disponibilidad y cotizacion (sesion de sistema)
-- =============================================================================

\echo '=== 1. el agente cotiza en centavos enteros desde rate_plan + tax_config: 2 noches x 1500 + IVA 16 % + ISH 3 % = 357000 ==='
begin;
select public.verify_as('');
select count(*) as cotizacion_deberia_ser_1 from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z')
 where room_type_name = 'Doble' and status = 'ok' and free_rooms = 2 and net_cents = 300000 and iva_cents = 48000 and ish_cents = 9000 and total_cents = 357000;
rollback;

\echo '=== 2. guardia de precio: una tarifa fuera de [piso, techo] de pricing_rule NO se cotiza (precio_fuera_de_guardia) ==='
begin;
select public.verify_as('');
select count(*) as fuera_de_guardia_deberia_ser_1 from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z')
 where room_type_name = 'Suite' and status = 'precio_fuera_de_guardia' and total_cents is null and net_cents is null;
rollback;

\echo '=== 3. noche sin tarifa => sin_tarifa; sin inventario => sin_inventario; nunca un precio inventado ==='
begin;
select public.verify_as('');
select public.verify_assert((select status from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-13', '2031-06-15', '2031-06-01T12:00:00Z') where room_type_name = 'Doble') = 'sin_inventario', 'noche 14 sin inventario');
select public.verify_su();
update hoteles.availability set booked_rooms = total_rooms where room_type_id = '00000000-0000-0000-0000-0000000d0001';
select public.verify_as('');
select count(*) as sin_inventario_deberia_ser_1 from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z')
 where room_type_name = 'Doble' and status = 'sin_inventario' and free_rooms = 0 and total_cents is null;
rollback;

\echo '=== 4. fechas absurdas: salida <= llegada, pasada, a mas de 365 dias, mas de 14 noches, nulas (22023) ==='
begin;
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-14', '2031-06-12', '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-12', '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-20T12:00:00Z')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2033-06-12', '2033-06-14', '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-07-12', '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', null, '2031-06-14', '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_su();
select count(*) as sin_efectos_deberia_ser_0 from hoteles.booking_hold;
rollback;

\echo '=== 5. zona horaria de la property: a las 06:30Z del 12-jun, CDMX ya esta en el 12 (11 es pasado) y Tijuana aun en el 11 ==='
begin;
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-11', '2031-06-12', '2031-06-12T06:30:00Z')$q$, '22023');
select count(*) as tijuana_aun_en_el_11_deberia_ser_1 from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a02', '2031-06-11', '2031-06-12', '2031-06-12T06:30:00Z') where status = 'ok';
rollback;

\echo '=== 6. solo el sistema consulta: staff (42501), anon (42501); property inexistente o de otro vertical (P0002) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z')$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$select * from hoteles.agent_stay_options(gen_random_uuid(), '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z')$q$, 'P0002');
select public.verify_su();
select count(*) as sin_efectos_deberia_ser_0 from hoteles.booking_hold;
rollback;

-- =============================================================================
-- (b) Politica por hotel
-- =============================================================================

\echo '=== 7. sin politica el agente NO crea holds (55000, fail-closed) y no retiene inventario ==='
begin;
select public.verify_as('');
select public.verify_expect_error($q$select public.verify_hold('hold-sin-politica-1')$q$, '55000');
select public.verify_su();
select count(*) as nada_retenido_deberia_ser_0 from hoteles.availability where booked_rooms > 0;
rollback;

\echo '=== 8. politica: owner y gm la crean; frontdesk/reservations/housekeeping (42501), otro tenant (42501), anon (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, holds_enabled) values ('00000000-0000-0000-0000-0000000a1a01', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, holds_enabled) values ('00000000-0000-0000-0000-0000000a1a01', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, holds_enabled) values ('00000000-0000-0000-0000-0000000a1a01', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, holds_enabled) values ('00000000-0000-0000-0000-0000000a1a01', true)$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, holds_enabled) values ('00000000-0000-0000-0000-0000000a1a01', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
insert into hoteles.booking_agent_policy (property_id, holds_enabled) values ('00000000-0000-0000-0000-0000000a1a01', true);
select public.verify_su();
select count(*) as politica_deberia_ser_1 from hoteles.booking_agent_policy where organization_id = '00000000-0000-0000-0000-00000000a001' and updated_by = '00000000-0000-0000-0000-0000000a0a02';
rollback;

\echo '=== 9. politica: GRANT por columna (no se reescribe organization_id) y CHECK de rangos (TTL, noches, huespedes) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.booking_agent_policy (property_id, holds_enabled) values ('00000000-0000-0000-0000-0000000a1a01', true);
select public.verify_expect_error($q$update hoteles.booking_agent_policy set organization_id = '00000000-0000-0000-0000-00000000b001'$q$, '42501');
select public.verify_expect_error($q$update hoteles.booking_agent_policy set hold_ttl_minutes = 1$q$, '23514');
select public.verify_expect_error($q$update hoteles.booking_agent_policy set max_nights = 0$q$, '23514');
select public.verify_expect_error($q$update hoteles.booking_agent_policy set max_guests = 99$q$, '23514');
select public.verify_expect_error($q$update hoteles.booking_agent_policy set mode = 'cobro_directo'$q$, '23514');
select public.verify_expect_error($q$delete from hoteles.booking_agent_policy$q$, '42501');
select count(*) as politica_intacta_deberia_ser_1 from hoteles.booking_agent_policy where hold_ttl_minutes = 120 and mode = 'aprobacion_humana';
rollback;

\echo '=== 10. RLS de lectura de la politica: staff autorizado la ve; housekeeping, otro tenant y anon no ==='
begin;
select public.verify_enable();
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select count(*) from hoteles.booking_agent_policy) = 1, 'frontdesk ve la politica');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert((select count(*) from hoteles.booking_agent_policy) = 0, 'housekeeping no ve');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert((select count(*) from hoteles.booking_agent_policy) = 0, 'otro tenant no ve');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.booking_agent_policy$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select count(*) as dueno_ve_deberia_ser_1 from hoteles.booking_agent_policy;
rollback;

-- =============================================================================
-- (c) Hold: retencion sin sobreventa, idempotencia, expiracion
-- =============================================================================

\echo '=== 11. hold: retiene cada noche, queda pendiente de aprobacion, expira segun el TTL y deja bitacora ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-basico-0001');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1, 'noche 12 retenida');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-13') = 1, 'noche 13 retenida');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-11') = 0, 'noche 11 intacta');
select public.verify_assert((select count(*) from hoteles.booking_hold_event where event_type = 'creado' and actor_id is null) = 1, 'bitacora creado sin actor');
select count(*) as hold_deberia_ser_1 from hoteles.booking_hold
 where status = 'pendiente_aprobacion' and mode = 'aprobacion_humana' and total_cents = 357000 and net_cents = 300000 and nights = 2
   and expires_at = '2031-06-01T14:00:00Z' and currency = 'MXN' and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 12. idempotencia: la MISMA llave devuelve el MISMO hold y no retiene dos veces; otra combinacion con la llave (22023) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-idem-000001');
select public.verify_assert(public.verify_hold('hold-idem-000001') = (select id from public.verify_hid()), 'mismo id');
select public.verify_expect_error($q$select public.verify_hold('hold-idem-000001', p_out => '2031-06-13', p_total => 178500)$q$, '22023');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1, 'una sola retencion');
select count(*) as un_solo_hold_deberia_ser_1 from hoteles.booking_hold;
rollback;

\echo '=== 12b. dedupe natural: el mismo telefono, tipo y fechas con OTRA llave devuelve el hold abierto (no retiene una segunda habitacion) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-dedupe-00001');
select public.verify_assert(public.verify_hold('hold-dedupe-00002') = (select id from public.verify_hid()), 'mismo hold');
select public.verify_su();
select count(*) as una_sola_retencion_deberia_ser_1 from hoteles.booking_hold h where public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1;
rollback;

\echo '=== 13. el precio lo calcula la base: un total esperado distinto (descuento pedido, precio viejo o inventado) se rechaza (22023) ==='
begin;
select public.verify_enable();
select public.verify_expect_error($q$select public.verify_hold('hold-precio-00001', p_total => 300000)$q$, '22023');
select public.verify_expect_error($q$select public.verify_hold('hold-precio-00002', p_total => 1)$q$, '22023');
select public.verify_expect_error($q$select public.verify_hold('hold-precio-00003', p_total => null)$q$, '22023');
select public.verify_su();
select count(*) as nada_retenido_deberia_ser_0 from hoteles.availability where booked_rooms > 0;
rollback;

\echo '=== 14. SIN SOBREVENTA: la ultima habitacion la gana un solo hold; el siguiente falla (P0001) y booked nunca excede total ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-ultimo-0001', '5215550000001');
select public.verify_hold('hold-ultimo-0002', '5215550000002');
select public.verify_expect_error($q$select public.verify_hold('hold-ultimo-0003', '5215550000003')$q$, 'P0001');
select public.verify_su();
select count(*) as sobrevendidas_deberia_ser_0 from hoteles.availability where booked_rooms > total_rooms or booked_rooms < 0;
rollback;

\echo '=== 15. un hold fallido es todo-o-nada: si una noche no tiene cupo no queda NINGUNA retenida ==='
begin;
select public.verify_su();
update hoteles.availability set booked_rooms = 2 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-13';
select public.verify_enable();
select public.verify_expect_error($q$select public.verify_hold('hold-atomico-001')$q$, 'P0001');
select public.verify_su();
select count(*) as noche_12_intacta_deberia_ser_1 from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-12' and booked_rooms = 0
  and (select count(*) from hoteles.booking_hold) = 0;
rollback;

\echo '=== 16. topes: 3er hold abierto del mismo telefono (55000), huespedes sobre la ocupacion del tipo o 0 (22023), telefono/llave/nombre invalidos (22023) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-tope-000001', '5215550000009', p_rt => '00000000-0000-0000-0000-0000000d0001');
select public.verify_su();
update hoteles.availability set total_rooms = 10 where room_type_id = '00000000-0000-0000-0000-0000000d0001';
select public.verify_as('');
select public.verify_hold('hold-tope-000002', '5215550000009', p_in => '2031-06-11', p_out => '2031-06-12', p_total => 178500);
select public.verify_expect_error($q$select public.verify_hold('hold-tope-000003', '5215550000009', p_in => '2031-06-13', p_out => '2031-06-14', p_total => 178500)$q$, '55000');
select public.verify_expect_error($q$select public.verify_hold('hold-tope-000004', '5215550000008', p_guests => 3)$q$, '22023');
select public.verify_expect_error($q$select public.verify_hold('hold-tope-000005', '5215550000008', p_guests => 0)$q$, '22023');
select public.verify_expect_error($q$select public.verify_hold('hold-tope-000006', '12')$q$, '22023');
select public.verify_expect_error($q$select public.verify_hold('corta')$q$, '22023');
select public.verify_expect_error($q$select hoteles.booking_hold_create('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-14', 2, repeat('x', 121), '5215550000008', 'whatsapp', 'hold-tope-000007', 357000, '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_expect_error($q$select hoteles.booking_hold_create('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-14', 2, 'Ana', '5215550000008', 'sms', 'hold-tope-000008', 357000, '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_su();
select count(*) as holds_deberia_ser_2 from hoteles.booking_hold;
rollback;

\echo '=== 17. tope de holds abiertos por hotel (max_active_holds) contra acaparar inventario (55000) ==='
begin;
select public.verify_enable();
select public.verify_su();
update hoteles.booking_agent_policy set max_active_holds = 1;
update hoteles.availability set total_rooms = 10 where room_type_id = '00000000-0000-0000-0000-0000000d0001';
select public.verify_as('');
select public.verify_hold('hold-acapara-0001', '5215550000001');
select public.verify_expect_error($q$select public.verify_hold('hold-acapara-0002', '5215550000002')$q$, '55000');
select public.verify_su();
select count(*) as un_hold_deberia_ser_1 from hoteles.booking_hold;
rollback;

\echo '=== 18. cross-tenant: tipo de habitacion de otra property (P0002); property de otro vertical; politica de otro hotel no habilita ==='
begin;
select public.verify_enable();
select public.verify_expect_error($q$select public.verify_hold('hold-cruce-000001', p_rt => '00000000-0000-0000-0000-0000000d0004')$q$, 'P0002');
select public.verify_expect_error($q$select public.verify_hold('hold-cruce-000002', p_prop => '00000000-0000-0000-0000-0000000b1b01', p_rt => '00000000-0000-0000-0000-0000000d0001')$q$, '55000');
select public.verify_expect_error($q$select public.verify_hold('hold-cruce-000003', p_prop => '00000000-0000-0000-0000-0000000a1a02', p_rt => '00000000-0000-0000-0000-0000000d0003')$q$, '55000');
select public.verify_su();
select count(*) as nada_retenido_deberia_ser_0 from hoteles.availability where booked_rooms > 0;
rollback;

\echo '=== 19. expiracion SIN cron: al consultar despues del TTL el hold vence y libera el inventario; el barrido de sistema tambien ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-expira-0001', '5215550000001');
select public.verify_hold('hold-expira-0002', '5215550000002');
select * from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T14:00:01Z');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 0, 'liberada');
select public.verify_assert((select count(*) from hoteles.booking_hold where status = 'expirado') = 2, 'expirados');
select public.verify_assert((select count(*) from hoteles.booking_hold_event where event_type = 'expirado') = 2, 'bitacora');
select public.verify_as('');
select public.verify_assert(hoteles.booking_hold_expire_due(null, '2031-06-02T00:00:00Z') = 0, 'idempotente');
select count(*) as libre_otra_vez_deberia_ser_1 from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T14:00:02Z') where room_type_name = 'Doble' and free_rooms = 2;
rollback;

\echo '=== 20. barrido de sistema: solo sistema (staff 42501, anon 42501); libera holds vencidos de todas las properties ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-barrido-0001');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.booking_hold_expire_due(null, '2031-06-02T00:00:00Z')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select hoteles.booking_hold_expire_due(null, '2031-06-02T00:00:00Z')$q$, '42501');
select public.verify_as('');
select hoteles.booking_hold_expire_due(null, '2031-06-02T00:00:00Z') as barridos_deberia_ser_1;
rollback;

\echo '=== 21. solo el sistema crea holds: staff (42501) y anon (42501) no pueden, ni siquiera con politica habilitada ==='
begin;
select public.verify_enable();
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select public.verify_hold('hold-staff-000001')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select public.verify_hold('hold-anon-0000001')$q$, '42501');
select public.verify_su();
select count(*) as nada_deberia_ser_0 from hoteles.booking_hold;
rollback;

-- =============================================================================
-- (d) Aprobacion humana, link de pago registrado y confirmacion
-- =============================================================================

\echo '=== 22. aprobar: reservations/gm/owner si; frontdesk, housekeeping, otro tenant y sistema no; motivo obligatorio ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-aprueba-0001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', 'ok')$q$, :'hid'), 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', 'ok')$q$, :'hid'), 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', 'ok')$q$, :'hid'), 'P0002');
select public.verify_as('');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', 'ok')$q$, :'hid'), '42501');
select public.verify_anon();
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', 'ok')$q$, :'hid'), '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', '  ')$q$, :'hid'), '22023');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'quizas', 'ok')$q$, :'hid'), '22023');
select hoteles.booking_hold_decide(:'hid', 'aprobar', 'Huesped conocido') ;
select count(*) as aprobado_deberia_ser_1 from hoteles.booking_hold where status = 'aprobado' and decided_by = '00000000-0000-0000-0000-0000000a0a04' and decision_reason = 'Huesped conocido';
rollback;

\echo '=== 23. rechazar libera el inventario; un hold ya decidido no se decide otra vez (55000) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-rechaza-0001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select hoteles.booking_hold_decide(:'hid', 'rechazar', 'Sin cupo real por mantenimiento');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', 'tarde')$q$, :'hid'), '55000');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 0, 'liberado');
select count(*) as rechazado_deberia_ser_1 from hoteles.booking_hold where status = 'rechazado';
rollback;

\echo '=== 24. modo link_pago: queda pendiente de pago; SOLO se registra la referencia; una con forma de tarjeta se rechaza (22023) ==='
begin;
select public.verify_enable('link_pago');
select public.verify_hold('hold-link-000001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_assert((select status from hoteles.booking_hold) = 'pendiente_pago', 'pendiente de pago');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error(format($q$select hoteles.booking_hold_decide(%L, 'aprobar', 'no aplica')$q$, :'hid'), '55000');
select public.verify_expect_error(format($q$select hoteles.booking_hold_register_payment_link(%L, '4111 1111 1111 1111')$q$, :'hid'), '22023');
select public.verify_expect_error(format($q$select hoteles.booking_hold_register_payment_link(%L, '4111-1111-1111-1111')$q$, :'hid'), '22023');
select public.verify_expect_error(format($q$select hoteles.booking_hold_register_payment_link(%L, '')$q$, :'hid'), '22023');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error(format($q$select hoteles.booking_hold_register_payment_link(%L, 'LNK-ABC-123')$q$, :'hid'), 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select hoteles.booking_hold_register_payment_link(:'hid', 'LNK-ABC-123');
select count(*) as link_registrado_deberia_ser_1 from hoteles.booking_hold where payment_link_ref = 'LNK-ABC-123' and status = 'pendiente_pago';
rollback;

\echo '=== 25. confirmar: crea UNA reserva confirmada (total = neto) sin doble conteo de inventario; no se confirma dos veces (55000) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-confirma-001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error(format($q$select hoteles.booking_hold_confirm(%L)$q$, :'hid'), '55000');
select hoteles.booking_hold_decide(:'hid', 'aprobar', 'Aprobado por reservas');
select hoteles.booking_hold_confirm(:'hid');
select public.verify_expect_error(format($q$select hoteles.booking_hold_confirm(%L)$q$, :'hid'), '55000');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1, 'una sola cuenta de inventario');
select count(*) as reserva_deberia_ser_1 from hoteles.reservation r join hoteles.booking_hold h on h.reservation_id = r.id
 where r.status = 'confirmada' and r.total_amount = 3000.00 and r.idempotency_key = 'hold-' || h.id::text and h.status = 'confirmado';
rollback;

\echo '=== 26. un hold vencido no se aprueba: la decision lo deja expirado y libera su inventario ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-vencido-0001');
select public.verify_su();
update hoteles.booking_hold set expires_at = now() - interval '1 minute';
select id as hid from public.verify_hid() \gset
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_assert((select status from hoteles.booking_hold_decide(:'hid', 'aprobar', 'tarde')) = 'expirado', 'queda expirado');
select public.verify_su();
select count(*) as expirado_liberado_deberia_ser_1 from hoteles.booking_hold h where h.status = 'expirado' and public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 0;
rollback;

\echo '=== 27. cancelar por staff (con motivo) libera; frontdesk no (P0002); ya confirmado no se cancela por esta via (55000) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-cancela-0001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error(format($q$select hoteles.booking_hold_staff_cancel(%L, 'x')$q$, :'hid'), 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error(format($q$select hoteles.booking_hold_staff_cancel(%L, '')$q$, :'hid'), '22023');
select hoteles.booking_hold_staff_cancel(:'hid', 'El huesped aviso por telefono');
select public.verify_expect_error(format($q$select hoteles.booking_hold_staff_cancel(%L, 'otra vez')$q$, :'hid'), '55000');
select public.verify_su();
select count(*) as cancelado_deberia_ser_1 from hoteles.booking_hold h where h.status = 'cancelado' and public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 0;
rollback;

-- =============================================================================
-- (e) Estado y cancelacion por el propio huesped
-- =============================================================================

\echo '=== 28. el huesped consulta y cancela SOLO con hold id + su telefono; telefono ajeno o id de otra property (P0002) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-huesped-001', '5215550000001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_as('');
select public.verify_expect_error(format($q$select hoteles.booking_hold_status_for_contact('00000000-0000-0000-0000-0000000a1a01', %L, '5215559999999', '2031-06-01T12:00:00Z')$q$, :'hid'), 'P0002');
select public.verify_expect_error(format($q$select hoteles.booking_hold_cancel_for_contact('00000000-0000-0000-0000-0000000a1a01', %L, '5215559999999', '2031-06-01T12:00:00Z')$q$, :'hid'), 'P0002');
select public.verify_expect_error(format($q$select hoteles.booking_hold_status_for_contact('00000000-0000-0000-0000-0000000a1a02', %L, '5215550000001', '2031-06-01T12:00:00Z')$q$, :'hid'), 'P0002');
select public.verify_assert((select status from hoteles.booking_hold_status_for_contact('00000000-0000-0000-0000-0000000a1a01', :'hid', '5215550000001', '2031-06-01T12:00:00Z')) = 'pendiente_aprobacion', 'estado propio');
select hoteles.booking_hold_cancel_for_contact('00000000-0000-0000-0000-0000000a1a01', :'hid', '5215550000001', '2031-06-01T12:00:00Z');
select public.verify_assert((select status from hoteles.booking_hold_cancel_for_contact('00000000-0000-0000-0000-0000000a1a01', :'hid', '5215550000001', '2031-06-01T12:00:00Z')) = 'cancelado', 'idempotente');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 0, 'liberado');
select count(*) as cancelado_por_huesped_deberia_ser_1 from hoteles.booking_hold_event where event_type = 'cancelado_por_huesped';
rollback;

\echo '=== 29. un hold ya confirmado no lo cancela el agente (55000: se deriva a una persona); staff y anon no usan las funciones del agente (42501) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-huesped-002', '5215550000001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select hoteles.booking_hold_decide(:'hid', 'aprobar', 'ok');
select hoteles.booking_hold_confirm(:'hid');
select public.verify_expect_error(format($q$select hoteles.booking_hold_cancel_for_contact('00000000-0000-0000-0000-0000000a1a01', %L, '5215550000001', '2031-06-01T12:00:00Z')$q$, :'hid'), '42501');
select public.verify_as('');
select public.verify_expect_error(format($q$select hoteles.booking_hold_cancel_for_contact('00000000-0000-0000-0000-0000000a1a01', %L, '5215550000001', '2031-06-01T12:00:00Z')$q$, :'hid'), '55000');
select public.verify_anon();
select public.verify_expect_error(format($q$select hoteles.booking_hold_status_for_contact('00000000-0000-0000-0000-0000000a1a01', %L, '5215550000001', '2031-06-01T12:00:00Z')$q$, :'hid'), '42501');
select public.verify_su();
select count(*) as sigue_confirmado_deberia_ser_1 from hoteles.booking_hold where status = 'confirmado';
rollback;

-- =============================================================================
-- (f) Integridad: sin escritura directa, inmutables, RLS de lectura, grants
-- =============================================================================

\echo '=== 30. sin escritura directa de authenticated/anon sobre holds y bitacora (42501), ni delete ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-directo-0001');
select public.verify_su();
select id as hid from public.verify_hid() \gset
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error(format($q$update hoteles.booking_hold set status = 'confirmado' where id = %L$q$, :'hid'), '42501');
select public.verify_expect_error(format($q$update hoteles.booking_hold set total_cents = 1, net_cents = 1, iva_cents = 0, ish_cents = 0 where id = %L$q$, :'hid'), '42501');
select public.verify_expect_error($q$delete from hoteles.booking_hold$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.booking_hold_event (organization_id, property_id, hold_id, event_type) select organization_id, property_id, id, 'falso' from hoteles.booking_hold$q$, '42501');
select public.verify_expect_error($q$select hoteles.booking_hold_log('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', gen_random_uuid(), 'falso', '{}'::jsonb)$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.booking_hold$q$, '42501');
select public.verify_su();
select count(*) as intacto_deberia_ser_1 from hoteles.booking_hold where status = 'pendiente_aprobacion' and total_cents = 357000;
rollback;

\echo '=== 31. segunda capa (triggers): ni el superusuario cambia lo cotizado/retenido (42501), ni el estado final cambia (55000); la bitacora es inmutable (42501) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-trigger-0001');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.booking_hold set total_cents = 100, net_cents = 100, iva_cents = 0, ish_cents = 0$q$, '42501');
select public.verify_expect_error($q$update hoteles.booking_hold set check_out_date = '2031-06-20'$q$, '42501');
select public.verify_expect_error($q$update hoteles.booking_hold set contact_phone = '5215550000777'$q$, '42501');
select public.verify_expect_error($q$update hoteles.booking_hold_event set event_type = 'x'$q$, '42501');
update hoteles.booking_hold set status = 'cancelado';
select public.verify_expect_error($q$update hoteles.booking_hold set status = 'aprobado'$q$, '55000');
select count(*) as sin_cambios_deberia_ser_1 from hoteles.booking_hold where total_cents = 357000;
rollback;

\echo '=== 32. CHECK de la tabla: total = neto + IVA + ISH, estado confirmado exige reserva, moneda MXN, montos positivos (23514) ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-check-000001');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.booking_hold set status = 'confirmado'$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.booking_hold (organization_id, property_id, room_type_id, check_in_date, check_out_date, nights, guests, channel, contact_phone, idempotency_key, net_cents, iva_cents, ish_cents, total_cents, nightly, mode, status, expires_at)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-14', 2, 2, 'voz', '5215550000001', 'hold-check-000002', 100, 16, 3, 1, '[]'::jsonb, 'link_pago', 'pendiente_pago', now())$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.booking_hold (organization_id, property_id, room_type_id, check_in_date, check_out_date, nights, guests, channel, contact_phone, idempotency_key, currency, net_cents, iva_cents, ish_cents, total_cents, nightly, mode, status, expires_at)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-14', 2, 2, 'voz', '5215550000001', 'hold-check-000003', 'USD', 100, 16, 3, 119, '[]'::jsonb, 'link_pago', 'pendiente_pago', now())$q$, '23514');
select public.verify_expect_error($q$insert into hoteles.booking_hold (organization_id, property_id, room_type_id, check_in_date, check_out_date, nights, guests, channel, contact_phone, idempotency_key, net_cents, iva_cents, ish_cents, total_cents, nightly, mode, status, expires_at)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-14', 2, 2, 'voz', '5215550000001', 'hold-check-000004', -5, 0, 0, -5, '[]'::jsonb, 'link_pago', 'pendiente_pago', now())$q$, '23514');
select count(*) as un_hold_deberia_ser_1 from hoteles.booking_hold;
rollback;

\echo '=== 33. RLS de lectura de holds y bitacora: owner/gm/frontdesk/reservations ven los de su hotel; housekeeping, otro tenant (0 filas) y anon (42501) no ==='
begin;
select public.verify_enable();
select public.verify_hold('hold-lectura-0001');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select count(*) from hoteles.booking_hold) = 1, 'frontdesk ve');
select public.verify_assert((select count(*) from hoteles.booking_hold_event) = 1, 'frontdesk ve bitacora');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert((select count(*) from hoteles.booking_hold) = 0, 'housekeeping no ve');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_assert((select count(*) from hoteles.booking_hold) = 0, 'otro tenant no ve holds');
select public.verify_assert((select count(*) from hoteles.booking_hold_event) = 0, 'otro tenant no ve bitacora');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.booking_hold_event$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select count(*) as reservations_ve_deberia_ser_1 from hoteles.booking_hold;
rollback;

\echo '=== 34. las funciones internas no son ejecutables por authenticated ni anon (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select * from hoteles.agent_quote_core('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-14')$q$, '42501');
select public.verify_expect_error($q$select hoteles.agent_validate_stay('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', now())$q$, '42501');
select public.verify_expect_error($q$select hoteles.booking_hold_expire_core('00000000-0000-0000-0000-0000000a1a01', now())$q$, '42501');
select public.verify_expect_error($q$select hoteles.booking_policy_of('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_expect_error($q$select hoteles.booking_hold_lock(gen_random_uuid())$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select hoteles.booking_hold_confirm(gen_random_uuid())$q$, '42501');
select public.verify_expect_error($q$select hoteles.booking_hold_staff_cancel(gen_random_uuid(), 'x')$q$, '42501');
select public.verify_su();
select count(*) as sin_efectos_deberia_ser_0 from hoteles.booking_hold_event;
rollback;

\echo '=== 35. todas las funciones nuevas son security definer con search_path fijo y NINGUNA es ejecutable por public/anon ==='
begin;
select public.verify_su();
select public.verify_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'hoteles' and (p.proname like 'booking_hold%' or p.proname like 'booking_policy%' or p.proname in ('agent_stay_options', 'agent_booking_policy', 'agent_quote_core', 'agent_validate_stay', 'booking_agent_policy_before_write')) and p.prosecdef and p.proconfig is null) = 0, 'definer sin search_path');
select public.verify_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'hoteles' and (p.proname like 'booking_hold%' or p.proname like 'booking_policy%' or p.proname in ('agent_stay_options', 'agent_booking_policy', 'agent_quote_core', 'agent_validate_stay', 'booking_agent_policy_before_write'))
     and (has_function_privilege('anon', p.oid, 'execute') or p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0))) = 0, 'anon/public sin execute');
select count(*) as funciones_deberia_ser_20 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'hoteles' and (p.proname like 'booking_hold%' or p.proname like 'booking_policy%' or p.proname in ('agent_stay_options', 'agent_booking_policy', 'agent_quote_core', 'agent_validate_stay', 'booking_agent_policy_before_write'));
rollback;

\echo '=== 36. redondeo half-up exacto en centavos: tarifa 1333.335 => 133334 centavos por noche; IVA/ISH redondeados a centavo entero ==='
begin;
select public.verify_su();
update hoteles.rate_plan set price = 1333.335 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-12';
select public.verify_as('');
select count(*) as redondeo_deberia_ser_1 from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-13', '2031-06-01T12:00:00Z')
 where room_type_name = 'Doble' and status = 'ok' and net_cents = 133334 and iva_cents = 21333 and ish_cents = 4000 and total_cents = 158667;
rollback;

\echo '=== 37. reglas de tarifa: CTA, CTD y estancia minima se respetan (no se cotiza ni se retiene) ==='
begin;
select public.verify_su();
update hoteles.rate_plan set closed_to_arrival = true where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-12';
select public.verify_as('');
select public.verify_assert((select status from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z') where room_type_name = 'Doble') = 'cerrado_a_llegada', 'CTA');
select public.verify_su();
update hoteles.rate_plan set closed_to_arrival = false where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-12';
update hoteles.rate_plan set closed_to_departure = true where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-13';
select public.verify_as('');
select public.verify_assert((select status from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-13', '2031-06-01T12:00:00Z') where room_type_name = 'Doble') = 'cerrado_a_salida', 'CTD');
select public.verify_su();
update hoteles.rate_plan set closed_to_departure = false, min_stay = 3 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-12';
select public.verify_as('');
select public.verify_assert((select status from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z') where room_type_name = 'Doble') = 'estadia_minima_no_alcanzada', 'min stay');
select public.verify_enable();
select public.verify_expect_error($q$select public.verify_hold('hold-reglas-00001')$q$, '22023');
select public.verify_su();
select count(*) as nada_retenido_deberia_ser_0 from hoteles.availability where booked_rooms > 0;
rollback;

\echo '=== 38. tarifa en otra moneda no se cotiza (moneda_no_soportada) ==='
begin;
select public.verify_su();
update hoteles.rate_plan set currency = 'USD' where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-12';
select public.verify_as('');
select count(*) as moneda_deberia_ser_1 from hoteles.agent_stay_options('00000000-0000-0000-0000-0000000a1a01', '2031-06-12', '2031-06-14', '2031-06-01T12:00:00Z') where room_type_name = 'Doble' and status = 'moneda_no_soportada';
rollback;

\echo '=== 39. guardia de precio tambien en el hold: una tarifa fuera de piso/techo NO se retiene (22023) aunque el agente pida un total ==='
begin;
select public.verify_enable();
select public.verify_expect_error($q$select public.verify_hold('hold-guardia-0001', p_rt => '00000000-0000-0000-0000-0000000d0002', p_total => 1)$q$, '22023');
select public.verify_su();
update hoteles.pricing_rule set ceiling_price = 9000 where room_type_id = '00000000-0000-0000-0000-0000000d0002';
select public.verify_as('');
select public.verify_hold('hold-guardia-0002', p_rt => '00000000-0000-0000-0000-0000000d0002', p_total => 1190000, p_guests => 4);
select public.verify_su();
select count(*) as suite_dentro_de_guardia_deberia_ser_1 from hoteles.booking_hold where total_cents = 1190000;
rollback;

\echo '=== 40. politica para el agente (sistema): sin fila = holds deshabilitados con topes por defecto; habilitada la refleja; staff/anon (42501), property inexistente (P0002) ==='
begin;
select public.verify_as('');
select public.verify_assert((select holds_enabled from hoteles.agent_booking_policy('00000000-0000-0000-0000-0000000a1a01')) = false, 'por defecto deshabilitada');
select public.verify_assert((select max_nights from hoteles.agent_booking_policy('00000000-0000-0000-0000-0000000a1a01')) = 14, 'tope por defecto');
select public.verify_expect_error($q$select * from hoteles.agent_booking_policy(gen_random_uuid())$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select * from hoteles.agent_booking_policy('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.agent_booking_policy('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_enable('link_pago');
select count(*) as politica_habilitada_deberia_ser_1 from hoteles.agent_booking_policy('00000000-0000-0000-0000-0000000a1a01') where holds_enabled and mode = 'link_pago';
rollback;

\echo 'Escenarios en los que verify_expect_error confirma el SQLSTATE exacto; los de valor terminan en deberia_ser_N.'
