-- CFO-02b (restaurantes 084): cierra cuatro huecos del CFO que dejo el servicio de CFO-05 (#509) leyendo `null`.
-- Prefijo de supabase/migrations: 20240101000394 (interno restaurantes 084).
-- Requiere: 081 (cfo_resolver_sucursales, cfo_validar_rango, cfo_pedidos_base, cfo_renglones), 082 (cfo_venta_lean) y 083 (cfo_config,
-- cfo_config_efectiva, cfo_resolver_alcance, sr_resumen_dia).
--
-- Que agrega:
--   1. restaurantes.cfo_clientes_frecuentes_dormidos(...)  -- NUEVA. Clientes frecuentes (cfo_config: N pedidos en X dias) que llevan >= M dias sin
--      pedir, por sucursal y del conjunto (NO aditivo), con una muestra opcional de alias hash. Alimenta el hallazgo `frecuentes_dormidos`.
--   2. restaurantes.cfo_descuento_p90(...)                  -- NUEVA. Percentil 90 historico del descuento % DIARIO por sucursal y del conjunto.
--      Alimenta `descuentoPctP90Historico` (hallazgo `descuento_fuera_rango`).
--   3. restaurantes.cfo_pedidos_detalle(...)                -- REDEFINIDA (DROP + CREATE: cambia el tipo de retorno). Misma firma de entrada y mismo
--      cuerpo que la 081, mas la columna `es_venta` AL FINAL (el filtro es_venta ya existia, pero la fila no decia si lo era).
--   4. restaurantes.sr_resumen_leer(...)                    -- REDEFINIDA (DROP + CREATE: cambia el tipo de retorno). Mismas columnas y orden que la 083,
--      mas `forma_pago` AL FINAL. Las filas ahora se parten por forma de pago.
--
-- ORDEN DE REDEFINICION: la ultima definicion de cfo_pedidos_detalle (081) y de sr_resumen_leer (083) es la de ESTA migracion (394, posterior a
-- ambas). Ninguna migracion con prefijo menor las vuelve a tocar. NO se redefine ninguna otra funcion (cfo_validar_rango de la 081 se LLAMA).
--
-- Definiciones:
--   * Frecuente: >= N ventas del cliente en los X dias de negocio que terminan en p_hasta (dia > p_hasta - X), la MISMA regla que
--     cfo_clientes_resumen.frecuentes (082). Dormido: dias desde su ultimo pedido (a p_hasta) >= M. N y X salen de cfo_config de la organizacion
--     (o de los parametros si se mandan); M es un parametro (default 30, el umbral del hallazgo). Como el cliente debe tener un pedido DENTRO de la
--     ventana de X dias, si M >= X nadie puede ser a la vez frecuente y dormido: se devuelve cero (no es un error). Por sucursal el cliente se mide
--     solo con sus pedidos EN esa sucursal; en el renglon del conjunto (alcance = 'conjunto', property_id nulo), con todos los de las sucursales
--     consultadas. NO es aditivo: un cliente que compra en dos sucursales cuenta en ambas y una vez en el conjunto.
--   * Cliente = orders.customer_id; los pedidos sin cliente identificado no entran. Venta = la regla de la 081/082 (cfo_venta_lean: cuenta
--     'entregado' y 'completado' y todo estado que no sea cancelado, no_recogido, por_aprobar o programado; sin falsos, sin demo 0009, sin
--     reposiciones).
--   * Sin PII: la muestra opcional (p_muestra > 0) trae solo alias = primeros 8 caracteres del sha-256 del customer_id (igual que
--     cfo_pedidos_detalle), pedidos, dias sin pedir y venta neta. Nunca nombre, telefono ni direccion.
--   * Descuento p90: por sucursal y dia de negocio, descuento % = 100 x Σ desc_centavos / Σ bruta_centavos de las ventas (descuento de promocion
--     + compensacion, igual que descPct del dominio). Solo cuentan los dias con bruta > 0. p90_pct = percentile_cont(0.9) de esos porcentajes
--     diarios, redondeado a 2 decimales, sobre los p_dias dias de negocio que terminan en p_hasta. Con menos de 14 dias con venta (la minima
--     historia que se considera creible) el p90 es NULL: nunca se inventa. El renglon del conjunto toma el descuento % diario de la SUMA de las
--     sucursales consultadas (no el promedio de los p90 de sus sucursales). NO es aditivo.
--   * forma_pago de SoftRestaurant: texto normalizado en minusculas tal como lo importo sr_importar (083), o NULL cuando el archivo no la trae.
--     La suma por (sucursal, dia, tipo_servicio) de cualquier columna es IDENTICA a la que devolvia la 083 (solo se parte el renglon). iva_centavos
--     sigue siendo NULL si algun renglon del grupo no traia IVA (ahora el grupo es mas fino: puede haber IVA en una forma de pago y no en otra).
--
-- Justificacion de seguridad (una por una):
--  * cfo_clientes_frecuentes_dormidos y cfo_descuento_p90: SECURITY DEFINER (orders y customers tienen RLS por rol y la 065 quito DML a authenticated;
--    son SOLO LECTURA, STABLE), search_path fijo `restaurantes, core, pg_temp`, `revoke all from public, anon`, `grant execute to authenticated`
--    (la sesion de sistema del backend corre con ese rol sin usuario). anon NO tiene execute. Doble puerta como la 081/082, via
--    cfo_resolver_sucursales: usuario owner/admin con alcance a CADA sucursal pedida (handoff_actor_en_sucursal) o sistema (auth.uid() nulo) con
--    sucursales de la organizacion declarada; sucursal ajena o inexistente = 42501; staff, repartidor y otra organizacion no pasan. El alcance se
--    resuelve ANTES de leer cfo_config (la configuracion de otra organizacion nunca se toca).
--  * Limites de parametros = los CHECK de cfo_config (083): frecuente_n 1..20, frecuente_dias 30..365, dormido 7..365 (el rango de activo_dias),
--    p_muestra 0..50, p_dias 14..365 (22023 fuera de ellos). El rango consultado nunca pasa de 365 dias (< 400 de cfo_validar_rango).
--  * cfo_pedidos_detalle: mismos permisos que la 081 (`revoke all from public, anon`, `grant execute to authenticated`) y mismas guardas; el DROP
--    FUNCTION quita los GRANT anteriores y aqui se otorgan de nuevo. Sigue sin PII (alias de 8 caracteres).
--  * sr_resumen_leer: mismos permisos y guardas que la 083 (cfo_resolver_alcance; lectura SOLO de sr_resumen_dia vigente).
--  * Rendimiento: las CTE que se consumen mas de una vez van `as materialized`; no se llama voz_zona_horaria/dia_negocio por pedido (se usan
--    cfo_venta_lean y cfo_pedidos_base, que resuelven zona y corte una vez por sucursal).
--
-- Compatibilidad con una base sin migrar: las dos funciones nuevas dan 42883 antes de aplicar esta migracion (el TypeScript degrada con SAVEPOINT);
-- cfo_pedidos_detalle y sr_resumen_leer siguen respondiendo con la forma anterior (sin es_venta / forma_pago) hasta que se aplique. Idempotente
-- (DROP FUNCTION IF EXISTS con la firma exacta + create or replace + revoke/grant); aplicarla dos veces no cambia nada.

-- ---------------------------------------------------------------------------
-- 1) cfo_clientes_frecuentes_dormidos
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_clientes_frecuentes_dormidos(
  p_org uuid,
  p_props uuid[],
  p_hasta date,
  p_frecuente_n integer default null,
  p_frecuente_dias integer default null,
  p_dormido_dias integer default 30,
  p_muestra integer default 0
) returns table (
  property_id uuid,
  alcance text,
  frecuente_n integer,
  frecuente_dias integer,
  dormido_dias integer,
  frecuentes bigint,
  frecuentes_dormidos bigint,
  pedidos_ventana bigint,
  neta_ventana_centavos bigint,
  muestra jsonb
)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
  v_cfg restaurantes.cfo_config;
  v_n integer;
  v_dias integer;
