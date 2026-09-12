-- Fase 3 restaurantes — agregados de KPIs para las primeras rutas de staff
-- autenticado del vertical (ver diseño Fase 3 §2). Puerto ADAPTADO (no textual) de
-- restaurantes/supabase/migrations/20260903160000_orders_bucketed_stats_rpc.sql y
-- 20260904056000_admin_channel_stats.sql: `restaurant_id` -> `organization_id`,
-- `branch_id`/`branch` (texto) -> `property_id` (uuid real, ver migrations/001), y se
-- agrega un filtro `p_property_ids uuid[]` (null = sin restricción) en vez del
-- `p_branch_id uuid` singular del origen — necesario porque fusion sí tiene el
-- concepto de membership acotada a un subconjunto de properties (ver
-- apps/api/src/routes/verticals/restaurantes/admin-kpis.ts), que el origen (un solo
-- tenant, sin ese concepto) nunca necesitó. Tampoco se porta el hack
-- `customer_phone not ilike 'widget-%'` del origen — fusion no tiene ese widget de
-- prueba (ver diseño §2).
--
-- SECURITY INVOKER en las 5 funciones, a propósito: corren con los mismos permisos/RLS
-- del rol que invoca (staff autenticado vía `dbSession`/`requirePropertyMembership`,
-- ver @atiende/core-auth), nunca elevan privilegios — mismo criterio que
-- `calc_customer_tier` (migrations/002) y las funciones portadas del origen.

-- orders_bucketed_stats — suma/cuenta pedidos por tramo de fecha en Postgres (Tus
-- ventas/Tendencias). Un tramo por posición del arreglo, `idx` 1-based por `with
-- ordinality` (igual que el origen) — el caller (kpis.ts) concatena en una sola
-- llamada los tramos de tendencia + la ventana actual + la ventana previa de
-- comparación, para evitar N round-trips.
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
    -- Cuenta por customer_name (no customer_id): mismo criterio literal que el
    -- origen — un pedido sin cliente vinculado (customer_id null, ej. checkout web
    -- de un cliente nuevo) sigue contando por nombre.
    count(distinct o.customer_name) as customer_count
  from unnest(p_bucket_starts, p_bucket_ends) with ordinality as b(bucket_start, bucket_end, idx)
  left join restaurantes.orders o
    on o.organization_id = p_organization_id
    and (p_property_ids is null or o.property_id = any(p_property_ids))
    and o.created_at >= b.bucket_start
    and o.created_at < b.bucket_end
  group by b.idx
  order by b.idx;
$$;

comment on function restaurantes.orders_bucketed_stats is
  'Suma/cuenta orders por tramo de fecha en Postgres, acotado opcionalmente a un '
  'subconjunto de properties (membership restringida) — evita bajar cada pedido al '
  'llamador (mismo fix real que 20260903160000_orders_bucketed_stats_rpc.sql del '
  'origen: con volumen real, sumar en el navegador chocaba en silencio con el límite '
  'de filas por respuesta de la API de datos).';

grant execute on function restaurantes.orders_bucketed_stats(uuid, uuid[], timestamptz[], timestamptz[]) to authenticated;

-- orders_channel_stats — desglose voz/whatsapp para "Impacto de tus agentes".
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
    coalesce(sum(total), 0),
    count(*) filter (where source = 'voice'),
    count(*) filter (where source = 'voice' and status in ('completado', 'entregado')),
    count(*) filter (where source = 'voice' and status = 'cancelado'),
    coalesce(sum(total) filter (where source = 'voice'), 0),
    count(*) filter (where source = 'whatsapp'),
    count(*) filter (where source = 'whatsapp' and status in ('completado', 'entregado')),
    count(*) filter (where source = 'whatsapp' and status = 'cancelado'),
    coalesce(sum(total) filter (where source = 'whatsapp'), 0)
  from restaurantes.orders
  where organization_id = p_organization_id
    and (p_property_ids is null or property_id = any(p_property_ids));
$$;

grant execute on function restaurantes.orders_channel_stats(uuid, uuid[]) to authenticated;

-- whatsapp_conversation_stats — mensajes promedio por conversación de WhatsApp.
create or replace function restaurantes.whatsapp_conversation_stats(
  p_organization_id uuid,
  p_property_ids uuid[]
)
returns table(total bigint, with_order bigint, average_messages numeric)
language sql
stable
security invoker
set search_path = restaurantes
as $$
  select
    count(*),
    count(*) filter (where order_id is not null),
    coalesce(avg(jsonb_array_length(messages)), 0)
  from restaurantes.whatsapp_conversations
  where organization_id = p_organization_id
    and (p_property_ids is null or property_id = any(p_property_ids));
