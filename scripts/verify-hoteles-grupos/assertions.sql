-- H-06 (P1) -- GRUPOS: cotizacion con vigencia, bloqueo de cuartos (allotment), pickup, rooming list, anticipos
-- registrados y liberacion por cutoff. Verifica contra Postgres REAL (nunca el mirror en memoria, que jamas aplica
-- RLS/GRANT/triggers/CHECK) que packages/domain-hoteles/migrations/036_hoteles_grupos.sql cierra lo que dice cerrar.
-- Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto). Mismo patron que
-- verify-hoteles-agentes-aprobaciones: fixtures persistentes (superusuario) + cada escenario en su propio
-- begin/rollback.
--
-- Convencion: public.verify_expect_error(sql, sqlstate) EXIGE el SQLSTATE exacto (42501 = RLS/GRANT/guard,
-- 23514 = CHECK/trigger, 22023 = parametro invalido, 55000 = estado invalido, P0002 = no encontrada/otro tenant,
-- P0001 = sin disponibilidad/cupo, 23505 = unico). public.verify_assert(cond, msg) falla el escenario si cond no es
-- cierto. Los positivos con valor usan alias con sufijo de valor exacto (..._deberia_ser_N) en la ULTIMA sentencia
-- del escenario (una sola por escenario). public.verify_as(sub) fija el rol authenticated con auth.uid() = sub;
-- sub vacio = SESION DE SISTEMA (auth.uid() is null). public.verify_su() vuelve al superusuario.
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

-- Renglon de cotizacion y atajos (corren con el rol activo del escenario).
create or replace function public.verify_l(p_rt uuid, p_rooms integer, p_rate bigint) returns jsonb language sql as $$
  select jsonb_build_object('room_type_id', p_rt, 'rooms', p_rooms, 'rate_cents', p_rate)
$$;

create or replace function public.verify_gq(
  p_lines jsonb, p_prop uuid default '00000000-0000-0000-0000-0000000a1a01',
  p_in date default '2031-06-12', p_out date default '2031-06-15', p_cutoff date default '2031-06-05',
  p_disc integer default 0, p_dep bigint default 0, p_valid timestamptz default now() + interval '7 days'
) returns uuid language sql as $$
  select id from hoteles.group_quote_create(p_prop, 'Boda Garcia', 'Ana Garcia', 'ana@example.com', p_in, p_out, p_cutoff, p_valid, p_disc, p_dep, p_lines)
$$;

-- Crea + envia + acepta (bloquea) y devuelve el id del bloqueo.
create or replace function public.verify_gblock(
  p_lines jsonb, p_prop uuid default '00000000-0000-0000-0000-0000000a1a01',
  p_in date default '2031-06-12', p_out date default '2031-06-15', p_cutoff date default '2031-06-05'
) returns uuid language plpgsql as $$
declare
  v_q uuid;
  v_b uuid;
begin
  v_q := public.verify_gq(p_lines, p_prop, p_in, p_out, p_cutoff);
  perform hoteles.group_quote_send(v_q);
  select id into v_b from hoteles.group_quote_accept(v_q);
  return v_b;
end;
$$;

create or replace function public.verify_entry(p_block uuid, p_rt uuid, p_name text default 'Luis Perez', p_in date default '2031-06-12', p_out date default '2031-06-15')
returns uuid language sql as $$
  select id from hoteles.group_rooming_add(p_block, p_rt, p_name, p_in, p_out)
$$;
grant execute on function public.verify_l(uuid, integer, bigint), public.verify_gq(jsonb, uuid, date, date, date, integer, bigint, timestamptz),
  public.verify_gblock(jsonb, uuid, date, date, date), public.verify_entry(uuid, uuid, text, date, date) to public;

-- Cuartos retenidos (booked_rooms) de un tipo en una noche, sin RLS (security definer).
create or replace function public.verify_booked(p_rt uuid, p_date date) returns integer language sql security definer as $$
  select booked_rooms from hoteles.availability where room_type_id = p_rt and date = p_date
$$;
grant execute on function public.verify_booked(uuid, date) to public;

-- Ids de la primera cotizacion/bloqueo/huesped (security definer: los ve cualquier rol, incluso uno de otro tenant).
create or replace function public.verify_qid() returns table (id uuid) language sql security definer as $$ select gq.id from hoteles.group_quote gq limit 1 $$;
create or replace function public.verify_bid() returns table (id uuid) language sql security definer as $$ select gb.id from hoteles.group_block gb limit 1 $$;
create or replace function public.verify_eid() returns table (id uuid) language sql security definer as $$ select re.id from hoteles.group_rooming_entry re limit 1 $$;
grant execute on function public.verify_qid(), public.verify_bid(), public.verify_eid() to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-gr'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-gr')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 2 (Tijuana)'),
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

