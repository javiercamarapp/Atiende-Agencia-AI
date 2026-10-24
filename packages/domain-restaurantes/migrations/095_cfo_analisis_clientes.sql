-- CFO "Analisis de clientes" (Fase A, SOLO LECTURA): RFM, reactivacion priorizada, intervalo de recompra y tortilla por renglon.
-- Prefijo de supabase/migrations: 20240101000409 (interno restaurantes 095; la 094 / ...408 esta reservada para la RLS del chofer del panel).
-- Requiere: 052 (marketing_consentimiento), 081 (cfo_resolver_sucursales, cfo_validar_rango, cfo_pedidos_base, cfo_renglones) y 082 (cfo_venta_lean).
--
-- Que agrega (todo NUEVO; NINGUNA tabla, funcion, policy ni GRANT existente se modifica o se redefine; sin tablas, sin DML):
--   1. restaurantes.cfo_clientes_rfm_base(...)       -- INTERNA (revoke total). Una fila por cliente con venta en el rango: recencia, frecuencia, monetario,
--                                                       intervalo mediano propio, puntajes y segmento. Es la UNICA definicion de segmento y de "dormido".
--   2. restaurantes.cfo_clientes_rfm(...)            -- PUBLICA. jsonb: segmentos (clientes, venta, ticket), resumen y curva de concentracion (Pareto).
--   3. restaurantes.cfo_clientes_reactivacion(...)   -- PUBLICA. jsonb: lista priorizada (alias de 8 caracteres, consentimiento de marketing, sin PII) y totales.
--   4. restaurantes.cfo_intervalo_recompra(...)      -- PUBLICA. p25/p50/p75/p90 de dias entre dias con venta, global y por segmento.
--   5. restaurantes.cfo_pedidos_tortilla(...)        -- PUBLICA. jsonb: renglones/unidades/pedidos por tipo de tortilla (items[].tortilla) de las ventas.
-- La afinidad de productos (soporte, confianza, lift) NO tiene SQL nuevo: se calcula en TypeScript sobre cfo_canasta_pares (081).
--
-- DEFINICIONES (los rotulos de la pantalla las repiten; el rango consultado es [p_desde, p_hasta], de a lo mas 400 dias):
--   * Venta = la regla de cfo_venta_lean (082): no cancelado/no_recogido/por_aprobar/programado, sin pedido_falso_at, sin trafico demo (telefono 0009...)
--     y sin reposiciones. Dia de negocio = el de la 076/077. Montos en centavos enteros. Cliente = orders.customer_id; las ventas sin cliente NO entran.
--   * Recencia = p_hasta - ultimo dia de negocio con venta del cliente (dias). Anclada a p_hasta (reproducible; NO a "hoy").
--   * Frecuencia (F) = numero de ventas del cliente en el rango. Puntaje por UMBRALES FIJOS: 1 venta = 1, 2 = 2, 3 = 3, 4 o mas = 4. No se usa ntile:
--     con ~2/3 de clientes de una sola venta los empates caerian en quintiles distintos de forma arbitraria.
--   * Monetario (M) = suma de la venta neta del cliente en el rango.
--   * Puntajes R y M = 1..5 por QUINTIL DE RANGO sobre los clientes del alcance y rango consultados (no de toda la organizacion): puntaje =
--     ceil(5 x clientes con valor igual o peor / clientes). Los EMPATES reciben el mismo puntaje (R: mas reciente = 5; M: mas venta = 5).
--     Con pocos clientes (< 5) los puntajes no son estables; la pantalla lo avisa.
--   * Intervalo propio = dias entre dias de negocio consecutivos con venta del cliente (varias ventas el mismo dia son un solo dia); su mediana es la
--     "mediana de intervalo". Un cliente con un solo dia con venta no tiene intervalo.
--   * DORMIDO (UNICA definicion): >= 2 ventas y recencia > max(30, 1.5 x mediana de intervalo propio). Sin mediana se usa 30.
--   * Segmento (se evalua EN ESTE ORDEN; gana el primero que cumpla):
--       campeon              F = 4 (4 o mas ventas) y R >= 4
--       leal                 F >= 3 y R >= 3
--       en_riesgo_alto_valor R <= 2 y M >= 4
--       nuevo_prometedor     R >= 4 y una sola venta
--       dormido              cumple la definicion de DORMIDO de arriba (y no cayo antes)
--       ocasional            todo lo demas (incluye al de una sola venta que lleva tiempo sin volver: no es "dormido" porque no tiene intervalo propio)
--     La tabla del documento definia Dormido como "R <= 2 (resto)"; se sustituye por la definicion unica de arriba para no tener dos "dormidos".
--   * Reactivacion: >= 2 ventas y recencia > max(14, 1.5 x mediana de intervalo propio) O recencia > 30. Prioridad = venta del rango x
--     least(1, umbral / recencia), donde umbral = max(14, 1.5 x mediana): vale mas quien vendio mas y volvio hace menos de lo esperado; el factor baja
--     cuanto mas se aleja. Es una heuristica simple, NO una probabilidad calibrada. La bandera `dormido` de cada fila es la misma definicion unica.
--     Relacion con la 084: cfo_clientes_frecuentes_dormidos (hallazgo `frecuentes_dormidos`) mide a los FRECUENTES de cfo_config que llevan >= M dias sin pedir;
--     NO se modifica ni se duplica (aqui se mide al cliente contra su propio ritmo), y se documenta la diferencia en docs/restaurantes/ANALISIS-CLIENTES.md.
--   * Concentracion (Pareto): clientes ordenados por venta desc (empate por customer_id); % de la venta que reunen los primeros 10 %, 20 %, ... 100 %.
--   * Consentimiento (052, canal whatsapp): 'otorgado' | 'revocado' | 'sin_registro'. Solo se MUESTRA; esta migracion no envia nada.
--   * Tortilla: items[].tortilla in (maiz, harina, mixta) de las ventas; el resto de renglones no la exige y no cuenta. Salsas/omisiones/notas NO estan
--     estructuradas en la base: no se parsean (cero heuristicas sobre texto libre).
--
-- Justificacion de seguridad (una por una):
--  * Las cuatro funciones PUBLICAS son SECURITY DEFINER (orders, customers y marketing_consentimiento tienen RLS por rol y la 065 quito DML a authenticated;
--    son SOLO LECTURA, STABLE), con search_path fijo `restaurantes, core, pg_temp`, `revoke all from public, anon` y `grant execute to authenticated` (la sesion
--    de sistema del backend corre con ese rol sin usuario). anon NO tiene execute.
--  * Doble puerta como la 081/082: cfo_resolver_sucursales exige usuario owner/admin con alcance a CADA sucursal pedida (handoff_actor_en_sucursal) o sistema
--    (auth.uid() nulo) con sucursales de la organizacion declarada; sucursal ajena o inexistente = 42501; staff, repartidor y otra organizacion no pasan.
--    cfo_validar_rango rechaza rangos invertidos o de mas de 400 dias (22023). Toda lectura de ventas pasa por cfo_venta_lean / cfo_pedidos_base ya con las
--    sucursales resueltas; el consentimiento se lee SOLO de la organizacion consultada.
--  * Sin PII: ninguna funcion devuelve nombre, telefono, direccion ni customer_id. Los clientes se identifican con un alias = primeros 8 caracteres del sha-256 del
--    customer_id (igual que cfo_pedidos_detalle y la 084). Un alias de 8 caracteres NO es k-anonimo (un cliente individual con su valor): se acepta porque es una
--    lista OPERATIVA para owner/admin; los conteos por segmento y la curva de concentracion no exponen individuos.
--  * cfo_clientes_rfm_base es interna: `revoke all ... from public, anon, authenticated`; solo la llaman las funciones publicas (definer) DESPUES de resolver el
--    alcance. El limite de la lista de reactivacion es 1..200 (22023 fuera de el) para acotar el tamano de la respuesta.
--
-- Compatibilidad con una base sin migrar: las cuatro funciones publicas dan 42883 antes de aplicar esta migracion (el TypeScript degrada a `disponible: false`
-- con SAVEPOINT); una base sin la 052 da 42P01 solo en reactivacion (mismo tratamiento). Idempotente (create or replace + revoke/grant); aplicarla dos veces no cambia nada.

