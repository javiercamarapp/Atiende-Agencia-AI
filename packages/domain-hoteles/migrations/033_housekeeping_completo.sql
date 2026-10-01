-- H-04 (P0) hoteles -- HOUSEKEEPING COMPLETO: tareas de limpieza por habitacion
-- (iniciar / terminar / inspeccionar), habitaciones fuera de servicio / fuera de orden
-- y el estado de limpieza de `hoteles.room.status`. Extiende (no duplica) lo que ya
-- existe desde 009_housekeeping_mantenimiento_turnos.sql (`hoteles.housekeeping_shift`
-- = turnos LFT; `hoteles.maintenance_ticket` = mantenimiento correctivo): el estado de
-- la habitacion sigue siendo UNA sola fuente de verdad (`hoteles.room.status`, 001).
-- Esta migracion agrega DONDE se guarda el trabajo de limpieza y las inhabilitaciones.
--
-- Requiere: 001 (hoteles.room, core.staff_user, core.has_property_access()),
-- 009 (hoteles.maintenance_ticket, para enlazar una inhabilitacion con su ticket).
--
-- Reparto de autoridad (mismo criterio que 009/018): RLS = "perteneces a esta property"
-- + un helper SQL por rol FINO (defensa en profundidad si alguien le pega a PostgREST
-- directo); el filtrado fino por accion vive ADEMAS en apps/api (assertVerticalRole,
-- domain-hoteles/src/roles.ts). Si el espejo de la app se desincroniza, la peor
-- consecuencia es un 403 de mas, nunca un acceso de mas.

-- ---------------------------------------------------------------------------
-- 0) Llave unica (id, property_id) en hoteles.room para poder referenciar a la
--    habitacion Y a su property en una sola FK compuesta (garantiza que una tarea o
--    una inhabilitacion NUNCA apunte a una habitacion de OTRA property). `id` ya es PK,
--    asi que la unicidad es trivialmente cierta: no puede fallar sobre datos reales.
-- ---------------------------------------------------------------------------
alter table hoteles.room add constraint room_id_property_unique unique (id, property_id);

-- ---------------------------------------------------------------------------
-- 1) Helpers de rol (security definer, search_path fijo, mismo cuerpo que
--    hoteles.can_manage_catalog() de 018). Un helper por conjunto de roles:
--      can_work_housekeeping : owner, gm, frontdesk, housekeeping  (crear/asignar/
--                              iniciar/terminar/inspeccionar tareas de limpieza)
--      can_set_room_out_of_service : owner, gm, frontdesk, maintenance (inhabilitar /
--                              rehabilitar una habitacion; mantenimiento la pone y la
--                              libera, housekeeping NO decide inhabilitar)
--      can_update_room_status : union de ambos + nadie mas (cambio de room.status)
--    Justificacion de seguridad: el rol sale de core.membership (autoridad unica),
--    nunca de un parametro del cliente; los tres revocan EXECUTE de public/anon.
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_work_housekeeping(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'housekeeping')
  )
$$;

create or replace function hoteles.can_set_room_out_of_service(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'maintenance')
  )
$$;

create or replace function hoteles.can_update_room_status(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'housekeeping', 'maintenance')
  )
$$;

