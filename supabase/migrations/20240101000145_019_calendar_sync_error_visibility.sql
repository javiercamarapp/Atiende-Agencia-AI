-- Fase 6 §2 (seguimiento, "citas-sync-errores-visibles") — cierra el hueco real
-- que el autor del PR #135 dejó documentado: cuando Cal.com/CalDAV/Google
-- rechazan un booking por una validación PERMANENTE (p.ej. Cal.com exige
-- `attendeeEmail` y esta cita no lo tiene), el motor lo trataba igual que un
-- fallo transitorio -- reintentaba con backoff hasta agotar 5 intentos y luego
-- quedaba en 'error' indistinguible de "el proveedor cayó" -- sin marcar nada en
-- la cuenta (correcto: la credencial sigue sirviendo) y sin que el staff viera
-- NADA distinto en el panel ("Calendarios conectados" seguía diciendo
-- "Conectado" mientras la cita nunca se sincronizaba). Ver diseño real en
-- ../src/calendar-sync.ts (isPermanentValidationError/markAppointmentGoogleSyncInvalid).
--
-- Tres cambios de esquema, los tres mínimos e imprescindibles:
--   1. `'invalid'` como valor nuevo de `google_sync_status` -- estado FINAL legible
--      y distinto de 'error' (backoff agotado, un reintento SÍ podía funcionar) y
--      de 'skipped' (sin calendario conectado). Nunca se reintenta solo.
--   2. `citas.retry_appointment_calendar_sync_from_panel` -- el botón "reintentar
--      sincronización" del panel: solo transiciona una cita 'invalid' de vuelta a
--      'pending' (attempts=0) para que el próximo best-effort la recoja con los
--      datos ya corregidos.
--   3. `citas.update_customer_email_from_panel` -- `citas.customers.email` existe
--      desde 001_citas_schema.sql (columna nullable, nunca obligatoria) pero
--      nunca era editable después de la primera reserva del cliente; sin esto,
--      un cliente creado SIN correo por voz/WhatsApp (el caso normal) no tenía
--      forma de que el staff se lo agregara para resolver el caso de arriba.
--
-- Ninguna columna nueva NOT NULL, ningún default inseguro, ninguna policy/RLS de
-- `citas.appointments`/`citas.customers` tocada -- ambas funciones son
-- `security definer` con el MISMO guard de membership que
-- `confirm_appointment_from_panel`/`create_appointment_from_panel`
-- (015_property_scoped_panel_access.sql), otorgadas a `authenticated` (nunca solo
-- `service_role`) porque su único caller real es el staff autenticado del panel.

-- ============================================================================
-- 1. 'invalid' -- nuevo estado FINAL de google_sync_status.
-- ============================================================================

alter table citas.appointments drop constraint appointments_google_sync_status_check;
alter table citas.appointments add constraint appointments_google_sync_status_check
  check (google_sync_status in ('pending', 'synced', 'error', 'skipped', 'pending_cancel', 'deleted', 'invalid'));

-- Mismo criterio que appointments_pending_google_sync_idx (005_google_calendar_sync.sql):
-- el panel/la ficha de proveedor cuentan cuántas citas de UN proveedor están en
-- 'invalid' ahora mismo (ver loadProviderCalendarSyncIssues) -- un índice parcial
-- por provider_id evita un seq scan conforme crece la tabla.
create index appointments_invalid_google_sync_idx
  on citas.appointments (provider_id)
  where google_sync_status = 'invalid';

-- ============================================================================
-- 2. Botón "reintentar sincronización" del panel.
-- ============================================================================

create or replace function citas.retry_appointment_calendar_sync_from_panel(
  p_organization_id uuid,
  p_appointment_id uuid
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_appointment citas.appointments;
  v_retried boolean;
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

  if not citas.membership_covers_property(p_organization_id, v_appointment.property_id) then
    raise exception 'No tienes acceso a la sucursal de esta cita' using errcode = 'AT403';
  end if;

  -- A diferencia de confirmar/completar/marcar no-show (que SÍ raisean AT409 por
  -- conflicto de estado): aquí el estado real de google_sync_status importa para
  -- el mensaje que ve el staff (¿por qué no se puede reintentar?), así que se
  -- devuelve la fila TAL CUAL con retried=false en vez de perder esa información
  -- en una excepción genérica -- el caller de TypeScript (postgres-repository.ts)
  -- ya lee el google_sync_status real de la respuesta.
  if v_appointment.google_sync_status <> 'invalid' then
    return jsonb_build_object('retried', false, 'appointment', to_jsonb(v_appointment));
  end if;

  update citas.appointments set
    google_sync_status = 'pending',
    google_sync_attempts = 0,
    google_sync_next_retry_at = null,
    google_sync_error = null
  where id = p_appointment_id and organization_id = p_organization_id
  returning * into v_appointment;

  v_retried := true;
  return jsonb_build_object('retried', v_retried, 'appointment', to_jsonb(v_appointment));
end;
$$;

revoke all on function citas.retry_appointment_calendar_sync_from_panel(uuid, uuid) from public, anon;
grant execute on function citas.retry_appointment_calendar_sync_from_panel(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- 3. Captura/edición del correo OPCIONAL de un cliente ya existente.
-- ============================================================================

create or replace function citas.update_customer_email_from_panel(
  p_organization_id uuid,
  p_customer_id uuid,
  p_email text
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_customer citas.customers;
begin
  -- Igual que retry_appointment_calendar_sync_from_panel: un staff que no
  -- pertenece a p_organization_id nunca puede editar nada aquí. A diferencia de
  -- las citas, `citas.customers` no tiene property_id (es de toda la
  -- organización, ver 001_citas_schema.sql) -- no hay un segundo check de
  -- sucursal que hacer. Devuelve null (nunca raisea AT403) para que el
  -- adaptador de TypeScript lo trate igual que "cliente no encontrado" -- el
  -- único caller real (POST .../customers/:customerId, requirePropertyMembership)
  -- ya resuelve p_organization_id del lado del servidor a partir de la sesión
  -- del staff, así que este caso es defensa en profundidad, no un flujo real.
  if not exists (select 1 from core.membership m where m.organization_id = p_organization_id and m.user_id = auth.uid()) then
    return null;
  end if;

  update citas.customers set email = nullif(trim(coalesce(p_email, '')), ''), updated_at = now()
  where id = p_customer_id and organization_id = p_organization_id
  returning * into v_customer;

  if v_customer.id is null then
    return null;
  end if;

  return to_jsonb(v_customer);
end;
$$;

revoke all on function citas.update_customer_email_from_panel(uuid, uuid, text) from public, anon;
grant execute on function citas.update_customer_email_from_panel(uuid, uuid, text) to authenticated, service_role;
