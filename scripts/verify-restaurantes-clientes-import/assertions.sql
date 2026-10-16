-- Verificacion contra Postgres REAL de
-- packages/domain-restaurantes/migrations/054_clientes_cartera_import_y_alerta_comandas.sql:
-- cartera de clientes por nivel, importacion de cartera y alerta de comandas en captura manual.
--
-- Cobertura (positivo, negativo, cross-tenant, anon):
--   A) customer_tiers: misma formula que calc_customer_tier (002) para cada cliente; cross-tenant; anon.
--   B) clientes_cartera: filtros por nivel, frecuencia, dias sin pedir, sucursal, busqueda y cursor; entradas invalidas.
--   C) cartera_kpis: total, recurrentes, ticket promedio, cliente mas frecuente; cross-tenant.
--   D) importar_clientes: upsert que NO pisa nombre/nota, sin pedidos, tope 5,000, idempotente por huella, rol, tenant, anon.
--   E) alerta de captura manual: umbral por sucursal, candidatos solo-sistema, rol, tenant, anon.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): "as should_fail" = el escenario debe terminar en
-- ERROR; "deberia_ser_N" = el ultimo valor impreso debe ser N. Los aciertos se expresan como `(condicion)::int as deberia_ser_1`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f5a00', 'restaurantes', 'Org A (clientes)', 'org-a-clientes'),
  ('00000000-0000-0000-0000-0000000f5b00', 'restaurantes', 'Org B (clientes, ajena)', 'org-b-clientes')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5a00', 'restaurantes', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000f5b01', '00000000-0000-0000-0000-0000000f5b00', 'restaurantes', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f5e01', 'owner-a-cli@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f5e02', 'admin-a-cli@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000f5e03', 'staff-a-cli@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f5e04', 'repartidor-a-cli@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000f5e05', 'owner-b-cli@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f5e01', '00000000-0000-0000-0000-0000000f5a00', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f5e02', '00000000-0000-0000-0000-0000000f5a00', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000f5e03', '00000000-0000-0000-0000-0000000f5a00', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f5e04', '00000000-0000-0000-0000-0000000f5a00', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000f5e05', '00000000-0000-0000-0000-0000000f5b00', null, 'owner', 'owner')
on conflict do nothing;

