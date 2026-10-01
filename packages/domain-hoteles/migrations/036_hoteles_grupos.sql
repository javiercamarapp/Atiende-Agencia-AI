-- H-06 (P1) hoteles -- GRUPOS: cotizacion de grupo con vigencia, bloqueo de cuartos (allotment) con fecha de
-- liberacion (cutoff), pickup (cuartos confirmados vs bloqueados), rooming list y liberacion automatica por cutoff
-- como funcion segura invocable (SIN cron programado: decision de producto, ver el README de la API).
--
-- Principio de diseno: la base es la autoridad. Ninguna tabla nueva tiene INSERT/UPDATE/DELETE para
-- `authenticated`: todo cambio pasa por las funciones security definer de abajo, que validan el rol con
-- `hoteles.agent_vertical_role` (de core.membership, jamas de un parametro del cliente) y mueven el inventario
-- (`hoteles.availability.booked_rooms`) bajo el MISMO advisory lock que `book_availability`/`release_availability`
-- (003/005), asi que un bloqueo y una venta o liberacion concurrentes sobre la misma (property, tipo, noche) se
-- serializan.
--
-- Reglas de inventario:
--   * Un bloqueo NUNCA sobrevende: aqui NO aplica la sobreventa controlada de `book_availability` (max_overbook_rooms);
--     se exige `booked_rooms + cuartos <= total_rooms` por noche, todo o nada (una noche sin cupo revierte el bloqueo
--     completo). Dos agentes bloqueando el mismo cuarto: el segundo espera el lock y falla con `sin_disponibilidad`.
--   * Un bloqueo mantiene los cuartos como `booked_rooms` (el inventario general ya no los vende). El pickup no mueve
--     inventario (ya estaba retenido); solo convierte "retenido" en "confirmado".
--   * La liberacion devuelve SOLO lo no confirmado (`blocked - picked_up - released`) con `release_availability`
--     (greatest(booked - qty, 0): nunca queda negativo) y es idempotente.
-- Fecha de liberacion (cutoff): es el PRIMER dia en que los cuartos no confirmados se liberan, a las 00:00 en la zona
-- horaria de la property (`hoteles.property_config.timezone`, o America/Mexico_City). Mientras la fecha local de la
-- property sea menor al cutoff se puede confirmar pickup; desde el cutoff ya no.
-- Dinero: centavos enteros MXN (bigint), sin decimales. Los anticipos/depositos SOLO SE REGISTRAN (no hay cobro ni
-- pasarela aqui); el cobro real sigue siendo del folio.
--
-- Reutiliza (no duplica): hoteles.agent_vertical_role / hoteles.agent_clock / hoteles.agent_guardrail (035: tope de
-- descuento y reloj de sistema no rebobinable), hoteles.property_config (030: zona horaria), hoteles.availability,
-- hoteles.lock_availability y hoteles.release_availability (003/005), hoteles.reservation (001: vinculo opcional).
-- Requiere: 001, 003, 005, 030, 035. Expand-only: solo crea objetos nuevos; no toca ninguna tabla existente.
--
-- REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: el codigo TypeScript que llama a estas tablas/funciones captura
-- SQLSTATE 42P01/42883/42703 dentro de un SAVEPOINT y degrada a "no disponible aun" (nunca un 500).

