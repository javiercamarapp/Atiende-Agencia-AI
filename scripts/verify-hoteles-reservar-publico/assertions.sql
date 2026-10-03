-- H-42 (P1) hoteles -- MOTOR DE RESERVAS DIRECTO PUBLICO: verifica contra Postgres REAL (nunca el mirror en memoria, que jamas aplica
-- RLS/GRANT/triggers/CHECK) que packages/domain-hoteles/migrations/044_hoteles_reservar_directo_publico.sql cierra lo que dice cerrar:
-- canal 'web' sobre booking_hold (037), politica fail-closed por hotel, cotizacion con guardia de precio recalculada en la base, hold
-- SIN sobreventa con anticipo opcional, pago que convierte el hold en reserva 'directo_web', cancelacion con cancellation_policy,
-- cross-tenant, anon y funciones solo-sistema. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI, auto-descubierto).
-- Convencion: igual que verify-hoteles-reservas-agente (verify_expect_error exige el SQLSTATE exacto; el chequeo de valor usa el alias
-- ..._deberia_ser_N en la ULTIMA sentencia de cada escenario). verify_as('') = SESION DE SISTEMA (auth.uid() is null).
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


-- ---------------------------------------------------------------------------
-- Ayudantes del canal web (corren con el rol activo del escenario: sistema = verify_as('')).
-- ---------------------------------------------------------------------------
create or replace function public.verify_web_enable(p_pct numeric default 0, p_enabled boolean default true) returns void language plpgsql as $$
begin
  perform public.verify_as('00000000-0000-0000-0000-0000000a0a01');
  insert into hoteles.booking_agent_policy (property_id, holds_enabled, web_enabled, web_deposit_pct)
    values ('00000000-0000-0000-0000-0000000a1a01', true, p_enabled, p_pct)
    on conflict (property_id) do update set holds_enabled = true, web_enabled = p_enabled, web_deposit_pct = p_pct;
  perform public.verify_as('');
end;
$$;
grant execute on function public.verify_web_enable(numeric, boolean) to public;

create or replace function public.verify_web_hold(
  p_key text, p_phone text default '5215550000001', p_email text default 'ana@example.com', p_rt uuid default '00000000-0000-0000-0000-0000000d0001',
  p_in date default '2031-06-12', p_out date default '2031-06-14', p_total bigint default 357000, p_guests integer default 2,
  p_now timestamptz default '2031-06-01T12:00:00Z', p_consent text default 'v1'
) returns uuid language sql as $$
  select id from hoteles.web_booking_hold_create('00000000-0000-0000-0000-0000000a1a01', p_rt, p_in, p_out, p_guests, 'Ana', p_phone, p_email, p_key, p_total, p_consent, p_now)
$$;
grant execute on function public.verify_web_hold(text, text, text, uuid, date, date, bigint, integer, timestamptz, text) to public;

create or replace function public.verify_hid_of(p_key text) returns uuid language sql security definer as $$
  select id from hoteles.booking_hold where idempotency_key = p_key
$$;
grant execute on function public.verify_hid_of(text) to public;

-- =============================================================================
-- (a) Politica del canal web: fail-closed y escritura solo owner/gm por columna
-- =============================================================================

\echo '=== 1. sin fila de politica el canal web esta deshabilitado (fail-closed): web_booking_policy lo dice y crear un hold falla (55000) sin retener nada ==='
begin;
select public.verify_as('');
select public.verify_assert((select not web_enabled and not holds_enabled and web_deposit_pct = 0 and free_until_hours is null and penalty_pct is null from hoteles.web_booking_policy('00000000-0000-0000-0000-0000000a1a01')), 'sin fila: web deshabilitado, sin anticipo y sin terminos de cancelacion');
select public.verify_su();
insert into hoteles.cancellation_policy (property_id, organization_id, free_until_hours, penalty_pct) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 48, 0.25);
select public.verify_as('');
select public.verify_assert((select free_until_hours = 48 and penalty_pct = 0.25 from hoteles.web_booking_policy('00000000-0000-0000-0000-0000000a1a01')), 'la politica publica trae los terminos de cancelacion vigentes');
select public.verify_expect_error($q$select public.verify_web_hold('web-sin-politica-1')$q$, '55000');
select public.verify_su();
select count(*) as nada_retenido_deberia_ser_0 from hoteles.availability where booked_rooms > 0;
rollback;

