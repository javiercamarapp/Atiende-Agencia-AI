-- Fase 3 hoteles (H02) — máquina de estados de reservas. Port literal de
-- hoteles/packages/db/migrations/0006_reservation.sql (tabla de transiciones +
-- trigger + bitácora append-only) + 0013_tarifas_avanzadas_y_politicas.sql
-- (release_availability, que Fase 1 nunca portó — ver migrations/003_availability.sql
-- comentario "Disponibilidad como ruta HTTP propia... queda fuera", que documentaba el
-- soporte de dominio pero no incluía la contraparte de liberar inventario).
--
-- Requiere: 001_hoteles_schema.sql, 003_availability.sql ya aplicadas.
--
-- Nota de despliegue (diseño Fase 3 §7-punto 2): `hoteles.reservation` puede ya tener
-- filas reales en producción con status='confirmada' (texto). Esta migración es
-- expand-safe (todo valor de texto existente -- 'confirmada' es el único default
-- posible desde 001 -- es un miembro válido del enum nuevo), pero debe verificarse
-- contra una copia real de los datos antes de aplicarse a producción.

-- ---------------------------------------------------------------------------
-- 1) Enum + columnas nuevas en hoteles.reservation (ALTER, expand-only)
-- ---------------------------------------------------------------------------
create type hoteles.reservation_status as enum
  ('cotizada', 'confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada', 'cancelada', 'no_show');

alter table hoteles.reservation
  alter column status drop default,
  alter column status type hoteles.reservation_status using status::hoteles.reservation_status,
  alter column status set default 'confirmada'::hoteles.reservation_status;

alter table hoteles.reservation
  add column updated_at timestamptz not null default now(),
  add column canceled_at timestamptz,
  add column cancellation_penalty_amount numeric(12, 2),
  add column total_amount numeric(12, 2) not null default 0 check (total_amount >= 0),
  add column idempotency_key text;

alter table hoteles.reservation alter column total_amount drop default;

-- Reintento seguro de `POST crear` con el mismo Idempotency-Key: mismo criterio que
-- `hoteles.idempotency_key`, pero a nivel de fila porque la reserva es la entidad raíz
-- de la que cuelga el folio primario (un reintento nunca debe producir dos reservas ni
-- dos folios primarios).
create unique index reservation_property_idempotency_key_idx
  on hoteles.reservation (property_id, idempotency_key) where idempotency_key is not null;

-- ---------------------------------------------------------------------------
-- 2) Tabla declarativa de transiciones válidas (idéntica al origen, espejo de
--    reservationStateMachine.ts::canTransition) — NUNCA un CASE en el trigger.
-- ---------------------------------------------------------------------------
create table hoteles.reservation_status_transition (
  from_status hoteles.reservation_status not null,
  to_status hoteles.reservation_status not null,
  primary key (from_status, to_status)
);
insert into hoteles.reservation_status_transition (from_status, to_status) values
  ('cotizada', 'confirmada'),
  ('cotizada', 'cancelada'),
  ('confirmada', 'check_in'),
  ('confirmada', 'cancelada'),
  ('confirmada', 'no_show'),
  ('check_in', 'en_estancia'),
  ('en_estancia', 'check_out'),
  ('check_out', 'cerrada');