-- ---------------------------------------------------------------------------
-- 1) Helpers de rol y de fecha local.
--    Seguridad: security definer con search_path fijo (core, hoteles, pg_temp) porque leen core.membership /
--    hoteles.property_config sin dar acceso directo; revocados a public/anon; solo devuelven un booleano/fecha.
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_view_groups(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select coalesce(hoteles.agent_vertical_role(_property_id) in ('owner', 'gm', 'frontdesk', 'reservations', 'accountant'), false)
$$;

create or replace function hoteles.can_manage_groups(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles, pg_temp as $$
  select coalesce(hoteles.agent_vertical_role(_property_id) in ('owner', 'gm', 'reservations'), false)
$$;

-- Fecha local de la property en el instante p_now. Zona nula o invalida cae a America/Mexico_City (nunca un error:
-- una zona mal capturada no debe bloquear la liberacion de cuartos).
create or replace function hoteles.group_local_today(p_property_id uuid, p_now timestamptz)
returns date language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_tz text;
begin
  select pc.timezone into v_tz from hoteles.property_config pc where pc.property_id = p_property_id;
  begin
    return (p_now at time zone coalesce(v_tz, 'America/Mexico_City'))::date;
  exception when others then
    return (p_now at time zone 'America/Mexico_City')::date;
  end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2) Tablas.
-- ---------------------------------------------------------------------------
create table hoteles.group_quote (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  group_name text not null check (char_length(btrim(group_name)) between 2 and 120),
  contact_name text check (contact_name is null or char_length(contact_name) between 2 and 120),
  contact_email text check (contact_email is null or (char_length(contact_email) <= 200 and contact_email ~ '^[^@[:space:]]+@[^@[:space:]]+$')),
  check_in_date date not null,
  check_out_date date not null,
  nights integer generated always as (check_out_date - check_in_date) stored,
  cutoff_date date not null,
  valid_until timestamptz not null,
  currency text not null default 'MXN' check (currency = 'MXN'),
  discount_bps integer not null default 0 check (discount_bps between 0 and 10000),
  gross_cents bigint not null check (gross_cents >= 0),
  total_cents bigint not null check (total_cents >= 0 and total_cents <= gross_cents),
  deposit_required_cents bigint not null default 0 check (deposit_required_cents >= 0 and deposit_required_cents <= total_cents),
  deposit_recorded_cents bigint not null default 0 check (deposit_recorded_cents >= 0 and deposit_recorded_cents <= total_cents),
  status text not null default 'borrador' check (status in ('borrador', 'enviada', 'aceptada', 'rechazada', 'vencida', 'cancelada')),
  sent_at timestamptz,
  accepted_at timestamptz,
  closed_reason text check (closed_reason is null or char_length(closed_reason) between 5 and 300),
  created_by uuid references core.staff_user(id) on delete set null,
  decided_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint group_quote_dates check (check_out_date > check_in_date and check_out_date - check_in_date <= 60),
  constraint group_quote_cutoff check (cutoff_date <= check_in_date)
);
create index group_quote_property_idx on hoteles.group_quote (property_id, created_at desc);
create index group_quote_open_idx on hoteles.group_quote (valid_until) where status in ('borrador', 'enviada');

create table hoteles.group_quote_line (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  quote_id uuid not null references hoteles.group_quote(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id),
  rooms integer not null check (rooms between 1 and 1000),
  rate_cents bigint not null check (rate_cents between 0 and 100000000),
  created_at timestamptz not null default now(),
  unique (quote_id, room_type_id)
);

create table hoteles.group_block (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  quote_id uuid not null unique references hoteles.group_quote(id),
  status text not null default 'activo' check (status in ('activo', 'liberado', 'cancelado')),
  check_in_date date not null,
  check_out_date date not null check (check_out_date > check_in_date),
  cutoff_date date not null check (cutoff_date <= check_in_date),
  released_at timestamptz,
  release_kind text check (release_kind is null or release_kind in ('cutoff', 'manual', 'cancelacion')),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint group_block_release_consistency check ((status = 'activo') = (released_at is null))
);
create index group_block_property_idx on hoteles.group_block (property_id, status);
create index group_block_cutoff_idx on hoteles.group_block (cutoff_date) where status = 'activo';

create table hoteles.group_block_night (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  block_id uuid not null references hoteles.group_block(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id),
  date date not null,
  blocked_rooms integer not null check (blocked_rooms between 1 and 1000),
  picked_up_rooms integer not null default 0 check (picked_up_rooms >= 0),
  released_rooms integer not null default 0 check (released_rooms >= 0),
  unique (block_id, room_type_id, date),
  -- Invariante central: lo confirmado mas lo liberado nunca excede lo bloqueado (nunca un pickup fantasma).
  constraint group_block_night_balance check (picked_up_rooms + released_rooms <= blocked_rooms)
);

create table hoteles.group_rooming_entry (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  block_id uuid not null references hoteles.group_block(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id),
  guest_name text not null check (char_length(btrim(guest_name)) between 2 and 120),
  check_in_date date not null,
  check_out_date date not null check (check_out_date > check_in_date),
  status text not null default 'pendiente' check (status in ('pendiente', 'confirmada', 'cancelada')),
  reservation_id uuid references hoteles.reservation(id) on delete set null,
  confirmed_at timestamptz,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index group_rooming_block_idx on hoteles.group_rooming_entry (block_id, status);

-- Anticipos registrados (SOLO registro, no cobro). La llave (cotizacion, referencia) evita registrar dos veces el
-- mismo comprobante.
create table hoteles.group_deposit (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  quote_id uuid not null references hoteles.group_quote(id),
  amount_cents bigint not null check (amount_cents > 0),
  reference text not null check (char_length(btrim(reference)) between 3 and 120),
  recorded_by uuid references core.staff_user(id) on delete set null,
  recorded_at timestamptz not null default now(),
  unique (quote_id, reference)
);

-- Bitacora inmutable: la escriben SOLO las funciones de abajo; actor null = sistema (barrido de cutoff).
create table hoteles.group_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  subject_type text not null check (subject_type in ('cotizacion', 'bloqueo', 'rooming', 'deposito')),
  subject_id uuid not null,
  event_type text not null check (char_length(event_type) between 1 and 60),
  actor_id uuid references core.staff_user(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index group_event_subject_idx on hoteles.group_event (property_id, subject_type, subject_id, created_at);

create or replace function hoteles.group_log(p_org uuid, p_property uuid, p_subject_type text, p_subject_id uuid, p_event text, p_detail jsonb)
returns void language sql security definer set search_path = core, hoteles, pg_temp as $$
  insert into hoteles.group_event (organization_id, property_id, subject_type, subject_id, event_type, actor_id, detail)
  values (p_org, p_property, p_subject_type, p_subject_id, p_event, auth.uid(), coalesce(p_detail, '{}'::jsonb))
$$;

create or replace function hoteles.group_event_immutable()
returns trigger language plpgsql set search_path = pg_catalog as $$
begin
  raise exception 'group_event es append-only' using errcode = '42501';
end;
$$;
create trigger group_event_no_update before update on hoteles.group_event
  for each row execute function hoteles.group_event_immutable();

-- ---------------------------------------------------------------------------
-- 3) Triggers anti-tamper (segunda capa: ya no hay GRANT de escritura para clientes).
--    La cotizacion solo avanza por el ciclo de vida valido y, fuera de `borrador`, no cambia lo ofrecido; las
--    lineas solo se tocan en `borrador`.
-- ---------------------------------------------------------------------------
create or replace function hoteles.group_quote_guard()
returns trigger language plpgsql set search_path = core, hoteles, pg_temp as $$
begin
  if tg_op = 'DELETE' then
    raise exception 'las cotizaciones de grupo no se borran: se cancelan' using errcode = '42501';
  end if;
  if new.organization_id is distinct from old.organization_id or new.property_id is distinct from old.property_id then
    raise exception 'organization_id/property_id de la cotizacion son inmutables' using errcode = '23514';
  end if;
  if old.status <> 'borrador' and (
       new.check_in_date <> old.check_in_date or new.check_out_date <> old.check_out_date or new.cutoff_date <> old.cutoff_date
       or new.discount_bps <> old.discount_bps or new.gross_cents <> old.gross_cents or new.total_cents <> old.total_cents
       or new.deposit_required_cents <> old.deposit_required_cents or new.valid_until <> old.valid_until) then
    raise exception 'lo ofrecido en una cotizacion enviada no se modifica' using errcode = '23514';
  end if;
  if new.status <> old.status and not (
       (old.status = 'borrador' and new.status in ('enviada', 'vencida', 'cancelada'))
    or (old.status = 'enviada' and new.status in ('aceptada', 'rechazada', 'vencida', 'cancelada'))) then
    raise exception 'transicion de cotizacion no permitida: % -> %', old.status, new.status using errcode = '55000';
  end if;
  if new.status = old.status and old.status in ('aceptada', 'rechazada', 'vencida', 'cancelada')
     and (new.deposit_recorded_cents < old.deposit_recorded_cents) then
    raise exception 'el anticipo registrado no disminuye' using errcode = '23514';
  end if;
  return new;
end;
$$;
create trigger group_quote_guard_trg before update or delete on hoteles.group_quote
  for each row execute function hoteles.group_quote_guard();

create or replace function hoteles.group_quote_line_guard()
returns trigger language plpgsql set search_path = core, hoteles, pg_temp as $$
declare
  v_status text;
begin
  select q.status into v_status from hoteles.group_quote q where q.id = coalesce(new.quote_id, old.quote_id);
  if v_status is not null and v_status <> 'borrador' then
    raise exception 'las lineas de una cotizacion enviada no se modifican' using errcode = '55000';
  end if;
  return coalesce(new, old);
end;
$$;
create trigger group_quote_line_guard_trg before update or delete on hoteles.group_quote_line
  for each row execute function hoteles.group_quote_line_guard();

-- ---------------------------------------------------------------------------
-- 4) Cotizacion: crear / enviar / cerrar / vencer.
-- ---------------------------------------------------------------------------

-- Busca la cotizacion y valida el rol SIN revelar existencia entre tenants: quien no es miembro de la property
-- recibe el mismo P0002 que si no existiera; un miembro sin rol suficiente recibe 42501. El bloqueo de fila se toma
-- DESPUES de validar el rol (un extrano no puede encolar locks).
create or replace function hoteles.group_quote_lock(p_quote_id uuid, p_roles text[])
returns hoteles.group_quote language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_property uuid;
  v_role text;
  q hoteles.group_quote;
begin
  select gq.property_id into v_property from hoteles.group_quote gq where gq.id = p_quote_id;
  v_role := case when v_property is null then null else hoteles.agent_vertical_role(v_property) end;
  if v_property is null or v_role is null then
    raise exception 'cotizacion_no_encontrada' using errcode = 'P0002';
  end if;
  if not (v_role = any(p_roles)) then
    raise exception 'sin permiso para esta operacion sobre grupos' using errcode = '42501';
  end if;
  select * into q from hoteles.group_quote gq where gq.id = p_quote_id for update;
  return q;
end;
$$;

create or replace function hoteles.group_block_lock(p_block_id uuid, p_roles text[])
returns hoteles.group_block language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_property uuid;
  v_role text;
  b hoteles.group_block;
begin
  select gb.property_id into v_property from hoteles.group_block gb where gb.id = p_block_id;
  v_role := case when v_property is null then null else hoteles.agent_vertical_role(v_property) end;
  if v_property is null or v_role is null then
    raise exception 'bloqueo_no_encontrado' using errcode = 'P0002';
  end if;
  if not (v_role = any(p_roles)) then
    raise exception 'sin permiso para esta operacion sobre grupos' using errcode = '42501';
  end if;
  select * into b from hoteles.group_block gb where gb.id = p_block_id for update;
  return b;
end;
$$;

-- p_lines: jsonb [{"room_type_id": uuid, "rooms": int, "rate_cents": int}], tarifa por cuarto-noche en centavos
-- ENTEROS MXN (un decimal se rechaza 22023). total = round-half-up(bruto * (10000 - descuento_bps) / 10000).
-- Un descuento mayor al tope `agent_guardrail.max_discount_pct` (035; 30 % por defecto) solo lo puede aplicar owner/gm.
create or replace function hoteles.group_quote_create(
  p_property_id uuid, p_group_name text, p_contact_name text, p_contact_email text,
  p_check_in date, p_check_out date, p_cutoff_date date, p_valid_until timestamptz,
  p_discount_bps integer, p_deposit_required_cents bigint, p_lines jsonb
) returns hoteles.group_quote
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_role text := hoteles.agent_vertical_role(p_property_id);
  v_org uuid;
  v_today date;
  v_nights integer;
  v_max_pct numeric;
  v_gross numeric := 0;
  v_total numeric;
  v_elem jsonb;
  v_rt uuid;
  v_rooms integer;
  v_rate bigint;
  v_seen uuid[] := '{}';
  q hoteles.group_quote;
begin
  if v_role is null or v_role not in ('owner', 'gm', 'reservations') then
    raise exception 'sin permiso para crear cotizaciones de grupo' using errcode = '42501';
  end if;
  select p.organization_id into v_org from core.property p where p.id = p_property_id;
  if v_org is null then raise exception 'property_no_encontrada' using errcode = 'P0002'; end if;
  if p_check_in is null or p_check_out is null or p_cutoff_date is null or p_valid_until is null then
    raise exception 'fechas y vigencia son obligatorias' using errcode = '22023';
  end if;
  v_nights := p_check_out - p_check_in;
  if v_nights < 1 or v_nights > 60 then
    raise exception 'la estancia del grupo debe ser de 1 a 60 noches' using errcode = '22023';
  end if;
  v_today := hoteles.group_local_today(p_property_id, now());
  if p_check_in < v_today then raise exception 'la llegada del grupo esta en el pasado' using errcode = '22023'; end if;
  if p_cutoff_date > p_check_in then raise exception 'la fecha de liberacion no puede ser posterior a la llegada' using errcode = '22023'; end if;
  if p_cutoff_date < v_today then raise exception 'la fecha de liberacion esta en el pasado' using errcode = '22023'; end if;
  if p_valid_until <= now() then raise exception 'la vigencia de la propuesta ya paso' using errcode = '22023'; end if;
  if p_discount_bps is null or p_discount_bps < 0 or p_discount_bps > 10000 then
    raise exception 'descuento_bps fuera de rango (0 a 10000)' using errcode = '22023';
  end if;
  select g.max_discount_pct into v_max_pct from hoteles.agent_guardrail g where g.property_id = p_property_id;
  if p_discount_bps > coalesce(v_max_pct, 30) * 100 and v_role not in ('owner', 'gm') then
    raise exception 'el descuento excede el tope vigente: lo autoriza owner/gm' using errcode = '42501';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) not between 1 and 50 then
    raise exception 'lines: se esperan de 1 a 50 renglones' using errcode = '22023';
  end if;

  for v_elem in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_elem) <> 'object'
       or (v_elem->>'room_type_id') is null or (v_elem->>'room_type_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
       or coalesce(v_elem->>'rooms', '') !~ '^[0-9]{1,4}$' or coalesce(v_elem->>'rate_cents', '') !~ '^[0-9]{1,9}$' then
      raise exception 'renglon invalido: room_type_id uuid, rooms y rate_cents enteros (centavos)' using errcode = '22023';
    end if;
    v_rt := (v_elem->>'room_type_id')::uuid;
    v_rooms := (v_elem->>'rooms')::integer;
    v_rate := (v_elem->>'rate_cents')::bigint;
    if v_rooms < 1 or v_rooms > 1000 or v_rate > 100000000 then
      raise exception 'renglon fuera de rango (1-1000 cuartos, tarifa hasta 1,000,000.00)' using errcode = '22023';
    end if;
    if v_rt = any(v_seen) then raise exception 'tipo de habitacion repetido en la cotizacion' using errcode = '22023'; end if;
    v_seen := v_seen || v_rt;
    if not exists (select 1 from hoteles.room_type rt where rt.id = v_rt and rt.property_id = p_property_id) then
      raise exception 'tipo_habitacion_invalido: no pertenece a la property' using errcode = '22023';
    end if;
    v_gross := v_gross + (v_rooms::numeric * v_rate::numeric * v_nights::numeric);
  end loop;

  v_total := floor((v_gross * (10000 - p_discount_bps)::numeric + 5000) / 10000);
  if p_deposit_required_cents is null or p_deposit_required_cents < 0 or p_deposit_required_cents > v_total then
    raise exception 'el anticipo requerido no puede exceder el total de la cotizacion' using errcode = '22023';
  end if;

  insert into hoteles.group_quote (organization_id, property_id, group_name, contact_name, contact_email, check_in_date, check_out_date,
                                   cutoff_date, valid_until, discount_bps, gross_cents, total_cents, deposit_required_cents, created_by)
  values (v_org, p_property_id, btrim(p_group_name), nullif(btrim(p_contact_name), ''), nullif(btrim(p_contact_email), ''), p_check_in, p_check_out,
          p_cutoff_date, p_valid_until, p_discount_bps, v_gross::bigint, v_total::bigint, p_deposit_required_cents, auth.uid())
  returning * into q;

  insert into hoteles.group_quote_line (organization_id, property_id, quote_id, room_type_id, rooms, rate_cents)
  select v_org, p_property_id, q.id, (j.value->>'room_type_id')::uuid, (j.value->>'rooms')::integer, (j.value->>'rate_cents')::bigint
  from jsonb_array_elements(p_lines) as j(value);

  perform hoteles.group_log(v_org, p_property_id, 'cotizacion', q.id, 'cotizacion_creada', jsonb_build_object('total_cents', q.total_cents, 'cutoff_date', q.cutoff_date));
  return q;
end;
$$;

create or replace function hoteles.group_quote_send(p_quote_id uuid, p_now timestamptz default null)
returns hoteles.group_quote language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  q hoteles.group_quote := hoteles.group_quote_lock(p_quote_id, array['owner', 'gm', 'reservations']);
  v_now timestamptz := hoteles.agent_clock(p_now);
begin
  if q.status <> 'borrador' then
    raise exception 'solo una cotizacion en borrador se envia (estado: %)', q.status using errcode = '55000';
  end if;
  if q.valid_until <= v_now then
    raise exception 'la vigencia de la propuesta ya paso' using errcode = '55000';
  end if;
  update hoteles.group_quote set status = 'enviada', sent_at = v_now, updated_at = now() where id = q.id returning * into q;
  perform hoteles.group_log(q.organization_id, q.property_id, 'cotizacion', q.id, 'cotizacion_enviada', '{}'::jsonb);
  return q;
end;
$$;

-- Rechaza (enviada) o cancela (borrador/enviada) con motivo. Una cotizacion aceptada tiene bloqueo: se libera por
-- hoteles.group_release_block / group_cancel_block, no aqui.
create or replace function hoteles.group_quote_close(p_quote_id uuid, p_outcome text, p_reason text)
returns hoteles.group_quote language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  q hoteles.group_quote := hoteles.group_quote_lock(p_quote_id, array['owner', 'gm', 'reservations']);
begin
  if p_outcome is null or p_outcome not in ('rechazada', 'cancelada') then
    raise exception 'p_outcome debe ser rechazada o cancelada' using errcode = '22023';
  end if;
  if p_reason is null or char_length(btrim(p_reason)) not between 5 and 300 then
    raise exception 'el motivo es obligatorio (5 a 300 caracteres)' using errcode = '22023';
  end if;
  if q.status not in ('borrador', 'enviada') or (p_outcome = 'rechazada' and q.status <> 'enviada') then
    raise exception 'la cotizacion en estado % no admite % ', q.status, p_outcome using errcode = '55000';
  end if;
  update hoteles.group_quote set status = p_outcome, closed_reason = btrim(p_reason), decided_by = auth.uid(), updated_at = now()
   where id = q.id returning * into q;
  perform hoteles.group_log(q.organization_id, q.property_id, 'cotizacion', q.id, 'cotizacion_' || p_outcome, jsonb_build_object('motivo', q.closed_reason));
  return q;
end;
$$;

-- Vence las propuestas (borrador o enviadas) cuya vigencia paso. SOLO sesion de sistema; idempotente.
create or replace function hoteles.group_expire_quotes(p_now timestamptz default null)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  v_n integer := 0;
  r record;
begin
  if auth.uid() is not null then
    raise exception 'group_expire_quotes: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  for r in select gq.id, gq.organization_id, gq.property_id from hoteles.group_quote gq
            where gq.status in ('borrador', 'enviada') and gq.valid_until <= v_now order by gq.id for update loop
    update hoteles.group_quote set status = 'vencida', updated_at = now() where id = r.id;
    perform hoteles.group_log(r.organization_id, r.property_id, 'cotizacion', r.id, 'cotizacion_vencida', '{}'::jsonb);
    v_n := v_n + 1;
  end loop;
  return v_n;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5) Aceptar = bloquear cuartos (allotment). Atomico: o se retienen TODAS las noches/tipos o ninguno.
