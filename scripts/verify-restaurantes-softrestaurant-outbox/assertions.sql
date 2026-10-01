-- Verificacion contra Postgres REAL de
-- packages/domain-restaurantes/migrations/024_softrestaurant_comanda_outbox.sql:
-- bandera por organizacion + outbox de comandas hacia SoftRestaurant.
--
-- Cobertura (positivo, negativo, cross-tenant, anon):
--   A) bandera: lectura/escritura por rol, default apagado, cross-tenant, anon.
--   B) encolar: solo sistema, idempotente, payload acotado, sin mezclar tenants.
--   C) reclamar/completar: solo sistema, kill switch (modo apagado), backoff,
--      lease vencido en el ultimo intento -> captura manual, folio solo si confirmada.
--   D) captura manual: rol, sucursal, estados permitidos, corta los reintentos.
--   E) RLS/GRANT de lectura: por rol/sucursal/tenant, columnas internas ocultas,
--      sin escritura directa para nadie.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): "as
-- should_fail" = el escenario debe terminar en ERROR; "deberia_ser_N" = el ultimo
-- valor impreso debe ser N. Para leer la tabla tras una funcion de sistema, el
-- escenario vuelve a superusuario con `reset role` (la sesion de sistema no tiene
-- policy de lectura, a proposito).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e1a00', 'restaurantes', 'Org A (softrestaurant)', 'org-a-softrest'),
  ('00000000-0000-0000-0000-0000000e1b00', 'restaurantes', 'Org B (softrestaurant, ajena)', 'org-b-softrest')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e1a00', 'restaurantes', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e1a00', 'restaurantes', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e1b01', '00000000-0000-0000-0000-0000000e1b00', 'restaurantes', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e2a01', 'owner-a-sr@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e2a02', 'admin-a-sr@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e2a03', 'staff-a-sr@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e2a04', 'repartidor-a-sr@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e2a05', 'staff-p2-sr@example.com', 'Staff solo A2', 'seed'),
  ('00000000-0000-0000-0000-0000000e2b01', 'owner-b-sr@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e2a01', '00000000-0000-0000-0000-0000000e1a00', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e2a02', '00000000-0000-0000-0000-0000000e1a00', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e2a03', '00000000-0000-0000-0000-0000000e1a00', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e2a04', '00000000-0000-0000-0000-0000000e1a00', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e2a05', '00000000-0000-0000-0000-0000000e1a00', array['00000000-0000-0000-0000-0000000e1a02']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e2b01', '00000000-0000-0000-0000-0000000e1b00', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source) values
  ('00000000-0000-0000-0000-0000000e3a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', 'Cliente Uno', '9990000001', 100, 'pending', '[]'::jsonb, 'voice'),
  ('00000000-0000-0000-0000-0000000e3a02', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', 'Cliente Dos', '9990000002', 100, 'pending', '[]'::jsonb, 'voice'),
  ('00000000-0000-0000-0000-0000000e3a03', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a02', 'Cliente Tres', '9990000003', 100, 'pending', '[]'::jsonb, 'voice'),
  ('00000000-0000-0000-0000-0000000e3b01', '00000000-0000-0000-0000-0000000e1b00', '00000000-0000-0000-0000-0000000e1b01', 'Cliente B', '9990000009', 100, 'pending', '[]'::jsonb, 'voice')
on conflict do nothing;

\echo ''
\echo '=== A) bandera por organizacion ==='
\echo ''
\echo '--- A1. positivo: owner de la Org A fija modo activo y la lectura lo refleja ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'activo');
select (restaurantes.softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00') = 'activo')::int as deberia_ser_1;
rollback;

\echo '--- A2. positivo: admin de la Org A fija modo sombra ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a02', true);
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'sombra');
select (restaurantes.softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00') = 'sombra')::int as deberia_ser_1;
rollback;

\echo '--- A3. positivo: sin fila en la bandera el modo efectivo es apagado (default) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select (restaurantes.softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00') = 'apagado')::int as deberia_ser_1;
rollback;

\echo '--- A4. NEGATIVO (rol): staff NO puede cambiar la bandera ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'activo') as should_fail;
rollback;

\echo '--- A5. NEGATIVO (rol): repartidor NO puede cambiar la bandera ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a04', true);
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'activo') as should_fail;
rollback;

\echo '--- A6. CROSS-TENANT: owner de la Org B NO puede cambiar la bandera de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'activo') as should_fail;
rollback;