\echo '=== 2. holds habilitados para WhatsApp/voz pero SIN opt-in web: la reserva publica sigue cerrada (55000) ==='
begin;
select public.verify_web_enable(0, false);
select public.verify_expect_error($q$select public.verify_web_hold('web-sin-optin-001')$q$, '55000');
select public.verify_su();
select count(*) as sin_holds_deberia_ser_0 from hoteles.booking_hold;
rollback;

\echo '=== 3. politica web: owner y gm la escriben por columna; frontdesk, otro tenant y anon no la cambian (RLS/GRANT) ni la crean (42501); porcentaje fuera de 0..1 (23514) ==='
begin;
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
insert into hoteles.booking_agent_policy (property_id, holds_enabled, web_enabled, web_deposit_pct) values ('00000000-0000-0000-0000-0000000a1a01', true, true, 0.3);
select public.verify_as('00000000-0000-0000-0000-0000000a0a02');
update hoteles.booking_agent_policy set web_deposit_pct = 0.5 where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
update hoteles.booking_agent_policy set web_enabled = false where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, web_enabled) values ('00000000-0000-0000-0000-0000000a1a02', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000b0b01');
update hoteles.booking_agent_policy set web_deposit_pct = 0 where property_id = '00000000-0000-0000-0000-0000000a1a01';
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, web_enabled) values ('00000000-0000-0000-0000-0000000a1a02', true)$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$update hoteles.booking_agent_policy set web_enabled = false where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.booking_agent_policy (property_id, web_enabled) values ('00000000-0000-0000-0000-0000000a1a02', true)$q$, '42501');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$update hoteles.booking_agent_policy set web_deposit_pct = 1.5 where property_id = '00000000-0000-0000-0000-0000000a1a01'$q$, '23514');
select public.verify_su();
select count(*) as pct_intacto_deberia_ser_1 from hoteles.booking_agent_policy where web_deposit_pct = 0.5 and web_enabled;
rollback;

-- =============================================================================
-- (b) Hold web: precio calculado por la base, sin sobreventa, idempotencia, topes
-- =============================================================================

\echo '=== 4. con anticipo 30 %: el hold web retiene cada noche, queda pendiente_pago con anticipo 107100 de 357000 y consentimiento registrado ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-anticipo-0001');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1 and public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-13') = 1, 'ambas noches retenidas');
select count(*) as hold_deberia_ser_1 from hoteles.booking_hold
 where channel = 'web' and status = 'pendiente_pago' and mode = 'link_pago' and total_cents = 357000 and deposit_cents = 107100 and payment_status = 'pendiente'
   and guest_email = 'ana@example.com' and consent_notice_version = 'v1' and consented_at is not null;
rollback;

\echo '=== 5. sin anticipo (0 %): el hold web queda pendiente_aprobacion para una persona, sin pago requerido ==='
begin;
select public.verify_web_enable(0);
select public.verify_web_hold('web-sinanticipo-1');
select public.verify_su();
select count(*) as hold_deberia_ser_1 from hoteles.booking_hold
 where channel = 'web' and status = 'pendiente_aprobacion' and mode = 'aprobacion_humana' and deposit_cents = 0 and payment_status = 'no_requerido';
rollback;

