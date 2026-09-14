-- Fase 8 hoteles (REQ-BO-024, P0/GOB, LFT art.132 fr.XXXIV) — checador de asistencia
-- INALTERABLE (append-only, encadenado por hash POR EMPLEADO) + horario programado
-- (staff_schedule, mutable, administrado por owner/gm) para cruzar lo REALMENTE
-- trabajado contra lo AUTORIZADO y marcar horas extra no autorizadas, exportable a la
-- STPS. Port ~conceptual (adaptado al esquema `organization_id`/`property_id` de
-- atiende-fusion, sin la tabla `hotel` del origen) de:
--   - hoteles/packages/db/migrations/0118_attendance_log.sql (checador + cadena de hash)
--   - hoteles/packages/domain-hotel/src/attendance.ts (cruce puro, ya portado tal cual
--     en @atiende/domain-hoteles/checador/attendance.ts -- esta migración solo agrega
--     DÓNDE se guarda lo que ese módulo cruza).
--
-- Gap verificado contra el código real de ambos lados antes de construirse: el
-- original tiene fichaje/checador real; en atiende-fusion, antes de esta migración,
-- domain-hoteles NO tenía ningún módulo/tabla/endpoint de clock-in/clock-out real --
-- lo único parecido, `housekeeping/turnos-lft.ts` (migrations/009), valida la
-- PLANTILLA de turnos ANTES de publicarse (el horario PLANEADO de camaristas), no
-- registra la asistencia real de NINGÚN rol. Propósito y archivo distintos.
--
-- Requiere: 001_hoteles_schema.sql (core.has_property_access, core.staff_user).
--
-- ---------------------------------------------------------------------------
-- Diseño de inmutabilidad -- deliberadamente MÁS simple que el original, adaptado al
-- patrón YA establecido por esta vertical: el original envuelve el INSERT en una
-- función SECURITY DEFINER (`record_attendance_event`) para que el trigger de la
-- cadena de hash pueda escribir en una tabla `_chain_head` sin grants directos.
-- Ninguna otra migración de domain-hoteles en atiende-fusion usa una RPC intermedia
-- para un INSERT de negocio (`hoteles.maintenance_ticket`/
-- `hoteles.reservation_status_event`: INSERT directo protegido por RLS -- ver
-- migrations/009/005) -- se mantiene ese mismo patrón aquí. Postgres permite marcar
-- SECURITY DEFINER una función de TRIGGER (no solo una función invocable
-- directamente); es el trigger mismo (`attendance_log_set_hash`, abajo) el que se
-- declara así -- es la única pieza que de verdad necesita el privilegio elevado
-- (escribir la cabeza de cadena bloqueada). El INSERT que lo dispara lo hace
-- `authenticated` normal, bajo la policy de abajo (`staff_user_id = auth.uid()`).
-- Mismo resultado que el original (nadie fuera del trigger puede tocar la cabeza de
-- cadena, ni UPDATE ni DELETE se permiten NUNCA sobre `attendance_log`), un mecanismo
-- menos.
-- ---------------------------------------------------------------------------

create type hoteles.attendance_event_type as enum ('entrada', 'salida');

-- ---------------------------------------------------------------------------
-- 1) attendance_log — registro real, append-only, encadenado por hash POR EMPLEADO
--    (mismo criterio que el original: la inspección de la STPS es "el historial de
--    ESTE trabajador"; encadenar por organización/property competiría sin necesidad
--    por una sola cabeza de cadena entre decenas de empleados de la misma property.
--    La garantía de inmutabilidad es por FILA -- los triggers de bloqueo de abajo --
--    no por el alcance de la cadena).
-- ---------------------------------------------------------------------------
create table hoteles.attendance_log (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete restrict,
  staff_user_id uuid not null references core.staff_user(id) on delete restrict,
  event_type hoteles.attendance_event_type not null,
  recorded_at timestamptz not null default now(),
  source text not null default 'app',
  note text,
  seq bigint generated always as identity,
  prev_hash text,
  hash text not null,
  created_at timestamptz not null default now()
);
create unique index attendance_log_seq_idx on hoteles.attendance_log (seq);
create index attendance_log_staff_seq_idx on hoteles.attendance_log (staff_user_id, seq);
create index attendance_log_property_recorded_idx on hoteles.attendance_log (property_id, recorded_at);

