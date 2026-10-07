-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/071_agente_lecturas_sistema_cliente_y_pedido.sql
-- (QA-PM-R2-whatsapp-02, P1 de la cuenta real de PM: RLS ocultaba `customers`, `customer_addresses` y `orders` a la sesion de sistema de los
-- agentes, asi que `buscar_cliente` devolvia SIEMPRE isNew:true y "repiteme mi ultimo pedido" respondia "no aparece un pedido anterior").
--
-- ROL Y SESION EXACTOS DE PRODUCCION: `set local role authenticated` + `request.jwt.claim.sub = ''` (auth.uid() NULL), que abre
-- `ManagedPostgresEngine.withAppSession({ userId: null })` para el webhook de WhatsApp y las herramientas de voz.
--
--   A. el defecto: el SELECT directo de la sesion de sistema devuelve 0 filas (con el cliente y su pedido existentes).
--   B. cada funcion devuelve el dato correcto a la sesion de sistema (cliente, direcciones, historial, pedido reciente, pedido por id).
--   C. aislamiento entre organizaciones: el mismo telefono/ids con OTRA organizacion no devuelven nada ajeno.
--   D. staff autenticado y anon: rechazados (solo-sistema / sin EXECUTE).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe terminar en ERROR;
-- `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e1a01', 'restaurantes', 'Lecturas Org A', 'lecturas-org-a'),
  ('00000000-0000-0000-0000-0000000e1a02', 'restaurantes', 'Lecturas Org B', 'lecturas-org-b')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000e1b01', '00000000-0000-0000-0000-0000000e1a01', 'restaurantes', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e1b02', '00000000-0000-0000-0000-0000000e1a02', 'restaurantes', 'Sucursal B1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e1c01', 'lecturas-owner-a@example.com', 'Owner A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e1c01', '00000000-0000-0000-0000-0000000e1a01', null, 'owner', 'owner')
on conflict do nothing;
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1a01', '9992220001', 'Cliente A', 1),
  ('00000000-0000-0000-0000-0000000e1d02', '00000000-0000-0000-0000-0000000e1a02', '9992220001', 'Cliente B (mismo telefono)', 5)
on conflict do nothing;
insert into restaurantes.customer_addresses (customer_id, address, is_default) values
  ('00000000-0000-0000-0000-0000000e1d01', 'Calle 20 #300, Garcia Lavin', true),
  ('00000000-0000-0000-0000-0000000e1d01', 'Calle 5 #10', false)
on conflict do nothing;
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, branch, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000e1f01', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1b01', '00000000-0000-0000-0000-0000000e1d01', 'Cliente A', '+52 999 222 0001', 'Calle 20 #300', 'Sucursal A1', 301, 'entregado', '[{"id":"p1","name":"Taco Al Pastor (individual)","price":42,"quantity":6}]'::jsonb, 'whatsapp', now() - interval '2 days'),
  ('00000000-0000-0000-0000-0000000e1f02', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1b01', '00000000-0000-0000-0000-0000000e1d01', 'Cliente A', '9992220001', null, 'Sucursal A1', 120, 'cancelado', '[{"id":"p2","name":"Horchata","price":60,"quantity":2}]'::jsonb, 'whatsapp', now() - interval '1 hour')
on conflict do nothing;

\echo ''
\echo '=== A) el defecto: la sesion de sistema no ve nada por SELECT directo ==='
\echo ''
\echo '--- 1. SELECT directo de customers con el rol de produccion: 0 filas (RLS) aunque el cliente existe ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as select_directo_clientes_deberia_ser_0 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e1a01' and phone = '9992220001';
rollback;

\echo '--- 2. SELECT directo de orders con el rol de produccion: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as select_directo_pedidos_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e1a01';
rollback;

\echo ''
\echo '=== B) las funciones de lectura devuelven el dato a la sesion de sistema ==='
\echo ''
\echo '--- 3. sistema_buscar_cliente_por_telefono: el cliente y su order_count ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (c->>'id' = '00000000-0000-0000-0000-0000000e1d01' and c->>'name' = 'Cliente A' and (c->>'order_count')::int = 1)::int as cliente_encontrado_deberia_ser_1
from (select restaurantes.sistema_buscar_cliente_por_telefono('00000000-0000-0000-0000-0000000e1a01', '9992220001') as c) s;
rollback;

\echo '--- 4. telefono desconocido: null (cliente nuevo de verdad) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.sistema_buscar_cliente_por_telefono('00000000-0000-0000-0000-0000000e1a01', '9990000000') is null)::int as desconocido_deberia_ser_1;
rollback;

\echo '--- 5. sistema_direcciones_cliente: 2 direcciones, la predeterminada primero ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (jsonb_array_length(d) = 2 and d->0->>'address' = 'Calle 20 #300, Garcia Lavin' and (d->0->>'is_default')::boolean)::int as direcciones_deberia_ser_1
from (select restaurantes.sistema_direcciones_cliente('00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1d01') as d) s;
rollback;

\echo '--- 6. sistema_historial_pedidos_cliente: solo el entregado (el cancelado no es elegible) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (jsonb_array_length(h) = 1 and h->0->'items'->0->>'name' = 'Taco Al Pastor (individual)')::int as historial_deberia_ser_1
from (select restaurantes.sistema_historial_pedidos_cliente('00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1d01') as h) s;
rollback;

\echo '--- 7. sistema_pedido_reciente_por_telefono: encuentra el entregado de hace 2 dias por los ultimos 10 digitos, ignora el cancelado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (p->>'id' = '00000000-0000-0000-0000-0000000e1f01' and (p->>'total')::numeric = 301)::int as pedido_reciente_deberia_ser_1
from (select restaurantes.sistema_pedido_reciente_por_telefono('00000000-0000-0000-0000-0000000e1a01', '9992220001', now() - interval '12 days') as p) s;
rollback;

\echo '--- 8. pedido reciente fuera de la ventana: null ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.sistema_pedido_reciente_por_telefono('00000000-0000-0000-0000-0000000e1a01', '9992220001', now() - interval '1 day') is null)::int as fuera_de_ventana_deberia_ser_1;
rollback;

\echo '--- 9. sistema_pedido_por_id: el pedido de SU organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (p->>'id' = '00000000-0000-0000-0000-0000000e1f01')::int as pedido_por_id_deberia_ser_1
from (select restaurantes.sistema_pedido_por_id('00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1f01') as p) s;
rollback;

\echo ''
\echo '=== C) aislamiento entre organizaciones ==='
\echo ''
\echo '--- 10. el mismo telefono en la Org B es OTRO cliente (no mezcla) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (c->>'id' = '00000000-0000-0000-0000-0000000e1d02' and (c->>'order_count')::int = 5)::int as otra_org_otro_cliente_deberia_ser_1
from (select restaurantes.sistema_buscar_cliente_por_telefono('00000000-0000-0000-0000-0000000e1a02', '9992220001') as c) s;
rollback;

\echo '--- 11. direcciones e historial del cliente de la Org A pedidos con la Org B: vacios ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.sistema_direcciones_cliente('00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e1d01') = '[]'::jsonb
        and restaurantes.sistema_historial_pedidos_cliente('00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e1d01') = '[]'::jsonb)::int as cross_tenant_vacio_deberia_ser_1;
rollback;

\echo '--- 12. pedido de la Org A pedido por id con la Org B: null; y pedido reciente por telefono con la Org B: null ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.sistema_pedido_por_id('00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e1f01') is null
        and restaurantes.sistema_pedido_reciente_por_telefono('00000000-0000-0000-0000-0000000e1a02', '9992220001', now() - interval '12 days') is null)::int as pedido_ajeno_null_deberia_ser_1;
rollback;

\echo ''
\echo '=== D) staff y anon ==='
\echo ''
\echo '--- 13. staff autenticado: rechazado (solo-sistema) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1c01', true);
select restaurantes.sistema_buscar_cliente_por_telefono('00000000-0000-0000-0000-0000000e1a01', '9992220001') as should_fail;
rollback;

\echo '--- 14. anon: sin EXECUTE ---'
begin;
set local role anon;
select restaurantes.sistema_pedido_por_id('00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1f01') as should_fail;
rollback;

\echo '--- 15. el staff SIGUE leyendo directo lo suyo (la policy de 001 no cambio) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1c01', true);
select count(*)::int as staff_ve_sus_clientes_deberia_ser_1 from restaurantes.customers where phone = '9992220001' and organization_id = '00000000-0000-0000-0000-0000000e1a01';
rollback;