\echo '=== 6. guardia de precio: un total distinto al vigente (22023 precio_cambio) o un descuento pedido NO crea hold ni retiene inventario ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_expect_error($q$select public.verify_web_hold('web-precio-00001', p_total => 100000)$q$, '22023');
select public.verify_expect_error($q$select public.verify_web_hold('web-precio-00002', p_total => 357001)$q$, '22023');
select public.verify_su();
select count(*) as nada_deberia_ser_0 from hoteles.booking_hold;
rollback;

\echo '=== 7. suite fuera de guardia (piso/techo) no se reserva (22023); consentimiento, correo, nombre y telefono invalidos (22023) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_expect_error($q$select public.verify_web_hold('web-guardia-00001', p_rt => '00000000-0000-0000-0000-0000000d0002', p_total => 1190000, p_guests => 2)$q$, '22023');
select public.verify_expect_error($q$select public.verify_web_hold('web-consent-00001', p_consent => '')$q$, '22023');
select public.verify_expect_error($q$select public.verify_web_hold('web-correo-000001', p_email => 'no-es-correo')$q$, '22023');
select public.verify_expect_error($q$select public.verify_web_hold('web-correo-000002', p_email => 'a b@x.com')$q$, '22023');
select public.verify_expect_error($q$select public.verify_web_hold('web-tel-00000001', p_phone => '12')$q$, '22023');
select public.verify_expect_error($q$select hoteles.web_booking_hold_create('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-14', 2, '  ', '5215550000001', 'ana@example.com', 'web-nombre-00001', 357000, 'v1', '2031-06-01T12:00:00Z')$q$, '22023');
select public.verify_su();
select count(*) as nada_deberia_ser_0 from hoteles.booking_hold;
rollback;

\echo '=== 8. idempotencia: la misma llave devuelve el MISMO hold (una sola retencion); con otros parametros (22023) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-idem-0000001');
select public.verify_assert(public.verify_web_hold('web-idem-0000001') = public.verify_hid_of('web-idem-0000001'), 'misma llave => mismo hold');
select public.verify_expect_error($q$select public.verify_web_hold('web-idem-0000001', p_out => '2031-06-13', p_total => 178500)$q$, '22023');
select public.verify_expect_error($q$select public.verify_web_hold('web-idem-0000001', p_phone => '5215550000099')$q$, '22023');
select public.verify_su();
select count(*) as una_retencion_deberia_ser_1 from hoteles.booking_hold h where idempotency_key = 'web-idem-0000001' and public.verify_booked(h.room_type_id, '2031-06-12') = 1;
rollback;

\echo '=== 9. sin dedupe cruzado: otra llave con el mismo telefono/tipo/fechas es OTRO hold (un token nunca apunta al hold de otra persona); el 3o del mismo contacto (55000) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-dedupe-000001');
select public.verify_assert(public.verify_web_hold('web-dedupe-000002') <> public.verify_hid_of('web-dedupe-000001'), 'otra llave => otro hold');
select public.verify_expect_error($q$select public.verify_web_hold('web-dedupe-000003', p_rt => '00000000-0000-0000-0000-0000000d0001')$q$, '55000');
select public.verify_expect_error($q$select public.verify_web_hold('web-dedupe-000004', p_phone => '5215550000444', p_email => 'otra@example.com')$q$, 'P0001');
select public.verify_su();
select count(*) as dos_holds_deberia_ser_2 from hoteles.booking_hold;
rollback;

\echo '=== 10. el limite por contacto tambien aplica por correo (55000) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_su();
update hoteles.availability set total_rooms = 6 where room_type_id = '00000000-0000-0000-0000-0000000d0001';
select public.verify_as('');
select public.verify_web_hold('web-correo-lim-001', '5215550000601', 'misma@example.com');
select public.verify_web_hold('web-correo-lim-002', '5215550000602', 'misma@example.com');
select public.verify_expect_error($q$select public.verify_web_hold('web-correo-lim-003', '5215550000603', 'MISMA@example.com')$q$, '55000');
select public.verify_su();
select count(*) as dos_holds_deberia_ser_2 from hoteles.booking_hold;
rollback;