begin
  v_props := restaurantes.cfo_resolver_sucursales(p_org, p_props);
  select * into v_cfg from restaurantes.cfo_config_efectiva(p_org);
  v_n := coalesce(p_frecuente_n, v_cfg.frecuente_n);
  v_dias := coalesce(p_frecuente_dias, v_cfg.frecuente_dias);
  if v_n < 1 or v_n > 20
     or v_dias < 30 or v_dias > 365
     or p_dormido_dias is null or p_dormido_dias < 7 or p_dormido_dias > 365
     or p_muestra is null or p_muestra < 0 or p_muestra > 50 then
    raise exception 'cfo_clientes_frecuentes_dormidos: parametros invalidos' using errcode = '22023';
  end if;
  if p_hasta is null then
    raise exception 'cfo: rango de fechas invalido' using errcode = '22023';
  end if;
  perform restaurantes.cfo_validar_rango(p_hasta - v_dias + 1, p_hasta);
  return query
    with b as materialized (
      select l.property_id, l.customer_id, l.dia_negocio as dia, l.neta_centavos as neta
        from restaurantes.cfo_venta_lean(p_org, v_props, p_hasta - v_dias + 1, p_hasta) l
       where l.customer_id is not null
    ),
    -- Una fila por (cliente, sucursal) y una por cliente en el conjunto (g = 1).
    agg as materialized (
      select b.customer_id, b.property_id, grouping(b.property_id) as g,
             count(*) as n, max(b.dia) as ultimo, coalesce(sum(b.neta), 0)::bigint as neta
        from b
       group by grouping sets ((b.customer_id, b.property_id), (b.customer_id))
    ),
    fr as materialized (
      select a.customer_id, a.property_id, a.g, a.n, a.ultimo, a.neta, (p_hasta - a.ultimo >= p_dormido_dias) as dormido
        from agg a
       where a.n >= v_n
    ),
    tot as (
      select f.property_id, f.g,
             count(*) as frec,
             count(*) filter (where f.dormido) as dorm,
             coalesce(sum(f.n) filter (where f.dormido), 0)::bigint as ped,
             coalesce(sum(f.neta) filter (where f.dormido), 0)::bigint as neta
        from fr f
       group by f.property_id, f.g
    ),
    mu as (
      select m.property_id, m.g,
             jsonb_agg(jsonb_build_object(
               'alias', left(encode(sha256(convert_to(m.customer_id::text, 'UTF8')), 'hex'), 8),
               'pedidos', m.n, 'dias_sin_pedir', p_hasta - m.ultimo, 'neta_centavos', m.neta) order by m.rn) as j
        from (select f.*, row_number() over (partition by f.g, f.property_id order by f.n desc, f.neta desc, f.customer_id) as rn
                from fr f where f.dormido) m
       where m.rn <= p_muestra
       group by m.property_id, m.g
    ),
    ren as (
      select u.pid as property_id, 0 as g from unnest(v_props) as u(pid)
      union all
      select null::uuid, 1
    )
    select r.property_id,
           case when r.g = 0 then 'sucursal' else 'conjunto' end,
           v_n, v_dias, p_dormido_dias,
           coalesce(t.frec, 0)::bigint,
           coalesce(t.dorm, 0)::bigint,
           coalesce(t.ped, 0)::bigint,
           coalesce(t.neta, 0)::bigint,
           coalesce(m.j, '[]'::jsonb)
      from ren r
      left join tot t on t.g = r.g and t.property_id is not distinct from r.property_id
      left join mu m on m.g = r.g and m.property_id is not distinct from r.property_id
     order by r.g, r.property_id;
