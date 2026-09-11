-- Soporte de disponibilidad (dependencia estructural de quotes.ts/overbooking.ts) —
-- SIN ruta propia expuesta en Fase 1 (ver diseño §6: "Disponibilidad como ruta propia
-- queda fuera; se porta solo el soporte de dominio"). Port literal de
-- hoteles/schema.sql (`public.availability`, `public.lock_availability`,
-- `public.book_availability`) + las columnas de sobreventa de
-- `room_type.max_overbook_rooms`/`overbooking_occupancy_threshold_pct` — mismo espejo
-- que packages/domain-hoteles/src/overbooking.ts implementa en TS puro para
-- explicar/probar la regla sin DB.
alter table hoteles.room_type add column max_overbook_rooms integer not null default 0 check (max_overbook_rooms >= 0);
alter table hoteles.room_type add column overbooking_occupancy_threshold_pct numeric(5, 2) not null default 95
  check (overbooking_occupancy_threshold_pct between 0 and 100);

create table hoteles.availability (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id) on delete cascade,
  date date not null,
  total_rooms integer not null check (total_rooms >= 0),
  booked_rooms integer not null default 0 check (booked_rooms >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, room_type_id, date)
  -- Sin CHECK(booked_rooms <= total_rooms): la sobreventa controlada
  -- (max_overbook_rooms/occupancy_threshold_pct) es una invariante que involucra otra
  -- tabla (room_type), un CHECK de tabla no puede expresarla — book_availability() es
  -- la ÚNICA vía de escritura sancionada, mismo criterio que el origen.
);
create index availability_property_date_idx on hoteles.availability (property_id, date);

create or replace function hoteles.lock_availability(_property_id uuid, _room_type_id uuid, _date date)
returns void
language plpgsql
as $$
begin
  perform pg_advisory_xact_lock(
    hashtextextended(_property_id::text || ':' || _room_type_id::text || ':' || _date::text, 0)
  );
end;
$$;

-- book_availability(): única vía de escritura recomendada para decrementar
-- inventario. Toma el advisory lock, relee la fila bajo lock, valida contra
-- total_rooms + sobreventa vigente (max_overbook_rooms cuando la ocupación ya superó
-- occupancy_threshold_pct) y solo entonces actualiza — nunca un UPDATE ciego.
-- security invoker: corre con el rol de quien llama para que las políticas RLS de
-- `hoteles.availability` sigan aplicando.
create or replace function hoteles.book_availability(
  _property_id uuid,
  _room_type_id uuid,
  _date date,
  _qty integer default 1
)
returns hoteles.availability
language plpgsql
as $$
declare
  v_row hoteles.availability;
  v_max_overbook integer;
  v_threshold_pct numeric;
  v_effective_capacity integer;
begin
  if _qty <= 0 then
    raise exception 'cantidad_invalida: _qty debe ser mayor a 0';
  end if;

  perform hoteles.lock_availability(_property_id, _room_type_id, _date);

  select max_overbook_rooms, overbooking_occupancy_threshold_pct
    into v_max_overbook, v_threshold_pct
  from hoteles.room_type
  where id = _room_type_id and property_id = _property_id;

  if not found then
    raise exception 'tipo_habitacion_invalido: room_type=% no pertenece a property=%', _room_type_id, _property_id
      using errcode = 'P0001';
  end if;

  select * into v_row
  from hoteles.availability
  where property_id = _property_id and room_type_id = _room_type_id and date = _date
  for update;

  if not found then
    raise exception 'sin_disponibilidad: no existe inventario para property=%, room_type=%, fecha=%',
      _property_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  v_effective_capacity := v_row.total_rooms;
  -- Port exacto de hoteles/packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql:
  -- con total_rooms=0 la ocupacion se trata como 100% (nunca como "sin datos"),
  -- asi que SI puede activar sobreventa hasta max_overbook_rooms. Debe coincidir
  -- con occupancyPct(0, x) = 100 en overbooking.ts (el "espejo exacto" documentado).
  if (case when v_row.total_rooms > 0
           then (v_row.booked_rooms::numeric / v_row.total_rooms::numeric) * 100
           else 100 end) >= v_threshold_pct then
    v_effective_capacity := v_row.total_rooms + v_max_overbook;
  end if;

  if v_row.booked_rooms + _qty > v_effective_capacity then
    raise exception 'sin_disponibilidad: no hay habitaciones libres para property=%, room_type=%, fecha=%',
      _property_id, _room_type_id, _date
      using errcode = 'P0001';
  end if;

  update hoteles.availability
  set booked_rooms = booked_rooms + _qty, updated_at = now()
  where id = v_row.id
  returning * into v_row;

  return v_row;
end;
$$;

alter table hoteles.availability enable row level security;
create policy "staff ve disponibilidad de su property" on hoteles.availability for select
  using (core.has_property_access(auth.uid(), property_id));

revoke all on hoteles.availability from public, anon;
grant select on hoteles.availability to authenticated;
grant select, insert, update, delete on hoteles.availability to service_role;
grant execute on function hoteles.lock_availability(uuid, uuid, date) to authenticated;
grant execute on function hoteles.book_availability(uuid, uuid, date, integer) to authenticated;
