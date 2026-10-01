-- H-05 (P0) hoteles -- TICKETS DE HUESPED con SLA, escalacion automatica a gerente,
-- bitacora y creacion desde resenas. Port (adaptado a core.organization/core.property)
-- del `guest_ticket` + `ticket_sla_policy` del repo suelto atiende-hoteles
-- (0098_guest_ticket_sla_escalacion.sql / 0128_guest_ticket_sla_warning.sql).
--
-- Es una tabla NUEVA y separada de `hoteles.maintenance_ticket` (009: flujo correctivo con
-- costo) y de `hoteles.housekeeping_task` (033): esta es la capa de TRIAGE de una peticion
-- o queja del huesped (por cualquier canal: staff, QR, WhatsApp, voz, o una resena
-- negativa, `hoteles.guest_review` de 013) con departamento, habitacion, prioridad,
-- responsable y SLA.
--
-- Requiere: 001 (core.*, hoteles.room), 013 (hoteles.guest_review), 033 (la llave unica
-- (id, property_id) de hoteles.room, `room_id_property_unique`).
-- Expand-only: la unica sentencia sobre una tabla existente es una llave unica
-- (id, property_id) en hoteles.guest_review, trivialmente cierta porque `id` ya es PK.
--
-- Reparto de autoridad (mismo criterio que 033): RLS = rol FINO por helper SQL (defensa en
-- profundidad si alguien le pega a PostgREST directo) + el mismo filtrado en apps/api
-- (assertVerticalRole). Si el espejo de la app se desincroniza, la peor consecuencia es un
-- 403 de mas, nunca un acceso de mas.

-- ---------------------------------------------------------------------------
-- 0) Llave unica (id, property_id) en hoteles.guest_review para poder enlazar una
--    resena Y su property en una sola FK compuesta: un ticket NUNCA apunta a una resena
--    de OTRA property.
-- ---------------------------------------------------------------------------
alter table hoteles.guest_review add constraint guest_review_id_property_unique unique (id, property_id);

-- ---------------------------------------------------------------------------
-- 1) Helpers de rol (security definer, search_path fijo, mismo cuerpo que
--    hoteles.can_work_housekeeping() de 033). El rol sale de core.membership (autoridad
--    unica), nunca de un parametro del cliente; todos revocan EXECUTE de public/anon.
--      guest_ticket_role           : rol vertical del llamador en la property (o null).
--      can_manage_guest_tickets    : owner, gm, frontdesk (ven y administran TODOS los
--                                    tickets de la property; reasignan departamento).
--      can_create_guest_ticket     : cualquiera de los 8 roles hoteleros (quien contesta
--                                    la peticion del huesped puede ser cualquier area).
--      guest_ticket_visible        : manager, o el departamento del ticket, o el
--                                    responsable asignado, o quien lo reporto.
--      can_write_ticket_sla_policy : owner, gm (el SLA es una decision de negocio).
-- ---------------------------------------------------------------------------
create or replace function hoteles.guest_ticket_role(_property_id uuid)
returns text language sql stable security definer set search_path = core, hoteles as $$
  select m.vertical_role from core.membership m
  join core.property p on p.organization_id = m.organization_id
  where m.user_id = auth.uid() and p.id = _property_id
    and (m.property_ids is null or _property_id = any(m.property_ids))
  limit 1
$$;

create or replace function hoteles.can_manage_guest_tickets(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk')
  )
$$;

create or replace function hoteles.can_create_guest_ticket(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant')
  )
$$;

create or replace function hoteles.guest_ticket_visible(_property_id uuid, _department text, _assigned_to uuid, _created_by uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and (
        m.vertical_role in ('owner', 'gm', 'frontdesk')
        or m.vertical_role = _department
        or _assigned_to = auth.uid()
        or _created_by = auth.uid()
      )
  )
$$;

create or replace function hoteles.can_write_ticket_sla_policy(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm')
  )
$$;

