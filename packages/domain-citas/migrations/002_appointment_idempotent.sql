-- Port de las 3 RPC atómicas reales de citas-reservaciones (§3.3 del diseño):
-- create_appointment_idempotent (20260908010000_appointment_engine.sql),
-- cancel_appointment_idempotent + cancel_appointment_from_panel
-- (20260908010000/20260908040000), reschedule_appointment_idempotent +
-- appointment_audit_events (20260908060000_reschedule_modify_and_audit.sql).
--
-- Cambio real necesario (no cosmético): `tenant_id` -> `organization_id`,
-- `is_tenant_staff(auth.uid(), p_tenant_id)` -> `exists (... core.membership ...)`.
-- El EXCLUDE USING gist (creado en 001) y el pg_advisory_xact_lock se preservan
-- EXACTAMENTE iguales — es la pieza que no debe tocarse (ver diseño §3.3).
--
-- modify_appointment_idempotent NO se porta: `modificar-cita` queda fuera de Fase 1
-- (ver diseño §6/§8) — comparte pipeline con reagendar sin agregar riesgo de
-- negocio distinto.

-- ============================================================================
-- create_appointment_idempotent
-- ============================================================================

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

revoke all on function citas.create_appointment_idempotent(jsonb, text, text) from public, anon, authenticated;
grant execute on function citas.create_appointment_idempotent(jsonb, text, text) to service_role;

-- ============================================================================
-- cancel_appointment_idempotent — usado por el agente (voz/WhatsApp), sin
-- auth.uid() real (ver diseño §5.2: la ruta ya autoriza vía x-atiende-tool-secret).
-- ============================================================================

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

  update citas.appointments set status = 'cancelled'
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.cancel_appointment_idempotent(uuid, uuid) from public, anon, authenticated;
grant execute on function citas.cancel_appointment_idempotent(uuid, uuid) to service_role;

-- ============================================================================
-- cancel_appointment_from_panel — equivalente para staff real desde el panel.
-- El origen exige is_tenant_staff() SIN distinguir rol (ver diseño §4/§5.2: el
-- origen no restringe por rol quién cancela desde el panel) — aquí el check
-- equivalente es "cualquier fila de core.membership para esta organización", el
-- mismo criterio de "cualquier miembro, sin importar platformRole". La ruta Hono ya
-- verificó requirePropertyMembership(propertyId) ANTES de llamar aquí (defensa en
-- profundidad, no la única capa — ver core-auth/src/middleware.ts).
-- ============================================================================

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

  update citas.appointments set status = 'cancelled'
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.cancel_appointment_from_panel(uuid, uuid) from public, anon;
grant execute on function citas.cancel_appointment_from_panel(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- reschedule_appointment_idempotent — único punto real de cambio de
-- starts_at/ends_at de una cita YA existente. Conserva el mismo appointment.id
-- (nunca inserta una fila nueva) — así el historial de auditoría y los
-- recordatorios ya enviados siguen apuntando a la misma cita.
-- ============================================================================

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

revoke all on function citas.reschedule_appointment_idempotent(uuid, uuid, timestamptz, timestamptz, text, text) from public, anon, authenticated;
grant execute on function citas.reschedule_appointment_idempotent(uuid, uuid, timestamptz, timestamptz, text, text) to service_role;
