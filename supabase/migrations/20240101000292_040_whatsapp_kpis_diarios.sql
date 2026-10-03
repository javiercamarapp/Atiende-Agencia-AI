-- KPI del agente de WhatsApp de restaurantes por dia local (R-31).
-- Prefijo de supabase/migrations: 20240101000292 (interno restaurantes 040).
-- Requiere: 001 (whatsapp_conversations, orders), 022 (branch_detail.zona_horaria), 028 (conversation_handoff,
-- handoff_actor_en_sucursal), 035 (voz_zona_horaria), 037 (demo_organization) y la plataforma de costos
-- (core.fx_rate, core.llm_usage_daily).
--
-- Que agrega (todo NUEVO; ninguna tabla ni restriccion existente se modifica):
--   restaurantes.whatsapp_kpis_diarios(org, property, desde, hasta) -- una fila por dia local con conversaciones,
--   conversion a pedido, handoffs y costo LLM, solo lectura.
--
-- Definiciones (los rotulos de la pantalla las repiten tal cual):
--   * "Dia" = dia calendario en la zona horaria de la SUCURSAL (restaurantes.voz_zona_horaria: branch_detail.zona_horaria
--     o America/Mexico_City). Igual que el KPI de voz (035).
--   * Conversacion = una fila de restaurantes.whatsapp_conversations. La tabla guarda UNA fila por cliente (unique
--     organization+phone) y no tiene marca de tiempo por mensaje, asi que lo unico fechable con exactitud es el primer
--     contacto: una "conversacion" cuenta en el dia local de su created_at (cliente que escribio por primera vez a
--     ESA sucursal). Un cliente que ya existia y vuelve a escribir NO suma conversacion nueva (limite conocido).
--     Conversaciones sin sucursal (property_id nulo, anteriores al registro por sucursal) no se atribuyen a ninguna.
--   * conversaciones_con_pedido = de esas conversaciones nuevas, las que quedaron ligadas a un pedido NO cancelado
--     de canal whatsapp (whatsapp_conversations.order_id). La conversion se calcula SOBRE ESA COHORTE
--     (con_pedido / conversaciones), por eso nunca pasa de 100%; el API devuelve NULL cuando no hay conversaciones.
--   * pedidos = pedidos de canal whatsapp (orders.source = 'whatsapp') creados ese dia en la sucursal, sin cancelados
--     (misma regla que R-30 / 036: un pedido cancelado no es un pedido concretado).
--   * handoffs = solicitudes de atencion humana (conversation_handoff canal 'whatsapp') hechas ese dia local en la
--     sucursal; conversaciones_con_handoff = de las conversaciones nuevas del dia, las que alguna vez pidieron un humano
--     (cohorte, base de la tasa de handoff, nunca > 100%).
--   * Trafico demo: el widget publico de las organizaciones demo usa telefonos ficticios del rango reservado 0009
--     (lada que no existe). Esas conversaciones, sus pedidos y sus handoffs se EXCLUYEN de todo conteo.
--   * Costo LLM = core.llm_usage_daily (vertical 'restaurantes', roles 'restaurantes:whatsapp_agent' y
--     'restaurantes:whatsapp_agent_escalated') del dia, en enteros micro-USD y centavos MXN (ultimo core.fx_rate con
--     fecha <= el dia; sin tipo de cambio los centavos son NULL, jamas 0). Esa tabla es DIARIA por ORGANIZACION y rol: no
--     trae sucursal ni conversacion. Por eso (a) solo se devuelve a quien tiene alcance de toda la organizacion
--     (membership.property_ids nulo) y nunca se reparte a una sucursal, y (b) el costo por pedido es un PROMEDIO del dia:
--     costo LLM de la organizacion / pedidos whatsapp de la organizacion (todas las sucursales, `pedidos_org`), NULL si
--     ese dia no hubo pedidos. No incluye los roles de plataforma (enrutador, compuerta, compactacion) porque su
--     vertical es 'plataforma' y no se atribuyen a un tenant.
--   * En una organizacion demo (restaurantes.demo_organization) el costo LLM mezcla el widget publico con el uso real y no se
--     puede separar: se devuelve NULL con org_es_demo = true (dato "no disponible", no una cifra inflada).
--   * Sin PII: todo es agregado. No se lee ni se devuelve telefono, nombre ni texto de mensajes.
--
-- Justificacion de seguridad de la funcion (la unica pieza nueva; no hay tablas, policies ni GRANT de tabla):
--  * restaurantes.whatsapp_kpis_diarios -- SECURITY DEFINER con search_path fijo (restaurantes, core, pg_temp) y
--    `revoke all ... from public, anon`; `grant execute` SOLO a authenticated (la sesion de sistema del backend corre con ese
--    rol pero sin usuario y el guard la rechaza). Es definer porque cruza tablas que el staff no lee directamente
--    (core.llm_usage_daily y core.fx_rate estan cerradas a authenticated; whatsapp_conversations y conversation_handoff
--    exponen telefono/texto y aqui solo salen conteos). El guard es la unica puerta: auth.uid() no nulo + owner/admin
--    con alcance a la sucursal via restaurantes.handoff_actor_en_sucursal(org, property, true) (028), que valida que la
--    sucursal pertenezca a la organizacion y respeta membership.property_ids; 42501 igual para sucursal ajena que para
--    inexistente (no confirma su existencia). Se pide owner/admin (no staff de piso ni repartidor) porque el costo es
--    informacion comercial, igual que 035. Todo filtro lleva organization_id Y property_id. Rango maximo 63 dias.
--
-- Compatibilidad con base sin migrar: la funcion es nueva; el TypeScript la llama con SAVEPOINT y degrada a
-- "no disponible" ante 42883 (nada de esto se aplica al mergear).

