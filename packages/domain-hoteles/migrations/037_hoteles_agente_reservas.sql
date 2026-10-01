-- H-25 (P0) hoteles -- AGENTE DE RESERVAS por WhatsApp y voz: disponibilidad por fechas/tipo de cuarto, cotizacion con
-- guardia de precio, pre-reserva (hold) con expiracion y, segun la politica del hotel, aprobacion humana o link de pago
-- SOLO REGISTRADO (sin cobro ni pasarela), mas el estado/cancelacion del hold por el propio huesped.
--
-- Principio de diseno: la base es la autoridad. El agente (sesion de SISTEMA, auth.uid() is null) NUNCA manda un precio:
-- la cotizacion se calcula aqui desde hoteles.rate_plan + hoteles.tax_config y se valida contra el piso/techo de
-- hoteles.pricing_rule (029). Un hold retiene inventario en hoteles.availability.booked_rooms bajo el MISMO advisory lock
-- que book_availability/release_availability/grupos, SIN la sobreventa controlada (booked + 1 <= total_rooms por noche,
-- todo o nada): dos holds concurrentes por la ultima habitacion se serializan y el segundo falla con sin_disponibilidad.
-- Reintentar con la misma llave de idempotencia devuelve el MISMO hold (nunca dos retenciones).
--
-- Dinero: centavos enteros MXN (bigint). Una tarifa de rate_plan con decimales de fraccion de centavo se redondea half-up.
-- Privacidad: el hold solo guarda nombre opcional y telefono del contacto (ya presente en el chat); NO hay columnas de
-- identificacion, tarjeta ni documento. La identidad sigue siendo solo de check-in (boveda, 031).
-- Fechas: "hoy" es la fecha local de la property (hoteles.group_local_today, 036); sin zona valida cae a America/Mexico_City.
--
-- Reutiliza (no duplica): hoteles.agent_vertical_role/can_view_agents/can_manage_agents/agent_clock (035), group_local_today
-- (036), lock_availability (003), release_availability (005), rate_plan/tax_config (001), pricing_rule (029).
-- Requiere: 001, 003, 005, 029, 030, 035, 036. Expand-only: solo crea objetos nuevos; no toca ninguna tabla existente.
--
-- REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: el codigo TypeScript que llama a estas tablas/funciones captura SQLSTATE
-- 42P01/42883/42703 dentro de un SAVEPOINT y degrada a "no disponible aun" + handoff a humano (nunca un 500).

-- ---------------------------------------------------------------------------
-- 1) Politica por hotel. Sin fila = el agente NO crea holds (cotiza y consulta disponibilidad, nada mas): fail-closed.
--    Seguridad: RLS select para staff autorizado; INSERT/UPDATE a nivel COLUMNA y solo owner/gm (can_manage_agents); la
--    organizacion se deriva de la property en el trigger, jamas de un parametro del cliente.
-- ---------------------------------------------------------------------------
create table hoteles.booking_agent_policy (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  holds_enabled boolean not null default false,
  -- aprobacion_humana: el hold queda pendiente hasta que owner/gm/reservations lo apruebe.
  -- link_pago: el hold queda pendiente de pago; un humano REGISTRA la referencia del link (no se cobra aqui).
  mode text not null default 'aprobacion_humana' check (mode in ('aprobacion_humana', 'link_pago')),
  hold_ttl_minutes integer not null default 120 check (hold_ttl_minutes between 15 and 4320),
  max_nights integer not null default 14 check (max_nights between 1 and 60),
  max_guests integer not null default 6 check (max_guests between 1 and 20),
  max_advance_days integer not null default 365 check (max_advance_days between 1 and 730),
  max_active_holds integer not null default 40 check (max_active_holds between 1 and 500),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now()
);

create or replace function hoteles.booking_agent_policy_before_write()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
begin
  if tg_op = 'INSERT' then
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property inexistente' using errcode = '23503';
    end if;
    new.organization_id := v_org;
  end if;
  new.updated_by := auth.uid();
  new.updated_at := now();
  return new;
end;
$$;
create trigger booking_agent_policy_before_write before insert or update on hoteles.booking_agent_policy
  for each row execute function hoteles.booking_agent_policy_before_write();

-- Politica efectiva (valores por defecto si no hay fila, con holds deshabilitados). Solo la usan funciones definer.
create or replace function hoteles.booking_policy_of(p_property_id uuid)
returns hoteles.booking_agent_policy language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  p hoteles.booking_agent_policy;
begin
  select * into p from hoteles.booking_agent_policy where property_id = p_property_id;
  if not found then
    p.property_id := p_property_id;
    p.holds_enabled := false;
    p.mode := 'aprobacion_humana';
    p.hold_ttl_minutes := 120;
    p.max_nights := 14;
    p.max_guests := 6;
    p.max_advance_days := 365;
    p.max_active_holds := 40;
  end if;
  return p;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Holds (pre-reservas) y su bitacora inmutable.
