-- Ported de restaurantes/supabase/migrations/20260903140000_customer_tier_percentile.sql
-- Cambia: schema `public.*` -> `restaurantes.*`, `restaurant_id` -> `organization_id`.
-- La lógica de percentil ("mid-rank") NO se rediseña — ya está resuelta correctamente
-- en el origen.
--
-- CORTES CORREGIDOS en Fase 3 restaurantes (diseño §1.4/§5): el port original de esta
-- función (Fase 1, commit de las 08:49am del 3-sep-2026) copió los cortes 90/75/35 de
-- `20260903140000_customer_tier_percentile.sql`. Pero el mismo día, a las 12:51pm, el
-- origen cambió esos cortes a 95/90/70 en `ClientesSection.tsx` (líneas 32-34: "Pedido
-- explícito de Javier: Black = top 5% ('elite'), Platinum = top 10%, Gold = top 30%")
-- — ese ajuste nunca se retro-portó a esta función SQL. Fase 3 pone "Distribución por
-- tier" en un dashboard visible (ver kpis.ts/calc_customer_tier_distribution), así que
-- se corrige aquí a 95/90/70 para que coincida con el criterio de negocio real y
-- vigente, no con el valor viejo que el port heredó por un desfase de horas.
create or replace function restaurantes.calc_customer_tier(p_organization_id uuid, p_customer_id uuid)
returns jsonb
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
  )
  select case
    when (select elegida from metrica) = 'sin_datos' then jsonb_build_object('tier', null, 'percentile', null)
    else coalesce(
      (
        select jsonb_build_object(
          'tier', case
            when p.percentil >= 95 then 'BLACK'
            when p.percentil >= 90 then 'PLATINUM'
            when p.percentil >= 70 then 'GOLD'
            else 'BLUE'
          end,
          'percentile', round(p.percentil, 2)
        )
        from percentiles p
        where p.id = p_customer_id
      ),
      jsonb_build_object('tier', null, 'percentile', null)
    )
  end;
$$;

grant execute on function restaurantes.calc_customer_tier(uuid, uuid) to authenticated, service_role;
