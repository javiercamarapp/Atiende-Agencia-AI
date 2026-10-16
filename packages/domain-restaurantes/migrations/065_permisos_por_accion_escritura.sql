-- PL-23 (restaurantes) -- permisos por ACCION en la base: solo owner/admin escriben precios, catalogo, promociones y datos de sucursal;
-- el `staff` (cajero/cocina) solo marca agotado/disponible EN SU sucursal. Prefijo de supabase/migrations: 20240101000370.
--
-- Contexto: la capa TypeScript (matriz de roles.ts + assertAccion) ya separa estas acciones. Hasta aqui las policies de escritura de
-- `categories`, `products`, `branch_products`, `branch_detail` y `promotions` solo pedian "existe una membresia de la organizacion"
-- (007/001/010), asi que una sesion SQL con el JWT de un `staff` (o de un repartidor) podia escribir precios y promociones por fuera de
-- la API. Esta migracion lleva a la base la misma regla. Es AUTOCONTENIDA: no depende de las funciones de la 064 (lote QA R1) y
-- coexiste con ella (si la 064 ya corrio, sus policies de escritura de estas cinco tablas se reemplazan por las de aqui, que ademas
-- exigen el rol owner/admin; si no corrio, se reemplazan las policies amplias de 007/001/010). Ningun GRANT nuevo se concede.
--
-- El codigo TypeScript sigue funcionando contra la base SIN migrar: el unico SQL nuevo del codigo es
-- `update restaurantes.branch_products set is_available ... where property_id/product_id`, que existe desde 001.
--
-- Quien conserva acceso (nada cambia): la sesion de SISTEMA (auth.uid() is null, rol authenticated: checkout, voz y WhatsApp) y
-- service_role. Las funciones auxiliares devuelven false (nunca error) cuando no hay auth.uid(), asi la sesion de sistema NO gana
-- escritura de staff por aqui; la escritura de sistema sigue entrando por las funciones security definer que ya existian.
--
-- 0) Funciones auxiliares (security definer, STABLE, search_path fijo, revoke de public/anon, execute solo a authenticated/service_role):
--    justificacion: `authenticated` no tiene SELECT sobre membresias ajenas, y centralizar la regla evita que cada policy la
--    reescriba distinto. Reciben la lista de roles permitidos para que la matriz viva en un solo sitio (los literales de abajo).

create or replace function restaurantes.actor_tiene_rol(p_organization_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m
     where m.user_id = auth.uid()
       and m.organization_id = p_organization_id
       and m.vertical_role = any (p_roles)
  );
$$;

