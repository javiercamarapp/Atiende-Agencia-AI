-- Estados de entrega de WhatsApp (statuses de Meta) para restaurantes.
-- Prefijo de supabase/migrations: 20240101000369 (interno restaurantes 066).
-- Requiere: 007 (messaging_outbox), 015 (guard de sesion de sistema), 028 (handoff_actor_en_sucursal), 035 (voz_zona_horaria),
-- 046 (purga por retencion).
--
-- Problema: Meta acepta un envio con 200 y devuelve un wamid, pero muchos fallos llegan DESPUES por el webhook como
-- `statuses[]` (failed con `errors[].code`: 131047 fuera de la ventana de 24 h, 131026 numero no entregable, 132xxx plantilla pausada,
-- 131049 limite de marketing). Hasta hoy el wamid no se guardaba y el webhook descartaba los statuses: el outbox quedaba en `sent` aunque
-- el cliente nunca recibiera "Recibimos su pedido" o "Va en camino".
--
-- Que agrega (todo NUEVO y aditivo; ninguna funcion ni restriccion existente se modifica):
--   1. Siete columnas en restaurantes.messaging_outbox: provider_message_id (wamid), enviado_como, delivery_status
--      (sent < delivered < read; failed gana), delivery_updated_at, delivery_error_code, delivery_error_title, delivery_failure_reason.
--      Indice unico PARCIAL (organization_id, provider_message_id) donde el wamid no es nulo.
--   2. restaurantes.complete_messaging_outbox_sent(uuid, text, text): sobrecarga de la de 007/015 que ademas guarda el wamid y como salio
--      el mensaje. La de un argumento queda intacta (la usa el TypeScript contra una base sin esta migracion).
--   3. restaurantes.registrar_estado_entrega_whatsapp(org, wamid, estado, codigo, titulo): avanza el estado de entrega por wamid, de forma
--      idempotente y sin retroceder, y devuelve lo que el backend necesita para avisar (pedido ligado, fallos de la ultima hora y, solo al pasar
--      a `failed` un aviso de pedido, el correo/nombre/sucursal/total de ESE pedido para el respaldo por correo).
--   4. restaurantes.whatsapp_entrega_diaria(org, property, desde, hasta): conteos por dia local de los avisos de estado de pedido
--      (enviados, entregados, leidos, fallidos y fallos por motivo). Solo conteos, sin PII.
--   5. Trigger de retencion: cuando la purga de 046 reemplaza el payload por '{"erased": true}', el wamid y todo el estado de entrega de esa
--      fila se borran en el mismo UPDATE (el estado de entrega no vive mas que el payload). Consecuencia declarada: pasada la retencion
--      (180 dias por defecto) esa fila deja de contar en el KPI de entrega.
--
-- Privacidad: ninguna columna nueva guarda telefono ni texto de mensaje. `delivery_error_title` es el titulo corto que Meta pone en
-- `errors[0].title` (texto de Meta, recortado a 120), nunca contenido del cliente. El `recipient_id` del status NO se guarda.
--
-- Justificacion de seguridad (una por una):
--
--  * Columnas nuevas de messaging_outbox -- la tabla ya tiene RLS habilitado y `revoke all from public, anon, authenticated` (007): el staff
--    y anon NO leen ni escriben esta tabla directamente; las columnas heredan ese cierre. Solo `service_role` conserva el GRANT de tabla de
--    007 (nunca se usa contra Postgres real: el motor conecta como `authenticated`, ver 015). No se agrega ningun GRANT, ni a nivel de
--    tabla ni de columna, ni ninguna policy.
--  * Indice unico parcial por (organizacion, wamid): un wamid solo puede pertenecer a UNA fila de la organizacion; la organizacion forma
--    parte de la llave para que un wamid repetido de otro tenant nunca bloquee un envio.
--  * complete_messaging_outbox_sent(uuid, text, text) -- SECURITY DEFINER, `set search_path = restaurantes, pg_temp`, `revoke all from public,
--    anon`, GRANT EXECUTE solo a `authenticated` (la sesion de sistema del motor corre con ese rol sin usuario) y guard `auth.uid() is
--    null` (un staff recibe 42501, igual que 015). Es definer porque la tabla no tiene DML para `authenticated`. Solo cierra una fila en
--    `processing` (como la de un argumento). Un wamid repetido (unique_violation) no deja el mensaje en `processing`: se cierra sin guardar
--    el wamid.
--  * registrar_estado_entrega_whatsapp -- SECURITY DEFINER, search_path fijo, `revoke all from public, anon`, GRANT EXECUTE solo a
--    `authenticated`, guard `auth.uid() is null` (solo sistema; 42501 si no). Es la UNICA via de escritura del estado de entrega. Toda
--    busqueda lleva `organization_id = p_organization_id`: el webhook resuelve esa organizacion del `phone_number_id` firmado, asi que un
--    wamid de la organizacion A enviado al webhook del numero de la B no toca nada (devuelve 'desconocido'). Valida el estado (22023) y
--    acota wamid (255), codigo y titulo. No lee ni escribe el payload. Es definer ademas porque la sesion de sistema no puede leer
--    `restaurantes.orders` (su unica policy es de staff): lee el correo, nombre, sucursal y total del pedido del aviso (con `organization_id`
--    = el del webhook) y SOLO los devuelve cuando el mensaje acaba de pasar a `failed`; es PII que ya maneja el backend (mismo dato que la
--    confirmacion por correo) y la funcion solo la ejecuta la sesion de sistema.
--  * whatsapp_entrega_diaria -- SECURITY DEFINER, search_path fijo, `revoke all from public, anon`, GRANT EXECUTE solo a `authenticated`.
--    Mismo guard que whatsapp_kpis_diarios (040): auth.uid() no nulo y owner/admin con alcance a la sucursal via
--    restaurantes.handoff_actor_en_sucursal(org, property, true) (42501 igual para sucursal ajena o inexistente). Cruza el aviso con su
--    pedido (organizacion Y sucursal) porque la tabla no es legible por el staff y solo salen conteos. Rango maximo 63 dias.
--  * Trigger de retencion -- funcion SECURITY INVOKER sin acceso a nada mas que la fila en curso; no necesita ningun GRANT (revoke all
--    from public, anon, authenticated).
--
-- Compatibilidad con base sin migrar: nada de esto se aplica al mergear. El TypeScript llama a las funciones nuevas dentro de SAVEPOINT y
-- degrada ante 42883/42P01/42703 (envio sin wamid, webhook de solo statuses responde 200, KPI "no disponible aun").

