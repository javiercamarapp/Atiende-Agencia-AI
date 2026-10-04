-- H-P3-01 (P0, dinero) -- FOLIO CERRADO QUE ADMITE CARGOS Y CIERRE SIN GUARDA DE ESTADO (hoteles)
-- + H-P3-04 (P1) -- EL DIA DE HOUSEKEEPING ARRANCA SOLO (hora de arranque y funciones de SISTEMA del cron).
--
-- Defecto de integridad (disponibilidad/consistencia de saldos): "cargar" y "cerrar" un folio eran dos pasos de
-- "leer estado -> decidir -> escribir" sin ningun lock entre ambos. Dos peticiones simultaneas (cargo + cierre
-- 'saldo_cero', pago + cierre) terminaban con exito las dos y el folio quedaba 'cerrado' con un cargo o un pago nuevo
-- que el cierre nunca vio. Ninguna policy RLS ni CHECK miraba `folio.status` al insertar en charge/payment. El cierre
-- tampoco comprobaba en la base que el saldo fuera cero: lo decidia la app con una lectura previa. Port de la
-- correccion ya probada en el suelto (auditoria-2, reproducida 10/10 con Promise.all), adaptada a los esquemas y
-- tablas de este monorepo (`hoteles.*`).
--
-- Que hace (todo en la base, idempotente):
--   1. `hoteles.charge_payment_reject_on_closed_folio()` + un trigger BEFORE INSERT en `hoteles.charge` y otro en
--      `hoteles.payment`: toma `select ... for update` sobre la fila de `hoteles.folio` y, si esta 'cerrado', rechaza
--      el INSERT con SQLSTATE P0001 y mensaje `folio_cerrado: ...`.
--   2. `hoteles.folio_reject_inconsistent_close()` + un trigger BEFORE UPDATE OF status en `hoteles.folio`: cuando el
--      UPDATE cierra el folio con close_reason = 'saldo_cero', recalcula el saldo REAL (misma formula que
--      `computeBalance` de apps/api: cargos con impuesto menos pagos capturados) y lo rechaza si no es cero con
--      `cierre_saldo_distinto_de_cero: ...` (P0001).
--   3. `hoteles.system_list_in_house_reservations_for_night_audit` ya no devuelve como "folio primario" uno cerrado
--      (el cargo de hospedaje de la noche se omite como anomalia en vez de abortar la auditoria nocturna entera contra
--      el trigger del punto 1; antes se posteaba silenciosamente un cargo en un folio cerrado).
--   4. (H-P3-04, ver la seccion al final) hora de arranque del dia de housekeeping, ledger por (property, fecha) y funciones
--      de SOLO SISTEMA para el cron `housekeeping-dia`.
--
-- Por que cierra la carrera sin importar el orden de llegada: ambos triggers comparten el MISMO recurso de lock (la
-- fila del folio). Si el INSERT gana, el UPDATE de cierre espera a que comprometa, y su trigger recalcula el saldo YA
-- con el cargo visible (READ COMMITTED: cada sentencia ve lo comprometido) y lo rechaza. Si el UPDATE de cierre gana,
-- el INSERT espera en el `for update`, releyendo `status` ya 'cerrado', y se rechaza. Ninguna secuencia deja un folio
-- cerrado con movimientos posteriores al cierre ni cerrado como 'saldo_cero' con saldo distinto de cero. Los dos
-- triggers toman locks en el mismo orden (folio primero), asi que no hay ciclo de deadlock entre ellos.
--
-- ---------------------------------------------------------------------------------------------------------------------
-- JUSTIFICACION DE SEGURIDAD (cada funcion / trigger nuevo)
-- ---------------------------------------------------------------------------------------------------------------------
--  * `charge_payment_reject_on_closed_folio` y `folio_reject_inconsistent_close` son funciones de TRIGGER, no RPC:
--    `security definer` con `search_path` fijo (`hoteles, pg_temp`) porque `select ... for update` sobre `hoteles.folio`
--    exige privilegio UPDATE y RLS sobre la fila, y el rol `authenticated` que inserta el cargo no debe necesitar mas
--    permisos que los que ya tiene (GRANT select+insert en charge/payment, sin cambios). Solo LEEN folio/charge/payment
--    y toman el lock; no escriben nada y no reciben parametros del cliente (usan solo `new`). `revoke execute ... from
--    public`: no son invocables como funcion (un trigger no necesita EXECUTE del rol que dispara).
--  * Ningun GRANT nuevo, ninguna policy nueva, nada para `anon`. Las tablas conservan sus GRANT y RLS actuales.
--  * H-P3-04: `housekeeping_config.start_hour` (columna con CHECK 0..23, default 7): GRANT UPDATE a nivel de COLUMNA para
--    `authenticated` (la unica que escribe la ruta PUT de configuracion); la policy de UPDATE existente ya limita la fila a
--    owner/gm de la property. `hoteles.housekeeping_day_run`: ledger (property, fecha) del arranque automatico; RLS con SELECT al
--    staff de la property, SIN GRANT de escritura a `authenticated` (solo lo escriben las funciones de sistema de abajo; nada para
--    `anon`). Las 6 funciones `system_hk_*` son `security definer` con `search_path` fijo, `revoke ... from public, anon`, y
--    GRANT EXECUTE a `authenticated`/`service_role` porque la sesion de sistema de la API corre como `authenticated` con
--    `auth.uid() is null` (igual que 022/035/037); TODAS exigen `auth.uid() is null` (42501 para cualquier staff) y reciben la
--    property como parametro: son solo de la sesion de sistema del cron, que ya resuelve de cual property se trata.
--    `system_hk_assign_task` solo asigna una tarea 'pendiente' sin responsable (guarda de estado en el UPDATE) y el trigger
--    existente `housekeeping_task_check_assignee` exige que el responsable sea staff de ESA property.
--  * `system_list_in_house_reservations_for_night_audit`: se redefine con el mismo cuerpo, mismo `security definer`,
--    mismo `search_path`, mismo guard `auth.uid() is not null -> 42501` (solo sesion de sistema) y los mismos
--    grants/revokes; unico cambio: el join de folio exige `status = 'abierto'`.
--
-- Compatibilidad con la base sin migrar: el codigo TypeScript traduce el error de estos triggers a 409; contra una base
-- vieja (sin triggers) el camino anterior sigue funcionando (la guarda de la app + el `where status = 'abierto'` del
-- UPDATE de cierre, que no depende de la migracion).

