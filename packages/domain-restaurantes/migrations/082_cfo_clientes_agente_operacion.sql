-- CFO-02: SQL de clientes, agente (costos y embudo), operacion, colonias, comandas del POS y agotados del modulo CFO de restaurantes (v1).
-- Prefijo de supabase/migrations: 20240101000392 (interno restaurantes 082).
-- Requiere: 001 (orders, customers, customer_addresses, whatsapp_conversations, branch_products), 005/056 (nearest_branch_by_colonia),
-- 008 (assigned_repartidor_id, incident_note), 024 (pos_comanda_outbox, softrestaurant_config), 025 (voice_conversation), 028 (conversation_handoff,
-- handoff_actor_en_sucursal), 035 (voz_zona_horaria), 040 (referencia de cohorte de WhatsApp), 049 (customer_addresses.colonia, pedido_falso_at),
-- 050 (por_aprobar, solicitud_aprobacion.reposicion_order_id, branch_products.agotado_hasta), 052 (marketing_campana_envio), 054
-- (pos_comanda_alerta_config), 076/077 (dia_negocio, dia_negocio_corte) y 081 (cfo_resolver_sucursales, cfo_validar_rango, cfo_pedidos_base,
-- cfo_renglones), mas la plataforma de costos (core.usage_cost_event, core.llm_usage_daily, core.fx_rate).
--
-- Que agrega (todo NUEVO: funciones cfo_* nuevas; NINGUNA tabla, funcion, policy ni GRANT existente se modifica o se redefine. En particular NO se
-- redefinen dia_negocio, voz_kpis_diarios, whatsapp_kpis_diarios, cierre_agregados ni ninguna funcion de la 081: solo se LLAMAN o se reimplementa su lectura):
--   * restaurantes.cfo_alcance_org_completo(org)       -- helper interno: true si el actor tiene alcance de organizacion completa (o es sistema).
--   * restaurantes.cfo_zonas(props)                    -- helper interno: zona y corte de varias sucursales con UN solo recorrido de pg_timezone_names.
--   * restaurantes.cfo_venta_lean(...)                 -- helper interno: una fila por VENTA (regla de 081) SIN jsonb de renglones; barato para 455 dias.
--   * restaurantes.cfo_colonia_cercana(org, colonia)   -- helper interno: sucursal de despacho mas cercana (056) sin romper si no responde.
--   * restaurantes.cfo_clientes_resumen(...)           -- 1. clientes por sucursal + renglon del conjunto (NO aditivo).
--   * restaurantes.cfo_clientes_cohortes(...)          -- 2. cohortes por mes del primer pedido con recompra a 30/60/90 dias.
--   * restaurantes.cfo_clientes_altas(...)             -- 3. altas (primer pedido) por semana ISO.
--   * restaurantes.cfo_clientes_segmento_hora(...)     -- 4. pedidos y venta neta por segmento (nuevo/recurrente/frecuente), hora y dia de la semana.
--   * restaurantes.cfo_agente_diario(...)              -- 5. embudo de WhatsApp y voz y costos del agente por sucursal/dia + fila «No asignado».
--   * restaurantes.cfo_escalaciones_hora(...)          -- 6. conversaciones y handoffs por dia de la semana y hora.
--   * restaurantes.cfo_entregas(...)                   -- 7a. entregas por hora/dia de la semana (aditivo).
--   * restaurantes.cfo_entregas_percentiles(...)       -- 7b. p50/p90 de entrega por sucursal y del conjunto (NO aditivo).
--   * restaurantes.cfo_repartidores(...)               -- 8. entregas, minutos, tardes e incidencias por repartidor.
--   * restaurantes.cfo_colonias(...)                   -- 9. pedidos por colonia con k-anonimato (k >= 5) y sucursal de despacho mas cercana.
--   * restaurantes.cfo_comandas_pos(...)               -- 10. comandas de SoftRestaurant por estado y dia de negocio + modo vigente.
--   * restaurantes.cfo_agotados(...)                   -- 11. productos agotados y su venta de los ultimos 28 dias.
-- Es SOLO LECTURA: ninguna funcion escribe, ninguna tabla nueva, ningun indice nuevo.
--
-- Definiciones (los rotulos de la pantalla las repiten tal cual):
--   * Venta, dia de negocio, hora local y dow_negocio: las MISMAS de la 081 (ver su cabecera). cfo_venta_lean repite la regla de venta de
--     cfo_pedidos_base (no cancelado, no_recogido, por_aprobar ni programado; sin pedido_falso_at; sin telefono demo 0009; sin reposiciones) con la
--     misma formula en linea del dia de negocio, pero sin calcular renglones ni bruta, que los clientes no necesitan. Zona y corte salen de cfo_zonas (un solo recorrido de pg_timezone_names por consulta). El verify prueba que ambas
--     coinciden pedido por pedido (cantidad, neta, dia, hora y minutos de entrega). NUNCA se llama voz_zona_horaria/dia_negocio por pedido
--     (recorren pg_timezone_names, ~30-80 ms por llamada): zona y corte se resuelven UNA vez por consulta (cfo_zonas).
--   * Cliente = orders.customer_id. Los pedidos sin cliente identificado no entran a las metricas de clientes (se cuentan en pedidos_sin_cliente).
--     Los clientes se miran con una historia de 365 dias antes del rango: «nuevo» = sin pedido en esos 365 dias (un cliente que vuelve tras mas
--     de un ano se verá como nuevo: limite declarado). Por sucursal, «nuevo» es su primer pedido EN esa sucursal; en el renglon del conjunto, el primero
--     de las sucursales consultadas (toda la organizacion cuando p_props es nulo).
--   * Activo / dormido / perdido, al CIERRE del rango (p_hasta): dias desde el ultimo pedido <= p_activo_dias (60) / hasta p_perdido_dias (120) /
--     mas de p_perdido_dias y como maximo 365. Frecuente: >= p_frecuente_n (3) pedidos en los ultimos p_frecuente_dias (90) dias que terminan en p_hasta
--     (con 90, el pedido de p_hasta-89 cuenta y el de p_hasta-90 no). El punto de enlace con cfo_config (083, frecuente_n/frecuente_dias/activo_dias/
--     perdido_dias) es el llamador: la 083 aun no esta fusionada, asi que aqui rigen los defaults de los parametros.
--   * Recuperado: cliente que al INICIO del rango (p_desde) llevaba mas de p_activo_dias sin pedir (dormido o perdido) y tiene pedido en el rango.
--     Por campana: ademas tiene un envio de marketing_campana_envio (estado 'encolado') creado en los 14 dias previos a su primer pedido del rango
--     (atribucion, no causalidad).
--   * Dias entre pedidos: mediana de los intervalos entre dias de negocio distintos consecutivos con pedido de cada cliente, con el pedido posterior
--     dentro del rango (dos pedidos el mismo dia son una sola ocasion de compra).
--   * Concentracion: venta neta del 10 % de clientes con mas venta del rango (ceil(n/10) clientes) sobre la venta neta total de clientes identificados.
--   * Multi-sucursal: multi_sucursal = Σ clientes_con_pedido de las sucursales − clientes_con_pedido del conjunto (es lo que el dominio verifica);
--     coincide con «clientes que compraron en mas de una sucursal» salvo que alguien compre en tres o mas (cuenta k−1 por cliente);
--     clientes_varias_sucursales es el conteo exacto de clientes distintos con pedido en 2 o mas sucursales.
--   * Cohorte: mes (dia de negocio) del primer pedido. Recompra a N dias = tiene un pedido en un dia de negocio POSTERIOR al del primero y a no mas de
--     N dias. observables_N = clientes cuya ventana de N dias ya termino (la tasa honesta es con_recompra_N / observables_N).
--   * Agente: un renglon por sucursal y dia de negocio CON actividad. WhatsApp = misma cohorte que 040 (conversacion nueva en su primer contacto, con
--     pedido si queda ligada a un pedido no cancelado de canal whatsapp, handoff = solicitud de humano); voz = llamadas (canal 'llamada') por resultado.
--     Costo por sucursal = voz en vivo (voice_conversation.costo_estimado_micro_usd) + telefonia (usage_cost_event 'telefonia' de esa sucursal);
--     la categoria 'voz' NO se suma (doble conteo, ver 035); Meta = categoria 'whatsapp' con sucursal, y con 0 eventos el costo es NULL («no medido»,
--     nunca $0). Centavos MXN = round(micro-USD × mxn_por_usd / 10000) con el ultimo core.fx_rate con fecha <= el dia de negocio; sin tipo de cambio,
--     NULL. Las comparaciones con voz_kpis_diarios (035) son contra el dia calendario local, que coincide con el de negocio en sucursales sin corte.
--     Fila «No asignado» (property_id nulo): LLM de texto de core.llm_usage_daily (vertical restaurantes, roles whatsapp_agent y
--     whatsapp_agent_escalated; NULL en organizaciones demo, donde se mezcla con el widget publico) y eventos de usage_cost_event sin sucursal (dia
--     calendario de America/Mexico_City). Solo con alcance de organizacion completa (owner/admin con property_ids nulo) o en sesion de sistema, y
--     solo si la consulta cubre TODAS las sucursales de la organizacion (p_props nulo o completo): un admin acotado nunca la ve.
--   * Comandas: por dia de negocio de creado_en. Minutos a captura = capturado_en − creado_en (capturada a mano) o actualizado_en − creado_en
--     (confirmada por el POS). vencidas_umbral = capturadas a mano con mas minutos que el umbral de su sucursal (pos_comanda_alerta_config, 5 por
--     omision) + las que siguen esperando captura manual desde hace mas que el umbral (misma regla que pos_comandas_captura_manual_vencidas).
--     Sin comandas en el rango se devuelve un renglon en cero (dia = p_desde) con el modo vigente: 'apagado' si no hay softrestaurant_config.
--   * Colonias: la del domicilio guardado del cliente con el mismo texto de direccion normalizado (lower, sin espacios dobles); sin coincidencia
--     = '(sin colonia)'. Por sucursal, las colonias con menos de p_k pedidos (k >= 5, 22023 si se pide menos) se agrupan en '(otras)'.
--   * Sin PII: ninguna funcion devuelve nombre, telefono ni direccion de cliente, ni el id del cliente. El nombre del repartidor es de staff
--     (core.staff_user.full_name, nunca telefono ni correo) y solo si pertenece a la organizacion.
--
-- Justificacion de seguridad (una por una):
--  * Funciones publicas (las 12 de arriba que no son helpers): SECURITY DEFINER (orders/customers/voice_*/pos_comanda_outbox tienen RLS por rol y la 065
--    quito DML a authenticated; core.usage_cost_event, llm_usage_daily y fx_rate estan cerradas a authenticated), STABLE (solo lectura), search_path
--    fijo `restaurantes, core, pg_temp`, `revoke all from public, anon`, `grant execute to authenticated` (la sesion de sistema del backend corre con
--    ese rol sin usuario). Doble puerta, igual que la 081, via cfo_resolver_sucursales (081): usuario con owner/admin con alcance a CADA sucursal
--    pedida (handoff_actor_en_sucursal), o sistema (auth.uid() nulo) con sucursales de la organizacion declarada; 42501 con el mismo mensaje para
--    sucursal ajena o inexistente; staff, repartidor y otra organizacion no pasan. p_props nulo = todas las permitidas (admin acotado = las suyas).
--  * Rango maximo de 400 dias (22023) y p_props de hasta 500 elementos (22023). Parametros numericos con limites explicitos (22023).
--  * Helpers (cfo_alcance_org_completo, cfo_zonas, cfo_venta_lean, cfo_colonia_cercana): `revoke all from public, anon, authenticated`; sin guard propio porque
--    solo los invocan las publicas, que ya validaron el acceso. NO se pueden llamar desde authenticated.
--  * Todo filtro lleva organization_id Y property_id (sucursales ya resueltas), nunca confia en parametros ajenos.
--
-- Compatibilidad con una base sin migrar: todo es nuevo. Llamar una de estas funciones antes de aplicar la migracion da 42883; el TypeScript lo
-- degrada con SAVEPOINT. Idempotente (create or replace / revoke+grant); aplicarla dos veces no cambia nada.

