-- QA adversarial R1 (lente automatizacion), restaurantes. Dos funciones de SISTEMA, ambas aditivas:
--
--   1. `restaurantes.system_purge_expired_privacy_data` (reemplaza la de 030, misma firma de entrada):
--        * QA-restaurantes-R1-automatizacion-04: `out_voice_calls_anonymized` solo contaba las llamadas con
--          `caller_hash`; las previews del panel y los numeros ocultos no lo tienen, asi que un lote lleno de
--          llamadas sin hash se reportaba como 0 y el cron cortaba su bucle dejando transcripciones vencidas.
--          Ahora cuenta las llamadas PROCESADAS del lote (las que se les borraron turnos o se les anulo el hash).
--        * QA-restaurantes-R1-automatizacion-05: cubre tres lugares con datos personales que la purga no alcanzaba:
--          `orders.call_transcript` / `orders.call_recording_url` (misma retencion que la voz),
--          `messaging_outbox.payload` (telefono y texto enviado) y `staff_order_notification.message`
--          (nombre del cliente), ambos con la retencion de conversaciones. Se vacian o reemplazan; la fila
--          y su estado se conservan (nunca se borra un pedido ni se rompe una llave de dedupe).
--        Salida: se AGREGAN tres columnas (`out_orders_voice_cleared`, `out_outbox_payloads_erased`,
--        `out_staff_notifications_erased`); el tipo de retorno cambia, por eso se hace DROP + CREATE.
--   2. `restaurantes.pos_comanda_promovidos_sin_comanda` (nueva): pedidos programados ya promovidos a cocina
--      cuya comanda nunca llego al outbox del POS (QA-restaurantes-R1-automatizacion-02). El cron de promocion
--      los vuelve a encolar (idempotente por organizacion + pedido).
--
-- Justificacion de seguridad (una por una):
--
--  * system_purge_expired_privacy_data -- `security definer`, `set search_path = restaurantes, core, pg_temp`,
--    `revoke all from public, anon`, GRANT EXECUTE solo a `authenticated` (la sesion de sistema del motor es
--    `authenticated` con `auth.uid() is null`; el guard interno exige `auth.uid() is null`, asi que un staff
--    autenticado recibe 42501). No se otorga ningun permiso de tabla nuevo: la funcion corre con los privilegios
--    de su duenio, igual que la de 030. Es DEFENSA EN PROFUNDIDAD de privacidad: reduce la superficie de datos
--    personales retenidos mas alla de lo avisado. NO toca a un titular con una solicitud ARCO abierta
--    (recibida/en_proceso/bloqueada): se compara por telefono normalizado, igual que ya hace la purga de voz.
--    Cada UPDATE esta acotado por `p_limit` (1..5000) y por organizacion via su propia retencion
--    (`privacy_config`), nunca entre organizaciones.
--  * pos_comanda_promovidos_sin_comanda -- `security definer`, search_path fijo, revoke de public/anon, GRANT
--    EXECUTE solo a `authenticated`, guard `auth.uid() is null` (solo sistema, 42501 si no). Solo lee pedidos de
--    organizaciones con la bandera de SoftRestaurant en `sombra`/`activo` y devuelve los de las ultimas
--    `p_horas` (1..168) en un estado vivo (ni `programado` ni `cancelado`), tope 1..500. No escribe nada.
--
-- Requiere 024 (pos_comanda_outbox, softrestaurant_config), 030 (privacidad) y 034 (promovido_at).

-- ---------------------------------------------------------------------------
-- 1) Purga por retencion ampliada
-- ---------------------------------------------------------------------------
drop function if exists restaurantes.system_purge_expired_privacy_data(integer);

create function restaurantes.system_purge_expired_privacy_data(p_limit integer default 500)
returns table (
  out_conversations_cleared integer,
  out_voice_turns_deleted integer,
  out_voice_calls_anonymized integer,
  out_orders_voice_cleared integer,
  out_outbox_payloads_erased integer,
  out_staff_notifications_erased integer
)
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_limit integer := least(greatest(coalesce(p_limit, 500), 1), 5000);
  v_conv integer := 0;
  v_turns integer := 0;
  v_calls integer := 0;
  v_orders integer := 0;
  v_outbox integer := 0;
  v_notifs integer := 0;