-- Rol dentro de UNA sucursal: la membresia debe cubrirla (property_ids null = todas) y la sucursal debe ser de la organizacion.
create or replace function restaurantes.actor_tiene_rol_en_sucursal(p_property_id uuid, p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and p_property_id is not null and exists (
    select 1 from core.property p
      join core.membership m on m.organization_id = p.organization_id
     where p.id = p_property_id
       and m.user_id = auth.uid()
       and m.vertical_role = any (p_roles)
       and (m.property_ids is null or p_property_id = any (m.property_ids))
  );
$$;

-- Rol sobre un ALCANCE de sucursales (promociones): `p_property_ids` null = "toda la organizacion" y solo lo cubre una membresia sin
-- acotar; un arreglo solo lo cubre quien tiene TODAS esas sucursales.
create or replace function restaurantes.actor_tiene_rol_en_alcance(p_organization_id uuid, p_property_ids uuid[], p_roles text[])
returns boolean
language sql
stable
security definer
set search_path = core, pg_temp
as $$
  select auth.uid() is not null and exists (
    select 1 from core.membership m
     where m.user_id = auth.uid()
       and m.organization_id = p_organization_id
       and m.vertical_role = any (p_roles)
       and (m.property_ids is null or (p_property_ids is not null and p_property_ids <@ m.property_ids))
  );
$$;

revoke all on function restaurantes.actor_tiene_rol(uuid, text[]) from public, anon;
revoke all on function restaurantes.actor_tiene_rol_en_sucursal(uuid, text[]) from public, anon;
revoke all on function restaurantes.actor_tiene_rol_en_alcance(uuid, uuid[], text[]) from public, anon;
grant execute on function restaurantes.actor_tiene_rol(uuid, text[]) to authenticated, service_role;
grant execute on function restaurantes.actor_tiene_rol_en_sucursal(uuid, text[]) to authenticated, service_role;
grant execute on function restaurantes.actor_tiene_rol_en_alcance(uuid, uuid[], text[]) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 1) Catalogo de la organizacion (categories, products): crear, editar y borrar es de owner/admin (catalogo.precio).
--    La lectura sigue en las policies de 014 (no se tocan). Se retiran las policies "for all" de 001, las de la 064 (si corrio) y
--    se crean policies por comando.
-- ---------------------------------------------------------------------------
drop policy if exists "staff gestiona categorías de su organización" on restaurantes.categories;
drop policy if exists "gestores insertan categorias" on restaurantes.categories;
drop policy if exists "gestores actualizan categorias" on restaurantes.categories;
drop policy if exists "gestores borran categorias" on restaurantes.categories;
create policy "duenos y admins insertan categorias" on restaurantes.categories for insert
  with check (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']));
create policy "duenos y admins actualizan categorias" on restaurantes.categories for update
  using (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']))
  with check (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']));
create policy "duenos y admins borran categorias" on restaurantes.categories for delete
  using (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']));

drop policy if exists "staff gestiona productos de su organización" on restaurantes.products;
drop policy if exists "gestores insertan productos" on restaurantes.products;
drop policy if exists "gestores actualizan productos" on restaurantes.products;
drop policy if exists "gestores borran productos" on restaurantes.products;
create policy "duenos y admins insertan productos" on restaurantes.products for insert
  with check (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']));
create policy "duenos y admins actualizan productos" on restaurantes.products for update
  using (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']))
  with check (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']));
create policy "duenos y admins borran productos" on restaurantes.products for delete
  using (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']));

-- ---------------------------------------------------------------------------
-- 2) branch_products (precio y disponibilidad por sucursal).
--    * INSERT (dar de alta un producto en la sucursal, con su precio): owner/admin de esa sucursal.
--    * UPDATE: owner/admin/staff de esa sucursal pasan la policy, pero un trigger BEFORE UPDATE exige owner/admin cuando cambia el
--      precio (o el producto/sucursal de la fila). Una policy no puede distinguir columnas; el trigger si, y devuelve 42501 claro.
--    * GRANT por COLUMNA: las funciones reales solo escriben price, is_available y updated_at (upsertBranchProductState y
--      setBranchProductAvailability); property_id/product_id dejan de ser reescribibles. Es un REVOKE + GRANT mas angosto, no uno nuevo.
-- ---------------------------------------------------------------------------
-- ADVERTENCIA para quien agregue columnas a branch_products: este REVOKE retira TODO UPDATE de columna a authenticated, incluido cualquier
--   GRANT por columna de migraciones previas; si una columna nueva debe ser editable por staff, hay que sumarla a la lista del GRANT de abajo
--   (y al trigger si afecta el precio). Hoy los unicos escritores son upsertBranchProductState, setBranchProductAvailability y el seed (postgres).
revoke update on restaurantes.branch_products from authenticated;
grant update (price, is_available, updated_at) on restaurantes.branch_products to authenticated;

drop policy if exists "staff gestiona branch_products de su organización" on restaurantes.branch_products;
drop policy if exists "gestores de la sucursal insertan branch_products" on restaurantes.branch_products;
drop policy if exists "gestores de la sucursal actualizan branch_products" on restaurantes.branch_products;
create policy "duenos y admins de la sucursal insertan branch_products" on restaurantes.branch_products for insert
  with check (restaurantes.actor_tiene_rol_en_sucursal(property_id, array['owner', 'admin']));
create policy "gestores de la sucursal actualizan branch_products" on restaurantes.branch_products for update
  using (restaurantes.actor_tiene_rol_en_sucursal(property_id, array['owner', 'admin', 'staff']))
  with check (restaurantes.actor_tiene_rol_en_sucursal(property_id, array['owner', 'admin', 'staff']));

create or replace function restaurantes.branch_products_exigir_admin_para_precio()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Sesion de sistema y service_role (auth.uid() null) no pasan por la regla de staff: ya estaban acotadas por sus propias funciones.
  if auth.uid() is null then
    return new;
  end if;
  if (new.price is distinct from old.price or new.property_id is distinct from old.property_id or new.product_id is distinct from old.product_id)
     and not restaurantes.actor_tiene_rol_en_sucursal(old.property_id, array['owner', 'admin']) then
    raise exception 'restaurantes.branch_products: solo owner/admin cambian el precio de un producto en la sucursal'
      using errcode = '42501';
  end if;
  return new;
end;
$$;
-- Funcion de trigger: no necesita EXECUTE para dispararse.
revoke all on function restaurantes.branch_products_exigir_admin_para_precio() from public, anon, authenticated;

drop trigger if exists branch_products_exigir_admin_para_precio_trg on restaurantes.branch_products;
create trigger branch_products_exigir_admin_para_precio_trg
  before update on restaurantes.branch_products
  for each row execute function restaurantes.branch_products_exigir_admin_para_precio();

-- ---------------------------------------------------------------------------
-- 3) branch_detail (direccion, telefono, coordenadas, slug, orden): editar es de owner/admin de la sucursal (sucursal.editar).
-- ---------------------------------------------------------------------------
drop policy if exists "staff actualiza detalle de sucursal de su organización" on restaurantes.branch_detail;
drop policy if exists "gestores de la sucursal actualizan el detalle" on restaurantes.branch_detail;
create policy "duenos y admins de la sucursal actualizan el detalle" on restaurantes.branch_detail for update
  using (restaurantes.actor_tiene_rol_en_sucursal(property_id, array['owner', 'admin']))
  with check (restaurantes.actor_tiene_rol_en_sucursal(property_id, array['owner', 'admin']));

-- ---------------------------------------------------------------------------
-- 4) promotions: crear/editar/borrar es de owner/admin dentro del alcance de su membresia (una promocion sin sucursales =
--    toda la organizacion solo la gestiona una membresia sin acotar). La lectura de staff pasa a owner/admin (promociones.ver); la
--    lectura de la sesion de SISTEMA (checkout/voz/WhatsApp) y la policy publica de promociones activas de 010 no se tocan.
-- ---------------------------------------------------------------------------
drop policy if exists "staff gestiona promociones de su organización" on restaurantes.promotions;
drop policy if exists "gestores crean promociones dentro de su alcance" on restaurantes.promotions;
drop policy if exists "gestores actualizan promociones dentro de su alcance" on restaurantes.promotions;
drop policy if exists "gestores borran promociones dentro de su alcance" on restaurantes.promotions;
create policy "duenos y admins crean promociones dentro de su alcance" on restaurantes.promotions for insert
  with check (restaurantes.actor_tiene_rol_en_alcance(organization_id, property_ids, array['owner', 'admin']));
create policy "duenos y admins actualizan promociones dentro de su alcance" on restaurantes.promotions for update
  using (restaurantes.actor_tiene_rol_en_alcance(organization_id, property_ids, array['owner', 'admin']))
  with check (restaurantes.actor_tiene_rol_en_alcance(organization_id, property_ids, array['owner', 'admin']));
create policy "duenos y admins borran promociones dentro de su alcance" on restaurantes.promotions for delete
  using (restaurantes.actor_tiene_rol_en_alcance(organization_id, property_ids, array['owner', 'admin']));

-- Efecto con la 064 aplicada: la 064 ya reemplazo "cualquiera puede ver promociones activas" por una policy solo de sistema, asi que con ambas
--   el staff NO lee ninguna promocion. No se rompe nada: ningun camino de staff lee promotions (createOrder/quoteOrder solo corren desde
--   public/whatsapp/voice/email con sesion de sistema, que no pasa por estas policies).
drop policy if exists "staff ve promociones de su organización" on restaurantes.promotions;
drop policy if exists "gestores ven las promociones de su organizacion" on restaurantes.promotions;
create policy "duenos y admins ven las promociones de su organizacion" on restaurantes.promotions for select
  using (restaurantes.actor_tiene_rol(organization_id, array['owner', 'admin']));
