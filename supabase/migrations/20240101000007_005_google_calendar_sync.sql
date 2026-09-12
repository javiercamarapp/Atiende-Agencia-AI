-- Fase 3 — sincronización real con Google Calendar (vertical citas), ver diseño
-- Fase 3 §3/§4. Port de las columnas/tabla reales de
-- citas-reservaciones/supabase/migrations/20260908000000_initial_schema.sql
-- (`provider_calendar_accounts`, `google_event_id`/`google_sync_*` de
-- `appointments`) + 20260908010000_appointment_engine.sql (los 2 estados nuevos de
-- `google_sync_status` y el índice parcial), adaptados al esquema `citas.*` de este
-- repo. Requiere: 001_citas_schema.sql, 002_appointment_idempotent.sql ya aplicadas.
--
-- Decisión de alcance (§2 del diseño): la conexión es por `provider_id` (el
-- Google Calendar PERSONAL de un profesional concreto), nunca una sola cuenta
-- compartida por organización/property completa — un calendario de Google es
-- personal por naturaleza; agrupar por organización forzaría a todos los
-- profesionales de un negocio a compartir un solo calendario, lo que el origen
-- nunca hizo. `ProviderRecord` (organizationId + propertyId opcional) ya modela
-- exactamente el árbol de tenancy donde esta conexión vive.
--
-- §7 del diseño: watch channels/webhook receptor de Google quedan FUERA de esta
-- fase (opción A) — no se portan `google_watch_*` como columnas ACTIVAS de ningún
-- flujo (el motor de sincronización nunca las lee/escribe); si una Fase 3b decide
-- construir el receptor real, esas columnas ya existen para no requerir otra
-- migración solo para agregarlas.

-- ============================================================================
-- provider_calendar_accounts — la conexión OAuth de UN proveedor con SU Google
-- Calendar personal (ver diseño §3).
-- ============================================================================

create table citas.provider_calendar_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references core.organization(id) on delete cascade,
  provider_id uuid not null unique references citas.providers(id) on delete cascade,
  -- Normalmente "primary" o el email del profesional (ver diseño §3).
  google_calendar_id text not null,
  -- El refresh token NUNCA vive en esta columna en claro — es el id del secreto en
  -- Supabase Vault (`citas.set_provider_calendar_refresh_token`/
  -- `citas.get_provider_calendar_refresh_token`, ver diseño §4 paso 4). Vault/
  -- pgsodium no está habilitado todavía en este proyecto — ver diseño §4/§8/§9: es
  -- un paso de infraestructura de despliegue real, no de este código.
  google_refresh_token_secret_id uuid,
  -- Watch channels (§7, opción A): columnas presentes, sin flujo activo que las
  -- lea/escriba en esta fase — ver comentario de archivo.
  google_watch_channel_id text,
  google_watch_resource_id text,
  google_watch_expires_at timestamptz,
  sync_status text not null default 'disconnected'
    check (sync_status in ('disconnected', 'connected', 'error')),
  sync_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index provider_calendar_accounts_organization_idx on citas.provider_calendar_accounts (organization_id);

create or replace function citas.touch_provider_calendar_accounts_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger provider_calendar_accounts_touch_updated_at
  before update on citas.provider_calendar_accounts
  for each row execute function citas.touch_provider_calendar_accounts_updated_at();

alter table citas.provider_calendar_accounts enable row level security;

-- Igual criterio que providers/services (§1 de 001_citas_schema.sql): cualquier
-- miembro de la organización dueña gestiona la conexión de cualquiera de sus
-- proveedores — el origen tampoco distingue rol para esto.
create policy "staff gestiona provider_calendar_accounts de su organización" on citas.provider_calendar_accounts for all
  using (exists (select 1 from core.membership m where m.organization_id = provider_calendar_accounts.organization_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.membership m where m.organization_id = provider_calendar_accounts.organization_id and m.user_id = auth.uid()));

grant select, insert, update, delete on citas.provider_calendar_accounts to service_role;
grant select on citas.provider_calendar_accounts to authenticated;

-- ============================================================================
-- citas.appointments — columnas de sincronización unidireccional (software ->
-- Google, nunca al revés, ver diseño §6). Mismos nombres/estados exactos que el
-- origen.
-- ============================================================================

alter table citas.appointments add column google_event_id text;
alter table citas.appointments add column google_sync_status text not null default 'pending';
alter table citas.appointments add column google_sync_attempts integer not null default 0;
alter table citas.appointments add column google_sync_next_retry_at timestamptz;
alter table citas.appointments add column google_sync_error text;

alter table citas.appointments add constraint appointments_google_sync_status_check
  check (google_sync_status in ('pending', 'synced', 'error', 'skipped', 'pending_cancel', 'deleted'));

create index appointments_google_event_idx on citas.appointments (google_event_id) where google_event_id is not null;

