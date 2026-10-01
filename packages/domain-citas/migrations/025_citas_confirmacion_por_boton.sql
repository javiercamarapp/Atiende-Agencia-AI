-- C-01 (citas) — confirmación de una cita por el CLIENTE desde el botón "Confirmar"
-- del recordatorio de WhatsApp (el webhook entrante corre en sesión de SISTEMA:
-- `auth.uid()` es null, Meta no manda ningún usuario autenticado).
--
-- Por qué hace falta una función nueva: la única función que pasa una cita de
-- 'pending' a 'confirmed' es `citas.confirm_appointment_from_panel` (010), que exige
-- membership de STAFF (`auth.uid()` real) y por tanto rechaza SIEMPRE a la sesión de
-- sistema del webhook. No se abre ningún GRANT/policy nuevo sobre `citas.appointments`
-- (sigue sin UPDATE directo para nadie): solo una función `security definer`
-- acotada a UNA transición.
--
-- Qué agrega: `citas.system_confirm_appointment_by_customer(p_organization_id,
-- p_appointment_id, p_customer_phone)`.
--
-- Justificación de seguridad:
--   * SOLO-SISTEMA: guard `auth.uid() is not null` -> 42501. Un staff o un usuario
--     autenticado no puede llamarla (para eso existe la variante _from_panel).
--   * `security definer` con `set search_path = citas, pg_temp` y REVOKE de
--     public/anon; EXECUTE solo para `authenticated` (la sesión de sistema del
--     webhook corre con ese rol y `auth.uid()` null, mismo mecanismo que 021/022/024)
--     y `service_role`. anon NO tiene EXECUTE.
--   * Autorización por TITULARIDAD, no por id adivinable: la cita solo se confirma si
--     su cliente (`citas.customers`) tiene EXACTAMENTE el teléfono `p_customer_phone`
--     de la misma organización. El teléfono lo pone el servidor desde el remitente
--     autenticado por Meta (HMAC), nunca desde el texto del mensaje. Cualquier otra
--     combinación (cita de otra organización, de otro cliente, inexistente) responde
--     igual: AT404, sin revelar si la cita existe.
--   * Idempotente y anti-replay: una cita ya 'confirmed' devuelve la fila sin
--     cambios (no duplica auditoría); solo 'pending' transiciona; cualquier otro
--     estado (cancelled/completed/no_show) o una cita cuyo horario ya pasó -> AT409.
--     Un toque repetido o un botón viejo nunca "resucita" nada.
--   * Candado de fila (`for update`) para que dos toques simultáneos no dupliquen la
--     auditoría.
--   * Bitácora: inserta 'confirmed' en `citas.appointment_audit_events` con
--     actor_channel 'whatsapp' (el CHECK de 010 ya admite 'confirmed').
--
-- Compatibilidad con la base sin migrar: el código TypeScript captura 42883 con
-- SAVEPOINT (`runWithSavepointFallback`) y responde de forma honesta sin confirmar
-- ("lo registramos como pendiente, el negocio lo verá") -- esta migración NO se aplica
-- automáticamente al mergear. Cancelar/Reagendar por botón NO la necesitan (usan
-- `cancel_appointment_idempotent`/el agente, ya existentes).
--
-- Requiere: 010_appointment_status_transitions.sql (CHECK de audit event_type).

create or replace function citas.system_confirm_appointment_by_customer(
  p_organization_id uuid,
  p_appointment_id uuid,
  p_customer_phone text
) returns jsonb
language plpgsql
security definer
set search_path = citas, pg_temp
as $$
declare
  v_appointment citas.appointments;
begin
  if auth.uid() is not null then
    raise exception 'system_confirm_appointment_by_customer es solo para la sesión de sistema' using errcode = '42501';
  end if;

  if p_organization_id is null or p_appointment_id is null or p_customer_phone is null or length(btrim(p_customer_phone)) = 0 then
    raise exception 'parámetros requeridos' using errcode = 'AT400';
  end if;

  select a.* into v_appointment
  from citas.appointments a
  join citas.customers c on c.id = a.customer_id and c.organization_id = a.organization_id
  where a.id = p_appointment_id
    and a.organization_id = p_organization_id
    and c.phone = p_customer_phone
  for update of a;

  if v_appointment.id is null then
    raise exception 'Cita no encontrada' using errcode = 'AT404';
  end if;

  if v_appointment.status = 'confirmed' then
    return to_jsonb(v_appointment); -- ya confirmada: no-op idempotente (toque repetido / reintento)
  end if;

  if v_appointment.status <> 'pending' then
    raise exception 'No se puede confirmar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

  if v_appointment.starts_at <= now() then
    raise exception 'La cita ya pasó' using errcode = 'AT409';
  end if;

  update citas.appointments set status = 'confirmed'
  where id = v_appointment.id and organization_id = p_organization_id
  returning * into v_appointment;

  insert into citas.appointment_audit_events (
    organization_id, appointment_id, event_type, actor_channel, actor_note, previous_data, new_data
  ) values (
    p_organization_id, v_appointment.id, 'confirmed', 'whatsapp', 'confirmada por el cliente con el boton del recordatorio',
    jsonb_build_object('status', 'pending'),
    jsonb_build_object('status', 'confirmed')
  );

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.system_confirm_appointment_by_customer(uuid, uuid, text) from public, anon, authenticated;
grant execute on function citas.system_confirm_appointment_by_customer(uuid, uuid, text) to authenticated, service_role;