-- ---------------------------------------------------------------------------
create table hoteles.booking_hold (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id) on delete restrict,
  check_in_date date not null,
  check_out_date date not null,
  nights integer not null check (nights between 1 and 60),
  guests integer not null check (guests between 1 and 20),
  channel text not null check (channel in ('whatsapp', 'voz')),
  guest_name text check (guest_name is null or char_length(guest_name) between 1 and 120),
  contact_phone text not null check (char_length(contact_phone) between 4 and 32),
  idempotency_key text not null check (char_length(idempotency_key) between 8 and 120),
  currency text not null default 'MXN' check (currency = 'MXN'),
  net_cents bigint not null check (net_cents > 0),
  iva_cents bigint not null check (iva_cents >= 0),
  ish_cents bigint not null check (ish_cents >= 0),
  total_cents bigint not null check (total_cents > 0),
  nightly jsonb not null check (jsonb_typeof(nightly) = 'array' and octet_length(nightly::text) <= 8192),
  mode text not null check (mode in ('aprobacion_humana', 'link_pago')),
  status text not null check (status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado', 'confirmado', 'rechazado', 'expirado', 'cancelado')),
  expires_at timestamptz not null,
  payment_link_ref text check (payment_link_ref is null or char_length(payment_link_ref) between 1 and 200),
  decided_by uuid references core.staff_user(id) on delete set null,
  decided_at timestamptz,
  decision_reason text check (decision_reason is null or char_length(decision_reason) between 1 and 500),
  reservation_id uuid references hoteles.reservation(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, idempotency_key),
  check (check_out_date > check_in_date),
  check (total_cents = net_cents + iva_cents + ish_cents),
  check (status <> 'confirmado' or reservation_id is not null)
);
create index booking_hold_property_status_idx on hoteles.booking_hold (property_id, status, created_at desc);
create index booking_hold_open_expiry_idx on hoteles.booking_hold (property_id, expires_at)
  where status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado');
create index booking_hold_contact_idx on hoteles.booking_hold (property_id, contact_phone) where status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado');

create table hoteles.booking_hold_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  hold_id uuid not null references hoteles.booking_hold(id) on delete cascade,
  event_type text not null check (char_length(event_type) between 1 and 60),
  actor_id uuid references core.staff_user(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index booking_hold_event_hold_idx on hoteles.booking_hold_event (hold_id, created_at);

create or replace function hoteles.booking_hold_log(p_org uuid, p_property uuid, p_hold uuid, p_event text, p_detail jsonb)
returns void language sql security definer set search_path = core, hoteles, pg_temp as $$
  insert into hoteles.booking_hold_event (organization_id, property_id, hold_id, event_type, actor_id, detail)
  values (p_org, p_property, p_hold, p_event, auth.uid(), coalesce(p_detail, '{}'::jsonb))
$$;

create or replace function hoteles.booking_hold_event_immutable()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'la bitacora de holds es inmutable' using errcode = '42501';
end;
$$;
create trigger booking_hold_event_no_update before update on hoteles.booking_hold_event
  for each row execute function hoteles.booking_hold_event_immutable();

-- Anti-tamper (segunda capa; el cliente tampoco tiene GRANT de escritura ni de DELETE: un hold no se borra, se cancela,
-- expira o rechaza; el DELETE no lleva trigger para no bloquear el borrado en cascada de una property): lo cotizado, las fechas, el contacto y la
-- llave de idempotencia son INMUTABLES una vez creado el hold -- lo que el humano aprueba es exactamente lo que se retuvo.
create or replace function hoteles.booking_hold_guard()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  if new.organization_id is distinct from old.organization_id or new.property_id is distinct from old.property_id
     or new.room_type_id is distinct from old.room_type_id or new.check_in_date is distinct from old.check_in_date
     or new.check_out_date is distinct from old.check_out_date or new.nights is distinct from old.nights
     or new.guests is distinct from old.guests or new.channel is distinct from old.channel
     or new.contact_phone is distinct from old.contact_phone or new.idempotency_key is distinct from old.idempotency_key
     or new.net_cents is distinct from old.net_cents or new.iva_cents is distinct from old.iva_cents
     or new.ish_cents is distinct from old.ish_cents or new.total_cents is distinct from old.total_cents
     or new.nightly is distinct from old.nightly or new.mode is distinct from old.mode then
    raise exception 'lo cotizado y retenido en un hold es inmutable' using errcode = '42501';
  end if;
  if old.status in ('confirmado', 'rechazado', 'expirado', 'cancelado') and new.status is distinct from old.status then
    raise exception 'el hold ya esta en un estado final (%)', old.status using errcode = '55000';
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger booking_hold_guard_trg before update on hoteles.booking_hold
  for each row execute function hoteles.booking_hold_guard();

-- ---------------------------------------------------------------------------
-- 3) Cotizacion DETERMINISTA y validacion de estadia (funciones internas, sin GRANT a nadie: solo las llaman las
--    funciones definer de abajo).
-- ---------------------------------------------------------------------------
create or replace function hoteles.agent_validate_stay(p_property_id uuid, p_check_in date, p_check_out date, p_now timestamptz)
returns integer language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  pol hoteles.booking_agent_policy := hoteles.booking_policy_of(p_property_id);
  v_today date := hoteles.group_local_today(p_property_id, p_now);
