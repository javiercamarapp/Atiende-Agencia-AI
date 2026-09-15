-- Fase 12 citas — hallazgo de auditoría (ALTO, "citas ignora :propertyId en su
-- scoping -- la RLS solo filtra por organización, así que un negocio con 2+
-- sucursales no puede operar correctamente"). Verificado contra
-- 001_citas_schema.sql/011_citas_admin_backoffice_grants_and_policies.sql/
-- 013_availability_rules_admin_grants_and_policies.sql: TODAS las policies de
-- escritura de staff (`citas.providers`/`property_config`/`provider_services`/
-- `availability_rules`/`availability_overrides`) y la única policy de lectura de
-- `citas.appointments` comparan ÚNICAMENTE `core.membership.organization_id` --
-- nunca `core.membership.property_ids` -- a diferencia de
-- `hoteles.can_access_money()` (001_hoteles_schema.sql) y
-- `rentas.can_read_finanzas`/`can_write_finanzas` (003_finanzas_schema.sql), que sí
-- exigen `(m.property_ids is null or _property_id = any(m.property_ids))`. Un staff
-- con `core.membership.property_ids` restringido a la sucursal A puede hoy leer/
-- editar proveedores, horarios, `property_config` y citas de la sucursal B de la
-- MISMA organización -- exactamente igual de laxo que si `property_ids` no
-- existiera. Las 4 RPC `*_from_panel` (002/010_appointment_*.sql) tienen el MISMO
-- gap por su propio lado: `security definer`, bypassean RLS por completo, y solo
-- verifican `exists (... core.membership ... organization_id ...)` -- nunca la
-- property de LA CITA que se está cancelando/confirmando/completando/marcando
-- no-show, así que ni siquiera arreglar la RLS de arriba las cubre.
--
-- `citas.providers.property_id`/`citas.appointments.property_id` son NULLABLE (un
-- negocio de una sola ubicación, caso común -- ver diseño Fase 1 §1/§5.1): una fila
-- sin sucursal asignada se sigue tratando como "visible/editable por cualquier
-- miembro de la organización", mismo criterio que YA aplican
-- `assertPropertyBelongsToOrganization`/el filtro de `GET .../admin/branches`
-- (apps/api/.../citas/admin.ts) del lado de la aplicación -- este archivo lo hace
-- real también del lado de Postgres.

-- ============================================================================
-- Helper reusado por todas las policies/RPC de abajo -- mismo principio que
-- hoteles.can_access_money()/rentas.can_read_finanzas(), generalizado para aceptar
-- un property_id NULL (ver nota de arriba).
-- ============================================================================
create or replace function citas.membership_covers_property(_organization_id uuid, _property_id uuid)
returns boolean
language sql
stable
security definer
set search_path = core, citas
as $$
  select exists (
    select 1 from core.membership m
    where m.organization_id = _organization_id
      and m.user_id = auth.uid()
      and (
        _property_id is null           -- fila sin sucursal asignada -- toda la org
        or m.property_ids is null       -- membership sin restricción -- toda la org
        or _property_id = any(m.property_ids)
      )
  )
$$;

revoke all on function citas.membership_covers_property(uuid, uuid) from public, anon;
grant execute on function citas.membership_covers_property(uuid, uuid) to authenticated, service_role;

-- ============================================================================
-- RLS -- reemplaza (drop + create) las policies org-only de 001/011/013 por la
-- versión property-scoped. Ningún GRANT de tabla se toca -- ya los otorgó 001/011/
-- 013 a `authenticated`; solo cambia QUÉ FILAS ve/edita cada policy.
-- ============================================================================

drop policy "staff gestiona proveedores de su organización" on citas.providers;
create policy "staff gestiona proveedores de su organización y sucursal" on citas.providers for all
  using (citas.membership_covers_property(providers.organization_id, providers.property_id))
  with check (citas.membership_covers_property(providers.organization_id, providers.property_id));

drop policy "staff gestiona property_config de su organización" on citas.property_config;
create policy "staff gestiona property_config de su organización y sucursal" on citas.property_config for all
  using (citas.membership_covers_property(property_config.organization_id, property_config.property_id))
  with check (citas.membership_covers_property(property_config.organization_id, property_config.property_id));

drop policy "staff ve citas de su organización" on citas.appointments;
create policy "staff ve citas de su organización y sucursal" on citas.appointments for select
  using (citas.membership_covers_property(appointments.organization_id, appointments.property_id));

drop policy "staff gestiona provider_services de su organización" on citas.provider_services;
create policy "staff gestiona provider_services de su organización y sucursal" on citas.provider_services for all
  using (exists (
    select 1 from citas.providers p
    where p.id = provider_services.provider_id and citas.membership_covers_property(p.organization_id, p.property_id)
  ))
  with check (exists (
    select 1 from citas.providers p
    where p.id = provider_services.provider_id and citas.membership_covers_property(p.organization_id, p.property_id)
  ));

drop policy "staff gestiona reglas de disponibilidad de su organización" on citas.availability_rules;
create policy "staff gestiona reglas de disponibilidad de su organización y sucursal" on citas.availability_rules for all
  using (exists (
    select 1 from citas.providers p
    where p.id = availability_rules.provider_id and citas.membership_covers_property(p.organization_id, p.property_id)
  ))
  with check (exists (
    select 1 from citas.providers p
    where p.id = availability_rules.provider_id and citas.membership_covers_property(p.organization_id, p.property_id)
  ));

drop policy "staff gestiona excepciones de disponibilidad de su organización" on citas.availability_overrides;
create policy "staff gestiona excepciones de disponibilidad de su organización y sucursal" on citas.availability_overrides for all
  using (exists (
    select 1 from citas.providers p
    where p.id = availability_overrides.provider_id and citas.membership_covers_property(p.organization_id, p.property_id)
  ))
  with check (exists (
    select 1 from citas.providers p
    where p.id = availability_overrides.provider_id and citas.membership_covers_property(p.organization_id, p.property_id)
  ));

drop policy "staff ve auditoría de citas de su organización" on citas.appointment_audit_events;
create policy "staff ve auditoría de citas de su organización y sucursal" on citas.appointment_audit_events for select
  using (exists (
    select 1 from citas.appointments a
    where a.id = appointment_audit_events.appointment_id and citas.membership_covers_property(a.organization_id, a.property_id)
  ));

-- ============================================================================
-- RPC `*_from_panel` -- `security definer`, bypassean la RLS de arriba por
-- completo, así que necesitan su PROPIO check de property. `create or replace`
-- preserva la firma exacta (mismos 2 argumentos) -- ningún caller de TS cambia.
-- Se agrega el check de property DESPUÉS de fijar la fila (`for update`), usando
-- el `property_id` real de la fila (nunca uno mandado por el cliente) -- el check
-- de organización de arriba (ya existía) se conserva intacto para no cambiar el
-- mensaje/comportamiento de "ni siquiera eres staff de este negocio".
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

  if not citas.membership_covers_property(p_organization_id, v_appointment.property_id) then
    raise exception 'No tienes acceso a la sucursal de esta cita' using errcode = 'AT403';
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

  if not citas.membership_covers_property(p_organization_id, v_appointment.property_id) then
    raise exception 'No tienes acceso a la sucursal de esta cita' using errcode = 'AT403';
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

  if not citas.membership_covers_property(p_organization_id, v_appointment.property_id) then
    raise exception 'No tienes acceso a la sucursal de esta cita' using errcode = 'AT403';
  end if;

  if v_appointment.status = 'completed' then
    return to_jsonb(v_appointment); -- ya completada: no-op idempotente
  end if;

  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'No se puede completar una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

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

  if not citas.membership_covers_property(p_organization_id, v_appointment.property_id) then
    raise exception 'No tienes acceso a la sucursal de esta cita' using errcode = 'AT403';
  end if;

  if v_appointment.status = 'no_show' then
    return to_jsonb(v_appointment); -- ya marcada no_show: no-op idempotente
  end if;

  if v_appointment.status not in ('pending', 'confirmed') then
    raise exception 'No se puede marcar como no-show una cita en estado %', v_appointment.status
      using errcode = 'AT409';
  end if;

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

-- Los 4 ya traían `revoke all ... from public, anon; grant execute ... to
-- authenticated, service_role;` desde 002/010 -- `create or replace function` no
-- toca privilegios, así que no hace falta repetirlos.

-- ============================================================================
-- Hallazgo de auditoría (ALTO, "Staff no puede crear citas manualmente desde la
-- Agenda") -- alta real de una cita desde el panel. A diferencia de
-- `create_appointment_idempotent` (002 -- agente/web, `security definer` pero
-- SOLO otorgada a `service_role`, que este monorepo no aprovisiona -- mismo
-- hallazgo raíz que 014_email_outbox_authenticated_grants.sql documenta para el
-- canal de correo, aquí NO se toca: sigue fuera del alcance de este cambio, ver
-- README de supabase/migrations entrada 86 para el patrón), esta función SÍ se
-- otorga real a `authenticated` desde el día uno -- staff autenticado real es su
-- ÚNICO caller previsto. Sin dedupe (acción deliberada de un clic, no un canal
-- reintentable) -- el único invariante real que nunca se salta es el EXCLUDE using
-- gist de 001_citas_schema.sql (AT423). `p_provider_id`/`p_service_id` ya se
-- validan del lado de TypeScript (`resolveProviderAndService`, activos y el
-- proveedor sí ofrece el servicio) antes de llegar aquí -- esta función solo
-- necesita el check de property (defensa real, no cosmética: SECURITY DEFINER
-- bypassea la RLS de `citas.providers` de arriba) + el alta atómica.
-- ============================================================================
create or replace function citas.create_appointment_from_panel(
  p_organization_id uuid,
  p_property_id uuid,
  p_provider_id uuid,
  p_service_id uuid,
  p_customer_name text,
  p_customer_phone text,
  p_customer_email text,
  p_starts_at timestamptz,
  p_ends_at timestamptz,
  p_notes text default null
) returns jsonb
language plpgsql
security definer
set search_path = citas
as $$
declare
  v_customer_id uuid;
  v_appointment citas.appointments;
begin
  if p_ends_at <= p_starts_at then
    raise exception 'ends_at debe ser posterior a starts_at' using errcode = 'AT400';
  end if;
  if p_customer_phone is null or length(trim(p_customer_phone)) = 0 then
    raise exception 'customer_phone es requerido' using errcode = 'AT400';
  end if;
  if p_customer_name is null or length(trim(p_customer_name)) = 0 then
    raise exception 'customer_name es requerido' using errcode = 'AT400';
  end if;

  if not citas.membership_covers_property(p_organization_id, p_property_id) then
    raise exception 'No tienes acceso a la sucursal de este proveedor' using errcode = 'AT403';
  end if;

  select id into v_customer_id from citas.customers where organization_id = p_organization_id and phone = p_customer_phone;
  if v_customer_id is null then
    insert into citas.customers (organization_id, phone, full_name, email)
    values (p_organization_id, p_customer_phone, p_customer_name, nullif(p_customer_email, ''))
    returning id into v_customer_id;
  elsif p_customer_email is not null and length(p_customer_email) > 0 then
    update citas.customers set email = coalesce(email, p_customer_email), updated_at = now() where id = v_customer_id;
  end if;

  begin
    insert into citas.appointments (
      organization_id, property_id, provider_id, service_id, customer_id,
      starts_at, ends_at, status, source, notes
    ) values (
      p_organization_id, p_property_id, p_provider_id, p_service_id, v_customer_id,
      p_starts_at, p_ends_at, 'pending', 'manual', nullif(p_notes, '')
    ) returning * into v_appointment;
  exception
    when exclusion_violation then
      raise exception 'El horario solicitado ya no está disponible para este proveedor.' using errcode = 'AT423';
  end;

  return to_jsonb(v_appointment);
end;
$$;

revoke all on function citas.create_appointment_from_panel(uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text) from public, anon;
grant execute on function citas.create_appointment_from_panel(uuid, uuid, uuid, uuid, text, text, text, timestamptz, timestamptz, text) to authenticated, service_role;