revoke all on function hoteles.guest_ticket_role(uuid) from public, anon;
revoke all on function hoteles.can_manage_guest_tickets(uuid) from public, anon;
revoke all on function hoteles.can_create_guest_ticket(uuid) from public, anon;
revoke all on function hoteles.guest_ticket_visible(uuid, text, uuid, uuid) from public, anon;
revoke all on function hoteles.can_write_ticket_sla_policy(uuid) from public, anon;
grant execute on function hoteles.guest_ticket_role(uuid) to authenticated, service_role;
grant execute on function hoteles.can_manage_guest_tickets(uuid) to authenticated, service_role;
grant execute on function hoteles.can_create_guest_ticket(uuid) to authenticated, service_role;
grant execute on function hoteles.guest_ticket_visible(uuid, text, uuid, uuid) to authenticated, service_role;
grant execute on function hoteles.can_write_ticket_sla_policy(uuid) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 2) Politica de SLA configurable por property: una fila por (departamento, prioridad)
--    que sobreescribe el SLA por defecto de la aplicacion
--    (packages/domain-hoteles/src/tickets/sla.ts). Sin fila -> el default por prioridad.
-- ---------------------------------------------------------------------------
create table hoteles.ticket_sla_policy (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  department text not null check (department in ('owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant')),
  priority text not null check (priority in ('alta', 'media', 'baja')),
  sla_minutes integer not null check (sla_minutes between 1 and 43200),
  updated_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, department, priority)
);
create index ticket_sla_policy_property_idx on hoteles.ticket_sla_policy (property_id);

-- ---------------------------------------------------------------------------
-- 3) Ticket de huesped. Ciclo: abierto -> en_progreso -> cerrado; al vencer el SLA sin
--    cierre pasa a `escalado` (sube a gerente/dueno, `escalated_to_roles`), desde donde
--    aun puede volver a en_progreso o cerrarse; `cancelado` = ya no hace falta.
--    cerrado/cancelado son terminales (inmutables).
--    El SLA se resuelve y CONGELA al crear (sla_minutes/sla_due_at): cambiar despues la
--    politica nunca mueve el vencimiento de un ticket ya abierto, ni reasignar el
--    departamento reinicia la espera del huesped.
-- ---------------------------------------------------------------------------
create table hoteles.guest_ticket (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  room_id uuid,
  -- Resena que origino el ticket (canal 'resena'); a lo sumo UN ticket activo por resena.
  guest_review_id uuid,
  department text not null check (department in ('owner', 'gm', 'frontdesk', 'reservations', 'housekeeping', 'maintenance', 'fnb', 'accountant')),
  priority text not null default 'media' check (priority in ('alta', 'media', 'baja')),
  status text not null default 'abierto' check (status in ('abierto', 'en_progreso', 'escalado', 'cerrado', 'cancelado')),
  channel text not null default 'staff' check (channel in ('staff', 'qr', 'whatsapp', 'voz', 'resena')),
  guest_message text not null check (length(guest_message) between 1 and 1000),
  sla_minutes integer not null check (sla_minutes between 1 and 43200),
  sla_due_at timestamptz not null,
  assigned_to uuid references core.staff_user(id) on delete set null,
  escalated_at timestamptz,
  escalated_to_roles jsonb not null default '[]'::jsonb,
  -- Aviso temprano al 75% del SLA (distinto de la escalacion al 100%).
  sla_warning_notified_at timestamptz,
  resolution_note text check (resolution_note is null or length(resolution_note) <= 1000),
  closed_at timestamptz,
  created_by uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  -- `on delete set null (col)`: solo se anula la columna del enlace, nunca property_id (NOT NULL).
  constraint guest_ticket_room_fk foreign key (room_id, property_id) references hoteles.room(id, property_id) on delete set null (room_id),
  constraint guest_ticket_review_fk foreign key (guest_review_id, property_id) references hoteles.guest_review(id, property_id) on delete set null (guest_review_id),
  constraint guest_ticket_closed_consistency check ((status in ('cerrado', 'cancelado')) = (closed_at is not null)),
  constraint guest_ticket_escalated_consistency check (status <> 'escalado' or escalated_at is not null),
  constraint guest_ticket_review_channel check (guest_review_id is null or channel = 'resena')
);
create index guest_ticket_property_status_idx on hoteles.guest_ticket (property_id, status, created_at desc);
create index guest_ticket_assignee_idx on hoteles.guest_ticket (assigned_to) where assigned_to is not null;
-- Barrido de SLA (hoteles.sweep_guest_ticket_sla): solo tickets aun sin cierre ni escalar.
create index guest_ticket_open_sla_idx on hoteles.guest_ticket (property_id, sla_due_at) where status in ('abierto', 'en_progreso');
create unique index guest_ticket_one_active_per_review_idx on hoteles.guest_ticket (guest_review_id)
  where guest_review_id is not null and status not in ('cerrado', 'cancelado');