-- ---------------------------------------------------------------------------
-- 1) Helpers internos
-- ---------------------------------------------------------------------------
-- Alcance de organizacion completa: sistema (auth.uid() nulo) u owner/admin con property_ids nulo. Lo usa la fila «No asignado».
create or replace function restaurantes.cfo_alcance_org_completo(p_org uuid)
returns boolean
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select auth.uid() is null or exists (
    select 1 from core.membership m
     where m.user_id = auth.uid() and m.organization_id = p_org
       and m.vertical_role in ('owner', 'admin') and m.property_ids is null
  );
$$;
revoke all on function restaurantes.cfo_alcance_org_completo(uuid) from public, anon, authenticated;

-- Zona horaria y corte de varias sucursales de un golpe. voz_zona_horaria valida contra pg_timezone_names (~600 zonas, ~30-80 ms por llamada): aqui se
-- recorre UNA vez por consulta, no una vez por sucursal ni por pedido. Misma regla que voz_zona_horaria (zona valida de branch_detail o
-- America/Mexico_City); el verify comprueba que coinciden sucursal por sucursal.
create or replace function restaurantes.cfo_zonas(p_props uuid[])
returns table (property_id uuid, tz text, corte interval)
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  with z as materialized (select zn.name from pg_catalog.pg_timezone_names zn)
  select x.pid,
         coalesce((select bd.zona_horaria from restaurantes.branch_detail bd
                    where bd.property_id = x.pid and bd.zona_horaria is not null and exists (select 1 from z where z.name = bd.zona_horaria)),
                  'America/Mexico_City'),
         restaurantes.dia_negocio_corte(x.pid)
    from unnest(p_props) as x(pid);
$$;
revoke all on function restaurantes.cfo_zonas(uuid[]) from public, anon, authenticated;

