-- C-04 (citas) -- mensajes de WhatsApp editables desde el panel: plantillas de recordatorio / confirmacion /
-- cancelacion / reagendado, anticipacion del recordatorio y horario de envio, con historial versionado.
-- Prefijo de supabase/migrations asignado: 20240101000232 (interno 026).
--
-- Decision de diseno: solo agrega objetos NUEVOS (dos tablas y tres funciones). Nada existente se toca. El codigo
-- TypeScript que usa estos objetos degrada con SAVEPOINT al comportamiento anterior (recordatorio de 24 h con el
-- texto de siempre, sin mensajes extra) mientras la base no tenga esta migracion (SQLSTATE 42883/42P01/42703):
-- nada de esto se aplica al mergear.
--
-- Justificacion de seguridad de cada objeto:
--  * citas.whatsapp_message_config (una fila por organizacion). RLS habilitado. `revoke all ... from public, anon,
--    authenticated, service_role` y despues SOLO `select` por COLUMNA para `authenticated`; la policy limita la
--    lectura a owner/admin de la organizacion (los textos y horarios no son para el rol `staff`). NO hay GRANT ni
--    policy de INSERT/UPDATE/DELETE: toda escritura pasa por `save_whatsapp_message_config` (deny-by-default).
--    Los CHECK acotan largo y rangos (el texto termina dentro de un mensaje a un cliente).
--  * citas.whatsapp_message_config_history. Append-only: RLS, mismo `revoke all`, `select` por columna solo para
--    owner/admin y triggers que bloquean UPDATE/DELETE incondicionalmente (ni service_role puede). Sin GRANT de
--    INSERT: solo la funcion de guardado escribe.
--  * citas.save_whatsapp_message_config -- `security definer`, `set search_path = citas, core, pg_temp`, `revoke ...
--    from public, anon`, EXECUTE solo para `authenticated`. Exige `auth.uid()` no nulo y membership owner/admin en
--    `p_organization_id` (42501 si no; el actor SIEMPRE sale de auth.uid(), nunca de un parametro). Bloquea la fila
--    `for update` y compara la version esperada (AT409 si cambio entre tanto: nadie pisa el cambio de otra persona).
--    Escribe la fila y su historial en la misma transaccion.
--  * citas.whatsapp_message_config_system -- lectura SOLO-SISTEMA para el cron de recordatorios y para los avisos
--    que corren sin usuario: exige `auth.uid() is null` (42501 si no) y devuelve unicamente columnas de envio (sin
--    updated_by). `security definer` con search_path fijo, `revoke ... from public, anon`; EXECUTE para
--    `authenticated` (la sesion de sistema corre con ese rol y auth.uid() null, mismo mecanismo que 021/022/025) y
--    service_role.
--  * citas.whatsapp_message_config_history_list -- lectura para el panel con la misma regla owner/admin que la
--    policy; devuelve las N versiones mas recientes (tope 100). `security definer` para poder resolver el nombre de
--    quien cambio desde core.staff_user (el rol `authenticated` no lee esa tabla de otras personas).
--
-- Requiere: 001_citas_schema.sql, 003 (citas.whatsapp_config) y 0001_core_schema.sql (core.membership/staff_user).

create table citas.whatsapp_message_config (
  organization_id uuid primary key references core.organization(id) on delete cascade,
  reminder_enabled boolean not null default true,
  reminder_text text check (reminder_text is null or char_length(reminder_text) between 1 and 600),
  reminder_lead_hours smallint not null default 24 check (reminder_lead_hours between 1 and 72),
  confirmation_enabled boolean not null default false,
  confirmation_text text check (confirmation_text is null or char_length(confirmation_text) between 1 and 600),
  cancellation_enabled boolean not null default false,
  cancellation_text text check (cancellation_text is null or char_length(cancellation_text) between 1 and 600),
  reschedule_enabled boolean not null default false,
  reschedule_text text check (reschedule_text is null or char_length(reschedule_text) between 1 and 600),
  send_window_start smallint check (send_window_start is null or send_window_start between 0 and 23),
  send_window_end smallint check (send_window_end is null or send_window_end between 1 and 24),
  version integer not null default 1 check (version >= 1),
  updated_by uuid references core.staff_user(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint whatsapp_message_config_window_pair check ((send_window_start is null) = (send_window_end is null)),
  constraint whatsapp_message_config_window_order check (send_window_start is null or send_window_end > send_window_start)
);

alter table citas.whatsapp_message_config enable row level security;

create policy "owner/admin lee la configuracion de mensajes de whatsapp" on citas.whatsapp_message_config for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = whatsapp_message_config.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

revoke all on citas.whatsapp_message_config from public, anon, authenticated, service_role;
grant select (organization_id, reminder_enabled, reminder_text, reminder_lead_hours, confirmation_enabled, confirmation_text,
              cancellation_enabled, cancellation_text, reschedule_enabled, reschedule_text, send_window_start, send_window_end,
              version, updated_by, updated_at)
  on citas.whatsapp_message_config to authenticated;

create table citas.whatsapp_message_config_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  version integer not null check (version >= 1),
  accion text not null check (accion in ('actualizado', 'restablecido')),
  -- Foto de los campos editables antes y despues (solo textos y horarios de configuracion, sin datos de clientes).
  anterior jsonb,
  nuevo jsonb not null,
  actor_id uuid references core.staff_user(id) on delete set null,
  created_at timestamptz not null default now(),
  seq bigint generated always as identity,
  unique (organization_id, version)
);
create index whatsapp_message_config_history_lookup_idx on citas.whatsapp_message_config_history (organization_id, version desc);