-- Bitacora inmutable del ticket (quien/cuando/que). La escribe SOLO el trigger de abajo
-- (security definer): el cliente no tiene INSERT/UPDATE/DELETE, asi que no puede omitir
-- ni falsificar una entrada. actor_id null = el sistema (barrido de SLA).
create table hoteles.guest_ticket_event (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  ticket_id uuid not null references hoteles.guest_ticket(id) on delete cascade,
  event_type text not null check (event_type in ('creado', 'asignado', 'departamento_cambiado', 'en_progreso', 'aviso_sla', 'escalado', 'cerrado', 'cancelado')),
  actor_id uuid references core.staff_user(id) on delete set null,
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index guest_ticket_event_ticket_idx on hoteles.guest_ticket_event (ticket_id, created_at);

-- ---------------------------------------------------------------------------
-- 4) Triggers de integridad. Justificacion de seguridad: la policy de INSERT solo mira
--    property_id y el GRANT de columna ya impide al cliente mandar organization_id,
--    created_by, sla_due_at o cualquier campo de escalacion; por defensa en profundidad
--    (un GRANT futuro, service_role) esos valores se DERIVAN en el servidor:
--      - organization_id sale de core.property (nunca de otro tenant);
--      - created_by = auth.uid() cuando hay sesion de usuario (no se falsifica autoria);
--      - el SLA se resuelve de ticket_sla_policy si existe (el cliente no lo puede
--        saltar mandando un sla_minutes mas holgado) y sla_due_at = now() + SLA;
--      - el responsable debe ser staff DE ESA property (core.has_property_access);
--      - las transiciones de estado se validan y los terminales son inmutables;
--      - reasignar departamento exige rol de manager (o sistema);
--      - al escalar se fijan escalated_at/escalated_to_roles; al cerrar, closed_at.
--    security definer + search_path fijo porque core.property/core.membership no son
--    legibles por el rol del cliente.
-- ---------------------------------------------------------------------------
create or replace function hoteles.guest_ticket_before_insert()
returns trigger language plpgsql security definer set search_path = core, hoteles as $$
declare
  v_org uuid;
  v_policy integer;
begin
  select organization_id into v_org from core.property where id = new.property_id;
  if v_org is null then
    raise exception 'property inexistente' using errcode = '23503';
  end if;
  new.organization_id := v_org;
  if auth.uid() is not null then
    new.created_by := auth.uid();
  end if;
  if new.assigned_to is not null and not core.has_property_access(new.assigned_to, new.property_id) then
    raise exception 'assigned_to no es staff de esta property' using errcode = '23514';
  end if;
  select sla_minutes into v_policy from hoteles.ticket_sla_policy
   where property_id = new.property_id and department = new.department and priority = new.priority;
  if v_policy is not null then
    new.sla_minutes := v_policy;
  end if;
  new.status := 'abierto';
  new.escalated_at := null;
  new.escalated_to_roles := '[]'::jsonb;
  new.sla_warning_notified_at := null;
  new.closed_at := null;
  new.sla_due_at := now() + new.sla_minutes * interval '1 minute';
  return new;
end;
$$;

create or replace function hoteles.guest_ticket_before_update()
returns trigger language plpgsql security definer set search_path = core, hoteles as $$
begin
  if old.status in ('cerrado', 'cancelado') then
    raise exception 'el ticket ya esta % y no se puede modificar', old.status using errcode = '23514';
  end if;
  if new.status is distinct from old.status and not (
    (old.status = 'abierto' and new.status in ('en_progreso', 'escalado', 'cerrado', 'cancelado'))
    or (old.status = 'en_progreso' and new.status in ('escalado', 'cerrado', 'cancelado'))
    or (old.status = 'escalado' and new.status in ('en_progreso', 'cerrado', 'cancelado'))
  ) then
    raise exception 'transicion de estado invalida: % -> %', old.status, new.status using errcode = '23514';
  end if;
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to
     and not core.has_property_access(new.assigned_to, new.property_id) then
    raise exception 'assigned_to no es staff de esta property' using errcode = '23514';
  end if;
  if new.department is distinct from old.department and auth.uid() is not null
     and not hoteles.can_manage_guest_tickets(new.property_id) then
    raise exception 'solo owner/gm/frontdesk reasignan el departamento' using errcode = '42501';
  end if;
  if new.status = 'escalado' and old.status <> 'escalado' then
    -- El barrido de sistema ya fija escalated_at = su reloj; una escalacion manual usa now().
    if new.escalated_at is not distinct from old.escalated_at then
      new.escalated_at := now();
    end if;
    new.escalated_to_roles := '["gm", "owner"]'::jsonb;
  end if;
  if new.status in ('cerrado', 'cancelado') then
    new.closed_at := now();
  end if;
  new.updated_at := now();
  return new;
end;
$$;

