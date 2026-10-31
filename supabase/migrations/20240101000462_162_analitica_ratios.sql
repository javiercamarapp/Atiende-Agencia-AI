-- Analitica del dueno (F7): RATIOS de restaurante. Solo lectura, sin tablas.
-- Prefijo de supabase/migrations: 20240101000462 (interno restaurantes 162).
-- Requiere: 081/082 (cfo_resolver_sucursales, cfo_validar_rango, cfo_zonas, cfo_venta_lean, cfo_agente_diario), 028 (conversation_handoff) y 160 (analitica_base).
--
-- restaurantes.analitica_ratios(p_org, p_props, p_desde, p_hasta, p_grande_centavos) devuelve jsonb { "filas": [...], "parametros": {...} }. Una fila por
-- sucursal y UNA del conjunto (property_id nulo) calculada desde cero (los clientes distintos y los percentiles no se suman entre sucursales). La funcion
-- entrega CONTEOS enteros; los porcentajes y razones se calculan en TypeScript (src/analitica/ratios.ts, una sola definicion con su prueba).
--
-- SEGURIDAD: SECURITY DEFINER, search_path fijo, revoke de public/anon, grant a authenticated; la puerta es cfo_resolver_sucursales (sistema, u owner/admin
-- con alcance sobre cada sucursal pedida; 42501 si no). Todas las lecturas filtran por organization_id = p_org (cross-tenant). Sin PII: solo conteos y
-- segundos; ningun id de cliente ni texto de mensaje sale de la funcion.
--
-- DEFINICIONES EXACTAS (rango [p_desde, p_hasta], dia de negocio de la sucursal):
--   pedidos / neta        Ventas de cfo_pedidos_base (es_venta) sin falsos ni reposiciones; neta en centavos.
--   ticket                round(neta / pedidos).
--   clientes              Clientes distintos (customer_id) con venta; las ventas sin cliente cuentan en `pedidos` pero no en `clientes`.
--   frecuencia            pedidos_con_cliente / clientes (pedidos por cliente en el rango).
--   clientes_nuevos       Clientes cuya PRIMERA venta de los ultimos 365 dias previos al rango + el rango cae dentro del rango (si compraron hace mas de 365 dias
--                         se ven «nuevos»: limite declarado). En una sucursal, «primera» es la primera VENTA EN ESA sucursal.
--   recompra_N (14|30|60) elegibles = nuevos con primera venta <= p_hasta - N (ya tuvieron N dias para volver); recompraron = los que tienen una venta en un
--                         dia de negocio POSTERIOR al de su primera y a lo mas N dias despues. recompra_N = recompraron / elegibles.
--   cancelados / tasa     Pedidos con status = 'cancelado' (sin falsos ni reposiciones). tasa = cancelados / (pedidos + cancelados).
--   grandes               Ventas con neta > p_grande_centavos (400000 = $4,000, la regla de pedido grande de pedido-grande.ts; el criterio por peso NO se mide aqui).
--   conv_chats / conv_con_pedido / conv_escaladas   Conversaciones NUEVAS de WhatsApp del rango (primer contacto). con_pedido = conversacion ligada a un pedido
--                         de WhatsApp de la misma sucursal no cancelado. escaladas = alguna vez pidieron humano (conversation_handoff). conversion_chat_pedido =
--                         con_pedido / conv_chats. «Resuelta por el agente» = NO escalada (cota superior: no mide satisfaccion).
--   voz_llamadas / voz_con_pedido / voz_escaladas   Idem para llamadas de voz (resultado pedido_creado / escalado).
--   resp_n / resp_mediana_seg / resp_p90_seg / resp_hasta_5min   Tiempo de primera respuesta: por cada RACHA de mensajes del cliente (el primero tras un mensaje del
--                         asistente o al abrir la conversacion), segundos hasta el siguiente mensaje del asistente (agente o persona). Solo mensajes con hora (`at`);
--                         las rachas sin respuesta aun no cuentan. resp_hasta_5min = respuestas en <= 300 s. Percentiles nearest-rank.
--   resp_agente_n / resp_humano_n   Cuantas de esas respuestas las dio el agente (autor ausente o 'agente') y cuantas una persona (autor 'humano' / 'humano_app').
--   conversaciones_agente / costo_total_centavos / costo_por_conversacion_centavos   conversaciones_agente = conv_chats + voz_llamadas. costo_total = voz +
--                         telefonia + Meta + LLM en centavos MXN de cfo_agente_diario (el LLM y «No asignado» solo entran en el conjunto de la organizacion completa).
--                         Nulo si falta el tipo de cambio; costo_por_conversacion = round(costo_total / conversaciones_agente) si hay conversaciones.
--
-- Compatibilidad con la base SIN migrar: 42883; el TypeScript degrada con SAVEPOINT. Idempotente.
-- REVERSA: drop function if exists restaurantes.analitica_ratios(uuid, uuid[], date, date, bigint);