alter table citas.whatsapp_message_config_history enable row level security;

create policy "owner/admin lee el historial de mensajes de whatsapp" on citas.whatsapp_message_config_history for select
  using (exists (
    select 1 from core.membership m
    where m.organization_id = whatsapp_message_config_history.organization_id
      and m.user_id = auth.uid()
      and m.vertical_role in ('owner', 'admin')
  ));

revoke all on citas.whatsapp_message_config_history from public, anon, authenticated, service_role;
grant select (id, organization_id, version, accion, anterior, nuevo, actor_id, created_at)
  on citas.whatsapp_message_config_history to authenticated;

create or replace function citas.whatsapp_message_config_history_block_mutation() returns trigger
language plpgsql
as $$
begin
  raise exception 'whatsapp_message_config_history_append_only: % no esta permitido', tg_op using errcode = '0A000';
end;
$$;

create trigger whatsapp_message_config_history_block_update_trg
  before update on citas.whatsapp_message_config_history
  for each row execute function citas.whatsapp_message_config_history_block_mutation();
create trigger whatsapp_message_config_history_block_delete_trg
  before delete on citas.whatsapp_message_config_history
  for each row execute function citas.whatsapp_message_config_history_block_mutation();

-- Foto de los campos editables (la misma forma en el historial y en la respuesta de la API).
create or replace function citas.whatsapp_message_config_snapshot(p_row citas.whatsapp_message_config) returns jsonb
language sql
immutable
set search_path = pg_temp
as $$
  select jsonb_build_object(
    'reminderEnabled', p_row.reminder_enabled,
    'reminderText', p_row.reminder_text,
    'reminderLeadHours', p_row.reminder_lead_hours,
    'confirmationEnabled', p_row.confirmation_enabled,
    'confirmationText', p_row.confirmation_text,
    'cancellationEnabled', p_row.cancellation_enabled,
    'cancellationText', p_row.cancellation_text,
    'rescheduleEnabled', p_row.reschedule_enabled,
    'rescheduleText', p_row.reschedule_text,
    'sendWindowStart', p_row.send_window_start,
    'sendWindowEnd', p_row.send_window_end
  );
$$;
-- Funcion auxiliar interna: sin EXECUTE para nadie (solo la invoca `save_whatsapp_message_config`, que corre como su duenio).
revoke all on function citas.whatsapp_message_config_snapshot(citas.whatsapp_message_config) from public, anon, authenticated, service_role;

-- Guardar o restablecer. `p_expected_version` = 0 cuando todavia no hay fila. Devuelve la version nueva.
-- AT409 si la version vigente no es la esperada; 42501 sin sesion o sin rol owner/admin; 22023 accion invalida.
create or replace function citas.save_whatsapp_message_config(
  p_organization_id uuid,
  p_expected_version integer,
  p_accion text,
  p_config jsonb
) returns integer
language plpgsql
security definer
set search_path = citas, core, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_old citas.whatsapp_message_config;
  v_new citas.whatsapp_message_config;
  v_version integer;