-- Bitacora: una fila por cambio relevante. actor_id = auth.uid() (null en el barrido de sistema).
create or replace function hoteles.guest_ticket_log_event()
returns trigger language plpgsql security definer set search_path = core, hoteles as $$
begin
  if tg_op = 'INSERT' then
    insert into hoteles.guest_ticket_event (organization_id, property_id, ticket_id, event_type, actor_id, detail)
    values (new.organization_id, new.property_id, new.id, 'creado', auth.uid(),
      jsonb_build_object('departamento', new.department, 'prioridad', new.priority, 'canal', new.channel,
                         'slaMinutos', new.sla_minutes, 'asignadoA', new.assigned_to, 'resenaId', new.guest_review_id));
    return new;
  end if;
  if new.status is distinct from old.status then
    insert into hoteles.guest_ticket_event (organization_id, property_id, ticket_id, event_type, actor_id, detail)
    values (new.organization_id, new.property_id, new.id, new.status, auth.uid(),
      case new.status
        when 'escalado' then jsonb_build_object('escaladoARoles', new.escalated_to_roles, 'origen', case when auth.uid() is null then 'sla_vencido' else 'manual' end)
        when 'cerrado' then jsonb_build_object('nota', new.resolution_note)
        else '{}'::jsonb
      end);
  end if;
  if new.assigned_to is distinct from old.assigned_to then
    insert into hoteles.guest_ticket_event (organization_id, property_id, ticket_id, event_type, actor_id, detail)
    values (new.organization_id, new.property_id, new.id, 'asignado', auth.uid(), jsonb_build_object('de', old.assigned_to, 'a', new.assigned_to));
  end if;
  if new.department is distinct from old.department then
    insert into hoteles.guest_ticket_event (organization_id, property_id, ticket_id, event_type, actor_id, detail)
    values (new.organization_id, new.property_id, new.id, 'departamento_cambiado', auth.uid(), jsonb_build_object('de', old.department, 'a', new.department));
  end if;
  if new.sla_warning_notified_at is not null and old.sla_warning_notified_at is null then
    insert into hoteles.guest_ticket_event (organization_id, property_id, ticket_id, event_type, actor_id, detail)
    values (new.organization_id, new.property_id, new.id, 'aviso_sla', auth.uid(), jsonb_build_object('slaVenceEn', new.sla_due_at));
  end if;
  return new;
end;
$$;

create or replace function hoteles.ticket_sla_policy_before_write()
returns trigger language plpgsql security definer set search_path = core, hoteles as $$
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

revoke all on function hoteles.guest_ticket_before_insert() from public, anon;
revoke all on function hoteles.guest_ticket_before_update() from public, anon;
revoke all on function hoteles.guest_ticket_log_event() from public, anon;
revoke all on function hoteles.ticket_sla_policy_before_write() from public, anon;

create trigger guest_ticket_before_insert before insert on hoteles.guest_ticket
  for each row execute function hoteles.guest_ticket_before_insert();
create trigger guest_ticket_before_update before update on hoteles.guest_ticket
  for each row execute function hoteles.guest_ticket_before_update();
create trigger guest_ticket_log_event after insert or update on hoteles.guest_ticket
  for each row execute function hoteles.guest_ticket_log_event();
create trigger ticket_sla_policy_before_write before insert or update on hoteles.ticket_sla_policy
  for each row execute function hoteles.ticket_sla_policy_before_write();

-- ---------------------------------------------------------------------------
-- 5) RLS + GRANTs. Sin `using (true)`, sin GRANT a anon, sin DELETE para authenticated
--    (un ticket se CANCELA: historial auditable). GRANT de UPDATE a nivel de COLUMNA: solo
--    lo que las rutas reales escriben (iniciar/asignar/reasignar/cerrar); `property_id`,
--    `organization_id`, `room_id`, `sla_*`, `escalated_*`, `closed_at` y `created_*` quedan
--    inmutables para el cliente (los derivan los triggers o el barrido de sistema).
-- ---------------------------------------------------------------------------
alter table hoteles.guest_ticket enable row level security;
alter table hoteles.guest_ticket_event enable row level security;
alter table hoteles.ticket_sla_policy enable row level security;

create policy "tickets: staff ve los tickets que le corresponden" on hoteles.guest_ticket for select
  using (hoteles.guest_ticket_visible(property_id, department, assigned_to, created_by));
create policy "tickets: staff de la property registra tickets" on hoteles.guest_ticket for insert
  with check (hoteles.can_create_guest_ticket(property_id));
create policy "tickets: manager, departamento o responsable actualiza" on hoteles.guest_ticket for update
  using (
    hoteles.can_manage_guest_tickets(property_id)
    or hoteles.guest_ticket_role(property_id) = department
    or assigned_to = auth.uid()
  )
  with check (hoteles.guest_ticket_visible(property_id, department, assigned_to, created_by));