-- Cabeza de cadena por empleado, bloqueada con FOR UPDATE dentro del trigger -- mismo
-- razonamiento que citas/002_appointment_idempotent.sql (advisory lock + FOR UPDATE
-- real) para no bifurcar la cadena bajo escritura concurrente real.
create table hoteles.attendance_log_chain_head (
  staff_user_id uuid primary key references core.staff_user(id) on delete cascade,
  hash text
);
revoke all on hoteles.attendance_log_chain_head from public, anon, authenticated;
alter table hoteles.attendance_log_chain_head enable row level security;
-- Sin ninguna policy: nadie -- ni `authenticated` ni `service_role` vía RLS -- tiene
-- una vía directa; solo el trigger de abajo (SECURITY DEFINER, ver comentario de
-- cabecera del archivo) la toca.

create or replace function hoteles.attendance_log_set_hash()
returns trigger
language plpgsql
security definer
set search_path = hoteles
as $$
declare
  v_prev_hash text;
  v_recorded_at timestamptz;
  v_canonical text;
begin
  insert into hoteles.attendance_log_chain_head (staff_user_id, hash)
  values (new.staff_user_id, null)
  on conflict (staff_user_id) do nothing;

  select hash into v_prev_hash
  from hoteles.attendance_log_chain_head
  where staff_user_id = new.staff_user_id
  for update;

  v_recorded_at := coalesce(new.recorded_at, now());

  v_canonical := coalesce(v_prev_hash, '<genesis>')
    || '|' || new.organization_id::text
    || '|' || new.property_id::text
    || '|' || new.staff_user_id::text
    || '|' || new.event_type::text
    || '|' || v_recorded_at::text
    || '|' || new.source
    || '|' || coalesce(new.note, '');

  new.prev_hash := v_prev_hash;
  new.recorded_at := v_recorded_at;
  new.hash := encode(sha256(convert_to(v_canonical, 'UTF8')), 'hex');

  update hoteles.attendance_log_chain_head set hash = new.hash where staff_user_id = new.staff_user_id;

  return new;
end;
$$;

create trigger attendance_log_set_hash_trg
  before insert on hoteles.attendance_log
  for each row execute function hoteles.attendance_log_set_hash();

create or replace function hoteles.attendance_log_block_mutation()
returns trigger
language plpgsql
as $$
begin
  raise exception 'attendance_log_append_only: % no está permitido sobre hoteles.attendance_log', tg_op
    using errcode = '0A000';
end;
$$;

create trigger attendance_log_block_update_trg
  before update on hoteles.attendance_log
  for each row execute function hoteles.attendance_log_block_mutation();
create trigger attendance_log_block_delete_trg
  before delete on hoteles.attendance_log
  for each row execute function hoteles.attendance_log_block_mutation();

-- ---------------------------------------------------------------------------
-- 2) Autorización -- `can_manage_attendance()`, mismo patrón que
--    `hoteles.can_manage_reservations()` (migrations/005): owner/gm ven y administran
--    la asistencia de CUALQUIER empleado de su property (responsables ante una
--    inspección de la STPS); nadie más (frontdesk/housekeeping/maintenance/fnb/
--    accountant NUNCA ven el historial de otro empleado -- dato personal de jornada
--    laboral, mismo criterio de minimización que el original, distinto de la
--    transparencia total intra-property de `reservation_status_event`).
-- ---------------------------------------------------------------------------
create or replace function hoteles.can_manage_attendance(_property_id uuid)
returns boolean language sql stable security definer set search_path = core, hoteles as $$
  select exists (
    select 1 from core.membership m
    join core.property p on p.organization_id = m.organization_id
    where m.user_id = auth.uid() and p.id = _property_id
      and (m.property_ids is null or _property_id = any(m.property_ids))
      and m.vertical_role in ('owner', 'gm')
  )
$$;

alter table hoteles.attendance_log enable row level security;

create policy "asistencia: propio registro o administracion ve" on hoteles.attendance_log for select
  using (staff_user_id = auth.uid() or hoteles.can_manage_attendance(property_id));

