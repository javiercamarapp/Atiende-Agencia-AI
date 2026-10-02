-- ---------------------------------------------------------------------------
-- Rentas 031 (H-30): core._arco_union clasifica 'pendiente_verificacion' (hoteles) como 'por_confirmar'.
--
-- Por que una migracion nueva y no una edicion de 028/278: 20240101000278 ya esta aplicada en la base real y
-- `supabase db push` decide por version, no por contenido; una edicion de 278 nunca llegaria a produccion.
-- La funcion se redefine aqui con el cuerpo VIGENTE de 278 (citas, restaurantes, hoteles, rentas) y UNA sola rama
-- cambiada: hoteles.arco_request.status = 'pendiente_verificacion' -> 'por_confirmar' (antes caia en el ELSE
-- 'resuelta', por lo que una solicitud publica sin verificar, incluido el spam, aparecia como resuelta en
-- core.org_list_arco_requests y core.platform_list_arco_requests).
--
-- Orden: el prefijo 20240101000294 es posterior a 278 (rentas.arco_solicitud) y a 277 (estado
-- 'pendiente_verificacion'), asi que sirve tanto en una base nueva migrada en orden como en la real, donde 278 ya
-- esta aplicada y 277 llega despues y fuera de orden.
--
-- Seguridad: identica a 278. security definer con set search_path fijo, revoke de public/anon/authenticated
-- (solo la invocan otras funciones definer de core). No agrega GRANT, policy ni tabla.
-- ---------------------------------------------------------------------------
create or replace function core._arco_union()
returns table (
  organization_id uuid, vertical text, request_id uuid, right_type text, channel text,
  native_status text, status_bucket text, opened_at timestamptz,
  response_due_at timestamptz, execution_due_at timestamptz, due_at timestamptz,
  resolved_at timestamptz, is_open boolean, is_overdue boolean
)
language sql stable security definer set search_path = core, citas, restaurantes, hoteles, rentas, pg_temp as $$
  with u as (
    select r.organization_id, 'citas'::text as vertical, r.id as request_id, r.right_type, r.channel,
           r.status as native_status,
           case r.status when 'pendiente_confirmacion' then 'por_confirmar' when 'recibida' then 'abierta'
             when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada' when 'resuelta' then 'resuelta'
             when 'rechazada' then 'rechazada' else 'cerrada' end as status_bucket,
           r.requested_at as opened_at, r.response_due_at, r.execution_due_at, r.resolved_at
      from citas.data_rights_requests r
    union all
    select r.organization_id, 'restaurantes', r.id, r.right_type, r.channel, r.status,
           case r.status when 'pendiente_confirmacion' then 'por_confirmar' when 'recibida' then 'abierta'
             when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada' when 'resuelta' then 'resuelta'
             when 'rechazada' then 'rechazada' else 'cerrada' end,
           r.requested_at, r.response_due_at, r.execution_due_at, r.resolved_at
      from restaurantes.data_rights_requests r
    union all
    select a.organization_id, 'hoteles', a.id, a.right_type, a.channel, a.status,
           case a.status when 'pendiente_verificacion' then 'por_confirmar' when 'recibida' then 'abierta' when 'en_revision' then 'en_proceso'
             when 'procedente' then 'en_proceso' when 'improcedente' then 'rechazada' else 'resuelta' end,
           a.created_at, a.response_due_on::timestamp at time zone 'UTC',
           a.execution_due_on::timestamp at time zone 'UTC', a.executed_at
      from hoteles.arco_request a
    union all
    select s.organization_id, 'rentas', s.id, s.derecho, s.canal, s.estado,
           case s.estado when 'recibida' then 'abierta' when 'en_proceso' then 'en_proceso' when 'bloqueada' then 'bloqueada'
             when 'resuelta' then 'resuelta' else 'rechazada' end,
           s.recibida_en, s.respuesta_vence_en, s.ejecucion_vence_en, s.resuelta_en
      from rentas.arco_solicitud s
  )
  select u.organization_id, u.vertical, u.request_id, u.right_type, u.channel, u.native_status, u.status_bucket,
         u.opened_at, u.response_due_at, u.execution_due_at,
         case when u.status_bucket = 'abierta' then u.response_due_at else coalesce(u.execution_due_at, u.response_due_at) end,
         u.resolved_at,
         u.status_bucket in ('abierta', 'en_proceso', 'bloqueada'),
         u.status_bucket in ('abierta', 'en_proceso', 'bloqueada')
           and case when u.status_bucket = 'abierta' then u.response_due_at else coalesce(u.execution_due_at, u.response_due_at) end < now()
    from u;
$$;
revoke all on function core._arco_union() from public, anon, authenticated;