--    Orden determinista (tipo, noche) para que dos aceptaciones concurrentes no se interbloqueen.
-- ---------------------------------------------------------------------------
create or replace function hoteles.group_quote_accept(p_quote_id uuid, p_now timestamptz default null)
returns hoteles.group_block language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  q hoteles.group_quote := hoteles.group_quote_lock(p_quote_id, array['owner', 'gm', 'reservations']);
  v_now timestamptz := hoteles.agent_clock(p_now);
  b hoteles.group_block;
  r record;
  a hoteles.availability;
begin
  if q.status <> 'enviada' then
    raise exception 'solo una cotizacion enviada se acepta (estado: %)', q.status using errcode = '55000';
  end if;
  if q.valid_until <= v_now then
    raise exception 'propuesta_vencida: la vigencia ya paso' using errcode = '55000';
  end if;
  if hoteles.group_local_today(q.property_id, v_now) >= q.cutoff_date then
    raise exception 'fecha_de_liberacion_vencida: ya paso la fecha de liberacion del bloqueo' using errcode = '55000';
  end if;

  insert into hoteles.group_block (organization_id, property_id, quote_id, check_in_date, check_out_date, cutoff_date, created_by)
  values (q.organization_id, q.property_id, q.id, q.check_in_date, q.check_out_date, q.cutoff_date, auth.uid())
  returning * into b;

  for r in
    select l.room_type_id, d::date as night, l.rooms
      from hoteles.group_quote_line l
     cross join lateral generate_series(q.check_in_date, q.check_out_date - 1, interval '1 day') d
     where l.quote_id = q.id
     order by l.room_type_id, d
  loop
    perform hoteles.lock_availability(q.property_id, r.room_type_id, r.night);
    select * into a from hoteles.availability av
     where av.property_id = q.property_id and av.room_type_id = r.room_type_id and av.date = r.night for update;
    if not found then
      raise exception 'sin_disponibilidad: no existe inventario para room_type=%, fecha=%', r.room_type_id, r.night using errcode = 'P0001';
    end if;
    -- Sin sobreventa: el bloqueo respeta total_rooms (a diferencia de book_availability).
    if a.booked_rooms + r.rooms > a.total_rooms then
      raise exception 'sin_disponibilidad: room_type=%, fecha=%, libres=%, pedidos=%', r.room_type_id, r.night, greatest(a.total_rooms - a.booked_rooms, 0), r.rooms
        using errcode = 'P0001';
    end if;
    update hoteles.availability set booked_rooms = booked_rooms + r.rooms, updated_at = now() where id = a.id;
    insert into hoteles.group_block_night (organization_id, property_id, block_id, room_type_id, date, blocked_rooms)
    values (q.organization_id, q.property_id, b.id, r.room_type_id, r.night, r.rooms);
  end loop;

  update hoteles.group_quote set status = 'aceptada', accepted_at = v_now, decided_by = auth.uid(), updated_at = now() where id = q.id;
  perform hoteles.group_log(q.organization_id, q.property_id, 'bloqueo', b.id, 'bloqueo_creado',
    jsonb_build_object('cotizacion_id', q.id, 'cutoff_date', b.cutoff_date, 'cuartos_noche', (select coalesce(sum(n.blocked_rooms), 0) from hoteles.group_block_night n where n.block_id = b.id)));
  return b;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6) Anticipos: SOLO REGISTRO (sin cobro). owner/gm/accountant; la cotizacion debe estar aceptada y el acumulado
