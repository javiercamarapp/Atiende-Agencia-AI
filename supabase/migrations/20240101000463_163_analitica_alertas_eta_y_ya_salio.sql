-- Analitica del dueno (F7): ALERTAS OPERATIVAS de ETA alto y «¿ya salio?» sin contestar.
-- Prefijo de supabase/migrations: 20240101000463 (interno restaurantes 163).
-- Requiere: 001 (orders, whatsapp_conversations), 008 (orders.estimated_delivery_at), 031 (orders.canal) y 034 (promovido_at).
--
-- NO duplica la rama fix/r23-alertas (chat sin respuesta, escalaciones, interruptor): aqui solo los DOS candidatos que esa rama no cubre. Se entregan por el mismo
-- mecanismo de avisos (emitirNotificacion, dedupe, destinatarios y preferencias por usuario; el barrido vive en src/analitica/alertas.ts y corre en el tick existente).
--
-- Que agrega:
--   1. restaurantes.analitica_pregunta_estado(text)  -- inmutable. true si el mensaje pregunta por el estado de un pedido («¿ya salio?», «¿como va mi pedido?»).
--   2. restaurantes.analitica_alertas_candidatos(...) -- SOLO SISTEMA. Candidatos con ids y minutos, sin PII:
--        restaurantes.pedido.eta_alta           pedido a domicilio abierto cuya promesa de entrega (estimated_delivery_at) supera p_eta_max_min desde su inicio.
--                                               Una por pedido. Prevencion: avisa ANTES de que llegue tarde (la «entrega tardia» existente mide contra la promesa).
--        restaurantes.chat.ya_salio_sin_respuesta  el ULTIMO mensaje de la conversacion es del cliente, pregunta por el estado, tiene un pedido abierto del mismo
--                                               telefono y lleva >= p_ya_salio_min minutos (y <= 6 h) sin que nadie conteste. Sin pedido abierto no hay alerta
--                                               (es una consulta normal que el agente atiende). Una por mensaje (el TS usa conversation_id + referencia_at).
--
-- SEGURIDAD: SECURITY DEFINER, search_path fijo, revoke de public/anon; auth.uid() debe ser nulo (42501 si no), como avisos_operativos_candidatos (043). Solo
-- devuelve identificadores, fechas y minutos: nunca telefono, nombre, direccion ni el texto del mensaje (el texto solo se evalua dentro de la funcion).
-- Umbrales con rango acotado (20..240 y 1..60).
--
-- Compatibilidad con la base SIN migrar: 42883; el TypeScript devuelve `disponible: false` con SAVEPOINT. Idempotente.
-- REVERSA: drop function if exists restaurantes.analitica_alertas_candidatos(timestamptz, integer, integer);
--          drop function if exists restaurantes.analitica_pregunta_estado(text);

create or replace function restaurantes.analitica_pregunta_estado(p_texto text)
returns boolean
language sql
immutable
set search_path = pg_catalog, pg_temp
as $$
  select coalesce(left(p_texto, 500) ~* '(^|[^a-z])(ya\s+(sali[oó]|va\s+(para|en)|viene|est[aá]\s+en\s+camino|lleg[oó]|mand(aron|[oó])|tard[oó])|c[oó]mo\s+va\s+(mi|el)\s+pedido|cu[aá]nto\s+(falta|tarda|m[aá]s)|d[oó]nde\s+(est[aá]|viene|va)\s+(mi|el)\s+pedido|no\s+ha\s+llegado|sigue\s+sin\s+llegar)', false);
$$;
revoke all on function restaurantes.analitica_pregunta_estado(text) from public, anon;
grant execute on function restaurantes.analitica_pregunta_estado(text) to authenticated;