create or replace function hoteles.charge_payment_reject_on_closed_folio()
returns trigger
language plpgsql
security definer
set search_path = hoteles, pg_temp
as $$
declare
  v_status text;
begin
  select status into v_status from hoteles.folio where id = new.folio_id for update;
  if not found then
    raise exception 'folio_no_encontrado: el folio % no existe', new.folio_id using errcode = 'P0001';
  end if;
  if v_status = 'cerrado' then
    raise exception 'folio_cerrado: el folio % esta cerrado y no admite nuevos movimientos', new.folio_id using errcode = 'P0001';
  end if;
  return new;
end;
$$;
revoke execute on function hoteles.charge_payment_reject_on_closed_folio() from public;

drop trigger if exists charge_reject_on_closed_folio_trg on hoteles.charge;
create trigger charge_reject_on_closed_folio_trg
  before insert on hoteles.charge
  for each row execute function hoteles.charge_payment_reject_on_closed_folio();

drop trigger if exists payment_reject_on_closed_folio_trg on hoteles.payment;
create trigger payment_reject_on_closed_folio_trg
  before insert on hoteles.payment
  for each row execute function hoteles.charge_payment_reject_on_closed_folio();

create or replace function hoteles.folio_reject_inconsistent_close()
returns trigger
language plpgsql
security definer
set search_path = hoteles, pg_temp
as $$
declare
  v_charges numeric(14, 2);
  v_payments numeric(14, 2);
  v_balance numeric(14, 2);
