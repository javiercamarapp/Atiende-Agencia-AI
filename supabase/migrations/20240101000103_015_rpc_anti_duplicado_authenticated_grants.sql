-- Hallazgo de auditoría (severidad CRÍTICA/ALTA, "21 RPC anti-duplicado sin GRANT
-- EXECUTE para authenticated en citas/hoteles/restaurantes"): mismo bug raíz que
-- las migraciones 014_email_outbox_authenticated_grants.sql (citas)/
-- 016_email_outbox_authenticated_grants.sql (hoteles)/
-- 012_email_outbox_authenticated_grants.sql (restaurantes) ya cerraron para el
-- outbox de correo — `packages/db/src/managed-postgres-engine.ts::withAppSession`
-- SIEMPRE conecta como `set local role authenticated` (con o sin `auth.uid()` real),
-- este monorepo nunca aprovisiona `service_role` contra Postgres real (ver el
-- comentario de cabecera de esas 3 migraciones, sigue vigente) — así que CUALQUIER
-- función `security definer` cuyo único GRANT EXECUTE sea a `service_role` es
-- literalmente inalcanzable en producción, sin importar qué tan buena sea su lógica
-- interna.
--
-- Verificado con `grep -rn "revoke all on function" packages/domain-citas/migrations`
-- + cruce contra `grep -rn "grant execute.*to authenticated"`: las 10 funciones de
-- abajo (creadas en 002/003/004/005/006, todas `security definer`) hacen
-- exactamente `revoke all ... from public, anon, authenticated; grant execute ...
-- to service_role;` -- nunca reciben el GRANT a `authenticated` de vuelta. Cruce
-- confirmado contra Postgres real (instancia efímera, las 95 migraciones previas
-- aplicadas primero, sin ningún paso manual fuera de este repo): las 10 fallan con
-- "permission denied for function ..." bajo `set role authenticated;` incluso con
-- `auth.uid()` null (sesión de sistema).
--
-- Motivo por el que nunca se notó en los tests: `tests/` usa el repositorio EN
-- MEMORIA (`InMemoryCitasRepository`), que no pasa por Postgres/RLS -- el bug
-- SOLO existe contra Postgres real, igual que el hallazgo de las migraciones
-- 86-91 que esta migración replica.
--
-- Dos familias, mismo remedio (se conserva `security definer`, se agrega el GRANT
-- EXECUTE real a `authenticated`, y cada función repone la verificación de acceso
-- que la policy de RLS bypasseada habría exigido -- nunca un GRANT plano sin
-- reponer esa verificación):
--
-- FAMILIA A -- "solo sesión de sistema" (verificado con `grep -rn` sobre
-- `apps/api/src/routes/verticals/citas`: las 4 llamadas reales -- `appointments.ts`
-- (crear), `appointments-lifecycle.ts` (cancelar/reagendar/reasignar vía el agente
-- de voz/WhatsApp, guardadas por `x-atiende-tool-secret`, NUNCA por
-- `authMiddleware`) -- todas abren `deps.engine.withAppSession({ userId: null },
-- ...)`; el equivalente de staff real ya existe aparte y YA tenía su GRANT
-- correcto -- `cancel_appointment_from_panel`/`confirm_appointment_from_panel`/
-- `complete_appointment_from_panel`/`mark_appointment_no_show_from_panel`
-- (002/010), sin tocar):
--   - create_appointment_idempotent (002)
--   - cancel_appointment_idempotent (002/005)
--   - reschedule_appointment_idempotent (002/005)
--   - reassign_appointment_idempotent (006)
--
-- FAMILIA B -- también "solo sesión de sistema" (verificado que
-- `voice-tools.ts`/`whatsapp.ts`/`appointments.ts`/`appointments-lifecycle.ts` NUNCA
-- las llaman desde una ruta con `authMiddleware` montado -- siempre
-- `withAppSession({ userId: null })`, el webhook de WhatsApp o el tool del agente de
-- voz, ninguno con `auth.uid()` real):
--   - claim_whatsapp_message / finish_whatsapp_message / whatsapp_append_turn /
--     append_whatsapp_user_message_once (004)
--   - claim_waitlist_notification_slot (003)
--   - consume_api_rate_limit (003)
--
-- Mismo criterio ya usado por `citas.claim_email_outbox_batch`/
-- `complete_email_outbox_job` (014): la verificación interna es
-- "auth.uid() is null" a secas (nunca alcanzable por un staff real con JWT), sin
-- el criterio adicional de membership que sí necesita `enqueue_messaging_outbox`
-- (esa SÍ la llaman también rutas de staff autenticado) -- ninguna de las 10 de
-- abajo tiene una sola ruta de staff que las invoque.

create or replace function citas.create_appointment_idempotent(
  p_appointment jsonb,
  p_dedupe_fingerprint text,
  p_idempotency_key text default null
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_appointment citas.appointments;
  v_organization_id uuid := (p_appointment->>'organization_id')::uuid;
begin
  if auth.uid() is not null then
    raise exception 'create_appointment_idempotent es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if v_organization_id is null then
    raise exception 'organization_id es requerido' using errcode = 'AT400';
  end if;
  if p_dedupe_fingerprint is null or p_dedupe_fingerprint !~ '^[0-9a-f]{64}$'
     or (p_idempotency_key is not null and p_idempotency_key !~ '^[0-9a-f]{64}$') then
    raise exception 'invalid idempotency input' using errcode = 'AT400';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(
    v_organization_id::text || ':' || coalesce(p_idempotency_key, p_dedupe_fingerprint),
    0
  ));

  if p_idempotency_key is not null then
    select * into v_appointment from citas.appointments
    where organization_id = v_organization_id and idempotency_key = p_idempotency_key
    limit 1;
    if v_appointment.id is not null
       and v_appointment.dedupe_fingerprint is distinct from p_dedupe_fingerprint then
      raise exception 'idempotency key was already used with different appointment data'
        using errcode = 'AT409';
    end if;
  else
    select * into v_appointment from citas.appointments
    where organization_id = v_organization_id
      and dedupe_fingerprint = p_dedupe_fingerprint
      and status in ('pending', 'confirmed')
      and created_at >= now() - interval '5 minutes'
    order by created_at desc
    limit 1;
  end if;

  if v_appointment.id is not null then
    return to_jsonb(v_appointment);
  end if;

  begin
    insert into citas.appointments (
      organization_id, property_id, provider_id, service_id, customer_id,
      starts_at, ends_at, status, source, notes,
      dedupe_fingerprint, idempotency_key
    ) values (
      v_organization_id,
      nullif(p_appointment->>'property_id', '')::uuid,
      (p_appointment->>'provider_id')::uuid,
      (p_appointment->>'service_id')::uuid,
      (p_appointment->>'customer_id')::uuid,
      (p_appointment->>'starts_at')::timestamptz,
      (p_appointment->>'ends_at')::timestamptz,
      coalesce(p_appointment->>'status', 'pending'),
      coalesce(p_appointment->>'source', 'manual'),
      nullif(p_appointment->>'notes', ''),
      p_dedupe_fingerprint,
      p_idempotency_key
    ) returning * into v_appointment;
  exception
    when exclusion_violation then
      raise exception 'El horario solicitado ya no está disponible para este proveedor.'
        using errcode = 'AT423';
  end;

  return to_jsonb(v_appointment);
end;
$$;

grant execute on function citas.create_appointment_idempotent(jsonb, text, text) to authenticated;

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
  if auth.uid() is not null then
    raise exception 'cancel_appointment_idempotent es solo para la sesión de sistema' using errcode = '42501';
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

  update citas.appointments set status = 'cancelled'
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  return to_jsonb(v_appointment);
end;
$$;

grant execute on function citas.cancel_appointment_idempotent(uuid, uuid) to authenticated;

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
  if auth.uid() is not null then
    raise exception 'reschedule_appointment_idempotent es solo para la sesión de sistema' using errcode = '42501';
  end if;

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
  -- idempotente real, sin duplicar el evento de auditoría.
  if v_appointment.starts_at = p_new_starts_at and v_appointment.ends_at = p_new_ends_at then
    return to_jsonb(v_appointment);
  end if;

  v_previous := jsonb_build_object('starts_at', v_appointment.starts_at, 'ends_at', v_appointment.ends_at);

  begin
    update citas.appointments set
      starts_at = p_new_starts_at,
      ends_at = p_new_ends_at,
      -- El recordatorio de 24h ya enviado (si lo había) era para el horario VIEJO —
      -- se limpia para que el cron de recordatorio vuelva a mandar uno correcto
      -- para el horario nuevo, nunca se queda sin recordatorio por haber reagendado.
      reminder_24h_sent_at = null
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

grant execute on function citas.reschedule_appointment_idempotent(uuid, uuid, timestamptz, timestamptz, text, text) to authenticated;

create or replace function citas.reassign_appointment_idempotent(
  p_organization_id uuid,
  p_appointment_id uuid,
  p_new_provider_id uuid,
  p_new_service_id uuid,
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
  if auth.uid() is not null then
    raise exception 'reassign_appointment_idempotent es solo para la sesión de sistema' using errcode = '42501';
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
    raise exception 'No se puede modificar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  if p_new_ends_at <= v_appointment.starts_at then
    raise exception 'ends_at debe ser posterior a starts_at' using errcode = 'AT400';
  end if;

  -- Reintento del mismo intento (mismo proveedor/servicio/ends_at ya vigentes):
  -- no-op idempotente real, sin duplicar el evento de auditoría.
  if v_appointment.provider_id = p_new_provider_id
     and v_appointment.service_id = p_new_service_id
     and v_appointment.ends_at = p_new_ends_at then
    return to_jsonb(v_appointment);
  end if;

  v_previous := jsonb_build_object('provider_id', v_appointment.provider_id, 'service_id', v_appointment.service_id, 'ends_at', v_appointment.ends_at);

  begin
    update citas.appointments set
      provider_id = p_new_provider_id,
      service_id = p_new_service_id,
      ends_at = p_new_ends_at,
      -- Mismo criterio que reagendar: el recordatorio de 24h ya enviado era para
      -- el proveedor/servicio/horario VIEJO -- se limpia para que el cron vuelva
      -- a evaluar y mandar uno correcto.
      reminder_24h_sent_at = null,
      -- Mismo criterio que reagendar: si ya había evento sincronizado en Google,
      -- una reasignación real (proveedor/servicio nuevo) debe volver a
      -- empujarlo -- se reinicia el backoff.
      google_sync_status = case when v_appointment.google_event_id is not null then 'pending' else google_sync_status end,
      google_sync_attempts = case when v_appointment.google_event_id is not null then 0 else google_sync_attempts end,
      google_sync_next_retry_at = case when v_appointment.google_event_id is not null then null else google_sync_next_retry_at end,
      google_sync_error = case when v_appointment.google_event_id is not null then null else google_sync_error end
    where id = p_appointment_id and organization_id = p_organization_id
    returning * into v_appointment;
  exception
    when exclusion_violation then
      raise exception 'El proveedor solicitado ya tiene una cita en ese horario.'
        using errcode = 'AT423';
  end;

  insert into citas.appointment_audit_events (
    organization_id, appointment_id, event_type, actor_channel, actor_note, previous_data, new_data
  ) values (
    p_organization_id, p_appointment_id, 'reassigned', p_actor_channel, p_actor_note,
    v_previous,
    jsonb_build_object('provider_id', v_appointment.provider_id, 'service_id', v_appointment.service_id, 'ends_at', v_appointment.ends_at)
  );

  return to_jsonb(v_appointment);
end;
$$;

grant execute on function citas.reassign_appointment_idempotent(uuid, uuid, uuid, uuid, timestamptz, text, text) to authenticated;

create or replace function citas.claim_waitlist_notification_slot(
  p_waitlist_id uuid,
  p_max_notifications integer default 3
) returns citas.appointment_waitlist
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_row citas.appointment_waitlist;
begin
  if auth.uid() is not null then
    raise exception 'claim_waitlist_notification_slot es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_waitlist_id is null or p_max_notifications < 1 then
    return null;
  end if;

  update citas.appointment_waitlist
  set notified_count = notified_count + 1,
      last_notified_at = now()
  where id = p_waitlist_id
    and status = 'active'
    and notified_count < p_max_notifications
  returning * into v_row;

  return v_row; -- null si ya no estaba 'active' o ya llegó al tope
end;
$$;

grant execute on function citas.claim_waitlist_notification_slot(uuid, integer) to authenticated;

create or replace function citas.consume_api_rate_limit(
  p_scope text, p_actor_hash text, p_max_requests integer, p_window_seconds integer
) returns boolean language plpgsql security definer set search_path = citas as $$
declare v_allowed boolean;
begin
  if auth.uid() is not null then
    raise exception 'consume_api_rate_limit es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_scope is null or p_actor_hash is null or p_max_requests < 1 or p_window_seconds < 1 then return false; end if;
  if length(p_scope) not between 1 and 120 or p_actor_hash !~ '^[0-9a-f]{64}$' then return false; end if;
  if random() < 0.01 then
    delete from citas.api_rate_limits where window_started_at < now() - interval '7 days';
  end if;
  insert into citas.api_rate_limits(scope, actor_hash, window_started_at, request_count)
  values (p_scope, p_actor_hash, now(), 1)
  on conflict (scope, actor_hash) do update set
    request_count = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then 1 else api_rate_limits.request_count + 1 end,
    window_started_at = case when now() - api_rate_limits.window_started_at >= make_interval(secs => p_window_seconds) then now() else api_rate_limits.window_started_at end
  returning request_count <= p_max_requests into v_allowed;
  return coalesce(v_allowed, false);
end; $$;

grant execute on function citas.consume_api_rate_limit(text, text, integer, integer) to authenticated;

create or replace function citas.whatsapp_append_turn(
  p_organization_id uuid,
  p_phone text,
  p_new_messages jsonb,
  p_status text default null,
  p_appointment_id uuid default null,
  p_property_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_messages jsonb;
begin
  if auth.uid() is not null then
    raise exception 'whatsapp_append_turn es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_phone is null or btrim(p_phone) = '' or jsonb_typeof(p_new_messages) <> 'array' then
    raise exception 'invalid whatsapp turn';
  end if;

  insert into citas.whatsapp_conversations (
    organization_id, phone, messages, status, appointment_id, property_id
  )
  values (
    p_organization_id,
    p_phone,
    p_new_messages,
    coalesce(p_status, 'active'),
    p_appointment_id,
    p_property_id
  )
  on conflict (organization_id, phone) do update
  set messages = whatsapp_conversations.messages || excluded.messages,
      status = coalesce(p_status, whatsapp_conversations.status),
      appointment_id = coalesce(p_appointment_id, whatsapp_conversations.appointment_id),
      property_id = coalesce(p_property_id, whatsapp_conversations.property_id),
      updated_at = now()
  returning messages into v_messages;

  return v_messages;
end;
$$;

grant execute on function citas.whatsapp_append_turn(uuid, text, jsonb, text, uuid, uuid) to authenticated;

create or replace function citas.append_whatsapp_user_message_once(
  p_organization_id uuid,
  p_message_id text,
  p_phone text,
  p_new_message jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
begin
  if auth.uid() is not null then
    raise exception 'append_whatsapp_user_message_once es solo para la sesión de sistema' using errcode = '42501';
  end if;

  return citas.whatsapp_append_turn(p_organization_id, p_phone, jsonb_build_array(p_new_message));
end;
$$;

grant execute on function citas.append_whatsapp_user_message_once(uuid, text, text, jsonb) to authenticated;

create or replace function citas.claim_whatsapp_message(
  p_organization_id uuid,
  p_message_id text,
  p_phone_hash text
) returns boolean
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_count integer;
begin
  if auth.uid() is not null then
    raise exception 'claim_whatsapp_message es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_message_id is null or length(p_message_id) not between 1 and 255 or p_phone_hash !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  insert into citas.whatsapp_inbound_events(message_id, organization_id, phone_hash)
  values (p_message_id, p_organization_id, p_phone_hash)
  on conflict (message_id) do update
    set status = 'processing',
        attempts = whatsapp_inbound_events.attempts + 1,
        claimed_at = now(),
        last_error_class = null
  where whatsapp_inbound_events.organization_id = excluded.organization_id
    and (
      whatsapp_inbound_events.status = 'failed'
      or (whatsapp_inbound_events.status = 'processing' and whatsapp_inbound_events.claimed_at < now() - interval '5 minutes')
    );
  get diagnostics v_count = row_count;
  return v_count = 1;
end;
$$;

grant execute on function citas.claim_whatsapp_message(uuid, text, text) to authenticated;

create or replace function citas.finish_whatsapp_message(
  p_organization_id uuid,
  p_message_id text,
  p_phone_hash text,
  p_status text,
  p_error_class text default null
) returns void
language plpgsql
security definer
set search_path = citas
as $$
begin
  if auth.uid() is not null then
    raise exception 'finish_whatsapp_message es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_status not in ('processed', 'failed') then raise exception 'invalid status'; end if;
  update citas.whatsapp_inbound_events
  set status = p_status,
      processed_at = case when p_status = 'processed' then now() else null end,
      last_error_class = left(p_error_class, 120)
  where message_id = p_message_id and organization_id = p_organization_id and phone_hash = p_phone_hash;
end;
$$;

grant execute on function citas.finish_whatsapp_message(uuid, text, text, text, text) to authenticated;
