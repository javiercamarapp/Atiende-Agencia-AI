-- R-16: fixtures + assertions contra Postgres REAL (RLS + GRANT + auth.uid() reales; el repositorio en
-- memoria nunca los aplica) de packages/domain-restaurantes/migrations/043_avisos_staff_preferencias_y_alertas.sql:
--
--   A. core.notification_preference / list / set (preferencias por usuario): positivo (cada usuario las suyas,
--      owner/admin las de su staff), RLS (nadie lee las de otro por la tabla), rol insuficiente, un admin no
--      edita las de un owner, cross-tenant, anon, escritura directa sin GRANT, tipo de otro vertical.
--   B. core.emit_notification: respeta la preferencia (quien apago el tipo no recibe; los demas si; otros tipos
--      siguen llegando), dedupe intacto y las demas verticales sin regresion (hoteles).
--   C. restaurantes.sucursal_avisos_config / set_umbral_entrega_tardia: solo owner/admin, cross-tenant, rango,
--      anon.
--   D. restaurantes.avisos_operativos_candidatos: solo sistema; que pedidos son candidatos de "entrega tardia" y
--      de "programado por vencer" y cuales no (umbral por sucursal, ventana de 24 h, canal recoger, repartidor).
--   E. Esquema de PRODUCCION a medio migrar: SQLSTATE 42883 recuperado con SAVEPOINT.
--
-- Un solo chequeo de valor (`..._deberia_ser_N`) por bloque begin;/rollback; (lo exige run-gate.mjs).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000a1601', 'restaurantes', 'R16 Org A', 'r16-org-a'),
  ('00000000-0000-0000-0000-0000000a1602', 'restaurantes', 'R16 Org B (ajena)', 'r16-org-b'),
  ('00000000-0000-0000-0000-0000000a1603', 'hoteles', 'R16 Hotel H', 'r16-hotel-h')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000a16a1', '00000000-0000-0000-0000-0000000a1601', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000a16a2', '00000000-0000-0000-0000-0000000a1601', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000a16b1', '00000000-0000-0000-0000-0000000a1602', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000a16a1', '00000000-0000-0000-0000-0000000a1601', 'r16-a1'),
  ('00000000-0000-0000-0000-0000000a16a2', '00000000-0000-0000-0000-0000000a1601', 'r16-a2'),
  ('00000000-0000-0000-0000-0000000a16b1', '00000000-0000-0000-0000-0000000a1602', 'r16-b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a1611', 'owner-a@r16.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a1612', 'admin-a@r16.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000a1613', 'staff-a@r16.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000a1614', 'repartidor-a@r16.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000a1615', 'owner-b@r16.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000a1616', 'owner-h@r16.example.com', 'Owner Hotel', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a1611', '00000000-0000-0000-0000-0000000a1601', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a1612', '00000000-0000-0000-0000-0000000a1601', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000a1613', '00000000-0000-0000-0000-0000000a1601', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000a1614', '00000000-0000-0000-0000-0000000a1601', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000a1615', '00000000-0000-0000-0000-0000000a1602', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a1616', '00000000-0000-0000-0000-0000000a1603', null, 'owner', 'gm')
on conflict do nothing;