begin
  if new.status = 'cerrado' and old.status is distinct from 'cerrado' and new.close_reason = 'saldo_cero' then
    select coalesce(sum(amount + tax_amount), 0) into v_charges from hoteles.charge where folio_id = new.id;
    select coalesce(sum(amount), 0) into v_payments from hoteles.payment where folio_id = new.id and status = 'capturado';
    v_balance := round(v_charges - v_payments, 2);
    if v_balance <> 0 then
      raise exception 'cierre_saldo_distinto_de_cero: el folio % tiene saldo % y no puede cerrarse como saldo_cero', new.id, v_balance
        using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$$;
revoke execute on function hoteles.folio_reject_inconsistent_close() from public;

drop trigger if exists folio_reject_inconsistent_close_trg on hoteles.folio;
create trigger folio_reject_inconsistent_close_trg
  before update of status on hoteles.folio
  for each row execute function hoteles.folio_reject_inconsistent_close();

-- Night audit: un folio primario cerrado ya no es destino de cargos (ver punto 3 de la cabecera).
create or replace function hoteles.system_list_in_house_reservations_for_night_audit(
  p_property_id uuid,
  p_business_date date
)
returns table (out_reservation_id uuid, out_folio_id uuid, out_nightly_price numeric)
language plpgsql security definer set search_path = hoteles as $$
begin
  if auth.uid() is not null then
    raise exception 'system_list_in_house_reservations_for_night_audit es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return query
    select r.id, f.id, rp.price
    from hoteles.reservation r
    left join hoteles.folio f on f.reservation_id = r.id and f.is_primary and f.status = 'abierto'
    left join hoteles.rate_plan rp on rp.room_type_id = r.room_type_id and rp.property_id = r.property_id and rp.date = p_business_date
    where r.property_id = p_property_id
      and r.status in ('check_in', 'en_estancia')
      and r.check_in_date <= p_business_date
      and r.check_out_date > p_business_date;
end;
$$;

revoke execute on function hoteles.system_list_in_house_reservations_for_night_audit(uuid, date) from public;
grant execute on function hoteles.system_list_in_house_reservations_for_night_audit(uuid, date) to authenticated;

-- ---------------------------------------------------------------------------------------------------------------------
-- 4) H-P3-04 -- el dia de housekeeping arranca solo (cron `housekeeping-dia`, horario).
-- ---------------------------------------------------------------------------------------------------------------------
-- Hora local de arranque por property (0..23, default 07:00). Lectura/escritura aislada en el codigo TypeScript con SAVEPOINT:
-- una base sin esta migracion sigue usando el default 07:00 y la configuracion actual no cambia.
alter table hoteles.housekeeping_config add column if not exists start_hour smallint not null default 7;
alter table hoteles.housekeeping_config drop constraint if exists housekeeping_config_start_hour_check;
alter table hoteles.housekeeping_config add constraint housekeeping_config_start_hour_check check (start_hour between 0 and 23);
grant update (start_hour) on hoteles.housekeeping_config to authenticated;

-- Ledger: UNA fila por (property, fecha de trabajo). Reclamarla (insert ... on conflict do nothing) es lo que hace idempotente el
-- arranque: dos corridas, o dos cron solapados, nunca generan ni asignan dos veces el mismo dia de la misma property.
create table if not exists hoteles.housekeeping_day_run (
  property_id uuid not null references core.property(id) on delete cascade,
  work_date date not null,
  organization_id uuid not null references core.organization(id) on delete restrict,
  started_at timestamptz not null default now(),
  tasks_generated integer not null default 0 check (tasks_generated >= 0),
  tasks_assigned integer not null default 0 check (tasks_assigned >= 0),
  tasks_unassigned integer not null default 0 check (tasks_unassigned >= 0),
  primary key (property_id, work_date)
);
alter table hoteles.housekeeping_day_run enable row level security;
drop policy if exists "staff ve el arranque del dia de housekeeping de su property" on hoteles.housekeeping_day_run;
create policy "staff ve el arranque del dia de housekeeping de su property" on hoteles.housekeeping_day_run for select
  using (core.has_property_access(auth.uid(), property_id));