\echo '--- A7. NEGATIVO: la sesion de sistema (auth.uid() null) NO puede cambiar la bandera ---'
begin;
set local role authenticated;
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'activo') as should_fail;
rollback;

\echo '--- A8. NEGATIVO: modo invalido rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'loco') as should_fail;
rollback;

\echo '--- A9. ANON: sin GRANT de EXECUTE sobre set_softrestaurant_modo ---'
begin;
set local role anon;
select restaurantes.set_softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00', 'activo') as should_fail;
rollback;

\echo '--- A10. CROSS-TENANT: owner de la Org B NO puede leer la bandera de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
select restaurantes.softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00') as should_fail;
rollback;

\echo '--- A11. positivo: la sesion de sistema SI lee la bandera (el codigo ya resolvio la organizacion) ---'
begin;
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select (restaurantes.softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00') = 'activo')::int as deberia_ser_1;
rollback;

\echo '--- A12. ANON: sin GRANT de EXECUTE sobre softrestaurant_modo ---'
begin;
set local role anon;
select restaurantes.softrestaurant_modo('00000000-0000-0000-0000-0000000e1a00') as should_fail;
rollback;

\echo '--- A13. NEGATIVO: INSERT directo en la tabla de bandera rechazado (sin GRANT de escritura) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') returning 1 as should_fail;
rollback;

\echo '--- A14. ANON: SELECT sobre la tabla de bandera rechazado ---'
begin;
set local role anon;
select * from restaurantes.softrestaurant_config as should_fail;
rollback;

\echo '--- A15. lectura directa: staff de la Org A ve SOLO la fila de su organizacion ---'
begin;
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1b00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select count(*)::int as deberia_ser_1 from restaurantes.softrestaurant_config;
rollback;

\echo '--- A16. columna interna: updated_by NO es legible (GRANT por columna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select updated_by as should_fail from restaurantes.softrestaurant_config;
rollback;

\echo ''
\echo '=== B) encolar (solo sistema) ==='
\echo ''
\echo '--- B1. positivo: la sesion de sistema encola una comanda y queda pendiente ---'
begin;
set local role authenticated;
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5);
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where estado = 'pendiente' and order_id = '00000000-0000-0000-0000-0000000e3a01';
rollback;

\echo '--- B2. positivo: encolar dos veces el mismo pedido deja UNA sola fila (idempotente) ---'
begin;
set local role authenticated;
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5);
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-otra', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5);
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where order_id = '00000000-0000-0000-0000-0000000e3a01';
rollback;

\echo '--- B3. NEGATIVO: staff autenticado NO puede encolar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5) as should_fail;
rollback;

\echo '--- B4. ANON: sin GRANT de EXECUTE sobre pos_comanda_encolar ---'
begin;
set local role anon;
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5) as should_fail;
rollback;

\echo '--- B5. CROSS-TENANT: encolar un pedido de la Org B declarando la Org A es RECHAZADO ---'
begin;
set local role authenticated;
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1b01', '00000000-0000-0000-0000-0000000e3b01', 'llave-1', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5) as should_fail;
rollback;

\echo '--- B6. NEGATIVO: sucursal que no corresponde al pedido rechazada ---'
begin;
set local role authenticated;
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a02', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5) as should_fail;
rollback;

\echo '--- B7. NEGATIVO: modo apagado no se encola (solo sombra/activo) ---'
begin;
set local role authenticated;
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'apagado', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5) as should_fail;
rollback;

