-- CFO-01: SQL de ventas, productos, canasta, horas y detalle de pedidos del modulo CFO de restaurantes (v1).
-- Prefijo de supabase/migrations: 20240101000391 (interno restaurantes 081).
-- Requiere: 001 (orders, products, categories, branch_products), 023 (branch_policy), 024 (pos_comanda_outbox), 028 (handoff_actor_en_sucursal),
-- 031 (canal, propina), 034 (programado/promovido_at), 035 (voz_zona_horaria), 049 (pedido_falso_at), 050 (por_aprobar, solicitud_aprobacion,
-- reposicion_order_id) y 076/077 (dia_negocio, dia_negocio_corte).
--
-- Que agrega (todo NUEVO; ninguna tabla, funcion, policy ni GRANT existente se modifica, y en particular NO se redefine dia_negocio ni ninguna
-- funcion de 076/077/041: solo se LLAMAN):
--   * indices orders_org_prop_created_idx y orders_org_prop_promovido_idx -- rango por sucursal sin recorrer toda la organizacion.
--   * restaurantes.cfo_renglones(jsonb)             -- helper interno: renglones validos de orders.items.
--   * restaurantes.cfo_validar_rango(date, date)    -- helper interno: rango de 1 a 400 dias.
--   * restaurantes.cfo_resolver_sucursales(...)     -- helper interno: alcance (doble puerta) -> arreglo de sucursales permitidas.
--   * restaurantes.cfo_pedidos_base(...)            -- helper interno: una fila por pedido con la regla comun de venta y dia de negocio.
--   * restaurantes.cfo_ventas_diarias(...)          -- 1. ventas por sucursal/dia/canal/source/forma de pago.
--   * restaurantes.cfo_cortesias(...)               -- 2. reposiciones valuadas a precio de lista vigente.
--   * restaurantes.cfo_ventas_hora(...)             -- 3. pedidos y venta neta por dia de la semana y hora local.
--   * restaurantes.cfo_productos(...)               -- 4. unidades, ingreso y pedidos por producto/dia (ranking, mix, efecto de promo).
--   * restaurantes.cfo_canasta_pares(...)           -- 5. pares de productos, totales y distribucion del ticket por numero de productos (jsonb).
--   * restaurantes.cfo_pedidos_detalle(...)         -- 6. drill-down de pedidos SIN datos personales, con filtros de lista cerrada y cursor.
--   * restaurantes.cfo_cobertura(...)               -- 7. desde cuando hay datos por sucursal, zona horaria y corte.
--
-- Solo SUMAS y CONTEOS aditivos por sucursal (las razones, medianas y percentiles se calculan en TypeScript). Consolidado = suma de las
-- sucursales. Fila «No asignado a sucursal»: esta migracion NO la produce, porque los pedidos siempre llevan property_id; los costos y eventos sin
-- sucursal (LLM de texto por organizacion, costos capturados a nivel organizacion) los pone la migracion 082.
--
-- Definiciones (los rotulos de la pantalla las repiten tal cual):
--   * Dia de negocio = restaurantes.dia_negocio(property_id, coalesce(promovido_at, created_at)): fecha local de la SUCURSAL menos el corte de su
--     horario (PM 12:00-01:00 => 1 h: un pedido a las 00:30 cuenta en el dia anterior, a la 01:05 en el nuevo). hora_local es la hora del reloj
--     local (0-23) SIN restar el corte; dow_negocio es el isodow (1 = lunes) del DIA DE NEGOCIO.
--   * Un pedido cuenta en el instante en que ENTRA a operar: promovido_at si fue programado (034), si no created_at.
--   * Venta (es_venta) = pedido que NO es cancelado, no_recogido, por_aprobar ni programado, SIN pedido_falso_at, sin telefono de trafico demo
--     (rango 0009) y que NO es una reposicion. Es la regla de 041 (cierre_agregados) mas esas exclusiones explicitas. Diferencias con 041:
--     (1) por_aprobar (050) queda fuera; (2) los pedidos marcados como falsos (049) quedan fuera de la venta; (3) las reposiciones
--     (solicitud_aprobacion.reposicion_order_id) no son venta: van a «cortesias». Los programados sin promover y el trafico demo no entran a
--     NINGUNA salida (igual que en 041). cancelados y no_recogidos se cuentan por estado, como en 041 (un cancelado nunca es venta).
--   * Montos en CENTAVOS enteros. bruta_centavos = suma de items[].price x items[].quantity (cada renglon redondeado a centavos); neta_centavos =
--     round(total x 100) (total ya viene neto del descuento, ver orders.ts). Descuento = max(bruta - neta, 0) de las ventas; si la nota del pedido
--     contiene `Promocion aplicada: GRACIAS-` es «compensacion» (desc_comp), si no «promocion» (desc_promo). La propina NO esta en el total
--     (nota «no incluida en el total»): propina_centavos se suma aparte y solo existe la que el agente capturo.
--   * Tiempo de entrega = delivered_at - inicio, status 'entregado' o 'completado' (desde 077 el autopiloto pasa los entregados a completado a las 6 h) con delivered_at >= inicio, en minutos con 2 decimales POR PEDIDO (asi la
--     suma es exacta y aditiva). entrega_tarde = entregas con mas minutos que p_promesa_min (default 50). Las razones y el p90 se calculan fuera.
--   * Reposiciones: pedidos referenciados por solicitud_aprobacion.reposicion_order_id (no cancelados ni por aprobar). Su valor se estima a
--     precio de lista VIGENTE: branch_products.price de la sucursal si existe (es la fuente de verdad del precio, ver 001) y, si no,
--     products.price; los renglones sin producto vigente cuentan en renglones_sin_precio (valor 0, nunca inventado).
--   * Canal efectivo = orders.canal, o 'domicilio' si hay customer_address, o 'recoger'.
--   * Sin PII: ninguna funcion devuelve nombre, telefono ni direccion. El detalle identifica al cliente con un alias de 8 caracteres
--     (hash de customer_id).
--
-- Justificacion de seguridad (una por una):
--  * Funciones publicas (cfo_ventas_diarias, cfo_cortesias, cfo_ventas_hora, cfo_productos, cfo_canasta_pares, cfo_pedidos_detalle,
--    cfo_cobertura): SECURITY DEFINER (orders tiene RLS por sucursal y 065 quito DML a authenticated; son SOLO LECTURA, declaradas STABLE, no
--    escriben nada), search_path fijo `restaurantes, core, pg_temp`, `revoke all from public, anon`, `grant execute to authenticated` (la sesion de
--    sistema del backend corre con ese rol sin usuario). anon no tiene execute. Doble puerta, igual que generar_cierre, via
--    cfo_resolver_sucursales:
--      - usuario (auth.uid() no nulo): cada sucursal pedida debe pasar handoff_actor_en_sucursal(org, prop, true) (owner/admin con alcance a ESA
--        sucursal); staff, repartidor y otra organizacion reciben 42501 con el mismo mensaje para sucursal ajena o inexistente;
--      - sistema (auth.uid() nulo): solo valida que cada sucursal pertenezca a la organizacion declarada (un barrido no cruza tenants).
--    p_props nulo = todas las permitidas: owner = todas las sucursales (branch_detail) de la organizacion; admin acotado = solo las suyas; sistema
--    = todas las de la organizacion. 42501 si alguna sucursal no esta permitida; 22023 si la lista queda vacia, trae nulos o el rango es invalido.
--  * Helpers (cfo_renglones, cfo_validar_rango, cfo_resolver_sucursales, cfo_pedidos_base): `revoke all from public, anon, authenticated`; solo los
--    ejecuta el duenio de las funciones publicas invocantes, que ya valido el acceso (mismo patron que cierre_agregados). cfo_pedidos_base y
--    cfo_resolver_sucursales NO se pueden llamar desde authenticated.
--  * Todo filtro lleva organization_id Y property_id (sucursales ya resueltas). Rango maximo 400 dias; detalle con tope de 200 filas por pagina.
--
-- Compatibilidad con una base sin migrar: todo es nuevo. Llamar una de estas funciones antes de aplicar la migracion da 42883 (funcion no
-- existe) o 42P01; el TypeScript de 05 lo degrada con SAVEPOINT. Esta migracion es idempotente (create or replace / if not exists / revoke+grant).

