-- Analitica del dueno (F7): PANEL DE DEMANDA y ZONAS. Solo lectura, sin tablas ni DML.
-- Prefijo de supabase/migrations: 20240101000460 (interno restaurantes 160; el rango 160-169 es de la analitica del dueno).
-- Requiere: 081 (cfo_resolver_sucursales, cfo_validar_rango, cfo_pedidos_base), 082 (cfo_zonas, customer_addresses.colonia por la 049) y 090 (orders.salio_at; no se usa aqui).
--
-- Que agrega (todo NUEVO; ninguna tabla, funcion, policy ni GRANT existente se modifica):
--   1. restaurantes.analitica_base(...)     -- INTERNA (revoke total). cfo_pedidos_base + la hora PROMETIDA de entrega (orders.estimated_delivery_at) y la direccion.
--   2. restaurantes.analitica_demanda(...)  -- PUBLICA. jsonb: matriz dia de la semana x hora x canal x origen, tendencia semanal, ticket, mezcla de pago,
--                                              tiempo real de entrega contra el prometido y totales (para cuadrar contra cfo_ventas_diarias).
--   3. restaurantes.analitica_zonas(...)    -- PUBLICA. Una fila por colonia (k-anonimato >= 5 pedidos Y >= 5 clientes, lo demas es «(otras)»; sin colonia o
--                                              para recoger = «sin colonia / recoge»): pedidos, venta, clientes y tiempo de entrega real (mediana, p90, > 60 min).
--
-- SEGURIDAD (misma doble puerta que el CFO; nada de esto escribe):
--   * analitica_demanda / analitica_zonas: SECURITY DEFINER, search_path fijo, revoke de public y anon, grant a authenticated. La puerta es
--     cfo_resolver_sucursales: sesion de sistema (auth.uid() nulo, la sucursal debe ser de la organizacion declarada) o owner/admin con alcance sobre CADA
--     sucursal pedida (42501 si no). Un admin acotado solo ve sus sucursales; staff y repartidor no pasan (la ruta ademas exige la accion `cfo.ver`).
--     Cross-tenant: el filtro `organization_id = p_org` va en cada lectura de orders / customer_addresses y la sucursal se valida contra la organizacion.
--   * analitica_base: sin GRANT a ningun rol (solo la llaman las funciones de arriba, que ya validaron el alcance).
--   * Sin PII: ni nombres, ni telefonos, ni direcciones, ni ids de cliente; solo agregados. La colonia es un dato de zona (no una direccion) y se agrupa con k = 5.
--
-- DEFINICIONES (el rango consultado es [p_desde, p_hasta], de a lo mas 400 dias):
--   * Venta = la regla de cfo_pedidos_base (es_venta): no cancelado/no_recogido/por_aprobar/programado sin promover, sin pedido falso, sin trafico demo (0009...)
--     y sin reposiciones. Dia de negocio y hora local = los de la 076/077 (zona horaria y corte de cada sucursal). dow_negocio es ISO: 1 = lunes ... 7 = domingo.
--   * Tiempo real de entrega = entregado_min de la 081: de coalesce(promovido_at, created_at) a delivered_at, solo pedidos entregado/completado con delivered_at.
--   * Tiempo PROMETIDO = estimated_delivery_at - coalesce(promovido_at, created_at), en minutos; solo si la promesa es posterior al inicio. Sin promesa no se inventa.
--   * «A tiempo» = tiempo real <= tiempo prometido del MISMO pedido. Solo domicilios (los pedidos para recoger no llevan promesa de reparto).
--   * Percentiles = nearest-rank (percentile_disc), el mismo del CFO. No son aditivos entre sucursales: el conjunto se recalcula en TypeScript solo cuando
--     la consulta es de una sucursal; con varias, la API muestra el de cada una.
--
-- Compatibilidad con la base SIN migrar: todo es nuevo; llamarlas antes de aplicar la migracion da 42883 y el TypeScript lo degrada con SAVEPOINT.
-- Idempotente (create or replace / revoke + grant): aplicarla dos veces no cambia nada.
-- REVERSA: drop function if exists restaurantes.analitica_zonas(uuid, uuid[], date, date, integer);
--          drop function if exists restaurantes.analitica_demanda(uuid, uuid[], date, date);
--          drop function if exists restaurantes.analitica_base(uuid, uuid[], date, date);