--    nunca excede el total. La llave (cotizacion, referencia) hace idempotente el registro.
-- ---------------------------------------------------------------------------
create or replace function hoteles.group_deposit_register(p_quote_id uuid, p_amount_cents bigint, p_reference text)
returns hoteles.group_quote language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  q hoteles.group_quote := hoteles.group_quote_lock(p_quote_id, array['owner', 'gm', 'accountant']);
  d hoteles.group_deposit;
begin
  if q.status <> 'aceptada' then
    raise exception 'solo se registran anticipos de una cotizacion aceptada (estado: %)', q.status using errcode = '55000';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'el monto del anticipo debe ser mayor a cero (centavos enteros)' using errcode = '22023';
  end if;
  if p_reference is null or char_length(btrim(p_reference)) not between 3 and 120 then
    raise exception 'la referencia del anticipo es obligatoria (3 a 120 caracteres)' using errcode = '22023';
  end if;
  if q.deposit_recorded_cents + p_amount_cents > q.total_cents then
    raise exception 'el anticipo acumulado excederia el total de la cotizacion' using errcode = '22023';
  end if;
  insert into hoteles.group_deposit (organization_id, property_id, quote_id, amount_cents, reference, recorded_by)
  values (q.organization_id, q.property_id, q.id, p_amount_cents, btrim(p_reference), auth.uid())
  returning * into d;
  update hoteles.group_quote set deposit_recorded_cents = deposit_recorded_cents + p_amount_cents, updated_at = now()
   where id = q.id returning * into q;
  perform hoteles.group_log(q.organization_id, q.property_id, 'deposito', d.id, 'anticipo_registrado',
    jsonb_build_object('cotizacion_id', q.id, 'amount_cents', p_amount_cents));
  return q;