-- Cartera de la Org A: 11 clientes. Gasto: c01..c09 = 100*i (un pedido), c10 = 3 pedidos de 500, c11 sin pedidos.
-- Percentil por gasto (n = 11): c10 = 100 (BLACK), c09 = 90 (PLATINUM), c08 = 80 y c07 = 70 (GOLD), el resto BLUE.
-- Ultimo pedido: c01 hace 100 d, c02 hace 70 d (en la sucursal A2), c03 hace 40 d, c04..c10 hace 1 d, c11 nunca.
insert into restaurantes.customers (id, organization_id, phone, name, order_count, last_order_at) values
  ('00000000-0000-0000-0000-0000000f5c01', '00000000-0000-0000-0000-0000000f5a00', '9990054001', 'Cliente 01', 1, now() - interval '100 days'),
  ('00000000-0000-0000-0000-0000000f5c02', '00000000-0000-0000-0000-0000000f5a00', '9990054002', 'Cliente 02', 1, now() - interval '70 days'),
  ('00000000-0000-0000-0000-0000000f5c03', '00000000-0000-0000-0000-0000000f5a00', '9990054003', 'Cliente 03', 1, now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000f5c04', '00000000-0000-0000-0000-0000000f5a00', '9990054004', 'Cliente 04', 1, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5c05', '00000000-0000-0000-0000-0000000f5a00', '9990054005', 'Cliente 05', 1, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5c06', '00000000-0000-0000-0000-0000000f5a00', '9990054006', 'Cliente 06', 1, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5c07', '00000000-0000-0000-0000-0000000f5a00', '9990054007', 'Cliente 07', 1, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5c08', '00000000-0000-0000-0000-0000000f5a00', '9990054008', 'Cliente 08', 1, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5c09', '00000000-0000-0000-0000-0000000f5a00', '9990054009', 'Cliente 09', 1, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5c10', '00000000-0000-0000-0000-0000000f5a00', '9990054010', 'Cliente 10', 3, now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5c11', '00000000-0000-0000-0000-0000000f5a00', '9990054011', 'Cliente 11', 0, null)
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name, order_count, last_order_at) values
  ('00000000-0000-0000-0000-0000000f5c99', '00000000-0000-0000-0000-0000000f5b00', '9990054099', 'Cliente de B', 1, now())
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000f5d01', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c01', 'Cliente 01', '9990054001', 100, 'entregado', '[]'::jsonb, 'voice', now() - interval '100 days'),
  ('00000000-0000-0000-0000-0000000f5d02', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5c02', 'Cliente 02', '9990054002', 200, 'entregado', '[]'::jsonb, 'voice', now() - interval '70 days'),
  ('00000000-0000-0000-0000-0000000f5d03', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c03', 'Cliente 03', '9990054003', 300, 'entregado', '[]'::jsonb, 'voice', now() - interval '40 days'),
  ('00000000-0000-0000-0000-0000000f5d04', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c04', 'Cliente 04', '9990054004', 400, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d05', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c05', 'Cliente 05', '9990054005', 500, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d06', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c06', 'Cliente 06', '9990054006', 600, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d07', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c07', 'Cliente 07', '9990054007', 700, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d08', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c08', 'Cliente 08', '9990054008', 800, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d09', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c09', 'Cliente 09', '9990054009', 900, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d10', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c10', 'Cliente 10', '9990054010', 500, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d11', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c10', 'Cliente 10', '9990054010', 500, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d12', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5c10', 'Cliente 10', '9990054010', 500, 'entregado', '[]'::jsonb, 'voice', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f5d90', '00000000-0000-0000-0000-0000000f5b00', '00000000-0000-0000-0000-0000000f5b01', '00000000-0000-0000-0000-0000000f5c99', 'Cliente de B', '9990054099', 50, 'entregado', '[]'::jsonb, 'voice', now())
on conflict do nothing;

\echo ''
\echo '=== A) customer_tiers ==='

\echo '--- A1. positivo: la formula nueva coincide con calc_customer_tier para cada cliente de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) filter (where t.tier is distinct from (restaurantes.calc_customer_tier('00000000-0000-0000-0000-0000000f5a00', t.customer_id)->>'tier')) as deberia_ser_0 from restaurantes.customer_tiers('00000000-0000-0000-0000-0000000f5a00') t;
rollback;

\echo '--- A2. positivo: staff de la Org A ve 11 clientes con nivel ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_11 from restaurantes.customer_tiers('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo '--- A3. CROSS-TENANT: owner de la Org B no ve niveles de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select count(*) as deberia_ser_0 from restaurantes.customer_tiers('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo '--- A4. ANON: sin GRANT de EXECUTE sobre customer_tiers ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.customer_tiers('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo ''
\echo '=== B) clientes_cartera ==='

\echo '--- B1. positivo: sin filtros devuelve los 11 clientes de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_11 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo '--- B2. positivo: nivel BLACK = 1 (c10) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_1 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_nivel => 'BLACK');
rollback;

\echo '--- B3. positivo: nivel PLATINUM = 1 (c09) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_1 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_nivel => 'PLATINUM');
rollback;

\echo '--- B4. positivo: nivel GOLD = 2 (c08, c07) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_2 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_nivel => 'GOLD');
rollback;

\echo '--- B5. positivo: nivel BLUE = 7 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_7 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_nivel => 'BLUE');
rollback;

\echo '--- B6. positivo: con 1 pedido = 9 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_9 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_frecuencia => 'una_vez');
rollback;

\echo '--- B7. positivo: recurrentes (>= 2 pedidos) = 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_1 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_frecuencia => 'recurrentes');
rollback;

\echo '--- B8. positivo: sin pedir en 30 dias = 4 (c01, c02, c03 y c11 que nunca pidio) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_4 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_inactivo_dias => 30);
rollback;

\echo '--- B9. positivo: sin pedir en 60 dias = 3 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_3 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_inactivo_dias => 60);
rollback;

\echo '--- B10. positivo: sin pedir en 90 dias = 2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_2 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_inactivo_dias => 90);
rollback;

\echo '--- B11. positivo: sucursal A2 = 1 (solo c02 pidio ahi) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_1 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_property_id => '00000000-0000-0000-0000-0000000f5a02');
rollback;

\echo '--- B12. positivo: filtros combinados (nivel BLUE + sin pedir en 30 dias) = 4 (c01, c02, c03 y c11 que nunca pidio) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_4 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_nivel => 'BLUE', p_inactivo_dias => 30);
rollback;

\echo '--- B13. positivo: busqueda por nombre ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_1 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_search => 'Cliente 03');
rollback;

\echo '--- B14. positivo: busqueda por telefono ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_1 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_search => '9990054005');
rollback;

\echo '--- B15. positivo: paginacion, limite 5 devuelve 5 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_5 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_limit => 5);
rollback;

\echo '--- B16. positivo: cursor, la segunda pagina no repite la primera (11 - 5 = 6) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as deberia_ser_6 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_cursor => (select x.customer_id from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_limit => 5) x order by x.customer_id desc limit 1));
rollback;

\echo '--- B17. CROSS-TENANT: owner de la Org B no obtiene clientes de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select count(*) as deberia_ser_0 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo '--- B18. positivo: owner de la Org B ve su propio cliente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select count(*) as deberia_ser_1 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5b00');
rollback;

\echo '--- B19. NEGATIVO: nivel invalido rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as should_fail from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_nivel => 'ORO');
rollback;

\echo '--- B20. NEGATIVO: frecuencia invalida rechazada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as should_fail from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_frecuencia => 'a_veces');
rollback;

\echo '--- B21. NEGATIVO: limite fuera de rango rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as should_fail from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_limit => 0);
rollback;

\echo '--- B21b. positivo: limite 200 (tope) aceptado; el repositorio parte las paginas de exportacion (500) en bloques de 200 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) <= 200 as deberia_ser_t from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_limit => 200);
rollback;

\echo '--- B21c. NEGATIVO: limite 201 rechazado (22023); por eso listCustomers nunca pide mas de 200 por llamada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as should_fail from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_limit => 201);
rollback;

\echo '--- B22. NEGATIVO: dias sin pedir fuera de rango rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select count(*) as should_fail from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00', p_inactivo_dias => 0);
rollback;

