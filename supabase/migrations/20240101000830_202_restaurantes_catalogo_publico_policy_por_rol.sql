-- Ola 2 (seguridad), arreglo F.1 (paso previo al revoke de PUBLIC en core.has_property_access) — separa por rol las
-- policies de lectura pública de restaurantes.branch_detail y restaurantes.branch_products.
--
-- 014_catalogo_publico_scoped dejó en cada tabla UNA policy de SELECT para todos los roles:
--   using (auth.uid() is null or core.has_property_access(auth.uid(), property_id))
-- Postgres exige EXECUTE sobre cada función de las policies que aplican al rol que consulta (al preparar la
-- consulta, aunque el OR no llegue a evaluarla). Con el revoke de PUBLIC de 0091 (espejo 831), `anon` deja de
-- tener EXECUTE sobre core.has_property_access y su lectura de estas dos tablas pasaría de funcionar a
-- «permission denied» (contrato que cubre scripts/verify-zona-horaria-por-negocio, escenario 11).
--
-- Arreglo: dos policies con el MISMO resultado que la anterior, una por rol:
--   * `to anon`: `auth.uid() is null` (anon nunca trae JWT con sub): lo mismo que el primer término del OR, sin helper.
--   * `to authenticated`: la expresión de siempre (sesión de sistema sin auth.uid(), o staff con acceso a la propiedad
--     vía core.has_property_access, que conserva EXECUTE para authenticated).
-- No cambia GRANTs: el SELECT de anon sobre estas dos tablas (001_restaurantes_schema) queda como excepción documentada
-- en scripts/guard-sql-privilegios/excepciones.json. Ningún otro rol tiene GRANT sobre ellas, así que no pierde nada.
--
-- Numeración: 202 = siguiente libre de restaurantes por encima de los PRs abiertos (main llega a 106; 103-201 en PRs
-- abiertos). Espejo: supabase/migrations/20240101000830_202_restaurantes_catalogo_publico_policy_por_rol.sql (ANTES
-- del revoke). Idempotente (drop policy if exists). Verificación: scripts/verify-security-definer-revoke/ (15-16).

drop policy if exists "público o su organización ve detalle de sucursal" on restaurantes.branch_detail;
drop policy if exists "público ve detalle de sucursal (anon)" on restaurantes.branch_detail;
drop policy if exists "sistema o su organización ve detalle de sucursal" on restaurantes.branch_detail;
create policy "público ve detalle de sucursal (anon)" on restaurantes.branch_detail
  for select to anon
  using (auth.uid() is null);
create policy "sistema o su organización ve detalle de sucursal" on restaurantes.branch_detail
  for select to authenticated
  using (auth.uid() is null or core.has_property_access(auth.uid(), branch_detail.property_id));

drop policy if exists "público o su organización ve branch_products" on restaurantes.branch_products;
drop policy if exists "público ve branch_products (anon)" on restaurantes.branch_products;
drop policy if exists "sistema o su organización ve branch_products" on restaurantes.branch_products;
create policy "público ve branch_products (anon)" on restaurantes.branch_products
  for select to anon
  using (auth.uid() is null);
create policy "sistema o su organización ve branch_products" on restaurantes.branch_products
  for select to authenticated
  using (auth.uid() is null or core.has_property_access(auth.uid(), branch_products.property_id));