\echo '=== 11. ultima habitacion: la segunda confirmacion falla sin_disponibilidad (P0001), sin retencion parcial ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_su();
update hoteles.availability set booked_rooms = 1 where room_type_id = '00000000-0000-0000-0000-0000000d0001';
select public.verify_as('');
select public.verify_web_hold('web-ultima-000001', '5215550000701', 'u1@example.com');
select public.verify_expect_error($q$select public.verify_web_hold('web-ultima-000002', '5215550000702', 'u2@example.com')$q$, 'P0001');
select public.verify_su();
select count(*) as una_deberia_ser_1 from hoteles.booking_hold where public.verify_booked(room_type_id, '2031-06-12') = 2;
rollback;

\echo '=== 12. el hold vence sin cron: pasado el TTL web_booking_get lo marca expirado y libera el inventario ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-expira-000001');
select public.verify_assert((select status from hoteles.web_booking_get('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-expira-000001'), '2031-06-01T13:00:00Z')) = 'pendiente_pago', 'antes del TTL sigue abierto');
select public.verify_assert((select status from hoteles.web_booking_get('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-expira-000001'), '2031-06-01T14:30:00Z')) = 'expirado', 'despues del TTL expira');
select public.verify_su();
select public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') + public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-13') as liberado_deberia_ser_0;
rollback;

-- =============================================================================
-- (c) Pago y confirmacion
-- =============================================================================