\echo '--- B23. ANON: sin GRANT de EXECUTE sobre clientes_cartera ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo '--- B24. positivo: la sesion de sistema (sin usuario) no ve clientes por RLS ---'
begin;
set local role authenticated;
select count(*) as deberia_ser_0 from restaurantes.clientes_cartera('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo ''
\echo '=== C) cartera_kpis ==='

\echo '--- C1. positivo: total 11, recurrentes 1, ticket promedio 500.00, mas frecuente c10 con 3 pedidos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select (total = 11 and recurrentes = 1 and ticket_promedio = 500.00 and top_customer_id = '00000000-0000-0000-0000-0000000f5c10' and top_order_count = 3 and top_last_order_at is not null)::int as deberia_ser_1 from restaurantes.cartera_kpis('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo '--- C2. CROSS-TENANT: owner de la Org B ve una cartera vacia al pedir la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select (total = 0 and recurrentes = 0 and ticket_promedio is null and top_customer_id is null)::int as deberia_ser_1 from restaurantes.cartera_kpis('00000000-0000-0000-0000-0000000f5a00');
rollback;

\echo '--- C3. ANON: sin GRANT de EXECUTE sobre cartera_kpis ---'
begin;
set local role anon;
select * from restaurantes.cartera_kpis('00000000-0000-0000-0000-0000000f5a00') as should_fail;
rollback;

\echo ''
\echo '=== D) importar_clientes ==='

\echo '--- D1. positivo: staff importa 3 renglones (2 nuevos, 1 telefono invalido rechazado) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select (not ya_importado and total = 3 and creados = 2 and actualizados = 0 and sin_cambios = 0 and rechazados = 1)::int as deberia_ser_1 from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
rollback;

\echo '--- D2. positivo: se guardan nombre, nota y direccion (principal) y NO se crean pedidos ni se mueve order_count ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
select (
  (select count(*) from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f5a00') = 13
  and (select c.notes from restaurantes.customers c where c.organization_id = '00000000-0000-0000-0000-0000000f5a00' and c.phone = '9991230001') = 'sin picante'
  and (select a.is_default from restaurantes.customer_addresses a join restaurantes.customers c on c.id = a.customer_id where c.phone = '9991230001' and a.address = 'Calle 1 #2')
  and (select count(*) from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f5a00' and order_count > 0) = 10
)::int as deberia_ser_1;
rollback;

\echo '--- D3. positivo: el MISMO archivo dos veces (misma huella) no duplica y avisa ya_importado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
select (ya_importado and total = 3 and creados = 2 and rechazados = 1)::int as deberia_ser_1 from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
rollback;

\echo '--- D4. positivo: la segunda importacion con la misma huella no vuelve a escribir (13 clientes, no 15) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
select count(*) as deberia_ser_13 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f5a00';
rollback;

\echo '--- D5. positivo: NO pisa el nombre conocido (X20) ni la nota existente; queda como sin_cambios o completa solo lo vacio ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[{"phone":"9990054001","name":"Nombre Distinto","notes":"nota nueva"}]'::jsonb);
select ((select name from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000f5a00' and phone = '9990054001') = 'Cliente 01')::int as deberia_ser_1;
rollback;

\echo '--- D6. positivo: cliente sin nombre recibe el nombre del archivo (actualizados = 1) y el existente no cambia de id ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
reset role;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f5caa', '00000000-0000-0000-0000-0000000f5a00', '9990054100', null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc', '[{"phone":"9990054100","name":"Rellenado"}]'::jsonb);
select ((select name from restaurantes.customers where id = '00000000-0000-0000-0000-0000000f5caa') = 'Rellenado')::int as deberia_ser_1;
rollback;

\echo '--- D7. positivo: telefono repetido dentro del archivo = 1 creado + 1 sin_cambios ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select (creados = 1 and sin_cambios = 1 and rechazados = 0)::int as deberia_ser_1 from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd', '[{"phone":"9991230010","name":"Uno"},{"phone":"9991230010","name":"Dos"}]'::jsonb);
rollback;

\echo '--- D8. positivo: tope exacto de 5,000 renglones ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select (creados = 5000 and rechazados = 0)::int as deberia_ser_1 from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', (select jsonb_agg(jsonb_build_object('phone', lpad(g::text, 10, '0'), 'name', 'Masivo ' || g)) from generate_series(1, 5000) g));
rollback;

\echo '--- D9. NEGATIVO: 5,001 renglones rechazados ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', (select jsonb_agg(jsonb_build_object('phone', lpad(g::text, 10, '7'))) from generate_series(1, 5001) g)) as should_fail;
rollback;

