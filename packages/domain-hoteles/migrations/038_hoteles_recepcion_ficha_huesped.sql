-- H-27 / H-28 (P1) hoteles -- RECEPCION y FICHA DE HUESPED.
--
-- Que agrega (expand-only: solo objetos nuevos, no toca ninguna tabla existente):
--   1) hoteles.guest_note: notas y preferencias del huesped (CRM), con minimizacion de datos y respeto a ARCO.
--   2) hoteles.reservation_room_change: bitacora append-only de asignaciones / cambios de habitacion.
--   3) hoteles.change_reservation_room(): asignar o cambiar la habitacion fisica de una reserva de forma ATOMICA
--      (sin traslape con otra reserva activa, misma categoria, habitacion apta) y con bitacora.
--   4) hoteles.guest_has_arco_restriction(): bandera booleana (sin detalle) para que recepcion sepa si el huesped
--      tiene una solicitud ARCO de cancelacion/oposicion en curso, sin dar acceso a la tabla ARCO (solo owner/gm).
--
-- Principio: la base es la autoridad. guest_note solo se escribe con GRANT de COLUMNA; la bitacora de cambios de
-- habitacion NO tiene escritura para authenticated (solo la funcion security definer de abajo).
-- Reutiliza (no duplica): hoteles.can_manage_reservations (005), hoteles.agent_vertical_role (035),
-- hoteles.room / hoteles.reservation (001/018), hoteles.room_out_of_service (033), hoteles.arco_request (032).
-- Requiere: 001, 005, 018, 032, 033, 035.
--
-- REGLA DE COMPATIBILIDAD CON LA BASE SIN MIGRAR: el codigo TypeScript que llama a estos objetos captura SQLSTATE
-- 42P01/42883/42703 dentro de un SAVEPOINT y degrada a "no disponible aun" o al camino anterior (nunca un 500).

-- ---------------------------------------------------------------------------
-- 1) hoteles.guest_note
--    Seguridad: RLS habilitada; select/insert/update SOLO para quien puede gestionar reservas de la property
--    (owner/gm/frontdesk/reservations; housekeeping, mantenimiento, F&B y contabilidad no ven el CRM).
--    GRANT de COLUMNA: insert solo (property_id, guest_id, kind, body); update solo (archived_at). El trigger deriva
--    organization_id/created_by/created_at (el cliente no los manda) y exige que el huesped sea de la property.
--    Minimizacion: la nota es texto corto (<= 500) y se rechaza si contiene una secuencia de 13 a 19 digitos
--    (numero de tarjeta o documento de identidad): la identidad vive SOLO en la boveda (031), nunca en una nota.
--    ARCO: mientras el huesped tenga una solicitud de cancelacion u oposicion no improcedente, no se agregan notas.
--    Sin DELETE: una nota se ARCHIVA (historial auditable).
-- ---------------------------------------------------------------------------
create table hoteles.guest_note (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  guest_id uuid not null references hoteles.guest(id) on delete cascade,
  kind text not null check (kind in ('nota', 'preferencia')),
  body text not null check (length(btrim(body)) between 1 and 500),
  created_by uuid references core.staff_user(id),
  created_at timestamptz not null default now(),
  archived_at timestamptz,
  archived_by uuid references core.staff_user(id),
  check ((archived_at is null and archived_by is null) or (archived_at is not null))
);
create index guest_note_guest_idx on hoteles.guest_note (guest_id, created_at desc) where archived_at is null;
create index guest_note_property_idx on hoteles.guest_note (property_id);