insert into hoteles.property_config (property_id, organization_id, timezone) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'America/Tijuana')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Doble'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Suite'),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a02', 'Doble'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Doble')
on conflict do nothing;

-- Inventario: noches 12, 13 y 14 de junio de 2031. Doble A1 = 10 cuartos, Suite A1 = 2, Doble A2 = 10, B1 = 10.
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms)
select o, p, rt, d::date, t
  from (values
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a01'::uuid, '00000000-0000-0000-0000-0000000d0001'::uuid, 10),
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a01'::uuid, '00000000-0000-0000-0000-0000000d0002'::uuid, 2),
    ('00000000-0000-0000-0000-00000000a001'::uuid, '00000000-0000-0000-0000-0000000a1a02'::uuid, '00000000-0000-0000-0000-0000000d0003'::uuid, 10),
    ('00000000-0000-0000-0000-00000000b001'::uuid, '00000000-0000-0000-0000-0000000b1b01'::uuid, '00000000-0000-0000-0000-0000000d0004'::uuid, 10)
  ) as t(o, p, rt, t)
 cross join generate_series('2031-06-12'::date, '2031-06-14'::date, interval '1 day') d
on conflict do nothing;

insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, total_amount) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-15', 0)
on conflict do nothing;

-- =============================================================================
-- (a) Cotizacion: montos en centavos, redondeo, validaciones
-- =============================================================================

\echo '=== 1. owner crea una cotizacion: total en centavos enteros con descuento y org derivada ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)), p_disc => 1000, p_dep => 500000);
select count(*) as cotizacion_deberia_ser_1 from hoteles.group_quote
 where gross_cents = 2250000 and total_cents = 2025000 and discount_bps = 1000 and deposit_required_cents = 500000 and nights = 3
   and status = 'borrador' and currency = 'MXN' and organization_id = '00000000-0000-0000-0000-00000000a001' and created_by = '00000000-0000-0000-0000-0000000a0a01';
rollback;

\echo '=== 2. redondeo half-up exacto: 33333 centavos con 0.01 % de descuento = 33330 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 33333)), p_in => '2031-06-12', p_out => '2031-06-13', p_disc => 1);
select count(*) as redondeo_deberia_ser_1 from hoteles.group_quote where gross_cents = 33333 and total_cents = 33330;
rollback;

\echo '=== 3. dos renglones suman cuartos x noches x tarifa, sin decimales ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 4, 100000), public.verify_l('00000000-0000-0000-0000-0000000d0002', 2, 250001)));
select count(*) as suma_deberia_ser_1 from hoteles.group_quote where gross_cents = (4 * 100000 + 2 * 250001) * 3 and total_cents = gross_cents;
rollback;

\echo '=== 4. tarifa con decimal, negativa, texto o cuartos 0 se rechazan (22023): solo centavos enteros ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select public.verify_gq('[{"room_type_id":"00000000-0000-0000-0000-0000000d0001","rooms":5,"rate_cents":1500.5}]'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq('[{"room_type_id":"00000000-0000-0000-0000-0000000d0001","rooms":5,"rate_cents":-1}]'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq('[{"room_type_id":"00000000-0000-0000-0000-0000000d0001","rooms":5,"rate_cents":"abc"}]'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq('[{"room_type_id":"00000000-0000-0000-0000-0000000d0001","rooms":0,"rate_cents":100}]'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq('[]'::jsonb)$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq('[{"room_type_id":"00000000-0000-0000-0000-0000000d0001","rooms":5,"rate_cents":100000001}]'::jsonb)$q$, '22023');
select count(*) as nada_creado_deberia_ser_0 from hoteles.group_quote;
rollback;

\echo '=== 5. fechas: cutoff posterior a la llegada, cutoff pasado, vigencia pasada, estancia invertida o de mas de 60 noches (22023) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_cutoff => '2031-06-13')$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_cutoff => '2020-01-01')$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_valid => now() - interval '1 minute')$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_in => '2031-06-15', p_out => '2031-06-12')$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_in => '2031-06-12', p_out => '2031-09-12')$q$, '22023');
select count(*) as nada_creado_deberia_ser_0 from hoteles.group_quote;
rollback;

\echo '=== 6. tipo de habitacion de otra property, repetido, anticipo mayor al total, descuento fuera de rango (22023) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0003', 1, 100)))$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100), public.verify_l('00000000-0000-0000-0000-0000000d0001', 2, 100)))$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_dep => 301)$q$, '22023');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_disc => 10001)$q$, '22023');
select count(*) as anticipo_borde_deberia_ser_1 from public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)), p_dep => 300);
rollback;

\echo '=== 7. descuento sobre el tope vigente (30 % por defecto): reservations 42501, owner permitido; en el borde exacto reservations pasa ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100000)), p_disc => 3001)$q$, '42501');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100000)), p_disc => 3000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select count(*) as owner_sobre_tope_deberia_ser_1 from public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100000)), p_disc => 5000);
rollback;