end;
$$;
revoke all on function restaurantes.cfo_clientes_frecuentes_dormidos(uuid, uuid[], date, integer, integer, integer, integer) from public, anon;
grant execute on function restaurantes.cfo_clientes_frecuentes_dormidos(uuid, uuid[], date, integer, integer, integer, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 2) cfo_descuento_p90
-- ---------------------------------------------------------------------------
create or replace function restaurantes.cfo_descuento_p90(
  p_org uuid,
  p_props uuid[],
  p_hasta date,
  p_dias integer default 90
) returns table (
  property_id uuid,
  alcance text,
  dias integer,
  desde date,
  hasta date,
  dias_con_venta bigint,
  p90_pct numeric
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
  if p_dias is null or p_dias < 14 or p_dias > 365 then
    raise exception 'cfo_descuento_p90: dias invalidos' using errcode = '22023';
  end if;
  if p_hasta is null then
    raise exception 'cfo: rango de fechas invalido' using errcode = '22023';
  end if;
  perform restaurantes.cfo_validar_rango(p_hasta - p_dias + 1, p_hasta);
  return query
    with d as materialized (
      select b.property_id, b.dia_negocio as dia,
             sum(b.desc_centavos)::bigint as descuento, sum(b.bruta_centavos)::bigint as bruta
        from restaurantes.cfo_pedidos_base(p_org, v_props, p_hasta - p_dias + 1, p_hasta) b
       where b.es_venta
       group by b.property_id, b.dia_negocio
    ),
    dc as materialized (
      select d.property_id, d.dia, d.descuento, d.bruta from d
      union all
      select null::uuid, d.dia, sum(d.descuento)::bigint, sum(d.bruta)::bigint from d group by d.dia
    ),
    p as (
      select dc.property_id,
             count(*) as n,
             percentile_cont(0.9) within group (order by (dc.descuento * 100.0 / dc.bruta)::float8) as p90
        from dc
       where dc.bruta > 0
       group by dc.property_id
    ),
    ren as (
      select u.pid as property_id, 0 as g from unnest(v_props) as u(pid)
      union all
      select null::uuid, 1
    )
    select r.property_id,
           case when r.g = 0 then 'sucursal' else 'conjunto' end,
           p_dias, p_hasta - p_dias + 1, p_hasta,
           coalesce(x.n, 0)::bigint,
           case when coalesce(x.n, 0) >= 14 then round(x.p90::numeric, 2) end
      from ren r
      left join p x on x.property_id is not distinct from r.property_id
     order by r.g, r.property_id;
end;
$$;
revoke all on function restaurantes.cfo_descuento_p90(uuid, uuid[], date, integer) from public, anon;
grant execute on function restaurantes.cfo_descuento_p90(uuid, uuid[], date, integer) to authenticated;

-- ---------------------------------------------------------------------------
-- 3) cfo_pedidos_detalle: agrega es_venta (DROP + CREATE; la ultima definicion es esta)
-- ---------------------------------------------------------------------------
-- El tipo de retorno cambia (columna nueva al final), asi que `create or replace` no basta. Entrada, filtros, cursor, topes y orden: IGUALES a la 081.
drop function if exists restaurantes.cfo_pedidos_detalle(uuid, uuid[], date, date, jsonb, integer, text, integer);
create function restaurantes.cfo_pedidos_detalle(
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
  cursor_pagina text,
  es_venta boolean
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
           to_char(b.dia_negocio, 'YYYY-MM-DD') || '|' || b.order_number::text,
           b.es_venta
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
-- 4) sr_resumen_leer: agrega forma_pago (DROP + CREATE; la ultima definicion es esta)
-- ---------------------------------------------------------------------------
-- Mismas columnas y orden que la 083 y `forma_pago` al final. El renglon se parte por forma de pago (null = el archivo no la traia); la suma por
-- (sucursal, dia, tipo_servicio) de cada columna es identica a la de la 083.
drop function if exists restaurantes.sr_resumen_leer(uuid, uuid[], date, date);
create function restaurantes.sr_resumen_leer(p_organization_id uuid, p_props uuid[], p_desde date, p_hasta date)
returns table (property_id uuid, dia_negocio date, tipo_servicio text, tickets bigint, bruta_centavos bigint, descuento_centavos bigint,
               cancelado_centavos bigint, propina_centavos bigint, iva_centavos bigint, neta_centavos bigint, forma_pago text)