-- Ventas (misma regla que cfo_pedidos_base de la 081) SIN renglones: una fila por venta con el dia de negocio calculado en linea.
-- Zona y corte se resuelven UNA vez por sucursal en variables (arreglos) y la consulta solo usa funciones nativas: asi el planificador puede
-- recorrer orders en paralelo (una CTE con voz_zona_horaria, que es PARALLEL UNSAFE, lo impedia).
create or replace function restaurantes.cfo_venta_lean(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  order_id uuid,
  property_id uuid,
  customer_id uuid,
  inicio timestamptz,
  dia_negocio date,
  hora_local integer,
  dow_negocio integer,
  canal_efectivo text,
  neta_centavos bigint,
  entregado_min numeric,
  repartidor_id uuid,
  con_incidencia boolean
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_pids uuid[];
  v_tzs text[];
  v_cortes interval[];
begin
  select array_agg(z.property_id order by z.property_id), array_agg(z.tz order by z.property_id), array_agg(z.corte order by z.property_id)
    into v_pids, v_tzs, v_cortes
    from restaurantes.cfo_zonas(p_props) z;
  return query
    with src as (
      select o.id, o.property_id, o.customer_id, o.status, o.total, o.canal, o.customer_address, o.delivered_at,
             o.assigned_repartidor_id, o.incident_note, par.tz, par.corte, coalesce(o.promovido_at, o.created_at) as inicio
        from restaurantes.orders o
        join unnest(v_pids, v_tzs, v_cortes) as par(property_id, tz, corte) on par.property_id = o.property_id
       where o.organization_id = p_org
         and o.status not in ('programado', 'cancelado', 'no_recogido', 'por_aprobar')
         and o.pedido_falso_at is null
         and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
         and ((o.created_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and o.created_at < ((p_hasta + 4)::timestamp at time zone 'UTC'))
           or (o.promovido_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and o.promovido_at < ((p_hasta + 4)::timestamp at time zone 'UTC')))
    ),
    dn as (
      select s.*, ((s.inicio at time zone s.tz) - s.corte)::date as dia
        from src s
       where not exists (
         select 1 from restaurantes.solicitud_aprobacion r where r.organization_id = p_org and r.reposicion_order_id = s.id
       )
    )
    select d.id, d.property_id, d.customer_id, d.inicio, d.dia,
           extract(hour from (d.inicio at time zone d.tz))::integer,
           extract(isodow from d.dia)::integer,
           coalesce(d.canal, case when d.customer_address is not null then 'domicilio' else 'recoger' end),
           round(d.total * 100)::bigint,
           case when d.status in ('entregado', 'completado') and d.delivered_at is not null and d.delivered_at >= d.inicio
                then round(extract(epoch from (d.delivered_at - d.inicio))::numeric / 60.0, 2) end,
           d.assigned_repartidor_id,
           (d.incident_note is not null)
      from dn d
     where d.dia between p_desde and p_hasta;
end;
$$;
revoke all on function restaurantes.cfo_venta_lean(uuid, uuid[], date, date) from public, anon, authenticated;

-- Sucursal de despacho mas cercana a una colonia (056). Si la funcion no responde o falla, no rompe el reporte: nulo.
create or replace function restaurantes.cfo_colonia_cercana(p_org uuid, p_colonia text)
returns table (sucursal_id uuid, distancia_km numeric)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  return query
    select n.property_id, n.distance_km from restaurantes.nearest_branch_by_colonia(p_org, p_colonia) n limit 1;
exception when others then
  return;
end;
$$;
revoke all on function restaurantes.cfo_colonia_cercana(uuid, text) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) cfo_clientes_resumen
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_clientes_resumen(
  p_org uuid,
  p_props uuid[],
  p_desde date,
  p_hasta date,
  p_frecuente_n integer default 3,
  p_frecuente_dias integer default 90,
  p_activo_dias integer default 60,
  p_perdido_dias integer default 120
) returns table (
  property_id uuid,
  alcance text,
  clientes_con_pedido bigint,
  nuevos bigint,
  recurrentes bigint,
  activos bigint,
  dormidos bigint,
  perdidos bigint,
  frecuentes bigint,
  multi_sucursal bigint,
  clientes_varias_sucursales bigint,
  recuperados bigint,
  recuperados_por_campana bigint,
  dias_entre_pedidos_mediana numeric,
  neta_top10pct_centavos bigint,
  neta_total_centavos bigint,
  pedidos_por_cliente_12m_promedio numeric,
  pedidos_con_cliente bigint,
  pedidos_sin_cliente bigint
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
set work_mem = '48MB'
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_envios boolean;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  if p_frecuente_n is null or p_frecuente_n < 1 or p_frecuente_n > 100
     or p_frecuente_dias is null or p_frecuente_dias < 1 or p_frecuente_dias > 365
     or p_activo_dias is null or p_activo_dias < 1 or p_activo_dias > 364
     or p_perdido_dias is null or p_perdido_dias <= p_activo_dias or p_perdido_dias > 364 then
    raise exception 'cfo_clientes_resumen: umbrales invalidos' using errcode = '22023';
  end if;
  -- Sin ningun envio de campana en la organizacion no hay atribucion que buscar (evita una sonda por cada recuperado).
  select exists (select 1 from restaurantes.marketing_campana_envio e where e.organization_id = p_org and e.estado = 'encolado') into v_envios;
  return query
    with b as materialized (
      select l.property_id, l.customer_id, l.inicio, l.dia_negocio as dia, l.neta_centavos as neta
        from restaurantes.cfo_venta_lean(p_org, v_props, p_desde - 365, p_hasta) l
    ),
    bc as (select * from b where b.customer_id is not null),
    -- Una fila por (cliente, sucursal) y una por cliente en el conjunto (g = 1).
    agg as materialized (
      select bc.customer_id, bc.property_id, grouping(bc.property_id) as g,
             max(bc.dia) as ultimo_dia,
             max(bc.dia) filter (where bc.dia < p_desde) as ultimo_previo,
             count(*) filter (where bc.dia >= p_desde) as n_rango,
             coalesce(sum(bc.neta) filter (where bc.dia >= p_desde), 0)::bigint as neta_rango,
             count(*) filter (where bc.dia > p_hasta - p_frecuente_dias) as n_frec,
             count(*) filter (where bc.dia > p_hasta - 365) as n_12m,
             min(bc.inicio) filter (where bc.dia >= p_desde) as primer_inicio_rango
        from bc
       group by grouping sets ((bc.customer_id, bc.property_id), (bc.customer_id))
    ),
    agg2 as (
      select a.*,
             (a.n_rango > 0 and a.ultimo_previo is not null and p_desde - a.ultimo_previo > p_activo_dias) as recuperado
        from agg a
    ),
    camp as (
      select a.customer_id, a.property_id, a.g,
             v_envios and exists (
               select 1 from restaurantes.marketing_campana_envio e
                where e.organization_id = p_org and e.customer_id = a.customer_id and e.estado = 'encolado'
                  and e.created_at >= a.primer_inicio_rango - interval '14 days' and e.created_at <= a.primer_inicio_rango
             ) as por_campana
        from agg2 a
       where a.recuperado
    ),
    -- Intervalos entre pedidos consecutivos del cliente. Solo se ordenan los pedidos del rango y el ultimo previo de cada cliente (lo unico que
    -- puede ser el anterior de un pedido del rango). El 0 (dos pedidos el mismo dia) se descarta, lo que deja exactamente los intervalos entre dias
    -- de negocio distintos consecutivos.
    iv as (
      select s.property_id, 0 as g, s.dia, s.dia - lag(s.dia) over (partition by s.customer_id, s.property_id order by s.dia) as d
        from (select bc.customer_id, bc.property_id, bc.dia
                from bc join agg a on a.g = 0 and a.customer_id = bc.customer_id and a.property_id = bc.property_id
               where bc.dia >= p_desde or bc.dia = a.ultimo_previo) s
      union all
      select null::uuid, 1, s.dia, s.dia - lag(s.dia) over (partition by s.customer_id order by s.dia)
        from (select bc.customer_id, bc.dia
                from bc join agg a on a.g = 1 and a.customer_id = bc.customer_id
               where bc.dia >= p_desde or bc.dia = a.ultimo_previo) s
    ),
    -- Mediana por histograma (los intervalos son enteros chicos): evita ordenar decenas de miles de filas.
    h as (
      select iv.property_id, iv.g, iv.d, count(*) as c from iv where iv.d > 0 and iv.dia >= p_desde group by iv.property_id, iv.g, iv.d
    ),
    cum as (
      select h.property_id, h.g, h.d,
             (sum(h.c) over (partition by h.g, h.property_id order by h.d))::bigint - h.c as lo,
             (sum(h.c) over (partition by h.g, h.property_id order by h.d))::bigint as hi,
             (sum(h.c) over (partition by h.g, h.property_id))::bigint as n
        from h
    ),
    med as (
      select c.property_id, c.g, avg(c.d)::numeric as m
        from cum c
       where (c.lo < (c.n + 1) / 2 and c.hi >= (c.n + 1) / 2) or (c.lo < (c.n + 2) / 2 and c.hi >= (c.n + 2) / 2)
       group by c.property_id, c.g
    ),
    rk as (
      select a.property_id, a.g, a.neta_rango,
             row_number() over (partition by a.g, a.property_id order by a.neta_rango desc, a.customer_id) as rn,
             count(*) over (partition by a.g, a.property_id) as cnt
        from agg a
       where a.n_rango > 0
    ),
    top as (
      select r.property_id, r.g, coalesce(sum(r.neta_rango) filter (where r.rn <= (r.cnt + 9) / 10), 0)::bigint as top10
        from rk r
       group by r.property_id, r.g
    ),
    multi as (
      select a.customer_id, count(*) as k from agg a where a.g = 0 and a.n_rango > 0 group by a.customer_id
    ),
    fin as (
      select a.property_id, a.g,
             count(*) filter (where a.n_rango > 0) as con_pedido,
             count(*) filter (where a.n_rango > 0 and a.ultimo_previo is null) as nuevos,
             count(*) filter (where a.n_rango > 0 and a.ultimo_previo is not null) as recurrentes,
             count(*) filter (where p_hasta - a.ultimo_dia <= p_activo_dias) as activos,
             count(*) filter (where p_hasta - a.ultimo_dia > p_activo_dias and p_hasta - a.ultimo_dia <= p_perdido_dias) as dormidos,
             count(*) filter (where p_hasta - a.ultimo_dia > p_perdido_dias and p_hasta - a.ultimo_dia <= 365) as perdidos,
             count(*) filter (where a.n_frec >= p_frecuente_n) as frecuentes,
             count(*) filter (where a.recuperado) as recuperados,
             coalesce(sum(a.neta_rango), 0)::bigint as neta_total,
             coalesce(sum(a.n_12m), 0)::bigint as pedidos_12m,
             count(*) filter (where a.n_12m > 0) as clientes_12m
        from agg2 a
       group by a.property_id, a.g
    ),
    por_camp as (
      select c.property_id, c.g, count(*) filter (where c.por_campana) as n from camp c group by c.property_id, c.g
    ),
    ped as (
      select b.property_id,
             count(*) filter (where b.customer_id is not null)::bigint as con_cliente,
             count(*) filter (where b.customer_id is null)::bigint as sin_cliente
        from b
       where b.dia >= p_desde
       group by b.property_id
    ),
    m_tot as (select coalesce(sum(m.k), 0) as suma_k, count(*) as clientes, count(*) filter (where m.k >= 2) as varias from multi m),
    -- Renglones de salida: una por sucursal permitida + el conjunto.
    ren as (
      select u.pid as property_id, 0 as g from unnest(v_props) as u(pid)
      union all
      select null::uuid, 1
    )
    select r.property_id,
           case when r.g = 0 then 'sucursal' else 'conjunto' end,
           coalesce(f.con_pedido, 0)::bigint,
           coalesce(f.nuevos, 0)::bigint,
           coalesce(f.recurrentes, 0)::bigint,
           coalesce(f.activos, 0)::bigint,
           coalesce(f.dormidos, 0)::bigint,
           coalesce(f.perdidos, 0)::bigint,
           coalesce(f.frecuentes, 0)::bigint,
           case when r.g = 1 then (select mt.suma_k - mt.clientes from m_tot mt)::bigint end,
           case when r.g = 1 then (select mt.varias from m_tot mt)::bigint end,
           coalesce(f.recuperados, 0)::bigint,
           coalesce(pc.n, 0)::bigint,
           round(md.m::numeric, 1),
           coalesce(t.top10, 0)::bigint,
           coalesce(f.neta_total, 0)::bigint,
           case when coalesce(f.clientes_12m, 0) > 0 then round(f.pedidos_12m::numeric / f.clientes_12m, 2) end,
           case when r.g = 0 then coalesce(pd.con_cliente, 0) else (select coalesce(sum(p2.con_cliente), 0) from ped p2) end::bigint,
           case when r.g = 0 then coalesce(pd.sin_cliente, 0) else (select coalesce(sum(p2.sin_cliente), 0) from ped p2) end::bigint
      from ren r
      left join fin f on f.g = r.g and f.property_id is not distinct from r.property_id
      left join por_camp pc on pc.g = r.g and pc.property_id is not distinct from r.property_id
      left join med md on md.g = r.g and md.property_id is not distinct from r.property_id
      left join top t on t.g = r.g and t.property_id is not distinct from r.property_id
      left join ped pd on r.g = 0 and pd.property_id = r.property_id
     order by r.g, r.property_id;
end;
$$;
revoke all on function restaurantes.cfo_clientes_resumen(uuid, uuid[], date, date, integer, integer, integer, integer) from public, anon;
grant execute on function restaurantes.cfo_clientes_resumen(uuid, uuid[], date, date, integer, integer, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) cfo_clientes_cohortes
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_clientes_cohortes(p_org uuid, p_props uuid[], p_meses integer default 6)
returns table (
  property_id uuid,
  mes_cohorte text,
  clientes bigint,
  con_recompra_30 bigint,
  con_recompra_60 bigint,
  con_recompra_90 bigint,
  observables_30 bigint,
  observables_60 bigint,
  observables_90 bigint
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
set work_mem = '48MB'
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_hoy date;
  v_ini date;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  if p_meses is null or p_meses < 1 or p_meses > 24 then
    raise exception 'cfo_clientes_cohortes: meses invalidos' using errcode = '22023';
  end if;
  -- «Hoy» = el dia de negocio vigente mas reciente entre las sucursales consultadas.
  select max(((now() at time zone z.tz) - z.corte)::date) into v_hoy from restaurantes.cfo_zonas(v_props) z;
  v_ini := (date_trunc('month', v_hoy::timestamp) - make_interval(months => p_meses - 1))::date;
  return query
    with bc as materialized (
      select l.property_id, l.customer_id, l.dia_negocio as dia
        from restaurantes.cfo_venta_lean(p_org, v_props, v_ini - 365, v_hoy) l
       where l.customer_id is not null
    ),
    f as (
      select bc.customer_id, bc.property_id, grouping(bc.property_id) as g,
             (array_agg(distinct bc.dia order by bc.dia))[1] as primer,
             (array_agg(distinct bc.dia order by bc.dia))[2] as segundo
        from bc
       group by grouping sets ((bc.customer_id, bc.property_id), (bc.customer_id))
    )
    select f.property_id,
           to_char(date_trunc('month', f.primer::timestamp), 'YYYY-MM'),
           count(*)::bigint,
           (count(*) filter (where f.segundo is not null and f.segundo - f.primer <= 30))::bigint,
           (count(*) filter (where f.segundo is not null and f.segundo - f.primer <= 60))::bigint,
           (count(*) filter (where f.segundo is not null and f.segundo - f.primer <= 90))::bigint,
           (count(*) filter (where f.primer + 30 <= v_hoy))::bigint,
           (count(*) filter (where f.primer + 60 <= v_hoy))::bigint,
           (count(*) filter (where f.primer + 90 <= v_hoy))::bigint
      from f
     where f.primer >= v_ini
     group by f.property_id, f.g, date_trunc('month', f.primer::timestamp)
     order by f.g, f.property_id, date_trunc('month', f.primer::timestamp);
end;
$$;
revoke all on function restaurantes.cfo_clientes_cohortes(uuid, uuid[], integer) from public, anon;
grant execute on function restaurantes.cfo_clientes_cohortes(uuid, uuid[], integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) cfo_clientes_altas
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_clientes_altas(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  semana date,
  altas bigint
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
set work_mem = '48MB'
as $$
#variable_conflict use_column
declare
  v_props uuid[];
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  return query
    with bc as materialized (
      select l.property_id, l.customer_id, l.dia_negocio as dia
        from restaurantes.cfo_venta_lean(p_org, v_props, p_desde - 365, p_hasta) l
       where l.customer_id is not null
    ),
    f as (
      select bc.customer_id, bc.property_id, grouping(bc.property_id) as g, min(bc.dia) as primer
        from bc
       group by grouping sets ((bc.customer_id, bc.property_id), (bc.customer_id))
    )
    select f.property_id, date_trunc('week', f.primer::timestamp)::date, count(*)::bigint
      from f
     where f.primer between p_desde and p_hasta
     group by f.property_id, f.g, date_trunc('week', f.primer::timestamp)
     order by f.g, f.property_id, 2;
end;
$$;
revoke all on function restaurantes.cfo_clientes_altas(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_clientes_altas(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) cfo_clientes_segmento_hora
-- ---------------------------------------------------------------------------
-- El segmento es del CLIENTE en el conjunto de sucursales consultadas, al cierre del rango: frecuente (>= p_frecuente_n pedidos en los ultimos
-- p_frecuente_dias) > nuevo (sin pedido antes del rango) > recurrente. Cada pedido del rango cae en el segmento de su cliente; pedidos y venta neta
-- son aditivos por sucursal; clientes (distintos en la celda) NO lo es. Los pedidos sin cliente identificado no entran.
create or replace function restaurantes.cfo_clientes_segmento_hora(
  p_org uuid,
  p_props uuid[],
  p_desde date,
  p_hasta date,
  p_frecuente_n integer default 3,
  p_frecuente_dias integer default 90
) returns table (
  property_id uuid,
  segmento text,
  dow_negocio integer,
  hora_local integer,
  pedidos bigint,
  neta_centavos bigint,
  clientes bigint,
  pedidos_por_cliente numeric
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
set work_mem = '48MB'
as $$
#variable_conflict use_column
declare
  v_props uuid[];
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  if p_frecuente_n is null or p_frecuente_n < 1 or p_frecuente_n > 100 or p_frecuente_dias is null or p_frecuente_dias < 1 or p_frecuente_dias > 365 then
    raise exception 'cfo_clientes_segmento_hora: umbrales invalidos' using errcode = '22023';
  end if;
  return query
    with bc as materialized (
      select l.property_id, l.customer_id, l.dia_negocio as dia, l.hora_local, l.dow_negocio, l.neta_centavos
        from restaurantes.cfo_venta_lean(p_org, v_props, p_desde - 365, p_hasta) l
       where l.customer_id is not null
    ),
    cs as (
      select bc.customer_id,
             count(*) filter (where bc.dia > p_hasta - p_frecuente_dias) as n_frec,
             bool_or(bc.dia < p_desde) as previo
        from bc
       group by bc.customer_id
    ),
    seg as (
      select bc.property_id, bc.customer_id, bc.dow_negocio, bc.hora_local, bc.neta_centavos,
             case when cs.n_frec >= p_frecuente_n then 'frecuente' when not cs.previo then 'nuevo' else 'recurrente' end as segmento
        from bc join cs on cs.customer_id = bc.customer_id
       where bc.dia >= p_desde
    )
    select s.property_id, s.segmento, s.dow_negocio, s.hora_local,
           count(*)::bigint, coalesce(sum(s.neta_centavos), 0)::bigint, count(distinct s.customer_id)::bigint,
           round(count(*)::numeric / count(distinct s.customer_id), 2)
      from seg s
     group by s.property_id, s.segmento, s.dow_negocio, s.hora_local
     order by s.property_id, s.segmento, s.dow_negocio, s.hora_local;
end;
$$;
revoke all on function restaurantes.cfo_clientes_segmento_hora(uuid, uuid[], date, date, integer, integer) from public, anon;
grant execute on function restaurantes.cfo_clientes_segmento_hora(uuid, uuid[], date, date, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) cfo_agente_diario
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_agente_diario(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  dia_negocio date,
  wa_conversaciones_nuevas bigint,
  wa_con_pedido bigint,
  wa_con_handoff bigint,
  wa_handoffs bigint,
  voz_llamadas bigint,
  voz_pedido_creado bigint,
  voz_escalado bigint,
  voz_abandonado bigint,
  costo_voz_micro_usd bigint,
  costo_telefonia_micro_usd bigint,
  costo_meta_micro_usd bigint,
  costo_llm_micro_usd bigint,
  costo_voz_centavos bigint,
  costo_telefonia_centavos bigint,
  costo_meta_centavos bigint,
  costo_llm_centavos bigint,
  meta_eventos bigint,
  mxn_por_usd numeric
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_na boolean;
  v_demo boolean;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  -- «No asignado»: alcance de organizacion completa Y la consulta cubre todas las sucursales de la organizacion.
  v_na := restaurantes.cfo_alcance_org_completo(p_org)
          and not exists (select 1 from restaurantes.branch_detail bd where bd.organization_id = p_org and bd.property_id <> all (v_props));
  select exists (select 1 from restaurantes.demo_organization d where d.organization_id = p_org) into v_demo;
  return query
    with par as materialized (
      select z.property_id, z.tz, z.corte from restaurantes.cfo_zonas(v_props) z
    ),
    wa as (
      select par.property_id, ((c.created_at at time zone par.tz) - par.corte)::date as dia,
             count(*) as conv,
             count(*) filter (where o.id is not null) as con_pedido,
             count(*) filter (where exists (
               select 1 from restaurantes.conversation_handoff h
                where h.canal = 'whatsapp' and h.conversation_id = c.id and h.organization_id = p_org and h.property_id = c.property_id
             )) as con_handoff
        from restaurantes.whatsapp_conversations c
        join par on par.property_id = c.property_id
        left join restaurantes.orders o
          on o.id = c.order_id and o.organization_id = p_org and o.property_id = c.property_id and o.source = 'whatsapp' and o.status <> 'cancelado'
       where c.organization_id = p_org
         and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
         and c.created_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and c.created_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
       group by 1, 2
    ),
    hof as (
      select par.property_id, ((h.solicitada_at at time zone par.tz) - par.corte)::date as dia, count(*) as handoffs
        from restaurantes.conversation_handoff h
        join par on par.property_id = h.property_id
        join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = p_org
       where h.organization_id = p_org and h.canal = 'whatsapp'
         and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
         and h.solicitada_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and h.solicitada_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
       group by 1, 2
    ),
    voz as (
      select par.property_id, ((v.started_at at time zone par.tz) - par.corte)::date as dia,
             count(*) as llamadas,
             count(*) filter (where v.resultado = 'pedido_creado') as pedido,
             count(*) filter (where v.resultado = 'escalado') as escalado,
             count(*) filter (where v.resultado = 'abandonado') as abandonado,
             coalesce(sum(v.costo_estimado_micro_usd), 0)::bigint as costo
        from restaurantes.voice_conversation v
        join par on par.property_id = v.property_id
       where v.organization_id = p_org and v.canal = 'llamada'
         and v.started_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and v.started_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
       group by 1, 2
    ),
    ce as (
      select par.property_id, ((u.occurred_at at time zone par.tz) - par.corte)::date as dia,
             (sum(u.costo_micro_usd) filter (where u.categoria = 'telefonia'))::bigint as tel,
             (sum(u.costo_micro_usd) filter (where u.categoria = 'whatsapp'))::bigint as meta,
             count(*) filter (where u.categoria = 'whatsapp') as meta_ev
        from core.usage_cost_event u
        join par on par.property_id = u.property_id
       where u.organization_id = p_org and u.vertical = 'restaurantes' and u.categoria in ('telefonia', 'whatsapp')
         and u.occurred_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and u.occurred_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
       group by 1, 2
    ),
    claves as (
      select property_id, dia from wa union select property_id, dia from hof union select property_id, dia from voz union select property_id, dia from ce
    ),
    suc as (
      select k.property_id, k.dia,
             coalesce(wa.conv, 0) as wa_conv, coalesce(wa.con_pedido, 0) as wa_ped, coalesce(wa.con_handoff, 0) as wa_conh, coalesce(hof.handoffs, 0) as wa_hof,
             coalesce(voz.llamadas, 0) as v_ll, coalesce(voz.pedido, 0) as v_ped, coalesce(voz.escalado, 0) as v_esc, coalesce(voz.abandonado, 0) as v_aba,
             coalesce(voz.costo, 0) as c_voz, coalesce(ce.tel, 0) as c_tel, ce.meta as c_meta, coalesce(ce.meta_ev, 0) as meta_ev, 0::bigint as c_llm
        from claves k
        left join wa on wa.property_id = k.property_id and wa.dia = k.dia
        left join hof on hof.property_id = k.property_id and hof.dia = k.dia
        left join voz on voz.property_id = k.property_id and voz.dia = k.dia
        left join ce on ce.property_id = k.property_id and ce.dia = k.dia
       where k.dia between p_desde and p_hasta
    ),
    na_llm as (
      select l.usage_date as dia, sum(l.cost_micro_usd)::bigint as costo
        from core.llm_usage_daily l
       where v_na and not v_demo and l.organization_id = p_org and l.vertical = 'restaurantes'
         and l.role in ('restaurantes:whatsapp_agent', 'restaurantes:whatsapp_agent_escalated')
         and l.usage_date between p_desde and p_hasta
       group by 1
    ),
    na_ev as (
      select (u.occurred_at at time zone 'America/Mexico_City')::date as dia,
             sum(u.costo_micro_usd) filter (where u.categoria = 'telefonia') as tel,
             sum(u.costo_micro_usd) filter (where u.categoria = 'whatsapp') as meta,
             count(*) filter (where u.categoria = 'whatsapp') as meta_ev
        from core.usage_cost_event u
       where v_na and u.organization_id = p_org and u.property_id is null and u.vertical = 'restaurantes' and u.categoria in ('telefonia', 'whatsapp')
         and u.occurred_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and u.occurred_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
       group by 1
    ),
    na as (
      select d.dia, 0::bigint as wa_conv, 0::bigint as wa_ped, 0::bigint as wa_conh, 0::bigint as wa_hof, 0::bigint as v_ll, 0::bigint as v_ped, 0::bigint as v_esc, 0::bigint as v_aba,
             0::bigint as c_voz, coalesce(e.tel, 0)::bigint as c_tel, e.meta::bigint as c_meta, coalesce(e.meta_ev, 0)::bigint as meta_ev,
             case when v_demo then null else coalesce(l.costo, 0) end::bigint as c_llm
        from (select na_llm.dia from na_llm union select na_ev.dia from na_ev) d
        left join na_ev e on e.dia = d.dia
        left join na_llm l on l.dia = d.dia
       where d.dia between p_desde and p_hasta
    ),
    todo as (
      select s.property_id, s.dia, s.wa_conv, s.wa_ped, s.wa_conh, s.wa_hof, s.v_ll, s.v_ped, s.v_esc, s.v_aba, s.c_voz, s.c_tel, s.c_meta, s.meta_ev, s.c_llm from suc s
      union all
      select null::uuid, n.dia, n.wa_conv, n.wa_ped, n.wa_conh, n.wa_hof, n.v_ll, n.v_ped, n.v_esc, n.v_aba, n.c_voz, n.c_tel, n.c_meta, n.meta_ev, n.c_llm from na n
    )
    select t.property_id, t.dia, t.wa_conv, t.wa_ped, t.wa_conh, t.wa_hof, t.v_ll, t.v_ped, t.v_esc, t.v_aba,
           t.c_voz, t.c_tel, t.c_meta, t.c_llm,
           case when fx.mxn is null then null else round(t.c_voz::numeric * fx.mxn / 10000)::bigint end,
           case when fx.mxn is null then null else round(t.c_tel::numeric * fx.mxn / 10000)::bigint end,
           case when fx.mxn is null or t.c_meta is null then null else round(t.c_meta::numeric * fx.mxn / 10000)::bigint end,
           case when fx.mxn is null or t.c_llm is null then null else round(t.c_llm::numeric * fx.mxn / 10000)::bigint end,
           t.meta_ev,
           fx.mxn
      from todo t
      left join lateral (select f.mxn_por_usd as mxn from core.fx_rate f where f.fecha <= t.dia order by f.fecha desc limit 1) fx on true
     order by t.property_id nulls last, t.dia;
end;
$$;
revoke all on function restaurantes.cfo_agente_diario(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_agente_diario(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) cfo_escalaciones_hora
-- ---------------------------------------------------------------------------
-- conversaciones = conversaciones nuevas de WhatsApp (su primer contacto) + llamadas de voz; handoffs = solicitudes de humano de WhatsApp + llamadas
-- de voz con resultado 'escalado'. Hora local del reloj de la sucursal y dia de la semana del DIA DE NEGOCIO (como la 081).
create or replace function restaurantes.cfo_escalaciones_hora(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  dow_negocio integer,
  hora_local integer,
  conversaciones bigint,
  handoffs bigint
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
    with par as materialized (
      select z.property_id, z.tz, z.corte from restaurantes.cfo_zonas(v_props) z
    ),
    ev as (
      select par.property_id, c.created_at as ts, par.tz, par.corte, 1 as conv, 0 as hof
        from restaurantes.whatsapp_conversations c
        join par on par.property_id = c.property_id
       where c.organization_id = p_org
         and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
         and c.created_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and c.created_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
      union all
      select par.property_id, h.solicitada_at, par.tz, par.corte, 0, 1
        from restaurantes.conversation_handoff h
        join par on par.property_id = h.property_id
        join restaurantes.whatsapp_conversations c on c.id = h.conversation_id and c.organization_id = p_org
       where h.organization_id = p_org and h.canal = 'whatsapp'
         and right(regexp_replace(c.phone, '\D', '', 'g'), 10) not like '0009%'
         and h.solicitada_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and h.solicitada_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
      union all
      select par.property_id, v.started_at, par.tz, par.corte, 1, case when v.resultado = 'escalado' then 1 else 0 end
        from restaurantes.voice_conversation v
        join par on par.property_id = v.property_id
       where v.organization_id = p_org and v.canal = 'llamada'
         and v.started_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and v.started_at < ((p_hasta + 4)::timestamp at time zone 'UTC')
    ),
    dn as (
      select e.property_id, e.conv, e.hof, ((e.ts at time zone e.tz) - e.corte)::date as dia, extract(hour from (e.ts at time zone e.tz))::integer as hora
        from ev e
    )
    select d.property_id, extract(isodow from d.dia)::integer, d.hora, sum(d.conv)::bigint, sum(d.hof)::bigint
      from dn d
     where d.dia between p_desde and p_hasta
     group by d.property_id, extract(isodow from d.dia), d.hora
     order by d.property_id, 2, d.hora;
end;
$$;
revoke all on function restaurantes.cfo_escalaciones_hora(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_escalaciones_hora(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) cfo_entregas y cfo_entregas_percentiles
-- ---------------------------------------------------------------------------
-- Entrega = venta con status 'entregado' o 'completado' (desde 077 el autopiloto pasa los entregados a completado a las 6 h) y delivered_at >= inicio.
-- Minutos con 2 decimales por pedido (suma exacta y aditiva). tarde = mas minutos que p_promesa_min.
create or replace function restaurantes.cfo_entregas(p_org uuid, p_props uuid[], p_desde date, p_hasta date, p_promesa_min integer default 50)
returns table (
  property_id uuid,
  hora_local integer,
  dow_negocio integer,
  entregados bigint,
  min_suma numeric,
  tarde bigint
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
  if p_promesa_min is null or p_promesa_min < 1 or p_promesa_min > 1440 then
    raise exception 'cfo_entregas: promesa invalida' using errcode = '22023';
  end if;
  return query
    select l.property_id, l.hora_local, l.dow_negocio, count(*)::bigint, coalesce(sum(l.entregado_min), 0)::numeric,
           (count(*) filter (where l.entregado_min > p_promesa_min))::bigint
      from restaurantes.cfo_venta_lean(p_org, v_props, p_desde, p_hasta) l
     where l.entregado_min is not null
     group by l.property_id, l.hora_local, l.dow_negocio
     order by l.property_id, l.dow_negocio, l.hora_local;
end;
$$;
revoke all on function restaurantes.cfo_entregas(uuid, uuid[], date, date, integer) from public, anon;
grant execute on function restaurantes.cfo_entregas(uuid, uuid[], date, date, integer) to authenticated;

-- Percentiles NO aditivos: uno por sucursal y uno del conjunto (property_id nulo, calculado sobre todas las entregas, nunca desde los de cada sucursal).
-- Nearest-rank (percentile_disc), el mismo que usa el dominio.
create or replace function restaurantes.cfo_entregas_percentiles(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  alcance text,
  entregados bigint,
  p50_min numeric,
  p90_min numeric
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
    with e as materialized (
      select l.property_id, l.entregado_min
        from restaurantes.cfo_venta_lean(p_org, v_props, p_desde, p_hasta) l
       where l.entregado_min is not null
    ),
    s as (
      select e.property_id, grouping(e.property_id) as g, count(*) as n,
             percentile_disc(0.5) within group (order by e.entregado_min) as p50,
             percentile_disc(0.9) within group (order by e.entregado_min) as p90
        from e
       group by grouping sets ((e.property_id), ())
    ),
    ren as (
      select u.pid as property_id, 0 as g from unnest(v_props) as u(pid)
      union all
      select null::uuid, 1
    )
    select r.property_id, case when r.g = 0 then 'sucursal' else 'conjunto' end, coalesce(s.n, 0)::bigint, s.p50, s.p90
      from ren r
      left join s on s.g = r.g and s.property_id is not distinct from r.property_id
     order by r.g, r.property_id;
end;
$$;
revoke all on function restaurantes.cfo_entregas_percentiles(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_entregas_percentiles(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 9) cfo_repartidores
-- ---------------------------------------------------------------------------
-- Solo pedidos con repartidor asignado. nombre = core.staff_user.full_name (nunca telefono ni correo) y solo si el repartidor es miembro de la
-- organizacion; si no, '(sin nombre)'. incidencias = pedidos con incident_note (solo la cuenta, nunca el texto).
create or replace function restaurantes.cfo_repartidores(p_org uuid, p_props uuid[], p_desde date, p_hasta date, p_promesa_min integer default 50)
returns table (
  property_id uuid,
  repartidor_id uuid,
  nombre text,
  entregas bigint,
  min_suma numeric,
  tarde bigint,
  incidencias bigint
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
  if p_promesa_min is null or p_promesa_min < 1 or p_promesa_min > 1440 then
    raise exception 'cfo_repartidores: promesa invalida' using errcode = '22023';
  end if;
  return query
    select l.property_id, l.repartidor_id,
           coalesce((select su.full_name from core.membership m join core.staff_user su on su.id = m.user_id
                      where m.organization_id = p_org and m.user_id = l.repartidor_id), '(sin nombre)'),
           (count(*) filter (where l.entregado_min is not null))::bigint,
           coalesce(sum(l.entregado_min), 0)::numeric,
           (count(*) filter (where l.entregado_min > p_promesa_min))::bigint,
           (count(*) filter (where l.con_incidencia))::bigint
      from restaurantes.cfo_venta_lean(p_org, v_props, p_desde, p_hasta) l
     where l.repartidor_id is not null
     group by l.property_id, l.repartidor_id
     order by l.property_id, 4 desc, l.repartidor_id;
end;
$$;
revoke all on function restaurantes.cfo_repartidores(uuid, uuid[], date, date, integer) from public, anon;
grant execute on function restaurantes.cfo_repartidores(uuid, uuid[], date, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 10) cfo_colonias
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_colonias(p_org uuid, p_props uuid[], p_desde date, p_hasta date, p_k integer default 5)
returns table (
  property_id uuid,
  colonia text,
  pedidos bigint,
  neta_centavos bigint,
  entregados bigint,
  min_suma numeric,
  clientes bigint,
  sucursal_cercana_id uuid,
  distancia_km numeric
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
  -- k-anonimato (diseno §3.7): nunca menos de 5 pedidos por colonia visible.
  if p_k is null or p_k < 5 or p_k > 1000 then
    raise exception 'cfo_colonias: k invalido (minimo 5)' using errcode = '22023';
  end if;
  return query
    with dom as materialized (
      select l.order_id, l.property_id, l.customer_id, l.neta_centavos, l.entregado_min,
             lower(regexp_replace(btrim(o.customer_address), '\s+', ' ', 'g')) as dir
        from restaurantes.cfo_venta_lean(p_org, v_props, p_desde, p_hasta) l
        join restaurantes.orders o on o.id = l.order_id and o.organization_id = p_org
       where l.canal_efectivo = 'domicilio'
    ),
    ca as (
      select a.customer_id, lower(regexp_replace(btrim(a.address), '\s+', ' ', 'g')) as dir, min(nullif(btrim(a.colonia), '')) as colonia
        from restaurantes.customer_addresses a
       where a.customer_id in (select d.customer_id from dom d where d.customer_id is not null)
       group by 1, 2
    ),
    pc as (
      select d.property_id, coalesce(ca.colonia, '(sin colonia)') as colonia, d.customer_id, d.neta_centavos, d.entregado_min
        from dom d
        left join ca on ca.customer_id = d.customer_id and ca.dir = d.dir
    ),
    g as (
      select p.property_id, p.colonia, count(*) as pedidos, sum(p.neta_centavos) as neta, count(*) filter (where p.entregado_min is not null) as ent,
             coalesce(sum(p.entregado_min), 0) as mins, count(distinct p.customer_id) as clientes
        from pc p
       group by p.property_id, p.colonia
    ),
    k as (
      select g.property_id,
             case when g.colonia <> '(sin colonia)' and g.pedidos < p_k then '(otras)' else g.colonia end as colonia,
             g.pedidos, g.neta, g.ent, g.mins, g.colonia as colonia_origen
        from g
    ),
    -- clientes distintos del grupo ya agrupado (un cliente en dos colonias de '(otras)' cuenta una vez).
    k2 as (
      select kk.property_id, kk.colonia, sum(kk.pedidos) as pedidos, sum(kk.neta) as neta, sum(kk.ent) as ent, sum(kk.mins) as mins
        from k kk
       group by kk.property_id, kk.colonia
    ),
    k3 as (
      select p.property_id,
             case when p.colonia <> '(sin colonia)' and gg.pedidos < p_k then '(otras)' else p.colonia end as colonia,
             count(distinct p.customer_id) as clientes
        from pc p join g gg on gg.property_id = p.property_id and gg.colonia = p.colonia
       group by 1, 2
    ),
    cer as (
      select c.colonia, h.sucursal_id, h.distancia_km
        from (select distinct k2.colonia from k2 where k2.colonia not in ('(otras)', '(sin colonia)')) c
        cross join lateral restaurantes.cfo_colonia_cercana(p_org, c.colonia) h
       where h.sucursal_id = any (v_props)
    )
    select k2.property_id, k2.colonia, k2.pedidos::bigint, k2.neta::bigint, k2.ent::bigint, k2.mins::numeric, k3.clientes::bigint, cer.sucursal_id, cer.distancia_km
      from k2
      join k3 on k3.property_id = k2.property_id and k3.colonia = k2.colonia
      left join cer on cer.colonia = k2.colonia
     order by k2.property_id, k2.pedidos desc, k2.colonia;
end;
$$;
revoke all on function restaurantes.cfo_colonias(uuid, uuid[], date, date, integer) from public, anon;
grant execute on function restaurantes.cfo_colonias(uuid, uuid[], date, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 11) cfo_comandas_pos
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_comandas_pos(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  dia_negocio date,
  modo text,
  encoladas bigint,
  confirmadas bigint,
  capturadas_manual bigint,
  captura_manual_pendientes bigint,
  fallidas bigint,
  pendientes_enviadas bigint,
  min_a_captura_suma numeric,
  capturadas_con_tiempo bigint,
  vencidas_umbral bigint,
  con_folio_pos bigint,
  con_folio_declarado bigint
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_modo text;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  select coalesce((select c.modo from restaurantes.softrestaurant_config c where c.organization_id = p_org), 'apagado') into v_modo;
  return query
    with par as materialized (
      select z.property_id, z.tz, z.corte,
             coalesce((select a.captura_manual_min from restaurantes.pos_comanda_alerta_config a where a.property_id = z.property_id), 5) as umbral
        from restaurantes.cfo_zonas(v_props) z
    ),
    x as (
      select par.property_id, ((o.creado_en at time zone par.tz) - par.corte)::date as dia, o.estado,
             case when o.estado = 'capturada_manual' and o.capturado_en is not null
                       then greatest(round(extract(epoch from (o.capturado_en - o.creado_en))::numeric / 60.0, 2), 0)
                  when o.estado = 'confirmada' then greatest(round(extract(epoch from (o.actualizado_en - o.creado_en))::numeric / 60.0, 2), 0) end as min_cap,
             par.umbral,
             case when o.estado = 'captura_manual' then greatest(extract(epoch from (now() - o.actualizado_en)) / 60.0, 0) end as espera_min,
             o.folio, o.nota_captura
        from restaurantes.pos_comanda_outbox o
        join par on par.property_id = o.property_id
       where o.organization_id = p_org
         and o.creado_en >= ((p_desde - 3)::timestamp at time zone 'UTC') and o.creado_en < ((p_hasta + 4)::timestamp at time zone 'UTC')
    ),
    g as (
      select x.property_id, x.dia,
             count(*)::bigint as enc,
             (count(*) filter (where x.estado = 'confirmada'))::bigint as conf,
             (count(*) filter (where x.estado = 'capturada_manual'))::bigint as capm,
             (count(*) filter (where x.estado = 'captura_manual'))::bigint as pend,
             (count(*) filter (where x.estado = 'fallida'))::bigint as fall,
             (count(*) filter (where x.estado in ('pendiente', 'enviada')))::bigint as penv,
             coalesce(sum(x.min_cap), 0)::numeric as mins,
             (count(*) filter (where x.min_cap is not null))::bigint as con_t,
             (count(*) filter (where (x.estado = 'capturada_manual' and x.min_cap > x.umbral) or (x.estado = 'captura_manual' and x.espera_min >= x.umbral)))::bigint as venc,
             (count(*) filter (where x.estado = 'confirmada' and x.folio is not null))::bigint as fpos,
             (count(*) filter (where x.nota_captura ~ '^[A-Za-z0-9-]{3,30}$'))::bigint as fdec
        from x
       where x.dia between p_desde and p_hasta
       group by x.property_id, x.dia
    )
    select g.property_id, g.dia, v_modo, g.enc, g.conf, g.capm, g.pend, g.fall, g.penv, g.mins, g.con_t, g.venc, g.fpos, g.fdec from g
    union all
    -- Sucursal sin comandas en el rango: un renglon en cero con el modo vigente (el modo apagado se rotula asi, no como «sin datos»).
    select u.pid, p_desde, v_modo, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::bigint, 0::numeric, 0::bigint, 0::bigint, 0::bigint, 0::bigint
      from unnest(v_props) as u(pid)
     where not exists (select 1 from g where g.property_id = u.pid)
    order by 1, 2;
end;
$$;
revoke all on function restaurantes.cfo_comandas_pos(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_comandas_pos(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 12) cfo_agotados
-- ---------------------------------------------------------------------------
-- Productos agotados hoy (branch_products.is_available = false, o con agotado_hasta) con sus unidades vendidas y dias con venta en los 28 dias de
-- negocio ANTERIORES al dia de negocio vigente de su sucursal. precio_centavos = precio de lista vigente de la sucursal.
create or replace function restaurantes.cfo_agotados(p_org uuid, p_props uuid[])
returns table (
  property_id uuid,
  product_id uuid,
  nombre text,
  agotado_hasta date,
  disponible boolean,
  precio_centavos bigint,
  unidades_28d bigint,
  dias_con_venta_28d bigint
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_hoy_min date;
  v_hoy_max date;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  select min(((now() at time zone z.tz) - z.corte)::date), max(((now() at time zone z.tz) - z.corte)::date)
    into v_hoy_min, v_hoy_max from restaurantes.cfo_zonas(v_props) z;
  return query
    with par as materialized (
      select z.property_id, ((now() at time zone z.tz) - z.corte)::date as hoy from restaurantes.cfo_zonas(v_props) z
    ),
    ag as (
      select bp.property_id, bp.product_id, pr.name, bp.agotado_hasta, bp.is_available, round(bp.price * 100)::bigint as precio, par.hoy
        from restaurantes.branch_products bp
        join par on par.property_id = bp.property_id
        join restaurantes.products pr on pr.id = bp.product_id and pr.organization_id = p_org
       where bp.is_available = false or bp.agotado_hasta is not null
    ),
    vta as (
      select b.property_id, lower(x.producto_ref) as ref, b.dia_negocio as dia, sum(x.cantidad) as unidades
        from restaurantes.cfo_pedidos_base(p_org, v_props, v_hoy_min - 28, v_hoy_max) b
        cross join lateral restaurantes.cfo_renglones(b.items) x
       where b.es_venta and x.producto_ref is not null
       group by 1, 2, 3
    )
    select a.property_id, a.product_id, a.name, a.agotado_hasta, a.is_available, a.precio,
           coalesce(sum(v.unidades) filter (where v.dia between a.hoy - 28 and a.hoy - 1), 0)::bigint,
           (count(distinct v.dia) filter (where v.dia between a.hoy - 28 and a.hoy - 1))::bigint
      from ag a
      left join vta v on v.property_id = a.property_id and v.ref = lower(a.product_id::text)
     group by a.property_id, a.product_id, a.name, a.agotado_hasta, a.is_available, a.precio
     order by a.property_id, a.name, a.product_id;
end;
$$;
revoke all on function restaurantes.cfo_agotados(uuid, uuid[]) from public, anon;
grant execute on function restaurantes.cfo_agotados(uuid, uuid[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Comentarios de las funciones publicas
-- ---------------------------------------------------------------------------
comment on function restaurantes.cfo_clientes_resumen(uuid, uuid[], date, date, integer, integer, integer, integer) is 'CFO: clientes por sucursal y renglon del conjunto (NO aditivo): nuevos, recurrentes, activos, dormidos, perdidos, frecuentes, recuperados, concentracion. Sin PII.';
comment on function restaurantes.cfo_clientes_cohortes(uuid, uuid[], integer) is 'CFO: cohortes por mes del primer pedido con recompra a 30/60/90 dias, por sucursal y conjunto (property_id nulo).';
comment on function restaurantes.cfo_clientes_altas(uuid, uuid[], date, date) is 'CFO: altas (primer pedido) por semana ISO, por sucursal y conjunto (property_id nulo).';
comment on function restaurantes.cfo_clientes_segmento_hora(uuid, uuid[], date, date, integer, integer) is 'CFO: pedidos y venta neta por segmento de cliente (nuevo/recurrente/frecuente), dia de la semana y hora local.';
comment on function restaurantes.cfo_agente_diario(uuid, uuid[], date, date) is 'CFO: embudo de WhatsApp y voz y costos del agente por sucursal y dia de negocio; property_id nulo = no asignado (solo organizacion completa o sistema).';
comment on function restaurantes.cfo_escalaciones_hora(uuid, uuid[], date, date) is 'CFO: conversaciones y handoffs (WhatsApp y voz escalado) por dia de la semana y hora local.';
comment on function restaurantes.cfo_entregas(uuid, uuid[], date, date, integer) is 'CFO: entregas, minutos y entregas tarde por sucursal, hora local y dia de la semana (aditivo).';
comment on function restaurantes.cfo_entregas_percentiles(uuid, uuid[], date, date) is 'CFO: p50 y p90 de entrega por sucursal y del conjunto (NO aditivos).';
comment on function restaurantes.cfo_repartidores(uuid, uuid[], date, date, integer) is 'CFO: entregas, minutos, tardes e incidencias (solo conteo) por repartidor; solo nombre de staff, nunca telefono.';
comment on function restaurantes.cfo_colonias(uuid, uuid[], date, date, integer) is 'CFO: pedidos por colonia con k-anonimato (k minimo 5, el resto en (otras)) y sucursal de despacho mas cercana.';
comment on function restaurantes.cfo_comandas_pos(uuid, uuid[], date, date) is 'CFO: comandas de SoftRestaurant por estado y dia de negocio, tiempo a captura y modo vigente.';
comment on function restaurantes.cfo_agotados(uuid, uuid[]) is 'CFO: productos agotados y sus unidades y dias con venta en los 28 dias de negocio previos.';
