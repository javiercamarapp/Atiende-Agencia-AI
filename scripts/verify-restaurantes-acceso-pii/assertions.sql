-- Verifica contra Postgres REAL (GRANT/RLS/auth.uid() reales) la migracion 097: restaurantes.registrar_acceso.
--   1. repartidor real de la org A registra 'pii.llamar' en su sucursal -> devuelve 1, 2 (conteo por actor/accion/entidad); la fila
--      queda con entity_type 'acceso' y NUNCA guarda un telefono.
--   2. sucursal fuera de su alcance (property_ids acotado) -> 42501.
--   3. cross-tenant (owner de la org B sobre la org A) -> 42501.
--   4. sin sesion (auth.uid() nulo) -> 28000; anon sin EXECUTE.
--   5. accion fuera del catalogo cerrado -> 22023.
--   6. la bitacora de accesos la LEEN owner/admin, no staff ni repartidor (RLS de 019).
--   7-9. entidad de otra organizacion/sucursal (22023), llave libre (22023), idempotencia acotada (misma llave: 10 min y 3 reintentos).
-- Formato del gate (scripts/verify-real-postgres-ci/run-gate.mjs): un `begin; ... rollback;` por escenario con `begin;`/`rollback;` en lineas
-- propias; `as should_fail` marca lo que debe terminar en ERROR y `deberia_ser_N` lo que debe devolver N.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000d1', 'restaurantes', 'Org A (acceso pii)', 'org-a-acceso-pii'),
  ('00000000-0000-0000-0000-0000000000d2', 'restaurantes', 'Org B (acceso pii, ajena)', 'org-b-acceso-pii')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000031', 'owner-a-pii@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000032', 'staff-a-pii@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-000000000033', 'repartidor-a-pii@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-000000000034', 'owner-b-pii@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000031', '00000000-0000-0000-0000-0000000000d1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000032', '00000000-0000-0000-0000-0000000000d1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000033', '00000000-0000-0000-0000-0000000000d1', array['00000000-0000-0000-0000-0000000000f1']::uuid[], 'member', 'repartidor'),
  ('00000000-0000-0000-0000-000000000034', '00000000-0000-0000-0000-0000000000d2', null, 'owner', 'owner')
on conflict do nothing;

-- Fixtures: pedidos de la org A (e1, e2) y de la B (e9), un cliente de la A (c1). property f1 es de la A.
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000d1', 'restaurantes', 'Suc A1', 'active'),
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000d1', 'restaurantes', 'Suc A2', 'active'),
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000d2', 'restaurantes', 'Suc B1', 'active')
on conflict do nothing;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, items) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'Cliente', '9990000000', 100, '[]'),
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'Cliente', '9990000000', 100, '[]'),
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'Cliente', '9990000000', 100, '[]'),
  ('00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'Cliente', '9990000000', 100, '[]'),
  ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f9', 'Cliente', '9990000001', 100, '[]')
on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '9990000002') on conflict do nothing;

\echo '--- 1. repartidor registra dos llamadas: conteo 1 y 2 (deberia_ser_2) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null) as deberia_ser_2;
rollback;

\echo '--- 1b. la fila es de tipo acceso: 2 filas del repartidor sobre e1 (deberia_ser_2) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null);
reset role;
select count(*) as deberia_ser_2 from restaurantes.audit_log where entity_type = 'acceso' and actor_user_id = '00000000-0000-0000-0000-000000000033' and entity_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 2. should_fail (42501): sucursal fuera del alcance acotado del repartidor -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null) as should_fail;
rollback;

\echo '--- 3. should_fail (42501): owner de la org B sobre la org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', null, null) as should_fail;
rollback;

\echo '--- 4a. should_fail: sin sesion (28000) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', null, null) as should_fail;
rollback;

\echo '--- 4b. should_fail: anon sin EXECUTE -- RECHAZADO ---'
begin;
set local role anon;
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', null, null) as should_fail;
rollback;

\echo '--- 5. should_fail (22023): accion fuera del catalogo cerrado -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.inventada', null, null) as should_fail;
rollback;

insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000033', 'pii.llamar', 'acceso', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1');

\echo '--- 6. lectura RLS: owner ve la fila (deberia_ser_1) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select count(*) as deberia_ser_1 from restaurantes.audit_log where entity_type = 'acceso';
rollback;

\echo '--- 6. lectura RLS: staff no ve filas (deberia_ser_0) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
select count(*) as deberia_ser_0 from restaurantes.audit_log where entity_type = 'acceso';
rollback;

\echo '--- 6. lectura RLS: repartidor no ve filas (deberia_ser_0) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select count(*) as deberia_ser_0 from restaurantes.audit_log where entity_type = 'acceso';
rollback;

\echo '--- 7a. should_fail (22023): pedido de OTRA organizacion -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e9', null) as should_fail;
rollback;

\echo '--- 7b. should_fail (22023): pedido inexistente -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-00000000dead', null) as should_fail;
rollback;

\echo '--- 7c. should_fail (22023): un pedido no es un cliente -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.cliente_ficha', '00000000-0000-0000-0000-0000000000e1', null) as should_fail;
rollback;

\echo '--- 8. should_fail (22023): texto libre como llave -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'telefono 9991234567') as should_fail;
rollback;

\echo '--- 9. idempotencia: misma llave dos veces no consume cupo (deberia_ser_1); llave nueva suma (siguiente escenario) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-uno-abcdef');
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-uno-abcdef') as deberia_ser_1;
rollback;

\echo '--- 9b. llave nueva despues de un reintento: deberia_ser_2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-uno-abcdef');
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-uno-abcdef');
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-dos-abcdef') as deberia_ser_2;
rollback;

\echo '--- 11. la MISMA llave 20 veces no da acceso ilimitado: 1 + 16 reintentos pasados de 3 = deberia_ser_17 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
do $$ begin for i in 1..19 loop perform restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e4', 'llave-abusiva-1'); end loop; end $$;
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e4', 'llave-abusiva-1') as deberia_ser_17;
rollback;

\echo '--- 12a. should_fail (22023): pedido de otra sucursal -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null) as should_fail;
rollback;

\echo '--- 12b. should_fail (22023): membresia acotada sin indicar sucursal -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null) as should_fail;
rollback;

