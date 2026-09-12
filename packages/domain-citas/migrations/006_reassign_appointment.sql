-- appointment_audit_events.event_type solo admitía 'rescheduled' (001) -- se
-- amplía para admitir el nuevo tipo de evento de esta fase.
alter table citas.appointment_audit_events drop constraint appointment_audit_events_event_type_check;
alter table citas.appointment_audit_events add constraint appointment_audit_events_event_type_check
  check (event_type in ('rescheduled', 'reassigned'));

-- Fase 4 -- "modificar-cita": cambio de proveedor y/o servicio de una cita
-- existente SIN tocar el horario de inicio (starts_at se conserva; ends_at se
-- recalcula desde la duración del servicio final, que puede ser el mismo o uno
-- nuevo). Explícitamente diferido desde Fase 1 (packages/domain-citas/README.md
-- "modificar-cita (cambio de proveedor/servicio sin tocar horario, sigue fuera)"),
-- nunca construido en Fase 2/3.
--
-- Mismo patrón EXACTO que reschedule_appointment_idempotent (002/005): candado de
-- fila (`for update`), estados editables, verificación de reintento idempotente
-- no-op, UPDATE con manejo de `exclusion_violation`, evento de auditoría append-
-- only. La autoridad final anti-doble-reserva sigue siendo el mismo
-- `exclude using gist (provider_id with =, tstzrange(starts_at, ends_at) with &&)`
-- de 001_citas_schema.sql -- como el UPDATE de abajo toca `provider_id` en la
-- misma sentencia, Postgres revalida el traslape contra el PROVEEDOR NUEVO
-- automáticamente, sin lógica adicional.
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

revoke all on function citas.reassign_appointment_idempotent(uuid, uuid, uuid, uuid, timestamptz, text, text) from public, anon, authenticated;
grant execute on function citas.reassign_appointment_idempotent(uuid, uuid, uuid, uuid, timestamptz, text, text) to service_role;