-- ---------------------------------------------------------------------------
-- 3) Bitácora append-only + trigger de validación (BEFORE UPDATE OF status).
--    Mismo principio event-sourcing-lite que ya aplica charge/reversed_by en folios:
--    nunca se edita/borra una fila de esta tabla.
-- ---------------------------------------------------------------------------
create table hoteles.reservation_status_event (
  id uuid primary key default gen_random_uuid(),
  reservation_id uuid not null references hoteles.reservation(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  from_status hoteles.reservation_status,
  to_status hoteles.reservation_status not null,
  -- NULL representa el actor lógico "system" (job automático de no-show, NUNCA un
  -- humano) — decisión Fase 3 §7-punto 3: se modela como ausencia de usuario real en
  -- vez de sembrar un usuario técnico, mismo criterio que `created_by uuid ... null`
  -- ya usa `hoteles.fnb_order` para los canales de voz/WhatsApp sin staff humano
  -- logueado (ver types.ts::NewFnbOrderInput). Distinguir "system" de "nadie lo
  -- registró" no es necesario hoy: la única transición que hoy corre sin actor humano
  -- es confirmada->no_show, y esa es la única fila de esta tabla que puede tener
  -- actor_user_id null sin ser un bug de la ruta HTTP.
  actor_user_id uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now()
);
create index reservation_status_event_reservation_idx on hoteles.reservation_status_event (reservation_id);

create or replace function hoteles.reservation_validate_transition()
returns trigger language plpgsql as $$
begin
  if new.status = old.status then
    return new; -- UPDATE que no toca status (ej. otro campo) -- nunca se valida ni se audita aquí.
  end if;
  if not exists (
    select 1 from hoteles.reservation_status_transition
    where from_status = old.status and to_status = new.status
  ) then
    raise exception 'transicion_invalida: % -> % no es una transición válida de hoteles.reservation', old.status, new.status
      using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger reservation_validate_transition_trg
  before update of status on hoteles.reservation
  for each row execute function hoteles.reservation_validate_transition();

-- El registro en la bitácora corre AFTER (la validación ya pasó en el BEFORE trigger
-- de arriba) — `actor_user_id` lo fija la sesión de aplicación vía
-- `set_config('hoteles.actor_user_id', ..., true)` antes del UPDATE (mismo patrón que
-- ya usan otras funciones SECURITY DEFINER de este esquema para no depender de
-- `auth.uid()` cuando el actor lógico es "system"); si la sesión no lo fija, queda
-- NULL (ver comentario de la tabla arriba).
create or replace function hoteles.reservation_log_status_event()
returns trigger language plpgsql as $$
declare
  v_actor uuid;
begin
  begin
    v_actor := nullif(current_setting('hoteles.actor_user_id', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;
  insert into hoteles.reservation_status_event
    (reservation_id, organization_id, property_id, from_status, to_status, actor_user_id)
  values (new.id, new.organization_id, new.property_id, old.status, new.status, v_actor);
  return new;
end;
$$;

create trigger reservation_log_status_event_upd_trg
  after update of status on hoteles.reservation
  for each row when (new.status is distinct from old.status)
  execute function hoteles.reservation_log_status_event();

create or replace function hoteles.reservation_log_status_event_on_insert()
returns trigger language plpgsql as $$
declare
  v_actor uuid;
begin
  begin
    v_actor := nullif(current_setting('hoteles.actor_user_id', true), '')::uuid;
  exception when others then
    v_actor := null;
  end;
  insert into hoteles.reservation_status_event
    (reservation_id, organization_id, property_id, from_status, to_status, actor_user_id)
  values (new.id, new.organization_id, new.property_id, null, new.status, v_actor);
  return new;
end;
$$;

create trigger reservation_log_status_event_ins_trg
  after insert on hoteles.reservation
  for each row execute function hoteles.reservation_log_status_event_on_insert();

-- ---------------------------------------------------------------------------
-- 4) release_availability() — faltaba por completo (ver migrations/003_availability.sql
--    comentario original: se portó book_availability/el soporte de disponibilidad, pero
--    nunca su contraparte de liberar inventario, porque Fase 1 no tenía ningún llamador
--    que cancelara/modificara una reserva). Port literal de
--    hoteles/packages/db/migrations/0013_tarifas_avanzadas_y_politicas.sql:
--    greatest(booked_rooms - qty, 0) — nunca deja booked_rooms negativo. Sin advisory
--    lock propio: comparte el MISMO lock que `book_availability` vía
--    `hoteles.lock_availability`, para que un release y un book concurrentes sobre la
--    misma (property,room_type,date) nunca corran en paralelo.
-- ---------------------------------------------------------------------------
create or replace function hoteles.release_availability(
  _property_id uuid,
  _room_type_id uuid,
  _date date,
  _qty integer default 1
) returns hoteles.availability
language plpgsql as $$
declare
  v_row hoteles.availability;
begin
  if _qty <= 0 then
    raise exception 'cantidad_invalida: _qty debe ser mayor a 0';
  end if;

  perform hoteles.lock_availability(_property_id, _room_type_id, _date);

  update hoteles.availability
  set booked_rooms = greatest(booked_rooms - _qty, 0), updated_at = now()
  where property_id = _property_id and room_type_id = _room_type_id and date = _date
  returning * into v_row;

  -- Mismo criterio que un UPDATE SQL sin fila que haga match: 0 filas afectadas,
  -- nunca un error — una disponibilidad que nunca se sembró no es un caso que esta
  -- función deba lanzar por él (a diferencia de book_availability, que SÍ exige que
  -- exista inventario para poder reservar).
  return v_row; -- NULL si no existía la fila.
end;
$$;

grant execute on function hoteles.release_availability(uuid, uuid, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Política de cancelación por property (port de `hotel_cancellation_policy`).
-- ---------------------------------------------------------------------------
create table hoteles.cancellation_policy (
  property_id uuid primary key references core.property(id) on delete cascade,
  organization_id uuid not null references core.organization(id) on delete cascade,
  free_until_hours integer not null default 24 check (free_until_hours >= 0),
  penalty_pct numeric(5, 4) not null default 0.5 check (penalty_pct >= 0 and penalty_pct <= 1),
  updated_at timestamptz not null default now()
);

alter table hoteles.cancellation_policy enable row level security;
create policy "staff ve la política de cancelación de su property" on hoteles.cancellation_policy for select
  using (core.has_property_access(auth.uid(), property_id));
revoke all on hoteles.cancellation_policy from public, anon;
grant select on hoteles.cancellation_policy to authenticated;
grant select, insert, update, delete on hoteles.cancellation_policy to service_role;

-- ---------------------------------------------------------------------------
-- 6) RLS de hoteles.reservation: Fase 1 solo otorgó SELECT (001_hoteles_schema.sql).
--    Se agrega INSERT/UPDATE acotado a un helper de roles FINOS nuevo,
--    `hoteles.can_manage_reservations()` (mismo patrón que `can_access_money()`,
--    diseño §4-punto 5) — la RLS es la capa "puede tocar el ciclo de vida de esta
--    reserva", el filtrado FINO por transición concreta (ej. quién puede hacer
--    confirmada->check_in vs. confirmada->no_show) vive en la capa de aplicación
--    (`rolesAllowedForTransition`), igual que folios/pedidos-fnb ya establecieron.
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_manage_reservations(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'reservations')
  )