create or replace function hoteles.guest_note_guard()
returns trigger language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_guest_property uuid;
begin
  if TG_OP = 'INSERT' then
    if auth.uid() is null then
      raise exception 'guest_note: requiere un usuario autenticado' using errcode = '42501';
    end if;
    select organization_id into v_org from core.property where id = new.property_id;
    if v_org is null then
      raise exception 'property_invalida: la property % no existe', new.property_id using errcode = '23503';
    end if;
    select property_id into v_guest_property from hoteles.guest where id = new.guest_id;
    if v_guest_property is distinct from new.property_id then
      raise exception 'guest_invalido: el huesped no pertenece a la property' using errcode = '23503';
    end if;
    if regexp_replace(new.body, '[ -]', '', 'g') ~ '[0-9]{13,19}' then
      raise exception 'nota_con_dato_sensible: no captures numeros de tarjeta ni de documento en una nota' using errcode = '22023';
    end if;
    if exists (
      select 1 from hoteles.arco_request a
      where a.guest_id = new.guest_id and a.right_type in ('cancelacion', 'oposicion') and a.status <> 'improcedente'
    ) then
      raise exception 'arco_en_curso: el huesped ejercio cancelacion u oposicion; no se agregan datos personales' using errcode = '55000';
    end if;
    new.organization_id := v_org;
    new.created_by := auth.uid();
    new.created_at := now();
    new.archived_at := null;
    new.archived_by := null;
    return new;
  end if;
  -- UPDATE: solo archivar, una vez; todo lo demas es inmutable.
  if old.archived_at is not null
     or new.archived_at is null
     or new.id is distinct from old.id
     or new.organization_id is distinct from old.organization_id
     or new.property_id is distinct from old.property_id
     or new.guest_id is distinct from old.guest_id
     or new.kind is distinct from old.kind
     or new.body is distinct from old.body
     or new.created_by is distinct from old.created_by
     or new.created_at is distinct from old.created_at then
    raise exception 'guest_note: solo se puede archivar una nota activa' using errcode = '42501';
  end if;
  new.archived_at := now();
  new.archived_by := auth.uid();
  return new;
end;
$$;
revoke all on function hoteles.guest_note_guard() from public, anon;

create trigger guest_note_guard_trg
  before insert or update on hoteles.guest_note
  for each row execute function hoteles.guest_note_guard();

alter table hoteles.guest_note enable row level security;
create policy "crm: staff de reservas ve notas del huesped" on hoteles.guest_note for select
  using (hoteles.can_manage_reservations(property_id));
create policy "crm: staff de reservas agrega notas" on hoteles.guest_note for insert
  with check (hoteles.can_manage_reservations(property_id));
create policy "crm: staff de reservas archiva notas" on hoteles.guest_note for update
  using (hoteles.can_manage_reservations(property_id)) with check (hoteles.can_manage_reservations(property_id));

revoke all on hoteles.guest_note from public, anon;
grant select on hoteles.guest_note to authenticated;
grant insert (property_id, guest_id, kind, body) on hoteles.guest_note to authenticated;
grant update (archived_at) on hoteles.guest_note to authenticated;
grant select, insert, update, delete on hoteles.guest_note to service_role;

-- ---------------------------------------------------------------------------
-- 2) hoteles.reservation_room_change (append-only)
--    Seguridad: sin INSERT/UPDATE/DELETE para authenticated; la escribe solo hoteles.change_reservation_room.
--    Un trigger impide UPDATE/DELETE directos incluso a un rol con privilegios (es evidencia operativa); solo deja pasar las
--    acciones referenciales en cascada de las FK (ver la funcion).
-- ---------------------------------------------------------------------------
create table hoteles.reservation_room_change (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  property_id uuid not null references core.property(id) on delete cascade,
  reservation_id uuid not null references hoteles.reservation(id) on delete cascade,
  from_room_id uuid references hoteles.room(id) on delete set null,
  to_room_id uuid references hoteles.room(id) on delete set null,
  reason text check (reason is null or length(btrim(reason)) between 3 and 200),
  changed_by uuid references core.staff_user(id),
  created_at timestamptz not null default now()
);
create index reservation_room_change_res_idx on hoteles.reservation_room_change (reservation_id, created_at desc);
create index reservation_room_change_property_idx on hoteles.reservation_room_change (property_id, created_at desc);

create or replace function hoteles.reservation_room_change_immutable()
returns trigger language plpgsql set search_path = hoteles, pg_temp as $$
begin
  -- Seguridad / disponibilidad: las FK de esta tabla son ON DELETE CASCADE (organization, property, reservation) y ON DELETE SET NULL
  -- (room, que dispara un UPDATE). Esas acciones referenciales corren como trigger anidado (pg_trigger_depth() > 1) y deben poder
  -- completarse: si no, con UNA fila de bitacora ya no se podria borrar una reserva, habitacion, property ni dar de baja un tenant.
  -- Un UPDATE/DELETE directo (profundidad 1) sigue prohibido incluso al superusuario.
  if pg_trigger_depth() > 1 then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  raise exception 'reservation_room_change es append-only' using errcode = '42501';
