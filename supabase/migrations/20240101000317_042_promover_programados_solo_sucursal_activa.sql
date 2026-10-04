-- Promocion de pedidos programados: una sucursal DESACTIVADA ya no manda sus programados a cocina.
-- Prefijo de supabase/migrations: 20240101000317 (interno restaurantes 042).
-- Requiere: 034 (restaurantes.promover_pedidos_programados y orders.programado_para) y 001 (core.property.status).
--
-- Defecto (QA R1 caos-17, disponibilidad): entre la creacion de un pedido programado y su hora la sucursal puede darse de
-- baja (`core.property.status = 'inactive'`). La funcion de 034 promovia el pedido a `pending` de todos modos, asi que
-- entraba a cocina (y a la comanda del POS) de una sucursal cerrada, sin avisar al equipo ni al cliente.
--
-- Que cambia: SOLO el predicado de `candidatos`: se agrega `exists (core.property ... status = 'active')`. El pedido de
-- una sucursal inactiva se queda en `programado` (sigue visible en la lista de programados del panel, donde el equipo lo
-- cancela o lo reasigna) y NUNCA se promueve en silencio. Si la sucursal se reactiva antes de la hora, se promueve con
-- normalidad en la siguiente corrida. Todo lo demas (firma, retorno, locking `for update skip locked`, limite de 1000,
-- reloj de sistema vs. staff) es identico a 034.
--
-- Seguridad (nada nuevo se abre):
--   * Misma firma, mismo `security definer` con `set search_path = restaurantes, core, pg_temp`, mismos revoke/grant que 034
--     (revoke a public y anon; execute solo a authenticated y service_role). Se repiten porque `create or replace` conserva
--     los permisos, y asi el archivo deja explicito que no se amplian.
--   * Sigue exigiendo membresia del llamante cuando auth.uid() no es nulo y que organizacion nula (barrido global) solo la
--     use el sistema. La subconsulta lee core.property por id de la propia fila candidata: no expone datos de otra
--     organizacion (la funcion solo devuelve los pedidos que promueve, como antes).
--   * Cero GRANT nuevos, cero politicas nuevas, ningun `using (true)`.
-- Compatibilidad con la base sin migrar: el codigo TypeScript de esta rama NO depende de esta migracion (antes de aplicarla
-- el comportamiento es el de 034; el panel ademas filtra por sucursales activas en TypeScript).

create or replace function restaurantes.promover_pedidos_programados(
  p_organization_id uuid,
  p_now timestamptz default null,
  p_anticipacion_min integer default 30,
  p_property_ids uuid[] default null
) returns jsonb
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
declare
  v_es_sistema boolean := auth.uid() is null;
  v_now timestamptz;
  v_anticipacion integer := least(greatest(coalesce(p_anticipacion_min, 30), 0), 1440);
  v_promovidos jsonb;
begin
  if not v_es_sistema then
    if p_organization_id is null
       or not exists (
         select 1 from core.membership m
         where m.organization_id = p_organization_id and m.user_id = auth.uid()
       ) then
      raise exception 'promover_pedidos_programados: sin acceso a esta organización' using errcode = '42501';
    end if;
    v_now := now();
  else
    v_now := coalesce(p_now, now());
  end if;

  with candidatos as (
    select o.id
    from restaurantes.orders o
    where o.status = 'programado'
      and (p_organization_id is null or o.organization_id = p_organization_id)
      and (p_property_ids is null or o.property_id = any (p_property_ids))
      and o.programado_para <= v_now + make_interval(mins => v_anticipacion)
      -- 042: una sucursal desactivada no manda pedidos a cocina; el programado se queda para que el equipo lo atienda.
      and exists (select 1 from core.property p where p.id = o.property_id and p.status = 'active')
    order by o.programado_para
    limit 1000
    for update of o skip locked
  ),
  promovidos as (
    update restaurantes.orders o
    set status = 'pending', promovido_at = v_now
    from candidatos c
    where o.id = c.id and o.status = 'programado'
    returning o.*
  )
  select coalesce(jsonb_agg(to_jsonb(p) order by p.programado_para), '[]'::jsonb) into v_promovidos from promovidos p;

  return v_promovidos;
end;
$$;

revoke all on function restaurantes.promover_pedidos_programados(uuid, timestamptz, integer, uuid[]) from public, anon;
grant execute on function restaurantes.promover_pedidos_programados(uuid, timestamptz, integer, uuid[]) to authenticated, service_role;