-- Pedidos para los candidatos (D). Hora de referencia = now() del servidor (el escenario usa el default).
-- Entrega tardia: L1 preparando creado hace 2 h sin hora prometida (umbral 45 -> tarde), L2 en_camino con
-- estimated_delivery_at pasada, L3 preparando con hora prometida FUTURA, L4 igual que L1 pero en una sucursal con
-- umbral de 240, L5 `pending` (no cuenta), L6 entregado (no cuenta), L7 prometido hace 30 h (fuera de la ventana de 24 h).
-- Programado por vencer: P1 programado que entra en 10 min (la promocion ya debio ocurrir), P2 programado lejano,
-- P3 en cocina y entra en 15 min sin repartidor (domicilio), P4 igual pero recoger, P5 igual pero con repartidor,
-- P6 cancelado. Org B: LB1 igual que L1 (cross-tenant: solo cuenta para su organizacion).
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000a16a3', '00000000-0000-0000-0000-0000000a1601', 'Sucursal A3 (umbral 240)')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000a16a3', '00000000-0000-0000-0000-0000000a1601', 'r16-a3')
on conflict do nothing;
insert into restaurantes.sucursal_avisos_config (property_id, organization_id, entrega_tardia_min) values
  ('00000000-0000-0000-0000-0000000a16a3', '00000000-0000-0000-0000-0000000a1601', 240)
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, customer_address, total, status, items, source, created_at, estimated_delivery_at, programado_para, canal, assigned_repartidor_id) values
  ('00000000-0000-0000-0000-0000000a16e1', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'L1', '+5219991600001', 'Calle 1', 100, 'preparando', '[]'::jsonb, 'web', now() - interval '2 hours', null, null, null, null),
  ('00000000-0000-0000-0000-0000000a16e2', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'L2', '+5219991600001', 'Calle 1', 100, 'en_camino', '[]'::jsonb, 'web', now() - interval '1 hour', now() - interval '10 minutes', null, null, null),
  ('00000000-0000-0000-0000-0000000a16e3', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'L3', '+5219991600001', 'Calle 1', 100, 'preparando', '[]'::jsonb, 'web', now() - interval '1 hour', now() + interval '10 minutes', null, null, null),
  ('00000000-0000-0000-0000-0000000a16e4', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a3', 'L4', '+5219991600001', 'Calle 1', 100, 'preparando', '[]'::jsonb, 'web', now() - interval '2 hours', null, null, null, null),
  ('00000000-0000-0000-0000-0000000a16e5', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'L5', '+5219991600001', 'Calle 1', 100, 'pending', '[]'::jsonb, 'web', now() - interval '2 hours', null, null, null, null),
  ('00000000-0000-0000-0000-0000000a16e6', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'L6', '+5219991600001', 'Calle 1', 100, 'entregado', '[]'::jsonb, 'web', now() - interval '2 hours', null, null, null, null),
  ('00000000-0000-0000-0000-0000000a16e7', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'L7', '+5219991600001', 'Calle 1', 100, 'preparando', '[]'::jsonb, 'web', now() - interval '31 hours', now() - interval '30 hours', null, null, null),
  ('00000000-0000-0000-0000-0000000a16f1', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'P1', '+5219991600001', 'Calle 1', 100, 'programado', '[]'::jsonb, 'web', now() - interval '1 hour', null, now() + interval '10 minutes', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000a16f2', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'P2', '+5219991600001', 'Calle 1', 100, 'programado', '[]'::jsonb, 'web', now() - interval '1 hour', null, now() + interval '3 hours', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000a16f3', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'P3', '+5219991600001', 'Calle 1', 100, 'pending', '[]'::jsonb, 'web', now() - interval '1 hour', null, now() + interval '15 minutes', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000a16f4', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'P4', '+5219991600001', null, 100, 'pending', '[]'::jsonb, 'web', now() - interval '1 hour', null, now() + interval '15 minutes', 'recoger', null),
  ('00000000-0000-0000-0000-0000000a16f5', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'P5', '+5219991600001', 'Calle 1', 100, 'pending', '[]'::jsonb, 'web', now() - interval '1 hour', null, now() + interval '15 minutes', 'domicilio', '00000000-0000-0000-0000-0000000a1614'),
  ('00000000-0000-0000-0000-0000000a16f6', '00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a16a1', 'P6', '+5219991600001', 'Calle 1', 100, 'cancelado', '[]'::jsonb, 'web', now() - interval '1 hour', null, now() + interval '10 minutes', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000a16d1', '00000000-0000-0000-0000-0000000a1602', '00000000-0000-0000-0000-0000000a16b1', 'LB1', '+5219991600009', 'Calle 9', 100, 'preparando', '[]'::jsonb, 'web', now() - interval '2 hours', null, null, null, null)
on conflict do nothing;

\echo ''
\echo '=== A) core.notification_preference -- preferencias por usuario ==='
\echo ''

\echo '--- 1. positivo: staff apaga SU aviso de pedido nuevo y lo lee de vuelta (1 fila propia) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', false, false);
select count(*)::int as propias_deberia_ser_1 from core.list_notification_preferences('00000000-0000-0000-0000-0000000a1601', false) where enabled = false and sonido = false;
rollback;

\echo '--- 2. positivo: owner edita la preferencia de su staff y el staff la ve (RLS por la tabla) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1611', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a1613', 'restaurantes.handoff.solicitado', false, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select count(*)::int as staff_la_ve_deberia_ser_1 from core.notification_preference where tipo = 'restaurantes.handoff.solicitado' and enabled = false;
rollback;

\echo '--- 3. positivo: admin edita la preferencia de un staff ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1612', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a1613', 'restaurantes.callback.pendiente', false, true);
select count(*)::int as admin_lista_todos_deberia_ser_1 from core.list_notification_preferences('00000000-0000-0000-0000-0000000a1601', true) where tipo = 'restaurantes.callback.pendiente';
rollback;

\echo '--- 4. RLS: un staff NO ve por la tabla las preferencias del owner (solo las suyas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1611', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', false, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select count(*)::int as ajenas_visibles_deberia_ser_0 from core.notification_preference where user_id = '00000000-0000-0000-0000-0000000a1611';
rollback;

\echo '--- 5. NEGATIVO (rol insuficiente): staff intenta editar la preferencia de otra persona -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a1614', 'restaurantes.pedido.nuevo', false, true) as should_fail;
rollback;

\echo '--- 6. NEGATIVO: admin intenta editar la preferencia de un owner -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1612', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a1611', 'restaurantes.pedido.nuevo', false, true) as should_fail;
rollback;

\echo '--- 7. NEGATIVO (rol insuficiente): staff pide la lista de TODO el equipo -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select * from core.list_notification_preferences('00000000-0000-0000-0000-0000000a1601', true) as should_fail;
rollback;

\echo '--- 8. CROSS-TENANT: owner de la Org B intenta editar la preferencia de un staff de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1615', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a1613', 'restaurantes.pedido.nuevo', false, true) as should_fail;
rollback;

\echo '--- 9. CROSS-TENANT: owner de la Org B intenta leer las preferencias de todo el equipo de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1615', true);
select * from core.list_notification_preferences('00000000-0000-0000-0000-0000000a1601', true) as should_fail;
rollback;