end;
$$;

-- ---------------------------------------------------------------------------
-- 7) Rooming list y pickup.
-- ---------------------------------------------------------------------------
create or replace function hoteles.group_rooming_add(p_block_id uuid, p_room_type_id uuid, p_guest_name text, p_check_in date, p_check_out date)
returns hoteles.group_rooming_entry language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  b hoteles.group_block := hoteles.group_block_lock(p_block_id, array['owner', 'gm', 'reservations', 'frontdesk']);
  e hoteles.group_rooming_entry;
begin
  if b.status <> 'activo' then
    raise exception 'el bloqueo esta % : no admite mas huespedes', b.status using errcode = '55000';
  end if;
  if p_check_in is null or p_check_out is null or p_check_out <= p_check_in or p_check_in < b.check_in_date or p_check_out > b.check_out_date then
    raise exception 'las fechas del huesped deben caer dentro de las del bloqueo' using errcode = '22023';
  end if;
  if p_guest_name is null or char_length(btrim(p_guest_name)) not between 2 and 120 then
    raise exception 'guest_name: 2 a 120 caracteres' using errcode = '22023';
  end if;
  if not exists (select 1 from hoteles.group_block_night n where n.block_id = b.id and n.room_type_id = p_room_type_id) then
    raise exception 'el tipo de habitacion no esta en el bloqueo' using errcode = '22023';
  end if;
  insert into hoteles.group_rooming_entry (organization_id, property_id, block_id, room_type_id, guest_name, check_in_date, check_out_date, created_by)
  values (b.organization_id, b.property_id, b.id, p_room_type_id, btrim(p_guest_name), p_check_in, p_check_out, auth.uid())
  returning * into e;
  perform hoteles.group_log(b.organization_id, b.property_id, 'rooming', e.id, 'huesped_agregado', jsonb_build_object('bloqueo_id', b.id));
  return e;