-- ---------------------------------------------------------------------------
-- 1) analitica_base (interna)
-- ---------------------------------------------------------------------------
create or replace function restaurantes.analitica_base(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  order_id uuid,
  property_id uuid,
  customer_id uuid,
  dia_negocio date,
  hora_local integer,
  dow_negocio integer,
  source text,
  canal_efectivo text,
  status text,
  payment_method text,
  es_venta boolean,
  es_falso boolean,
  es_reposicion boolean,
  neta_centavos bigint,
  entregado_min numeric,
  prometido_min numeric,
  customer_address text
)
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  select b.order_id, b.property_id, b.customer_id, b.dia_negocio, b.hora_local, b.dow_negocio, b.source, b.canal_efectivo, b.status, b.payment_method,
         b.es_venta, b.es_falso, b.es_reposicion, b.neta_centavos, b.entregado_min,
         case when o.estimated_delivery_at is not null and o.estimated_delivery_at > coalesce(o.promovido_at, o.created_at)
              then round(extract(epoch from (o.estimated_delivery_at - coalesce(o.promovido_at, o.created_at)))::numeric / 60.0, 2) end,
         o.customer_address
    from restaurantes.cfo_pedidos_base(p_org, p_props, p_desde, p_hasta) b
    join restaurantes.orders o on o.id = b.order_id and o.organization_id = p_org;