create or replace function restaurantes.analitica_ratios(p_org uuid, p_props uuid[], p_desde date, p_hasta date, p_grande_centavos bigint default 400000)
returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_out jsonb;
  v_cero constant uuid := '00000000-0000-0000-0000-000000000000';
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  if p_grande_centavos is null or p_grande_centavos < 1 then
    raise exception 'analitica_ratios: umbral de pedido grande invalido' using errcode = '22023';
  end if;

  with
  par as materialized (select z.property_id, z.tz, z.corte from restaurantes.cfo_zonas(v_props) z),
  alcances as (select u.pid as k from unnest(v_props) as u(pid) union all select v_cero),
  b as materialized (
    select x.* from restaurantes.analitica_base(p_org, v_props, p_desde, p_hasta) x where not x.es_falso and not x.es_reposicion
  ),
  ped as (
    select coalesce(s.pid, v_cero) as k,
           count(*) filter (where b.es_venta) as pedidos,
           coalesce(sum(b.neta_centavos) filter (where b.es_venta), 0)::bigint as neta,
           count(*) filter (where b.status = 'cancelado') as cancelados,
           count(*) filter (where b.es_venta and b.neta_centavos > p_grande_centavos) as grandes,
           count(distinct b.customer_id) filter (where b.es_venta and b.customer_id is not null) as clientes,
           count(*) filter (where b.es_venta and b.customer_id is not null) as pedidos_con_cliente
      from b cross join lateral (values (b.property_id), (null::uuid)) as s(pid)
     group by 1
  ),
  hist as materialized (
    select l.property_id, l.customer_id, l.dia_negocio
      from restaurantes.cfo_venta_lean(p_org, v_props, p_desde - 365, p_hasta) l
     where l.customer_id is not null
  ),
  dias as (
    select d.k, d.customer_id, d.dia_negocio, row_number() over (partition by d.k, d.customer_id order by d.dia_negocio) as rn
      from (select distinct coalesce(s.pid, v_cero) as k, h.customer_id, h.dia_negocio
              from hist h cross join lateral (values (h.property_id), (null::uuid)) as s(pid)) d
  ),
  rec as (
    select a.k, a.dia_negocio as primera, s2.dia_negocio as segunda
      from dias a
      left join dias s2 on s2.k = a.k and s2.customer_id = a.customer_id and s2.rn = 2
     where a.rn = 1 and a.dia_negocio between p_desde and p_hasta
  ),
  recs as (
    select r.k,
           count(*) as nuevos,
           count(*) filter (where r.primera <= p_hasta - 14) as el14,
           count(*) filter (where r.primera <= p_hasta - 14 and r.segunda <= r.primera + 14) as re14,
           count(*) filter (where r.primera <= p_hasta - 30) as el30,
           count(*) filter (where r.primera <= p_hasta - 30 and r.segunda <= r.primera + 30) as re30,
           count(*) filter (where r.primera <= p_hasta - 60) as el60,
           count(*) filter (where r.primera <= p_hasta - 60 and r.segunda <= r.primera + 60) as re60
      from rec r group by 1
  ),
  wa as materialized (
    select c.id, c.property_id,
           (o.id is not null) as con_pedido,
           exists (select 1 from restaurantes.conversation_handoff h
                    where h.organization_id = p_org and h.canal = 'whatsapp' and h.conversation_id = c.id and h.property_id = c.property_id) as escalada
      from restaurantes.whatsapp_conversations c
      join par on par.property_id = c.property_id
      left join restaurantes.orders o
        on o.id = c.order_id and o.organization_id = p_org and o.property_id = c.property_id and o.source = 'whatsapp' and o.status <> 'cancelado'
     where c.organization_id = p_org
       and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
       and c.created_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and c.created_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
       and ((c.created_at at time zone par.tz) - par.corte)::date between p_desde and p_hasta
  ),
  was as (
    select coalesce(s.pid, v_cero) as k, count(*) as conv, count(*) filter (where w.con_pedido) as con_pedido, count(*) filter (where w.escalada) as escaladas
      from wa w cross join lateral (values (w.property_id), (null::uuid)) as s(pid) group by 1
  ),
  voz as (
    select coalesce(s.pid, v_cero) as k, count(*) as llamadas, count(*) filter (where v.resultado = 'pedido_creado') as con_pedido,
           count(*) filter (where v.resultado = 'escalado') as escaladas
      from restaurantes.voice_conversation v
      join par on par.property_id = v.property_id
      cross join lateral (values (v.property_id), (null::uuid)) as s(pid)
     where v.organization_id = p_org and v.canal = 'llamada'
       and v.started_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and v.started_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
       and ((v.started_at at time zone par.tz) - par.corte)::date between p_desde and p_hasta
     group by 1
  ),
  msgs as materialized (
    select c.id as conv_id, c.property_id, m.ord,
           m.e ->> 'role' as role,
           m.e ->> 'autor' as autor,
           case when (m.e ->> 'at') ~ '^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])T([01]\d|2[0-3]):[0-5]\d:[0-5]\d' then (m.e ->> 'at')::timestamptz end as at
      from restaurantes.whatsapp_conversations c
      join par on par.property_id = c.property_id
      cross join lateral jsonb_array_elements(case when jsonb_typeof(c.messages) = 'array' then c.messages else '[]'::jsonb end) with ordinality as m(e, ord)
     where c.organization_id = p_org
       and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
       and c.updated_at >= ((p_desde - 3)::timestamp at time zone 'UTC')
  ),
  mw as (
    select m.*,
           lag(m.role) over (partition by m.conv_id order by m.ord) as prev_role,
           min(m.at) filter (where m.role = 'assistant') over (partition by m.conv_id order by m.ord rows between 1 following and unbounded following) as next_asst_at,
           (array_agg(m.autor) filter (where m.role = 'assistant') over (partition by m.conv_id order by m.ord rows between 1 following and unbounded following))[1] as next_autor
      from msgs m
  ),
  resp as (
    select coalesce(s.pid, v_cero) as k,
           extract(epoch from (w.next_asst_at - w.at))::numeric as seg,
           (w.next_autor is null or w.next_autor = 'agente') as por_agente
      from mw w
      join par on par.property_id = w.property_id
      cross join lateral (values (w.property_id), (null::uuid)) as s(pid)
     where w.role = 'user' and (w.prev_role is null or w.prev_role <> 'user')
       and w.at is not null and w.next_asst_at is not null and w.next_asst_at >= w.at
       and ((w.at at time zone par.tz) - par.corte)::date between p_desde and p_hasta
  ),
  resps as (
    select r.k, count(*) as n,
           percentile_disc(0.5) within group (order by r.seg) as mediana,
           percentile_disc(0.9) within group (order by r.seg) as p90,
           count(*) filter (where r.seg <= 300) as hasta5,
           count(*) filter (where r.por_agente) as n_agente,
           count(*) filter (where not r.por_agente) as n_humano
      from resp r group by 1
  ),
  ag as (
    select a.property_id as k, a.wa_conversaciones_nuevas, a.voz_llamadas, a.costo_voz_centavos, a.costo_telefonia_centavos,
           a.costo_meta_centavos, a.costo_llm_centavos, a.mxn_por_usd
      from restaurantes.cfo_agente_diario(p_org, v_props, p_desde, p_hasta) a
  ),
  ags as (
    select x.k,
           bool_or(x.mxn_por_usd is null) as sin_fx,
           (coalesce(sum(x.costo_voz_centavos), 0) + coalesce(sum(x.costo_telefonia_centavos), 0) + coalesce(sum(x.costo_meta_centavos), 0) + coalesce(sum(x.costo_llm_centavos), 0))::bigint as costo
      from (
        select a.k, a.mxn_por_usd, a.costo_voz_centavos, a.costo_telefonia_centavos, a.costo_meta_centavos, a.costo_llm_centavos from ag a where a.k is not null
        union all
        select v_cero, a.mxn_por_usd, a.costo_voz_centavos, a.costo_telefonia_centavos, a.costo_meta_centavos, a.costo_llm_centavos from ag a
      ) x group by 1
  ),
  filas as (
    select al.k,
           coalesce(p.pedidos, 0) as pedidos, coalesce(p.neta, 0) as neta, coalesce(p.cancelados, 0) as cancelados, coalesce(p.grandes, 0) as grandes,
           coalesce(p.clientes, 0) as clientes, coalesce(p.pedidos_con_cliente, 0) as pedidos_con_cliente,
           coalesce(rc.nuevos, 0) as nuevos, coalesce(rc.el14, 0) as el14, coalesce(rc.re14, 0) as re14, coalesce(rc.el30, 0) as el30, coalesce(rc.re30, 0) as re30,
           coalesce(rc.el60, 0) as el60, coalesce(rc.re60, 0) as re60,
           coalesce(w.conv, 0) as conv, coalesce(w.con_pedido, 0) as conv_ped, coalesce(w.escaladas, 0) as conv_esc,
           coalesce(v.llamadas, 0) as llamadas, coalesce(v.con_pedido, 0) as voz_ped, coalesce(v.escaladas, 0) as voz_esc,
           coalesce(rs.n, 0) as resp_n, rs.mediana, rs.p90, coalesce(rs.hasta5, 0) as hasta5, coalesce(rs.n_agente, 0) as n_agente, coalesce(rs.n_humano, 0) as n_humano,
           g.sin_fx, g.costo
      from alcances al
      left join ped p on p.k = al.k
      left join recs rc on rc.k = al.k
      left join was w on w.k = al.k
      left join voz v on v.k = al.k
      left join resps rs on rs.k = al.k
      left join ags g on g.k = al.k
  )
  select jsonb_build_object(
    'filas', coalesce((select jsonb_agg(jsonb_build_object(
        'property_id', case when f.k = v_cero then null else f.k end,
        'pedidos', f.pedidos, 'neta_centavos', f.neta,
        'ticket_centavos', case when f.pedidos > 0 then round(f.neta::numeric / f.pedidos) end,
        'clientes', f.clientes, 'pedidos_con_cliente', f.pedidos_con_cliente, 'clientes_nuevos', f.nuevos,
        'recompra', jsonb_build_object(
          'd14', jsonb_build_object('elegibles', f.el14, 'recompraron', f.re14),
          'd30', jsonb_build_object('elegibles', f.el30, 'recompraron', f.re30),
          'd60', jsonb_build_object('elegibles', f.el60, 'recompraron', f.re60)),
        'cancelados', f.cancelados, 'grandes', f.grandes,
        'conv_chats', f.conv, 'conv_con_pedido', f.conv_ped, 'conv_escaladas', f.conv_esc,
        'voz_llamadas', f.llamadas, 'voz_con_pedido', f.voz_ped, 'voz_escaladas', f.voz_esc,
        'resp_n', f.resp_n, 'resp_mediana_seg', f.mediana, 'resp_p90_seg', f.p90, 'resp_hasta_5min', f.hasta5,
        'resp_agente_n', f.n_agente, 'resp_humano_n', f.n_humano,
        'conversaciones_agente', f.conv + f.llamadas,
        'costo_total_centavos', case when f.sin_fx is null or f.sin_fx then null else f.costo end,
        'costo_por_conversacion_centavos', case when f.sin_fx is null or f.sin_fx or f.conv + f.llamadas = 0 then null else round(f.costo::numeric / (f.conv + f.llamadas)) end)
        order by (f.k = v_cero), f.k) from filas f), '[]'::jsonb),
    'parametros', jsonb_build_object('desde', to_char(p_desde, 'YYYY-MM-DD'), 'hasta', to_char(p_hasta, 'YYYY-MM-DD'), 'grande_centavos', p_grande_centavos, 'historial_dias', 365)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function restaurantes.analitica_ratios(uuid, uuid[], date, date, bigint) from public, anon;
grant execute on function restaurantes.analitica_ratios(uuid, uuid[], date, date, bigint) to authenticated;