begin
  if auth.uid() is not null then
    raise exception 'system_purge_expired_privacy_data es solo para la sesion de sistema' using errcode = '42501';
  end if;

  -- (030) conversaciones de WhatsApp: se vacian los mensajes.
  with victims as (
    select w.id
      from restaurantes.whatsapp_conversations w
      left join restaurantes.privacy_config pc on pc.organization_id = w.organization_id
     where w.messages <> '[]'::jsonb
       and w.updated_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = w.organization_id and regexp_replace(r.customer_phone, '\D', '', 'g') = regexp_replace(w.phone, '\D', '', 'g')
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
       )
     order by w.updated_at
     limit v_limit
  ), cleared as (
    update restaurantes.whatsapp_conversations w
       set messages = '[]'::jsonb
      from victims v
     where w.id = v.id
    returning 1
  )
  select count(*) into v_conv from cleared;

  -- (030 + QA-04) llamadas de voz: turnos borrados y caller_hash anulado. `v_calls` cuenta las llamadas
  -- PROCESADAS del lote (con o sin caller_hash).
  with old_calls as (
    select c.id
      from restaurantes.voice_conversation c
      left join restaurantes.privacy_config pc on pc.organization_id = c.organization_id
     where (c.ended_at is not null or c.started_at < now() - interval '1 day')
       and c.started_at < now() - make_interval(days => coalesce(pc.voice_retention_days, 30))
       and (
         exists (select 1 from restaurantes.voice_turn t where t.conversation_id = c.id)
         or c.caller_hash is not null
       )
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = c.organization_id
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
            and c.caller_hash = encode(sha256(convert_to(regexp_replace(r.customer_phone, '\D', '', 'g'), 'UTF8')), 'hex')
       )
     order by c.started_at
     limit v_limit
  ), del_turns as (
    delete from restaurantes.voice_turn t using old_calls o where t.conversation_id = o.id returning 1
  ), anon as (
    update restaurantes.voice_conversation c set caller_hash = null
      from old_calls o where c.id = o.id and c.caller_hash is not null returning 1
  )
  select (select count(*) from del_turns), (select count(*) from old_calls) into v_turns, v_calls;

  -- (QA-05) transcripcion y URL de grabacion que la API publica y crear_pedido guardan en el pedido: misma
  -- retencion de voz de la organizacion.
  with viejos as (
    select o.id
      from restaurantes.orders o
      left join restaurantes.privacy_config pc on pc.organization_id = o.organization_id
     where (o.call_transcript is not null or o.call_recording_url is not null)
       and o.created_at < now() - make_interval(days => coalesce(pc.voice_retention_days, 30))
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = o.organization_id and regexp_replace(r.customer_phone, '\D', '', 'g') = regexp_replace(o.customer_phone, '\D', '', 'g')
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
       )
     order by o.created_at
     limit v_limit
  ), limpios as (
    update restaurantes.orders o
       set call_transcript = null, call_recording_url = null
      from viejos v
     where o.id = v.id
    returning 1
  )
  select count(*) into v_orders from limpios;

  -- (QA-05) cola de mensajes ya terminada (enviada, fallida o muerta): el payload lleva telefono y texto. Una fila
  -- pendiente o en proceso NO se toca (todavia se va a enviar). Misma retencion que las conversaciones.
  with viejos as (
    select m.id
      from restaurantes.messaging_outbox m
      left join restaurantes.privacy_config pc on pc.organization_id = m.organization_id
     where m.status not in ('pending', 'processing')
       and m.payload <> '{"erased": true}'::jsonb
       and m.created_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = m.organization_id
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
            and regexp_replace(r.customer_phone, '\D', '', 'g') = regexp_replace(coalesce(m.payload->>'to', ''), '\D', '', 'g')
       )
     order by m.created_at
     limit v_limit
  ), borrados as (
    update restaurantes.messaging_outbox m
       set payload = '{"erased": true}'::jsonb
      from viejos v
     where m.id = v.id
    returning 1
  )
  select count(*) into v_outbox from borrados;

  -- (QA-05) bandeja del staff: el texto lleva el nombre del cliente. Se reemplaza por un texto neutro.
  with viejos as (
    select n.id
      from restaurantes.staff_order_notification n
      left join restaurantes.privacy_config pc on pc.organization_id = n.organization_id
      left join restaurantes.orders o on o.id = n.order_id
     where n.message <> 'Aviso depurado por retencion de datos'
       and n.created_at < now() - make_interval(days => coalesce(pc.conversation_retention_days, 180))
       and not exists (
         select 1 from restaurantes.data_rights_requests r
          where r.organization_id = n.organization_id and regexp_replace(r.customer_phone, '\D', '', 'g') = regexp_replace(o.customer_phone, '\D', '', 'g')
            and r.status in ('recibida', 'en_proceso', 'bloqueada')
       )
     order by n.created_at
     limit v_limit
  ), borrados as (
    update restaurantes.staff_order_notification n
       set message = 'Aviso depurado por retencion de datos'
      from viejos v
     where n.id = v.id
    returning 1
  )
  select count(*) into v_notifs from borrados;

  return query select v_conv, v_turns, v_calls, v_orders, v_outbox, v_notifs;
end;
$$;

revoke all on function restaurantes.system_purge_expired_privacy_data(integer) from public, anon;
grant execute on function restaurantes.system_purge_expired_privacy_data(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) Promovidos sin comanda (reconciliacion del cron de promocion)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.pos_comanda_promovidos_sin_comanda(p_horas integer default 24, p_limit integer default 100)
returns setof restaurantes.orders
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if auth.uid() is not null then
    raise exception 'pos_comanda_promovidos_sin_comanda es solo para la sesion de sistema' using errcode = '42501';
  end if;
  return query
    select o.*
      from restaurantes.orders o
      join restaurantes.softrestaurant_config c on c.organization_id = o.organization_id and c.modo in ('sombra', 'activo')
     where o.promovido_at is not null
       and o.promovido_at >= now() - make_interval(hours => least(greatest(coalesce(p_horas, 24), 1), 168))
       and o.status not in ('programado', 'cancelado')
       and not exists (
         select 1 from restaurantes.pos_comanda_outbox x
          where x.organization_id = o.organization_id and x.order_id = o.id
       )
     order by o.promovido_at
     limit least(greatest(coalesce(p_limit, 100), 1), 500);
end;
$$;

revoke all on function restaurantes.pos_comanda_promovidos_sin_comanda(integer, integer) from public, anon;
grant execute on function restaurantes.pos_comanda_promovidos_sin_comanda(integer, integer) to authenticated;