revoke all on hoteles.housekeeping_day_run from public, anon;
grant select on hoteles.housekeeping_day_run to authenticated;
grant select, insert, update, delete on hoteles.housekeeping_day_run to service_role;

-- 4a) Configuracion efectiva para el cron (la tabla tiene RLS por staff: la sesion de sistema no la veria y creeria que la
--     asignacion automatica esta apagada). 0 filas = la property no guardo configuracion propia (el codigo usa los defaults).
create or replace function hoteles.system_hk_config(p_property_id uuid)
returns table (
  out_auto_assign_enabled boolean, out_max_tasks_per_camarista integer, out_shift_minutes integer,
  out_minutes_salida integer, out_minutes_estancia integer, out_minutes_profunda integer, out_minutes_repaso integer,
  out_start_hour integer
)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_hk_config es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select c.auto_assign_enabled, c.max_tasks_per_camarista::integer, c.shift_minutes::integer, c.minutes_salida::integer,
           c.minutes_estancia::integer, c.minutes_profunda::integer, c.minutes_repaso::integer, c.start_hour::integer
      from hoteles.housekeeping_config c where c.property_id = p_property_id;
end;
$$;

-- 4b) Arranque del dia: reclama el ledger y genera las tareas con la MISMA regla que "Generar dia" (habitaciones sucias u ocupadas,
--     sin fuera de servicio activo, sin tarea activa ese dia, y sin tarea de estancia si hay opt-out activo ese dia).
create or replace function hoteles.system_hk_start_day(p_property_id uuid, p_work_date date)
returns table (out_claimed boolean, out_generated integer)
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_org uuid;
  v_claimed uuid;
  v_generated integer := 0;
  v_skip uuid[];
begin
  if auth.uid() is not null then
    raise exception 'system_hk_start_day es solo para la sesion de sistema' using errcode = '42501';
  end if;
  select organization_id into v_org from core.property where id = p_property_id;
  if v_org is null then
    raise exception 'property inexistente' using errcode = 'P0002';
  end if;
  insert into hoteles.housekeeping_day_run (property_id, work_date, organization_id)
  values (p_property_id, p_work_date, v_org)
  on conflict (property_id, work_date) do nothing
  returning property_id into v_claimed;
  if v_claimed is null then
    return query select false, 0;
    return;
  end if;
  select coalesce(array_agg(o.room_id), '{}'::uuid[]) into v_skip
    from hoteles.cleaning_opt_out o
   where o.property_id = p_property_id and o.opt_out_date = p_work_date and o.status = 'activo';
  with ins as (
    insert into hoteles.housekeeping_task (property_id, room_id, task_type, priority, work_date, created_by)
    select r.property_id, r.id, case when r.status = 'ocupada' then 'estancia' else 'salida' end, 'normal', p_work_date, null
      from hoteles.room r
     where r.property_id = p_property_id and r.status in ('sucia', 'ocupada')
       and not exists (select 1 from hoteles.room_out_of_service o where o.room_id = r.id and o.status = 'activo')
       and not exists (select 1 from hoteles.housekeeping_task t where t.room_id = r.id and t.work_date = p_work_date and t.status <> 'cancelada')
       and not (r.status = 'ocupada' and r.id = any(v_skip))
    on conflict do nothing
    returning id
  )
  select count(*)::integer into v_generated from ins;
  update hoteles.housekeeping_day_run set tasks_generated = v_generated where property_id = p_property_id and work_date = p_work_date;
  return query select true, v_generated;
end;
$$;

