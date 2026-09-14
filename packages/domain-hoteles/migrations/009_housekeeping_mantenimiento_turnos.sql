-- Fase 6 hoteles (REQ-HK-008/011) — housekeeping, ACOTADO a lo que domain-hoteles
-- porta en esta fase: turnos de camaristas/lavandería (validados contra la LFT,
-- @atiende/domain-hoteles/housekeeping/turnos-lft.ts) + intake de tickets de
-- mantenimiento correctivo (huésped/staff/agente de WhatsApp/sensor). Port
-- ~conceptual, adaptado al esquema `organization_id`/`property_id` de atiende-fusion,
-- de:
--   - hoteles/packages/db/migrations/0043_maintenance_ticket.sql (tickets)
--   - hoteles/packages/domain-hotel/src/housekeeping/turnos-lft.ts (validación, ya
--     portada tal cual en el paquete TS -- esta migración solo agrega DÓNDE se
--     guarda la plantilla YA validada)
--
-- Explícitamente FUERA de esta fase (dependen de un conector PMS real, REQ-INT-001,
-- que ninguna vertical de fusion tiene todavía):
--   - Asignación automática de camaristas (optimizador CP-SAT) -- `assigned_to` de
--     `hoteles.maintenance_ticket` es asignación MANUAL (un supervisor la fija por
--     HTTP), nunca un solver.
--   - Inspección de habitación por foto/OCR -- no existe tabla de
--     inspección/evidencia en esta migración; `hoteles.room.status` (migrations/001)
--     sigue siendo el único estado de la habitación, sin un estado de limpieza
--     separado (a diferencia del origen, que sí lo trae) -- se documenta como gap,
--     no se inventa un campo sin lógica real detrás.
--
-- Requiere: 001_hoteles_schema.sql ya aplicada (hoteles.room, core.staff_user,
-- core.has_property_access()).

-- ---------------------------------------------------------------------------
-- 1) Tickets de mantenimiento correctivo (REQ-HK-011). Sin `agent_approval`/
--    `requires_approval` (a diferencia del origen): ninguna vertical de fusion tiene
--    todavía una cola de aprobación de gasto genérica -- cerrar un ticket con su
--    costo real es una acción administrativa simple en esta fase (ver
--    MAINTENANCE_TICKET_MANAGE_ROLES, domain-hoteles/src/roles.ts), no un flujo de
--    doble confirmación inventado sin el resto del mecanismo detrás.
-- ---------------------------------------------------------------------------
create table hoteles.maintenance_ticket (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  room_id uuid references hoteles.room(id) on delete set null,
  title text not null check (length(title) between 1 and 150),
  description text not null check (length(description) between 1 and 1000),
  origin text not null default 'staff' check (origin in ('huesped', 'staff', 'agente', 'sensor')),
  severity text not null default 'media' check (severity in ('alta', 'media', 'baja')),
  status text not null default 'abierto' check (status in ('abierto', 'en_progreso', 'cerrado', 'cancelado')),
  assigned_to uuid references core.staff_user(id) on delete set null,
  estimated_cost numeric(12, 2) not null default 0 check (estimated_cost >= 0),
  actual_cost numeric(12, 2) check (actual_cost is null or actual_cost >= 0),
  resolution_note text,
  created_by uuid references core.staff_user(id) on delete set null,
  closed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint maintenance_ticket_closed_consistency check (
    (status in ('cerrado', 'cancelado')) = (closed_at is not null)
  )
);
create index maintenance_ticket_property_idx on hoteles.maintenance_ticket (organization_id, property_id, status);
create index maintenance_ticket_room_idx on hoteles.maintenance_ticket (room_id) where room_id is not null;

alter table hoteles.maintenance_ticket enable row level security;

-- RLS aquí es la capa de "perteneces a esta property" (mismo criterio ya documentado
-- en migrations/001 para `hoteles.fnb_order`); el filtrado fino de rol (quién puede
-- CERRAR/cambiar costo vs. solo reportar) vive en apps/api
-- (MAINTENANCE_TICKET_CREATE_ROLES/MAINTENANCE_TICKET_MANAGE_ROLES,
-- domain-hoteles/src/roles.ts) -- si ese espejo se desincroniza, la peor consecuencia
-- es un 403 de más, nunca un acceso de más (ver 0001, mismo principio).
create policy "staff ve tickets de mantenimiento de su property" on hoteles.maintenance_ticket for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff reporta tickets de mantenimiento de su property" on hoteles.maintenance_ticket for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff actualiza tickets de mantenimiento de su property" on hoteles.maintenance_ticket for update
  using (core.has_property_access(auth.uid(), property_id)) with check (core.has_property_access(auth.uid(), property_id));

revoke all on hoteles.maintenance_ticket from public, anon;
grant select, insert, update on hoteles.maintenance_ticket to authenticated;
grant select, insert, update, delete on hoteles.maintenance_ticket to service_role;

-- ---------------------------------------------------------------------------
-- 2) Turnos de camaristas/lavandería (REQ-HK-008). Solo la plantilla YA validada
--    contra la LFT (`assertTurnosLftPublishable`, turnos-lft.ts) llega aquí -- la
--    ruta HTTP nunca persiste un turno sin haber corrido esa validación primero
--    (ver apps/api/src/routes/verticals/hoteles/housekeeping.ts). Sin columna de
--    "publicado/borrador": a diferencia de una plantilla que se edita en curso, este
--    esquema modela solo el turno YA publicado (la validación en memoria, antes de
--    persistir, cumple el rol de "borrador").
-- ---------------------------------------------------------------------------
create table hoteles.housekeeping_shift (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  staff_id uuid not null references core.staff_user(id) on delete cascade,
  work_date date not null,
  start_time time not null,
  end_time time not null,
  created_at timestamptz not null default now()
);
create index housekeeping_shift_property_staff_idx on hoteles.housekeeping_shift (property_id, staff_id, work_date);

alter table hoteles.housekeeping_shift enable row level security;

-- Cualquier miembro del staff de la property puede CONSULTAR el turno publicado
-- (transparencia hacia la propia camarista sobre su propio horario, mismo criterio
-- que REQ-HK-020 del origen); publicar/reemplazar la plantilla es una decisión de
-- supervisión (HOUSEKEEPING_SHIFT_PUBLISH_ROLES: owner/gm/frontdesk), filtrada en
-- apps/api -- mismo reparto RLS-vs-aplicación que `maintenance_ticket` arriba.
create policy "staff ve turnos de housekeeping de su property" on hoteles.housekeeping_shift for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "staff publica turnos de housekeeping de su property" on hoteles.housekeeping_shift for insert
  with check (core.has_property_access(auth.uid(), property_id));
create policy "staff reemplaza turnos de housekeeping de su property" on hoteles.housekeeping_shift for delete
  using (core.has_property_access(auth.uid(), property_id));

revoke all on hoteles.housekeeping_shift from public, anon;
grant select, insert, delete on hoteles.housekeeping_shift to authenticated;
grant select, insert, update, delete on hoteles.housekeeping_shift to service_role;