\echo '=== 8. el tope de descuento respeta el guardrail configurado de la property (035) ==='
begin;
insert into hoteles.agent_guardrail (property_id, max_discount_pct) values ('00000000-0000-0000-0000-0000000a1a01', 10);
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100000)), p_disc => 1001)$q$, '42501');
select count(*) as guardrail_borde_deberia_ser_1 from public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100000)), p_disc => 1000);
rollback;

\echo '=== 9. frontdesk, accountant y housekeeping no crean cotizaciones (42501); otro tenant tampoco; anon no ejecuta ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)))$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)))$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)))$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)))$q$, '42501');
select public.verify_as('');
select public.verify_expect_error($q$select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)))$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select hoteles.group_quote_create('00000000-0000-0000-0000-0000000a1a01', 'X Grupo', null, null, '2031-06-12', '2031-06-15', '2031-06-05', now() + interval '1 day', 0, 0, '[]'::jsonb)$q$, '42501');
select public.verify_su();
select count(*) as nada_creado_deberia_ser_0 from hoteles.group_quote;
rollback;

\echo '=== 10. sin INSERT/UPDATE/DELETE directos para authenticated ni anon, ni siquiera el dueno (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$insert into hoteles.group_quote (organization_id, property_id, group_name, check_in_date, check_out_date, cutoff_date, valid_until, gross_cents, total_cents) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Directo', '2031-06-12', '2031-06-15', '2031-06-05', now() + interval '1 day', 1, 1)$q$, '42501');
select public.verify_expect_error($q$update hoteles.group_block_night set picked_up_rooms = 1$q$, '42501');
select public.verify_expect_error($q$delete from hoteles.group_quote$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.group_event (organization_id, property_id, subject_type, subject_id, event_type) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'bloqueo', gen_random_uuid(), 'falsa')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select count(*) from hoteles.group_quote$q$, '42501');
select public.verify_su();
select count(*) as sin_cambios_deberia_ser_0 from hoteles.group_quote;
rollback;

-- =============================================================================
-- (b) Enviar, vigencia y vencimiento
-- =============================================================================

\echo '=== 11. enviar: borrador -> enviada una vez; reenviar es 55000; frontdesk 42501; otro tenant P0002 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)));
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select hoteles.group_quote_send((select id from hoteles.group_quote limit 1))$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select hoteles.group_quote_send((select q.id from public.verify_qid() q))$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_expect_error($q$select hoteles.group_quote_send((select id from hoteles.group_quote limit 1))$q$, '55000');
select count(*) as enviada_deberia_ser_1 from hoteles.group_quote where status = 'enviada' and sent_at is not null;
rollback;

\echo '=== 12. enviar con la vigencia ya vencida es 55000 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)));
select public.verify_su();
update hoteles.group_quote set valid_until = now() - interval '1 hour';
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.group_quote_send((select id from hoteles.group_quote limit 1))$q$, '55000');
select count(*) as sigue_borrador_deberia_ser_1 from hoteles.group_quote where status = 'borrador';
rollback;

\echo '=== 13. rechazar/cancelar: motivo obligatorio, solo estados abiertos, solo enviada se rechaza ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)));
select public.verify_expect_error($q$select hoteles.group_quote_close((select id from hoteles.group_quote limit 1), 'rechazada', 'No era enviada')$q$, '55000');
select public.verify_expect_error($q$select hoteles.group_quote_close((select id from hoteles.group_quote limit 1), 'cancelada', 'abc')$q$, '22023');
select public.verify_expect_error($q$select hoteles.group_quote_close((select id from hoteles.group_quote limit 1), 'aceptada', 'Motivo valido')$q$, '22023');
select hoteles.group_quote_close((select id from hoteles.group_quote limit 1), 'cancelada', 'El cliente desistio');
select public.verify_expect_error($q$select hoteles.group_quote_close((select id from hoteles.group_quote limit 1), 'cancelada', 'Otra vez cancelada')$q$, '55000');
select count(*) as cancelada_deberia_ser_1 from hoteles.group_quote where status = 'cancelada' and closed_reason = 'El cliente desistio' and decided_by = '00000000-0000-0000-0000-0000000a0a01';
rollback;

\echo '=== 14. vencimiento por vigencia: solo sistema; vence borradores y enviadas, no aceptadas; idempotente ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)));
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)));
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0002', 1, 100)));
select public.verify_expect_error($q$select hoteles.group_expire_quotes(now() + interval '30 days')$q$, '42501');
select public.verify_as('');
select public.verify_assert(hoteles.group_expire_quotes(now() + interval '30 days') = 2, 'vencen la enviada y el borrador');
select public.verify_assert(hoteles.group_expire_quotes(now() + interval '30 days') = 0, 'idempotente');
select public.verify_assert(hoteles.group_expire_quotes(now() - interval '30 days') = 0, 'un reloj anterior no vence nada');
select public.verify_su();
select count(*) as vencidas_deberia_ser_2 from hoteles.group_quote where status = 'vencida';
rollback;

