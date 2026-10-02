-- H-28 (cambio de fechas con recotizacion + seguimientos de #302) y H-12 (lista de espera de hoteles).
--
-- Requiere: 001, 003, 005, 025/026, 035 (agent_vertical_role), 038 (change_reservation_room). Expand-only: crea objetos
-- nuevos y REDEFINE una sola funcion (change_reservation_room) sin cambiar su firma ni su contrato.
--
-- REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: el codigo TypeScript que usa estos objetos captura SQLSTATE 42883/42P01/42703
-- dentro de un SAVEPOINT y responde "no disponible aun" (503 / lista vacia con bandera), nunca un 500.
--
-- Roles (todos leidos de core.membership con hoteles.agent_vertical_role, jamas de un parametro):
--   cambio de fechas y lista de espera: owner, gm, frontdesk, reservations (los mismos que can_manage_reservations).

-- ---------------------------------------------------------------------------
-- 1) Seguimiento #302: change_reservation_room revisaba la membresia DESPUES de `for update` sobre la reserva. Un usuario
--    de otro tenant podia, en teoria, bloquear una fila ajena antes de recibir "no encontrada" (disponibilidad, no fuga de
--    datos: la respuesta seguia siendo P0002). Se redefine con la membresia PRIMERO (lectura sin bloqueo) y el bloqueo
--    despues. Misma firma, mismos errores, mismas reglas; solo cambia el orden.
--    Seguridad: security definer, search_path fijo (core, hoteles, pg_temp), exige auth.uid(), revocada a public/anon.
-- ---------------------------------------------------------------------------
create or replace function hoteles.change_reservation_room(p_reservation_id uuid, p_new_room_id uuid, p_reason text default null)
returns table (reservation_id uuid, from_room_id uuid, to_room_id uuid)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_res record;
  v_room record;
  v_role text;
  v_prop uuid;
  v_reason text := nullif(btrim(p_reason), '');
begin
  if auth.uid() is null then
    raise exception 'change_reservation_room: requiere un usuario autenticado' using errcode = '42501';
  end if;
  if p_reservation_id is null or p_new_room_id is null then
    raise exception 'reserva y habitacion son obligatorias' using errcode = '22023';
  end if;
  if v_reason is not null and length(v_reason) not between 3 and 200 then
    raise exception 'motivo: entre 3 y 200 caracteres' using errcode = '22023';
  end if;

  -- Membresia ANTES de bloquear: lectura simple, sin `for update`.
  select r.property_id into v_prop from hoteles.reservation r where r.id = p_reservation_id;
  v_role := case when v_prop is null then null else hoteles.agent_vertical_role(v_prop) end;
  if v_role is null then
    -- Sin membresia en la property o reserva inexistente: indistinguibles (no se filtra la existencia entre tenants).
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'gm', 'frontdesk') then
    raise exception 'rol sin permiso para asignar habitaciones' using errcode = '42501';
  end if;

  select r.id, r.organization_id, r.property_id, r.room_type_id, r.room_id, r.status, r.check_in_date, r.check_out_date
    into v_res from hoteles.reservation r where r.id = p_reservation_id for update;
  if v_res.id is null then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if v_res.status not in ('confirmada', 'check_in', 'en_estancia') then
    raise exception 'reserva_no_modificable: la reserva esta en estado %', v_res.status using errcode = '55000';
  end if;

  select rm.id, rm.room_type_id, rm.status, rm.code into v_room
    from hoteles.room rm where rm.id = p_new_room_id and rm.property_id = v_res.property_id;
  if v_room.id is null then
    raise exception 'habitacion no encontrada en esta property' using errcode = 'P0002';
  end if;
  if v_room.id is not distinct from v_res.room_id then
    raise exception 'misma_habitacion: la reserva ya tiene esa habitacion' using errcode = '22023';
  end if;
  if v_room.room_type_id is distinct from v_res.room_type_id then
    raise exception 'tipo_distinto: la habitacion es de otro tipo que la reserva' using errcode = '22023';
  end if;
  if v_room.status in ('fuera_de_servicio', 'mantenimiento')
     or exists (select 1 from hoteles.room_out_of_service o where o.room_id = v_room.id and o.status = 'activo') then
    raise exception 'habitacion_no_disponible: la habitacion % esta fuera de servicio', v_room.code using errcode = '55000';
  end if;
  if v_res.status in ('check_in', 'en_estancia') and v_room.status in ('sucia', 'ocupada') then
    raise exception 'habitacion_no_lista: la habitacion % esta %', v_room.code, v_room.status using errcode = '55000';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('hoteles.room_assign:' || v_room.id::text, 0));
  if exists (
    select 1 from hoteles.reservation o
    where o.room_id = v_room.id and o.id <> v_res.id
      and o.status in ('confirmada', 'check_in', 'en_estancia')
      and o.check_in_date < v_res.check_out_date and o.check_out_date > v_res.check_in_date
  ) then
    raise exception 'habitacion_ocupada: la habitacion % tiene otra reserva en esas fechas', v_room.code using errcode = '23P01';
  end if;

  update hoteles.reservation set room_id = v_room.id where id = v_res.id;
  if v_res.status in ('check_in', 'en_estancia') then
    if v_res.room_id is not null then
      update hoteles.room set status = 'sucia' where id = v_res.room_id and property_id = v_res.property_id and status in ('disponible', 'ocupada');
    end if;
    update hoteles.room set status = 'ocupada' where id = v_room.id and property_id = v_res.property_id and status = 'disponible';
  end if;
  insert into hoteles.reservation_room_change (organization_id, property_id, reservation_id, from_room_id, to_room_id, reason, changed_by)
  values (v_res.organization_id, v_res.property_id, v_res.id, v_res.room_id, v_room.id, v_reason, auth.uid());

  return query select v_res.id, v_res.room_id, v_room.id;