-- ---------------------------------------------------------------------------
-- 0) Indices
-- ---------------------------------------------------------------------------
create index if not exists orders_org_prop_created_idx on restaurantes.orders (organization_id, property_id, created_at);
-- Pedidos programados que entraron a operar en el rango pero se crearon antes (promovido_at): indice parcial, pocas filas.
create index if not exists orders_org_prop_promovido_idx on restaurantes.orders (organization_id, property_id, promovido_at) where promovido_at is not null;

-- ---------------------------------------------------------------------------
-- 1) Helpers internos
-- ---------------------------------------------------------------------------
-- Renglones validos de orders.items: un objeto con price numerico no negativo y quantity entera. Lo demas (p. ej. quantity no entera) se ignora SIN aviso
-- (nunca inventa; la bruta de ese pedido queda sin ese renglon).
create or replace function restaurantes.cfo_renglones(p_items jsonb)
returns table (producto_ref text, nombre text, precio numeric, cantidad numeric)
language sql
immutable
set search_path = restaurantes, core, pg_temp
as $$
  select nullif(btrim(e.value ->> 'id'), ''),
         nullif(btrim(e.value ->> 'name'), ''),
         (e.value ->> 'price')::numeric,
         (e.value ->> 'quantity')::numeric
  from jsonb_array_elements(case when jsonb_typeof(p_items) = 'array' then p_items else '[]'::jsonb end) as e(value)
  where jsonb_typeof(e.value) = 'object'
    and (e.value ->> 'price') ~ '^[0-9]{1,8}(\.[0-9]{1,6})?$'
    and (e.value ->> 'quantity') ~ '^[0-9]{1,6}$';