-- ---------------------------------------------------------------------------
-- 1) Columnas e indice
-- ---------------------------------------------------------------------------
alter table restaurantes.messaging_outbox
  add column provider_message_id text
    check (provider_message_id is null or length(provider_message_id) between 1 and 255),
  add column enviado_como text
    check (enviado_como is null or enviado_como in ('texto', 'plantilla', 'botones', 'ubicacion')),
  add column delivery_status text
    check (delivery_status is null or delivery_status in ('sent', 'delivered', 'read', 'failed')),
  add column delivery_updated_at timestamptz,
  add column delivery_error_code integer
    check (delivery_error_code is null or delivery_error_code >= 0),
  add column delivery_error_title text
    check (delivery_error_title is null or length(delivery_error_title) <= 120),
  add column delivery_failure_reason text
    check (delivery_failure_reason is null or delivery_failure_reason in (
      'fuera_de_ventana', 'fuera_de_ventana_plantilla_sin_usar', 'numero_no_entregable', 'plantilla', 'limite_marketing', 'otro'
    ));

create unique index messaging_outbox_provider_message_id_uidx
  on restaurantes.messaging_outbox (organization_id, provider_message_id)
  where provider_message_id is not null;

-- Lectura por dia local de los avisos de estado de pedido ya enviados (KPI de entrega).
create index messaging_outbox_entrega_kpi_idx
  on restaurantes.messaging_outbox (organization_id, sent_at)
  where event_type like 'order.status.%' and provider_message_id is not null;