end;
$$;
revoke all on function hoteles.change_reservation_room(uuid, uuid, text) from public, anon;
grant execute on function hoteles.change_reservation_room(uuid, uuid, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Bitacora append-only del cambio de fechas.
--    Seguridad: RLS select solo para el staff que administra reservas de la property; ningun GRANT de escritura a
--    authenticated (solo la funcion change_reservation_dates, security definer, inserta); un trigger bloquea UPDATE/DELETE
--    aun para superusuario salvo las acciones referenciales en cascada de sus FK (mismo patron que reservation_room_change, 038). organization_id y changed_by los deriva la
--    funcion de la reserva y de auth.uid(): nunca vienen del cliente. El motivo es texto libre acotado (3-200).
--    `penalty_amount` es la penalidad calculada por la politica de cancelacion al acortar; es informativa para el
--    staff (no se postea sola al folio).
-- ---------------------------------------------------------------------------
create table hoteles.reservation_date_change (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  reservation_id uuid not null references hoteles.reservation(id) on delete cascade,
  old_check_in date not null,
  old_check_out date not null,
  new_check_in date not null,
  new_check_out date not null,
  old_total numeric(12, 2) not null check (old_total >= 0),
  new_total numeric(12, 2) not null check (new_total >= 0),
  penalty_amount numeric(12, 2) not null default 0 check (penalty_amount >= 0),
  reason text check (reason is null or char_length(reason) between 3 and 200),
  changed_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  check (old_check_out > old_check_in and new_check_out > new_check_in)
);
create index reservation_date_change_reservation_idx on hoteles.reservation_date_change (reservation_id, created_at desc);

create or replace function hoteles.reservation_date_change_immutable()
returns trigger language plpgsql set search_path = hoteles, pg_temp as $$
begin
  -- Disponibilidad: las FK de esta tabla son ON DELETE CASCADE (organization, property, reservation) y ON DELETE SET NULL
  -- (changed_by, que dispara un UPDATE). Esas acciones referenciales corren como trigger anidado (pg_trigger_depth() > 1) y
  -- deben poder completarse: si no, con UNA fila de bitacora ya no se podria borrar una reserva, property, staff ni dar de
  -- baja un tenant (mismo criterio que reservation_room_change, 038). Un UPDATE/DELETE directo (profundidad 1) sigue
  -- prohibido incluso al superusuario.
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'reservation_date_change es append-only' using errcode = '42501';
end;
$$;
revoke all on function hoteles.reservation_date_change_immutable() from public, anon;
create trigger reservation_date_change_no_update_trg
  before update or delete on hoteles.reservation_date_change
  for each row execute function hoteles.reservation_date_change_immutable();

alter table hoteles.reservation_date_change enable row level security;
create policy "fechas: staff de reservas ve la bitacora de cambios de fechas" on hoteles.reservation_date_change for select
  using (hoteles.can_manage_reservations(property_id));
revoke all on hoteles.reservation_date_change from public, anon;
grant select on hoteles.reservation_date_change to authenticated;
grant select, insert on hoteles.reservation_date_change to service_role;

-- ---------------------------------------------------------------------------
-- 3) hoteles.change_reservation_dates(...): cambio atomico de fechas de una reserva.
--    Seguridad: security definer con search_path fijo (core, hoteles, pg_temp) porque actualiza reservation.check_in_date /
--    check_out_date / total_amount y el inventario en UNA transaccion con bloqueos y validaciones (nota: authenticated ya
--    tiene UPDATE(total_amount) desde la 005; esta funcion NO es la barrera sobre ese campo, solo agrega atomicidad); exige auth.uid() (la sesion de sistema
--    NO la ejecuta); la membresia y el rol (owner/gm/frontdesk/reservations) se leen ANTES de bloquear fila alguna; revocada
--    a public/anon.
--    Reglas: la reserva debe estar confirmada / check_in / en_estancia. Confirmada: cambia llegada y salida. En casa: la
--    llegada NO cambia, solo se extiende o acorta la salida. NUNCA se tocan noches ya posteadas por el night-audit (cargo de
--    hospedaje con stay_date, sin reversar): toda noche posteada debe seguir dentro de [llegada, salida). Si la reserva
--    tiene habitacion fisica asignada, ninguna otra reserva activa puede traslaparla en el rango nuevo (bajo el mismo
--    advisory lock por habitacion que change_reservation_room).
--    Inventario: las noches quitadas se liberan (release_availability) y las agregadas se reservan (book_availability, que
--    respeta la sobreventa controlada), recorridas en orden de fecha ascendente para que dos cambios concurrentes tomen los
--    advisory locks en el mismo orden (sin interbloqueo). Si una noche agregada no tiene cupo, la funcion lanza P0001
--    sin_disponibilidad y TODO el cambio se revierte.
--    Concurrencia: `for update` sobre la reserva serializa dos cambios de la misma reserva; las fechas "esperadas" que manda
--    el llamador se comparan con las vigentes bajo bloqueo: si otro cambio ya las movio, 55006 reserva_modificada (el total
--    que el llamador calculo ya no aplica).
--    El total (neto) y la penalidad los calcula el servidor con el motor de cotizacion; aqui solo se validan >= 0.
-- ---------------------------------------------------------------------------
create or replace function hoteles.change_reservation_dates(
  p_reservation_id uuid,
  p_expected_check_in date,
  p_expected_check_out date,
  p_new_check_in date,
  p_new_check_out date,
  p_new_total numeric,
  p_penalty numeric default 0,
  p_reason text default null
)
returns table (out_reservation_id uuid, out_old_check_in date, out_old_check_out date, out_new_check_in date, out_new_check_out date, out_new_total numeric, out_noches_liberadas integer, out_noches_reservadas integer, out_penalty_amount numeric)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_res record;
  v_prop uuid;
  v_role text;
  v_reason text := nullif(btrim(p_reason), '');
  v_night record;
  v_released integer := 0;
  v_booked integer := 0;
  v_in_house boolean;
  v_penalty numeric := coalesce(p_penalty, 0);
  v_old_total numeric;
