-- Verifica contra Postgres REAL (GRANT/RLS/auth.uid() reales) la migracion 097: restaurantes.registrar_acceso.
--   1. repartidor real de la org A registra 'pii.llamar' en su sucursal -> devuelve 1, 2 (conteo por actor/accion/entidad); la fila
--      queda con entity_type 'acceso' y NUNCA guarda un telefono.
--   2. sucursal fuera de su alcance (property_ids acotado) -> 42501.
--   3. cross-tenant (owner de la org B sobre la org A) -> 42501.
--   4. sin sesion (auth.uid() nulo) -> 28000; anon sin EXECUTE.
--   5. accion fuera del catalogo cerrado -> 22023.
--   6. la bitacora de accesos la LEEN owner/admin, no staff ni repartidor (RLS de 019).
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
  ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000f9', 'Cliente', '9990000001', 100, '[]')
on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone) values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000d1', '9990000002') on conflict do nothing;

\echo '--- 1. repartidor registra dos llamadas: conteo 1 y 2 (deberia_ser_1, deberia_ser_2) y la fila es de tipo acceso ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null) as deberia_ser_1;
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null) as deberia_ser_2;
reset role;
select count(*) as deberia_ser_2 from restaurantes.audit_log where entity_type = 'acceso' and actor_user_id = '00000000-0000-0000-0000-000000000033';
rollback;

\echo '--- 2. should_fail (42501): sucursal fuera del alcance acotado del repartidor ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2', 'pii.llamar', null, null);
rollback;

\echo '--- 3. should_fail (42501): owner de la org B sobre la org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000034', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', null, null);
rollback;

\echo '--- 4. should_fail: sin sesion (28000) y anon (permission denied) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', null, null);
rollback;
begin;
set local role anon;
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', null, null);
rollback;

\echo '--- 5. should_fail (22023): accion fuera del catalogo cerrado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.inventada', null, null);
rollback;

\echo '--- 6. lectura: owner ve la fila (deberia_ser_1); staff y repartidor ven 0 ---'
insert into restaurantes.audit_log (organization_id, actor_user_id, action, entity_type, entity_id, campo)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-000000000033', 'pii.llamar', 'acceso', '00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000f1');
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select count(*) as deberia_ser_1 from restaurantes.audit_log where entity_type = 'acceso'; rollback;
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000032', true);
select count(*) as deberia_ser_0 from restaurantes.audit_log where entity_type = 'acceso'; rollback;
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select count(*) as deberia_ser_0 from restaurantes.audit_log where entity_type = 'acceso'; rollback;

\echo '--- 7. entidad de OTRA organizacion o inexistente -> 22023 (cada uno debe terminar en ERROR 22023) ---'
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e9', null); rollback;
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-00000000dead', null); rollback;
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.cliente_ficha', '00000000-0000-0000-0000-0000000000e1', null); rollback; -- un pedido no es un cliente

\echo '--- 8. texto libre: llave invalida (22023); llave valida se guarda en despues ---'
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'telefono 9991234567'); rollback;

\echo '--- 9. idempotencia: misma llave dos veces -> deberia_ser_1 las dos; llave nueva -> deberia_ser_2 ---'
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-uno-abcdef') as deberia_ser_1;
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-uno-abcdef') as deberia_ser_1;
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', 'llave-dos-abcdef') as deberia_ser_2; rollback;

\echo '--- 11. la MISMA llave 20 veces no da acceso ilimitado: el conteo final debe pasar de 5 (REPLAY_ACOTADO deberia_ser_true) ---'
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
do $$ declare i int; n int; begin for i in 1..20 loop n := restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f1', 'pii.llamar', '00000000-0000-0000-0000-0000000000e2', 'llave-abusiva-1'); end loop; raise notice 'REPLAY_ACOTADO ultimo conteo=% deberia_ser_true=%', n, n > 5; end $$;
rollback;

\echo '--- 12. pedido de otra sucursal (22023) y membresia acotada sin sucursal (22023) ---'
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000031', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000f2', 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null); rollback;
begin; set local role authenticated; select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000033', true);
select restaurantes.registrar_acceso('00000000-0000-0000-0000-0000000000d1', null, 'pii.llamar', '00000000-0000-0000-0000-0000000000e1', null); rollback;