end;
$$;

-- Confirma el pickup de un huesped: consume un cuarto del bloqueo en CADA noche de su estancia. Se bloquea la fila
-- del bloque primero (misma jerarquia que la liberacion: bloque -> noches), asi un pickup y una liberacion nunca
-- corren a la vez. Desde la fecha de liberacion (hora local de la property) ya no se confirma.
create or replace function hoteles.group_rooming_confirm(p_entry_id uuid, p_reservation_id uuid default null, p_now timestamptz default null)
returns hoteles.group_rooming_entry language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_block uuid;
  v_now timestamptz := hoteles.agent_clock(p_now);
  b hoteles.group_block;
  e hoteles.group_rooming_entry;
  v_res hoteles.reservation;
  v_night date;
  n hoteles.group_block_night;
begin
  select re.block_id into v_block from hoteles.group_rooming_entry re where re.id = p_entry_id;
  if v_block is null then raise exception 'huesped_no_encontrado' using errcode = 'P0002'; end if;
  b := hoteles.group_block_lock(v_block, array['owner', 'gm', 'reservations', 'frontdesk']);
  select * into e from hoteles.group_rooming_entry re where re.id = p_entry_id for update;
  if e.status <> 'pendiente' then
    raise exception 'solo un huesped pendiente se confirma (estado: %)', e.status using errcode = '55000';
  end if;
  if b.status <> 'activo' then
    raise exception 'el bloqueo esta % : ya no admite pickup', b.status using errcode = '55000';
  end if;
  if hoteles.group_local_today(b.property_id, v_now) >= b.cutoff_date then
    raise exception 'fecha_de_liberacion_vencida: el pickup cerro en la fecha de liberacion' using errcode = '55000';
  end if;
  if p_reservation_id is not null then
    select * into v_res from hoteles.reservation r where r.id = p_reservation_id and r.property_id = b.property_id;
    if not found or v_res.room_type_id is distinct from e.room_type_id
       or v_res.check_in_date <> e.check_in_date or v_res.check_out_date <> e.check_out_date then
      raise exception 'la reserva no coincide con la property, el tipo o las fechas del huesped' using errcode = '22023';
    end if;
  end if;

  for v_night in select d::date from generate_series(e.check_in_date, e.check_out_date - 1, interval '1 day') d order by 1 loop
    select * into n from hoteles.group_block_night gn
     where gn.block_id = b.id and gn.room_type_id = e.room_type_id and gn.date = v_night for update;
    if not found or n.picked_up_rooms + n.released_rooms >= n.blocked_rooms then
      raise exception 'sin_cupo_en_bloque: no quedan cuartos bloqueados para la noche %', v_night using errcode = 'P0001';
    end if;
    update hoteles.group_block_night set picked_up_rooms = picked_up_rooms + 1 where id = n.id;
  end loop;

  update hoteles.group_rooming_entry set status = 'confirmada', confirmed_at = v_now, reservation_id = p_reservation_id, updated_at = now()
   where id = e.id returning * into e;
  perform hoteles.group_log(b.organization_id, b.property_id, 'rooming', e.id, 'pickup_confirmado', jsonb_build_object('bloqueo_id', b.id));
  return e;
end;
$$;

-- Cancela un huesped. Si estaba confirmado, devuelve el cuarto: con el bloqueo activo vuelve al pool retenido; con el
-- bloqueo ya liberado se libera tambien del inventario (el cuarto ya no es del grupo).
create or replace function hoteles.group_rooming_cancel(p_entry_id uuid)
returns hoteles.group_rooming_entry language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_block uuid;
  b hoteles.group_block;
  e hoteles.group_rooming_entry;
  v_night date;