begin
  if auth.uid() is null then
    raise exception 'change_reservation_dates: requiere un usuario autenticado' using errcode = '42501';
  end if;
  if p_reservation_id is null or p_expected_check_in is null or p_expected_check_out is null
     or p_new_check_in is null or p_new_check_out is null or p_new_total is null then
    raise exception 'reserva, fechas y total son obligatorios' using errcode = '22023';
  end if;
  if p_new_check_out <= p_new_check_in then
    raise exception 'la salida debe ser posterior a la llegada' using errcode = '22023';
  end if;
  if p_new_check_out - p_new_check_in > 365 then
    raise exception 'la estancia no puede pasar de 365 noches' using errcode = '22023';
  end if;
  if p_new_total < 0 or v_penalty < 0 then
    raise exception 'total y penalidad no pueden ser negativos' using errcode = '22023';
  end if;
  if v_reason is not null and char_length(v_reason) not between 3 and 200 then
    raise exception 'motivo: entre 3 y 200 caracteres' using errcode = '22023';
  end if;

  -- Membresia y rol ANTES de bloquear (sin `for update`): sin membresia = "no encontrada".
  select r.property_id into v_prop from hoteles.reservation r where r.id = p_reservation_id;
  v_role := case when v_prop is null then null else hoteles.agent_vertical_role(v_prop) end;
  if v_role is null then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'gm', 'frontdesk', 'reservations') then
    raise exception 'rol sin permiso para cambiar fechas de reservas' using errcode = '42501';
  end if;

  select r.id, r.organization_id, r.property_id, r.room_type_id, r.room_id, r.status, r.check_in_date, r.check_out_date, r.total_amount
    into v_res from hoteles.reservation r where r.id = p_reservation_id for update;
  if v_res.id is null then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if v_res.check_in_date is distinct from p_expected_check_in or v_res.check_out_date is distinct from p_expected_check_out then
    raise exception 'reserva_modificada: las fechas de la reserva cambiaron mientras tanto' using errcode = '55006';
  end if;
  if v_res.status not in ('confirmada', 'check_in', 'en_estancia') then
    raise exception 'reserva_no_modificable: la reserva esta en estado %', v_res.status using errcode = '55000';
  end if;
  if p_new_check_in = v_res.check_in_date and p_new_check_out = v_res.check_out_date then
    raise exception 'sin_cambio: las fechas son las mismas' using errcode = '22023';
  end if;
  v_in_house := v_res.status in ('check_in', 'en_estancia');
  if v_in_house and p_new_check_in <> v_res.check_in_date then
    raise exception 'llegada_no_modificable: con el huesped en casa solo se cambia la salida' using errcode = '22023';
  end if;

  -- Noches ya posteadas por el night-audit: no se tocan jamas.
  if exists (
    select 1 from hoteles.charge c join hoteles.folio f on f.id = c.folio_id
    where f.reservation_id = v_res.id and c.concept = 'hospedaje' and c.stay_date is not null
      and c.reverses_charge_id is null and c.reversed_by is null
      and (c.stay_date < p_new_check_in or c.stay_date >= p_new_check_out)
  ) then
    raise exception 'noches_posteadas: hay noches ya cargadas al folio fuera de las fechas nuevas' using errcode = '55000';
  end if;

  if v_res.room_id is not null then
    perform pg_advisory_xact_lock(hashtextextended('hoteles.room_assign:' || v_res.room_id::text, 0));
    if exists (
      select 1 from hoteles.reservation o
      where o.room_id = v_res.room_id and o.id <> v_res.id
        and o.status in ('confirmada', 'check_in', 'en_estancia')
        and o.check_in_date < p_new_check_out and o.check_out_date > p_new_check_in
    ) then
      raise exception 'habitacion_ocupada: la habitacion asignada tiene otra reserva en las fechas nuevas' using errcode = '23P01';
    end if;
  end if;

  -- Inventario por noche en orden de fecha ascendente (mismo orden de locks para todo cambio concurrente).
  for v_night in
    select d::date as night,
           (d::date >= v_res.check_in_date and d::date < v_res.check_out_date) as was_booked,
           (d::date >= p_new_check_in and d::date < p_new_check_out) as will_be_booked
      from generate_series(least(v_res.check_in_date, p_new_check_in)::timestamp,
                           (greatest(v_res.check_out_date, p_new_check_out) - 1)::timestamp, interval '1 day') d
     order by 1
  loop
    if v_night.was_booked and not v_night.will_be_booked then
      perform hoteles.release_availability(v_res.property_id, v_res.room_type_id, v_night.night, 1);
      v_released := v_released + 1;
    elsif v_night.will_be_booked and not v_night.was_booked then
      perform hoteles.book_availability(v_res.property_id, v_res.room_type_id, v_night.night, 1);
      v_booked := v_booked + 1;
    end if;
  end loop;

  v_old_total := v_res.total_amount;
  update hoteles.reservation
     set check_in_date = p_new_check_in, check_out_date = p_new_check_out, total_amount = p_new_total, updated_at = now()
   where id = v_res.id;

  insert into hoteles.reservation_date_change
    (organization_id, property_id, reservation_id, old_check_in, old_check_out, new_check_in, new_check_out, old_total, new_total, penalty_amount, reason, changed_by)
  values (v_res.organization_id, v_res.property_id, v_res.id, v_res.check_in_date, v_res.check_out_date, p_new_check_in, p_new_check_out, v_old_total, p_new_total, v_penalty, v_reason, auth.uid());

  return query select v_res.id, v_res.check_in_date, v_res.check_out_date, p_new_check_in, p_new_check_out, p_new_total, v_released, v_booked, v_penalty;
