-- QA restaurantes ronda 1 -- lente SEGURIDAD Y DATOS. Escenarios contra Postgres REAL (RLS + GRANT
-- reales) de packages/domain-restaurantes/migrations/041_seguridad_rls_alcance_y_privacidad.sql: alcance por
-- rol y sucursal (QA-restaurantes-R1-seguridad-01/02/03), higiene de permisos (11) y privacidad (06/07/10/14).
-- Los escenarios S* eran los defectos abiertos (fallaban antes de la 041); los R* son regresion y los P* son
-- escenarios positivos de lo que SI debe seguir funcionando. Cada escenario corre en su propio begin; ... rollback;.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'QA Org A', 'qa-org-a'),
  ('00000000-0000-0000-0000-0000000f0002', 'restaurantes', 'QA Org B (ajena)', 'qa-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'A1', 'active'),
  ('00000000-0000-0000-0000-0000000f00a2', '00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'A2', 'active'),
  ('00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f0002', 'restaurantes', 'B1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0011', 'owner-a@qa.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0012', 'repartidor-a1@qa.example.com', 'Repartidor A1', 'seed'),
  ('00000000-0000-0000-0000-0000000f0013', 'staff-a1@qa.example.com', 'Staff A1', 'seed'),
  ('00000000-0000-0000-0000-0000000f0021', 'owner-b@qa.example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0011', '00000000-0000-0000-0000-0000000f0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0012', '00000000-0000-0000-0000-0000000f0001', array['00000000-0000-0000-0000-0000000f00a1']::uuid[], 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f0013', '00000000-0000-0000-0000-0000000f0001', array['00000000-0000-0000-0000-0000000f00a1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f0021', '00000000-0000-0000-0000-0000000f0002', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, items, source, status) values
  ('00000000-0000-0000-0000-0000000f0a21', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a2', 'Cliente QA', '+520000000001', 480, '[]'::jsonb, 'web', 'pending')
on conflict do nothing;

insert into restaurantes.promotions (id, organization_id, code, name, type, value, is_active) values
  ('00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-0000000f0002', 'QAPRIVADOB', 'Codigo privado de B', 'percentage', 50, true)
on conflict do nothing;

insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-0000000f0c01', '00000000-0000-0000-0000-0000000f0001', 'Producto QA', 100)
on conflict do nothing;

\echo '=== R1. Regresion: owner de A lee su pedido de A2 (positivo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select count(*)::int as owner_ve_su_pedido_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000f0a21';
rollback;

\echo '=== R2. Regresion cross-tenant: owner de B no ve pedidos de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0021', true);
select count(*)::int as owner_b_ve_pedidos_a_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== S01. QA-R1-seguridad-01: repartidor acotado a A1 NO cambia el total de un pedido de A2 (el GRANT por columna lo rechaza) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
update restaurantes.orders set total = 1 where id = '00000000-0000-0000-0000-0000000f0a21' returning total as should_fail;
rollback;

\echo '=== S01b. QA-R1-seguridad-01: repartidor NO crea una promocion (solo owner/admin/staff via la app) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
insert into restaurantes.promotions (organization_id, code, name, type, value) values ('00000000-0000-0000-0000-0000000f0001', 'QAREPARTIDOR', 'x', 'percentage', 100) returning id as should_fail;
rollback;

\echo '=== S03. QA-R1-seguridad-03: repartidor acotado a A1 NO lee pedidos (PII) de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
select count(*)::int as repartidor_lee_pii_a2_deberia_ser_0 from restaurantes.orders where property_id = '00000000-0000-0000-0000-0000000f00a2';
rollback;

\echo '=== S03b. QA-R1-seguridad-03: staff acotado a A1 NO lee pedidos de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
select count(*)::int as staff_a1_lee_pedidos_a2_deberia_ser_0 from restaurantes.orders where property_id = '00000000-0000-0000-0000-0000000f00a2';
rollback;

\echo '=== S02. QA-R1-seguridad-02: owner de A NO lee los codigos de promocion activos de B (cross-tenant) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select count(*)::int as owner_a_lee_codigos_de_b_deberia_ser_0 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000f0002';
rollback;

\echo '=== R2b. Regresion (S02 no aplica a anon): anon no lee codigos de promocion -- hoy termina en ERROR (las policies OR consultan core.membership, sin GRANT para anon) ==='
begin;
-- as should_fail (sin alias)
set local role anon;
select code from restaurantes.promotions;
rollback;

\echo '=== R3. Regresion: anon no lee pedidos (sin GRANT) ==='
begin;
-- as should_fail (sin alias)
set local role anon;
select * from restaurantes.orders;
rollback;

\echo '=== R4. Regresion: owner de B no actualiza un producto de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0021', true);
with u as (update restaurantes.products set price = 1 where id = '00000000-0000-0000-0000-0000000f0c01' returning 1)
select count(*)::int as owner_b_cambia_precio_a_deberia_ser_0 from u;
rollback;

\echo '=== R5. Regresion: las funciones de sistema rechazan una sesion de staff (auth.uid() no nulo) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select * from restaurantes.storefront_order_tracking('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f0a21');
rollback;

-- ---------------------------------------------------------------------------------------------------------------
-- Fixtures adicionales (041): pedidos, catalogo y datos personales para los positivos, cross-sucursal y privacidad.
-- ---------------------------------------------------------------------------------------------------------------
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, items, source, status, assigned_repartidor_id) values
  ('00000000-0000-0000-0000-0000000f0a11', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Cliente A1', '+520000000002', 200, '[]'::jsonb, 'web', 'pending', null),
  ('00000000-0000-0000-0000-0000000f0a12', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Cliente Asignado', '+520000000003', 150, '[]'::jsonb, 'web', 'en_camino', '00000000-0000-0000-0000-0000000f0012')
on conflict do nothing;
insert into restaurantes.promotions (id, organization_id, code, name, type, value, is_active) values
  ('00000000-0000-0000-0000-0000000f0b02', '00000000-0000-0000-0000-0000000f0001', 'QAPROMOA', 'Promo propia de A', 'percentage', 10, true)
on conflict do nothing;
insert into restaurantes.branch_products (id, property_id, product_id, price) values
  ('00000000-0000-0000-0000-0000000f0d02', '00000000-0000-0000-0000-0000000f00a2', '00000000-0000-0000-0000-0000000f0c01', 100),
  ('00000000-0000-0000-0000-0000000f0d01', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0c01', 100)
on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000f0e01', '00000000-0000-0000-0000-0000000f0001', '9990001234', 'Titular QA', 1)
on conflict do nothing;
insert into restaurantes.callback_requests (id, organization_id, property_id, customer_name, customer_phone, message) values
  ('00000000-0000-0000-0000-0000000f0f02', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a2', 'Cliente de A2', '9990009999', 'llamar de vuelta')
on conflict do nothing;

\echo '=== P1. Positivo: staff de A1 cambia el estado de un pedido de SU sucursal (la ruta real de estado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000f0a11' returning 1)
select count(*)::int as staff_a1_cambia_estado_a1_deberia_ser_1 from u;
rollback;

\echo '=== S01c. QA-R1-seguridad-01: staff de A1 NO cambia el estado de un pedido de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.orders set status = 'cancelado' where id = '00000000-0000-0000-0000-0000000f0a21' returning 1)
select count(*)::int as staff_a1_cambia_estado_a2_deberia_ser_0 from u;
rollback;

\echo '=== S01d. QA-R1-seguridad-01: ni el owner reescribe el TOTAL de un pedido (GRANT por columna) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
update restaurantes.orders set total = 1 where id = '00000000-0000-0000-0000-0000000f0a21' returning total as should_fail;
rollback;

\echo '=== P2. Positivo: el repartidor cambia el estado de SU pedido asignado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
with u as (update restaurantes.orders set status = 'entregado', delivered_at = now() where id = '00000000-0000-0000-0000-0000000f0a12' returning 1)
select count(*)::int as repartidor_cierra_su_pedido_deberia_ser_1 from u;
rollback;

\echo '=== S01e. QA-R1-seguridad-01: el repartidor NO cambia el estado de un pedido que no tiene asignado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
with u as (update restaurantes.orders set status = 'entregado' where id = '00000000-0000-0000-0000-0000000f0a11' returning 1)
select count(*)::int as repartidor_cierra_pedido_ajeno_deberia_ser_0 from u;
rollback;

\echo '=== S01f. QA-R1-seguridad-01: el repartidor NO reasigna su pedido a otra persona (with check) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
update restaurantes.orders set assigned_repartidor_id = '00000000-0000-0000-0000-0000000f0013' where id = '00000000-0000-0000-0000-0000000f0a12' returning id as should_fail;
rollback;

\echo '=== S01g. QA-R1-seguridad-01: staff acotado a A1 NO crea una promocion de toda la organizacion ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
insert into restaurantes.promotions (organization_id, code, name, type, value) values ('00000000-0000-0000-0000-0000000f0001', 'QASTAFFTODAS', 'x', 'percentage', 100) returning id as should_fail;
rollback;

\echo '=== P3. Positivo: staff acotado a A1 SI crea una promocion limitada a A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with i as (insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids) values ('00000000-0000-0000-0000-0000000f0001', 'QASTAFFA1', 'x', 'percentage', 10, array['00000000-0000-0000-0000-0000000f00a1']::uuid[]) returning 1)
select count(*)::int as staff_crea_promo_de_su_sucursal_deberia_ser_1 from i;
rollback;

\echo '=== S01h. QA-R1-seguridad-01: staff acotado a A1 NO crea una promocion que incluye A2 ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, property_ids) values ('00000000-0000-0000-0000-0000000f0001', 'QASTAFFA1A2', 'x', 'percentage', 10, array['00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00a2']::uuid[]) returning id as should_fail;
rollback;

\echo '=== S01i. QA-R1-seguridad-01: staff acotado a A1 NO desactiva una promocion de toda la organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.promotions set is_active = false where id = '00000000-0000-0000-0000-0000000f0b02' returning 1)
select count(*)::int as staff_acotado_apaga_promo_org_deberia_ser_0 from u;
rollback;

\echo '=== P4. Positivo: el owner (sin acotar) crea una promocion de toda la organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
with i as (insert into restaurantes.promotions (organization_id, code, name, type, value) values ('00000000-0000-0000-0000-0000000f0001', 'QAOWNERORG', 'x', 'percentage', 10) returning 1)
select count(*)::int as owner_crea_promo_de_toda_la_org_deberia_ser_1 from i;
rollback;

\echo '=== S01j. QA-R1-seguridad-01: el repartidor NO crea categorias ni productos ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
insert into restaurantes.categories (organization_id, name, slug) values ('00000000-0000-0000-0000-0000000f0001', 'x', 'x') returning id as should_fail;
rollback;

\echo '=== P5. Positivo: staff crea una categoria de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with i as (insert into restaurantes.categories (organization_id, name, slug) values ('00000000-0000-0000-0000-0000000f0001', 'Cat QA', 'cat-qa') returning 1)
select count(*)::int as staff_crea_categoria_deberia_ser_1 from i;
rollback;

\echo '=== S01k. QA-R1-seguridad-01: staff acotado a A1 NO cambia el precio de un producto en la sucursal A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.branch_products set price = 1 where id = '00000000-0000-0000-0000-0000000f0d02' returning 1)
select count(*)::int as staff_a1_cambia_precio_en_a2_deberia_ser_0 from u;
rollback;

\echo '=== P6. Positivo: staff acotado a A1 cambia el precio de un producto en SU sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
with u as (update restaurantes.branch_products set price = 120 where id = '00000000-0000-0000-0000-0000000f0d01' returning 1)
select count(*)::int as staff_a1_cambia_precio_en_a1_deberia_ser_1 from u;
rollback;

\echo '=== S01l. QA-R1-seguridad-01: el repartidor NO edita el detalle de ninguna sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
with u as (update restaurantes.branch_detail set phone = '000' returning 1)
select count(*)::int as repartidor_edita_sucursal_deberia_ser_0 from u;
rollback;

\echo '=== P7. Positivo: la sesion de SISTEMA (auth.uid() null) sigue resolviendo promociones ACTIVAS para el checkout ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as sistema_resuelve_promocion_activa_deberia_ser_1 from restaurantes.promotions where code = 'QAPROMOA';
rollback;

\echo '=== S02b. QA-R1-seguridad-02: el repartidor no ve los codigos de promocion de su propia organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
select count(*)::int as repartidor_ve_codigos_deberia_ser_0 from restaurantes.promotions;
rollback;

\echo '=== S02c. QA-R1-seguridad-02: un staff de otra organizacion tampoco ve codigos activos ajenos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0021', true);
select count(*)::int as owner_b_ve_codigos_de_a_deberia_ser_0 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== P8. Positivo: el repartidor ve SOLO su pedido asignado (1 de los 3 pedidos de A) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
select count(*)::int as repartidor_ve_su_pedido_asignado_deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== P9. Positivo: staff acotado a A1 ve los pedidos de A1 (2) y ninguno de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
select count(*)::int as staff_a1_ve_pedidos_de_a1_deberia_ser_2 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000f0001';
rollback;

\echo '=== S03c. QA-R1-seguridad-03: el repartidor no lee clientes de la organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0012', true);
select count(*)::int as repartidor_lee_clientes_deberia_ser_0 from restaurantes.customers;
rollback;

\echo '=== P10. Positivo: staff lee los clientes de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
select count(*)::int as staff_lee_clientes_deberia_ser_1 from restaurantes.customers;
rollback;

\echo '=== S03d. QA-R1-seguridad-03: staff acotado a A1 no lee solicitudes de contacto de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0013', true);
select count(*)::int as staff_a1_lee_callbacks_a2_deberia_ser_0 from restaurantes.callback_requests;
rollback;

\echo '=== P11. Positivo: el owner lee las solicitudes de contacto de cualquier sucursal de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select count(*)::int as owner_lee_callbacks_deberia_ser_1 from restaurantes.callback_requests;
rollback;

\echo '=== R6. QA-R1-seguridad-11: anon no lee el catalogo (ya no hay GRANT de SELECT a anon) ==='
begin;
-- as should_fail (sin alias)
set local role anon;
select * from restaurantes.categories;
rollback;

\echo '=== S11. QA-R1-seguridad-11: ninguna funcion de restaurantes queda ejecutable por PUBLIC o anon (con acl explicita) ==='
begin;
select count(*)::int as funciones_publicas_deberia_ser_0
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'restaurantes'
   and p.proname not in ('data_rights_events_block_mutation', 'voice_tool_audit_block_mutation', 'audit_log_block_mutation', 'callback_requests_sync_status')
   and (p.proacl is null or exists (select 1 from aclexplode(p.proacl) a where a.grantee = 0 or a.grantee = (select oid from pg_roles where rolname = 'anon')));
rollback;

\echo '=== S11b. QA-R1-seguridad-11: demo_limpiar ya no fija public en su search_path ==='
begin;
select count(*)::int as demo_limpiar_con_public_deberia_ser_0
  from pg_proc p where p.oid = 'restaurantes.demo_limpiar(uuid, text, integer)'::regprocedure
   and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%public%');
rollback;

-- ---------------------------------------------------------------------------------------------------------------
-- Privacidad: cancelacion ARCO ejecutable (06), cruce entre canales (10), retencion completa (07) y lote lleno (14).
-- ---------------------------------------------------------------------------------------------------------------
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0014', 'admin-a@qa.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0015', 'staff-org-a@qa.example.com', 'Staff A (toda la org)', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0014', '00000000-0000-0000-0000-0000000f0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000f0015', '00000000-0000-0000-0000-0000000f0001', null, 'member', 'staff')
on conflict do nothing;

