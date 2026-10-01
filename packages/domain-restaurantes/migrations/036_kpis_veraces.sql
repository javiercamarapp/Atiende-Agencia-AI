-- R-30 (PM): KPIs con rotulo veraz. Corrige DEFINICIONES de los agregados de 006_kpi_aggregates.sql, que
-- inflaban cifras que el panel mostraba como "ventas" / "ingresos generados por IA":
--
--   1. Los ingresos sumaban pedidos CANCELADOS (un pedido cancelado no es dinero cobrado). Ahora toda suma de
--      dinero (`revenue`, `total_revenue`, `*_revenue`, ticket promedio) excluye `status = 'cancelado'`.
--   2. "Clientes" de un tramo se contaban por `customer_name` (dos personas llamadas "Juan" eran una, y una
--      misma persona con dos grafias eran dos). Ahora se cuentan por `customer_id` (la tabla de clientes ya
--      deduplica por telefono); `createOrder` siempre vincula el pedido a un cliente.
--   3. `orders_channel_stats` no tenia periodo: siempre era "todo el historico" aunque el panel mostrara
--      7/30/90 dias. Se agrega la variante con periodo `orders_channel_stats_periodo` (la de 2 argumentos se
--      conserva, solo con ingresos sin cancelados, para el codigo desplegado antes de esta migracion).
--
-- Compatibilidad: ninguna firma existente cambia (`create or replace` con los MISMOS argumentos y columnas de
-- retorno); solo se AGREGA `orders_channel_stats_periodo`. El codigo TypeScript la llama dentro de un SAVEPOINT y
-- cae a la funcion de 2 argumentos si la base aun no tiene esta migracion (rotulo "todo el tiempo").
--
-- JUSTIFICACION DE SEGURIDAD (cada funcion / GRANT):
--   * Las cuatro funciones son SECURITY INVOKER con `set search_path = restaurantes` (no elevan privilegios):
--     corren con la RLS de `restaurantes.orders`/`customers` del rol que llama (staff de ESA organizacion), igual
--     que en 006. Un staff de otra organizacion que pase un `p_organization_id` ajeno recibe 0 filas (RLS), nunca
--     datos de otro tenant. No hay `security definer`, por lo que no aplica el guard de `auth.uid()`.
--   * `grant execute ... to authenticated` solo para la funcion NUEVA (misma firma de acceso que las otras de
--     006); `anon` y `public` no reciben nada: se hace `revoke` explicito. Las funciones reemplazadas conservan
--     el GRANT de 006 (`create or replace` no lo toca).
--   * No se agregan tablas, columnas, policies ni GRANT de tabla.

-- 1) orders_bucketed_stats: ventas netas (sin cancelados) y clientes por id.
create or replace function restaurantes.orders_bucketed_stats(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_bucket_starts timestamptz[],
  p_bucket_ends timestamptz[]
)
returns table(idx int, revenue numeric, order_count bigint, customer_count bigint)
language sql
stable
security invoker
set search_path = restaurantes
as $$
  select
    b.idx,
    coalesce(sum(o.total), 0) as revenue,
    count(o.id) as order_count,
    -- Por customer_id (no por nombre): dos clientes con el mismo nombre son dos clientes.
    count(distinct o.customer_id) as customer_count
  from unnest(p_bucket_starts, p_bucket_ends) with ordinality as b(bucket_start, bucket_end, idx)
  left join restaurantes.orders o
    on o.organization_id = p_organization_id
    and o.status <> 'cancelado'
    and (p_property_ids is null or o.property_id = any(p_property_ids))
    and o.created_at >= b.bucket_start
    and o.created_at < b.bucket_end
  group by b.idx
  order by b.idx;
$$;

-- 2) orders_channel_stats (sin periodo): mismos 10 campos; los ingresos ya no incluyen cancelados. Los conteos
--    de pedidos SI incluyen cancelados (se reportan aparte en `*_cancelled`).
create or replace function restaurantes.orders_channel_stats(
  p_organization_id uuid,
  p_property_ids uuid[]
)
returns table(
  total_orders bigint,
  total_revenue numeric,
  voice_orders bigint,
  voice_completed bigint,
  voice_cancelled bigint,
  voice_revenue numeric,
  whatsapp_orders bigint,
  whatsapp_completed bigint,
  whatsapp_cancelled bigint,
  whatsapp_revenue numeric
)
language sql
stable
security invoker
set search_path = restaurantes
as $$
  select
    count(*),
    coalesce(sum(total) filter (where status <> 'cancelado'), 0),
    count(*) filter (where source = 'voice'),
    count(*) filter (where source = 'voice' and status in ('completado', 'entregado')),
    count(*) filter (where source = 'voice' and status = 'cancelado'),
    coalesce(sum(total) filter (where source = 'voice' and status <> 'cancelado'), 0),
    count(*) filter (where source = 'whatsapp'),
    count(*) filter (where source = 'whatsapp' and status in ('completado', 'entregado')),
    count(*) filter (where source = 'whatsapp' and status = 'cancelado'),
    coalesce(sum(total) filter (where source = 'whatsapp' and status <> 'cancelado'), 0)
  from restaurantes.orders
  where organization_id = p_organization_id
    and (p_property_ids is null or property_id = any(p_property_ids));
