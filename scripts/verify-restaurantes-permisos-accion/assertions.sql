-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna + trigger reales -- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/065_permisos_por_accion_escritura.sql (PL-23, permisos por accion):
--
--   A. Catalogo (categories, products): owner/admin escriben; staff, repartidor, otra organizacion y anon NO.
--   B. branch_products: staff solo cambia is_available de una fila existente de SU sucursal; el precio (solo o junto con la
--      disponibilidad) -> 42501 del trigger; alta, cambio de property_id/product_id y otra sucursal/organizacion NO.
--   C. branch_detail: solo owner/admin de la sucursal.
--   D. promotions: solo owner/admin dentro del alcance; staff ni escribe ni lee las no activas.
--   E. Compatibilidad: sesion de sistema/service_role (auth.uid() null) no se rompe, y el SQL de disponibilidad del repositorio
--      funciona tambien contra el estado ANTERIOR a la migracion (policies de 007) sin error.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`: un escenario
-- "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'Permisos Org A', 'permisos-org-a'),
  ('00000000-0000-0000-0000-0000000f0002', 'restaurantes', 'Permisos Org B (ajena)', 'permisos-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f00c1', '00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'Sucursal A1', 'active'),
  ('00000000-0000-0000-0000-0000000f00c2', '00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'Sucursal A2', 'active'),
  ('00000000-0000-0000-0000-0000000f00c3', '00000000-0000-0000-0000-0000000f0002', 'restaurantes', 'Sucursal B1', 'active')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, address) values
  ('00000000-0000-0000-0000-0000000f00c1', '00000000-0000-0000-0000-0000000f0001', 'a1', 'Calle A1'),
  ('00000000-0000-0000-0000-0000000f00c2', '00000000-0000-0000-0000-0000000f0001', 'a2', 'Calle A2'),
  ('00000000-0000-0000-0000-0000000f00c3', '00000000-0000-0000-0000-0000000f0002', 'b1', 'Calle B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0011', 'owner-a@permisos.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0012', 'admin-a@permisos.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0013', 'staff-a1@permisos.example.com', 'Staff A1', 'seed'),
  ('00000000-0000-0000-0000-0000000f0014', 'owner-b@permisos.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000f0015', 'repartidor-a@permisos.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0016', 'admin-a1@permisos.example.com', 'Admin acotado A1', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0011', '00000000-0000-0000-0000-0000000f0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0012', '00000000-0000-0000-0000-0000000f0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000f0013', '00000000-0000-0000-0000-0000000f0001', array['00000000-0000-0000-0000-0000000f00c1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f0014', '00000000-0000-0000-0000-0000000f0002', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0015', '00000000-0000-0000-0000-0000000f0001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f0016', '00000000-0000-0000-0000-0000000f0001', array['00000000-0000-0000-0000-0000000f00c1']::uuid[], 'admin', 'admin')
on conflict do nothing;

insert into restaurantes.categories (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-0000000f00d1', '00000000-0000-0000-0000-0000000f0001', 'Tacos', 'tacos')
on conflict do nothing;

insert into restaurantes.products (id, organization_id, category_id, name, price) values
  ('00000000-0000-0000-0000-0000000f00e1', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00d1', 'Taco al pastor', 30)
on conflict do nothing;

insert into restaurantes.branch_products (id, property_id, product_id, price, is_available) values
  ('00000000-0000-0000-0000-0000000f00f1', '00000000-0000-0000-0000-0000000f00c1', '00000000-0000-0000-0000-0000000f00e1', 35, true),
  ('00000000-0000-0000-0000-0000000f00f2', '00000000-0000-0000-0000-0000000f00c2', '00000000-0000-0000-0000-0000000f00e1', 36, true)
on conflict do nothing;

insert into restaurantes.promotions (id, organization_id, code, name, type, value, is_active, property_ids) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'TODAS', 'Toda la organizacion', 'percentage', 10, false, null),
  ('00000000-0000-0000-0000-0000000f00a2', '00000000-0000-0000-0000-0000000f0001', 'SOLOA1', 'Solo A1', 'percentage', 10, false, array['00000000-0000-0000-0000-0000000f00c1']::uuid[])
on conflict do nothing;

-- ===========================================================================
-- A. Catalogo
-- ===========================================================================
\echo '=== A1. POSITIVO: owner de A crea producto y categoria ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
insert into restaurantes.categories (organization_id, name, slug) values ('00000000-0000-0000-0000-0000000f0001', 'Bebidas', 'bebidas') returning slug;
insert into restaurantes.products (organization_id, name, price) values ('00000000-0000-0000-0000-0000000f0001', 'Horchata', 25) returning name;
rollback;

\echo '=== A2. POSITIVO: admin de A cambia el precio base de un producto (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
with u as (update restaurantes.products set price = 31 where id = '00000000-0000-0000-0000-0000000f00e1' returning id)
select count(*)::int as admin_actualiza_producto_deberia_ser_1 from u;
rollback;

\echo '=== A3. RECHAZADO (debe fallar): staff crea un producto ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
insert into restaurantes.products (organization_id, name, price) values ('00000000-0000-0000-0000-0000000f0001', 'Intento staff', 1);
rollback;

\echo '=== A4. staff NO cambia el precio base de un producto (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.products set price = 1 where id = '00000000-0000-0000-0000-0000000f00e1' returning id)
select count(*)::int as staff_actualiza_producto_deberia_ser_0 from u;
rollback;

\echo '=== A5. RECHAZADO (debe fallar): repartidor crea una categoria ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0015', true);
insert into restaurantes.categories (organization_id, name, slug) values ('00000000-0000-0000-0000-0000000f0001', 'Intento', 'intento');
rollback;

\echo '=== A6. staff NO borra ni edita una categoria (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with d as (delete from restaurantes.categories where id = '00000000-0000-0000-0000-0000000f00d1' returning id),
     u as (update restaurantes.categories set name = 'x' where id = '00000000-0000-0000-0000-0000000f00d1' returning id)
select (select count(*) from d)::int + (select count(*) from u)::int as staff_borra_o_edita_categoria_deberia_ser_0;
rollback;

\echo '=== A7. CROSS-TENANT: owner de B no cambia el producto de A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
with u as (update restaurantes.products set price = 1 where id = '00000000-0000-0000-0000-0000000f00e1' returning id)
select count(*)::int as owner_ajeno_actualiza_producto_deberia_ser_0 from u;
rollback;

\echo '=== A8. RECHAZADO (debe fallar): anon no inserta productos ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.products (organization_id, name, price) values ('00000000-0000-0000-0000-0000000f0001', 'Anon', 1);
rollback;

\echo '=== A9. POSITIVO: admin de A marca no_domicilio en un producto y en una categoria (1 + 1 = 2 filas, una sola columna para el gate) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
with p as (update restaurantes.products set no_domicilio = true where id = '00000000-0000-0000-0000-0000000f00e1' returning id),
     c as (update restaurantes.categories set no_domicilio = true where id = '00000000-0000-0000-0000-0000000f00d1' returning id)
select ((select count(*) from p) + (select count(*) from c))::int as admin_marca_producto_y_categoria_deberia_ser_2;
rollback;

\echo '=== A10. staff NO marca no_domicilio (RLS filtra: 0 filas; la API responde 403 antes de llegar aqui) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with p as (update restaurantes.products set no_domicilio = true where id = '00000000-0000-0000-0000-0000000f00e1' returning id),
     c as (update restaurantes.categories set no_domicilio = true where id = '00000000-0000-0000-0000-0000000f00d1' returning id)
select (select count(*) from p)::int + (select count(*) from c)::int as staff_marca_no_domicilio_deberia_ser_0;
rollback;

-- ===========================================================================
-- B. branch_products
-- ===========================================================================
\echo '=== B1. POSITIVO: staff de A1 marca agotado el producto en SU sucursal (1 fila) y el precio no cambia ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.branch_products set is_available = false, updated_at = now()
            where property_id = '00000000-0000-0000-0000-0000000f00c1' and product_id = '00000000-0000-0000-0000-0000000f00e1' returning price, is_available)
select count(*)::int as staff_marca_agotado_deberia_ser_1 from u;
rollback;

\echo '=== B2. RECHAZADO (debe fallar con 42501): staff cambia el PRECIO por sucursal ==='
begin;
-- as should_fail (UPDATE sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
update restaurantes.branch_products set price = 1 where property_id = '00000000-0000-0000-0000-0000000f00c1' and product_id = '00000000-0000-0000-0000-0000000f00e1';
rollback;

\echo '=== B3. staff que manda precio y disponibilidad juntos: el trigger devuelve SQLSTATE 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
do $$
declare
  v_state text;
begin
  begin
    update restaurantes.branch_products set price = 1, is_available = false where id = '00000000-0000-0000-0000-0000000f00f1';
    raise exception 'se esperaba SQLSTATE 42501, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42501' then
      raise exception 'se esperaba SQLSTATE 42501, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback;

\echo '=== B4. POSITIVO: admin y owner de A cambian el precio por sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
with u as (update restaurantes.branch_products set price = 40 where id = '00000000-0000-0000-0000-0000000f00f1' returning id)
select count(*)::int as admin_cambia_precio_deberia_ser_1 from u;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
with u as (update restaurantes.branch_products set price = 41 where id = '00000000-0000-0000-0000-0000000f00f1' returning id)
select count(*)::int as owner_cambia_precio_deberia_ser_1 from u;
rollback;

\echo '=== B5. staff de A1 NO toca la sucursal A2 (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.branch_products set is_available = false where id = '00000000-0000-0000-0000-0000000f00f2' returning id)
select count(*)::int as staff_en_otra_sucursal_deberia_ser_0 from u;
rollback;

\echo '=== B6. RECHAZADO (debe fallar): staff da de alta un producto en la sucursal ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
insert into restaurantes.branch_products (property_id, product_id, price) values ('00000000-0000-0000-0000-0000000f00c1', '00000000-0000-0000-0000-0000000f00e1', 1);
rollback;

\echo '=== B7. RECHAZADO (debe fallar): reescribir property_id (sin GRANT de columna) ==='
begin;
-- as should_fail (UPDATE sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
update restaurantes.branch_products set property_id = '00000000-0000-0000-0000-0000000f00c2' where id = '00000000-0000-0000-0000-0000000f00f1';
rollback;

\echo '=== B8. CROSS-TENANT: owner de B no cambia el precio de A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
with u as (update restaurantes.branch_products set price = 1 where id = '00000000-0000-0000-0000-0000000f00f1' returning id)
select count(*)::int as owner_ajeno_cambia_precio_deberia_ser_0 from u;
rollback;

\echo '=== B9. RECHAZADO (debe fallar): anon no actualiza branch_products ==='
begin;
-- as should_fail (UPDATE sin alias)
set local role anon;
update restaurantes.branch_products set is_available = false where id = '00000000-0000-0000-0000-0000000f00f1';
rollback;

\echo '=== B10. repartidor NO marca agotado (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0015', true);
with u as (update restaurantes.branch_products set is_available = false where id = '00000000-0000-0000-0000-0000000f00f1' returning id)
select count(*)::int as repartidor_marca_agotado_deberia_ser_0 from u;
rollback;

\echo '=== B11. COMPATIBILIDAD: una sesion sin usuario (auth.uid() null, p. ej. mantenimiento con service_role/operador) sigue pudiendo corregir un precio: el trigger no lo bloquea ==='
begin;
with u as (update restaurantes.branch_products set price = 50 where id = '00000000-0000-0000-0000-0000000f00f1' returning id)
select count(*)::int as sesion_sin_usuario_cambia_precio_deberia_ser_1 from u;
rollback;

\echo '=== B12. La sesion de SISTEMA (authenticated sin usuario) NO gana escritura de staff: 0 filas ==='
begin;
set local role authenticated;
with u as (update restaurantes.branch_products set is_available = false where id = '00000000-0000-0000-0000-0000000f00f1' returning id)
select count(*)::int as sistema_escribe_branch_products_deberia_ser_0 from u;
rollback;

-- ===========================================================================
-- C. branch_detail
-- ===========================================================================
\echo '=== C1. POSITIVO: admin de A edita la direccion de A1 (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
with u as (update restaurantes.branch_detail set address = 'Nueva 1' where property_id = '00000000-0000-0000-0000-0000000f00c1' returning property_id)
select count(*)::int as admin_edita_sucursal_deberia_ser_1 from u;
rollback;

\echo '=== C2. staff NO edita la sucursal (0 filas), ni siquiera la suya ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.branch_detail set address = 'Hackeada' where property_id = '00000000-0000-0000-0000-0000000f00c1' returning property_id)
select count(*)::int as staff_edita_sucursal_deberia_ser_0 from u;
rollback;

\echo '=== C3. admin acotado a A1 NO edita A2 (0 filas); owner de B no edita A1 (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0016', true);
with u as (update restaurantes.branch_detail set address = 'x' where property_id = '00000000-0000-0000-0000-0000000f00c2' returning property_id)
select count(*)::int as admin_acotado_en_otra_sucursal_deberia_ser_0 from u;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
with u as (update restaurantes.branch_detail set address = 'x' where property_id = '00000000-0000-0000-0000-0000000f00c1' returning property_id)
select count(*)::int as owner_ajeno_edita_sucursal_deberia_ser_0 from u;
rollback;

-- ===========================================================================
-- D. promotions
-- ===========================================================================
\echo '=== D1. POSITIVO: admin (sin acotar) crea una promocion de toda la organizacion; owner crea una acotada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
insert into restaurantes.promotions (organization_id, code, name, type, value) values ('00000000-0000-0000-0000-0000000f0001', 'ADMIN10', 'x', 'percentage', 10) returning code;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000f0001', 'OWNERA1', 'x', 'percentage', 10, array['00000000-0000-0000-0000-0000000f00c1']::uuid[]) returning code;
rollback;

\echo '=== D2. RECHAZADO (debe fallar): staff crea una promocion ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids)
  values ('00000000-0000-0000-0000-0000000f0001', 'STAFF50', 'x', 'percentage', 50, array['00000000-0000-0000-0000-0000000f00c1']::uuid[]);
rollback;

\echo '=== D3. staff NO edita ni borra una promocion de su alcance (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.promotions set value = 90 where id = '00000000-0000-0000-0000-0000000f00a2' returning id),
     d as (delete from restaurantes.promotions where id = '00000000-0000-0000-0000-0000000f00a2' returning id)
select (select count(*) from u)::int + (select count(*) from d)::int as staff_edita_o_borra_promocion_deberia_ser_0;
rollback;

\echo '=== D4. staff NO ve las promociones no activas de su organizacion (0 filas); owner y admin si (2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
select count(*)::int as staff_ve_promociones_inactivas_deberia_ser_0 from restaurantes.promotions where is_active = false;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
select count(*)::int as admin_ve_promociones_inactivas_deberia_ser_2 from restaurantes.promotions where is_active = false and organization_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== D5. RECHAZADO (debe fallar): admin acotado a A1 crea una promocion de TODA la organizacion (fuera de su alcance) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0016', true);
insert into restaurantes.promotions (organization_id, code, name, type, value) values ('00000000-0000-0000-0000-0000000f0001', 'ALCANCE', 'x', 'percentage', 10);
rollback;

\echo '=== D6. CROSS-TENANT: owner de B no edita la promocion de A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
with u as (update restaurantes.promotions set value = 1 where id = '00000000-0000-0000-0000-0000000f00a1' returning id)
select count(*)::int as owner_ajeno_edita_promocion_deberia_ser_0 from u;
rollback;

\echo '=== D7. RECHAZADO (debe fallar): anon no crea promociones ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.promotions (organization_id, code, name, type, value) values ('00000000-0000-0000-0000-0000000f0001', 'ANON', 'x', 'percentage', 10);
rollback;

-- ===========================================================================
-- E. Compatibilidad: el SQL de disponibilidad del repositorio contra el estado ANTERIOR a la migracion
-- ===========================================================================
\echo '=== E1. ESTADO ANTERIOR (policy y GRANT de 007, sin trigger): el UPDATE de disponibilidad del repositorio sigue funcionando ==='
begin;
drop trigger branch_products_exigir_admin_para_precio_trg on restaurantes.branch_products;
drop policy "gestores de la sucursal actualizan branch_products" on restaurantes.branch_products;
grant update on restaurantes.branch_products to authenticated;
create policy "staff gestiona branch_products de su organización" on restaurantes.branch_products for all
  using (exists (select 1 from core.property p join core.membership m on m.organization_id = p.organization_id
                  where p.id = branch_products.property_id and m.user_id = auth.uid()))
  with check (exists (select 1 from core.property p join core.membership m on m.organization_id = p.organization_id
                  where p.id = branch_products.property_id and m.user_id = auth.uid()));
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.branch_products set is_available = false, updated_at = now()
            where property_id = '00000000-0000-0000-0000-0000000f00c1' and product_id = '00000000-0000-0000-0000-0000000f00e1'
        returning property_id, product_id, price, is_available)
select count(*)::int as disponibilidad_en_base_anterior_deberia_ser_1 from u;
rollback;