begin
  if p_check_in is null or p_check_out is null then
    raise exception 'fechas_invalidas: llegada y salida son obligatorias' using errcode = '22023';
  end if;
  if p_check_out <= p_check_in then
    raise exception 'fechas_invalidas: la salida debe ser posterior a la llegada' using errcode = '22023';
  end if;
  if p_check_in < v_today then
    raise exception 'fecha_pasada: la llegada ya paso en la zona horaria del hotel' using errcode = '22023';
  end if;
  if p_check_in > v_today + pol.max_advance_days then
    raise exception 'fecha_muy_lejana: mas de % dias por adelantado', pol.max_advance_days using errcode = '22023';
  end if;
  if (p_check_out - p_check_in) > pol.max_nights then
    raise exception 'estadia_muy_larga: maximo % noches por el agente', pol.max_nights using errcode = '22023';
  end if;
  return (p_check_out - p_check_in);
end;
$$;

-- Devuelve el estado de la cotizacion ('ok' o el motivo) y, si es 'ok', los montos en centavos. Reglas: una tarifa REAL por
-- noche (rate_plan), min-stay/CTA/CTD de la llegada y la salida, moneda MXN, e IMPORTE por noche dentro de
-- [floor_price, ceiling_price] de pricing_rule si el tipo la tiene (guardia de precio: fuera de rango NO se cotiza, se
-- deriva a una persona). Ningun parametro permite fijar o descontar un precio.
create or replace function hoteles.agent_quote_core(p_property_id uuid, p_room_type_id uuid, p_check_in date, p_check_out date)
returns table (status text, net_cents bigint, iva_cents bigint, ish_cents bigint, total_cents bigint, nightly jsonb)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_nights integer := p_check_out - p_check_in;
  v_found integer;
  v_arrival hoteles.rate_plan;
  v_departure hoteles.rate_plan;
  v_rule hoteles.pricing_rule;
  v_iva numeric;
  v_ish numeric;
  v_net bigint;
  v_iva_c bigint;
  v_ish_c bigint;
  v_nightly jsonb;
begin
  select count(*) into v_found from hoteles.rate_plan rp
   where rp.property_id = p_property_id and rp.room_type_id = p_room_type_id and rp.date >= p_check_in and rp.date < p_check_out;
  if v_found < v_nights then
    return query select 'sin_tarifa'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::jsonb; return;
  end if;
  if exists (select 1 from hoteles.rate_plan rp where rp.property_id = p_property_id and rp.room_type_id = p_room_type_id
               and rp.date >= p_check_in and rp.date < p_check_out and rp.currency <> 'MXN') then
    return query select 'moneda_no_soportada'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::jsonb; return;
  end if;
  select * into v_arrival from hoteles.rate_plan rp where rp.property_id = p_property_id and rp.room_type_id = p_room_type_id and rp.date = p_check_in;
  if v_arrival.closed_to_arrival then
    return query select 'cerrado_a_llegada'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::jsonb; return;
  end if;
  if v_nights < v_arrival.min_stay then
    return query select 'estadia_minima_no_alcanzada'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::jsonb; return;
  end if;
  select * into v_departure from hoteles.rate_plan rp where rp.property_id = p_property_id and rp.room_type_id = p_room_type_id and rp.date = p_check_out;
  if found and v_departure.closed_to_departure then
    return query select 'cerrado_a_salida'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::jsonb; return;
  end if;
  select * into v_rule from hoteles.pricing_rule pr where pr.room_type_id = p_room_type_id and pr.property_id = p_property_id;
  if found and exists (select 1 from hoteles.rate_plan rp where rp.property_id = p_property_id and rp.room_type_id = p_room_type_id
                         and rp.date >= p_check_in and rp.date < p_check_out and (rp.price < v_rule.floor_price or rp.price > v_rule.ceiling_price)) then
    return query select 'precio_fuera_de_guardia'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::jsonb; return;
  end if;
  select coalesce(tc.iva_rate, 0.16), coalesce(tc.ish_rate, 0.03) into v_iva, v_ish
    from (select 1) x left join hoteles.tax_config tc on tc.property_id = p_property_id;
  select coalesce(sum(floor(rp.price * 100 + 0.5)), 0)::bigint,
         jsonb_agg(jsonb_build_object('date', rp.date, 'cents', floor(rp.price * 100 + 0.5)::bigint) order by rp.date)
    into v_net, v_nightly
    from hoteles.rate_plan rp
   where rp.property_id = p_property_id and rp.room_type_id = p_room_type_id and rp.date >= p_check_in and rp.date < p_check_out;
  if v_net <= 0 then
    return query select 'precio_fuera_de_guardia'::text, null::bigint, null::bigint, null::bigint, null::bigint, null::jsonb; return;
  end if;
  v_iva_c := floor(v_net * v_iva + 0.5)::bigint;
  v_ish_c := floor(v_net * v_ish + 0.5)::bigint;
  return query select 'ok'::text, v_net, v_iva_c, v_ish_c, v_net + v_iva_c + v_ish_c, v_nightly;