$$;

-- 3) orders_channel_stats_periodo: lo mismo acotado a [p_start, p_end) por `created_at`.
create or replace function restaurantes.orders_channel_stats_periodo(
  p_organization_id uuid,
  p_property_ids uuid[],
  p_start timestamptz,
  p_end timestamptz
)
returns table(
  total_orders bigint,
  total_revenue numeric,
  voice_orders bigint,
  voice_completed bigint,
  voice_cancelled bigint,
  voice_revenue numeric,
  whatsapp_orders bigint,
  whatsapp_completed bigint,
  whatsapp_cancelled bigint,
  whatsapp_revenue numeric
)
language sql
stable
security invoker
set search_path = restaurantes
as $$
  select
    count(*),
    coalesce(sum(total) filter (where status <> 'cancelado'), 0),
    count(*) filter (where source = 'voice'),
    count(*) filter (where source = 'voice' and status in ('completado', 'entregado')),
    count(*) filter (where source = 'voice' and status = 'cancelado'),
    coalesce(sum(total) filter (where source = 'voice' and status <> 'cancelado'), 0),
    count(*) filter (where source = 'whatsapp'),
    count(*) filter (where source = 'whatsapp' and status in ('completado', 'entregado')),
    count(*) filter (where source = 'whatsapp' and status = 'cancelado'),
    coalesce(sum(total) filter (where source = 'whatsapp' and status <> 'cancelado'), 0)
  from restaurantes.orders
  where organization_id = p_organization_id
    and (p_property_ids is null or property_id = any(p_property_ids))
    and created_at >= p_start
    and created_at < p_end;
$$;

revoke all on function restaurantes.orders_channel_stats_periodo(uuid, uuid[], timestamptz, timestamptz) from public, anon;
grant execute on function restaurantes.orders_channel_stats_periodo(uuid, uuid[], timestamptz, timestamptz) to authenticated;

-- 4) get_customer_overview_kpis: el ticket promedio ya no promedia pedidos cancelados. Resto identico a 006.
create or replace function restaurantes.get_customer_overview_kpis(p_organization_id uuid)
returns table(
  total_customers bigint,
  -- null cuando la organización no tiene ningún pedido todavía (avg() de un conjunto
  -- vacío ya es null en Postgres — nunca se envuelve en coalesce(...,0), que
  -- fingiría un ticket promedio de $0).
  average_order_value numeric,
  customers_with_orders bigint,
  recurring_customers bigint,
  top_customer_id uuid,
  top_customer_name text,
  top_customer_phone text,
  top_customer_order_count integer,
  avg_days_since_last_order numeric
)
language sql
stable
security invoker
set search_path = restaurantes
as $$
  with clientes as (
    select * from restaurantes.customers where organization_id = p_organization_id
  ),
  -- avg_days_since_last_order se calcula desde MAX(orders.created_at) por cliente, no
  -- desde `customers.last_order_at` — esa columna existe en el schema (migrations/001)
  -- pero ningún caso de negocio la escribe todavía (gap real preexistente, fuera de
  -- alcance de Fase 3 arreglar la escritura); calcularlo desde orders da el mismo
  -- resultado sin depender de una columna que nadie mantiene.
  ultimo_pedido as (
    select customer_id, max(created_at) as last_order_at
    from restaurantes.orders
    where organization_id = p_organization_id and customer_id is not null
    group by customer_id
  ),
  -- Empate en pedidos: gana el cliente creado más recientemente (mismo criterio que
  -- ClientesSection.tsx, que itera su lista `created_at desc` con comparación
  -- estricta ">").
  top as (
    select id, name, phone, order_count
    from clientes
    where order_count > 0
    order by order_count desc, created_at desc
    limit 1
  )
  select
    (select count(*) from clientes),
    (select avg(total) from restaurantes.orders where organization_id = p_organization_id and status <> 'cancelado'),
    (select count(*) from clientes where order_count > 0),
    (select count(*) from clientes where order_count > 1),
    (select id from top),
    (select name from top),
    (select phone from top),
    (select order_count from top),
    (select avg(extract(epoch from (now() - last_order_at)) / 86400) from ultimo_pedido);
$$;