begin
  if v_uid is null or p_organization_id is null or not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = v_uid and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'save_whatsapp_message_config: sin acceso' using errcode = '42501';
  end if;
  if p_accion not in ('actualizado', 'restablecido') then
    raise exception 'save_whatsapp_message_config: accion invalida' using errcode = '22023';
  end if;

  select * into v_old from citas.whatsapp_message_config c where c.organization_id = p_organization_id for update;
  if not found then
    if coalesce(p_expected_version, 0) <> 0 then
      raise exception 'save_whatsapp_message_config: la configuracion cambio' using errcode = 'AT409';
    end if;
    v_version := 1;
  else
    if p_expected_version is distinct from v_old.version then
      raise exception 'save_whatsapp_message_config: la configuracion cambio' using errcode = 'AT409';
    end if;
    v_version := v_old.version + 1;
  end if;

  if p_accion = 'restablecido' then
    v_new := row(p_organization_id, true, null, 24, false, null, false, null, false, null, null, null, v_version, v_uid, now());
  else
    v_new := row(
      p_organization_id,
      coalesce((p_config ->> 'reminderEnabled')::boolean, true),
      nullif(btrim(p_config ->> 'reminderText'), ''),
      coalesce((p_config ->> 'reminderLeadHours')::smallint, 24),
      coalesce((p_config ->> 'confirmationEnabled')::boolean, false),
      nullif(btrim(p_config ->> 'confirmationText'), ''),
      coalesce((p_config ->> 'cancellationEnabled')::boolean, false),
      nullif(btrim(p_config ->> 'cancellationText'), ''),
      coalesce((p_config ->> 'rescheduleEnabled')::boolean, false),
      nullif(btrim(p_config ->> 'rescheduleText'), ''),
      (p_config ->> 'sendWindowStart')::smallint,
      (p_config ->> 'sendWindowEnd')::smallint,
      v_version, v_uid, now()
    );
  end if;

  insert into citas.whatsapp_message_config as c (
    organization_id, reminder_enabled, reminder_text, reminder_lead_hours, confirmation_enabled, confirmation_text,
    cancellation_enabled, cancellation_text, reschedule_enabled, reschedule_text, send_window_start, send_window_end,
    version, updated_by, updated_at
  ) values (
    v_new.organization_id, v_new.reminder_enabled, v_new.reminder_text, v_new.reminder_lead_hours, v_new.confirmation_enabled,
    v_new.confirmation_text, v_new.cancellation_enabled, v_new.cancellation_text, v_new.reschedule_enabled, v_new.reschedule_text,
    v_new.send_window_start, v_new.send_window_end, v_new.version, v_new.updated_by, v_new.updated_at
  )
  on conflict (organization_id) do update set
    reminder_enabled = excluded.reminder_enabled, reminder_text = excluded.reminder_text,
    reminder_lead_hours = excluded.reminder_lead_hours, confirmation_enabled = excluded.confirmation_enabled,
    confirmation_text = excluded.confirmation_text, cancellation_enabled = excluded.cancellation_enabled,
    cancellation_text = excluded.cancellation_text, reschedule_enabled = excluded.reschedule_enabled,
    reschedule_text = excluded.reschedule_text, send_window_start = excluded.send_window_start,
    send_window_end = excluded.send_window_end, version = excluded.version, updated_by = excluded.updated_by,
    updated_at = excluded.updated_at;

  insert into citas.whatsapp_message_config_history (organization_id, version, accion, anterior, nuevo, actor_id)
  values (
    p_organization_id, v_version, p_accion,
    case when v_old.organization_id is null then null else citas.whatsapp_message_config_snapshot(v_old) end,
    citas.whatsapp_message_config_snapshot(v_new), v_uid
  );
  return v_version;
exception
  when unique_violation then
    -- Dos primeras escrituras a la vez: la segunda pierde y el codigo la devuelve como conflicto.
    raise exception 'save_whatsapp_message_config: la configuracion cambio' using errcode = 'AT409';
end;
$$;

-- Lectura SOLO-SISTEMA (cron de recordatorios y avisos sin usuario). Sin fila devuelve 0 filas: el codigo usa los
-- textos y el horario de siempre.
create or replace function citas.whatsapp_message_config_system(p_organization_id uuid)
returns table (
  reminder_enabled boolean, reminder_text text, reminder_lead_hours smallint,
  confirmation_enabled boolean, confirmation_text text,
  cancellation_enabled boolean, cancellation_text text,
  reschedule_enabled boolean, reschedule_text text,
  send_window_start smallint, send_window_end smallint
)
language plpgsql
stable
security definer
set search_path = citas, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_message_config_system es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
  select c.reminder_enabled, c.reminder_text, c.reminder_lead_hours, c.confirmation_enabled, c.confirmation_text,
         c.cancellation_enabled, c.cancellation_text, c.reschedule_enabled, c.reschedule_text, c.send_window_start, c.send_window_end
    from citas.whatsapp_message_config c
   where c.organization_id = p_organization_id;
end;
$$;

-- Historial para el panel (mas reciente primero, tope 100) con el nombre de quien cambio.
create or replace function citas.whatsapp_message_config_history_list(p_organization_id uuid, p_limit integer)
returns table (version integer, accion text, anterior jsonb, nuevo jsonb, actor_id uuid, actor_nombre text, created_at timestamptz)
language plpgsql
stable
security definer
set search_path = citas, core, pg_temp
as $$
begin
  if auth.uid() is null or p_organization_id is null or not exists (
    select 1 from core.membership m
    where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
  ) then
    raise exception 'whatsapp_message_config_history_list: sin acceso' using errcode = '42501';
  end if;
  return query
  select h.version, h.accion, h.anterior, h.nuevo, h.actor_id, (select su.full_name from core.staff_user su where su.id = h.actor_id), h.created_at
    from citas.whatsapp_message_config_history h
   where h.organization_id = p_organization_id
   order by h.version desc
   limit least(greatest(coalesce(p_limit, 20), 1), 100);
end;
$$;

revoke all on function citas.save_whatsapp_message_config(uuid, integer, text, jsonb) from public, anon;
revoke all on function citas.whatsapp_message_config_system(uuid) from public, anon;
revoke all on function citas.whatsapp_message_config_history_list(uuid, integer) from public, anon;
grant execute on function citas.save_whatsapp_message_config(uuid, integer, text, jsonb) to authenticated;
grant execute on function citas.whatsapp_message_config_system(uuid) to authenticated, service_role;
grant execute on function citas.whatsapp_message_config_history_list(uuid, integer) to authenticated;