end;
$$;

-- Libera (o no) los holds abiertos vencidos de una property. Idempotente; libera noche por noche bajo el mismo lock.
create or replace function hoteles.booking_hold_release_inventory(h hoteles.booking_hold)
returns void language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  d date;
begin
  for d in select g::date from generate_series(h.check_in_date, h.check_out_date - 1, interval '1 day') g order by 1 loop
    perform hoteles.lock_availability(h.property_id, h.room_type_id, d);
    update hoteles.availability set booked_rooms = greatest(booked_rooms - 1, 0), updated_at = now()
     where property_id = h.property_id and room_type_id = h.room_type_id and date = d;
  end loop;
end;
$$;

create or replace function hoteles.booking_hold_expire_core(p_property_id uuid, p_now timestamptz)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold;
  n integer := 0;
begin
  for h in select * from hoteles.booking_hold
            where property_id = p_property_id and status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado') and expires_at <= p_now
            order by id for update skip locked loop
    perform hoteles.booking_hold_release_inventory(h);
    update hoteles.booking_hold set status = 'expirado' where id = h.id;
    perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'expirado', jsonb_build_object('expiro', p_now));
    n := n + 1;
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4) Funciones del AGENTE (solo sesion de sistema: auth.uid() is null).
-- ---------------------------------------------------------------------------
create or replace function hoteles.agent_stay_options(p_property_id uuid, p_check_in date, p_check_out date, p_now timestamptz default null)
returns table (room_type_id uuid, room_type_name text, max_occupancy integer, free_rooms integer, status text,
               net_cents bigint, iva_cents bigint, ish_cents bigint, total_cents bigint, nightly jsonb)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  v_nights integer;
  rt record;
  q record;
  v_free integer;
  v_rows integer;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (agente) puede consultar' using errcode = '42501';
  end if;
  if not exists (select 1 from core.property where id = p_property_id and vertical = 'hoteles') then
    raise exception 'property no encontrada' using errcode = 'P0002';
  end if;
  v_nights := hoteles.agent_validate_stay(p_property_id, p_check_in, p_check_out, v_now);
  perform hoteles.booking_hold_expire_core(p_property_id, v_now);
  for rt in select t.id, t.name, t.max_occupancy from hoteles.room_type t where t.property_id = p_property_id order by t.name, t.id loop
    select count(*), coalesce(min(a.total_rooms - a.booked_rooms), 0) into v_rows, v_free
      from hoteles.availability a
     where a.property_id = p_property_id and a.room_type_id = rt.id and a.date >= p_check_in and a.date < p_check_out;
    if v_rows < v_nights then v_free := 0; end if;
    v_free := greatest(v_free, 0);
    select * into q from hoteles.agent_quote_core(p_property_id, rt.id, p_check_in, p_check_out);
    room_type_id := rt.id; room_type_name := rt.name; max_occupancy := rt.max_occupancy; free_rooms := v_free;
    if v_free = 0 then
      status := 'sin_inventario'; net_cents := null; iva_cents := null; ish_cents := null; total_cents := null; nightly := null;
    else
      status := q.status; net_cents := q.net_cents; iva_cents := q.iva_cents; ish_cents := q.ish_cents; total_cents := q.total_cents; nightly := q.nightly;
    end if;
    return next;
  end loop;
end;
$$;