\echo '=== 13. pago capturado: el hold pasa a confirmado y se crea la reserva con canal directo_web SIN volver a contar el inventario ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-pago-0000001');
select public.verify_assert((select status || '/' || payment_status from hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-pago-0000001'), 'capturado', 'pi_test_1', '2031-06-01T12:05:00Z')) = 'confirmado/capturado', 'confirmado y capturado');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1, 'una sola cuenta por habitacion-noche');
select count(*) as reserva_deberia_ser_1 from hoteles.reservation r join hoteles.booking_hold h on h.reservation_id = r.id
 where r.channel = 'directo_web' and r.status = 'confirmada' and r.total_amount = 3000.00 and h.payment_ref = 'pi_test_1';
rollback;

\echo '=== 14. un cobro fallido deja el hold pendiente_pago (reintentable); luego capturado confirma; repetir el pago es idempotente (una sola reserva) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-pago-0000002');
select public.verify_assert((select payment_status from hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-pago-0000002'), 'fallido', 'pi_fail_1', '2031-06-01T12:05:00Z')) = 'fallido', 'pago fallido');
select public.verify_assert((select status from hoteles.web_booking_get('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-pago-0000002'), '2031-06-01T12:06:00Z')) = 'pendiente_pago', 'sigue abierto');
select public.verify_assert((select status from hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-pago-0000002'), 'capturado', 'pi_ok_2', '2031-06-01T12:07:00Z')) = 'confirmado', 'confirmado');
select public.verify_assert((select status from hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-pago-0000002'), 'capturado', 'pi_ok_2', '2031-06-01T12:08:00Z')) = 'confirmado', 'idempotente');
select public.verify_expect_error($q$select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', gen_random_uuid(), 'capturado', 'pi_x', '2031-06-01T12:08:00Z')$q$, 'P0002');
select public.verify_expect_error($q$select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', null, 'bogus', 'pi_x', '2031-06-01T12:08:00Z')$q$, '22023');
select public.verify_su();
select count(*) as una_reserva_deberia_ser_1 from hoteles.reservation where channel = 'directo_web';
rollback;

\echo '=== 15. pago tardio: con el hold ya vencido el pago NO crea reserva (queda expirado) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-pago-0000003');
select public.verify_assert((select status from hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-pago-0000003'), 'capturado', 'pi_late_1', '2031-06-01T15:00:00Z')) = 'expirado', 'expirado');
select public.verify_su();
select count(*) as sin_reserva_deberia_ser_0 from hoteles.reservation where channel = 'directo_web';
rollback;

\echo '=== 16. el staff confirma un hold web con anticipo sin cobro en pasarela: la reserva es directo_web y el pago queda manual; un hold de WhatsApp sigue sin canal ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-staff-0000001');
select public.verify_hold('hold-wa-0000000001', '5215550000333');
select public.verify_as('00000000-0000-0000-0000-0000000a0a04');
select public.verify_assert((select payment_status from hoteles.booking_hold_confirm(public.verify_hid_of('web-staff-0000001'))) = 'manual', 'pago manual');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select hoteles.booking_hold_decide(public.verify_hid_of('hold-wa-0000000001'), 'aprobar', 'ok');
select hoteles.booking_hold_confirm(public.verify_hid_of('hold-wa-0000000001'));
select public.verify_su();
select count(*) as web_y_wa_deberia_ser_2 from hoteles.reservation r join hoteles.booking_hold h on h.reservation_id = r.id
 where (h.channel = 'web' and r.channel = 'directo_web') or (h.channel = 'whatsapp' and r.channel is null);
rollback;

-- =============================================================================
-- (d) Estado y cancelacion por token (la API firma el token; la base exige property + canal web)
-- =============================================================================

\echo '=== 17. cancelar un hold abierto libera todas las noches y queda cancelado sin penalidad; repetir es idempotente ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-cancel-000001');
select public.verify_assert((select status || '/' || refund_status from hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-cancel-000001'), '2031-06-01T12:10:00Z')) = 'cancelado/no_aplica', 'cancelado');
select public.verify_assert((select status from hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-cancel-000001'), '2031-06-01T12:11:00Z')) = 'cancelado', 'idempotente');
select public.verify_su();
select public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') + public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-13') as liberado_deberia_ser_0;
rollback;

\echo '=== 18. cancelar una reserva confirmada DENTRO de la ventana de penalidad (<24 h, 50 %): penalidad 178500 sobre 357000; el anticipo 107100 no alcanza, reembolso 0 ==='
begin;
select public.verify_su();
insert into hoteles.cancellation_policy (property_id, organization_id, free_until_hours, penalty_pct) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 24, 0.5);
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-penal-0000001');
select public.verify_assert((select status from hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-penal-0000001'), 'capturado', 'pi_pen_1', '2031-06-01T12:05:00Z')) = 'confirmado', 'confirmado');
select public.verify_assert((select cancel_penalty_cents = 178500 and refund_cents = 0 and refund_status = 'no_aplica' from hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-penal-0000001'), '2031-06-11T12:00:00Z')), 'penalidad y sin reembolso');
select public.verify_su();
select public.verify_assert(public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') + public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-13') = 0, 'inventario liberado');
select count(*) as reserva_cancelada_deberia_ser_1 from hoteles.reservation where status = 'cancelada' and cancellation_penalty_amount = 1785.00 and canceled_at is not null;
rollback;

\echo '=== 19. cancelar FUERA de la ventana (>= 24 h): sin penalidad y el anticipo se devuelve (reembolso solicitado 107100); la API lo marca procesado una sola vez ==='
begin;
select public.verify_su();
insert into hoteles.cancellation_policy (property_id, organization_id, free_until_hours, penalty_pct) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 24, 0.5);
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-libre-0000001');
select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-libre-0000001'), 'capturado', 'pi_free_1', '2031-06-01T12:05:00Z');
select public.verify_assert((select cancel_penalty_cents = 0 and refund_cents = 107100 and refund_status = 'solicitado' from hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-libre-0000001'), '2031-06-05T12:00:00Z')), 'sin penalidad y reembolso solicitado');
select public.verify_assert((select refund_status from hoteles.web_booking_mark_refunded('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-libre-0000001'), 're_test_1')) = 'procesado', 'reembolso procesado');
select public.verify_assert((select refund_status from hoteles.web_booking_mark_refunded('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-libre-0000001'), 're_test_1')) = 'procesado', 'idempotente');
select public.verify_assert((select refund_cents from hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-libre-0000001'), '2031-06-05T13:00:00Z')) = 107100, 'cancelar de nuevo no recalcula');
select public.verify_expect_error($q$select hoteles.web_booking_mark_refunded('00000000-0000-0000-0000-0000000a1a01', gen_random_uuid(), 're_x')$q$, 'P0002');
select public.verify_su();
select count(*) as una_cancelada_deberia_ser_1 from hoteles.reservation where status = 'cancelada' and cancellation_penalty_amount = 0;
rollback;

\echo '=== 20. sin cancellation_policy configurada no hay penalidad (mismo criterio que la cancelacion del staff) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-sinpol-000001');
select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-sinpol-000001'), 'capturado', 'pi_np_1', '2031-06-01T12:05:00Z');
select public.verify_assert((select cancel_penalty_cents = 0 and refund_cents = 107100 from hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-sinpol-000001'), '2031-06-11T23:00:00Z')), 'sin politica: sin penalidad');
select public.verify_su();
select count(*) as cancelada_deberia_ser_1 from hoteles.reservation where status = 'cancelada';
rollback;

\echo '=== 21. una reserva ya en check-in no se cancela en linea (55000): se atiende con una persona ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-checkin-00001');
select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-checkin-00001'), 'capturado', 'pi_ci_1', '2031-06-01T12:05:00Z');
select public.verify_su();
update hoteles.reservation set status = 'check_in' where channel = 'directo_web';
select public.verify_as('');
select public.verify_expect_error($q$select hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-checkin-00001'), '2031-06-12T12:00:00Z')$q$, '55000');
select public.verify_su();
select count(*) as sigue_en_check_in_deberia_ser_1 from hoteles.reservation where status = 'check_in' and public.verify_booked('00000000-0000-0000-0000-0000000d0001', '2031-06-12') = 1;
rollback;

\echo '=== 22. contexto del hold web: nombre del tipo, estado de la reserva y terminos de cancelacion; un hold de otro canal o de otra property no se ve (0 filas) ==='
begin;
select public.verify_su();
insert into hoteles.cancellation_policy (property_id, organization_id, free_until_hours, penalty_pct) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 48, 1);
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-ctx-00000001');
select public.verify_hold('hold-wa-ctx-0001', '5215550000555');
select public.verify_assert((select room_type_name = 'Doble' and reservation_status is null and free_until_hours = 48 and penalty_pct = 1 from hoteles.web_booking_context('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-ctx-00000001'))), 'contexto');
select public.verify_assert(not exists (select 1 from hoteles.web_booking_context('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('hold-wa-ctx-0001'))), 'WhatsApp no se expone');
select count(*) as otra_property_deberia_ser_0 from hoteles.web_booking_context('00000000-0000-0000-0000-0000000a1a02', public.verify_hid_of('web-ctx-00000001'));
rollback;

\echo '=== 23. cross-tenant y canal: leer/cancelar/pagar con otra property (P0002) o un hold de WhatsApp por la via web (P0002) no es posible ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-xt-000000001');
select public.verify_hold('hold-wa-xt-000001', '5215550000666');
select public.verify_expect_error(format($q$select hoteles.web_booking_get('00000000-0000-0000-0000-0000000a1a02', %L, '2031-06-01T12:00:00Z')$q$, public.verify_hid_of('web-xt-000000001')), 'P0002');
select public.verify_expect_error(format($q$select hoteles.web_booking_get('00000000-0000-0000-0000-0000000b1b01', %L, '2031-06-01T12:00:00Z')$q$, public.verify_hid_of('web-xt-000000001')), 'P0002');
select public.verify_expect_error(format($q$select hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000b1b01', %L, '2031-06-01T12:00:00Z')$q$, public.verify_hid_of('web-xt-000000001')), 'P0002');
select public.verify_expect_error(format($q$select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a02', %L, 'capturado', 'pi_x', '2031-06-01T12:00:00Z')$q$, public.verify_hid_of('web-xt-000000001')), 'P0002');
select public.verify_expect_error(format($q$select hoteles.web_booking_get('00000000-0000-0000-0000-0000000a1a01', %L, '2031-06-01T12:00:00Z')$q$, public.verify_hid_of('hold-wa-xt-000001')), 'P0002');
select public.verify_expect_error(format($q$select hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', %L, '2031-06-01T12:00:00Z')$q$, public.verify_hid_of('hold-wa-xt-000001')), 'P0002');
select public.verify_su();
select count(*) as intactos_deberia_ser_2 from hoteles.booking_hold where status in ('pendiente_pago', 'pendiente_aprobacion');
rollback;

\echo '=== 24. solo el sistema usa las funciones web: staff con sesion real (42501) y anon (42501) no pueden crear, leer, pagar ni cancelar ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-solo-sist-001');
select public.verify_su();
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$select public.verify_web_hold('web-staff-crea-001')$q$, '42501');
select public.verify_expect_error(format($q$select hoteles.web_booking_get('00000000-0000-0000-0000-0000000a1a01', %L)$q$, public.verify_hid_of('web-solo-sist-001')), '42501');
select public.verify_expect_error(format($q$select hoteles.web_booking_context('00000000-0000-0000-0000-0000000a1a01', %L)$q$, public.verify_hid_of('web-solo-sist-001')), '42501');
select public.verify_expect_error(format($q$select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', %L, 'capturado', 'pi_x')$q$, public.verify_hid_of('web-solo-sist-001')), '42501');
select public.verify_expect_error(format($q$select hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', %L)$q$, public.verify_hid_of('web-solo-sist-001')), '42501');
select public.verify_expect_error(format($q$select hoteles.web_booking_mark_refunded('00000000-0000-0000-0000-0000000a1a01', %L, 're_x')$q$, public.verify_hid_of('web-solo-sist-001')), '42501');
select public.verify_expect_error($q$select * from hoteles.web_booking_policy('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_anon();
select public.verify_expect_error($q$select public.verify_web_hold('web-anon-crea-0001')$q$, '42501');
select public.verify_expect_error(format($q$select hoteles.web_booking_get('00000000-0000-0000-0000-0000000a1a01', %L)$q$, public.verify_hid_of('web-solo-sist-001')), '42501');
select public.verify_expect_error(format($q$select hoteles.web_booking_cancel('00000000-0000-0000-0000-0000000a1a01', %L)$q$, public.verify_hid_of('web-solo-sist-001')), '42501');
select public.verify_expect_error($q$select * from hoteles.web_booking_policy('00000000-0000-0000-0000-0000000a1a01')$q$, '42501');
select public.verify_su();
select count(*) as intacto_deberia_ser_1 from hoteles.booking_hold where status = 'pendiente_pago';
rollback;

-- =============================================================================
-- (e) Integridad: CHECK de coherencia, sin escritura directa, grants y definer
-- =============================================================================

\echo '=== 25. un hold web sin correo ni consentimiento no existe (23514 aun con superusuario); el anticipo no supera el total (23514); sin escritura directa de authenticated (42501) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-integr-00001');
select public.verify_su();
select public.verify_expect_error($q$insert into hoteles.booking_hold (organization_id, property_id, room_type_id, check_in_date, check_out_date, nights, guests, channel, contact_phone, idempotency_key, net_cents, iva_cents, ish_cents, total_cents, nightly, mode, status, expires_at)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-13', 1, 1, 'web', '5215550000999', 'web-sin-correo-001', 100, 0, 0, 100, '[]'::jsonb, 'link_pago', 'pendiente_pago', now())$q$, '23514');
select public.verify_expect_error($q$update hoteles.booking_hold set deposit_cents = total_cents + 1$q$, '23514');
select public.verify_as('00000000-0000-0000-0000-0000000a0a01');
select public.verify_expect_error($q$update hoteles.booking_hold set payment_status = 'capturado', deposit_cents = 0$q$, '42501');
select public.verify_expect_error($q$update hoteles.reservation set channel = 'directo_web'$q$, '42501');
select public.verify_expect_error($q$insert into hoteles.reservation (organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount, channel) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-13', 'confirmada', 1, 'directo_web')$q$, '42501');
select public.verify_su();
select count(*) as intacto_deberia_ser_1 from hoteles.booking_hold where payment_status = 'pendiente' and deposit_cents = 107100;
rollback;

\echo '=== 26. lo cotizado sigue inmutable (42501 aun con superusuario) y el hold web confirmado no cambia de estado final (55000) ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-inmut-000001');
select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-inmut-000001'), 'capturado', 'pi_im_1', '2031-06-01T12:05:00Z');
select public.verify_su();
select public.verify_expect_error($q$update hoteles.booking_hold set total_cents = 100, net_cents = 100, iva_cents = 0, ish_cents = 0, deposit_cents = 0$q$, '42501');
select public.verify_expect_error($q$update hoteles.booking_hold set channel = 'whatsapp'$q$, '42501');
select public.verify_expect_error($q$update hoteles.booking_hold set status = 'cancelado'$q$, '55000');
select count(*) as sigue_confirmado_deberia_ser_1 from hoteles.booking_hold where status = 'confirmado' and total_cents = 357000;
rollback;

\echo '=== 27. todas las funciones web son security definer con search_path fijo y sin EXECUTE para public/anon; solo authenticated/service_role las ejecutan ==='
begin;
select public.verify_assert((select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'hoteles' and p.proname like 'web\_booking\_%') = 7, 'siete funciones web');
select public.verify_assert((select bool_and(p.prosecdef and exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%'))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'hoteles' and p.proname like 'web\_booking\_%'), 'definer con search_path fijo');
select public.verify_assert((select bool_and(p.proacl is not null and not exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = 'anon')))
   from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'hoteles' and p.proname like 'web\_booking\_%'), 'sin EXECUTE para anon/public');
select count(*) as grants_deberia_ser_7 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'hoteles' and p.proname like 'web\_booking\_%' and has_function_privilege('authenticated', p.oid, 'execute') and has_function_privilege('service_role', p.oid, 'execute');
rollback;

\echo '=== 28. KPI room-nights directas (la consulta del backend): noches de reservas directo_web vs total, sin canceladas, recortadas al rango ==='
begin;
select public.verify_web_enable(0.3);
select public.verify_web_hold('web-kpi-0000001');
select hoteles.web_booking_record_payment('00000000-0000-0000-0000-0000000a1a01', public.verify_hid_of('web-kpi-0000001'), 'capturado', 'pi_kpi_1', '2031-06-01T12:05:00Z');
select public.verify_su();
insert into hoteles.reservation (organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-13', 'confirmada', 1000),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', '2031-06-12', '2031-06-15', 'cancelada', 1000);
select public.verify_as('00000000-0000-0000-0000-0000000a0a03');
select count(*) as kpi_deberia_ser_1 from (
  select coalesce(sum(case when channel = 'directo_web' then n end), 0) as directas, coalesce(sum(n), 0) as total
    from (select channel, greatest(0, least(check_out_date, '2031-06-20'::date) - greatest(check_in_date, '2031-06-01'::date)) as n
            from hoteles.reservation where property_id = '00000000-0000-0000-0000-0000000a1a01' and status not in ('cotizada', 'cancelada')
             and check_in_date < '2031-06-20' and check_out_date > '2031-06-01') r
) k where directas = 2 and total = 3;
rollback;

\echo '=== listo: los escenarios con alias deberia_ser_N deben devolver N; los demas deben terminar sin error (verify_expect_error/verify_assert fallan con excepcion) ==='