-- La bitacora hereda la visibilidad del ticket: el subselect corre bajo la RLS de guest_ticket.
create policy "tickets: bitacora visible si el ticket es visible" on hoteles.guest_ticket_event for select
  using (exists (select 1 from hoteles.guest_ticket t where t.id = guest_ticket_event.ticket_id));

create policy "tickets: staff ve la politica de SLA de su property" on hoteles.ticket_sla_policy for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "tickets: owner/gm define la politica de SLA" on hoteles.ticket_sla_policy for insert
  with check (hoteles.can_write_ticket_sla_policy(property_id));
create policy "tickets: owner/gm ajusta la politica de SLA" on hoteles.ticket_sla_policy for update
  using (hoteles.can_write_ticket_sla_policy(property_id)) with check (hoteles.can_write_ticket_sla_policy(property_id));

revoke all on hoteles.guest_ticket, hoteles.guest_ticket_event, hoteles.ticket_sla_policy from public, anon;
grant select on hoteles.guest_ticket, hoteles.guest_ticket_event, hoteles.ticket_sla_policy to authenticated;
grant insert (property_id, room_id, guest_review_id, department, priority, channel, guest_message, sla_minutes, assigned_to)
  on hoteles.guest_ticket to authenticated;
grant update (status, department, assigned_to, resolution_note) on hoteles.guest_ticket to authenticated;
grant insert (property_id, department, priority, sla_minutes) on hoteles.ticket_sla_policy to authenticated;
grant update (sla_minutes) on hoteles.ticket_sla_policy to authenticated;
grant select, insert, update, delete on hoteles.guest_ticket, hoteles.guest_ticket_event, hoteles.ticket_sla_policy to service_role;

-- ---------------------------------------------------------------------------
-- 6) Barrido de SLA: SOLO sistema (auth.uid() is null, el cron), UNA property por llamada
--    (una transaccion por unidad en el barrido). Con el reloj `p_now` que manda la
--    aplicacion (nunca el de la base, para poder probar con reloj simulado):
--      - ESCALA (-> escalado, a gerente/dueno) todo ticket abierto/en_progreso cuyo
--        sla_due_at ya quedo atras de p_now;
--      - AVISA (sla_warning_notified_at) los que alcanzaron `p_warning_ratio` (75% por
--        defecto) de su SLA sin vencer todavia y sin aviso previo.
--    Idempotente: una segunda corrida no vuelve a tocar lo ya escalado/avisado. La
--    bitacora la escribe el trigger log_event (actor null). Devuelve que hizo.
--    Justificacion de seguridad: security definer para poder actualizar columnas que el
--    cliente no tiene (escalated_*, sla_warning_notified_at); search_path fijo; el guard
--    `auth.uid() is not null` la hace inalcanzable para un usuario final; solo toca la
--    property recibida y tickets sin cierre.
-- ---------------------------------------------------------------------------
create or replace function hoteles.sweep_guest_ticket_sla(p_property_id uuid, p_now timestamptz, p_warning_ratio numeric default 0.75)
returns table (out_ticket_id uuid, out_kind text, out_department text, out_priority text, out_assigned_to uuid)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'sweep_guest_ticket_sla: solo alcanzable desde sesion de sistema' using errcode = '42501';
  end if;
  if p_warning_ratio is null or p_warning_ratio <= 0 or p_warning_ratio > 1 then
    raise exception 'p_warning_ratio debe estar en (0, 1]' using errcode = '22023';
  end if;
  return query
  with escalated as (
    update hoteles.guest_ticket t
       set status = 'escalado', escalated_at = p_now
     where t.property_id = p_property_id and t.status in ('abierto', 'en_progreso') and t.sla_due_at < p_now
    returning t.id, t.department, t.priority, t.assigned_to
  ), warned as (
    update hoteles.guest_ticket t
       set sla_warning_notified_at = p_now
     where t.property_id = p_property_id and t.status in ('abierto', 'en_progreso')
       and t.sla_warning_notified_at is null and t.sla_due_at >= p_now
       and t.created_at + (t.sla_minutes * p_warning_ratio) * interval '1 minute' <= p_now
    returning t.id, t.department, t.priority, t.assigned_to
  )
  select e.id, 'escalado'::text, e.department, e.priority, e.assigned_to from escalated e
  union all
  select w.id, 'aviso_sla'::text, w.department, w.priority, w.assigned_to from warned w;
end;
$$;
revoke all on function hoteles.sweep_guest_ticket_sla(uuid, timestamptz, numeric) from public, anon;
grant execute on function hoteles.sweep_guest_ticket_sla(uuid, timestamptz, numeric) to authenticated, service_role;