create or replace function restaurantes.whatsapp_kpis_diarios(
  p_organization_id uuid,
  p_property_id uuid,
  p_desde date,
  p_hasta date
) returns table (
  fecha date,
  zona_horaria text,
  conversaciones integer,
  conversaciones_con_pedido integer,
  conversaciones_con_handoff integer,
  pedidos integer,
  handoffs integer,
  pedidos_org integer,
  org_es_demo boolean,
  costo_llm_org_micro_usd bigint,
  costo_llm_org_centavos_mxn bigint,
  mxn_por_usd numeric
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_tz text;
  v_org_completa boolean;
  v_demo boolean;
  v_ini timestamptz;
  v_fin timestamptz;
begin
  if auth.uid() is null or not restaurantes.handoff_actor_en_sucursal(p_organization_id, p_property_id, true) then
    raise exception 'whatsapp_kpis_diarios: sin acceso a la sucursal' using errcode = '42501';
  end if;
  if p_desde is null or p_hasta is null or p_hasta < p_desde or p_hasta - p_desde > 62 then
    raise exception 'whatsapp_kpis_diarios: rango de fechas invalido (maximo 63 dias)' using errcode = '22023';
  end if;

  v_tz := restaurantes.voz_zona_horaria(p_property_id);
  v_ini := p_desde::timestamp at time zone v_tz;
  v_fin := (p_hasta + 1)::timestamp at time zone v_tz;

  select exists (
    select 1 from core.membership m
    where m.user_id = auth.uid() and m.organization_id = p_organization_id
      and m.vertical_role in ('owner', 'admin') and m.property_ids is null
  ) into v_org_completa;
  select exists (select 1 from restaurantes.demo_organization d where d.organization_id = p_organization_id) into v_demo;

  return query
  with dias as (
    select d::date as dia from generate_series(p_desde::timestamp, p_hasta::timestamp, interval '1 day') d
  ),
  conv as (
    select (c.created_at at time zone v_tz)::date as dia,
           count(*)::integer as conversaciones,
           count(*) filter (where o.id is not null)::integer as con_pedido,
           count(*) filter (where exists (
             select 1 from restaurantes.conversation_handoff h
             where h.canal = 'whatsapp' and h.conversation_id = c.id
               and h.organization_id = p_organization_id and h.property_id = p_property_id
           ))::integer as con_handoff
    from restaurantes.whatsapp_conversations c
    left join restaurantes.orders o
      on o.id = c.order_id and o.organization_id = p_organization_id and o.property_id = p_property_id
         and o.source = 'whatsapp' and o.status <> 'cancelado'
    where c.organization_id = p_organization_id and c.property_id = p_property_id
      and c.created_at >= v_ini and c.created_at < v_fin
      and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
    group by 1
  ),
  ped as (
    select (o.created_at at time zone v_tz)::date as dia,
           count(*) filter (where o.property_id = p_property_id)::integer as pedidos,
           count(*)::integer as pedidos_org
    from restaurantes.orders o
    where o.organization_id = p_organization_id and o.source = 'whatsapp' and o.status <> 'cancelado'
      and o.created_at >= v_ini and o.created_at < v_fin
      and (o.property_id = p_property_id or v_org_completa)
      and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
    group by 1
  ),
  hof as (
    select (h.solicitada_at at time zone v_tz)::date as dia, count(*)::integer as handoffs
    from restaurantes.conversation_handoff h
    join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = p_organization_id
    where h.organization_id = p_organization_id and h.property_id = p_property_id and h.canal = 'whatsapp'
      and h.solicitada_at >= v_ini and h.solicitada_at < v_fin
      and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
    group by 1
  ),
  llm as (
    select l.usage_date as dia, sum(l.cost_micro_usd)::bigint as costo
    from core.llm_usage_daily l
    where v_org_completa and not v_demo
      and l.organization_id = p_organization_id and l.vertical = 'restaurantes'
      and l.role in ('restaurantes:whatsapp_agent', 'restaurantes:whatsapp_agent_escalated')
      and l.usage_date between p_desde and p_hasta
    group by 1
  )
  select
    d.dia,
    v_tz,
    coalesce(conv.conversaciones, 0),
    coalesce(conv.con_pedido, 0),
    coalesce(conv.con_handoff, 0),
    coalesce(ped.pedidos, 0),
    coalesce(hof.handoffs, 0),
    case when v_org_completa then coalesce(ped.pedidos_org, 0) else null end,
    v_demo,
    case when v_org_completa and not v_demo then coalesce(llm.costo, 0)::bigint else null end,
    case when v_org_completa and not v_demo and fx.mxn is not null
         then round(coalesce(llm.costo, 0)::numeric * fx.mxn / 10000)::bigint else null end,
    fx.mxn
  from dias d
  left join conv on conv.dia = d.dia
  left join ped on ped.dia = d.dia
  left join hof on hof.dia = d.dia
  left join llm on llm.dia = d.dia
  left join lateral (
    select f.mxn_por_usd as mxn from core.fx_rate f where f.fecha <= d.dia order by f.fecha desc limit 1
  ) fx on true
  order by d.dia;
end;
$$;

revoke all on function restaurantes.whatsapp_kpis_diarios(uuid, uuid, date, date) from public, anon;
grant execute on function restaurantes.whatsapp_kpis_diarios(uuid, uuid, date, date) to authenticated;