-- INSERT: cualquier staff de la property ficha SU PROPIO registro -- checador de
-- autoservicio, cierra por diseño el vector de fraude más común de un checador (un
-- compañero marca la entrada/salida de quien todavía no ha llegado). El `with check`
-- es la autoridad REAL (no solo la ruta HTTP, que YA ignora cualquier staffUserId del
-- body -- ver apps/api/src/routes/verticals/hoteles/asistencia.ts y
-- domain-hoteles/src/roles.ts, comentario de ATTENDANCE_ADMIN_ROLES): ni siquiera un
-- bug futuro de la ruta podría insertar a nombre de otro empleado.
create policy "asistencia: staff ficha su propio registro" on hoteles.attendance_log for insert
  with check (staff_user_id = auth.uid() and core.has_property_access(auth.uid(), property_id));

-- Sin policy de UPDATE/DELETE para NINGÚN rol -- los triggers de bloqueo de arriba lo
-- impiden de todas formas para cualquiera, incluido `service_role`/el dueño de la
-- migración (defensa en profundidad, mismo criterio que el original: esto es lo que
-- hace el registro "inalterable" exigido por LFT art.132 fr.XXXIV, no solo la
-- ausencia de policy de escritura).
revoke all on hoteles.attendance_log from public, anon;
grant select, insert on hoteles.attendance_log to authenticated;
grant select, insert, update, delete on hoteles.attendance_log to service_role;

-- ---------------------------------------------------------------------------
-- 3) staff_schedule — horario programado (mutable), lo que se cruza contra
--    attendance_log en @atiende/domain-hoteles/checador/attendance.ts::crossCheckAttendance.
--    Distinto de `hoteles.housekeeping_shift` (migrations/009): cubre a TODO el
--    staff (no solo camaristas/lavandería) y trae `authorized_overtime_minutes`, que
--    housekeeping_shift no necesita.
-- ---------------------------------------------------------------------------
create table hoteles.staff_schedule (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete restrict,
  property_id uuid not null references core.property(id) on delete cascade,
  staff_user_id uuid not null references core.staff_user(id) on delete cascade,
  work_date date not null,
  scheduled_start timestamptz not null,
  scheduled_end timestamptz not null,
  authorized_overtime_minutes integer not null default 0 check (authorized_overtime_minutes >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (property_id, staff_user_id, work_date),
  constraint staff_schedule_rango_valido check (scheduled_end > scheduled_start)
);
create index staff_schedule_property_staff_idx on hoteles.staff_schedule (property_id, staff_user_id, work_date);

-- Un horario solo tiene sentido para un empleado que de verdad pertenece a la
-- property que lo programa -- mismo tipo de guarda que
-- `hoteles.can_manage_reservations()`/`release_availability()` ya aplican con un
-- `raise exception` explícito en vez de dejar que una FK silenciosa lo permita.
create or replace function hoteles.staff_schedule_validate_staff()
returns trigger language plpgsql as $$
begin
  if not core.has_property_access(new.staff_user_id, new.property_id) then
    raise exception 'staff_no_pertenece_a_la_property: % no pertenece al staff de esta property', new.staff_user_id
      using errcode = 'P0001';
  end if;
  new.updated_at := now();
  return new;
end;
$$;

create trigger staff_schedule_validate_staff_trg
  before insert or update on hoteles.staff_schedule
  for each row execute function hoteles.staff_schedule_validate_staff();

alter table hoteles.staff_schedule enable row level security;

-- SELECT: transparencia hacia el propio empleado sobre su horario publicado, mismo
-- criterio que `hoteles.housekeeping_shift` (migrations/009) -- cualquier staff de la
-- property puede consultar el horario de cualquier compañero (es un horario de
-- trabajo, no un dato personal de jornada YA trabajada como attendance_log).
create policy "asistencia: staff ve el horario de su property" on hoteles.staff_schedule for select
  using (core.has_property_access(auth.uid(), property_id));
create policy "asistencia: administracion programa horarios" on hoteles.staff_schedule for insert
  with check (hoteles.can_manage_attendance(property_id));
create policy "asistencia: administracion reemplaza horarios" on hoteles.staff_schedule for update
  using (hoteles.can_manage_attendance(property_id)) with check (hoteles.can_manage_attendance(property_id));

revoke all on hoteles.staff_schedule from public, anon;
grant select, insert, update on hoteles.staff_schedule to authenticated;
grant select, insert, update, delete on hoteles.staff_schedule to service_role;