language plpgsql
stable
security definer
set search_path = restaurantes, core, pg_temp
as $$
#variable_conflict use_column
declare
  v_props uuid[];
begin
  perform restaurantes.cfo_validar_rango(p_desde, p_hasta);
  select a.props into v_props from restaurantes.cfo_resolver_alcance(p_organization_id, p_props) a;
  return query
    select r.property_id, r.dia_negocio, r.tipo_servicio, sum(r.tickets)::bigint, sum(r.bruta_centavos)::bigint, sum(r.descuento_centavos)::bigint,
           sum(r.cancelado_centavos)::bigint, sum(r.propina_centavos)::bigint,
           case when bool_and(r.iva_centavos is not null) then sum(r.iva_centavos)::bigint end,
           sum(r.neta_centavos)::bigint,
           r.forma_pago
      from restaurantes.sr_resumen_dia r
     where r.organization_id = p_organization_id and r.estado = 'vigente' and r.property_id = any (v_props)
       and r.dia_negocio between p_desde and p_hasta
     group by r.property_id, r.dia_negocio, r.tipo_servicio, r.forma_pago
     order by r.property_id, r.dia_negocio, r.tipo_servicio, r.forma_pago nulls first;
end;
$$;
revoke all on function restaurantes.sr_resumen_leer(uuid, uuid[], date, date) from public, anon;
grant execute on function restaurantes.sr_resumen_leer(uuid, uuid[], date, date) to authenticated;

-- Comentarios.
comment on function restaurantes.cfo_clientes_frecuentes_dormidos(uuid, uuid[], date, integer, integer, integer, integer) is 'CFO: clientes frecuentes (N pedidos en X dias, de cfo_config) con >= M dias sin pedir, por sucursal y del conjunto (no aditivo); muestra opcional con alias hash.';
comment on function restaurantes.cfo_descuento_p90(uuid, uuid[], date, integer) is 'CFO: percentil 90 del descuento % diario de los ultimos p_dias dias, por sucursal y del conjunto; null con menos de 14 dias con venta.';
comment on function restaurantes.cfo_pedidos_detalle(uuid, uuid[], date, date, jsonb, integer, text, integer) is 'CFO: drill-down de pedidos sin PII, filtros de lista cerrada, tope 200 y cursor; incluye es_venta (084).';
comment on function restaurantes.sr_resumen_leer(uuid, uuid[], date, date) is 'SR: resumen vigente por sucursal, dia, tipo de servicio y forma de pago (084).';