revoke all on function hoteles.can_work_housekeeping(uuid) from public, anon;
revoke all on function hoteles.can_set_room_out_of_service(uuid) from public, anon;
revoke all on function hoteles.can_update_room_status(uuid) from public, anon;
grant execute on function hoteles.can_work_housekeeping(uuid) to authenticated, service_role;
grant execute on function hoteles.can_set_room_out_of_service(uuid) to authenticated, service_role;
grant execute on function hoteles.can_update_room_status(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Tareas de limpieza por habitacion (REQ-HK tablero/tareas/inspeccion).
--    Ciclo: pendiente -> en_progreso -> terminada (espera inspeccion) ->
--    inspeccionada (aprobada, habitacion liberada). Una inspeccion RECHAZADA devuelve
--    la tarea a `pendiente` con inspection_result = 'rechazada' y rejections + 1.
--    `cancelada` = ya no hace falta (p. ej. se inhabilito la habitacion).
-- ---------------------------------------------------------------------------
create table hoteles.housekeeping_task (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  room_id uuid not null,
  task_type text not null default 'salida' check (task_type in ('salida', 'estancia', 'profunda', 'repaso')),
  status text not null default 'pendiente' check (status in ('pendiente', 'en_progreso', 'terminada', 'inspeccionada', 'cancelada')),
  priority text not null default 'normal' check (priority in ('normal', 'alta')),
  work_date date not null,
  assigned_to uuid references core.staff_user(id) on delete set null,
  notes text check (notes is null or length(notes) <= 500),
  started_at timestamptz,
  finished_at timestamptz,
  inspection_result text check (inspection_result is null or inspection_result in ('aprobada', 'rechazada')),
  inspected_by uuid references core.staff_user(id) on delete set null,
  inspected_at timestamptz,
  inspection_note text check (inspection_note is null or length(inspection_note) <= 500),
  rejections integer not null default 0 check (rejections >= 0),
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint housekeeping_task_room_fk foreign key (room_id, property_id) references hoteles.room(id, property_id) on delete cascade,
  -- Una tarea solo queda `inspeccionada` con un resultado `aprobada` (y viceversa).
  constraint housekeeping_task_inspection_consistency check ((status = 'inspeccionada') = (coalesce(inspection_result, '') = 'aprobada')),
  -- `terminada`/`inspeccionada` siempre traen la hora real de termino.
  constraint housekeeping_task_finished_consistency check (status not in ('terminada', 'inspeccionada') or finished_at is not null),
  -- Separacion de funciones: quien limpio no inspecciona su propio trabajo.
  constraint housekeeping_task_inspector_not_assignee check (inspected_by is null or assigned_to is null or inspected_by <> assigned_to)
);
create index housekeeping_task_property_date_idx on hoteles.housekeeping_task (property_id, work_date, status);
create index housekeeping_task_room_idx on hoteles.housekeeping_task (room_id);
create index housekeeping_task_assignee_idx on hoteles.housekeeping_task (assigned_to, work_date) where assigned_to is not null;
-- Una sola tarea ACTIVA por (habitacion, dia, tipo): generar el dia dos veces es idempotente.
create unique index housekeeping_task_one_active_idx on hoteles.housekeeping_task (room_id, work_date, task_type) where status <> 'cancelada';

-- ---------------------------------------------------------------------------
-- 3) Habitaciones fuera de servicio / fuera de orden. `kind`: fuera_de_orden =
--    inhabilitada por falla (no vendible, no limpiable); fuera_de_servicio = retirada
--    por decision operativa (renovacion, bloqueo). Un solo registro ACTIVO por
--    habitacion. Al cerrarlo la habitacion regresa a `sucia` (debe limpiarse e
--    inspeccionarse antes de venderse), nunca directo a `disponible`.
-- ---------------------------------------------------------------------------
create table hoteles.room_out_of_service (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  room_id uuid not null,
  kind text not null default 'fuera_de_servicio' check (kind in ('fuera_de_servicio', 'fuera_de_orden')),
  reason text not null check (length(reason) between 3 and 300),
  from_date date not null,
  expected_return_date date,
  status text not null default 'activo' check (status in ('activo', 'cerrado')),
  maintenance_ticket_id uuid references hoteles.maintenance_ticket(id) on delete set null,
  created_by uuid references core.staff_user(id) on delete set null,
  closed_by uuid references core.staff_user(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  constraint room_out_of_service_room_fk foreign key (room_id, property_id) references hoteles.room(id, property_id) on delete cascade,
  constraint room_out_of_service_dates check (expected_return_date is null or expected_return_date >= from_date),
  constraint room_out_of_service_closed_consistency check ((status = 'cerrado') = (closed_at is not null))
);
create index room_out_of_service_property_idx on hoteles.room_out_of_service (property_id, status);
create unique index room_out_of_service_one_active_idx on hoteles.room_out_of_service (room_id) where status = 'activo';

-- ---------------------------------------------------------------------------
-- 4) Trigger de integridad (ambas tablas). Justificacion de seguridad: la policy
--    de INSERT solo mira property_id y el GRANT de columna ya impide al cliente mandar
--    organization_id; por defensa en profundidad (un GRANT futuro, service_role) el
--    valor se DERIVA de core.property y se sobrescribe -- ninguna fila puede quedar con
--    la organizacion de otro tenant. Ademas, el responsable asignado
--    (`assigned_to`) debe ser staff DE ESA property (core.has_property_access):
--    asignar a alguien de otra organizacion fallaria con 23514. security definer +
--    search_path fijo porque core.property no es legible por el rol del cliente.
-- ---------------------------------------------------------------------------
create or replace function hoteles.housekeeping_derive_org()
returns trigger language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_org uuid;
begin
  select organization_id into v_org from core.property where id = new.property_id;
  if v_org is null then
    raise exception 'property inexistente' using errcode = '23503';
  end if;
  new.organization_id := v_org;
  return new;
