-- Fase 7 — transición de estado confirmar/completar/no-show desde el panel de
-- staff (gap real de auditoría: el repo original — citas-reservaciones/src/
-- components/admin/AgendaSection.tsx, funciones confirmarCita/completarCita y un
-- update directo a status:'no_show' — deja marcar una cita como confirmada,
-- completada o no-show; en esta rama el esquema YA preservaba esos 3 estados
-- (001_citas_schema.sql: `status in ('pending','confirmed','completed','cancelled',
-- 'no_show')`) pero ninguna función/ruta los escribía jamás — una cita nunca salía
-- de 'pending'/'confirmed' aunque el cliente hubiera asistido, lo que rompía
-- reportes y el estado real de la agenda.
--
-- Mismo patrón EXACTO que cancel_appointment_from_panel (002): candado de fila
-- (`for update`), check de membership de staff SIN distinguir rol (mismo criterio
-- que 002/006 — el origen no restringe por rol quién opera el panel), no-op
-- idempotente si ya está en el estado destino, AT409 si el estado actual no admite
-- esa transición, AT404 si la cita no existe/no es de esta organización. A
-- diferencia de cancel (que no auditaba), aquí SÍ se registra un evento de
-- auditoría por transición — es justo el estado que los reportes necesitan poder
-- reconstruir (motivo real de este gap).

-- appointment_audit_events.event_type admitía 'rescheduled'/'reassigned' (001/006)
-- -- se amplía para las 3 transiciones nuevas.
alter table citas.appointment_audit_events drop constraint appointment_audit_events_event_type_check;
alter table citas.appointment_audit_events add constraint appointment_audit_events_event_type_check
  check (event_type in ('rescheduled', 'reassigned', 'confirmed', 'completed', 'no_show'));

-- ============================================================================
-- confirm_appointment_from_panel — pending -> confirmed. Idempotente si ya estaba
-- confirmed. Solo pending/confirmed son transiciones válidas de origen (una cita
-- completed/cancelled/no_show ya es un estado terminal para "confirmar").
-- ============================================================================

create or replace function citas.confirm_appointment_from_panel(
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

  if v_appointment.status = 'confirmed' then
    return to_jsonb(v_appointment); -- ya confirmada: no-op idempotente
  end if;

  if v_appointment.status <> 'pending' then
    raise exception 'No se puede confirmar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  update citas.appointments set status = 'confirmed'
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  insert into citas.appointment_audit_events (
    organization_id, appointment_id, event_type, actor_channel, actor_note, previous_data, new_data
  ) values (
    p_organization_id, p_appointment_id, 'confirmed', 'panel', null,
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'confirmed')
  );

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.confirm_appointment_from_panel(uuid, uuid) from public, anon;
grant execute on function citas.confirm_appointment_from_panel(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- complete_appointment_from_panel — pending/confirmed -> completed. Idempotente si
-- ya estaba completed. Una cita cancelled/no_show ya es terminal en otro sentido —
-- nunca se "completa" después de eso.
-- ============================================================================

create or replace function citas.complete_appointment_from_panel(
  p_organization_id uuid,
  p_appointment_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_appointment citas.appointments;
  v_previous_status text;
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

  if v_appointment.status = 'completed' then
    return to_jsonb(v_appointment); -- ya completada: no-op idempotente
  end if;

  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'No se puede completar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  -- Capturado ANTES del UPDATE a propósito: el UPDATE...RETURNING de abajo
  -- sobreescribe v_appointment con el estado NUEVO, así que leerlo después ya
  -- no serviría para el previous_data del evento de auditoría (mismo motivo que
  -- RescheduleOutcome.previousStartsAt en appointments.ts).
  v_previous_status := v_appointment.status;

  update citas.appointments set status = 'completed'
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  insert into citas.appointment_audit_events (
    organization_id, appointment_id, event_type, actor_channel, actor_note, previous_data, new_data
  ) values (
    p_organization_id, p_appointment_id, 'completed', 'panel', null,
    jsonb_build_object('status', v_previous_status),
    jsonb_build_object('status', 'completed')
  );

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.complete_appointment_from_panel(uuid, uuid) from public, anon;
grant execute on function citas.complete_appointment_from_panel(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- mark_appointment_no_show_from_panel — pending/confirmed -> no_show. Idempotente
-- si ya estaba no_show. A diferencia de 'completed', 'no_show' SÍ queda fuera del
-- EXCLUDE using gist (`where status in ('pending','confirmed','completed')` en
-- 001_citas_schema.sql) -- marcar no-show libera de inmediato el horario del
-- proveedor para una nueva reserva, sin lógica adicional aquí (la exclusión ya lo
-- resuelve solo).
-- ============================================================================

create or replace function citas.mark_appointment_no_show_from_panel(
  p_organization_id uuid,
  p_appointment_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_appointment citas.appointments;
  v_previous_status text;
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

  if v_appointment.status = 'no_show' then
    return to_jsonb(v_appointment); -- ya marcada no_show: no-op idempotente
  end if;

  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'No se puede marcar como no-show una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  -- Capturado ANTES del UPDATE — misma nota que complete_appointment_from_panel.
  v_previous_status := v_appointment.status;

  update citas.appointments set status = 'no_show'
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  insert into citas.appointment_audit_events (
    organization_id, appointment_id, event_type, actor_channel, actor_note, previous_data, new_data
  ) values (
    p_organization_id, p_appointment_id, 'no_show', 'panel', null,
    jsonb_build_object('status', v_previous_status),
    jsonb_build_object('status', 'no_show')
  );

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.mark_appointment_no_show_from_panel(uuid, uuid) from public, anon;
grant execute on function citas.mark_appointment_no_show_from_panel(uuid, uuid) to authenticated, service_role;