\echo '--- B8. NEGATIVO: payload que no es objeto rechazado por CHECK ---'
begin;
set local role authenticated;
select id from restaurantes.pos_comanda_encolar('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'activo', '[]'::jsonb, 5) as should_fail;
rollback;

\echo ''
\echo '=== C) reclamar / completar (solo sistema) ==='
\echo ''
\echo '--- C1. kill switch: con la bandera apagada NO se reclama nada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_reclamar(null, 10, 120);
rollback;

\echo '--- C2. positivo: con la bandera activa se reclama y pasa a enviada con intentos=1 ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_reclamar(null, 10, 120) where estado = 'enviada' and intentos = 1;
rollback;

\echo '--- C3. NEGATIVO: staff autenticado NO puede reclamar ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select * from restaurantes.pos_comanda_reclamar(null, 10, 120) as should_fail;
rollback;

\echo '--- C4. ANON: sin GRANT de EXECUTE sobre pos_comanda_reclamar ---'
begin;
set local role anon;
select * from restaurantes.pos_comanda_reclamar(null, 10, 120) as should_fail;
rollback;

\echo '--- C5. un segundo reclamo inmediato NO devuelve la fila en vuelo (lease vigente) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select count(*)::int from restaurantes.pos_comanda_reclamar(null, 10, 120);
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_reclamar(null, 10, 120);
rollback;

\echo '--- C6. positivo: completar confirmada con folio deja estado confirmada y el folio ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select restaurantes.pos_comanda_completar('00000000-0000-0000-0000-0000000e4a01', 'confirmada', 'T1-000123', null, null);
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where estado = 'confirmada' and folio = 'T1-000123';
rollback;

\echo '--- C7. NEGATIVO: confirmada sin folio rechazada (el agente nunca inventa folios) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select restaurantes.pos_comanda_completar('00000000-0000-0000-0000-0000000e4a01', 'confirmada', null, null, null) as should_fail;
rollback;

\echo '--- C8. NEGATIVO: fallida sin proximo intento rechazada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select restaurantes.pos_comanda_completar('00000000-0000-0000-0000-0000000e4a01', 'fallida', null, 'no_disponible:timeout', null) as should_fail;
rollback;

\echo '--- C9. completar solo transiciona desde enviada: sobre una pendiente no cambia nada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select restaurantes.pos_comanda_completar('00000000-0000-0000-0000-0000000e4a01', 'confirmada', 'T1-9', null, null);
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where estado = 'pendiente' and folio is null;
rollback;

\echo '--- C10. NEGATIVO: staff autenticado NO puede completar ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
select restaurantes.pos_comanda_completar('00000000-0000-0000-0000-0000000e4a01', 'confirmada', 'T1-1', null, null) as should_fail;
rollback;

\echo '--- C11. ANON: sin GRANT de EXECUTE sobre pos_comanda_completar ---'
begin;
set local role anon;
select restaurantes.pos_comanda_completar('00000000-0000-0000-0000-0000000e4a01', 'confirmada', 'T1-1', null, null) as should_fail;
rollback;

\echo '--- C12. backoff: una fallida con proximo intento en el futuro NO se reclama ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, proximo_intento_en) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'fallida', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, now() + interval '10 minutes');
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_reclamar(null, 10, 120);
rollback;

\echo '--- C13. backoff vencido: una fallida con proximo intento pasado SI se reclama (intentos pasa a 1) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, proximo_intento_en) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'fallida', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, now() - interval '1 minute');
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_reclamar(null, 10, 120) where intentos = 1;
rollback;

\echo '--- C14. fallida -> completar captura_manual con motivo (sin reintentos restantes) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select restaurantes.pos_comanda_completar('00000000-0000-0000-0000-0000000e4a01', 'captura_manual', null, 'no_disponible:timeout:intentos_agotados', null);
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where estado = 'captura_manual' and folio is null;
rollback;

\echo '--- C15. lease vencido en el ULTIMO intento: no se reclama, pasa a captura_manual ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, intentos, max_intentos, reclamada_en) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 5, 5, now() - interval '1 hour');
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select count(*)::int from restaurantes.pos_comanda_reclamar(null, 10, 120);
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where estado = 'captura_manual';
rollback;

\echo '--- C16. lease vencido con intentos disponibles: SI se reclama otra vez (intentos +1) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, intentos, reclamada_en) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 2, now() - interval '1 hour');
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_reclamar(null, 10, 120) where intentos = 3;
rollback;

\echo '--- C17. bandera apagada DESPUES de encolar: la comanda se queda quieta (no se reclama) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'apagado') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_reclamar(null, 10, 120);
rollback;

\echo '--- C18. CHECK: un folio solo puede existir en una comanda confirmada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
update restaurantes.pos_comanda_outbox set folio = 'T1-777' where id = '00000000-0000-0000-0000-0000000e4a01' returning 1 as should_fail;
rollback;

\echo ''
\echo '=== D) captura manual (staff) ==='
\echo ''
\echo '--- D1. positivo: staff marca capturada una comanda en captura_manual ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'captura_manual', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado;
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where estado = 'capturada_manual' and capturado_por = '00000000-0000-0000-0000-0000000e2a03';
rollback;

\echo '--- D2. positivo: admin marca capturada una comanda fallida (corta los reintentos) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'fallida', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a02', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado;
reset role;
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox where estado = 'capturada_manual';
rollback;

\echo '--- D3. despues de capturada a mano ya no se reclama (cero duplicados automaticos) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, proximo_intento_en) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'fallida', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, now() - interval '1 minute');
insert into restaurantes.softrestaurant_config (organization_id, modo) values ('00000000-0000-0000-0000-0000000e1a00', 'activo') on conflict (organization_id) do update set modo = excluded.modo;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'x');
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
reset role;
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_reclamar(null, 10, 120);
rollback;