-- =============================================================================
-- (c) Aceptar = bloquear cuartos (allotment) sin sobreventa
-- =============================================================================

\echo '=== 15. aceptar retiene los cuartos de CADA noche y crea el bloqueo con la fecha de liberacion ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 5, 'noche 12 retenida');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-14') = 5, 'noche 14 retenida');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-15') is null, 'la noche de salida no se toca (sin fila)');
select public.verify_assert(not exists (select 1 from hoteles.group_quote where status <> 'aceptada'), 'cotizacion aceptada');
select count(*) as bloqueo_deberia_ser_3 from hoteles.group_block_night n join hoteles.group_block b on b.id = n.block_id
 where b.status = 'activo' and b.cutoff_date = '2031-06-05' and n.blocked_rooms = 5 and n.picked_up_rooms = 0 and n.released_rooms = 0;
rollback;

\echo '=== 16. ATOMICO: si una sola noche no alcanza, no se retiene ninguna y no queda bloqueo ==='
begin;
select public.verify_su();
update hoteles.availability set booked_rooms = 8 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-14';
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, 'P0001');
select public.verify_assert(not exists (select 1 from hoteles.group_block), 'sin bloqueo');
select public.verify_assert(exists (select 1 from hoteles.group_quote where status = 'enviada'), 'la cotizacion sigue enviada');
select count(*) as inventario_intacto_deberia_ser_2 from hoteles.availability
 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and booked_rooms = 0 and date in ('2031-06-12', '2031-06-13');
rollback;

\echo '=== 17. SIN SOBREVENTA: con la noche llena y sobreventa habilitada en el tipo, el bloqueo igual falla ==='
begin;
select public.verify_su();
update hoteles.room_type set max_overbook_rooms = 5, overbooking_occupancy_threshold_pct = 50 where id = '00000000-0000-0000-0000-0000000d0001';
update hoteles.availability set booked_rooms = 10 where room_type_id = '00000000-0000-0000-0000-0000000d0001' and date = '2031-06-13';
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 150000)));
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, 'P0001');
select count(*) as nunca_negativo_ni_sobre_deberia_ser_0 from hoteles.availability where booked_rooms > total_rooms or booked_rooms < 0;
rollback;

\echo '=== 18. noche sin fila de inventario: no se puede bloquear (P0001) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 150000)), p_in => '2031-06-12', p_out => '2031-06-16');
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, 'P0001');
select count(*) as sin_bloqueo_deberia_ser_0 from hoteles.group_block;
rollback;

\echo '=== 19. dos agentes compiten por los ultimos cuartos: el primero bloquea, el segundo falla; nunca se pasa de total ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 6, 100)));
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 6, 100)));
select hoteles.group_quote_send(id) from hoteles.group_quote;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select hoteles.group_quote_accept((select id from hoteles.group_quote order by id limit 1));
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote order by id desc limit 1))$q$, 'P0001');
select count(*) as retenido_exacto_deberia_ser_3 from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000d0001' and booked_rooms = 6 and total_rooms = 10;
rollback;

\echo '=== 20. aceptar exige estado enviada, una sola vez; frontdesk 42501; otro tenant P0002 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100)));
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, '55000');
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select hoteles.group_quote_accept((select q.id from public.verify_qid() q))$q$, 'P0002');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1));
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, '55000');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1, 'una sola retencion');
select count(*) as un_bloqueo_deberia_ser_1 from hoteles.group_block;
rollback;

\echo '=== 21. aceptar tras la vigencia o tras la fecha de liberacion es 55000 y no retiene nada ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 2, 100)));
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_su();
set local session_replication_role = replica;
update hoteles.group_quote set valid_until = now() - interval '1 hour';
set local session_replication_role = origin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, '55000');
select public.verify_su();
set local session_replication_role = replica;
update hoteles.group_quote set valid_until = now() + interval '1 day', cutoff_date = '2020-01-01';
set local session_replication_role = origin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1))$q$, '55000');
select count(*) as nada_retenido_deberia_ser_0 from hoteles.availability where booked_rooms > 0;
rollback;

-- =============================================================================
-- (d) Rooming list y pickup
-- =============================================================================

\echo '=== 22. confirmar pickup consume un cuarto del bloqueo en cada noche; el inventario general no cambia ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1));
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-13') = 5, 'el pickup no mueve inventario');
select public.verify_expect_error($q$select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1))$q$, '55000');
select count(*) as pickup_deberia_ser_3 from hoteles.group_block_night where picked_up_rooms = 1 and blocked_rooms = 5;
rollback;