\echo '--- 10. ANON: sin GRANT de EXECUTE -- RECHAZADO ---'
begin;
set local role anon;
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', false, true) as should_fail;
rollback;

\echo '--- 11. ANON: la tabla no tiene ningun grant -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from core.notification_preference;
rollback;

\echo '--- 12. NEGATIVO: escritura directa a la tabla (sin GRANT de INSERT) -- RECHAZADA aunque sea la propia fila ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
insert into core.notification_preference (organization_id, user_id, tipo, enabled, sonido) values ('00000000-0000-0000-0000-0000000a1601', '00000000-0000-0000-0000-0000000a1613', 'restaurantes.pedido.nuevo', false, true) returning 1 as should_fail;
rollback;

\echo '--- 13. NEGATIVO: tipo de OTRO vertical en una organizacion de restaurantes -- RECHAZADO (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', null, 'hoteles.ticket.sla_vencido', false, true) as should_fail;
rollback;

\echo ''
\echo '=== B) core.emit_notification respeta la preferencia ==='
\echo ''

\echo '--- 14. sin preferencias: el aviso llega a owner + admin + staff (3 destinatarios) ---'
begin;
set local role authenticated;
select core.emit_notification('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'Pedido nuevo por atender', null, '/restaurantes/{orgSlug}/pedidos', null, null, 'r16:k1', array['staff'], interval '1 day') as emitidas_deberia_ser_3;
rollback;

\echo '--- 15. el staff apago ese tipo: llega solo a owner + admin (2) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', false, true);
select set_config('request.jwt.claim.sub', '', true);
select core.emit_notification('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'Pedido nuevo por atender', null, '/restaurantes/{orgSlug}/pedidos', null, null, 'r16:k2', array['staff'], interval '1 day') as emitidas_deberia_ser_2;
rollback;

\echo '--- 16. el staff apago OTRO tipo: el pedido nuevo le sigue llegando (3) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.handoff.solicitado', false, true);
select set_config('request.jwt.claim.sub', '', true);
select core.emit_notification('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'Pedido nuevo por atender', null, '/restaurantes/{orgSlug}/pedidos', null, null, 'r16:k3', array['staff'], interval '1 day') as emitidas_deberia_ser_3;
rollback;

\echo '--- 17. el owner apaga el suyo (los propietarios tambien pueden): llega a admin + staff (2) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1611', true);
select core.set_notification_preference('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', false, true);
select set_config('request.jwt.claim.sub', '', true);
select core.emit_notification('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'Pedido nuevo por atender', null, '/restaurantes/{orgSlug}/pedidos', null, null, 'r16:k4', array['staff'], interval '1 day') as emitidas_deberia_ser_2;
rollback;

\echo '--- 18. dedupe intacto: emitir dos veces la misma clave -> la segunda inserta 0 ---'
begin;
set local role authenticated;
select core.emit_notification('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'Pedido nuevo por atender', null, '/restaurantes/{orgSlug}/pedidos', null, null, 'r16:k5', array['staff'], interval '1 day');
select core.emit_notification('00000000-0000-0000-0000-0000000a1601', null, 'restaurantes.pedido.nuevo', 'operacion', 'info', 'Pedido nuevo por atender', null, '/restaurantes/{orgSlug}/pedidos', null, null, 'r16:k5', array['staff'], interval '1 day') as segunda_emision_deberia_ser_0;
rollback;

\echo '--- 19. sin regresion en otra vertical: el owner del hotel recibe su aviso (1) ---'
begin;
set local role authenticated;
select core.emit_notification('00000000-0000-0000-0000-0000000a1603', null, 'hoteles.ticket.sla_vencido', 'operacion', 'atencion', 'Tickets de huespedes con SLA vencido', null, '/hoteles/{orgSlug}/tickets', null, null, 'r16:h1', array['gm'], interval '1 day') as hotel_deberia_ser_1;
rollback;

\echo ''
\echo '=== C) Umbral de entrega tardia por sucursal ==='
\echo ''

\echo '--- 20. positivo: owner fija 30 min en la sucursal A1 y un staff de la organizacion lo lee (RLS) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1611', true);
select restaurantes.set_umbral_entrega_tardia('00000000-0000-0000-0000-0000000a16a1', 30);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select entrega_tardia_min as umbral_deberia_ser_30 from restaurantes.sucursal_avisos_config where property_id = '00000000-0000-0000-0000-0000000a16a1';
rollback;

\echo '--- 21. positivo: admin tambien puede cambiarlo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1612', true);
select restaurantes.set_umbral_entrega_tardia('00000000-0000-0000-0000-0000000a16a1', 60);
select entrega_tardia_min as umbral_deberia_ser_60 from restaurantes.sucursal_avisos_config where property_id = '00000000-0000-0000-0000-0000000a16a1';
rollback;

