-- F4c (revision de seguridad) -- el borrado de un producto con historial queda PROHIBIDO por la base, no solo por la API. Prefijo de supabase/migrations asignado: 20240101000484 (interno 184).
--
-- Que cierra (la 065 ya limito INSERT/UPDATE/DELETE de `products` a owner/admin con `actor_tiene_rol`, pero ese helper ignora `property_ids`):
--  1) DELETE exige alcance de TODA la organizacion (`actor_tiene_rol_en_alcance(org, null, owner/admin)`): un admin acotado a algunas sucursales ya no puede borrar el catalogo de toda la
--     organizacion saltandose la API.
--  2) Trigger BEFORE DELETE: si algun pedido de la organizacion trae el producto en `orders.items` (`[{"id": <uuid>, ...}]`), levanta 23503 y no borra nada; el camino es ARCHIVAR (180).
--     Aplica a cualquier rol, incluido service_role y SQL directo de un owner/admin: la integridad no depende de la API.
--  3) Limpieza de ids huerfanos: al borrar o archivar un producto se quita de `promotions.product_ids` y `courtesy_product_ids` (uuid[] sin FK). Si un arreglo se quedaria vacio, pasa a null
--     (CHECK de 027/031); una promocion de tipo cortesia exige ambos arreglos, asi que ahi se conserva el arreglo y la promocion se DESACTIVA (`is_active = false`) en vez de violar el CHECK.
--
-- Justificacion de seguridad:
--  * Las dos funciones son `security definer` con `search_path` fijo y `revoke all ... from public, anon`: leen `orders` y escriben `promotions` aunque la sesion que borra no tenga SELECT sobre
--    todos los pedidos ni UPDATE sobre promociones; solo las dispara el trigger de `products` (no se concede EXECUTE a nadie). Filtran SIEMPRE por la `organization_id` del producto afectado.
--  * La policy nueva reemplaza a "duenos y admins borran productos" (065) sin ampliar a nadie: es la misma condicion de rol y ademas exige `property_ids is null` en la membresia.
--  * Sin cambio para `anon` ni para la sesion de sistema (`actor_tiene_rol_en_alcance` devuelve false sin `auth.uid()`, igual que antes).
create or replace function restaurantes.promos_quitar_producto(p_organization_id uuid, p_product_id uuid)
returns void
language plpgsql
security definer
set search_path = restaurantes, pg_temp
as $$
begin
  update restaurantes.promotions p set
    product_ids = case
      when p.product_ids is null or not (p_product_id = any (p.product_ids)) then p.product_ids
      when cardinality(array_remove(p.product_ids, p_product_id)) > 0 then array_remove(p.product_ids, p_product_id)
      when p.type = 'cortesia' then p.product_ids
      else null
    end,
    courtesy_product_ids = case
      when p.courtesy_product_ids is null or not (p_product_id = any (p.courtesy_product_ids)) then p.courtesy_product_ids
      when cardinality(array_remove(p.courtesy_product_ids, p_product_id)) > 0 then array_remove(p.courtesy_product_ids, p_product_id)
      when p.type = 'cortesia' then p.courtesy_product_ids
      else null
    end,
    is_active = case
      when p.type = 'cortesia'
       and ((p.product_ids is not null and p_product_id = any (p.product_ids) and cardinality(array_remove(p.product_ids, p_product_id)) = 0)
         or (p.courtesy_product_ids is not null and p_product_id = any (p.courtesy_product_ids) and cardinality(array_remove(p.courtesy_product_ids, p_product_id)) = 0))
      then false
      else p.is_active
    end
  where p.organization_id = p_organization_id
    and ((p.product_ids is not null and p_product_id = any (p.product_ids)) or (p.courtesy_product_ids is not null and p_product_id = any (p.courtesy_product_ids)));
end;
$$;

create or replace function restaurantes.producto_proteger_historial()
returns trigger
language plpgsql
security definer
set search_path = restaurantes, core, pg_temp
as $$
begin
  if tg_op = 'DELETE' then
    -- Borrado en CASCADA de la organizacion (demo_limpiar, baja de cuenta): la fila de core.organization ya no existe cuando se dispara este trigger por fila. No hay
    -- historial que proteger (los pedidos se van con la organizacion) y actualizar promotions violaria su FK a la organizacion borrada. Un DELETE directo de un producto
    -- SIEMPRE ve su organizacion, asi que esta salida no abre el hueco que cierra el trigger.
    if not exists (select 1 from core.organization g where g.id = old.organization_id) then
      return old;
    end if;
    if exists (
      select 1 from restaurantes.orders o
       where o.organization_id = old.organization_id
         and jsonb_typeof(o.items) = 'array'
         and o.items @> jsonb_build_array(jsonb_build_object('id', old.id))
    ) then
      raise exception 'producto_con_historial: el producto % aparece en pedidos; archivalo en vez de borrarlo', old.id using errcode = '23503';
    end if;
    perform restaurantes.promos_quitar_producto(old.organization_id, old.id);
    return old;
  end if;
  -- UPDATE de archived_at (null -> valor): se quita de las promociones.
  perform restaurantes.promos_quitar_producto(new.organization_id, new.id);
  return new;
end;
$$;

revoke all on function restaurantes.promos_quitar_producto(uuid, uuid) from public, anon, authenticated;
revoke all on function restaurantes.producto_proteger_historial() from public, anon, authenticated;

drop trigger if exists products_proteger_historial_delete on restaurantes.products;
create trigger products_proteger_historial_delete
  before delete on restaurantes.products
  for each row execute function restaurantes.producto_proteger_historial();

drop trigger if exists products_archivar_limpia_promos on restaurantes.products;
create trigger products_archivar_limpia_promos
  after update of archived_at on restaurantes.products
  for each row when (old.archived_at is null and new.archived_at is not null)
  execute function restaurantes.producto_proteger_historial();

drop policy if exists "duenos y admins borran productos" on restaurantes.products;
create policy "duenos y admins de toda la organizacion borran productos" on restaurantes.products for delete
  using (restaurantes.actor_tiene_rol_en_alcance(organization_id, null, array['owner', 'admin']));