$$;
revoke all on function restaurantes.cfo_renglones(jsonb) from public, anon, authenticated;

create or replace function restaurantes.cfo_validar_rango(p_desde date, p_hasta date)
returns void
language plpgsql
immutable
set search_path = restaurantes, core, pg_temp
as $$
begin
  if p_desde is null or p_hasta is null or p_desde > p_hasta then
    raise exception 'cfo: rango de fechas invalido' using errcode = '22023';
  end if;
  if p_hasta - p_desde + 1 > 400 then
    raise exception 'cfo: el rango maximo es de 400 dias' using errcode = '22023';
  end if;
end;
$$;
revoke all on function restaurantes.cfo_validar_rango(date, date) from public, anon, authenticated;

-- Alcance: doble puerta (usuario owner/admin con alcance por sucursal, o sesion de sistema). Devuelve las sucursales permitidas, sin repetidos.
create or replace function restaurantes.cfo_resolver_sucursales(p_org uuid, p_props uuid[])
returns uuid[]
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_props uuid[];
  v_prop uuid;
begin
  if p_org is null then
    raise exception 'cfo: organizacion requerida' using errcode = '22023';
  end if;
  if p_props is not null then
    if cardinality(p_props) = 0 or cardinality(p_props) > 500 or array_position(p_props, null) is not null then
      raise exception 'cfo: lista de sucursales invalida' using errcode = '22023';
    end if;
    select array_agg(distinct u.x) into v_props from unnest(p_props) as u(x);
    foreach v_prop in array v_props loop
      if auth.uid() is null then
        -- Sistema: la sucursal debe pertenecer a la organizacion declarada.
        if not exists (select 1 from core.property p join restaurantes.branch_detail bd on bd.property_id = p.id
                        where p.id = v_prop and p.organization_id = p_org) then
          raise exception 'cfo: sin acceso a la sucursal' using errcode = '42501';
        end if;
      elsif not restaurantes.handoff_actor_en_sucursal(p_org, v_prop, true) then
        raise exception 'cfo: sin acceso a la sucursal' using errcode = '42501';
      end if;
    end loop;
    return v_props;
  end if;

  -- p_props nulo: todas las permitidas del actor.
  if auth.uid() is null then
    select array_agg(bd.property_id order by bd.property_id) into v_props
      from restaurantes.branch_detail bd
     where bd.organization_id = p_org;
  else
    select array_agg(bd.property_id order by bd.property_id) into v_props
      from restaurantes.branch_detail bd
     where bd.organization_id = p_org
       and restaurantes.handoff_actor_en_sucursal(p_org, bd.property_id, true);
    if v_props is null then
      raise exception 'cfo: sin acceso a la sucursal' using errcode = '42501';
    end if;
  end if;
  if v_props is null or cardinality(v_props) = 0 then
    raise exception 'cfo: la organizacion no tiene sucursales' using errcode = '22023';
  end if;
  return v_props;
end;
$$;
revoke all on function restaurantes.cfo_resolver_sucursales(uuid, uuid[]) from public, anon, authenticated;