create or replace function restaurantes.analitica_alertas_candidatos(p_now timestamptz default null, p_eta_max_min integer default 60, p_ya_salio_min integer default 5)
returns table (tipo text, organization_id uuid, property_id uuid, order_id uuid, order_number bigint, conversation_id uuid, referencia_at timestamptz, minutos integer)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_now timestamptz := coalesce(p_now, now());
begin
  if auth.uid() is not null then
    raise exception 'analitica_alertas_candidatos es solo para la sesion de sistema' using errcode = '42501';
  end if;
  if p_eta_max_min is null or p_eta_max_min < 20 or p_eta_max_min > 240 or p_ya_salio_min is null or p_ya_salio_min < 1 or p_ya_salio_min > 60 then
    raise exception 'analitica_alertas_candidatos: umbral fuera de rango' using errcode = '22023';
  end if;

  return query
  select * from (
    select 'restaurantes.pedido.eta_alta'::text as tipo, o.organization_id, o.property_id, o.id as order_id, o.order_number::bigint, null::uuid as conversation_id,
           coalesce(o.promovido_at, o.created_at) as referencia_at,
           round(extract(epoch from (o.estimated_delivery_at - coalesce(o.promovido_at, o.created_at))) / 60.0)::integer as minutos
      from restaurantes.orders o
     where o.status in ('pending', 'preparando', 'en_camino')
       and coalesce(o.canal, case when o.customer_address is not null then 'domicilio' else 'recoger' end) = 'domicilio'
       and o.estimated_delivery_at is not null
       and o.estimated_delivery_at - coalesce(o.promovido_at, o.created_at) > make_interval(mins => p_eta_max_min)
       and coalesce(o.promovido_at, o.created_at) <= v_now
       and coalesce(o.promovido_at, o.created_at) > v_now - interval '24 hours'
       and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
    union all
    select 'restaurantes.chat.ya_salio_sin_respuesta'::text, ped.organization_id, ped.property_id, ped.id, ped.order_number::bigint, ped.conversation_id, ped.ref_at,
           floor(extract(epoch from (v_now - ped.ref_at)) / 60.0)::integer
      from (
        select c.id as conversation_id, c.organization_id,
               (select o.id from restaurantes.orders o
                 where o.organization_id = c.organization_id and o.status in ('pending', 'preparando', 'en_camino', 'listo_para_recoger')
                   and o.created_at > v_now - interval '24 hours'
                   and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
                 order by o.created_at desc limit 1) as id,
               (select o.order_number from restaurantes.orders o
                 where o.organization_id = c.organization_id and o.status in ('pending', 'preparando', 'en_camino', 'listo_para_recoger')
                   and o.created_at > v_now - interval '24 hours'
                   and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
                 order by o.created_at desc limit 1) as order_number,
               (select o.property_id from restaurantes.orders o
                 where o.organization_id = c.organization_id and o.status in ('pending', 'preparando', 'en_camino', 'listo_para_recoger')
                   and o.created_at > v_now - interval '24 hours'
                   and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) = right(regexp_replace(c.phone, '\D', '', 'g'), 10)
                 order by o.created_at desc limit 1) as property_id,
               case when ((c.messages -> -1) ->> 'at') ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d'
                    then ((c.messages -> -1) ->> 'at')::timestamptz else c.updated_at end as ref_at
          from restaurantes.whatsapp_conversations c
         where c.updated_at > v_now - interval '12 hours'
           and jsonb_typeof(c.messages) = 'array' and jsonb_array_length(c.messages) > 0
           and (c.messages -> -1) ->> 'role' = 'user'
           and restaurantes.analitica_pregunta_estado((c.messages -> -1) ->> 'content')
           and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
      ) ped
     where ped.id is not null
       and ped.ref_at <= v_now - make_interval(mins => p_ya_salio_min)
       and ped.ref_at > v_now - interval '6 hours'
  ) x
  order by x.referencia_at, x.tipo
  limit 500;
end;
$$;
revoke all on function restaurantes.analitica_alertas_candidatos(timestamptz, integer, integer) from public, anon;
grant execute on function restaurantes.analitica_alertas_candidatos(timestamptz, integer, integer) to authenticated;