$$;

create policy "reservas: staff con acceso crea reservas" on hoteles.reservation for insert
  with check (hoteles.can_manage_reservations(property_id));
create policy "reservas: staff con acceso actualiza reservas" on hoteles.reservation for update
  using (hoteles.can_manage_reservations(property_id)) with check (hoteles.can_manage_reservations(property_id));

-- reservation_status_event: solo SELECT (append-only, mismo criterio que folio/charge
-- -- ninguna policy de insert/update/delete vía `authenticated`, las triggers arriba
-- corren como el dueño de la función (invoker real via `insert into ... values` dentro
-- del trigger AFTER, ejecutado con los privilegios de quien disparó el UPDATE/INSERT
-- original, protegido por las policies de reservation en sí).
alter table hoteles.reservation_status_event enable row level security;
create policy "staff ve la bitácora de transiciones de su property" on hoteles.reservation_status_event for select
  using (core.has_property_access(auth.uid(), property_id));
revoke all on hoteles.reservation_status_event from public, anon;
grant select, insert on hoteles.reservation_status_event to authenticated;
grant select, insert, update, delete on hoteles.reservation_status_event to service_role;

grant update (status, canceled_at, cancellation_penalty_amount, guest_id, total_amount) on hoteles.reservation to authenticated;
grant insert on hoteles.reservation to authenticated;