\echo '--- 22. NEGATIVO (rol insuficiente): staff intenta cambiarlo -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1613', true);
select restaurantes.set_umbral_entrega_tardia('00000000-0000-0000-0000-0000000a16a1', 30) as should_fail;
rollback;

\echo '--- 23. CROSS-TENANT: owner de la Org B intenta cambiar el umbral de una sucursal de la Org A -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1615', true);
select restaurantes.set_umbral_entrega_tardia('00000000-0000-0000-0000-0000000a16a1', 30) as should_fail;
rollback;

\echo '--- 24. NEGATIVO: minutos fuera de rango (5) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1611', true);
select restaurantes.set_umbral_entrega_tardia('00000000-0000-0000-0000-0000000a16a1', 5) as should_fail;
rollback;

\echo '--- 25. ANON: sin GRANT -- RECHAZADO ---'
begin;
set local role anon;
select restaurantes.set_umbral_entrega_tardia('00000000-0000-0000-0000-0000000a16a1', 30) as should_fail;
rollback;

\echo '--- 26. RLS cross-tenant: el owner de la Org B no ve ninguna configuracion de la Org A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1615', true);
select count(*)::int as ajenas_visibles_deberia_ser_0 from restaurantes.sucursal_avisos_config where organization_id = '00000000-0000-0000-0000-0000000a1601';
rollback;

\echo ''
\echo '=== D) Candidatos de las alertas operativas (solo sistema) ==='
\echo ''

\echo '--- 27. NEGATIVO: un usuario autenticado NO puede llamar al candidato (solo sistema) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a1611', true);
select * from restaurantes.avisos_operativos_candidatos() as should_fail;
rollback;

\echo '--- 28. ANON: sin GRANT -- RECHAZADO ---'
begin;
set local role anon;
select * from restaurantes.avisos_operativos_candidatos() as should_fail;
rollback;

\echo '--- 29. entrega tardia: L1 (preparando hace 2 h, umbral 45) SI ---'
begin;
set local role authenticated;
select count(*)::int as l1_deberia_ser_1 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16e1' and tipo = 'restaurantes.pedido.entrega_tardia';
rollback;

