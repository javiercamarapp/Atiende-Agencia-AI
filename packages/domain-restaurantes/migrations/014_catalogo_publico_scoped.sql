-- Hallazgo de auditoría (severidad ALTA) — policies "using (true)" sobre el
-- catálogo de restaurantes permiten fuga cross-tenant, mismo hallazgo y mismo fix
-- que `packages/domain-citas/migrations/016_catalogo_publico_scoped_y_dead_policies.sql`
-- (ver su cabecera para el detalle completo del razonamiento).
--
-- `001_restaurantes_schema.sql` dejó 4 policies de SELECT sin ningún filtro
-- ("cualquiera puede ver categorías/productos/branch_products/detalle de
-- sucursal", las 4 `using (true)`) con GRANT SELECT explícito a `anon` (línea
-- 255) -- el checkout web anónimo real las necesita sin filtrar. El bug: las
-- mismas 4 tablas también otorgan SELECT a `authenticated` sin ningún filtro
-- adicional, así que cualquier staff autenticado de CUALQUIER organización puede
-- leer el catálogo COMPLETO (categorías, productos, precios por sucursal) de
-- cualquier otro restaurante del monorepo, vía una consulta directa que nunca
-- pasa por las rutas de la aplicación (que sí filtran por `organization_id`).
--
-- Verificado contra Postgres real (mismo patrón de instancia efímera que la
-- migración 016 de citas) antes de escribir el fix.
--
-- Fix: mismo patrón -- `auth.uid() is null` (checkout anónimo real, sesión de
-- sistema) OR staff con membership real de la organización dueña de la fila.
-- `restaurantes.categories`/`restaurantes.products` ya tienen `organization_id`
-- propio (join directo); `restaurantes.branch_products`/`restaurantes.
-- branch_detail` solo tienen `property_id` -- se usa `core.has_property_access`
-- (packages/db/migrations/0001_core_schema.sql), la misma función que ya
-- resuelve ese mismo join en el resto del esquema de este vertical (ver
-- `007_admin_backoffice_grants_and_policies.sql`).

drop policy if exists "cualquiera puede ver categorías" on restaurantes.categories;
create policy "público o su organización ve categorías" on restaurantes.categories for select
  using (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = categories.organization_id and m.user_id = auth.uid())
  );

drop policy if exists "cualquiera puede ver productos" on restaurantes.products;
create policy "público o su organización ve productos" on restaurantes.products for select
  using (
    auth.uid() is null
    or exists (select 1 from core.membership m where m.organization_id = products.organization_id and m.user_id = auth.uid())
  );

drop policy if exists "cualquiera puede ver branch_products" on restaurantes.branch_products;
create policy "público o su organización ve branch_products" on restaurantes.branch_products for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), branch_products.property_id));

drop policy if exists "cualquiera puede ver detalle de sucursal" on restaurantes.branch_detail;
create policy "público o su organización ve detalle de sucursal" on restaurantes.branch_detail for select
  using (auth.uid() is null or core.has_property_access(auth.uid(), branch_detail.property_id));

-- Nota (hallazgo de auditoría "policies letra muerta", revisado junto con lo
-- anterior por tocar la misma tabla): `restaurantes.branch_products` también
-- tiene policy "for all" (`007_admin_backoffice_grants_and_policies.sql`) cuyo
-- GRANT solo cubre INSERT/UPDATE, nunca DELETE -- el arma DELETE de esa policy es
-- letra muerta. Verificado con `grep -rn "delete from restaurantes.branch_products"
-- packages/domain-restaurantes/src`: ningún código de este repo borra una fila de
-- branch_products -- el patrón real es `is_available = false` (soft-delete, igual
-- que el resto del catálogo). Se deja sin GRANT DELETE a propósito -- no hay caso
-- de uso real que destrabar hoy.
