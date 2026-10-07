// SQL de SOLO LECTURA del catalogo de "Chatea con tus datos" de restaurantes. Una constante por
// herramienta, todas parametrizadas ($1..$6, nunca interpolacion) y con la MISMA forma de alcance:
//   $1 organizacion · $2 sucursales permitidas (uuid[] | null = todas) · $3 inicio (inclusive)
//   $4 fin (exclusivo) · $5 zona horaria IANA (solo las consultas que agrupan por hora/dia local;
//   en las demas $5 es el tope de filas) · $6 tope de filas (solo las consultas con zona horaria)
//
// Seguridad (ver docs/DATA-CHAT.md):
//  - Corren con la sesion RLS DEL USUARIO (rol authenticated + auth.uid()): la policy de
//    restaurantes.orders limita a su organizacion y el JOIN con core.property (policy
//    `has_property_access`) limita a las sucursales de su membership -- defensa en profundidad
//    ademas del filtro `$2` que fija el servidor.
//  - Nunca devuelven nombre/telefono/direccion de comensales: solo agregados.
//  - Excluyen de ventas los pedidos cancelados, `no_recogido` (comida no cobrada), `programado` (aun no es venta;
//    al promoverse pasa a pending y cuenta) y `por_aprobar` (retenido sin aprobar: no es venta hasta que se aprueba).
//    Ver QA-restaurantes-R1-viaje-09 y QA-restaurantes-R2-viaje-03/04. El dia de un pedido es `coalesce(promovido_at, created_at)`.
//  - tests/data-chat-sql-drift.spec.ts exige que estos textos aparezcan identicos en
//    scripts/verify-data-chat/assertions.sql (el verify los corre contra Postgres real).

/** Momento en que el pedido cuenta como venta del dia: un programado cuenta el dia en que se promueve, no el que se agendo
 *  (igual que el Cierre del dia; QA R2 viaje-03). `promovido_at` es de la migracion 034: contra la base sin migrar el lector
 *  reintenta con `FECHA_PEDIDO_LEGADA`. */
export const FECHA_PEDIDO = "coalesce(o.promovido_at, o.created_at)";
export const FECHA_PEDIDO_LEGADA = "o.created_at";

const SCOPE = `o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and ${FECHA_PEDIDO} >= $3 and ${FECHA_PEDIDO} < $4`;

export const SQL_VISIBLE_BRANCHES = `select p.id as property_id, p.name, bd.slug
   from core.property p
   join restaurantes.branch_detail bd on bd.property_id = p.id
   where p.organization_id = $1 and p.status = 'active' and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by bd.display_order asc, p.name asc
   limit 100`;

// $7 = unidad de agrupacion ('day' | 'week' | 'month'): la elige el CODIGO (por la longitud del periodo),
// nunca el modelo, y date_trunc la recibe como parametro, no concatenada.
export const SQL_SALES_BY_PERIOD = `select to_char(date_trunc($7::text, ${FECHA_PEDIDO} at time zone $5::text)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where ${SCOPE} and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by 1 limit $6`;

export const SQL_SALES_BY_BRANCH = `select p.name as branch, coalesce(sum(o.total), 0) as revenue, count(*) as orders
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where ${SCOPE} and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by p.id, p.name order by revenue desc, p.name limit $5`;

const PRODUCTS = (order: string) => `select it->>'name' as product,
    coalesce(sum((it->>'quantity')::numeric), 0) as quantity,
    coalesce(sum((it->>'quantity')::numeric * (it->>'price')::numeric), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  cross join lateral jsonb_array_elements(case when jsonb_typeof(o.items) = 'array' then o.items else '[]'::jsonb end) as it
  where ${SCOPE} and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    and (it->>'quantity') ~ '^[0-9]+(\\.[0-9]+)?$' and (it->>'price') ~ '^[0-9]+(\\.[0-9]+)?$' and (it->>'name') is not null
  group by 1 order by ${order} desc, 1 limit $5`;
export const SQL_TOP_PRODUCTS_BY_QUANTITY = PRODUCTS("quantity");
export const SQL_TOP_PRODUCTS_BY_REVENUE = PRODUCTS("revenue");

export const SQL_ORDER_STATS = `select count(*) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')) as orders,
    coalesce(sum(o.total) filter (where o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')), 0) as revenue,
    count(*) filter (where o.status = 'cancelado') as cancelled
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where ${SCOPE}
  limit $5`;

export const SQL_ORDERS_BY_CHANNEL = `select o.source as channel, count(*) as orders, coalesce(sum(o.total), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where ${SCOPE} and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by o.source order by orders desc, o.source limit $5`;

export const SQL_PEAK_HOURS = `select extract(hour from (${FECHA_PEDIDO} at time zone $5::text))::int as hour, count(*) as orders,
    coalesce(sum(o.total), 0) as revenue
  from restaurantes.orders o
  join core.property p on p.id = o.property_id
  where ${SCOPE} and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  group by 1 order by orders desc, hour limit $6`;

// Cliente = customer_id si existe, si no el telefono: la clave NUNCA sale de la consulta, solo conteos.
export const SQL_RECURRING_CUSTOMERS = `with in_period as (
    select coalesce(o.customer_id::text, o.customer_phone) as ckey, count(*) as n
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where ${SCOPE} and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
    group by 1
  ), before_period as (
    select distinct coalesce(o.customer_id::text, o.customer_phone) as ckey
    from restaurantes.orders o
    join core.property p on p.id = o.property_id
    where o.organization_id = $1 and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
      and ${FECHA_PEDIDO} < $3 and o.status not in ('cancelado', 'no_recogido', 'programado', 'por_aprobar')
  )
  select count(*) as customers,
    count(*) filter (where i.n >= 2 or b.ckey is not null) as recurring,
    count(*) filter (where i.n < 2 and b.ckey is null) as new_customers
  from in_period i left join before_period b on b.ckey = i.ckey
  limit $5`;

// Promociones: configuracion de la organizacion (no depende de periodo ni sucursal).
export const SQL_PROMOTIONS = `select pr.code, pr.name, pr.type, pr.value, pr.is_active, pr.times_used, pr.max_uses, pr.starts_at, pr.ends_at
  from restaurantes.promotions pr
  where pr.organization_id = $1
  order by pr.is_active desc, pr.times_used desc, pr.code
  limit $2`;

export const ALL_DATA_CHAT_SQL: Readonly<Record<string, string>> = {
  SQL_VISIBLE_BRANCHES,
  SQL_SALES_BY_PERIOD,
  SQL_SALES_BY_BRANCH,
  SQL_TOP_PRODUCTS_BY_QUANTITY,
  SQL_TOP_PRODUCTS_BY_REVENUE,
  SQL_ORDER_STATS,
  SQL_ORDERS_BY_CHANNEL,
  SQL_PEAK_HOURS,
  SQL_RECURRING_CUSTOMERS,
  SQL_PROMOTIONS,
};