create or replace function hoteles.booking_hold_create(
  p_property_id uuid, p_room_type_id uuid, p_check_in date, p_check_out date, p_guests integer, p_guest_name text,
  p_contact_phone text, p_channel text, p_idempotency_key text, p_expected_total_cents bigint, p_now timestamptz default null
) returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  pol hoteles.booking_agent_policy;
  v_org uuid;
  v_max_occ integer;
  v_nights integer;
  q record;
  h hoteles.booking_hold;
  v_name text := nullif(btrim(coalesce(p_guest_name, '')), '');
  v_phone text := btrim(coalesce(p_contact_phone, ''));
  d date;
  a hoteles.availability;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (agente) crea holds' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id and vertical = 'hoteles';
  if v_org is null then
    raise exception 'property no encontrada' using errcode = 'P0002';
  end if;
  pol := hoteles.booking_policy_of(p_property_id);
  if not pol.holds_enabled then
    raise exception 'holds_deshabilitados: el hotel no habilito la pre-reserva por el agente' using errcode = '55000';
  end if;
  if p_channel not in ('whatsapp', 'voz') or p_idempotency_key is null or char_length(p_idempotency_key) not between 8 and 120
     or char_length(v_phone) not between 4 and 32 or (v_name is not null and char_length(v_name) > 120) then
    raise exception 'parametros_invalidos: canal, llave, telefono o nombre fuera de rango' using errcode = '22023';
  end if;

  -- Idempotencia: una sola retencion por (property, llave), tambien ante concurrencia de la MISMA llave.
  perform pg_advisory_xact_lock(hashtextextended('booking_hold:' || p_property_id::text || ':' || p_idempotency_key, 0));
  select * into h from hoteles.booking_hold where property_id = p_property_id and idempotency_key = p_idempotency_key;
  if found then
    if h.room_type_id is distinct from p_room_type_id or h.check_in_date is distinct from p_check_in
       or h.check_out_date is distinct from p_check_out or h.contact_phone is distinct from v_phone then
      raise exception 'idempotencia_conflicto: la llave ya se uso con otros parametros' using errcode = '22023';
    end if;
    return h;
  end if;

  -- Dedupe natural: el mismo contacto ya tiene un hold ABIERTO para el mismo tipo y fechas (otra llave, mismo pedido: un
  -- reintento del LLM, un mensaje repetido) => se devuelve ese, no se retiene una segunda habitacion.
  select * into h from hoteles.booking_hold
   where property_id = p_property_id and contact_phone = v_phone and room_type_id = p_room_type_id
     and check_in_date = p_check_in and check_out_date = p_check_out
     and status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado') and expires_at > v_now
   order by created_at limit 1;
  if found then
    return h;
  end if;

  v_nights := hoteles.agent_validate_stay(p_property_id, p_check_in, p_check_out, v_now);
  select max_occupancy into v_max_occ from hoteles.room_type where id = p_room_type_id and property_id = p_property_id;
  if not found then
    raise exception 'tipo_habitacion_invalido: no pertenece a la property' using errcode = 'P0002';
  end if;
  if p_guests is null or p_guests < 1 or p_guests > least(pol.max_guests, v_max_occ) then
    raise exception 'huespedes_invalidos: de 1 a % huespedes para este tipo', least(pol.max_guests, v_max_occ) using errcode = '22023';
  end if;

  perform hoteles.booking_hold_expire_core(p_property_id, v_now);
  if (select count(*) from hoteles.booking_hold where property_id = p_property_id and status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado')) >= pol.max_active_holds then
    raise exception 'limite_holds_activos: demasiados holds abiertos en el hotel' using errcode = '55000';
  end if;
  if (select count(*) from hoteles.booking_hold where property_id = p_property_id and contact_phone = v_phone and status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado')) >= 2 then
    raise exception 'limite_holds_contacto: ya tiene 2 pre-reservas abiertas' using errcode = '55000';
  end if;

  select * into q from hoteles.agent_quote_core(p_property_id, p_room_type_id, p_check_in, p_check_out);
  if q.status <> 'ok' then
    raise exception 'cotizacion_no_disponible: %', q.status using errcode = '22023';
  end if;
  if p_expected_total_cents is distinct from q.total_cents then
    raise exception 'precio_cambio: el total vigente es % centavos', q.total_cents using errcode = '22023';
  end if;

  -- Retencion todo-o-nada SIN sobreventa, orden determinista por noche (no hay interbloqueo entre holds).
  for d in select g::date from generate_series(p_check_in, p_check_out - 1, interval '1 day') g order by 1 loop
    perform hoteles.lock_availability(p_property_id, p_room_type_id, d);
    select * into a from hoteles.availability av where av.property_id = p_property_id and av.room_type_id = p_room_type_id and av.date = d for update;
    if not found or a.booked_rooms + 1 > a.total_rooms then
      raise exception 'sin_disponibilidad: no hay habitaciones libres para room_type=%, fecha=%', p_room_type_id, d using errcode = 'P0001';
    end if;
    update hoteles.availability set booked_rooms = booked_rooms + 1, updated_at = now() where id = a.id;
  end loop;

  insert into hoteles.booking_hold (organization_id, property_id, room_type_id, check_in_date, check_out_date, nights, guests, channel, guest_name,
    contact_phone, idempotency_key, net_cents, iva_cents, ish_cents, total_cents, nightly, mode, status, expires_at)
  values (v_org, p_property_id, p_room_type_id, p_check_in, p_check_out, v_nights, p_guests, p_channel, v_name,
    v_phone, p_idempotency_key, q.net_cents, q.iva_cents, q.ish_cents, q.total_cents, q.nightly, pol.mode,
    case pol.mode when 'aprobacion_humana' then 'pendiente_aprobacion' else 'pendiente_pago' end,
    v_now + make_interval(mins => pol.hold_ttl_minutes))
  returning * into h;
  perform hoteles.booking_hold_log(v_org, p_property_id, h.id, 'creado',
    jsonb_build_object('canal', p_channel, 'modo', h.mode, 'totalCentavos', h.total_cents, 'noches', h.nights, 'expira', h.expires_at));
  return h;
end;
$$;

-- Estado y cancelacion por el propio huesped: solo con el hold id Y el mismo telefono del contacto (un id adivinado no
-- basta). Solo cancela holds abiertos; una reserva confirmada se deriva a una persona.
create or replace function hoteles.booking_hold_status_for_contact(p_property_id uuid, p_hold_id uuid, p_contact_phone text, p_now timestamptz default null)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  h hoteles.booking_hold;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (agente) consulta' using errcode = '42501';
  end if;
  perform hoteles.booking_hold_expire_core(p_property_id, v_now);
  select * into h from hoteles.booking_hold where id = p_hold_id and property_id = p_property_id and contact_phone = btrim(coalesce(p_contact_phone, ''));
  if not found then
    raise exception 'pre-reserva no encontrada' using errcode = 'P0002';
  end if;
  return h;
end;
$$;

create or replace function hoteles.booking_hold_cancel_for_contact(p_property_id uuid, p_hold_id uuid, p_contact_phone text, p_now timestamptz default null)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  h hoteles.booking_hold;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema (agente) cancela' using errcode = '42501';
  end if;
  perform hoteles.booking_hold_expire_core(p_property_id, v_now);
  select * into h from hoteles.booking_hold
   where id = p_hold_id and property_id = p_property_id and contact_phone = btrim(coalesce(p_contact_phone, '')) for update;
  if not found then
    raise exception 'pre-reserva no encontrada' using errcode = 'P0002';
  end if;
  if h.status = 'cancelado' then
    return h;
  end if;
  if h.status not in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado') then
    raise exception 'estado_no_cancelable: la pre-reserva esta en estado %', h.status using errcode = '55000';
  end if;
  perform hoteles.booking_hold_release_inventory(h);
  update hoteles.booking_hold set status = 'cancelado' where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'cancelado_por_huesped', '{}'::jsonb);
  return h;
end;
$$;

-- Barrido de sistema (sin cron programado: lo invoca una ruta interna o a mano). Las funciones del agente ya vencen
-- los holds de SU property al consultar, asi que la expiracion no depende de un cron.
create or replace function hoteles.booking_hold_expire_due(p_property_id uuid default null, p_now timestamptz default null)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := hoteles.agent_clock(p_now);
  r record;
  n integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'solo la sesion de sistema puede vencer holds' using errcode = '42501';
  end if;
  for r in select distinct property_id from hoteles.booking_hold
            where status in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado') and expires_at <= v_now
              and (p_property_id is null or property_id = p_property_id) order by 1 loop
    n := n + hoteles.booking_hold_expire_core(r.property_id, v_now);
  end loop;
  return n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Funciones del STAFF (auth.uid() real; rol tomado de core.membership, jamas de un parametro).
--    Aprobar/rechazar/registrar link/confirmar: owner, gm o reservations.
-- ---------------------------------------------------------------------------
create or replace function hoteles.booking_hold_lock(p_hold_id uuid)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold;
begin
  if auth.uid() is null then
    raise exception 'se requiere una sesion de staff' using errcode = '42501';
  end if;
  select * into h from hoteles.booking_hold where id = p_hold_id for update;
  if not found or coalesce(hoteles.agent_vertical_role(h.property_id), '') not in ('owner', 'gm', 'reservations') then
    raise exception 'pre-reserva no encontrada' using errcode = 'P0002';
  end if;
  return h;
end;
$$;

create or replace function hoteles.booking_hold_decide(p_hold_id uuid, p_decision text, p_reason text)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold := hoteles.booking_hold_lock(p_hold_id);
  pol hoteles.booking_agent_policy;
begin
  if p_decision not in ('aprobar', 'rechazar') then
    raise exception 'decision invalida' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'el motivo es obligatorio (1 a 500 caracteres)' using errcode = '22023';
  end if;
  if h.mode <> 'aprobacion_humana' or h.status <> 'pendiente_aprobacion' then
    raise exception 'solo un hold pendiente de aprobacion se decide (estado: %)', h.status using errcode = '55000';
  end if;
  if h.expires_at <= now() then
    -- Vence y devuelve el hold ya en estado 'expirado' (sin excepcion: un RAISE revertiria la liberacion del inventario).
    perform hoteles.booking_hold_expire_core(h.property_id, now());
    select * into h from hoteles.booking_hold where id = p_hold_id;
    return h;
  end if;
  if p_decision = 'rechazar' then
    perform hoteles.booking_hold_release_inventory(h);
    update hoteles.booking_hold set status = 'rechazado', decided_by = auth.uid(), decided_at = now(), decision_reason = btrim(p_reason)
     where id = h.id returning * into h;
  else
    pol := hoteles.booking_policy_of(h.property_id);
    update hoteles.booking_hold set status = 'aprobado', decided_by = auth.uid(), decided_at = now(), decision_reason = btrim(p_reason),
           expires_at = now() + make_interval(mins => pol.hold_ttl_minutes)
     where id = h.id returning * into h;
  end if;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, case p_decision when 'aprobar' then 'aprobado' else 'rechazado' end,
    jsonb_build_object('motivo', btrim(p_reason)));
  return h;