\echo '=== 23. no se confirma mas pickup que cuartos bloqueados (P0001) y nada queda a medias ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0002', 1, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0002', 'Uno Perez');
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0002', 'Dos Perez');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry where guest_name = 'Uno Perez'));
select public.verify_expect_error($q$select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry where guest_name = 'Dos Perez'))$q$, 'P0001');
select count(*) as pickup_tope_deberia_ser_3 from hoteles.group_block_night where picked_up_rooms = 1 and blocked_rooms = 1;
rollback;

\echo '=== 24. pickup parcial por noche: un huesped de 2 noches consume solo esas dos ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Corto Perez', '2031-06-13', '2031-06-15');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1));
select count(*) as dos_noches_deberia_ser_2 from hoteles.group_block_night where picked_up_rooms = 1 and date in ('2031-06-13', '2031-06-14');
rollback;

\echo '=== 25. rooming: fechas fuera del bloqueo, tipo ajeno o nombre vacio son 22023 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_expect_error($q$select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Fuera Perez', '2031-06-11', '2031-06-13')$q$, '22023');
select public.verify_expect_error($q$select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Fuera Perez', '2031-06-12', '2031-06-16')$q$, '22023');
select public.verify_expect_error($q$select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0002', 'Tipo Ajeno')$q$, '22023');
select public.verify_expect_error($q$select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'x')$q$, '22023');
select count(*) as nada_agregado_deberia_ser_0 from hoteles.group_rooming_entry;
rollback;

\echo '=== 26. roles de rooming: frontdesk puede, housekeeping y accountant no (42501), otro tenant P0002 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1));
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_expect_error($q$select public.verify_entry((select b.id from public.verify_bid() b), '00000000-0000-0000-0000-0000000d0001', 'Sin Permiso')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_expect_error($q$select hoteles.group_rooming_cancel((select id from hoteles.group_rooming_entry limit 1))$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select hoteles.group_rooming_cancel((select e.id from public.verify_eid() e))$q$, 'P0002');
select public.verify_su();
select count(*) as confirmada_deberia_ser_1 from hoteles.group_rooming_entry where status = 'confirmada';
rollback;

\echo '=== 27. vinculo opcional con una reserva real: debe coincidir property, tipo y fechas (22023) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Con Reserva', '2031-06-13', '2031-06-15');
select public.verify_expect_error($q$select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1), '00000000-0000-0000-0000-0000000e0001')$q$, '22023');
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Con Reserva Ok');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry where guest_name = 'Con Reserva Ok'), '00000000-0000-0000-0000-0000000e0001');
select count(*) as reserva_vinculada_deberia_ser_1 from hoteles.group_rooming_entry where reservation_id = '00000000-0000-0000-0000-0000000e0001' and status = 'confirmada';
rollback;

\echo '=== 28. cancelar un huesped confirmado devuelve el cuarto al bloqueo (pickup baja) sin tocar el inventario ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1));
select hoteles.group_rooming_cancel((select id from hoteles.group_rooming_entry limit 1));
select public.verify_expect_error($q$select hoteles.group_rooming_cancel((select id from hoteles.group_rooming_entry limit 1))$q$, '55000');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 5, 'inventario igual');
select count(*) as pickup_devuelto_deberia_ser_3 from hoteles.group_block_night where picked_up_rooms = 0 and released_rooms = 0 and blocked_rooms = 5;
rollback;

\echo '=== 29. desde la fecha de liberacion ya no se confirma pickup (55000) aunque el barrido aun no corra ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select public.verify_su();
update hoteles.group_block set cutoff_date = '2020-01-01';
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1))$q$, '55000');
select count(*) as sin_pickup_deberia_ser_0 from hoteles.group_block_night where picked_up_rooms > 0;
rollback;

-- =============================================================================
-- (e) Liberacion: manual, cancelacion y barrido por cutoff (zona horaria de la property)
-- =============================================================================

\echo '=== 30. liberacion manual devuelve SOLO lo no confirmado; el pickup sigue retenido ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Uno Perez');
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Dos Perez');
select hoteles.group_rooming_confirm(id) from hoteles.group_rooming_entry;
select public.verify_assert(hoteles.group_release_block((select id from hoteles.group_block limit 1)) = 9, 'se liberan 3 cuartos x 3 noches');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 2, 'quedan los 2 confirmados');
select public.verify_expect_error($q$select hoteles.group_release_block((select id from hoteles.group_block limit 1))$q$, '55000');
select public.verify_expect_error($q$select hoteles.group_rooming_confirm(gen_random_uuid())$q$, 'P0002');
select count(*) as liberado_deberia_ser_1 from hoteles.group_block where status = 'liberado' and release_kind = 'manual' and released_at is not null;
rollback;

