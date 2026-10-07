-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna reales) de
-- packages/domain-restaurantes/migrations/031_recoger_promociones_automaticas_puentes.sql:
--
--   A. restaurantes.orders: canal/propina/hora_recogida (CHECKs), estados nuevos de recoger,
--      create_order_idempotent (persiste lo nuevo, compatible con payload viejo, solo sistema),
--      cross-tenant y anon.
--   B. restaurantes.promotions: auto_apply (exige canales), tipo cortesia (forma y limites),
--      cross-tenant y anon.
--   C. restaurantes.branch_hours_exception (puentes): positivo, rol insuficiente, property ajena,
--      GRANT por columna, lectura de sistema, cross-tenant, anon y CHECKs.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`:
-- un escenario "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0001', 'restaurantes', 'RP Org A', 'rp-org-a'),
  ('00000000-0000-0000-0000-0000000d0002', 'restaurantes', 'RP Org B (ajena)', 'rp-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000d00a1', '00000000-0000-0000-0000-0000000d0001', 'rp-a1'),
  ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0002', 'rp-b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0011', 'owner-a@rp.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0013', 'staff-a@rp.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0014', 'owner-b@rp.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0011', '00000000-0000-0000-0000-0000000d0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0013', '00000000-0000-0000-0000-0000000d0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000d0014', '00000000-0000-0000-0000-0000000d0002', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001', '+5219991230001', 'Cliente A')
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal, propina) values
  ('00000000-0000-0000-0000-0000000d00e1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', 'Cliente A', '+5219991230001', 200, 'preparando', '[]'::jsonb, 'whatsapp', 'recoger', null)
on conflict do nothing;

insert into restaurantes.promotions (id, organization_id, code, name, type, value, channels, auto_apply, is_active) values
  ('00000000-0000-0000-0000-0000000d00f1', '00000000-0000-0000-0000-0000000d0001', 'LUNES2X1', 'Lunes 2x1 pastor', 'bogo', 1, array['recoger'], true, true)
on conflict do nothing;

insert into restaurantes.branch_hours_exception (id, organization_id, property_id, fecha_desde, fecha_hasta, horario, motivo) values
  ('00000000-0000-0000-0000-0000000d00d1', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '2026-12-12', '2026-12-13',
   '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"16:00"},{"dias":[0,1,2,3,4,5,6],"abre":"18:00","cierra":"01:00"}]'::jsonb, 'Puente fixture')
on conflict do nothing;

-- ===========================================================================
-- A. orders
-- ===========================================================================
\echo '=== A1. POSITIVO: create_order_idempotent (sesion de SISTEMA) persiste canal, propina y hora_recogida ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select r->>'canal' as canal, (r->>'propina')::numeric as propina, r->>'hora_recogida' is not null as con_hora_recogida
from (select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000d0001', 'customer_id', '00000000-0000-0000-0000-0000000d00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000d00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'whatsapp', 'payment_method', 'tarjeta', 'canal', 'recoger', 'propina', 15, 'hora_recogida', '2026-12-12T20:00:00-06:00'),
  repeat('a', 64)) as r) t;
rollback;

\echo '=== A2. POSITIVO (compatibilidad): un payload SIN las llaves nuevas (codigo viejo) sigue creando el pedido con canal null ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select r->>'canal' is null as canal_nulo_deberia_ser_true, r->>'status' as status
from (select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000d0001', 'customer_id', '00000000-0000-0000-0000-0000000d00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000d00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'web'),
  repeat('b', 64)) as r) t;
rollback;

\echo '=== A3. RECHAZADO (debe fallar): create_order_idempotent con un canal invalido (el CHECK lo rechaza) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000d0001', 'customer_id', '00000000-0000-0000-0000-0000000d00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000d00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'whatsapp', 'canal', 'mesa'),
  repeat('c', 64)) as should_fail;
rollback;

\echo '=== A4. RECHAZADO (debe fallar): create_order_idempotent con propina negativa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000d0001', 'customer_id', '00000000-0000-0000-0000-0000000d00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000d00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'whatsapp', 'canal', 'recoger', 'propina', -5),
  repeat('d', 64)) as should_fail;
rollback;

\echo '=== A5. RECHAZADO (debe fallar): un staff autenticado (auth.uid no nulo) no puede llamar create_order_idempotent ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000d0001', 'customer_id', '00000000-0000-0000-0000-0000000d00c1',
    'customer_name', 'Cliente A', 'customer_phone', '+5219991230001', 'branch', 'Sucursal A1', 'property_id', '00000000-0000-0000-0000-0000000d00a1',
    'total', 150, 'items', '[]'::jsonb, 'source', 'whatsapp'),
  repeat('e', 64)) as should_fail;
rollback;

\echo '=== A6. RECHAZADO (debe fallar): anon no puede llamar create_order_idempotent ==='
begin;
set local role anon;
select restaurantes.create_order_idempotent(
  jsonb_build_object('organization_id', '00000000-0000-0000-0000-0000000d0001', 'customer_id', '00000000-0000-0000-0000-0000000d00c1',
    'customer_name', 'X', 'customer_phone', '+5219991230001', 'branch', 'S', 'property_id', '00000000-0000-0000-0000-0000000d00a1',
    'total', 1, 'items', '[]'::jsonb, 'source', 'web'),
  repeat('f', 64)) as should_fail;
rollback;

\echo '=== A7. POSITIVO: staff de A marca el pedido listo_para_recoger y luego no_recogido (estados nuevos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
update restaurantes.orders set status = 'listo_para_recoger' where id = '00000000-0000-0000-0000-0000000d00e1' and status = 'preparando' returning id, status;
update restaurantes.orders set status = 'no_recogido' where id = '00000000-0000-0000-0000-0000000d00e1' and status = 'listo_para_recoger' returning id, status;
rollback;

\echo '=== A8. RECHAZADO (debe fallar): un estado inventado sigue prohibido por el CHECK ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
update restaurantes.orders set status = 'se_lo_comio_el_perro' where id = '00000000-0000-0000-0000-0000000d00e1' returning 1 as should_fail;
rollback;

\echo '=== A9. CROSS-TENANT: owner de B no cambia el estado de un pedido de A (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
with actualizado as (
  update restaurantes.orders set status = 'no_recogido' where id = '00000000-0000-0000-0000-0000000d00e1' returning id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== A10. RECHAZADO (debe fallar): anon no lee pedidos (ni canal ni propina) ==='
begin;
set local role anon;
select canal, propina as should_fail from restaurantes.orders;
rollback;

\echo '=== A11. CROSS-TENANT LECTURA: owner de B ve 0 pedidos de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
select count(*)::int as pedidos_visibles_cross_tenant_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000d0001';
rollback;

-- ===========================================================================
-- B. promotions (PL-23: crear promociones es de owner/admin; la 065 niega al staff, por eso estos escenarios usan al owner)
-- ===========================================================================
\echo '=== B1. POSITIVO: owner de A crea una promocion automatica 2x1 solo para recoger ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, days_of_week, channels, auto_apply)
  values ('00000000-0000-0000-0000-0000000d0001', 'LUNES2X1B', 'Lunes 2x1', 'bogo', 1, array[1]::smallint[], array['recoger'], true)
  returning code, auto_apply, channels;
rollback;

\echo '=== B2. POSITIVO: combo de cortesia (martes nachos de pastor + 2 aguas) con listas y cantidad ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, days_of_week, channels, auto_apply, product_ids, courtesy_product_ids, courtesy_quantity)
  values ('00000000-0000-0000-0000-0000000d0001', 'MARTESNACHOS', 'Martes nachos', 'cortesia', 1, array[2]::smallint[], array['recoger'], true,
          array['00000000-0000-0000-0000-0000000d0f01']::uuid[], array['00000000-0000-0000-0000-0000000d0f02']::uuid[], 2)
  returning code, type, courtesy_quantity;
rollback;

\echo '=== B3. RECHAZADO (debe fallar): una promocion automatica SIN canales explicitos (podria aplicar a domicilio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, auto_apply)
  values ('00000000-0000-0000-0000-0000000d0001', 'SINCANAL', 'Sin canal', 'bogo', 1, true) returning 1 as should_fail;
rollback;

\echo '=== B4. RECHAZADO (debe fallar): cortesia sin lista de cortesia ni cantidad ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids)
  values ('00000000-0000-0000-0000-0000000d0001', 'CORTESIAROTA', 'Cortesia rota', 'cortesia', 1, array['00000000-0000-0000-0000-0000000d0f01']::uuid[]) returning 1 as should_fail;
rollback;

\echo '=== B5. RECHAZADO (debe fallar): cortesia con value distinto de 1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids, courtesy_product_ids, courtesy_quantity)
  values ('00000000-0000-0000-0000-0000000d0001', 'CORTESIAV2', 'Cortesia v2', 'cortesia', 2,
          array['00000000-0000-0000-0000-0000000d0f01']::uuid[], array['00000000-0000-0000-0000-0000000d0f02']::uuid[], 2) returning 1 as should_fail;
rollback;

\echo '=== B6. RECHAZADO (debe fallar): cantidad de cortesia fuera de 1..10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, product_ids, courtesy_product_ids, courtesy_quantity)
  values ('00000000-0000-0000-0000-0000000d0001', 'CORTESIA11', 'Cortesia 11', 'cortesia', 1,
          array['00000000-0000-0000-0000-0000000d0f01']::uuid[], array['00000000-0000-0000-0000-0000000d0f02']::uuid[], 11) returning 1 as should_fail;
rollback;

\echo '=== B7. RECHAZADO (debe fallar): un tipo inventado sigue prohibido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.promotions (organization_id, code, name, type, value)
  values ('00000000-0000-0000-0000-0000000d0001', 'TIPOMALO', 'Tipo malo', 'regalo', 1) returning 1 as should_fail;
rollback;

\echo '=== B8. CROSS-TENANT: owner de B no apaga la promocion automatica de A (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
with actualizado as (
  update restaurantes.promotions set is_active = false where id = '00000000-0000-0000-0000-0000000d00f1' returning id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== B9. RECHAZADO (debe fallar): owner de B declara la organizacion A al crear una promocion automatica ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, channels, auto_apply)
  values ('00000000-0000-0000-0000-0000000d0001', 'AJENA', 'Ajena', 'bogo', 1, array['recoger'], true) returning 1 as should_fail;
rollback;

\echo '=== B10. RECHAZADO (debe fallar): anon no puede escribir promociones ==='
begin;
set local role anon;
insert into restaurantes.promotions (organization_id, code, name, type, value, channels, auto_apply)
  values ('00000000-0000-0000-0000-0000000d0001', 'ANON', 'Anon', 'bogo', 1, array['recoger'], true) returning 1 as should_fail;
rollback;

-- ===========================================================================
-- C. branch_hours_exception (puentes)
-- ===========================================================================
\echo '=== C1. POSITIVO: owner de A crea el puente de una sucursal con los dos turnos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario, motivo)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '2027-05-01', '2027-05-03',
          '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"16:00"},{"dias":[0,1,2,3,4,5,6],"abre":"18:00","cierra":"01:00"}]'::jsonb, 'Puente 1 de mayo')
  returning property_id, fecha_desde, fecha_hasta;
rollback;

\echo '=== C2. RECHAZADO (debe fallar): staff de A (rol staff, no owner/admin) no crea excepciones de horario ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0013', true);
insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '2027-05-01', '2027-05-03', '[]'::jsonb) returning 1 as should_fail;
rollback;

\echo '=== C3. RECHAZADO (debe fallar): owner de B escribe para una property de A declarando SU organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario)
  values ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000d00a1', '2027-05-01', '2027-05-03', '[]'::jsonb) returning 1 as should_fail;
rollback;

\echo '=== C4. RECHAZADO (debe fallar): owner de B declara la organizacion A (no es miembro de A) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '2027-05-01', '2027-05-03', '[]'::jsonb) returning 1 as should_fail;
rollback;

\echo '=== C5. RECHAZADO (debe fallar): GRANT por columna -- ni el owner puede mover una excepcion a otra sucursal (property_id sin UPDATE) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
update restaurantes.branch_hours_exception set property_id = '00000000-0000-0000-0000-0000000d00b1' where id = '00000000-0000-0000-0000-0000000d00d1' returning 1 as should_fail;
rollback;

\echo '=== C6. RECHAZADO (debe fallar): un rango de mas de 31 dias (un puente, no un cambio permanente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '2027-05-01', '2027-07-01', '[]'::jsonb) returning 1 as should_fail;
rollback;

\echo '=== C7. RECHAZADO (debe fallar): fecha_hasta anterior a fecha_desde ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0011', true);
insert into restaurantes.branch_hours_exception (organization_id, property_id, fecha_desde, fecha_hasta, horario)
  values ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d00a1', '2027-05-03', '2027-05-01', '[]'::jsonb) returning 1 as should_fail;
rollback;

\echo '=== C8. LECTURA: sesion de SISTEMA (agente de WhatsApp, sin usuario) lee la excepcion de la sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as filas_visibles_sistema_deberia_ser_1 from restaurantes.branch_hours_exception where property_id = '00000000-0000-0000-0000-0000000d00a1';
rollback;

\echo '=== C9. CROSS-TENANT LECTURA: owner de B ve 0 excepciones de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
select count(*)::int as filas_visibles_cross_tenant_deberia_ser_0 from restaurantes.branch_hours_exception where property_id = '00000000-0000-0000-0000-0000000d00a1';
rollback;

\echo '=== C10. CROSS-TENANT: owner de B no borra la excepcion de A (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0014', true);
with borrado as (
  delete from restaurantes.branch_hours_exception where id = '00000000-0000-0000-0000-0000000d00d1' returning id
)
select count(*)::int as filas_borradas_cross_tenant_deberia_ser_0 from borrado;
rollback;

\echo '=== C11. RECHAZADO (debe fallar): anon no lee excepciones de horario ==='
begin;
set local role anon;
select count(*)::int as should_fail from restaurantes.branch_hours_exception;
rollback;