begin
  select re.block_id into v_block from hoteles.group_rooming_entry re where re.id = p_entry_id;
  if v_block is null then raise exception 'huesped_no_encontrado' using errcode = 'P0002'; end if;
  b := hoteles.group_block_lock(v_block, array['owner', 'gm', 'reservations', 'frontdesk']);
  select * into e from hoteles.group_rooming_entry re where re.id = p_entry_id for update;
  if e.status = 'cancelada' then
    raise exception 'el huesped ya estaba cancelado' using errcode = '55000';
  end if;
  if e.status = 'confirmada' then
    for v_night in select d::date from generate_series(e.check_in_date, e.check_out_date - 1, interval '1 day') d order by 1 loop
      if b.status = 'liberado' then
        perform hoteles.release_availability(b.property_id, e.room_type_id, v_night, 1);
        update hoteles.group_block_night set picked_up_rooms = picked_up_rooms - 1, released_rooms = released_rooms + 1
         where block_id = b.id and room_type_id = e.room_type_id and date = v_night and picked_up_rooms > 0;
      else
        update hoteles.group_block_night set picked_up_rooms = picked_up_rooms - 1
         where block_id = b.id and room_type_id = e.room_type_id and date = v_night and picked_up_rooms > 0;
      end if;
    end loop;
  end if;
  update hoteles.group_rooming_entry set status = 'cancelada', updated_at = now() where id = e.id returning * into e;
  perform hoteles.group_log(b.organization_id, b.property_id, 'rooming', e.id, 'huesped_cancelado', jsonb_build_object('bloqueo_id', b.id));
  return e;
end;
$$;

-- ---------------------------------------------------------------------------
-- 8) Liberacion: nucleo interno + manual + barrido por cutoff (sistema).
-- ---------------------------------------------------------------------------

-- Nucleo: libera SOLO lo no confirmado (blocked - picked - released) de un bloqueo activo y lo marca liberado.
-- Idempotente (un bloqueo ya liberado/cancelado devuelve 0). Sin EXECUTE para ningun cliente: solo lo llaman las
-- funciones definer de abajo, que ya validaron rol o sesion de sistema.
create or replace function hoteles.group_release_core(p_block_id uuid, p_kind text, p_now timestamptz)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  b hoteles.group_block;
  r record;
  v_total integer := 0;
begin
  select * into b from hoteles.group_block gb where gb.id = p_block_id for update;
  if not found or b.status <> 'activo' then return 0; end if;
  for r in
    select n.id, n.room_type_id, n.date, (n.blocked_rooms - n.picked_up_rooms - n.released_rooms) as libres
      from hoteles.group_block_night n
     where n.block_id = b.id and (n.blocked_rooms - n.picked_up_rooms - n.released_rooms) > 0
     order by n.room_type_id, n.date
  loop
    perform hoteles.release_availability(b.property_id, r.room_type_id, r.date, r.libres);
    update hoteles.group_block_night set released_rooms = released_rooms + r.libres where id = r.id;
    v_total := v_total + r.libres;
  end loop;
  update hoteles.group_block set status = case when p_kind = 'cancelacion' then 'cancelado' else 'liberado' end,
         released_at = p_now, release_kind = p_kind where id = b.id;
  perform hoteles.group_log(b.organization_id, b.property_id, 'bloqueo', b.id, 'bloqueo_liberado',
    jsonb_build_object('tipo', p_kind, 'cuartos_noche_liberados', v_total));
  return v_total;
end;
$$;

-- Liberacion manual anticipada (owner/gm/reservations): libera lo no confirmado y deja el bloqueo `liberado`.
create or replace function hoteles.group_release_block(p_block_id uuid, p_now timestamptz default null)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  b hoteles.group_block := hoteles.group_block_lock(p_block_id, array['owner', 'gm', 'reservations']);
begin
  if b.status <> 'activo' then
    raise exception 'el bloqueo ya esta %', b.status using errcode = '55000';
  end if;
  return hoteles.group_release_core(b.id, 'manual', hoteles.agent_clock(p_now));
end;
$$;

-- Cancela un bloqueo sin pickup confirmado (con huespedes confirmados se libera, no se cancela). Libera todo.
create or replace function hoteles.group_cancel_block(p_block_id uuid, p_reason text)
returns integer language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  b hoteles.group_block := hoteles.group_block_lock(p_block_id, array['owner', 'gm', 'reservations']);
begin
  if p_reason is null or char_length(btrim(p_reason)) not between 5 and 300 then
    raise exception 'el motivo es obligatorio (5 a 300 caracteres)' using errcode = '22023';
  end if;
  if b.status <> 'activo' then
    raise exception 'el bloqueo ya esta %', b.status using errcode = '55000';
  end if;
  if exists (select 1 from hoteles.group_block_night n where n.block_id = b.id and n.picked_up_rooms > 0) then
    raise exception 'el bloqueo tiene huespedes confirmados: cancelalos antes o libera el bloqueo' using errcode = '55000';
  end if;
  update hoteles.group_rooming_entry set status = 'cancelada', updated_at = now() where block_id = b.id and status = 'pendiente';
  return hoteles.group_release_core(b.id, 'cancelacion', now());
end;
$$;

-- LIBERACION AUTOMATICA POR CUTOFF. SOLO sesion de sistema (auth.uid() is null). Recorre los bloqueos activos cuya
-- fecha de liberacion YA llego en la zona horaria de CADA property (fecha local >= cutoff_date) y libera lo no
-- confirmado. Una transaccion interna (subtransaccion) POR bloqueo: si uno falla se registra y se sigue con el
-- resto. p_property_id null = todas las properties. Idempotente. NO esta programada en ningun cron.
create or replace function hoteles.group_release_due(p_property_id uuid default null, p_now timestamptz default null)
returns table (block_id uuid, released_rooms integer)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_now timestamptz := coalesce(p_now, now());
  r record;
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'group_release_due: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  for r in
    select gb.id as bid, gb.organization_id as org, gb.property_id as prop
      from hoteles.group_block gb
     where gb.status = 'activo' and (p_property_id is null or gb.property_id = p_property_id)
       and hoteles.group_local_today(gb.property_id, v_now) >= gb.cutoff_date
     order by gb.cutoff_date, gb.id
  loop
    begin
      v_n := hoteles.group_release_core(r.bid, 'cutoff', v_now);
      block_id := r.bid;
      released_rooms := v_n;
      return next;
    exception when others then
      perform hoteles.group_log(r.org, r.prop, 'bloqueo', r.bid, 'liberacion_fallida', jsonb_build_object('sqlstate', sqlstate));
    end;
  end loop;