\echo '=== 31. tras liberar no se aceptan mas huespedes ni pickup (55000) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select hoteles.group_release_block((select id from hoteles.group_block limit 1));
select public.verify_expect_error($q$select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Tarde Perez')$q$, '55000');
select public.verify_expect_error($q$select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1))$q$, '55000');
select count(*) as sin_retencion_deberia_ser_3 from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000d0001' and booked_rooms = 0;
rollback;

\echo '=== 32. cancelar un huesped confirmado DESPUES de liberar devuelve ese cuarto al inventario general ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1));
select hoteles.group_release_block((select id from hoteles.group_block limit 1));
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1, 'queda el confirmado');
select hoteles.group_rooming_cancel((select id from hoteles.group_rooming_entry limit 1));
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 0, 'se libero el ultimo');
select count(*) as balance_deberia_ser_3 from hoteles.group_block_night where picked_up_rooms = 0 and released_rooms = 5 and blocked_rooms = 5;
rollback;

\echo '=== 33. cancelar bloqueo: motivo obligatorio, con pickup confirmado es 55000, sin pickup libera todo y cancela pendientes ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select public.verify_expect_error($q$select hoteles.group_cancel_block((select id from hoteles.group_block limit 1), 'abc')$q$, '22023');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1));
select public.verify_expect_error($q$select hoteles.group_cancel_block((select id from hoteles.group_block limit 1), 'Se cae el evento')$q$, '55000');
select hoteles.group_rooming_cancel((select id from hoteles.group_rooming_entry limit 1));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001', 'Pendiente Perez');
select public.verify_assert(hoteles.group_cancel_block((select id from hoteles.group_block limit 1), 'Se cae el evento') = 15, '5 cuartos x 3 noches');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-13') = 0, 'todo liberado');
select public.verify_assert(not exists (select 1 from hoteles.group_rooming_entry where status = 'pendiente'), 'pendientes cancelados');
select count(*) as cancelado_deberia_ser_1 from hoteles.group_block where status = 'cancelado' and release_kind = 'cancelacion';
rollback;

\echo '=== 34. barrido por cutoff: solo sistema (usuario 42501), no libera antes de la fecha, si en la fecha, e idempotente ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select hoteles.group_rooming_confirm((select id from hoteles.group_rooming_entry limit 1));
select public.verify_expect_error($q$select * from hoteles.group_release_due()$q$, '42501');
select public.verify_as('');
select public.verify_assert((select count(*) from hoteles.group_release_due(null, '2031-06-04T12:00:00Z')) = 0, 'antes del cutoff no libera');
select public.verify_assert((select released_rooms from hoteles.group_release_due(null, '2031-06-05T12:00:00Z')) = 12, 'libera 4 cuartos x 3 noches');
select public.verify_assert((select count(*) from hoteles.group_release_due(null, '2031-06-05T12:00:00Z')) = 0, 'idempotente');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-14') = 1, 'queda el pickup confirmado');
select public.verify_su();
select count(*) as cutoff_deberia_ser_1 from hoteles.group_block where status = 'liberado' and release_kind = 'cutoff' and released_at = '2031-06-05T12:00:00Z';
rollback;

\echo '=== 35. ZONA HORARIA: el mismo instante libera Mexico_City (UTC-6) pero aun no Tijuana (UTC-7, verano) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 3, 100000)));
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0003', 3, 100000)), '00000000-0000-0000-0000-0000000a1a02');
select public.verify_as('');
-- 06:30Z = 00:30 del 5-jun en Mexico_City; 23:30 del 4-jun en Tijuana.
select public.verify_assert((select count(*) from hoteles.group_release_due(null, '2031-06-05T06:30:00Z')) = 1, 'solo Mexico_City');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 0, 'A1 liberada');
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0003', '2031-06-12') = 3, 'Tijuana aun retenida');
-- una hora despues ya es 00:30 del 5-jun en Tijuana.
select public.verify_assert((select count(*) from hoteles.group_release_due(null, '2031-06-05T07:30:00Z')) = 1, 'ahora Tijuana');
select public.verify_su();
select count(*) as ambas_liberadas_deberia_ser_2 from hoteles.group_block where status = 'liberado';
rollback;

\echo '=== 36. ZONA HORARIA: borde exacto a medianoche local (05:59:59Z no libera, 06:00:00Z si) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 3, 100000)));
select public.verify_as('');
select public.verify_assert((select count(*) from hoteles.group_release_due(null, '2031-06-05T05:59:59Z')) = 0, 'un segundo antes');
select count(*) as medianoche_deberia_ser_1 from hoteles.group_release_due(null, '2031-06-05T06:00:00Z');
rollback;