-- Titular de la cancelacion: el MISMO numero con tres formatos (cliente 10 digitos, WhatsApp +521..., voz +52...).
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-0000000f0001', '9991230001', 'Titular Cancelacion', 2),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-0000000f0001', '9991230002', 'Otro Cliente', 1)
on conflict do nothing;
insert into restaurantes.customer_addresses (customer_id, address) values
  ('00000000-0000-0000-0000-0000000f1001', 'Calle 1 #123'),
  ('00000000-0000-0000-0000-0000000f1002', 'Calle 2 #456');
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, customer_email, total, items, source, status, notes) values
  ('00000000-0000-0000-0000-0000000f1011', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f1001', 'Titular Cancelacion', '9991230001', 'Calle 1 #123', 'titular@example.com', 310, '[]'::jsonb, 'whatsapp', 'entregado', 'sin cebolla'),
  ('00000000-0000-0000-0000-0000000f1012', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f1002', 'Otro Cliente', '9991230002', 'Calle 2 #456', null, 99, '[]'::jsonb, 'web', 'entregado', null)
on conflict do nothing;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages) values
  ('00000000-0000-0000-0000-0000000f1021', '00000000-0000-0000-0000-0000000f0001', '+5219991230001', '00000000-0000-0000-0000-0000000f00a1', '[{"role":"user","text":"hola"}]'::jsonb),
  ('00000000-0000-0000-0000-0000000f1022', '00000000-0000-0000-0000-0000000f0001', '+5219991230002', '00000000-0000-0000-0000-0000000f00a1', '[{"role":"user","text":"hola"}]'::jsonb)
on conflict do nothing;
insert into restaurantes.callback_requests (id, organization_id, property_id, customer_name, customer_phone, message) values
  ('00000000-0000-0000-0000-0000000f1031', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Titular Cancelacion', '9991230001', 'quiero hablar'),
  ('00000000-0000-0000-0000-0000000f1032', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Otro Cliente', '9991230002', 'quiero hablar')
on conflict do nothing;
insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status) values
  ('00000000-0000-0000-0000-0000000f0001', 'whatsapp', 'order.status.entregado', 'order-status:00000000-0000-0000-0000-0000000f1011:entregado', '{"to":"+529991230001","body":"Tu pedido va en camino"}'::jsonb, 'sent'),
  ('00000000-0000-0000-0000-0000000f0001', 'whatsapp', 'order.status.entregado', 'order-status:00000000-0000-0000-0000-0000000f1012:entregado', '{"to":"+529991230002","body":"Tu pedido va en camino"}'::jsonb, 'sent');
-- Llamada del titular: caller_hash = sha256 de los digitos del identificador de llamada ("52" + 10 digitos).
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values
  ('00000000-0000-0000-0000-0000000f1041', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'call-titular', 'llamada', 'elevenlabs-agents',
   encode(sha256(convert_to('529991230001', 'UTF8')), 'hex'), now() - interval '2 days', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000f1042', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'call-otro', 'llamada', 'elevenlabs-agents',
   encode(sha256(convert_to('529991230002', 'UTF8')), 'hex'), now() - interval '2 days', now() - interval '2 days')
on conflict do nothing;
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values
  ('00000000-0000-0000-0000-0000000f1041', '00000000-0000-0000-0000-0000000f0001', 1, 'cliente', 'mi nombre es Titular'),
  ('00000000-0000-0000-0000-0000000f1042', '00000000-0000-0000-0000-0000000f0001', 1, 'cliente', 'mi nombre es Otro');
-- Solicitud de cancelacion YA confirmada (recibida) hecha por WhatsApp (formato +521...).
insert into restaurantes.data_rights_requests (id, organization_id, customer_phone, right_type, channel, status, confirmed_at, response_due_at, execution_due_at) values
  ('00000000-0000-0000-0000-0000000f1051', '00000000-0000-0000-0000-0000000f0001', '+5219991230001', 'cancelacion', 'whatsapp', 'recibida', now(), now() + interval '20 days', now() + interval '35 days');

\echo '=== P12. Positivo: el admin resuelve la cancelacion y los datos del titular quedan ANONIMIZADOS (pedido) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok');
reset role;
select count(*)::int as pedidos_con_telefono_del_titular_deberia_ser_0 from restaurantes.orders where customer_phone = '9991230001' or customer_name = 'Titular Cancelacion' or customer_email = 'titular@example.com' or customer_address = 'Calle 1 #123';
rollback;

\echo '=== P12b. La cancelacion conserva el importe del pedido (contabilidad) pero sin datos personales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok');
reset role;
select count(*)::int as pedido_conserva_importe_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000f1011' and total = 310 and customer_phone = 'anonimizado' and notes is null and customer_id is null;
rollback;