end;
$$;
revoke all on function hoteles.change_reservation_dates(uuid, date, date, date, date, numeric, numeric, text) from public, anon;
grant execute on function hoteles.change_reservation_dates(uuid, date, date, date, date, numeric, numeric, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) H-12 Lista de espera: hoteles.waitlist_entry.
--    estados: activa -> ofrecida | cancelada ; ofrecida -> aceptada | expirada | cancelada.
--    Seguridad:
--      * RLS: select/insert/update solo para el staff que administra reservas de la property (can_manage_reservations); sin
--        policy de delete. Ningun GRANT a anon.
--      * GRANT a nivel COLUMNA: INSERT solo de los campos que captura el staff (property, tipo, fechas, huespedes, nombre,
--        contacto, notas); UPDATE solo de `status`, `offer_expires_at` y `reservation_id` (lo unico que escriben las rutas).
--        organization_id, offered_at/offered_by, created_by y las marcas de tiempo los fija el trigger: nunca el cliente.
--      * El trigger de insercion deriva organization_id de la property y exige que el tipo de habitacion sea de ESA
--        property (cross-tenant -> 22023); el trigger de actualizacion valida la transicion, que una oferta lleve vencimiento
--        entre ahora y 7 dias, que solo se marque `expirada` una oferta ya vencida, y que `aceptada` apunte a una reserva de
--        la misma property.
--      * Minimizacion: solo nombre y un contacto (telefono o correo); ningun documento ni dato de pago.
-- ---------------------------------------------------------------------------
create table hoteles.waitlist_entry (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  room_type_id uuid not null references hoteles.room_type(id) on delete cascade,
  check_in_date date not null,
  check_out_date date not null,
  guests integer not null default 1 check (guests between 1 and 20),
  guest_name text not null check (char_length(btrim(guest_name)) between 2 and 120),
  contact_phone text check (contact_phone is null or char_length(contact_phone) between 7 and 20),
  contact_email text check (contact_email is null or (char_length(contact_email) between 5 and 160 and contact_email like '%_@_%')),
  notes text check (notes is null or char_length(notes) <= 300),
  status text not null default 'activa' check (status in ('activa', 'ofrecida', 'aceptada', 'expirada', 'cancelada')),
  offered_at timestamptz,
  offered_by uuid references core.staff_user(id) on delete set null,
  offer_expires_at timestamptz,
  -- Sin ON DELETE explicito (NO ACTION): borrar directo una reserva ya ligada a una entrada aceptada se rechaza; el borrado
  -- en cascada de property/organization si procede porque la entrada tambien se borra en la misma sentencia.
  reservation_id uuid references hoteles.reservation(id),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (check_out_date > check_in_date and check_out_date - check_in_date <= 60),
  check (contact_phone is not null or contact_email is not null),
  check (status <> 'ofrecida' or offer_expires_at is not null),
  check ((status = 'aceptada') = (reservation_id is not null))
);
create index waitlist_entry_property_status_idx on hoteles.waitlist_entry (property_id, status, created_at);
create index waitlist_entry_room_type_idx on hoteles.waitlist_entry (property_id, room_type_id, status, check_in_date);