\echo '--- D10. NEGATIVO: arreglo vacio rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', '1111111111111111111111111111111111111111111111111111111111111111', '[]'::jsonb) as should_fail;
rollback;

\echo '--- D11. NEGATIVO: huella invalida rechazada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'no-es-sha256', '[{"phone":"9991230001"}]'::jsonb) as should_fail;
rollback;

\echo '--- D12. NEGATIVO: el cuerpo debe ser un arreglo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', '2222222222222222222222222222222222222222222222222222222222222222', '{"phone":"9991230001"}'::jsonb) as should_fail;
rollback;

\echo '--- D13. NEGATIVO (rol): repartidor NO puede importar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e04', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', '3333333333333333333333333333333333333333333333333333333333333333', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb) as should_fail;
rollback;

\echo '--- D14. CROSS-TENANT: owner de la Org B NO puede importar a la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', '4444444444444444444444444444444444444444444444444444444444444444', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb) as should_fail;
rollback;

\echo '--- D15. NEGATIVO: la sesion de sistema (sin usuario) NO puede importar ---'
begin;
set local role authenticated;
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', '5555555555555555555555555555555555555555555555555555555555555555', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb) as should_fail;
rollback;

\echo '--- D16. ANON: sin GRANT de EXECUTE sobre importar_clientes ---'
begin;
set local role anon;
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', '6666666666666666666666666666666666666666666666666666666666666666', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb) as should_fail;
rollback;