end;
$$;

-- SOLO REGISTRA la referencia de un link de pago que el hotel genero por fuera: no cobra ni toca pasarelas. Rechaza una
-- referencia con forma de tarjeta (13 a 19 digitos seguidos) para que nunca se guarde un PAN.
create or replace function hoteles.booking_hold_register_payment_link(p_hold_id uuid, p_ref text)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold := hoteles.booking_hold_lock(p_hold_id);
begin
  if h.mode <> 'link_pago' or h.status <> 'pendiente_pago' then
    raise exception 'solo un hold en modo link_pago pendiente de pago admite el registro (estado: %)', h.status using errcode = '55000';
  end if;
  if p_ref is null or char_length(btrim(p_ref)) not between 1 and 200 or regexp_replace(p_ref, '[ -]', '', 'g') ~ '[0-9]{13,19}' then
    raise exception 'referencia invalida: de 1 a 200 caracteres y sin numeros con forma de tarjeta' using errcode = '22023';
  end if;
  update hoteles.booking_hold set payment_link_ref = btrim(p_ref) where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'link_pago_registrado', '{}'::jsonb);
  return h;
end;
$$;

-- Confirma: crea la reserva (confirmada, total = NETO en pesos, mismo criterio que POST crear) y marca el hold. El
-- inventario ya estaba retenido por el hold, asi que NO se vuelve a reservar (una sola cuenta por habitacion-noche).
create or replace function hoteles.booking_hold_confirm(p_hold_id uuid)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold := hoteles.booking_hold_lock(p_hold_id);
  v_res uuid;