end;
$$;

-- Funcion aparte para la tarea (plpgsql NO hace cortocircuito al resolver `new.assigned_to`:
-- una sola funcion compartida con room_out_of_service, que no tiene esa columna, fallaria).
create or replace function hoteles.housekeeping_task_check_assignee()
returns trigger language plpgsql security definer set search_path = core, hoteles as $$
begin
  if new.assigned_to is not null
     and (tg_op = 'INSERT' or new.assigned_to is distinct from old.assigned_to)
     and not core.has_property_access(new.assigned_to, new.property_id) then
    raise exception 'assigned_to no es staff de esta property' using errcode = '23514';
  end if;
  return new;
end;
$$;
revoke all on function hoteles.housekeeping_derive_org() from public, anon;
revoke all on function hoteles.housekeeping_task_check_assignee() from public, anon;

create trigger housekeeping_task_derive_org before insert or update of property_id on hoteles.housekeeping_task
  for each row execute function hoteles.housekeeping_derive_org();
create trigger housekeeping_task_check_assignee before insert or update of assigned_to on hoteles.housekeeping_task
  for each row execute function hoteles.housekeeping_task_check_assignee();
create trigger room_out_of_service_derive_org before insert on hoteles.room_out_of_service
  for each row execute function hoteles.housekeeping_derive_org();

-- ---------------------------------------------------------------------------
-- 5) RLS + GRANTs. Sin `using (true)`, sin GRANT a anon, sin DELETE para authenticated
--    (una tarea se CANCELA, una inhabilitacion se CIERRA: historial auditable).
--    GRANT de UPDATE a nivel de COLUMNA: solo las columnas que las rutas reales
--    escriben (iniciar/terminar/inspeccionar/asignar/cancelar, cerrar inhabilitacion);
--    `room_id`, `property_id`, `organization_id`, `work_date`, `created_*` quedan
--    inmutables para el cliente.
-- ---------------------------------------------------------------------------
alter table hoteles.housekeeping_task enable row level security;
alter table hoteles.room_out_of_service enable row level security;

create policy "staff ve tareas de housekeeping de su property" on hoteles.housekeeping_task for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "housekeeping: staff autorizado crea tareas" on hoteles.housekeeping_task for insert
  with check (hoteles.can_work_housekeeping(property_id));
create policy "housekeeping: staff autorizado actualiza tareas" on hoteles.housekeeping_task for update
  using (hoteles.can_work_housekeeping(property_id)) with check (hoteles.can_work_housekeeping(property_id));

create policy "staff ve habitaciones fuera de servicio de su property" on hoteles.room_out_of_service for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "fuera de servicio: staff autorizado inhabilita" on hoteles.room_out_of_service for insert
  with check (hoteles.can_set_room_out_of_service(property_id));
create policy "fuera de servicio: staff autorizado rehabilita" on hoteles.room_out_of_service for update
  using (hoteles.can_set_room_out_of_service(property_id)) with check (hoteles.can_set_room_out_of_service(property_id));

-- Estado de la habitacion: hasta hoy `hoteles.room` era solo SELECT/INSERT para
-- authenticated (001/018) y NADIE podia mover su estado. Se otorga UPDATE SOLO de la
-- columna `status` (el CHECK de 001 ya limita los valores) con una policy por rol fino.
create policy "housekeeping: staff autorizado actualiza estado de habitacion" on hoteles.room for update
  using (hoteles.can_update_room_status(property_id)) with check (hoteles.can_update_room_status(property_id));

revoke all on hoteles.housekeeping_task, hoteles.room_out_of_service from public, anon;
grant select on hoteles.housekeeping_task, hoteles.room_out_of_service to authenticated;
grant insert (property_id, room_id, task_type, priority, work_date, assigned_to, notes, created_by) on hoteles.housekeeping_task to authenticated;
grant update (status, priority, assigned_to, notes, started_at, finished_at, inspection_result, inspected_by, inspected_at, inspection_note, rejections, updated_at)
  on hoteles.housekeeping_task to authenticated;
grant insert (property_id, room_id, kind, reason, from_date, expected_return_date, maintenance_ticket_id, created_by) on hoteles.room_out_of_service to authenticated;
grant update (status, expected_return_date, closed_by, closed_at) on hoteles.room_out_of_service to authenticated;
grant update (status) on hoteles.room to authenticated;
grant select, insert, update, delete on hoteles.housekeeping_task, hoteles.room_out_of_service to service_role;