\echo '=== 37. una zona invalida o nula cae a America/Mexico_City en vez de romper la liberacion ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 3, 100000)));
select public.verify_su();
update hoteles.property_config set timezone = 'Mundo/Inexistente' where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_as('');
select public.verify_assert((select count(*) from hoteles.group_release_due(null, '2031-06-05T05:59:59Z')) = 0, 'invalida: borde Mexico_City');
select count(*) as fallback_deberia_ser_1 from hoteles.group_release_due(null, '2031-06-05T06:00:00Z');
rollback;

\echo '=== 38. el barrido filtra por property y respeta bloqueos ya liberados o cancelados ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 3, 100000)));
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0003', 3, 100000)), '00000000-0000-0000-0000-0000000a1a02');
select public.verify_as('');
select public.verify_assert((select count(*) from hoteles.group_release_due('00000000-0000-0000-0000-0000000a1a01', '2032-01-01T00:00:00Z')) = 1, 'solo A1');
select count(*) as solo_a1_deberia_ser_1 from hoteles.group_release_due('00000000-0000-0000-0000-0000000a1a02', '2032-01-01T00:00:00Z');
rollback;

\echo '=== 39. la liberacion nunca deja inventario negativo aunque booked_rooms ya se hubiera reducido por fuera ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 100000)));
select public.verify_su();
update hoteles.availability set booked_rooms = 2 where room_type_id = '00000000-0000-0000-0000-0000000d0001';
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select hoteles.group_release_block((select id from hoteles.group_block limit 1));
select count(*) as nunca_negativo_deberia_ser_3 from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000d0001' and booked_rooms = 0;
rollback;

\echo '=== 40. liberar exige owner/gm/reservations (frontdesk 42501) y el barrido no esta al alcance de anon ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 100000)));
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select hoteles.group_release_block((select id from hoteles.group_block limit 1))$q$, '42501');
select public.verify_expect_error($q$select hoteles.group_cancel_block((select id from hoteles.group_block limit 1), 'Motivo valido')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select hoteles.group_release_block((select b.id from public.verify_bid() b))$q$, 'P0002');
select public.verify_anon();
select public.verify_expect_error($q$select * from hoteles.group_release_due()$q$, '42501');
select public.verify_su();
select count(*) as sigue_activo_deberia_ser_1 from hoteles.group_block where status = 'activo';
rollback;

-- =============================================================================
-- (f) Anticipos: solo registro
-- =============================================================================

\echo '=== 41. anticipo: accountant registra sobre cotizacion aceptada; acumulado exacto; no toca pagos ni folio ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 500000, 'SPEI-0001');
select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 1, 'SPEI-0002');
select public.verify_su();
select public.verify_assert((select count(*) from hoteles.payment) = 0, 'no se creo ningun pago');
select public.verify_assert((select count(*) from hoteles.charge) = 0, 'no se creo ningun cargo');
select count(*) as anticipo_deberia_ser_1 from hoteles.group_quote where deposit_recorded_cents = 500001
  and (select count(*) from hoteles.group_deposit where recorded_by = '00000000-0000-0000-0000-0000000a0a09') = 2;
rollback;

\echo '=== 42. anticipo: borde exacto del total, no mas, monto no positivo, referencia repetida y estado invalido ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 1, 100000)), p_in => '2031-06-12', p_out => '2031-06-13');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 100, 'REF-0001')$q$, '55000');
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select hoteles.group_quote_accept((select id from hoteles.group_quote limit 1));
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 0, 'REF-0001')$q$, '22023');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), -5, 'REF-0001')$q$, '22023');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 100, 'ab')$q$, '22023');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 100001, 'REF-0001')$q$, '22023');
select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 99999, 'REF-0001');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 1, 'REF-0001')$q$, '23505');
select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 1, 'REF-0002');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 1, 'REF-0003')$q$, '22023');
select count(*) as total_exacto_deberia_ser_1 from hoteles.group_quote where deposit_recorded_cents = 100000 and total_cents = 100000;
rollback;

\echo '=== 43. anticipo: reservations y frontdesk no (42501); otro tenant P0002 ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 100, 'REF-0001')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select id from hoteles.group_quote limit 1), 100, 'REF-0001')$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select public.verify_expect_error($q$select hoteles.group_deposit_register((select q.id from public.verify_qid() q), 100, 'REF-0001')$q$, 'P0002');
select public.verify_su();
select count(*) as sin_anticipo_deberia_ser_0 from hoteles.group_deposit;
rollback;

-- =============================================================================
-- (g) Visibilidad (RLS), inmutabilidad y bitacora
-- =============================================================================

