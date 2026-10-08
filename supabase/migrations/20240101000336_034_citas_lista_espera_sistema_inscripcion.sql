-- QA R1 features-12 (corrección tras revisión): inscribir a un cliente en la lista de espera DESDE EL AGENTE (herramienta `anotar_lista_espera` de
-- WhatsApp y voz).
--
-- Causa raíz: el agente corre en la sesión de SISTEMA, que NO es `service_role` ni tiene BYPASSRLS: es el rol `authenticated` con `auth.uid()` NULL
-- (`set local role authenticated` con sub vacío, managed-postgres-engine.ts), y por tanto sujeto a RLS. `citas.appointment_waitlist` solo tiene la
-- política de STAFF (003: `for all ... using/with check (membership con auth.uid())`), que nunca aplica con `auth.uid()` NULL (mismo hallazgo que ya
-- documenta 020_appointment_waitlist_sistema_lectura.sql para el SELECT): los SELECT de idempotencia y de tope devolvían 0 filas en silencio y el
-- INSERT fallaba con 42501.
--
-- Diseño (misma plantilla que 020): una función `security definer` de SOLO-SISTEMA, en vez de ampliar la política `for all` de staff (eso daría también
-- update/delete a la sesión de sistema, que hoy están correctamente reservados al panel). La función hace TODA la inscripción en una sola llamada:
-- idempotencia, tope por teléfono e INSERT, y los serializa con un lock consultivo de transacción por (organización, teléfono), de modo que dos
-- inscripciones concurrentes del mismo número no duplican la anotación ni rebasan el tope.
--
-- Justificación de seguridad de cada pieza:
--   * `security definer` + `set search_path = citas, pg_temp` fijo: sin secuestro de nombres no calificados.
--   * Guard `auth.uid() is null` (42501 si no): una sesión de staff o de un usuario final NO puede invocarla; el panel sigue usando la política de
--     staff directamente. Mismo patrón que `citas.system_load_live_waitlist_candidates` (020) y `citas.claim_waitlist_notification_slot` (015).
--   * `revoke all ... from public, anon, authenticated` y `grant execute ... to authenticated`: la sesión de sistema es el rol `authenticated`, por eso se
--     le concede EXECUTE; `anon` nunca. El guard de `auth.uid()` es lo que la restringe a sistema.
--   * No hay GRANT nuevo sobre la tabla ni política nueva: no se amplía ningún acceso directo a `citas.appointment_waitlist`.
--   * Defensa en profundidad en el cuerpo: el proveedor y el servicio, si vienen, deben ser de la organización dada (AT404 si no); el teléfono no
--     puede estar vacío ni pasar de 32 caracteres; el tope debe estar entre 1 y 50. Cross-tenant: toda lectura y el INSERT están acotados a
--     `p_organization_id`, y un cliente de otra organización con el mismo teléfono no cuenta ni se devuelve.
--   * Devuelve solo las columnas que el agente y `WaitlistCandidateRow` ya usan (nunca `status`/`expires_at`/`organization_id`).
--
-- Orden de despliegue: código y migración son independientes en ambas direcciones. Si el código se despliega ANTES que esta migración, la llamada cae
-- (SAVEPOINT + SQLSTATE 42883) a "lista de espera no disponible aún" y el agente lo dice con honestidad; aplicar esta migración es lo que activa la
-- inscripción desde WhatsApp y voz.
create or replace function citas.system_enroll_waitlist(
  p_organization_id uuid,
  p_customer_phone text,
  p_customer_name text,
  p_provider_id uuid,
  p_service_id uuid,
  p_preferred_date_from date,
  p_preferred_date_to date,
  p_preferred_time_window text,
  p_max_active integer
)
returns table (
  out_outcome text,
  out_id uuid,
  out_customer_phone text,
  out_customer_name text,
  out_notified_count integer,
  out_provider_id uuid,
  out_service_id uuid,
  out_preferred_date_from text,
  out_preferred_date_to text,
  out_preferred_time_window text,
  out_created_at timestamptz
)
language plpgsql
security definer
set search_path = citas, pg_temp
as $$
declare
  v_row citas.appointment_waitlist;
  v_active integer;
begin
  if auth.uid() is not null then
    raise exception 'system_enroll_waitlist es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_customer_phone is null or btrim(p_customer_phone) = '' or length(p_customer_phone) > 32 then
    raise exception 'organización y teléfono (máximo 32 caracteres) son requeridos' using errcode = 'AT400';
  end if;
  if p_max_active is null or p_max_active < 1 or p_max_active > 50 then
    raise exception 'tope de anotaciones fuera de rango' using errcode = 'AT400';
  end if;
  if p_provider_id is not null and not exists (select 1 from citas.providers p where p.id = p_provider_id and p.organization_id = p_organization_id) then
    raise exception 'proveedor no encontrado' using errcode = 'AT404';
  end if;
  if p_service_id is not null and not exists (select 1 from citas.services s where s.id = p_service_id and s.organization_id = p_organization_id) then
    raise exception 'servicio no encontrado' using errcode = 'AT404';
  end if;

  -- Serializa inscripciones del mismo (organización, teléfono): el chequeo, el conteo y el INSERT de abajo ya no admiten carreras.
  perform pg_advisory_xact_lock(hashtextextended('citas.waitlist:' || p_organization_id::text || ':' || p_customer_phone, 0));

  select * into v_row
  from citas.appointment_waitlist w
  where w.organization_id = p_organization_id and w.customer_phone = p_customer_phone and w.status = 'active' and w.expires_at > now()
    and w.provider_id is not distinct from p_provider_id and w.service_id is not distinct from p_service_id
    and w.preferred_date_from is not distinct from p_preferred_date_from and w.preferred_date_to is not distinct from p_preferred_date_to
    and w.preferred_time_window = p_preferred_time_window
  order by w.created_at asc
  limit 1;

  if found then
    out_outcome := 'already_waiting';
  else
    select count(*) into v_active
    from citas.appointment_waitlist w
    where w.organization_id = p_organization_id and w.customer_phone = p_customer_phone and w.status = 'active' and w.expires_at > now();
    if v_active >= p_max_active then
      out_outcome := 'too_many';
      return next;
      return;
    end if;
    insert into citas.appointment_waitlist (organization_id, customer_phone, customer_name, provider_id, service_id, preferred_date_from, preferred_date_to, preferred_time_window)
    values (p_organization_id, p_customer_phone, p_customer_name, p_provider_id, p_service_id, p_preferred_date_from, p_preferred_date_to, p_preferred_time_window)
    returning * into v_row;
    out_outcome := 'created';
  end if;

  out_id := v_row.id;
  out_customer_phone := v_row.customer_phone;
  out_customer_name := v_row.customer_name;
  out_notified_count := v_row.notified_count;
  out_provider_id := v_row.provider_id;
  out_service_id := v_row.service_id;
  out_preferred_date_from := v_row.preferred_date_from::text;
  out_preferred_date_to := v_row.preferred_date_to::text;
  out_preferred_time_window := v_row.preferred_time_window;
  out_created_at := v_row.created_at;
  return next;
end;
$$;

revoke all on function citas.system_enroll_waitlist(uuid, text, text, uuid, uuid, date, date, text, integer) from public, anon, authenticated;
grant execute on function citas.system_enroll_waitlist(uuid, text, text, uuid, uuid, date, date, text, integer) to authenticated;