\echo '=== P12c. La cancelacion borra direcciones, anonimiza al cliente, vacia la conversacion de WhatsApp y anonimiza la solicitud de contacto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok');
reset role;
select (
  (select count(*) from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000f1001')
  + (select count(*) from restaurantes.customers where id = '00000000-0000-0000-0000-0000000f1001' and (name is not null or phone = '9991230001'))
  + (select count(*) from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000f1021' and (messages <> '[]'::jsonb or phone = '+5219991230001'))
  + (select count(*) from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000f1031' and (customer_phone <> 'anonimizado' or message is not null))
)::int as restos_del_titular_deberia_ser_0;
rollback;

\echo '=== P12d. La cancelacion cruza canales: borra la cola de mensajes y la voz del MISMO titular (+52 sin el 1 de WhatsApp) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok');
reset role;
select (
  (select count(*) from restaurantes.messaging_outbox where payload ->> 'to' = '+529991230001')
  + (select count(*) from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000f1041')
  + (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f1041' and caller_hash is not null)
)::int as cola_y_voz_del_titular_deberia_ser_0;
rollback;

\echo '=== P12e. La cancelacion NO toca a otro titular (cliente, pedido, conversacion, cola y voz siguen intactos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok');
reset role;
select (
  (select count(*) from restaurantes.customers where id = '00000000-0000-0000-0000-0000000f1002' and name = 'Otro Cliente')
  + (select count(*) from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000f1002')
  + (select count(*) from restaurantes.orders where id = '00000000-0000-0000-0000-0000000f1012' and customer_phone = '9991230002')
  + (select count(*) from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000f1022' and messages <> '[]'::jsonb)
  + (select count(*) from restaurantes.messaging_outbox where payload ->> 'to' = '+529991230002')
  + (select count(*) from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000f1042')
)::int as otro_titular_intacto_deberia_ser_6;
rollback;

\echo '=== P12f. La cancelacion deja evidencia en la bitacora ARCO (conteos, sin telefono) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok');
select count(*)::int as evidencia_de_cancelacion_deberia_ser_1 from restaurantes.data_rights_events where request_id = '00000000-0000-0000-0000-0000000f1051' and actor_kind = 'sistema' and note like 'Cancelacion ejecutada:%' and note not like '%9991230001%';
rollback;

\echo '=== P13. Bloquear una cancelacion saca del uso las direcciones y la conversacion, pero CONSERVA el pedido y el cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0014', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'bloqueada', 'plazo de conservacion');
reset role;
select (
  (select count(*) from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000f1001')
  + (select count(*) from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000f1021' and messages <> '[]'::jsonb)
  + (select count(*) from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000f1041')
  + 2 - (select count(*) from restaurantes.orders where id = '00000000-0000-0000-0000-0000000f1011' and customer_phone = '9991230001')
  - (select count(*) from restaurantes.customers where id = '00000000-0000-0000-0000-0000000f1001' and name = 'Titular Cancelacion')
)::int as bloqueo_quita_uso_y_conserva_registro_deberia_ser_0;
rollback;

\echo '=== S06b. QA-R1-seguridad-06: un staff (no owner/admin) NO resuelve una solicitud ARCO ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0015', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok') as should_fail;
rollback;

\echo '=== S06c. QA-R1-seguridad-06: el owner de OTRA organizacion NO resuelve la solicitud de A (cross-tenant) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0021', true);
select * from restaurantes.update_data_rights_request_status('00000000-0000-0000-0000-0000000f0021'::uuid, '00000000-0000-0000-0000-0000000f1051', 'resuelta', 'ok') as should_fail;
rollback;

\echo '=== S06d. QA-R1-seguridad-06: anon no ejecuta la resolucion ni la funcion interna de supresion ==='
begin;
-- as should_fail (sin alias)
set local role anon;
select restaurantes.arco_ejecutar_cancelacion('00000000-0000-0000-0000-0000000f0001', '+5219991230001', 'supresion', '{}') as should_fail;
rollback;

\echo '=== S06e. QA-R1-seguridad-06: ni el staff autenticado ejecuta la funcion interna de supresion directamente ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select restaurantes.arco_ejecutar_cancelacion('00000000-0000-0000-0000-0000000f0001', '+5219991230001', 'supresion', '{}') as should_fail;
rollback;

-- Datos vencidos para la retencion (todos de A; los de la solicitud ARCO abierta deben quedar protegidos).
insert into restaurantes.callback_requests (id, organization_id, property_id, customer_name, customer_phone, message, created_at) values
  ('00000000-0000-0000-0000-0000000f2001', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Vencido Uno', '9995550001', 'hola', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000f2002', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Vencido Dos', '9995550002', 'hola', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000f2003', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'Protegido ARCO', '9995550003', 'hola', now() - interval '400 days')
on conflict do nothing;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages, updated_at) values
  ('00000000-0000-0000-0000-0000000f2011', '00000000-0000-0000-0000-0000000f0001', '+5219995550003', '00000000-0000-0000-0000-0000000f00a1', '[{"role":"user","text":"hola"}]'::jsonb, now() - interval '400 days')
on conflict do nothing;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values
  ('00000000-0000-0000-0000-0000000f2021', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'call-vencida', 'llamada', 'elevenlabs-agents',
   encode(sha256(convert_to('529995550003', 'UTF8')), 'hex'), now() - interval '400 days', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000f2022', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'call-vencida-libre', 'llamada', 'elevenlabs-agents',
   encode(sha256(convert_to('529995550004', 'UTF8')), 'hex'), now() - interval '400 days', now() - interval '400 days')
on conflict do nothing;
insert into restaurantes.voice_tool_audit (id, organization_id, tool, outcome, phone_hash, created_at) values
  ('00000000-0000-0000-0000-0000000f2031', '00000000-0000-0000-0000-0000000f0001', 'nearest_branch', 'denied', repeat('a', 64), now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000f2032', '00000000-0000-0000-0000-0000000f0001', 'nearest_branch', 'ok', repeat('b', 64), now())
on conflict do nothing;
insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, created_at) values
  ('00000000-0000-0000-0000-0000000f0001', 'whatsapp', 'order.status.entregado', 'order-status:viejo:entregado', '{"to":"+529995550009","body":"Tu pedido"}'::jsonb, 'sent', now() - interval '60 days');
-- Solicitud ARCO ABIERTA por VOZ (+52 sin el 1) para el 9995550003: protege el mismo numero en WhatsApp y en voz.
insert into restaurantes.data_rights_requests (id, organization_id, customer_phone, right_type, channel, status, confirmed_at, response_due_at, execution_due_at) values
  ('00000000-0000-0000-0000-0000000f2041', '00000000-0000-0000-0000-0000000f0001', '+529995550003', 'acceso', 'voice', 'en_proceso', now(), now() + interval '20 days', now() + interval '35 days');

\echo '=== P14. Retencion: la purga anonimiza las solicitudes de contacto vencidas (2 de 3: la tercera esta protegida por ARCO) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_callbacks_anonymized as callbacks_anonimizados_deberia_ser_2 from restaurantes.system_purge_expired_privacy_data(500, '{}'::text[]);
rollback;

\echo '=== P14b. Retencion: el mismo numero con solicitud ARCO abierta por voz queda protegido en WhatsApp (cruce de canales) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as purga_ejecutada from restaurantes.system_purge_expired_privacy_data(500, '{}'::text[]);
reset role;
select count(*)::int as conversacion_protegida_conserva_mensajes_deberia_ser_1 from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000f2011' and messages <> '[]'::jsonb;
rollback;

\echo '=== P14c. Retencion: la llamada vencida del titular protegido conserva su caller_hash y la otra se anonimiza ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as purga_ejecutada from restaurantes.system_purge_expired_privacy_data(500, '{}'::text[]);
reset role;
select (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f2021' and caller_hash is not null)
     + (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f2022' and caller_hash is null) as llamadas_bien_tratadas_deberia_ser_2;
rollback;

\echo '=== P14d. Retencion: la bitacora de voz vencida se borra y la reciente se conserva; la cola de mensajes vieja pierde su payload ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as purga_ejecutada from restaurantes.system_purge_expired_privacy_data(500, '{}'::text[]);
reset role;
select (select count(*) from restaurantes.voice_tool_audit where id = '00000000-0000-0000-0000-0000000f2031')
     + (select count(*) from restaurantes.voice_tool_audit where id = '00000000-0000-0000-0000-0000000f2032') * 2
     + (select count(*) from restaurantes.messaging_outbox where dedupe_key = 'order-status:viejo:entregado' and payload = '{}'::jsonb) * 4 as auditoria_y_cola_deberia_ser_6;
rollback;

\echo '=== P14e. QA-R1-seguridad-14: con el lote lleno la purga avisa que queda trabajo pendiente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_pendiente::int as lote_lleno_avisa_pendiente_deberia_ser_1 from restaurantes.system_purge_expired_privacy_data(1, '{}'::text[]);
rollback;

\echo '=== P14f. QA-R1-seguridad-14: la firma anterior de 1 argumento sigue devolviendo sus 3 columnas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_conversations_cleared, out_voice_turns_deleted, out_voice_calls_anonymized from restaurantes.system_purge_expired_privacy_data(500);
rollback;

\echo '=== S07. QA-R1-seguridad-07: la purga es solo de sistema (staff autenticado rechazado) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select * from restaurantes.system_purge_expired_privacy_data(500, '{}'::text[]) as should_fail;
rollback;

\echo '=== S07b. QA-R1-seguridad-07: la bitacora de voz sigue siendo append-only fuera de la purga (DELETE directo rechazado por el trigger) ==='
begin;
-- as should_fail (sin alias)
delete from restaurantes.voice_tool_audit where id = '00000000-0000-0000-0000-0000000f2031' returning id as should_fail;
rollback;

\echo '=== S07c. QA-R1-seguridad-07: la bitacora de voz sigue sin permitir UPDATE ni con el parametro de purga ==='
begin;
-- as should_fail (sin alias)
select set_config('restaurantes.purga_privacidad', 'on', true);
update restaurantes.voice_tool_audit set detail = 'x' where id = '00000000-0000-0000-0000-0000000f2031' returning id as should_fail;
rollback;

\echo '=== S07d. QA-R1-seguridad-07: staff autenticado no puede borrar la bitacora de voz aunque fije el parametro de purga (sin GRANT) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select set_config('restaurantes.purga_privacidad', 'on', true);
delete from restaurantes.voice_tool_audit where id = '00000000-0000-0000-0000-0000000f2031' returning id as should_fail;
rollback;

\echo '=== P15. La lista de telefonos con solicitud ARCO abierta es solo de sistema y devuelve la solicitud abierta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as solicitudes_abiertas_deberia_ser_2 from restaurantes.system_list_open_arco_phones(100);
rollback;

\echo '=== S15b. La lista de telefonos con solicitud ARCO abierta rechaza al staff autenticado ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select * from restaurantes.system_list_open_arco_phones(100) as should_fail;
rollback;

-- ═══ Purga de PLATAFORMA (core.system_run_retention_purge, cron /internal/plataforma/privacidad-retencion) ═══
-- Misma proteccion de titulares con ARCO abierta que la purga de restaurantes. El caller_hash sha256('hmac-simulado-...') representa
-- el seudonimo HMAC (ACTOR_HASH_KEY) que la base no puede recalcular: solo lo reconoce si el servidor lo pasa.
\echo '=== P16. Plataforma/voz: la llamada vencida con seudonimo HMAC del titular con ARCO abierta CONSERVA su hash si el servidor lo pasa ==='
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values
  ('00000000-0000-0000-0000-0000000f2023', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'call-hmac', 'llamada', 'elevenlabs-agents',
   encode(sha256(convert_to('hmac-simulado-9995550003', 'UTF8')), 'hex'), now() - interval '400 days', now() - interval '400 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as purga_ejecutada from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f0001', 'restaurantes_voz_transcripciones', false, 500, array[encode(sha256(convert_to('hmac-simulado-9995550003', 'UTF8')), 'hex')]);
reset role;
select (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f2023' and caller_hash is not null)
     + (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f2021' and caller_hash is not null)
     + (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f2022' and caller_hash is null) as plataforma_voz_bien_tratada_deberia_ser_3;
rollback;

\echo '=== P16b. Plataforma/voz: SIN la lista del servidor el seudonimo HMAC no se reconoce (por eso la ruta TypeScript la pasa) y la llamada libre se anonimiza ==='
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values
  ('00000000-0000-0000-0000-0000000f2023', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'call-hmac', 'llamada', 'elevenlabs-agents',
   encode(sha256(convert_to('hmac-simulado-9995550003', 'UTF8')), 'hex'), now() - interval '400 days', now() - interval '400 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as purga_ejecutada from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f0001', 'restaurantes_voz_transcripciones', false, 500, null);
reset role;
select (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f2023' and caller_hash is null)
     + (select count(*) from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000f2021' and caller_hash is not null) as sha256_plano_sigue_protegido_deberia_ser_2;
rollback;

\echo '=== P16c. Plataforma/voz: una llamada vencida SIN caller_hash pero con turnos se purga (el NOT con hash nulo no la excluye) ==='
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at) values
  ('00000000-0000-0000-0000-0000000f2024', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', 'call-sin-hash', 'llamada', 'elevenlabs-agents',
   null, now() - interval '400 days', now() - interval '400 days');
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values
  ('00000000-0000-0000-0000-0000000f2024', '00000000-0000-0000-0000-0000000f0001', 0, 'cliente', 'hola');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as purga_ejecutada from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f0001', 'restaurantes_voz_transcripciones', false, 500, array[encode(sha256(convert_to('hmac-simulado-9995550003', 'UTF8')), 'hex')]);
reset role;
select count(*)::int as turnos_sin_hash_borrados_deberia_ser_0 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000f2024';
rollback;

\echo '=== P16d. Plataforma/WhatsApp: la conversacion +521 del titular con ARCO abierta por voz (+52) queda protegida (cruce por telefono_clave) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as purga_ejecutada from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f0001', 'restaurantes_whatsapp_conversaciones', false, 500, null);
reset role;
select count(*)::int as conversacion_protegida_conserva_mensajes_deberia_ser_1 from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000f2011' and messages <> '[]'::jsonb;
rollback;

\echo '=== P16e. Plataforma: la firma anterior de 4 argumentos sigue funcionando y la simulacion cuenta la protegida ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (out_status = 'simulacion' and out_rows_protected = 1)::int as firma_de_4_argumentos_deberia_ser_1 from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f0001', 'restaurantes_voz_transcripciones', true, 500);
rollback;

\echo '=== S16f. Plataforma: la purga de 5 argumentos rechaza al staff autenticado (solo sistema) ==='
begin;
-- as should_fail (sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select * from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f0001', 'restaurantes_voz_transcripciones', false, 500, array['x']) as should_fail;
rollback;

\echo '=== S16g. Plataforma: anon no ejecuta ni la firma de 5 argumentos ni el envoltorio de 4 ==='
begin;
-- as should_fail (sin alias)
set local role anon;
select (select count(*) from core.system_run_retention_purge('00000000-0000-0000-0000-0000000f0001', 'restaurantes_voz_transcripciones', true, 500, null)) as should_fail;
rollback;