-- ---------------------------------------------------------------------------
-- 2) Cerrar como enviado guardando el wamid (sobrecarga; la de un argumento no cambia)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.complete_messaging_outbox_sent(
  p_id uuid, p_provider_message_id text, p_enviado_como text
) returns void
language plpgsql security definer set search_path = restaurantes, pg_temp as $$
begin
  if auth.uid() is not null then
    raise exception 'complete_messaging_outbox_sent es solo para la sesión de sistema' using errcode = '42501';
  end if;
  begin
    update restaurantes.messaging_outbox
       set status = 'sent', sent_at = now(),
           provider_message_id = left(nullif(p_provider_message_id, ''), 255),
           enviado_como = case when p_enviado_como in ('texto', 'plantilla', 'botones', 'ubicacion') then p_enviado_como else null end,
           delivery_status = case when nullif(p_provider_message_id, '') is null then null else 'sent' end,
           delivery_updated_at = case when nullif(p_provider_message_id, '') is null then null else now() end
     where id = p_id and status = 'processing';
  exception when unique_violation then
    -- wamid repetido en la organizacion (no deberia ocurrir): el mensaje se cierra igual, sin llave de entrega.
    update restaurantes.messaging_outbox set status = 'sent', sent_at = now()
     where id = p_id and status = 'processing';
  end;
end;
$$;
revoke all on function restaurantes.complete_messaging_outbox_sent(uuid, text, text) from public, anon;
grant execute on function restaurantes.complete_messaging_outbox_sent(uuid, text, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) Avanzar el estado de entrega por wamid (solo sistema)
-- ---------------------------------------------------------------------------
-- Orden: sent < delivered < read; `failed` gana y es terminal. Repetir el mismo estado no cambia nada (resultado 'sin_cambio').
-- resultado: 'actualizado' | 'sin_cambio' | 'desconocido' (ningun mensaje de ESTA organizacion con ese wamid).
-- order_id / order_status: solo cuando el mensaje era un aviso de estado de pedido (dedupe `order-status:<pedido>:<estado>`).
create or replace function restaurantes.registrar_estado_entrega_whatsapp(
  p_organization_id uuid,
  p_wamid text,
  p_estado text,
  p_error_code integer default null,
  p_error_title text default null
) returns table (
  outbox_id uuid,
  resultado text,
  estado text,
  event_type text,
  failure_reason text,
  order_id uuid,
  order_status text,
  fallidas_ultima_hora integer,
  pedido_correo text,
  pedido_cliente text,
  pedido_sucursal text,
  pedido_total numeric
)
language plpgsql security definer set search_path = restaurantes, pg_temp as $$
#variable_conflict use_column
declare
  v_row restaurantes.messaging_outbox%rowtype;
  v_nuevo text;
  v_razon text;
  v_order uuid;
  v_order_status text;
  v_correo text;
  v_cliente text;
  v_sucursal text;
  v_total numeric;