$$;
revoke all on function restaurantes.analitica_base(uuid, uuid[], date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) analitica_demanda
-- ---------------------------------------------------------------------------
-- jsonb:
--   { "matriz":   [ {property_id, dow, hora, canal, source, pedidos, neta_centavos} ],
--     "semanas":  [ {property_id, semana (lunes, YYYY-MM-DD), dias, pedidos, neta_centavos} ],
--     "ticket":   [ {property_id, canal, pedidos, neta_centavos, mediana_centavos, p90_centavos} ],
--     "pago":     [ {property_id, forma_pago ('efectivo'|'tarjeta'|'sin_dato'), pedidos, neta_centavos} ],
--     "promesa":  [ {property_id, domicilios, entregados, con_promesa, a_tiempo, sin_promesa, sin_cierre, real_mediana_min, prometido_mediana_min, desvio_mediana_min} ],
--     "totales":  [ {property_id, pedidos, neta_centavos} ],
--     "dias_con_venta": n }
create or replace function restaurantes.analitica_demanda(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
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
    select x.* from restaurantes.analitica_base(p_org, v_props, p_desde, p_hasta) x where x.es_venta
  ),
  matriz as (
    select b.property_id, b.dow_negocio, b.hora_local, b.canal_efectivo, b.source, count(*) as pedidos, sum(b.neta_centavos)::bigint as neta
      from b group by 1, 2, 3, 4, 5
  ),
  semanas as (
    select b.property_id, date_trunc('week', b.dia_negocio::timestamp)::date as semana, count(distinct b.dia_negocio) as dias, count(*) as pedidos, sum(b.neta_centavos)::bigint as neta
      from b group by 1, 2
  ),
  ticket as (
    select b.property_id, b.canal_efectivo as canal, count(*) as pedidos, sum(b.neta_centavos)::bigint as neta,
           percentile_disc(0.5) within group (order by b.neta_centavos) as mediana,
           percentile_disc(0.9) within group (order by b.neta_centavos) as p90
      from b group by 1, 2
  ),
  pago as (
    select b.property_id, coalesce(b.payment_method, 'sin_dato') as forma_pago, count(*) as pedidos, sum(b.neta_centavos)::bigint as neta
      from b group by 1, 2
  ),
  promesa as (
    select b.property_id,
           count(*) as domicilios,
           count(*) filter (where b.entregado_min is not null) as entregados,
           count(*) filter (where b.entregado_min is not null and b.prometido_min is not null) as con_promesa,
           count(*) filter (where b.entregado_min is not null and b.prometido_min is not null and b.entregado_min <= b.prometido_min) as a_tiempo,
           count(*) filter (where b.entregado_min is not null and b.prometido_min is null) as sin_promesa,
           count(*) filter (where b.entregado_min is null) as sin_cierre,
           percentile_disc(0.5) within group (order by b.entregado_min) filter (where b.entregado_min is not null and b.prometido_min is not null) as real_mediana,
           percentile_disc(0.5) within group (order by b.prometido_min) filter (where b.entregado_min is not null and b.prometido_min is not null) as prometido_mediana,
           percentile_disc(0.5) within group (order by (b.entregado_min - b.prometido_min)) filter (where b.entregado_min is not null and b.prometido_min is not null) as desvio_mediana
      from b where b.canal_efectivo = 'domicilio' group by 1
  ),
  totales as (
    select b.property_id, count(*) as pedidos, sum(b.neta_centavos)::bigint as neta from b group by 1
  )
  select jsonb_build_object(
    'matriz', coalesce((select jsonb_agg(jsonb_build_object('property_id', m.property_id, 'dow', m.dow_negocio, 'hora', m.hora_local, 'canal', m.canal_efectivo,
                                                          'source', m.source, 'pedidos', m.pedidos, 'neta_centavos', m.neta)
                                         order by m.property_id, m.dow_negocio, m.hora_local, m.canal_efectivo, m.source) from matriz m), '[]'::jsonb),
    'semanas', coalesce((select jsonb_agg(jsonb_build_object('property_id', s.property_id, 'semana', to_char(s.semana, 'YYYY-MM-DD'), 'dias', s.dias,
                                                           'pedidos', s.pedidos, 'neta_centavos', s.neta)
                                          order by s.property_id, s.semana) from semanas s), '[]'::jsonb),
    'ticket', coalesce((select jsonb_agg(jsonb_build_object('property_id', t.property_id, 'canal', t.canal, 'pedidos', t.pedidos, 'neta_centavos', t.neta,
                                                          'mediana_centavos', t.mediana, 'p90_centavos', t.p90)
                                         order by t.property_id, t.canal) from ticket t), '[]'::jsonb),
    'pago', coalesce((select jsonb_agg(jsonb_build_object('property_id', p.property_id, 'forma_pago', p.forma_pago, 'pedidos', p.pedidos, 'neta_centavos', p.neta)
                                       order by p.property_id, p.forma_pago) from pago p), '[]'::jsonb),
    'promesa', coalesce((select jsonb_agg(jsonb_build_object('property_id', r.property_id, 'domicilios', r.domicilios, 'entregados', r.entregados,
                                                           'con_promesa', r.con_promesa, 'a_tiempo', r.a_tiempo, 'sin_promesa', r.sin_promesa, 'sin_cierre', r.sin_cierre,
                                                           'real_mediana_min', r.real_mediana, 'prometido_mediana_min', r.prometido_mediana, 'desvio_mediana_min', r.desvio_mediana)
                                          order by r.property_id) from promesa r), '[]'::jsonb),
    'totales', coalesce((select jsonb_agg(jsonb_build_object('property_id', x.property_id, 'pedidos', x.pedidos, 'neta_centavos', x.neta) order by x.property_id) from totales x), '[]'::jsonb),
    'dias_con_venta', (select count(distinct b.dia_negocio) from b)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function restaurantes.analitica_demanda(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.analitica_demanda(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) analitica_zonas
-- ---------------------------------------------------------------------------
-- Colonia = customer_addresses.colonia del domicilio que coincide (misma normalizacion de espacios y mayusculas que cfo_colonias, 082). Un domicilio sin
-- colonia conocida y TODO pedido para recoger caen en «sin colonia / recoge» (tiempo de entrega solo de domicilios: el recoger no se reparte).
-- k-anonimato: una colonia con menos de p_k pedidos o menos de p_k clientes distintos se junta en «(otras)» (minimo 5, como cfo_colonias).
-- Los percentiles de «(otras)» y de «sin colonia / recoge» se calculan sobre sus pedidos reunidos, no promediando colonias.
create or replace function restaurantes.analitica_zonas(p_org uuid, p_props uuid[], p_desde date, p_hasta date, p_k integer default 5)
returns table (
  property_id uuid,
  colonia text,
  pedidos bigint,
  domicilios bigint,
  recogidas bigint,
  neta_centavos bigint,
  clientes bigint,
  entregados bigint,
  sin_cierre bigint,
  mediana_min numeric,
  p90_min numeric,
  mas_de_60 bigint
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
  if p_k is null or p_k < 5 or p_k > 1000 then
    raise exception 'analitica_zonas: k invalido (minimo 5)' using errcode = '22023';
  end if;
  return query
    with dom as materialized (
      select x.order_id, x.property_id, x.customer_id, x.canal_efectivo, x.neta_centavos, x.entregado_min,
             lower(regexp_replace(btrim(x.customer_address), '\s+', ' ', 'g')) as dir
        from restaurantes.analitica_base(p_org, v_props, p_desde, p_hasta) x
       where x.es_venta
    ),
    ca as (
      select a.customer_id, lower(regexp_replace(btrim(a.address), '\s+', ' ', 'g')) as dir, min(nullif(btrim(a.colonia), '')) as colonia
        from restaurantes.customer_addresses a
       where a.customer_id in (select d.customer_id from dom d where d.customer_id is not null and d.canal_efectivo = 'domicilio')
       group by 1, 2
    ),
    pc as (
      select d.property_id, d.customer_id, d.canal_efectivo, d.neta_centavos, d.entregado_min,
             case when d.canal_efectivo = 'domicilio' then ca.colonia end as colonia
        from dom d
        left join ca on ca.customer_id = d.customer_id and ca.dir = d.dir
    ),
    g as (
      select p.property_id, p.colonia, count(*) as pedidos, count(distinct p.customer_id) as clientes
        from pc p where p.colonia is not null
       group by 1, 2
    ),
    lab as (
      select p.property_id, p.customer_id, p.canal_efectivo, p.neta_centavos, p.entregado_min,
             case when p.colonia is null then 'sin colonia / recoge'
                  when g.pedidos < p_k or g.clientes < p_k then '(otras)'
                  else p.colonia end as etiqueta
        from pc p
        left join g on g.property_id = p.property_id and g.colonia = p.colonia
    )
    select l.property_id, l.etiqueta,
           count(*)::bigint,
           (count(*) filter (where l.canal_efectivo = 'domicilio'))::bigint,
           (count(*) filter (where l.canal_efectivo <> 'domicilio'))::bigint,
           coalesce(sum(l.neta_centavos), 0)::bigint,
           count(distinct l.customer_id)::bigint,
           (count(*) filter (where l.canal_efectivo = 'domicilio' and l.entregado_min is not null))::bigint,
           (count(*) filter (where l.canal_efectivo = 'domicilio' and l.entregado_min is null))::bigint,
           percentile_disc(0.5) within group (order by l.entregado_min) filter (where l.canal_efectivo = 'domicilio' and l.entregado_min is not null),
           percentile_disc(0.9) within group (order by l.entregado_min) filter (where l.canal_efectivo = 'domicilio' and l.entregado_min is not null),
           (count(*) filter (where l.canal_efectivo = 'domicilio' and l.entregado_min > 60))::bigint
      from lab l
     group by l.property_id, l.etiqueta
     order by l.property_id, 3 desc, l.etiqueta;
end;
$$;
revoke all on function restaurantes.analitica_zonas(uuid, uuid[], date, date, integer) from public, anon;
grant execute on function restaurantes.analitica_zonas(uuid, uuid[], date, date, integer) to authenticated;