create or replace function hoteles.waitlist_entry_before_insert()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
begin
  select p.organization_id into v_org from core.property p where p.id = new.property_id;
  if v_org is null then
    raise exception 'property no encontrada' using errcode = '22023';
  end if;
  if not exists (select 1 from hoteles.room_type t where t.id = new.room_type_id and t.property_id = new.property_id) then
    raise exception 'el tipo de habitacion no pertenece a esta property' using errcode = '22023';
  end if;
  if new.status <> 'activa' or new.offer_expires_at is not null or new.reservation_id is not null then
    raise exception 'una entrada nueva nace activa' using errcode = '22023';
  end if;
  new.organization_id := v_org;
  new.created_by := auth.uid();
  new.offered_at := null;
  new.offered_by := null;
  new.created_at := now();
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function hoteles.waitlist_entry_before_insert() from public, anon;
create trigger waitlist_entry_before_insert_trg
  before insert on hoteles.waitlist_entry
  for each row execute function hoteles.waitlist_entry_before_insert();

create or replace function hoteles.waitlist_entry_before_update()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  if new.status = old.status then
    -- Sin cambio de estado no se permite tocar la oferta ni la reserva.
    if new.offer_expires_at is distinct from old.offer_expires_at or new.reservation_id is distinct from old.reservation_id then
      raise exception 'solo se modifica la oferta al cambiar de estado' using errcode = '22023';
    end if;
    return new;
  end if;
  if not ((old.status = 'activa' and new.status in ('ofrecida', 'cancelada'))
       or (old.status = 'ofrecida' and new.status in ('aceptada', 'expirada', 'cancelada'))) then
    raise exception 'transicion_invalida: % -> %', old.status, new.status using errcode = '55000';
  end if;
  if new.status = 'ofrecida' then
    if new.offer_expires_at is null or new.offer_expires_at <= now() or new.offer_expires_at > now() + interval '7 days' then
      raise exception 'la oferta debe vencer entre ahora y 7 dias' using errcode = '22023';
    end if;
    new.offered_at := now();
    new.offered_by := auth.uid();
  elsif new.status = 'expirada' then
    if old.offer_expires_at is null or old.offer_expires_at > now() then
      raise exception 'oferta_vigente: la oferta aun no vence' using errcode = '55000';
    end if;
  elsif new.status = 'aceptada' then
    if old.offer_expires_at is null or old.offer_expires_at <= now() then
      raise exception 'oferta_vencida: la oferta ya vencio' using errcode = '55000';
    end if;
    if not exists (select 1 from hoteles.reservation r where r.id = new.reservation_id and r.property_id = old.property_id) then
      raise exception 'la reserva no pertenece a esta property' using errcode = '22023';
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
revoke all on function hoteles.waitlist_entry_before_update() from public, anon;
create trigger waitlist_entry_before_update_trg
  before update on hoteles.waitlist_entry
  for each row execute function hoteles.waitlist_entry_before_update();

alter table hoteles.waitlist_entry enable row level security;
create policy "lista de espera: staff de reservas ve" on hoteles.waitlist_entry for select
  using (hoteles.can_manage_reservations(property_id));
create policy "lista de espera: staff de reservas agrega" on hoteles.waitlist_entry for insert
  with check (hoteles.can_manage_reservations(property_id));
create policy "lista de espera: staff de reservas actualiza" on hoteles.waitlist_entry for update
  using (hoteles.can_manage_reservations(property_id)) with check (hoteles.can_manage_reservations(property_id));

revoke all on hoteles.waitlist_entry from public, anon, authenticated;
grant select on hoteles.waitlist_entry to authenticated;
grant insert (property_id, room_type_id, check_in_date, check_out_date, guests, guest_name, contact_phone, contact_email, notes)
  on hoteles.waitlist_entry to authenticated;
grant update (status, offer_expires_at, reservation_id) on hoteles.waitlist_entry to authenticated;
grant select, insert, update on hoteles.waitlist_entry to service_role;