-- Base comun: una fila por pedido (sucursales YA resueltas) con dia de negocio y la regla de venta. Sin guard propio: revoke total.
create or replace function restaurantes.cfo_pedidos_base(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  order_id uuid,
  order_number bigint,
  property_id uuid,
  customer_id uuid,
  items jsonb,
  dia_negocio date,
  hora_local integer,
  dow_negocio integer,
  source text,
  canal_efectivo text,
  status text,
  payment_method text,
  es_venta boolean,
  es_reposicion boolean,
  es_falso boolean,
  bruta_centavos bigint,
  neta_centavos bigint,
  desc_centavos bigint,
  es_compensacion boolean,
  propina_centavos bigint,
  entregado_min numeric
)
language sql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
  with par as materialized (
    select x.pid as property_id, restaurantes.voz_zona_horaria(x.pid) as tz, restaurantes.dia_negocio_corte(x.pid) as corte
      from unnest(p_props) as x(pid)
  ),
  repos as materialized (
    select distinct s.reposicion_order_id as order_id
      from restaurantes.solicitud_aprobacion s
     where s.organization_id = p_org and s.reposicion_order_id is not null
  ),
  src as (
    select o.id, o.order_number, o.property_id, o.customer_id, o.items, o.source, o.status, o.payment_method,
           o.total, o.propina, o.canal, o.customer_address, o.notes, o.delivered_at, o.pedido_falso_at,
           par.tz, par.corte, coalesce(o.promovido_at, o.created_at) as inicio
      from restaurantes.orders o
      join par on par.property_id = o.property_id
     where o.organization_id = p_org
       and o.status <> 'programado'
       and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
       -- Ventana ampliada (zona horaria y corte) y recortada despues por dia de negocio. promovido_at cubre programados creados antes.
       and ((o.created_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and o.created_at < ((p_hasta + 4)::timestamp at time zone 'UTC'))
         or (o.promovido_at >= ((p_desde - 3)::timestamp at time zone 'UTC') and o.promovido_at < ((p_hasta + 4)::timestamp at time zone 'UTC')))
  ),
  dn as (
    select s.*, ((s.inicio at time zone s.tz) - s.corte)::date as dia
      from src s
  )
  select d.id, d.order_number, d.property_id, d.customer_id, d.items,
         d.dia,
         extract(hour from (d.inicio at time zone d.tz))::integer,
         extract(isodow from d.dia)::integer,
         d.source,
         coalesce(d.canal, case when d.customer_address is not null then 'domicilio' else 'recoger' end),
         d.status,
         d.payment_method,
         v.es_venta,
         (r.order_id is not null),
         (d.pedido_falso_at is not null),
         b.bruta,
         n.neta,
         case when v.es_venta then greatest(b.bruta - n.neta, 0) else 0 end::bigint,
         (coalesce(d.notes, '') like '%Promoción aplicada: GRACIAS-%'),
         coalesce(round(d.propina * 100), 0)::bigint,
         case when d.status in ('entregado', 'completado') and d.delivered_at is not null and d.delivered_at >= d.inicio
              then round(extract(epoch from (d.delivered_at - d.inicio))::numeric / 60.0, 2) end
    from dn d
    left join repos r on r.order_id = d.id
    cross join lateral (select coalesce(sum(round(x.precio * x.cantidad * 100)), 0)::bigint as bruta from restaurantes.cfo_renglones(d.items) x) b
    cross join lateral (select round(d.total * 100)::bigint as neta) n
    cross join lateral (
      select (d.status not in ('cancelado', 'no_recogido', 'por_aprobar') and d.pedido_falso_at is null and r.order_id is null) as es_venta
    ) v
   where d.dia between p_desde and p_hasta;
$$;
revoke all on function restaurantes.cfo_pedidos_base(uuid, uuid[], date, date) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2) cfo_ventas_diarias
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_ventas_diarias(
  p_org uuid,
  p_props uuid[],
  p_desde date,
  p_hasta date,
  p_promesa_min integer default 50
) returns table (
  property_id uuid,
  dia_negocio date,
  canal text,
  source text,
  payment_method text,
  pedidos bigint,
  bruta_centavos bigint,
  desc_promo_centavos bigint,
  desc_comp_centavos bigint,
  neta_centavos bigint,
  propina_centavos bigint,
  cancelados bigint,
  cancelados_centavos bigint,
  no_recogidos bigint,
  no_recogidos_centavos bigint,
  reposiciones bigint,
  reposicion_unidades bigint,
  entregados bigint,
  entrega_min_suma numeric,
  entrega_tarde bigint
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
    raise exception 'cfo_ventas_diarias: promesa invalida' using errcode = '22023';
  end if;
  return query
    with b as (select * from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta)),
    reps as (
      select r.order_id, coalesce(sum(x.cantidad), 0)::bigint as unidades
        from b r
        cross join lateral restaurantes.cfo_renglones(r.items) x
       where r.es_reposicion and r.status not in ('cancelado', 'por_aprobar')
       group by r.order_id
    )
    select b.property_id, b.dia_negocio, b.canal_efectivo, b.source, b.payment_method,
           (count(*) filter (where b.es_venta))::bigint,
           coalesce(sum(b.bruta_centavos) filter (where b.es_venta), 0)::bigint,
           coalesce(sum(b.desc_centavos) filter (where b.es_venta and not b.es_compensacion), 0)::bigint,
           coalesce(sum(b.desc_centavos) filter (where b.es_venta and b.es_compensacion), 0)::bigint,
           coalesce(sum(b.neta_centavos) filter (where b.es_venta), 0)::bigint,
           coalesce(sum(b.propina_centavos) filter (where b.es_venta), 0)::bigint,
           (count(*) filter (where b.status = 'cancelado' and not b.es_reposicion))::bigint,
           coalesce(sum(b.neta_centavos) filter (where b.status = 'cancelado' and not b.es_reposicion), 0)::bigint,
           (count(*) filter (where b.status = 'no_recogido' and not b.es_reposicion))::bigint,
           coalesce(sum(b.neta_centavos) filter (where b.status = 'no_recogido' and not b.es_reposicion), 0)::bigint,
           (count(*) filter (where b.es_reposicion and b.status not in ('cancelado', 'por_aprobar')))::bigint,
           coalesce(sum(rp.unidades) filter (where b.es_reposicion and b.status not in ('cancelado', 'por_aprobar')), 0)::bigint,
           (count(*) filter (where b.es_venta and b.entregado_min is not null))::bigint,
           coalesce(sum(b.entregado_min) filter (where b.es_venta), 0)::numeric,
           (count(*) filter (where b.es_venta and b.entregado_min > p_promesa_min))::bigint
      from b
      left join reps rp on rp.order_id = b.order_id
     where b.es_venta
        or (not b.es_reposicion and b.status in ('cancelado', 'no_recogido'))
        or (b.es_reposicion and b.status not in ('cancelado', 'por_aprobar'))
     group by b.property_id, b.dia_negocio, b.canal_efectivo, b.source, b.payment_method
     order by b.property_id, b.dia_negocio, b.canal_efectivo, b.source, b.payment_method;