\echo '--- 30. entrega tardia: L2 (en_camino con hora prometida pasada) SI ---'
begin;
set local role authenticated;
select count(*)::int as l2_deberia_ser_1 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16e2' and tipo = 'restaurantes.pedido.entrega_tardia';
rollback;

\echo '--- 31. entrega tardia: L3 (hora prometida futura) NO ---'
begin;
set local role authenticated;
select count(*)::int as l3_deberia_ser_0 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16e3';
rollback;

\echo '--- 32. entrega tardia: L4 (sucursal con umbral de 240 min, aun dentro del margen) NO ---'
begin;
set local role authenticated;
select count(*)::int as l4_deberia_ser_0 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16e4';
rollback;

\echo '--- 33. entrega tardia: L5 en pending y L6 entregado NO (L5 si es un pedido sin aceptar: ver scenario QA R2) ---'
begin;
set local role authenticated;
select count(*)::int as l5_l6_deberia_ser_0 from restaurantes.avisos_operativos_candidatos() where order_id in ('00000000-0000-0000-0000-0000000a16e5', '00000000-0000-0000-0000-0000000a16e6') and tipo = 'restaurantes.pedido.entrega_tardia';
rollback;

\echo '--- 34. entrega tardia: L7 (prometido hace 30 h, fuera de la ventana de 24 h) NO ---'
begin;
set local role authenticated;
select count(*)::int as l7_deberia_ser_0 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16e7';
rollback;

\echo '--- 35. programado por vencer: P1 (sigue programado y entra en 10 min) SI ---'
begin;
set local role authenticated;
select count(*)::int as p1_deberia_ser_1 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16f1' and tipo = 'restaurantes.pedido.programado_por_vencer';
rollback;

\echo '--- 36. programado por vencer: P3 (en cocina, entra en 15 min, domicilio sin repartidor) SI ---'
begin;
set local role authenticated;
select count(*)::int as p3_deberia_ser_1 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16f3' and tipo = 'restaurantes.pedido.programado_por_vencer';
rollback;

\echo '--- 37. programado por vencer: P2 lejano, P4 recoger, P5 con repartidor y P6 cancelado NO ---'
begin;
set local role authenticated;
select count(*)::int as resto_deberia_ser_0 from restaurantes.avisos_operativos_candidatos() where order_id in ('00000000-0000-0000-0000-0000000a16f2', '00000000-0000-0000-0000-0000000a16f4', '00000000-0000-0000-0000-0000000a16f5', '00000000-0000-0000-0000-0000000a16f6') and tipo = 'restaurantes.pedido.programado_por_vencer';
rollback;

\echo '--- 38. cross-tenant: LB1 (Org B) es candidato con SU organization_id, nunca con el de la Org A ---'
begin;
set local role authenticated;
select count(*)::int as lb1_con_org_a_deberia_ser_0 from restaurantes.avisos_operativos_candidatos() where order_id = '00000000-0000-0000-0000-0000000a16d1' and organization_id = '00000000-0000-0000-0000-0000000a1601';
rollback;

\echo '--- 39. el reloj que manda el sistema se respeta: con p_now = hace 10 dias ninguno de los pedidos de hoy es candidato ---'
begin;
set local role authenticated;
select count(*)::int as con_reloj_pasado_deberia_ser_0 from restaurantes.avisos_operativos_candidatos(now() - interval '10 days') where order_id::text like '00000000-0000-0000-0000-0000000a16%';
rollback;

\echo ''
\echo '=== E) esquema de produccion a medio migrar ==='
\echo ''

\echo '--- 40. con restaurantes.avisos_operativos_candidatos ELIMINADA en esta transaccion, la llamada falla con 42883 y SAVEPOINT + ROLLBACK TO SAVEPOINT deja la transaccion utilizable (nunca 25P02) ---'
begin;
drop function restaurantes.avisos_operativos_candidatos(timestamptz);
set local role authenticated;
savepoint sp_verify_candidatos;
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.avisos_operativos_candidatos();
    raise exception 'se esperaba SQLSTATE 42883 (funcion eliminada), pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_candidatos;
release savepoint sp_verify_candidatos;
select 1 as transaccion_recuperada_tras_42883_deberia_ser_1;
rollback;