begin
  if h.status not in ('aprobado', 'pendiente_pago') then
    raise exception 'solo un hold aprobado o pendiente de pago se confirma (estado: %)', h.status using errcode = '55000';
  end if;
  if h.expires_at <= now() then
    perform hoteles.booking_hold_expire_core(h.property_id, now());
    select * into h from hoteles.booking_hold where id = p_hold_id;
    return h;
  end if;
  insert into hoteles.reservation (organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount, idempotency_key)
  values (h.organization_id, h.property_id, h.room_type_id, h.check_in_date, h.check_out_date, 'confirmada', h.net_cents::numeric / 100, 'hold-' || h.id::text)
  on conflict (property_id, idempotency_key) where idempotency_key is not null do update set updated_at = hoteles.reservation.updated_at
  returning id into v_res;
  update hoteles.booking_hold set status = 'confirmado', reservation_id = v_res, decided_by = coalesce(decided_by, auth.uid()),
         decided_at = coalesce(decided_at, now()) where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'confirmado', jsonb_build_object('reservaId', v_res));
  return h;
end;
$$;

create or replace function hoteles.booking_hold_staff_cancel(p_hold_id uuid, p_reason text)
returns hoteles.booking_hold language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  h hoteles.booking_hold := hoteles.booking_hold_lock(p_hold_id);
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 1 and 500 then
    raise exception 'el motivo es obligatorio (1 a 500 caracteres)' using errcode = '22023';
  end if;
  if h.status not in ('pendiente_aprobacion', 'pendiente_pago', 'aprobado') then
    raise exception 'estado_no_cancelable: el hold esta en estado %', h.status using errcode = '55000';
  end if;
  perform hoteles.booking_hold_release_inventory(h);
  update hoteles.booking_hold set status = 'cancelado', decided_by = auth.uid(), decided_at = now(), decision_reason = btrim(p_reason)
   where id = h.id returning * into h;
  perform hoteles.booking_hold_log(h.organization_id, h.property_id, h.id, 'cancelado_por_staff', jsonb_build_object('motivo', btrim(p_reason)));
  return h;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) RLS + GRANT.
--    * Tablas: solo SELECT para staff autorizado (can_view_agents). Ninguna escritura directa de authenticated sobre holds
--      ni bitacora; la politica se escribe por COLUMNA y solo owner/gm.
--    * Funciones del agente: EXECUTE solo para service_role (la sesion de sistema de la API) y se auto-protegen con
--      auth.uid() is null. Funciones de staff: EXECUTE para authenticated, con rol exigido adentro. Todo revocado a
--      public/anon. Las funciones internas no tienen GRANT para nadie.
-- ---------------------------------------------------------------------------
alter table hoteles.booking_agent_policy enable row level security;
alter table hoteles.booking_hold enable row level security;
alter table hoteles.booking_hold_event enable row level security;