\echo '--- D4. NEGATIVO (estado): una comanda en vuelo (enviada) NO se puede marcar capturada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'enviada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo '--- D5. NEGATIVO (estado): una comanda ya confirmada NO se puede marcar capturada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'confirmada', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb, 'T1-1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo '--- D6. NEGATIVO (rol): repartidor NO puede marcar capturada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'captura_manual', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a04', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo '--- D7. CROSS-TENANT: owner de la Org B NO puede marcar capturada una comanda de la Org A ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'captura_manual', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1b00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo '--- D8. CROSS-TENANT: owner de la Org B declarando SU organizacion tampoco alcanza la fila ajena ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'captura_manual', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo '--- D9. NEGATIVO (sucursal): staff restringido a la sucursal A2 NO puede capturar una comanda de A1 ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'captura_manual', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a05', true);
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo '--- D10. NEGATIVO: la sesion de sistema NO puede marcar capturada (requiere actor) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'captura_manual', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo '--- D11. ANON: sin GRANT de EXECUTE sobre pos_comanda_marcar_capturada ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'captura_manual', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role anon;
select (restaurantes.pos_comanda_marcar_capturada('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e4a01', 'capturada en caja')).estado as should_fail;
rollback;

\echo ''
\echo '=== E) RLS / GRANT de lectura y escritura directa ==='
\echo ''
\echo '--- E1. positivo: staff de la Org A ve la comanda de su sucursal ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select count(*)::int as deberia_ser_1 from restaurantes.pos_comanda_outbox;
rollback;

\echo '--- E2. positivo: staff restringido a A2 ve 0 comandas de A1 ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a05', true);
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_outbox;
rollback;

\echo '--- E3. repartidor de la Org A NO ve comandas (contienen PII de clientes) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a04', true);
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_outbox;
rollback;

\echo '--- E4. CROSS-TENANT: owner de la Org B ve 0 comandas de la Org A ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2b01', true);
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_outbox;
rollback;

\echo '--- E5. la sesion de sistema no lee la tabla directamente (solo por funciones) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select count(*)::int as deberia_ser_0 from restaurantes.pos_comanda_outbox;
rollback;

\echo '--- E6. ANON: SELECT sobre el outbox rechazado ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role anon;
select * from restaurantes.pos_comanda_outbox as should_fail;
rollback;

\echo '--- E7. columna interna: idempotency_key NO es legible por authenticated ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select idempotency_key as should_fail from restaurantes.pos_comanda_outbox;
rollback;

\echo '--- E8. columna interna: reclamada_en NO es legible por authenticated ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a03', true);
select reclamada_en as should_fail from restaurantes.pos_comanda_outbox;
rollback;

\echo '--- E9. NEGATIVO: INSERT directo en el outbox rechazado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
insert into restaurantes.pos_comanda_outbox (organization_id, property_id, order_id, idempotency_key, modo, payload) values ('00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a02', 'k', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb) returning 1 as should_fail;
rollback;

\echo '--- E10. NEGATIVO: UPDATE directo del estado rechazado (nadie salta la maquina de estados) ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
update restaurantes.pos_comanda_outbox set estado = 'confirmada' where true returning 1 as should_fail;
rollback;

\echo '--- E11. NEGATIVO: DELETE directo rechazado ---'
begin;
insert into restaurantes.pos_comanda_outbox (id, organization_id, property_id, order_id, idempotency_key, estado, modo, payload) values ('00000000-0000-0000-0000-0000000e4a01', '00000000-0000-0000-0000-0000000e1a00', '00000000-0000-0000-0000-0000000e1a01', '00000000-0000-0000-0000-0000000e3a01', 'llave-1', 'pendiente', 'activo', '{"sucursal":"T1","tipo":"recoger","items":[]}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e2a01', true);
delete from restaurantes.pos_comanda_outbox where true returning 1 as should_fail;
rollback;

\echo ''
\echo 'Escenarios que deben terminar en ERROR se marcan con "as should_fail"; los de valor, con deberia_ser_N.'