-- La reconciliación (POST /internal/citas/google-calendar-sync, ver
-- calendar-sync.ts::syncPendingAppointments) recorre exactamente este subconjunto
-- en cada corrida; el índice parcial evita un seq scan sobre toda la tabla
-- conforme crece.
create index appointments_pending_google_sync_idx
  on citas.appointments (google_sync_next_retry_at)
  where google_sync_status in ('pending', 'pending_cancel');

-- ============================================================================
-- Transiciones de google_sync_status ESCRITAS DENTRO de las mismas funciones
-- plpgsql que ya cambian la cita real — nunca en una segunda transacción (ver
-- diseño §3/§5/§6: es lo que hace que "pending"/"pending_cancel" quede atómico con
-- el cambio real, no un job separado que pueda perderse).
--
-- create_appointment_idempotent: NO se re-crea — el default de la columna
-- ('pending') ya cubre toda cita nueva sin tocar la función; el motor de
-- sincronización decide 'skipped' si el proveedor no tiene calendario conectado
-- (nunca se decide en el punto de creación, ver calendar-sync.ts).
-- ============================================================================

-- ---- cancel_appointment_idempotent (agente) ----
create or replace function citas.cancel_appointment_idempotent(
  p_organization_id uuid,
  p_appointment_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_appointment citas.appointments;
begin
  select * into v_appointment from citas.appointments
  where id = p_appointment_id and organization_id = p_organization_id
  for update;

  if v_appointment.id is null then
    raise exception 'Cita no encontrada' using errcode = 'AT404';
  end if;

  if v_appointment.status = 'cancelled' then
    return to_jsonb(v_appointment); -- ya cancelada: no-op idempotente
  end if;

  if v_appointment.status in ('completed', 'no_show') then
    raise exception 'No se puede cancelar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  update citas.appointments set
    status = 'cancelled',
    -- 'pending_cancel' si ya había un evento en Google que borrar; 'skipped' si
    -- esta cita nunca llegó a sincronizarse (nunca queda en 'pending': el cron NO
    -- debe intentar CREAR un evento para una cita ya cancelada, ver diseño §3/§5).
    -- Reinicia el backoff: es, en efecto, una intención de sincronización nueva.
    google_sync_status = case when v_appointment.google_event_id is not null then 'pending_cancel' else 'skipped' end,
    google_sync_attempts = 0,
    google_sync_next_retry_at = null,
    google_sync_error = null
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.cancel_appointment_idempotent(uuid, uuid) from public, anon, authenticated;
grant execute on function citas.cancel_appointment_idempotent(uuid, uuid) to service_role;

-- ---- cancel_appointment_from_panel (staff) ----
create or replace function citas.cancel_appointment_from_panel(
  p_organization_id uuid,
  p_appointment_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_appointment citas.appointments;
begin
  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = auth.uid()) then
    raise exception 'No tienes permiso sobre este negocio' using errcode = 'AT403';
  end if;

  select * into v_appointment from citas.appointments
  where id = p_appointment_id and organization_id = p_organization_id
  for update;

  if v_appointment.id is null then
    raise exception 'Cita no encontrada' using errcode = 'AT404';
  end if;

  if v_appointment.status = 'cancelled' then
    return to_jsonb(v_appointment); -- ya cancelada: no-op idempotente
  end if;

  if v_appointment.status in ('completed', 'no_show') then
    raise exception 'No se puede cancelar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  update citas.appointments set
    status = 'cancelled',
    google_sync_status = case when v_appointment.google_event_id is not null then 'pending_cancel' else 'skipped' end,
    google_sync_attempts = 0,
    google_sync_next_retry_at = null,
    google_sync_error = null
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.cancel_appointment_from_panel(uuid, uuid) from public, anon;
grant execute on function citas.cancel_appointment_from_panel(uuid, uuid) to authenticated, service_role;

-- ---- reschedule_appointment_idempotent ----
create or replace function citas.reschedule_appointment_idempotent(
  p_organization_id uuid,
  p_appointment_id uuid,
  p_new_starts_at timestamptz,
  p_new_ends_at timestamptz,
  p_actor_channel text,
  p_actor_note text default null
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_appointment citas.appointments;
  v_previous jsonb;
begin
  if p_new_ends_at <= p_new_starts_at then
    raise exception 'ends_at debe ser posterior a starts_at' using errcode = 'AT400';
  end if;
  if p_actor_channel not in ('voice', 'whatsapp', 'web', 'manual', 'panel') then
    raise exception 'actor_channel inválido' using errcode = 'AT400';
  end if;
  if p_actor_note is not null and length(p_actor_note) > 2000 then
    raise exception 'actor_note excede el tamaño permitido' using errcode = 'AT400';
  end if;

  select * into v_appointment from citas.appointments
  where id = p_appointment_id and organization_id = p_organization_id
  for update;

  if v_appointment.id is null then
    raise exception 'Cita no encontrada' using errcode = 'AT404';
  end if;

  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'No se puede reagendar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  -- Reintento del mismo intento (mismo horario destino ya vigente): no-op
  -- idempotente real, sin duplicar el evento de auditoría ni tocar el estado de
  -- sincronización (nada cambió de verdad).
  if v_appointment.starts_at = p_new_starts_at and v_appointment.ends_at = p_new_ends_at then
    return to_jsonb(v_appointment);
  end if;

  v_previous := jsonb_build_object('starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at);

  begin
    update citas.appointments set
      starts_at = p_new_starts_at,
      ends_at = p_new_ends_at,
      -- El recordatorio de 24h ya enviado (si lo había) era para el horario VIEJO —
      -- se limpia para que el cron de recordatorio vuelva a mandar uno correcto.
      reminder_24h_sent_at = null,
      -- Si ya había un evento sincronizado en Google, reagendar debe volver a
      -- empujarlo (nunca queda "olvidado" con el horario viejo, ver diseño §5/§6) —
      -- se reinicia el backoff porque es, en efecto, un intento de sincronización
      -- nuevo. Si nunca tuvo evento, se deja tal cual: la fila ya trae el horario
      -- nuevo, así que cuando sí sincronice lo hará con el dato correcto.
      google_sync_status = case when v_appointment.google_event_id is not null then 'pending' else google_sync_status end,
      google_sync_attempts = case when v_appointment.google_event_id is not null then 0 else google_sync_attempts end,
      google_sync_next_retry_at = case when v_appointment.google_event_id is not null then null else google_sync_next_retry_at end,
      google_sync_error = case when v_appointment.google_event_id is not null then null else google_sync_error end
    where id = p_appointment_id and organization_id = p_organization_id
    returning * into v_appointment;
  exception
    when exclusion_violation then
      raise exception 'El nuevo horario ya no está disponible para este proveedor.'
        using errcode = 'AT423';
  end;

  insert into citas.appointment_audit_events (
    organization_id, appointment_id, event_type, actor_channel, actor_note, previous_data, new_data
  ) values (
    p_organization_id, p_appointment_id, 'rescheduled', p_actor_channel, p_actor_note,
    v_previous,
    jsonb_build_object('starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at)
  );

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.reschedule_appointment_idempotent(uuid, uuid, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function citas.reschedule_appointment_idempotent(uuid, uuid, timestamptz, timestamptz, text, text) to service_role;

-- ============================================================================
-- Vault — almacenamiento seguro del refresh token OAuth (ver diseño §4 paso 4).
--
-- IMPORTANTE (honesto, ver diseño §4/§8/§9): `atiende-fusion` HOY no tiene la
-- extensión `supabase_vault`/`pgsodium` habilitada en ningún vertical — Fase 3 de
-- citas es la PRIMERA vez que este monorepo necesita un secreto real por-fila
-- (cada proveedor trae su propio refresh token; los secretos de Meta/WhatsApp son
-- de plataforma completa, vía variable de entorno, no por-tenant). Habilitar esa
-- extensión en el proyecto Postgres real es un paso de INFRAESTRUCTURA de
-- despliegue, no de este archivo — estas dos funciones son código real y completo,
-- pero solo se ejecutan sin error una vez que `vault`/`pgsodium` estén habilitados
-- ahí. `resolveProviderCalendarRefreshToken` (postgres-repository.ts) ya trata
-- cualquier fallo de esta RPC exactamente igual que "proveedor sin conectar":
-- null, nunca una excepción que tumbe la reconciliación completa.
-- ============================================================================

create or replace function citas.set_provider_calendar_refresh_token(p_secret_id uuid, p_refresh_token text)
returns uuid
language plpgsql
security definer
set search_path = citas, vault, public
as $$
declare
  v_id uuid;
begin
  if p_refresh_token is null or length(p_refresh_token) = 0 then
    raise exception 'refresh_token vacío' using errcode = 'AT400';
  end if;
  if p_secret_id is null then
    v_id := vault.create_secret(p_refresh_token, 'citas_provider_calendar_refresh_token_' || gen_random_uuid()::text, 'Fase 3 citas — refresh token OAuth de Google Calendar de un provider_calendar_accounts.');
  else
    perform vault.update_secret(p_secret_id, p_refresh_token);
    v_id := p_secret_id;
  end if;
  return v_id;
end;
$$;

create or replace function citas.get_provider_calendar_refresh_token(p_secret_id uuid)
returns text
language plpgsql
security definer
set search_path = citas, vault, public
as $$
declare
  v_token text;
begin
  select decrypted_secret into v_token from vault.decrypted_secrets where id = p_secret_id;
  return v_token;
end;
$$;

revoke all on function citas.set_provider_calendar_refresh_token(uuid, text) from public, anon, authenticated;
grant execute on function citas.set_provider_calendar_refresh_token(uuid, text) to service_role;
revoke all on function citas.get_provider_calendar_refresh_token(uuid) from public, anon, authenticated;
grant execute on function citas.get_provider_calendar_refresh_token(uuid) to service_role;