begin
  if auth.uid() is not null then
    raise exception 'registrar_estado_entrega_whatsapp es solo para la sesión de sistema' using errcode = '42501';
  end if;
  if p_organization_id is null or p_wamid is null or length(p_wamid) not between 1 and 255 then
    raise exception 'registrar_estado_entrega_whatsapp: organizacion o wamid invalidos' using errcode = '22023';
  end if;
  if p_estado is null or p_estado not in ('sent', 'delivered', 'read', 'failed') then
    raise exception 'registrar_estado_entrega_whatsapp: estado invalido' using errcode = '22023';
  end if;

  select * into v_row from restaurantes.messaging_outbox m
   where m.organization_id = p_organization_id and m.provider_message_id = p_wamid and m.channel = 'whatsapp'
   for update;
  if not found then
    return query select null::uuid, 'desconocido'::text, null::text, null::text, null::text, null::uuid, null::text, 0, null::text, null::text, null::text, null::numeric;
    return;
  end if;

  -- Misma tabla de avance que avanzarEstadoEntrega (packages/whatsapp-gateway/src/statuses.ts).
  v_nuevo := case
    when v_row.delivery_status = 'failed' then 'failed'
    when v_row.delivery_status is null then p_estado
    when p_estado = 'failed' then 'failed'
    when (case p_estado when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 end)
       > (case v_row.delivery_status when 'sent' then 1 when 'delivered' then 2 when 'read' then 3 end) then p_estado
    else v_row.delivery_status
  end;

  if v_nuevo = 'failed' and v_row.delivery_status is distinct from 'failed' then
    v_razon := case
      when p_error_code = 131047 then
        case when v_row.enviado_como = 'texto' and jsonb_typeof(v_row.payload -> 'template') = 'object'
             then 'fuera_de_ventana_plantilla_sin_usar' else 'fuera_de_ventana' end
      when p_error_code = 131026 then 'numero_no_entregable'
      when p_error_code = 131049 then 'limite_marketing'
      when p_error_code between 132000 and 132999 then 'plantilla'
      else 'otro'
    end;
  end if;

  if v_nuevo is distinct from v_row.delivery_status then
    update restaurantes.messaging_outbox m
       set delivery_status = v_nuevo,
           delivery_updated_at = now(),
           delivery_error_code = case when v_nuevo = 'failed' then p_error_code else m.delivery_error_code end,
           delivery_error_title = case when v_nuevo = 'failed' then left(nullif(p_error_title, ''), 120) else m.delivery_error_title end,
           delivery_failure_reason = case when v_nuevo = 'failed' then v_razon else m.delivery_failure_reason end
     where m.id = v_row.id;
  end if;

  if v_row.event_type like 'order.status.%' then
    v_order := nullif(substring(v_row.dedupe_key from '^order-status:([0-9a-fA-F-]{36}):'), '')::uuid;
    v_order_status := substring(v_row.dedupe_key from '^order-status:[0-9a-fA-F-]{36}:(.+)$');
  end if;

  -- Respaldo por correo: SOLO cuando este status hace pasar el mensaje a `failed` y era el aviso de un pedido de ESTA organizacion. La sesion de
  -- sistema no puede leer `orders` (su unica policy es de staff), por eso los datos del correo salen de aqui, ya acotados por organizacion.
  if v_nuevo = 'failed' and v_row.delivery_status is distinct from 'failed' and v_order is not null then
    select o.customer_email, o.customer_name, o.branch, o.total into v_correo, v_cliente, v_sucursal, v_total
      from restaurantes.orders o where o.id = v_order and o.organization_id = p_organization_id;
  end if;

  return query
    select v_row.id,
           (case when v_nuevo is distinct from v_row.delivery_status then 'actualizado' else 'sin_cambio' end)::text,
           v_nuevo,
           v_row.event_type,
           (case when v_nuevo = 'failed' then coalesce(v_razon, v_row.delivery_failure_reason) else null end)::text,
           v_order,
           v_order_status,
           (select count(*)::integer from restaurantes.messaging_outbox f
             where f.organization_id = p_organization_id and f.delivery_status = 'failed'
               and f.delivery_updated_at > now() - interval '1 hour'),
           v_correo, v_cliente, v_sucursal, v_total;