end;
$$;

-- ---------------------------------------------------------------------------
-- 9) RLS + GRANT.
--    Seguridad: lectura por property para quienes pueden ver grupos (helper definer). NINGUN INSERT/UPDATE/DELETE
--    para authenticated (por eso no hay GRANT de columna: no existen columnas escribibles directamente); anon no
--    tiene nada. service_role solo lee (sus escrituras tambien pasan por las funciones). Cada funcion definer
--    declara su guard arriba; los helpers internos (group_log, group_release_core, *_lock) no se otorgan a nadie.
-- ---------------------------------------------------------------------------
alter table hoteles.group_quote enable row level security;
alter table hoteles.group_quote_line enable row level security;
alter table hoteles.group_block enable row level security;
alter table hoteles.group_block_night enable row level security;
alter table hoteles.group_rooming_entry enable row level security;
alter table hoteles.group_deposit enable row level security;
alter table hoteles.group_event enable row level security;

create policy "grupos: staff autorizado ve cotizaciones" on hoteles.group_quote for select using (hoteles.can_view_groups(property_id));
create policy "grupos: staff autorizado ve renglones" on hoteles.group_quote_line for select using (hoteles.can_view_groups(property_id));
create policy "grupos: staff autorizado ve bloqueos" on hoteles.group_block for select using (hoteles.can_view_groups(property_id));
create policy "grupos: staff autorizado ve noches bloqueadas" on hoteles.group_block_night for select using (hoteles.can_view_groups(property_id));
create policy "grupos: staff autorizado ve rooming list" on hoteles.group_rooming_entry for select using (hoteles.can_view_groups(property_id));
create policy "grupos: staff autorizado ve anticipos" on hoteles.group_deposit for select using (hoteles.can_view_groups(property_id));
create policy "grupos: staff autorizado ve bitacora" on hoteles.group_event for select using (hoteles.can_view_groups(property_id));

revoke all on hoteles.group_quote, hoteles.group_quote_line, hoteles.group_block, hoteles.group_block_night,
  hoteles.group_rooming_entry, hoteles.group_deposit, hoteles.group_event from public, anon, authenticated, service_role;
grant select on hoteles.group_quote, hoteles.group_quote_line, hoteles.group_block, hoteles.group_block_night,
  hoteles.group_rooming_entry, hoteles.group_deposit, hoteles.group_event to authenticated, service_role;

revoke all on function hoteles.can_view_groups(uuid) from public, anon;
revoke all on function hoteles.can_manage_groups(uuid) from public, anon;
revoke all on function hoteles.group_local_today(uuid, timestamptz) from public, anon, authenticated;
revoke all on function hoteles.group_log(uuid, uuid, text, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function hoteles.group_event_immutable() from public, anon, authenticated;
revoke all on function hoteles.group_quote_guard() from public, anon, authenticated;
revoke all on function hoteles.group_quote_line_guard() from public, anon, authenticated;
revoke all on function hoteles.group_quote_lock(uuid, text[]) from public, anon, authenticated;
revoke all on function hoteles.group_block_lock(uuid, text[]) from public, anon, authenticated;
revoke all on function hoteles.group_release_core(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function hoteles.group_quote_create(uuid, text, text, text, date, date, date, timestamptz, integer, bigint, jsonb) from public, anon;
revoke all on function hoteles.group_quote_send(uuid, timestamptz) from public, anon;
revoke all on function hoteles.group_quote_close(uuid, text, text) from public, anon;
revoke all on function hoteles.group_expire_quotes(timestamptz) from public, anon;
revoke all on function hoteles.group_quote_accept(uuid, timestamptz) from public, anon;
revoke all on function hoteles.group_deposit_register(uuid, bigint, text) from public, anon;
revoke all on function hoteles.group_rooming_add(uuid, uuid, text, date, date) from public, anon;
revoke all on function hoteles.group_rooming_confirm(uuid, uuid, timestamptz) from public, anon;
revoke all on function hoteles.group_rooming_cancel(uuid) from public, anon;
revoke all on function hoteles.group_release_block(uuid, timestamptz) from public, anon;
revoke all on function hoteles.group_cancel_block(uuid, text) from public, anon;
revoke all on function hoteles.group_release_due(uuid, timestamptz) from public, anon;

grant execute on function hoteles.can_view_groups(uuid) to authenticated, service_role;
grant execute on function hoteles.can_manage_groups(uuid) to authenticated, service_role;
grant execute on function hoteles.group_quote_create(uuid, text, text, text, date, date, date, timestamptz, integer, bigint, jsonb) to authenticated, service_role;
grant execute on function hoteles.group_quote_send(uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.group_quote_close(uuid, text, text) to authenticated, service_role;
grant execute on function hoteles.group_expire_quotes(timestamptz) to authenticated, service_role;
grant execute on function hoteles.group_quote_accept(uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.group_deposit_register(uuid, bigint, text) to authenticated, service_role;
grant execute on function hoteles.group_rooming_add(uuid, uuid, text, date, date) to authenticated, service_role;
grant execute on function hoteles.group_rooming_confirm(uuid, uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.group_rooming_cancel(uuid) to authenticated, service_role;
grant execute on function hoteles.group_release_block(uuid, timestamptz) to authenticated, service_role;
grant execute on function hoteles.group_cancel_block(uuid, text) to authenticated, service_role;
grant execute on function hoteles.group_release_due(uuid, timestamptz) to authenticated, service_role;