end;
$$;
revoke all on function restaurantes.cfo_ventas_diarias(uuid, uuid[], date, date, integer) from public, anon;
grant execute on function restaurantes.cfo_ventas_diarias(uuid, uuid[], date, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) cfo_cortesias
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_cortesias(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  dia_negocio date,
  reposiciones bigint,
  valor_lista_centavos bigint,
  renglones_sin_precio bigint
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
    with b as (
      select * from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta)
       where es_reposicion and status not in ('cancelado', 'por_aprobar')
    ),
    reng as (
      select b.order_id, b.property_id, b.dia_negocio,
             case when pr.id is null then null
                  else round(coalesce(bp.price, pr.price) * x.cantidad * 100)::bigint end as valor,
             (pr.id is null) as sin_precio
        from b
        cross join lateral restaurantes.cfo_renglones(b.items) x
        left join restaurantes.products pr on pr.organization_id = p_org and lower(pr.id::text) = lower(x.producto_ref)
        left join restaurantes.branch_products bp on bp.property_id = b.property_id and bp.product_id = pr.id
    ),
    por_pedido as (
      select b.order_id, b.property_id, b.dia_negocio,
             coalesce(sum(r.valor), 0)::bigint as valor,
             (count(*) filter (where r.sin_precio))::bigint as sin_precio
        from b
        left join reng r on r.order_id = b.order_id
       group by b.order_id, b.property_id, b.dia_negocio
    )
    select pp.property_id, pp.dia_negocio, count(*)::bigint, sum(pp.valor)::bigint, sum(pp.sin_precio)::bigint
      from por_pedido pp
     group by pp.property_id, pp.dia_negocio
     order by pp.property_id, pp.dia_negocio;