end;
$$;
revoke all on function restaurantes.registrar_estado_entrega_whatsapp(uuid, text, text, integer, text) from public, anon;
grant execute on function restaurantes.registrar_estado_entrega_whatsapp(uuid, text, text, integer, text) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) KPI de entrega por dia local (panel, owner/admin)
-- ---------------------------------------------------------------------------
-- Base: avisos de estado de pedido (event_type 'order.status.%') que SALIERON (status 'sent') y tienen wamid, atribuidos al dia local de
-- la sucursal del PEDIDO en que se enviaron. `entregados` incluye los leidos (un leido tambien fue entregado). `sin_estado` = enviados
-- de los que Meta aun no reporto nada. Un aviso cuyo wamid ya se purgo por retencion deja de contar.
create or replace function restaurantes.whatsapp_entrega_diaria(
  p_organization_id uuid,
  p_property_id uuid,
  p_desde date,
  p_hasta date
) returns table (
  fecha date,
  zona_horaria text,
  enviados integer,
  entregados integer,
  leidos integer,
  fallidos integer,
  sin_estado integer,
  fallos_por_motivo jsonb
)
language plpgsql stable security definer set search_path = restaurantes, core, pg_temp as $$
#variable_conflict use_column
declare
  v_tz text;
  v_ini timestamptz;
  v_fin timestamptz;
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'whatsapp_entrega_diaria: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 62 then
    raise exception 'whatsapp_entrega_diaria: rango de fechas invalido (maximo 63 dias)' using errcode = '22023';
  end if;

  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_ini := p_desde::timestamp at time zone v_tz;
  v_fin := (p_hasta + 1)::timestamp at time zone v_tz;

  return query
  with dias as (
    select d::date as dia from generate_series(p_desde::timestamp, p_hasta::timestamp, interval '1 day') d
  ),
  avisos as (
    select (m.sent_at at time zone v_tz)::date as dia, m.delivery_status, m.delivery_failure_reason
      from restaurantes.messaging_outbox m
      join restaurantes.orders o
        on o.id = nullif(substring(m.dedupe_key from '^order-status:([0-9a-fA-F-]{36}):'), '')::uuid
       and o.organization_id = p_organization_id and o.property_id = p_property_id
     where m.organization_id = p_organization_id
       and m.channel = 'whatsapp' and m.status = 'sent'
       and m.event_type like 'order.status.%'
       and m.provider_message_id is not null
       and m.sent_at >= v_ini and m.sent_at < v_fin
  ),
  motivos as (
    select dia, jsonb_object_agg(motivo, n) as por_motivo
      from (select dia, coalesce(delivery_failure_reason, 'otro') as motivo, count(*)::integer as n
              from avisos where delivery_status = 'failed' group by 1, 2) x
     group by dia
  ),
  agg as (
    select dia,
           count(*)::integer as enviados,
           count(*) filter (where delivery_status in ('delivered', 'read'))::integer as entregados,
           count(*) filter (where delivery_status = 'read')::integer as leidos,
           count(*) filter (where delivery_status = 'failed')::integer as fallidos,
           count(*) filter (where delivery_status = 'sent')::integer as sin_estado
      from avisos group by dia
  )
  select d.dia, v_tz,
         coalesce(a.enviados, 0), coalesce(a.entregados, 0), coalesce(a.leidos, 0), coalesce(a.fallidos, 0), coalesce(a.sin_estado, 0),
         coalesce(mo.por_motivo, '{}'::jsonb)
    from dias d
    left join agg a on a.dia = d.dia
    left join motivos mo on mo.dia = d.dia
   order by d.dia;
end;
$$;
revoke all on function restaurantes.whatsapp_entrega_diaria(uuid, uuid, date, date) from public, anon;
grant execute on function restaurantes.whatsapp_entrega_diaria(uuid, uuid, date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) Retencion: el estado de entrega no vive mas que el payload
-- ---------------------------------------------------------------------------
create or replace function restaurantes.messaging_outbox_borrar_entrega_con_payload() returns trigger
language plpgsql set search_path = restaurantes, pg_temp as $$
begin
  if new.payload = '{"erased": true}'::jsonb and old.payload is distinct from new.payload then
    new.provider_message_id := null;
    new.enviado_como := null;
    new.delivery_status := null;
    new.delivery_updated_at := null;
    new.delivery_error_code := null;
    new.delivery_error_title := null;
    new.delivery_failure_reason := null;
  end if;
  return new;
end;
$$;
revoke all on function restaurantes.messaging_outbox_borrar_entrega_con_payload() from public, anon, authenticated;

create trigger messaging_outbox_borrar_entrega_con_payload
  before update of payload on restaurantes.messaging_outbox
  for each row execute function restaurantes.messaging_outbox_borrar_entrega_con_payload();