create policy "reservas-agente: staff autorizado ve la politica" on hoteles.booking_agent_policy for select using (hoteles.can_view_agents(property_id));
create policy "reservas-agente: owner/gm crea la politica" on hoteles.booking_agent_policy for insert with check (hoteles.can_manage_agents(property_id));
create policy "reservas-agente: owner/gm ajusta la politica" on hoteles.booking_agent_policy for update
  using (hoteles.can_manage_agents(property_id)) with check (hoteles.can_manage_agents(property_id));
create policy "reservas-agente: staff autorizado ve los holds" on hoteles.booking_hold for select using (hoteles.can_view_agents(property_id));
create policy "reservas-agente: staff autorizado ve la bitacora de holds" on hoteles.booking_hold_event for select using (hoteles.can_view_agents(property_id));

revoke all on hoteles.booking_agent_policy, hoteles.booking_hold, hoteles.booking_hold_event from public, anon, authenticated;
grant select on hoteles.booking_agent_policy, hoteles.booking_hold, hoteles.booking_hold_event to authenticated;
grant insert (property_id, holds_enabled, mode, hold_ttl_minutes, max_nights, max_guests, max_advance_days, max_active_holds)
  on hoteles.booking_agent_policy to authenticated;
grant update (holds_enabled, mode, hold_ttl_minutes, max_nights, max_guests, max_advance_days, max_active_holds)
  on hoteles.booking_agent_policy to authenticated;
grant select, insert, update, delete on hoteles.booking_agent_policy, hoteles.booking_hold, hoteles.booking_hold_event to service_role;

revoke all on function hoteles.booking_agent_policy_before_write() from public, anon, authenticated;
revoke all on function hoteles.booking_policy_of(uuid) from public, anon, authenticated;
revoke all on function hoteles.booking_hold_log(uuid, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function hoteles.booking_hold_event_immutable() from public, anon, authenticated;
revoke all on function hoteles.booking_hold_guard() from public, anon, authenticated;
revoke all on function hoteles.agent_validate_stay(uuid, date, date, timestamptz) from public, anon, authenticated;
revoke all on function hoteles.agent_quote_core(uuid, uuid, date, date) from public, anon, authenticated;
revoke all on function hoteles.booking_hold_release_inventory(hoteles.booking_hold) from public, anon, authenticated;
revoke all on function hoteles.booking_hold_expire_core(uuid, timestamptz) from public, anon, authenticated;
revoke all on function hoteles.booking_hold_lock(uuid) from public, anon, authenticated;
revoke all on function hoteles.agent_stay_options(uuid, date, date, timestamptz) from public, anon;
revoke all on function hoteles.booking_hold_create(uuid, uuid, date, date, integer, text, text, text, text, bigint, timestamptz) from public, anon;
revoke all on function hoteles.booking_hold_status_for_contact(uuid, uuid, text, timestamptz) from public, anon;
revoke all on function hoteles.booking_hold_cancel_for_contact(uuid, uuid, text, timestamptz) from public, anon;
revoke all on function hoteles.booking_hold_expire_due(uuid, timestamptz) from public, anon;
revoke all on function hoteles.booking_hold_decide(uuid, text, text) from public, anon;
revoke all on function hoteles.booking_hold_register_payment_link(uuid, text) from public, anon;
revoke all on function hoteles.booking_hold_confirm(uuid) from public, anon;
revoke all on function hoteles.booking_hold_staff_cancel(uuid, text) from public, anon;

-- La sesion de sistema de la API corre como el rol de la conexion (authenticated con auth.uid() null, igual que 022/035/036):
-- por eso las funciones del agente tambien llevan EXECUTE para authenticated y se protegen con el guard auth.uid() is null.
grant execute on function hoteles.agent_stay_options(uuid, date, date, timestamptz) to authenticated, service_role;
grant execute on function hoteles.booking_hold_create(uuid, uuid, date, date, integer, text, text, text, text, bigint, timestamptz) to authenticated, service_role;
grant execute on function hoteles.booking_hold_status_for_contact(uuid, uuid, text, timestamptz) to authenticated, service_role;
grant execute on function hoteles.booking_hold_cancel_for_contact(uuid, uuid, text, timestamptz) to authenticated, service_role;
grant execute on function hoteles.booking_hold_expire_due(uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.booking_hold_decide(uuid, text, text) to authenticated, service_role;
grant execute on function hoteles.booking_hold_register_payment_link(uuid, text) to authenticated, service_role;
grant execute on function hoteles.booking_hold_confirm(uuid) to authenticated, service_role;
grant execute on function hoteles.booking_hold_staff_cancel(uuid, text) to authenticated, service_role;