end;
$$;
revoke all on function restaurantes.cfo_cortesias(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_cortesias(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 4) cfo_ventas_hora
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_ventas_hora(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  dow_negocio integer,
  hora_local integer,
  source text,
  pedidos bigint,
  neta_centavos bigint
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
    select b.property_id, b.dow_negocio, b.hora_local, b.source,
           count(*)::bigint,
           coalesce(sum(b.neta_centavos), 0)::bigint
      from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta) b
     where b.es_venta
     group by b.property_id, b.dow_negocio, b.hora_local, b.source
     order by b.property_id, b.dow_negocio, b.hora_local, b.source;
end;
$$;
revoke all on function restaurantes.cfo_ventas_hora(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_ventas_hora(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 5) cfo_productos
-- ---------------------------------------------------------------------------
-- Solo ventas. ingreso_centavos = precio del renglon x cantidad (antes de descuentos de pedido). nombre_actual: products.name o, si el producto
-- ya no existe, el nombre del renglon; categoria: categories.name o '(sin categoría)'. pedidos = pedidos distintos con el producto ese dia.
create or replace function restaurantes.cfo_productos(p_org uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (
  property_id uuid,
  producto_ref text,
  nombre_actual text,
  categoria text,
  dia_negocio date,
  dow_negocio integer,
  unidades bigint,
  ingreso_centavos bigint,
  pedidos bigint
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
    with b as (
      select * from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta) where es_venta
    ),
    r as (
      select b.order_id, b.property_id, b.dia_negocio, b.dow_negocio, x.producto_ref, x.nombre, x.precio, x.cantidad
        from b
        cross join lateral restaurantes.cfo_renglones(b.items) x
       where x.producto_ref is not null
    )
    select r.property_id, r.producto_ref,
           coalesce(max(pr.name), max(r.nombre)),
           coalesce(max(c.name), '(sin categoría)'),
           r.dia_negocio, r.dow_negocio,
           sum(r.cantidad)::bigint,
           sum(round(r.precio * r.cantidad * 100))::bigint,
           count(distinct r.order_id)::bigint
      from r
      left join restaurantes.products pr on pr.organization_id = p_org and lower(pr.id::text) = lower(r.producto_ref)
      left join restaurantes.categories c on c.id = pr.category_id
     group by r.property_id, r.producto_ref, r.dia_negocio, r.dow_negocio
     order by r.property_id, r.producto_ref, r.dia_negocio;
end;
$$;
revoke all on function restaurantes.cfo_productos(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.cfo_productos(uuid, uuid[], date, date) to authenticated;

-- ---------------------------------------------------------------------------
-- 6) cfo_canasta_pares
-- ---------------------------------------------------------------------------
-- Devuelve UN jsonb (se eligio jsonb para que pares, totales y ticket viajen en una sola llamada y una sola foto consistente):
--   { "pares":     [ {property_id, producto_a, producto_b, pedidos_juntos} ],            -- a < b (texto), top p_limite POR SUCURSAL
--     "productos": [ {property_id, producto_ref, pedidos_con_producto} ],                -- productos que aparecen en esos pares
--     "totales":   [ {property_id, pedidos_totales} ],                                    -- ventas de la sucursal (soporte = juntos / totales)
--     "tickets":   [ {property_id, n_productos, pedidos, neta_centavos} ] }              -- n_productos: 1, 2, 3, 4 o 5 (= 5 o mas)
-- Solo ventas; un producto repetido en un pedido cuenta una vez. OJO aditividad: pedidos_juntos de un par SI suma entre sucursales, pero el top se
-- corta por sucursal; para consolidar un par hay que pedirlo con p_limite alto (max 500) para que ninguna sucursal lo recorte.
create or replace function restaurantes.cfo_canasta_pares(
  p_org uuid,
  p_props uuid[],
  p_desde date,
  p_hasta date,
  p_limite integer default 50
) returns jsonb
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_props uuid[];
  v_lim integer;
  v_out jsonb;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  if p_limite is null or p_limite < 1 then
    raise exception 'cfo_canasta_pares: limite invalido' using errcode = '22023';
  end if;
  v_lim := least(p_limite, 500);

  with b as (
    select * from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta) where es_venta
  ),
  ped as (
    select b.order_id, b.property_id, b.neta_centavos,
           coalesce(array_agg(distinct x.producto_ref order by x.producto_ref) filter (where x.producto_ref is not null), '{}'::text[]) as refs
      from b
      left join lateral restaurantes.cfo_renglones(b.items) x on true
     group by b.order_id, b.property_id, b.neta_centavos
  ),
  pares_all as (
    select p.property_id, a.ref as producto_a, c.ref as producto_b, count(*) as juntos
      from ped p
      cross join lateral unnest(p.refs) with ordinality as a(ref, ia)
      cross join lateral unnest(p.refs) with ordinality as c(ref, ic)
     where a.ia < c.ic
     group by p.property_id, a.ref, c.ref
  ),
  pares_top as (
    select * from (
      select pa.*, row_number() over (partition by pa.property_id order by pa.juntos desc, pa.producto_a, pa.producto_b) as rn
        from pares_all pa
    ) t where t.rn <= v_lim
  ),
  refs_top as (
    select distinct pt.property_id, u.ref
      from pares_top pt
      cross join lateral (values (pt.producto_a), (pt.producto_b)) as u(ref)
  )
  select jsonb_build_object(
    'pares', coalesce((select jsonb_agg(jsonb_build_object('property_id', pt.property_id, 'producto_a', pt.producto_a,
                                                          'producto_b', pt.producto_b, 'pedidos_juntos', pt.juntos)
                                         order by pt.property_id, pt.juntos desc, pt.producto_a, pt.producto_b) from pares_top pt), '[]'::jsonb),
    'productos', coalesce((select jsonb_agg(jsonb_build_object('property_id', rt.property_id, 'producto_ref', rt.ref,
                                                              'pedidos_con_producto', (select count(*) from ped p where p.property_id = rt.property_id and rt.ref = any (p.refs)))
                                             order by rt.property_id, rt.ref) from refs_top rt), '[]'::jsonb),
    'totales', coalesce((select jsonb_agg(jsonb_build_object('property_id', t.property_id, 'pedidos_totales', t.n) order by t.property_id)
                           from (select p.property_id, count(*) as n from ped p group by p.property_id) t), '[]'::jsonb),
    'tickets', coalesce((select jsonb_agg(jsonb_build_object('property_id', t.property_id, 'n_productos', t.n_productos,
                                                            'pedidos', t.pedidos, 'neta_centavos', t.neta)
                                           order by t.property_id, t.n_productos)
                           from (select p.property_id, least(cardinality(p.refs), 5) as n_productos, count(*) as pedidos,
                                        coalesce(sum(p.neta_centavos), 0)::bigint as neta
                                   from ped p where cardinality(p.refs) >= 1
                                  group by p.property_id, least(cardinality(p.refs), 5)) t), '[]'::jsonb)
  ) into v_out;
  return v_out;
end;
$$;
revoke all on function restaurantes.cfo_canasta_pares(uuid, uuid[], date, date, integer) from public, anon;
grant execute on function restaurantes.cfo_canasta_pares(uuid, uuid[], date, date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 7) cfo_pedidos_detalle
-- ---------------------------------------------------------------------------
-- Drill-down SIN PII. bruta/"desc"/neta/propina en CENTAVOS. Devuelve TODOS los pedidos de la base comun (ventas y no ventas: es_venta permite
-- separarlos; los programados sin promover y el trafico demo no existen). Orden: dia_negocio desc, order_number desc. cursor_pagina de la ULTIMA fila
-- ("YYYY-MM-DD|order_number") se pasa como p_cursor para la pagina siguiente. Tope 200 filas por pagina.
-- Filtros (lista cerrada, p_filtro objeto jsonb): canal, source, status, payment_method, producto_ref (texto); es_venta, es_compensacion,
-- con_descuento, entrega_tarde (booleano); hora_local (0-23), dow_negocio (1-7) (entero). Otra clave o un tipo erroneo => 22023.
create or replace function restaurantes.cfo_pedidos_detalle(
  p_org uuid,
  p_props uuid[],
  p_desde date,
  p_hasta date,
  p_filtro jsonb default null,
  p_limite integer default 50,
  p_cursor text default null,
  p_promesa_min integer default 50
) returns table (
  order_id uuid,
  order_number bigint,
  property_id uuid,
  dia_negocio date,
  hora_local integer,
  canal text,
  source text,
  status text,
  payment_method text,
  bruta bigint,
  "desc" bigint,
  neta bigint,
  propina bigint,
  entregado_min numeric,
  es_compensacion boolean,
  es_reposicion boolean,
  cliente_alias text,
  comanda_estado text,
  cursor_pagina text
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_f jsonb := coalesce(p_filtro, '{}'::jsonb);
  v_lim integer;
  v_k text;
  v_t text;
  v_c_dia date;
  v_c_num bigint;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  if jsonb_typeof(v_f) <> 'object' then
    raise exception 'cfo_pedidos_detalle: filtro invalido' using errcode = '22023';
  end if;
  for v_k, v_t in select k, jsonb_typeof(v) from jsonb_each(v_f) as e(k, v) loop
    if v_k in ('canal', 'source', 'status', 'payment_method', 'producto_ref') then
      if v_t <> 'string' then raise exception 'cfo_pedidos_detalle: filtro % invalido', v_k using errcode = '22023'; end if;
    elsif v_k in ('es_venta', 'es_compensacion', 'con_descuento', 'entrega_tarde') then
      if v_t <> 'boolean' then raise exception 'cfo_pedidos_detalle: filtro % invalido', v_k using errcode = '22023'; end if;
    elsif v_k in ('hora_local', 'dow_negocio') then
      if v_t <> 'number' or (v_f ->> v_k) !~ '^[0-9]{1,2}$' then raise exception 'cfo_pedidos_detalle: filtro % invalido', v_k using errcode = '22023'; end if;
    else
      raise exception 'cfo_pedidos_detalle: filtro % no permitido', v_k using errcode = '22023';
    end if;
  end loop;
  if p_limite is null or p_limite < 1 then
    raise exception 'cfo_pedidos_detalle: limite invalido' using errcode = '22023';
  end if;
  v_lim := least(p_limite, 200);
  if p_promesa_min is null or p_promesa_min < 1 or p_promesa_min > 1440 then
    raise exception 'cfo_pedidos_detalle: promesa invalida' using errcode = '22023';
  end if;
  if p_cursor is not null then
    if p_cursor !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}\|[0-9]{1,18}$' then
      raise exception 'cfo_pedidos_detalle: cursor invalido' using errcode = '22023';
    end if;
    begin
      v_c_dia := split_part(p_cursor, '|', 1)::date;
      v_c_num := split_part(p_cursor, '|', 2)::bigint;
    exception when others then
      raise exception 'cfo_pedidos_detalle: cursor invalido' using errcode = '22023';
    end;
  end if;

  return query
    select b.order_id, b.order_number, b.property_id, b.dia_negocio, b.hora_local, b.canal_efectivo, b.source, b.status, b.payment_method,
           b.bruta_centavos, b.desc_centavos, b.neta_centavos, b.propina_centavos, b.entregado_min,
           b.es_compensacion, b.es_reposicion,
           case when b.customer_id is null then null
                else left(encode(sha256(convert_to(b.customer_id::text, 'UTF8')), 'hex'), 8) end,
           co.estado,
           to_char(b.dia_negocio, 'YYYY-MM-DD') || '|' || b.order_number::text
      from restaurantes.cfo_pedidos_base(p_org, v_props, p_desde, p_hasta) b
      left join restaurantes.pos_comanda_outbox co on co.organization_id = p_org and co.order_id = b.order_id
     where (not (v_f ? 'canal') or b.canal_efectivo = v_f ->> 'canal')
       and (not (v_f ? 'source') or b.source = v_f ->> 'source')
       and (not (v_f ? 'status') or b.status = v_f ->> 'status')
       and (not (v_f ? 'payment_method') or b.payment_method = v_f ->> 'payment_method')
       and (not (v_f ? 'es_venta') or b.es_venta = (v_f ->> 'es_venta')::boolean)
       and (not (v_f ? 'es_compensacion') or b.es_compensacion = (v_f ->> 'es_compensacion')::boolean)
       and (not (v_f ? 'con_descuento') or (b.desc_centavos > 0) = (v_f ->> 'con_descuento')::boolean)
       and (not (v_f ? 'entrega_tarde') or (coalesce(b.entregado_min > p_promesa_min, false)) = (v_f ->> 'entrega_tarde')::boolean)
       and (not (v_f ? 'hora_local') or b.hora_local = (v_f ->> 'hora_local')::integer)
       and (not (v_f ? 'dow_negocio') or b.dow_negocio = (v_f ->> 'dow_negocio')::integer)
       and (not (v_f ? 'producto_ref') or exists (
              select 1 from restaurantes.cfo_renglones(b.items) x where lower(x.producto_ref) = lower(v_f ->> 'producto_ref')))
       and (p_cursor is null or (b.dia_negocio, b.order_number) < (v_c_dia, v_c_num))
     order by b.dia_negocio desc, b.order_number desc
     limit v_lim;
end;
$$;
revoke all on function restaurantes.cfo_pedidos_detalle(uuid, uuid[], date, date, jsonb, integer, text, integer) from public, anon;
grant execute on function restaurantes.cfo_pedidos_detalle(uuid, uuid[], date, date, jsonb, integer, text, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 8) cfo_cobertura
-- ---------------------------------------------------------------------------
-- Por sucursal: primer y ultimo dia de negocio con pedidos (mismos pedidos que la base: sin programados por promover ni trafico demo), zona y corte
-- (intervalo como texto). primer_dia/ultimo_dia nulos = sin pedidos. Le dice a la UI desde cuando hay datos.
create or replace function restaurantes.cfo_cobertura(p_org uuid, p_props uuid[])
returns table (
  property_id uuid,
  primer_dia date,
  ultimo_dia date,
  zona text,
  corte text
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
  return query
    select pr.pid,
           case when m.mn is null then null else restaurantes.dia_negocio(pr.pid, m.mn) end,
           case when m.mx is null then null else restaurantes.dia_negocio(pr.pid, m.mx) end,
           restaurantes.voz_zona_horaria(pr.pid),
           restaurantes.dia_negocio_corte(pr.pid)::text
      from unnest(v_props) as pr(pid)
      left join lateral (
        select min(coalesce(o.promovido_at, o.created_at)) as mn, max(coalesce(o.promovido_at, o.created_at)) as mx
          from restaurantes.orders o
         where o.organization_id = p_org and o.property_id = pr.pid
           and o.status <> 'programado'
           and right(regexp_replace(o.customer_phone, '\D', '', 'g'), 10) not like '0009%'
      ) m on true
     order by pr.pid;
end;
$$;
revoke all on function restaurantes.cfo_cobertura(uuid, uuid[]) from public, anon;
grant execute on function restaurantes.cfo_cobertura(uuid, uuid[]) to authenticated;

-- Comentarios de las funciones publicas.
comment on function restaurantes.cfo_ventas_diarias(uuid, uuid[], date, date, integer) is 'CFO: ventas por sucursal/dia/canal/source/pago (centavos, aditivo). Doble puerta owner/admin o sistema.';
comment on function restaurantes.cfo_cortesias(uuid, uuid[], date, date) is 'CFO: reposiciones valuadas a precio de lista vigente por sucursal y dia.';
comment on function restaurantes.cfo_ventas_hora(uuid, uuid[], date, date) is 'CFO: pedidos y venta neta por dia de la semana del dia de negocio y hora local.';
comment on function restaurantes.cfo_productos(uuid, uuid[], date, date) is 'CFO: unidades, ingreso y pedidos por producto y dia de negocio (solo ventas).';
comment on function restaurantes.cfo_canasta_pares(uuid, uuid[], date, date, integer) is 'CFO: pares de productos, totales y distribucion del ticket (jsonb); top por sucursal.';
comment on function restaurantes.cfo_pedidos_detalle(uuid, uuid[], date, date, jsonb, integer, text, integer) is 'CFO: drill-down de pedidos sin PII, filtros de lista cerrada, tope 200 y cursor.';
comment on function restaurantes.cfo_cobertura(uuid, uuid[]) is 'CFO: primer y ultimo dia con pedidos, zona y corte por sucursal.';