-- ---------------------------------------------------------------------------
-- 1) cfo_clientes_rfm_base (interna)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_clientes_rfm_base(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  customer_id uuid,
  ventas bigint,
  dias_con_venta bigint,
  primer_dia date,
  ultimo_dia date,
  venta_centavos bigint,
  recencia_dias integer,
  mediana_intervalo numeric,
  intervalos integer[],
  canal_frecuente text,
  r integer,
  f integer,
  m integer,
  segmento text,
  dormido boolean
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
begin
  return query
    with v as materialized (
      select l.customer_id, l.dia_negocio, l.neta_centavos, l.canal_efectivo
        from restaurantes.cfo_venta_lean(p_org, p_props, p_desde, p_hasta) l
       where l.customer_id is not null
    ),
    dias as materialized (
      select x.customer_id, x.dia_negocio from v x group by x.customer_id, x.dia_negocio
    ),
    gaps as (
      select d.customer_id,
             (d.dia_negocio - lag(d.dia_negocio) over (partition by d.customer_id order by d.dia_negocio))::integer as gap
        from dias d
    ),
    gp as (
      select g.customer_id,
             array_agg(g.gap order by g.gap) as arr,
             (percentile_cont(0.5) within group (order by g.gap))::numeric as med
        from gaps g
       where g.gap is not null
       group by g.customer_id
    ),
    cli as (
      select x.customer_id,
             count(*) as ventas,
             count(distinct x.dia_negocio) as dias_con_venta,
             min(x.dia_negocio) as primer,
             max(x.dia_negocio) as ultimo,
             coalesce(sum(x.neta_centavos), 0)::bigint as venta,
             mode() within group (order by x.canal_efectivo) as canal
        from v x
       group by x.customer_id
    ),
    base as (
      select c.customer_id, c.ventas, c.dias_con_venta, c.primer, c.ultimo, c.venta,
             (p_hasta - c.ultimo)::integer as rec,
             g.med, g.arr, c.canal,
             -- Clientes con recencia igual o PEOR (mas dias) / con venta igual o MENOR: el conteo incluye a los empatados (frame RANGE por omision).
             count(*) over (order by (p_hasta - c.ultimo) desc) as cnt_r,
             count(*) over (order by c.venta) as cnt_m,
             count(*) over () as n
        from cli c
        left join gp g on g.customer_id = c.customer_id
    ),
    sc as (
      select b.*,
             ((b.cnt_r * 5 + b.n - 1) / b.n)::integer as r,
             least(4, b.ventas)::integer as f,
             ((b.cnt_m * 5 + b.n - 1) / b.n)::integer as m,
             (b.ventas >= 2 and b.rec > greatest(30::numeric, 1.5 * coalesce(b.med, 0))) as dormido
        from base b
    )
    select s.customer_id, s.ventas, s.dias_con_venta, s.primer, s.ultimo, s.venta, s.rec, s.med, s.arr, s.canal, s.r, s.f, s.m,
           case when s.f >= 4 and s.r >= 4 then 'campeon'
                when s.f >= 3 and s.r >= 3 then 'leal'
                when s.r <= 2 and s.m >= 4 then 'en_riesgo_alto_valor'
                when s.r >= 4 and s.ventas = 1 then 'nuevo_prometedor'
                when s.dormido then 'dormido'
                else 'ocasional' end,
           s.dormido
      from sc s;
end;
$$;
revoke all on function restaurantes.cfo_clientes_rfm_base(uuid, uuid[], date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) cfo_clientes_rfm
-- ---------------------------------------------------------------------------
-- Devuelve UN jsonb (una sola foto consistente):
--   { "desde", "hasta",
--     "segmentos": [ {segmento, orden, clientes, pedidos, venta_centavos, ticket_centavos, recencia_mediana_dias} ],   -- los 6, siempre, en el orden de evaluacion
--     "resumen":   { clientes_con_venta, clientes_recompra, activos_30, dormidos, venta_total_centavos, venta_en_riesgo_centavos },
--     "pareto":    { puntos: [ {clientes_pct, clientes, venta_pct} ], clientes_para_50_pct, clientes_para_80_pct } }
-- venta_en_riesgo = venta del rango de los clientes DORMIDOS o en_riesgo_alto_valor. clientes_recompra = clientes con venta en >= 2 DIAS distintos (dos ventas el mismo dia no son una recompra). activos_30 = recencia <= 30.
create or replace function restaurantes.cfo_clientes_rfm(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
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
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  with b as materialized (
    select * from restaurantes.cfo_clientes_rfm_base(p_org, v_props, p_desde, p_hasta)
  ),
  segs(clave, orden) as (
    values ('campeon', 1), ('leal', 2), ('en_riesgo_alto_valor', 3), ('nuevo_prometedor', 4), ('dormido', 5), ('ocasional', 6)
  ),
  agg as (
    select x.segmento, count(*) as clientes, sum(x.ventas)::bigint as pedidos, sum(x.venta_centavos)::bigint as venta,
           (percentile_cont(0.5) within group (order by x.recencia_dias))::numeric as rec_med
      from b x group by x.segmento
  ),
  tot as (
    select count(*) as n, coalesce(sum(x.venta_centavos), 0)::bigint as venta
      from b x
  ),
  rk as (
    select row_number() over (order by x.venta_centavos desc, x.customer_id) as rn,
           sum(x.venta_centavos) over (order by x.venta_centavos desc, x.customer_id rows between unbounded preceding and current row) as cum
      from b x
  ),
  dec as (
    select g.d, ((t.n * g.d + 9) / 10) as rn
      from generate_series(1, 10) g(d) cross join tot t
     where t.n > 0
  )
  select jsonb_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'segmentos', (
      select jsonb_agg(jsonb_build_object(
               'segmento', s.clave, 'orden', s.orden,
               'clientes', coalesce(a.clientes, 0), 'pedidos', coalesce(a.pedidos, 0), 'venta_centavos', coalesce(a.venta, 0),
               'ticket_centavos', case when coalesce(a.pedidos, 0) > 0 then round(a.venta::numeric / a.pedidos)::bigint end,
               'recencia_mediana_dias', case when a.rec_med is not null then round(a.rec_med, 1) end) order by s.orden)
        from segs s left join agg a on a.segmento = s.clave),
    'resumen', jsonb_build_object(
      'clientes_con_venta', (select t.n from tot t),
      'clientes_recompra', (select count(*) from b x where x.dias_con_venta >= 2),
      'activos_30', (select count(*) from b x where x.recencia_dias <= 30),
      'dormidos', (select count(*) from b x where x.dormido),
      'venta_total_centavos', (select t.venta from tot t),
      'venta_en_riesgo_centavos', (select coalesce(sum(x.venta_centavos), 0)::bigint from b x where x.dormido or x.segmento = 'en_riesgo_alto_valor')),
    'pareto', jsonb_build_object(
      'puntos', coalesce((select jsonb_agg(jsonb_build_object(
                    'clientes_pct', d.d * 10, 'clientes', k.rn,
                    'venta_pct', case when t.venta > 0 then round(100.0 * k.cum / t.venta, 1) else 0 end) order by d.d)
                   from dec d join rk k on k.rn = d.rn cross join tot t), '[]'::jsonb),
      'clientes_para_50_pct', (select case when t.n > 0 and t.venta > 0 then round(100.0 * (select min(k.rn) from rk k where k.cum * 2 >= t.venta) / t.n, 1) end from tot t),
      'clientes_para_80_pct', (select case when t.n > 0 and t.venta > 0 then round(100.0 * (select min(k.rn) from rk k where k.cum * 5 >= t.venta * 4) / t.n, 1) end from tot t))
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function restaurantes.cfo_clientes_rfm(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_clientes_rfm(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) cfo_clientes_reactivacion
-- ---------------------------------------------------------------------------
-- Devuelve UN jsonb:
--   { "desde", "hasta", "total_elegibles", "mostrados", "venta_en_juego_centavos", "dormidos",
--     "consentimiento": { otorgado, revocado, sin_registro },                    -- sobre TODOS los elegibles, no solo los mostrados
--     "filas": [ {alias, ventas, ultima_venta, dias_sin_pedir, intervalo_mediano_dias, umbral_dias, venta_centavos, ticket_centavos,
--                 canal_frecuente, dormido, consentimiento, prioridad_centavos} ] }  -- top p_limite por prioridad desc (empate por customer_id)
create or replace function restaurantes.cfo_clientes_reactivacion(p_org uuid, p_props uuid[], p_desde date, p_hasta date, p_limite integer default 50)
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
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  if p_limite is null or p_limite < 1 or p_limite > 200 then
    raise exception 'cfo_clientes_reactivacion: limite invalido' using errcode = '22023';
  end if;
  with b as materialized (
    select * from restaurantes.cfo_clientes_rfm_base(p_org, v_props, p_desde, p_hasta)
  ),
  el as materialized (
    select x.customer_id, x.ventas, x.ultimo_dia, x.recencia_dias as rec, x.mediana_intervalo as med, x.venta_centavos, x.canal_frecuente, x.dormido,
           greatest(14::numeric, 1.5 * coalesce(x.mediana_intervalo, 0)) as umbral,
           coalesce(mc.estado, 'sin_registro') as consent
      from b x
      left join restaurantes.marketing_consentimiento mc
        on mc.organization_id = p_org and mc.customer_id = x.customer_id and mc.canal = 'whatsapp'
     where x.ventas >= 2
       and (x.recencia_dias > greatest(14::numeric, 1.5 * coalesce(x.mediana_intervalo, 0)) or x.recencia_dias > 30)
  ),
  -- nullif(e.rec,0): evita dividir entre cero si la recencia fuera 0 (compra el dia del corte); la prioridad quedaria NULL, y el filtro de recencia de `el` ya excluye esos casos.
  pr as (
    select e.*, round(e.venta_centavos * least(1::numeric, e.umbral / nullif(e.rec, 0)))::bigint as prioridad,
           row_number() over (order by round(e.venta_centavos * least(1::numeric, e.umbral / nullif(e.rec, 0))) desc, e.customer_id) as rn
      from el e
  ),
  top as (
    select * from pr where rn <= p_limite
  )
  select jsonb_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'total_elegibles', (select count(*) from el),
    'mostrados', (select count(*) from top),
    'venta_en_juego_centavos', (select coalesce(sum(e.venta_centavos), 0)::bigint from el e),
    'dormidos', (select count(*) from el e where e.dormido),
    'consentimiento', jsonb_build_object(
      'otorgado', (select count(*) from el e where e.consent = 'otorgado'),
      'revocado', (select count(*) from el e where e.consent = 'revocado'),
      'sin_registro', (select count(*) from el e where e.consent = 'sin_registro')),
    'filas', coalesce((select jsonb_agg(jsonb_build_object(
                'alias', left(encode(sha256(convert_to(t.customer_id::text, 'UTF8')), 'hex'), 8),
                'ventas', t.ventas,
                'ultima_venta', t.ultimo_dia,
                'dias_sin_pedir', t.rec,
                'intervalo_mediano_dias', case when t.med is not null then round(t.med, 1) end,
                'umbral_dias', round(t.umbral, 1),
                'venta_centavos', t.venta_centavos,
                'ticket_centavos', round(t.venta_centavos::numeric / t.ventas)::bigint,
                'canal_frecuente', t.canal_frecuente,
                'dormido', t.dormido,
                'consentimiento', t.consent,
                'prioridad_centavos', t.prioridad) order by t.rn) from top t), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function restaurantes.cfo_clientes_reactivacion(uuid, uuid[], date, date, integer) from public, anon;
grant execute on function restaurantes.cfo_clientes_reactivacion(uuid, uuid[], date, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) cfo_intervalo_recompra
-- ---------------------------------------------------------------------------
-- Un renglon 'global' y uno por segmento (los 6, siempre). Pool de TODOS los intervalos (dias entre dias de negocio consecutivos con venta) de los clientes
-- del grupo. Con menos de 5 intervalos los percentiles son NULL (muestra insuficiente: nunca se inventan).
create or replace function restaurantes.cfo_intervalo_recompra(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  segmento text,
  clientes bigint,
  intervalos bigint,
  p25 numeric,
  p50 numeric,
  p75 numeric,
  p90 numeric
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  return query
    with b as materialized (
      select * from restaurantes.cfo_clientes_rfm_base(p_org, v_props, p_desde, p_hasta)
    ),
    gr(clave, orden) as (
      values ('global', 0), ('campeon', 1), ('leal', 2), ('en_riesgo_alto_valor', 3), ('nuevo_prometedor', 4), ('dormido', 5), ('ocasional', 6)
    ),
    iv as (
      select x.segmento, u.gap
        from b x cross join lateral unnest(coalesce(x.intervalos, '{}'::integer[])) as u(gap)
    ),
    pool as (
      select g.clave, g.orden, i.gap
        from gr g
        join iv i on g.clave = 'global' or i.segmento = g.clave
    ),
    st as (
      select p.clave, count(*) as n,
             percentile_cont(0.25) within group (order by p.gap) as q25,
             percentile_cont(0.50) within group (order by p.gap) as q50,
             percentile_cont(0.75) within group (order by p.gap) as q75,
             percentile_cont(0.90) within group (order by p.gap) as q90
        from pool p group by p.clave
    )
    select g.clave::text,
           case when g.clave = 'global' then (select count(*) from b) else (select count(*) from b x where x.segmento = g.clave) end,
           coalesce(s.n, 0)::bigint,
           case when coalesce(s.n, 0) >= 5 then round(s.q25::numeric, 1) end,
           case when coalesce(s.n, 0) >= 5 then round(s.q50::numeric, 1) end,
           case when coalesce(s.n, 0) >= 5 then round(s.q75::numeric, 1) end,
           case when coalesce(s.n, 0) >= 5 then round(s.q90::numeric, 1) end
      from gr g left join st s on s.clave = g.clave
     order by g.orden;
end;
$$;
revoke all on function restaurantes.cfo_intervalo_recompra(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_intervalo_recompra(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) cfo_pedidos_tortilla
-- ---------------------------------------------------------------------------
-- { "desde", "hasta", "pedidos_con_items", "tortilla": [ {tipo, renglones, unidades, pedidos} ] }  -- tipo in (maiz, harina, mixta), los 3 siempre
-- pedidos_con_items = ventas cuyo items trae al menos un elemento (las importadas sin detalle quedan fuera). unidades suma items[].quantity solo cuando es un
-- entero valido (la misma regla de cfo_renglones); un renglon con tortilla y cantidad invalida cuenta como renglon pero no suma unidades.
create or replace function restaurantes.cfo_pedidos_tortilla(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
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
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  with b as materialized (
    select pb.order_id, pb.items
      from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta) pb
     where pb.es_venta
  ),
  el as (
    select b.order_id, e.value ->> 'tortilla' as tipo,
           case when (e.value ->> 'quantity') ~ '^[0-9]{1,6}$' then (e.value ->> 'quantity')::integer else 0 end as qty
      from b
      cross join lateral jsonb_array_elements(case when jsonb_typeof(b.items) = 'array' then b.items else '[]'::jsonb end) as e(value)
     where jsonb_typeof(e.value) = 'object' and (e.value ->> 'tortilla') in ('maiz', 'harina', 'mixta')
  ),
  tp(tipo, orden) as (values ('maiz', 1), ('harina', 2), ('mixta', 3)),
  ag as (
    select x.tipo, count(*) as renglones, sum(x.qty)::bigint as unidades, count(distinct x.order_id) as pedidos from el x group by x.tipo
  )
  select jsonb_build_object(
    'desde', p_desde,
    'hasta', p_hasta,
    'pedidos_con_items', (select count(*) from b where jsonb_typeof(b.items) = 'array' and jsonb_array_length(b.items) > 0),
    'tortilla', (select jsonb_agg(jsonb_build_object('tipo', t.tipo, 'renglones', coalesce(a.renglones, 0), 'unidades', coalesce(a.unidades, 0),
                                                     'pedidos', coalesce(a.pedidos, 0)) order by t.orden)
                   from tp t left join ag a on a.tipo = t.tipo)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function restaurantes.cfo_pedidos_tortilla(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_pedidos_tortilla(uuid, uuid[], date, date) to authenticated;

comment on function restaurantes.cfo_clientes_rfm(uuid, uuid[], date, date) is 'CFO: segmentos RFM (umbrales fijos de frecuencia, quintiles de rango para recencia y monto, recencia anclada a p_hasta), resumen y curva de concentracion. Solo lectura, sin PII.';
comment on function restaurantes.cfo_clientes_reactivacion(uuid, uuid[], date, date, integer) is 'CFO: clientes con >= 2 ventas que superan su ritmo de recompra, priorizados; alias de 8 caracteres y consentimiento de marketing (052) visible. Solo lectura, sin PII.';
comment on function restaurantes.cfo_intervalo_recompra(uuid, uuid[], date, date) is 'CFO: p25/p50/p75/p90 de dias entre dias con venta, global y por segmento RFM (NULL con menos de 5 intervalos). Solo lectura.';
comment on function restaurantes.cfo_pedidos_tortilla(uuid, uuid[], date, date) is 'CFO: renglones, unidades y pedidos por tipo de tortilla (items[].tortilla) de las ventas. Solo lectura, sin PII.';