\echo '--- D17. NEGATIVO: escritura directa en customers por authenticated rechazada (solo la funcion escribe) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
insert into restaurantes.customers (organization_id, phone, name) values ('00000000-0000-0000-0000-0000000f5a00', '9990099999', 'Directo') returning id;
select 1 as should_fail from restaurantes.customers where false;
rollback;

\echo '--- D18. NEGATIVO: escritura directa en customer_imports rechazada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
insert into restaurantes.customer_imports (organization_id, file_hash, total) values ('00000000-0000-0000-0000-0000000f5a00', '7777777777777777777777777777777777777777777777777777777777777777', 1);
select 1 as should_fail from restaurantes.customers where false;
rollback;

\echo '--- D19. positivo: staff de la Org A ve la huella de su importacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
select count(*) as deberia_ser_1 from restaurantes.customer_imports where organization_id = '00000000-0000-0000-0000-0000000f5a00' and file_hash = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
rollback;

\echo '--- D20. CROSS-TENANT: el owner de la Org B no ve las importaciones de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 #2","notes":"sin picante"},{"phone":"9991230002","name":"Bruno"},{"phone":"12345","name":"Invalido"}]'::jsonb);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select count(*) as deberia_ser_0 from restaurantes.customer_imports where organization_id = '00000000-0000-0000-0000-0000000f5a00';
rollback;

\echo '--- D21. NEGATIVO: created_by (id de staff) no es legible por GRANT de columna ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select created_by as should_fail from restaurantes.customer_imports;
rollback;

\echo '--- D22. positivo: la nota de mas de 500 caracteres se recorta, no falla ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select (creados = 1)::int as deberia_ser_1 from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000f5a00', '8888888888888888888888888888888888888888888888888888888888888888', jsonb_build_array(jsonb_build_object('phone', '9991230099', 'name', 'Largo', 'notes', repeat('x', 900))));
rollback;

\echo ''
\echo '=== E) alerta de captura manual ==='

\echo '--- E1. positivo: con el umbral por omision (5 min) solo la comanda de hace 10 min esta vencida ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f01', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d01', 'k-x', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000f5f02', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5d02', 'k-y', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '3 minutes');
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f03', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d03', 'k-z', 'confirmada', 'activo', '{}'::jsonb, 'F-1', now() - interval '30 minutes');
set local role authenticated;
select (count(*) = 1 and bool_and(comanda_id = '00000000-0000-0000-0000-0000000f5f01' and minutos >= 10 and organization_id = '00000000-0000-0000-0000-0000000f5a00'))::int as deberia_ser_1 from restaurantes.pos_comandas_captura_manual_vencidas();
rollback;

\echo '--- E2. positivo: una comanda confirmada nunca es candidata aunque sea vieja ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f01', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d01', 'k-x', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000f5f02', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5d02', 'k-y', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '3 minutes');
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f03', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d03', 'k-z', 'confirmada', 'activo', '{}'::jsonb, 'F-1', now() - interval '30 minutes');
set local role authenticated;
select count(*) as deberia_ser_0 from restaurantes.pos_comandas_captura_manual_vencidas() where comanda_id = '00000000-0000-0000-0000-0000000f5f03';
rollback;

\echo '--- E3. positivo: el umbral por sucursal (A2 = 2 min) hace candidata la de hace 3 min ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f01', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d01', 'k-x', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000f5f02', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5d02', 'k-y', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '3 minutes');
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f03', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d03', 'k-z', 'confirmada', 'activo', '{}'::jsonb, 'F-1', now() - interval '30 minutes');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a02', 2);
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_2 from restaurantes.pos_comandas_captura_manual_vencidas();
rollback;