\echo '=== 44. RLS: owner/gm/frontdesk/reservations/accountant ven; housekeeping y otro tenant no ven nada; anon sin acceso ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_entry((select id from hoteles.group_block limit 1), '00000000-0000-0000-0000-0000000d0001');
select public.verify_as('00000000-0000-0000-0000-0000000a0a09');
select public.verify_assert((select count(*) from hoteles.group_quote) = 1 and (select count(*) from hoteles.group_block_night) = 3 and (select count(*) from hoteles.group_rooming_entry) = 1, 'accountant ve');
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select public.verify_assert((select count(*) from hoteles.group_quote_line) = 1 and (select count(*) from hoteles.group_event) > 0, 'frontdesk ve');
select public.verify_as('00000000-0000-0000-0000-0000000a0a05');
select public.verify_assert((select count(*) from hoteles.group_quote) = 0 and (select count(*) from hoteles.group_block) = 0 and (select count(*) from hoteles.group_event) = 0, 'housekeeping no ve');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
select count(*) as otro_tenant_deberia_ser_0 from hoteles.group_quote q, hoteles.group_block b, hoteles.group_block_night n, hoteles.group_rooming_entry e, hoteles.group_deposit d;
rollback;

\echo '=== 45. la cotizacion enviada es inmutable (23514) y no admite transiciones invalidas (55000), ni con superusuario ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gq(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 2, 100000)));
select hoteles.group_quote_send((select id from hoteles.group_quote limit 1));
select public.verify_su();
select public.verify_expect_error($q$update hoteles.group_quote set total_cents = 1$q$, '23514');
select public.verify_expect_error($q$update hoteles.group_quote set cutoff_date = '2031-06-01'$q$, '23514');
select public.verify_expect_error($q$update hoteles.group_quote set property_id = '00000000-0000-0000-0000-0000000a1a02'$q$, '23514');
select public.verify_expect_error($q$update hoteles.group_quote set status = 'borrador'$q$, '55000');
select public.verify_expect_error($q$update hoteles.group_quote_line set rooms = 9$q$, '55000');
select public.verify_expect_error($q$delete from hoteles.group_quote_line$q$, '55000');
select public.verify_expect_error($q$delete from hoteles.group_quote$q$, '42501');
select count(*) as intacta_deberia_ser_1 from hoteles.group_quote where total_cents = 600000 and status = 'enviada';
rollback;

\echo '=== 46. invariantes de las noches: pickup + liberado nunca excede lo bloqueado (23514) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_su();
select public.verify_expect_error($q$update hoteles.group_block_night set picked_up_rooms = 6$q$, '23514');
select public.verify_expect_error($q$update hoteles.group_block_night set picked_up_rooms = 3, released_rooms = 3$q$, '23514');
select public.verify_expect_error($q$update hoteles.group_block_night set picked_up_rooms = -1$q$, '23514');
select count(*) as sin_cambios_deberia_ser_3 from hoteles.group_block_night where picked_up_rooms = 0 and released_rooms = 0;
rollback;

\echo '=== 47. bitacora: cada paso deja entrada con actor; la de sistema (cutoff) queda sin actor; es append-only (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_gblock(jsonb_build_array(public.verify_l('00000000-0000-0000-0000-0000000d0001', 5, 150000)));
select public.verify_as('');
select hoteles.group_release_due(null, '2031-06-05T12:00:00Z');
select public.verify_su();
select public.verify_assert((select count(*) from hoteles.group_event where event_type = 'bloqueo_creado' and actor_id = '00000000-0000-0000-0000-0000000a0a04') = 1, 'bloqueo_creado con actor');
select public.verify_assert((select count(*) from hoteles.group_event where event_type = 'cotizacion_enviada') = 1, 'cotizacion_enviada');
select public.verify_assert((select count(*) from hoteles.group_event where event_type = 'bloqueo_liberado' and actor_id is null and detail->>'tipo' = 'cutoff') = 1, 'liberado por el sistema');
select public.verify_expect_error($q$update hoteles.group_event set event_type = 'x'$q$, '42501');
select count(*) as eventos_deberia_ser_1 from hoteles.group_event where event_type = 'cotizacion_creada';
rollback;

\echo '=== 48. los helpers internos no son ejecutables por authenticated ni anon (42501) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select hoteles.group_release_core(gen_random_uuid(), 'manual', now())$q$, '42501');
select public.verify_expect_error($q$select hoteles.group_log('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'bloqueo', gen_random_uuid(), 'falsa', '{}'::jsonb)$q$, '42501');
select public.verify_expect_error($q$select hoteles.group_quote_lock(gen_random_uuid(), array['owner'])$q$, '42501');
select public.verify_expect_error($q$select hoteles.group_local_today('00000000-0000-0000-0000-0000000a1a01', now())$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select hoteles.group_quote_accept(gen_random_uuid())$q$, '42501');
select public.verify_expect_error($q$select hoteles.can_view_groups('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_su();
select count(*) as sin_efectos_deberia_ser_0 from hoteles.group_event;
rollback;

\echo 'Escenarios en los que verify_expect_error confirma el SQLSTATE exacto; los de valor terminan en deberia_ser_N.'