$$;

grant execute on function restaurantes.whatsapp_conversation_stats(uuid, uuid[]) to authenticated;

-- get_customer_overview_kpis — NUEVO (el origen nunca lo movió a SQL: ClientesSection
-- .tsx bajaba TODOS los customers+orders al navegador para calcular esto — mismo
-- antipatrón que ya se corrigió para ventas allá, pero nunca para clientes). Mismas
-- fórmulas que ClientesSection.tsx líneas 314-334, agregadas en Postgres. Sin filtro
-- de property_ids: la memoria de cliente es por-organización, nunca por-sucursal (un
-- mismo cliente puede pedir a varias sucursales — ver diseño §2).
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
    (select avg(total) from restaurantes.orders where organization_id = p_organization_id),
    (select count(*) from clientes where order_count > 0),
    (select count(*) from clientes where order_count > 1),
    (select id from top),
    (select name from top),
    (select phone from top),
    (select order_count from top),
    (select avg(extract(epoch from (now() - last_order_at)) / 86400) from ultimo_pedido);
$$;

grant execute on function restaurantes.get_customer_overview_kpis(uuid) to authenticated;

-- calc_customer_tier_distribution — NUEVO. Reusa la MISMA fórmula de percentil
-- "mid-rank" y de selección de métrica que `calc_customer_tier` (migrations/002,
-- cortes ya corregidos a 95/90/70), pero calculada UNA vez para todos los clientes de
-- la organización (agrupa y cuenta por tier) en vez de tier-por-tier — evita terminar
-- reimplementando en fusion el mismo antipatrón client-side de ClientesSection.tsx.
create or replace function restaurantes.calc_customer_tier_distribution(p_organization_id uuid)
returns table(metric text, black bigint, platinum bigint, gold bigint, blue bigint, without_tier bigint)
language sql
stable
security invoker
set search_path = restaurantes
as $$
  with clientes as (
    select
      c.id,
      c.order_count,
      coalesce(g.gasto, 0) as gasto
    from restaurantes.customers c
    left join (
      select customer_id, sum(total) as gasto
      from restaurantes.orders
      where organization_id = p_organization_id and customer_id is not null
      group by customer_id
    ) g on g.customer_id = c.id
    where c.organization_id = p_organization_id
  ),
  meta as (
    select
      count(*) as n,
      count(*) filter (where gasto > 0) as con_gasto,
      count(*) filter (where order_count > 0) as con_frecuencia
    from clientes
  ),
  metrica as (
    select case
      when (select n from meta) = 0 then 'sin_datos'
      when (select con_gasto from meta) >= greatest(1, ceil((select n from meta)::numeric * 0.3)) then 'gasto'
      when (select con_frecuencia from meta) > 0 then 'frecuencia'
      else 'sin_datos'
    end as elegida
  ),
  valores as (
    select
      id,
      case (select elegida from metrica)
        when 'gasto' then gasto
        when 'frecuencia' then order_count::numeric
        else 0::numeric
      end as valor
    from clientes
  ),
  ranked as (
    select
      id,
      (rank() over (order by valor asc) - 1) as rank_min,
      count(*) over (partition by valor) as tie_count,
      count(*) over () as n
    from valores
  ),
  percentiles as (
    select
      id,
      case
        when n = 1 then 100::numeric
        else (((rank_min::numeric + rank_min + tie_count - 1) / 2.0) / (n - 1)) * 100
      end as percentil
    from ranked
  ),
  tiers as (
    select
      id,
      case
        when p.percentil >= 95 then 'BLACK'
        when p.percentil >= 90 then 'PLATINUM'
        when p.percentil >= 70 then 'GOLD'
        else 'BLUE'
      end as tier
    from percentiles p
  )
  select
    m.elegida,
    case when m.elegida = 'sin_datos' then 0 else (select count(*) from tiers where tier = 'BLACK') end,
    case when m.elegida = 'sin_datos' then 0 else (select count(*) from tiers where tier = 'PLATINUM') end,
    case when m.elegida = 'sin_datos' then 0 else (select count(*) from tiers where tier = 'GOLD') end,
    case when m.elegida = 'sin_datos' then 0 else (select count(*) from tiers where tier = 'BLUE') end,
    case when m.elegida = 'sin_datos' then (select n from meta) else 0 end
  from metrica m;
$$;

grant execute on function restaurantes.calc_customer_tier_distribution(uuid) to authenticated;