\echo '--- E4. positivo: al capturarla a mano deja de ser candidata ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f01', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d01', 'k-x', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000f5f02', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5d02', 'k-y', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '3 minutes');
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f03', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d03', 'k-z', 'confirmada', 'activo', '{}'::jsonb, 'F-1', now() - interval '30 minutes');
update restaurantes.pos_comanda_outbox set estado = 'capturada_manual' where id = '00000000-0000-0000-0000-0000000f5f01';
set local role authenticated;
select count(*) as deberia_ser_0 from restaurantes.pos_comandas_captura_manual_vencidas();
rollback;

\echo '--- E5. positivo: con p_now una hora despues ambas vencen ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f01', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d01', 'k-x', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000f5f02', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a02', '00000000-0000-0000-0000-0000000f5d02', 'k-y', 'captura_manual', 'activo', '{}'::jsonb, now() - interval '3 minutes');
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio, actualizado_en) values
  ('00000000-0000-0000-0000-0000000f5f03', '00000000-0000-0000-0000-0000000f5a00', '00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5d03', 'k-z', 'confirmada', 'activo', '{}'::jsonb, 'F-1', now() - interval '30 minutes');
set local role authenticated;
select count(*) as deberia_ser_2 from restaurantes.pos_comandas_captura_manual_vencidas(now() + interval '1 hour');
rollback;

\echo '--- E6. NEGATIVO: un usuario autenticado NO puede pedir los candidatos (solo sistema) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
select * from restaurantes.pos_comandas_captura_manual_vencidas() as should_fail;
rollback;

\echo '--- E7. ANON: sin GRANT de EXECUTE sobre los candidatos ---'
begin;
set local role anon;
select * from restaurantes.pos_comandas_captura_manual_vencidas() as should_fail;
rollback;

\echo '--- E8. positivo: owner fija el umbral y staff lo lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 8);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select (captura_manual_min = 8)::int as deberia_ser_1 from restaurantes.pos_comanda_alerta_config where property_id = '00000000-0000-0000-0000-0000000f5a01';
rollback;

\echo '--- E9. positivo: admin fija el umbral ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e02', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 15);
select (captura_manual_min = 15)::int as deberia_ser_1 from restaurantes.pos_comanda_alerta_config where property_id = '00000000-0000-0000-0000-0000000f5a01';
rollback;

\echo '--- E10. NEGATIVO (rol): staff NO puede fijar el umbral ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e03', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 8) as should_fail;
rollback;

\echo '--- E11. NEGATIVO (rol): repartidor NO puede fijar el umbral ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e04', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 8) as should_fail;
rollback;

\echo '--- E12. CROSS-TENANT: owner de la Org B NO puede fijar el umbral de una sucursal de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 8) as should_fail;
rollback;

\echo '--- E13. CROSS-TENANT: owner de la Org A NO puede fijar el umbral de una sucursal de la Org B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5b01', 8) as should_fail;
rollback;

\echo '--- E14. NEGATIVO: la sesion de sistema NO puede fijar el umbral ---'
begin;
set local role authenticated;
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 8) as should_fail;
rollback;

\echo '--- E15. NEGATIVO: 0 minutos rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 0) as should_fail;
rollback;

\echo '--- E16. NEGATIVO: 241 minutos rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 241) as should_fail;
rollback;

\echo '--- E17. ANON: sin GRANT de EXECUTE sobre set_umbral_captura_manual ---'
begin;
set local role anon;
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 8) as should_fail;
rollback;

\echo '--- E18. CROSS-TENANT: el umbral de la Org A no es legible por la Org B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
select restaurantes.set_umbral_captura_manual('00000000-0000-0000-0000-0000000f5a01', 8);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e05', true);
select count(*) as deberia_ser_0 from restaurantes.pos_comanda_alerta_config;
rollback;

\echo '--- E19. NEGATIVO: escritura directa en pos_comanda_alerta_config rechazada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5e01', true);
insert into restaurantes.pos_comanda_alerta_config (property_id, organization_id, captura_manual_min) values ('00000000-0000-0000-0000-0000000f5a01', '00000000-0000-0000-0000-0000000f5a00', 3);
select 1 as should_fail from restaurantes.customers where false;
rollback;

\echo ''
\echo 'Fin: los escenarios marcados should_fail deben terminar en ERROR; los deberia_ser_N deben imprimir N.'