-- 4c) Lectura de las tareas del dia y de las camaristas candidatas (para planificar la asignacion automatica en TypeScript, con la
--     misma funcion pura `planAutoAssignment` que usa el boton).
create or replace function hoteles.system_hk_list_day_tasks(p_property_id uuid, p_work_date date)
returns table (out_task_id uuid, out_room_code text, out_task_type text, out_priority text, out_status text, out_assigned_to uuid)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_hk_list_day_tasks es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select t.id, r.code, t.task_type, t.priority, t.status, t.assigned_to
      from hoteles.housekeeping_task t join hoteles.room r on r.id = t.room_id and r.property_id = t.property_id
     where t.property_id = p_property_id and t.work_date = p_work_date
     order by r.code, t.id;
end;
$$;

create or replace function hoteles.system_hk_list_camaristas(p_property_id uuid)
returns table (out_user_id uuid, out_full_name text)
language plpgsql stable security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_hk_list_camaristas es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select su.id, su.full_name
      from core.membership m
      join core.staff_user su on su.id = m.user_id
      join core.property p on p.organization_id = m.organization_id
     where p.id = p_property_id and m.vertical_role = 'housekeeping'
       and (m.property_ids is null or p_property_id = any(m.property_ids))
     order by su.full_name asc, su.id;
end;
$$;

-- 4d) Asignar una tarea: solo 'pendiente' y sin responsable (guarda de estado; el trigger existente valida que el responsable sea
--     staff de la property). Devuelve false si la tarea ya no estaba disponible (carrera perdida con una asignacion manual).
create or replace function hoteles.system_hk_assign_task(p_property_id uuid, p_task_id uuid, p_camarista_id uuid)
returns boolean
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
declare
  v_n integer;
begin
  if auth.uid() is not null then
    raise exception 'system_hk_assign_task es solo para la sesion de sistema' using errcode = '42501';
  end if;
  update hoteles.housekeeping_task set assigned_to = p_camarista_id, updated_at = now()
   where id = p_task_id and property_id = p_property_id and status = 'pendiente' and assigned_to is null;
  get diagnostics v_n = row_count;
  return v_n > 0;
end;
$$;

-- 4e) Cierra el ledger con el resultado de la asignacion.
create or replace function hoteles.system_hk_finish_day(p_property_id uuid, p_work_date date, p_assigned integer, p_unassigned integer)
returns void
language plpgsql security definer set search_path = core, hoteles, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'system_hk_finish_day es solo para la sesion de sistema' using errcode = '42501';
  end if;
  update hoteles.housekeeping_day_run set tasks_assigned = greatest(coalesce(p_assigned, 0), 0), tasks_unassigned = greatest(coalesce(p_unassigned, 0), 0)
   where property_id = p_property_id and work_date = p_work_date;
end;
$$;

revoke all on function hoteles.system_hk_config(uuid) from public, anon;
revoke all on function hoteles.system_hk_start_day(uuid, date) from public, anon;
revoke all on function hoteles.system_hk_list_day_tasks(uuid, date) from public, anon;
revoke all on function hoteles.system_hk_list_camaristas(uuid) from public, anon;
revoke all on function hoteles.system_hk_assign_task(uuid, uuid, uuid) from public, anon;
revoke all on function hoteles.system_hk_finish_day(uuid, date, integer, integer) from public, anon;
grant execute on function hoteles.system_hk_config(uuid) to authenticated, service_role;
grant execute on function hoteles.system_hk_start_day(uuid, date) to authenticated, service_role;
grant execute on function hoteles.system_hk_list_day_tasks(uuid, date) to authenticated, service_role;
grant execute on function hoteles.system_hk_list_camaristas(uuid) to authenticated, service_role;
grant execute on function hoteles.system_hk_assign_task(uuid, uuid, uuid) to authenticated, service_role;
grant execute on function hoteles.system_hk_finish_day(uuid, date, integer, integer) to authenticated, service_role;