end;
$$;
revoke all on function hoteles.reservation_room_change_immutable() from public, anon;
create trigger reservation_room_change_no_update_trg
  before update or delete on hoteles.reservation_room_change
  for each row execute function hoteles.reservation_room_change_immutable();

alter table hoteles.reservation_room_change enable row level security;
create policy "recepcion: staff de reservas ve cambios de habitacion" on hoteles.reservation_room_change for select
  using (hoteles.can_manage_reservations(property_id));
revoke all on hoteles.reservation_room_change from public, anon;
grant select on hoteles.reservation_room_change to authenticated;
grant select, insert on hoteles.reservation_room_change to service_role;

-- ---------------------------------------------------------------------------
-- 3) hoteles.change_reservation_room(reserva, habitacion nueva, motivo)
--    Seguridad: security definer con search_path fijo (core, hoteles, pg_temp) porque actualiza reservation.room_id y
--    room.status sin dar UPDATE de esas columnas al cliente; exige auth.uid() (la sesion de sistema NO la ejecuta) y
--    rol owner/gm/frontdesk leido de core.membership (jamas de un parametro). Revocada a public/anon.
--    Reglas: la reserva debe estar confirmada / en check_in / en_estancia; la habitacion destino es de la MISMA
--    property y del MISMO tipo que la reserva (no se mueve inventario por tipo: un cambio de categoria es una
--    reserva nueva); no puede estar fuera de servicio (marca ni inhabilitacion activa), sucia u ocupada cuando el
--    huesped ya esta en casa; y NINGUNA otra reserva activa (confirmada/check_in/en_estancia) puede traslapar sus
--    fechas en esa habitacion. El advisory lock por habitacion serializa dos asignaciones concurrentes. Si la
--    reserva ya estaba en casa, la habitacion anterior queda `sucia` para limpieza y la nueva `ocupada`.
-- ---------------------------------------------------------------------------
create or replace function hoteles.change_reservation_room(p_reservation_id uuid, p_new_room_id uuid, p_reason text default null)
returns table (reservation_id uuid, from_room_id uuid, to_room_id uuid)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_res record;
  v_room record;
  v_role text;
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

  select r.id, r.organization_id, r.property_id, r.room_type_id, r.room_id, r.status, r.check_in_date, r.check_out_date
    into v_res from hoteles.reservation r where r.id = p_reservation_id for update;
  if v_res.id is null then
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  v_role := hoteles.agent_vertical_role(v_res.property_id);
  if v_role is null then
    -- Sin membresia en la property: indistinguible de "no existe" (no se filtra la existencia entre tenants).
    raise exception 'reserva no encontrada' using errcode = 'P0002';
  end if;
  if v_role not in ('owner', 'gm', 'frontdesk') then
    raise exception 'rol sin permiso para asignar habitaciones' using errcode = '42501';
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
    -- Huesped en casa: la habitacion anterior queda sucia y la nueva ocupada (la nueva ya se valido `disponible` arriba).
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
-- 4) hoteles.guest_has_arco_restriction(huesped)
--    Seguridad: security definer con search_path fijo porque arco_request solo es legible por owner/gm; devuelve UN
--    booleano (jamas el detalle de la solicitud) y solo a quien puede gestionar reservas de la property del huesped
--    (para cualquier otro caso, falso: no filtra la existencia de huespedes ajenos). Revocada a public/anon.
-- ---------------------------------------------------------------------------
create or replace function hoteles.guest_has_arco_restriction(p_guest_id uuid)
returns boolean language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_property uuid;
begin
  if auth.uid() is null or p_guest_id is null then
    return false;
  end if;
  select property_id into v_property from hoteles.guest where id = p_guest_id;
  if v_property is null or not hoteles.can_manage_reservations(v_property) then
    return false;
  end if;
  return exists (
    select 1 from hoteles.arco_request a
    where a.guest_id = p_guest_id and a.right_type in ('cancelacion', 'oposicion') and a.status <> 'improcedente'
  );
end;
$$;
revoke all on function hoteles.guest_has_arco_restriction(uuid) from public, anon;
grant execute on function hoteles.guest_has_arco_restriction(uuid) to authenticated;
