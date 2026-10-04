-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/034_pedidos_programados.sql:
--
--   A. restaurantes.orders / create_order_idempotent: pedido `programado` (positivo), pedido normal intacto,
--      hora pasada rechazada, idempotencia, solo sistema, anon, CHECKs.
--   B. restaurantes.promover_pedidos_programados: promocion de los vencidos (positivo), idempotencia (la
--      segunda ejecucion no promueve nada), un pedido cancelado u otro estado no se promueve, un futuro no
--      se promueve, staff ignora el reloj que manda, anticipacion, alcance por sucursal, barrido global solo
--      de sistema, cross-tenant y anon.
--   C. Cancelacion de un programado por el staff y cross-tenant de lectura/escritura.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`:
-- un escenario "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0001', 'restaurantes', 'PP Org A', 'pp-org-a'),
  ('00000000-0000-0000-0000-0000000e0002', 'restaurantes', 'PP Org B (ajena)', 'pp-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'pp-a1'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'pp-b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0011', 'owner-a@pp.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0013', 'staff-a@pp.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0014', 'owner-b@pp.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0011', '00000000-0000-0000-0000-0000000e0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e0013', '00000000-0000-0000-0000-0000000e0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e0014', '00000000-0000-0000-0000-0000000e0002', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000e00c1', '00000000-0000-0000-0000-0000000e0001', '+5219991230001', 'Cliente A')
on conflict do nothing;

-- Pedidos de la organizacion A: uno programado dentro de la anticipacion (+10 min), uno programado vencido
-- (hace 2 h, p. ej. nadie abrio el panel), uno programado lejano (+3 h), uno CANCELADO que conserva su hora
-- (+5 min) y uno normal en `pending`. Y uno programado dentro de la anticipacion en la organizacion B.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, programado_para) values
  ('00000000-0000-0000-0000-0000000e00e1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Prog Proximo', '+5219991230001', 200, 'programado', '[]'::jsonb, 'web', now() + interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000e00e2', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Prog Vencido', '+5219991230001', 200, 'programado', '[]'::jsonb, 'web', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000e00e3', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Prog Lejano', '+5219991230001', 200, 'programado', '[]'::jsonb, 'web', now() + interval '3 hours'),
  ('00000000-0000-0000-0000-0000000e00e4', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Prog Cancelado', '+5219991230001', 200, 'cancelado', '[]'::jsonb, 'web', now() + interval '5 minutes'),
  ('00000000-0000-0000-0000-0000000e00e5', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Pedido Normal', '+5219991230001', 200, 'pending', '[]'::jsonb, 'web', null),
  ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00b1', 'Prog Org B', '+5219991230009', 200, 'programado', '[]'::jsonb, 'web', now() + interval '10 minutes')
on conflict do nothing;

-- ===========================================================================
-- A. orders / create_order_idempotent
-- ===========================================================================
\echo '=== A1. POSITIVO: create_order_idempotent (sistema) con programado_para futuro crea el pedido en estado programado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((r->>'status') = 'programado' and (r->>'programado_para') is not null)::int as programado_creado_deberia_ser_1
from (select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web', 'programado_para', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
  repeat('a', 64)) as r) t;
rollback;

\echo '=== A2. POSITIVO (compatibilidad): un payload SIN programado_para sigue creando el pedido en pending ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select ((r->>'status') = 'pending' and (r->>'programado_para') is null)::int as pending_normal_deberia_ser_1
from (select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web'),
  repeat('b', 64)) as r) t;
rollback;

\echo '=== A3. RECHAZADO (debe fallar): programado_para en el pasado (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web', 'programado_para', to_char(now() - interval '1 hour', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
  repeat('c', 64)) as should_fail;
rollback;

\echo '=== A4. IDEMPOTENCIA: dos llamadas con la misma llave crean UN solo pedido programado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web', 'programado_para', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
  repeat('d', 64), repeat('1', 64)) is not null as primera;
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web', 'programado_para', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
  repeat('d', 64), repeat('1', 64)) is not null as segunda;
reset role;
select count(*)::int as pedidos_con_la_llave_deberia_ser_1 from restaurantes.orders where idempotency_key = repeat('1', 64);
rollback;

\echo '=== A5. IDEMPOTENCIA SIN LLAVE: el dedupe de 5 minutos tambien reconoce un pedido programado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web', 'programado_para', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
  repeat('e', 64)) is not null as primera;
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web', 'programado_para', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
  repeat('e', 64)) is not null as segunda;
reset role;
select count(*)::int as pedidos_con_el_fingerprint_deberia_ser_1 from restaurantes.orders where dedupe_fingerprint = repeat('e', 64);
rollback;

\echo '=== A6. RECHAZADO (debe fallar): un staff autenticado (auth.uid no nulo) no puede llamar create_order_idempotent ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web', 'programado_para', to_char(now() + interval '2 hours', 'YYYY-MM-DD"T"HH24:MI:SSOF')),
  repeat('f', 64)) as should_fail;
rollback;

\echo '=== A7. RECHAZADO (debe fallar): anon no puede llamar create_order_idempotent ==='
begin;
set local role anon;
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000e0001', 'customer_id', '00000000-0000-0000-0000-0000000e00c1',
    'customer_name', 'X', 'customer_phone', '+5219991230001', 'branch', 'S', 'property_id', '00000000-0000-0000-0000-0000000e00a1',
    'total', 1, 'items', '[]'::jsonb, 'source', 'web'),
  repeat('9', 64)) as should_fail;
rollback;

\echo '=== A8. RECHAZADO (debe fallar): marcar un pedido como programado SIN programado_para viola el CHECK ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
update restaurantes.orders set status = 'programado' where id = '00000000-0000-0000-0000-0000000e00e5' returning 1 as should_fail;
rollback;

\echo '=== A9. RECHAZADO (debe fallar): promovido_at sin programado_para viola el CHECK ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
update restaurantes.orders set promovido_at = now() where id = '00000000-0000-0000-0000-0000000e00e5' returning 1 as should_fail;
rollback;

\echo '=== A10. RECHAZADO (debe fallar): un estado inventado sigue prohibido por el CHECK ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
update restaurantes.orders set status = 'se_lo_comio_el_perro' where id = '00000000-0000-0000-0000-0000000e00e5' returning 1 as should_fail;
rollback;

\echo '=== A11. RECHAZADO (debe fallar): anon no lee pedidos (ni programado_para) ==='
begin;
set local role anon;
select programado_para as should_fail from restaurantes.orders;
rollback;

-- ===========================================================================
-- B. promover_pedidos_programados
-- ===========================================================================
\echo '=== B1. POSITIVO: sistema promueve los programados de A dentro de la anticipacion y los vencidos (2), no el lejano ni el cancelado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30)) as promovidos_deberia_ser_2;
rollback;

\echo '=== B2. IDEMPOTENCIA: la segunda ejecucion no promueve nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30)) as primera;
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30)) as segunda_deberia_ser_0;
rollback;

\echo '=== B3. Los promovidos quedan en pending con promovido_at; el cancelado y el lejano no cambian ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30)) as promovidos;
reset role;
select (
  (select status = 'pending' and promovido_at is not null from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e00e1')
  and (select status = 'pending' and promovido_at is not null from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e00e2')
  and (select status = 'programado' and promovido_at is null from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e00e3')
  and (select status = 'cancelado' and promovido_at is null from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e00e4')
  and (select status = 'pending' and promovido_at is null from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e00e5')
)::int as estados_finales_correctos_deberia_ser_1;
rollback;

\echo '=== B4. NO SE PROMUEVE UN CANCELADO: el staff cancela el proximo y la promocion solo toma el vencido (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
update restaurantes.orders set status = 'cancelado' where id = '00000000-0000-0000-0000-0000000e00e1' and status = 'programado' returning id, status;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30)) as promovidos_tras_cancelar_deberia_ser_1;
rollback;

\echo '=== B5. POSITIVO: un staff de A promueve los de SU organizacion e ignora el reloj que manda (p_now a 10 dias): el lejano NO se promueve ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', now() + interval '10 days', 30)) as staff_promueve_solo_vencidos_deberia_ser_2;
rollback;

\echo '=== B6. RECHAZADO (debe fallar): un staff de A no promueve los pedidos de la organizacion B (cross-tenant) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0002', null, 30) as should_fail;
rollback;

\echo '=== B7. RECHAZADO (debe fallar): el owner de B no promueve los pedidos de A (cross-tenant) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30) as should_fail;
rollback;

\echo '=== B8. RECHAZADO (debe fallar): un staff no puede pedir el barrido global (organizacion nula = solo sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.promover_pedidos_programados(null, null, 30) as should_fail;
rollback;

\echo '=== B9. RECHAZADO (debe fallar): anon no puede ejecutar promover_pedidos_programados ==='
begin;
set local role anon;
select restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30) as should_fail;
rollback;

\echo '=== B10. POSITIVO: el barrido de sistema (organizacion nula) promueve los vencidos de TODAS las organizaciones (A: 2, B: 1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados(null, null, 30)) as barrido_global_deberia_ser_3;
rollback;

\echo '=== B11. ALCANCE POR SUCURSAL: filtrar por una sucursal de otra organizacion no promueve nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30, array['00000000-0000-0000-0000-0000000e00b1']::uuid[])) as promovidos_deberia_ser_0;
rollback;

\echo '=== B12. ANTICIPACION 0: solo se promueve el ya vencido (1), no el que falta 10 minutos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 0)) as promovidos_deberia_ser_1;
rollback;

\echo '=== B13. RELOJ DE SISTEMA: con p_now dentro de 4 horas el pedido lejano tambien vence (3 en A) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', now() + interval '4 hours', 30)) as promovidos_deberia_ser_3;
rollback;

-- ===========================================================================
-- C. Cancelacion y cross-tenant de lectura/escritura
-- ===========================================================================
\echo '=== C1. POSITIVO: el staff de A cancela un pedido programado (RLS + GRANT de status existentes) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
update restaurantes.orders set status = 'cancelado' where id = '00000000-0000-0000-0000-0000000e00e3' and status = 'programado' returning id, status;
rollback;

\echo '=== C2. CROSS-TENANT: el owner de B no cancela un programado de A (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
with actualizado as (
  update restaurantes.orders set status = 'cancelado' where id = '00000000-0000-0000-0000-0000000e00e3' returning id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== C3. CROSS-TENANT LECTURA: el owner de B ve 0 pedidos programados de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as programados_visibles_cross_tenant_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e0001' and status = 'programado';
rollback;

-- ===========================================================================
-- D. Sucursal desactivada (041): sus programados no se promueven en silencio
-- ===========================================================================
\echo '=== D1. SUCURSAL DESACTIVADA: el barrido de sistema no promueve los programados de A (sucursal A1 inactiva); solo el de B (1) ==='
begin;
update core.property set status = 'inactive' where id = '00000000-0000-0000-0000-0000000e00a1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados(null, null, 30)) as barrido_global_deberia_ser_1;
rollback;

\echo '=== D2. SUCURSAL DESACTIVADA: ni siquiera con el reloj de sistema adelantado 4 h se promueve un programado de A (0) ==='
begin;
update core.property set status = 'inactive' where id = '00000000-0000-0000-0000-0000000e00a1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', now() + interval '4 hours', 30)) as promovidos_deberia_ser_0;
rollback;

\echo '=== D3. SUCURSAL DESACTIVADA: el staff de A tampoco promueve desde el panel (0) y el pedido sigue en programado ==='
begin;
update core.property set status = 'inactive' where id = '00000000-0000-0000-0000-0000000e00a1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30)) as promovidos_deberia_ser_0;
rollback;

\echo '=== D4. REACTIVADA: al volver a active el programado vencido de A si se promueve (positivo: 2 en A, los vencidos) ==='
begin;
update core.property set status = 'inactive' where id = '00000000-0000-0000-0000-0000000e00a1';
update core.property set status = 'active' where id = '00000000-0000-0000-0000-0000000e00a1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30)) as promovidos_deberia_ser_2;
rollback;

\echo '=== D5. SUCURSAL INACTIVA Y ORGANIZACION B: el cambio no cruza tenants (B sigue promoviendo su programado: 1) ==='
begin;
update core.property set status = 'inactive' where id = '00000000-0000-0000-0000-0000000e00a1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0002', null, 30)) as promovidos_deberia_ser_1;
rollback;

\echo '=== D6. RECHAZADO (debe fallar): anon sigue sin poder ejecutar la funcion tras 041 ==='
begin;
set local role anon;
select restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-0000000e0001', null, 30) as should_fail;
rollback;
