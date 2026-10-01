-- C-10 (citas) -- "Chatea con tus datos": estado de entrega de los recordatorios de cita.
-- Prefijo de supabase/migrations asignado: 20240101000237 (interno 027).
--
-- Por que hace falta SQL: el chat debe poder responder "cuantos recordatorios fallaron". Esa informacion vive en
-- citas.messaging_outbox, tabla a la que `authenticated` NO tiene ningun GRANT (revoke all en 003; solo la
-- sesion de sistema y las funciones del despachador la tocan) y que ademas no guarda la sucursal. En vez de abrir
-- la tabla (que contiene destinatarios y cuerpos de mensaje), se agrega UNA funcion de solo lectura que devuelve
-- unicamente conteos.
--
-- Decision de diseno: solo agrega un objeto NUEVO. Nada existente se toca. El codigo TypeScript que lo usa
-- (packages/domain-citas/src/data-chat) corre la consulta dentro de un SAVEPOINT y, si la funcion todavia no
-- existe (SQLSTATE 42883), responde "el detalle de envios todavia no esta disponible" sin abortar la transaccion de
-- la request y sin romper ninguna otra herramienta del chat: nada de esto se aplica al mergear.
--
-- Justificacion de seguridad:
--  * citas.data_chat_reminder_delivery -- `security definer` (necesario: authenticated no puede leer el outbox),
--    `set search_path = citas, core, pg_temp`, `revoke ... from public, anon`, EXECUTE solo para `authenticated`
--    (anon y service_role no la reciben: no hay sesion de sistema que la necesite).
--    - Exige `auth.uid()` no nulo y membership de la organizacion pedida con vertical_role owner/admin (mismo rol que
--      el chat de datos y que 026): un `staff`, un usuario de otra organizacion o la sesion de sistema obtienen 0 filas
--      (la consulta nunca lanza: devuelve vacio, sin confirmar si la organizacion existe).
--    - Solo devuelve (canal, estado, total): nunca destinatarios, cuerpos, ids ni errores.
--    - Solo cuenta recordatorios de citas que la RLS de citas.appointments le dejaria ver al propio usuario
--      (`citas.membership_covers_property`, 015) y ademas recorta al filtro de sucursales que fija el servidor
--      (`p_property_ids`; null = todas las de su membership). Una cita sin sucursal solo cuenta con `p_property_ids`
--      nulo (consulta sin filtro de sucursal).
--    - Solo lectura (language sql stable): no escribe nada.
create or replace function citas.data_chat_reminder_delivery(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_start timestamptz,
  p_end timestamptz
) returns table (channel text, status text, total bigint)
language sql
stable
security definer
set search_path = citas, core, pg_temp
as $$
  select o.channel, o.status, count(*)::bigint as total
  from citas.messaging_outbox o
  join citas.appointments a
    on a.organization_id = o.organization_id
   and o.dedupe_key = 'reminder-24h:' || a.id::text
  where auth.uid() is not null
    and p_organization_id is not null
    and o.organization_id = p_organization_id
    and o.event_type = 'appointment.reminder_24h'
    and exists (
      select 1 from core.membership m
      where m.organization_id = p_organization_id and m.user_id = auth.uid() and m.vertical_role in ('owner', 'admin')
    )
    and citas.membership_covers_property(a.organization_id, a.property_id)
    and (p_property_ids is null or a.property_id = any(p_property_ids))
    and a.starts_at >= p_start and a.starts_at < p_end
  group by o.channel, o.status
  order by o.channel, o.status
$$;

revoke all on function citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz) from public, anon;
grant execute on function citas.data_chat_reminder_delivery(uuid, uuid[], timestamptz, timestamptz) to authenticated;
