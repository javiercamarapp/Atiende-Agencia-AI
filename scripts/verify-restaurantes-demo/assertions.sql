-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales -- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/037_demo_organization.sql (restaurantes.demo_organization y
-- restaurantes.demo_limpiar).
--
-- Cada escenario corre en su propio `begin; ... rollback;`. Un escenario "RECHAZADO" termina en ERROR real de Postgres
-- (lo marca el comentario `-- as should_fail`); un escenario de conteo termina en `..._deberia_ser_N`.
\set ON_ERROR_STOP off
\pset pager off

-- Organizacion A: DEMO (marcada). Organizacion B: real (NO marcada) con datos del mismo rango ficticio, para probar el
-- aislamiento entre organizaciones.
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0001', 'restaurantes', 'Demo A', 'demo-a'),
  ('00000000-0000-0000-0000-0000000e0002', 'restaurantes', 'Real B (no demo)', 'real-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'a1'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0011', 'owner-a@demo.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0012', 'owner-b@demo.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0011', '00000000-0000-0000-0000-0000000e0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e0012', '00000000-0000-0000-0000-0000000e0002', null, 'owner', 'owner')
on conflict do nothing;

-- Marca demo SOLO de A (insertada como propietario de la base, igual que el seed).
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000e0001', 'verify-1');

-- Clientes y pedidos: en A hay 1 del volumen (0001), 1 del widget (0009) y 1 REAL; en B hay 1 con rango 0001 (ajeno).
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-0000000e0c01', '00000000-0000-0000-0000-0000000e0001', '+520001000001', 'Ficticio volumen', 1),
  ('00000000-0000-0000-0000-0000000e0c02', '00000000-0000-0000-0000-0000000e0001', '+520009000001', 'Ficticio widget', 1),
  ('00000000-0000-0000-0000-0000000e0c03', '00000000-0000-0000-0000-0000000e0001', '+529991234567', 'Cliente real de A', 1),
  ('00000000-0000-0000-0000-0000000e0c04', '00000000-0000-0000-0000-0000000e0002', '+520001000001', 'Rango 0001 de B', 1);

insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000e0f01', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0c01', 'Ficticio volumen', '+520001000001', 100, '[]'::jsonb, 'whatsapp', now() - interval '3 days'),
  ('00000000-0000-0000-0000-0000000e0f02', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0c02', 'Ficticio widget', '+520009000001', 100, '[]'::jsonb, 'whatsapp', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000e0f03', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0c03', 'Cliente real de A', '+529991234567', 100, '[]'::jsonb, 'whatsapp', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000e0f04', '00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0c04', 'Rango 0001 de B', '+520001000001', 100, '[]'::jsonb, 'whatsapp', now() - interval '3 days');

insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages, status) values
  ('00000000-0000-0000-0000-0000000e0d01', '00000000-0000-0000-0000-0000000e0001', '+520009000001', '00000000-0000-0000-0000-0000000e00a1', '[{"role":"user","content":"hola"}]'::jsonb, 'active'),
  ('00000000-0000-0000-0000-0000000e0d02', '00000000-0000-0000-0000-0000000e0001', '+529991234567', '00000000-0000-0000-0000-0000000e00a1', '[{"role":"user","content":"hola"}]'::jsonb, 'active');

insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo) values
  ('00000000-0000-0000-0000-0000000e0a01', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e0d01', 'pendiente', 'agente', 'queja');

\echo '=== D1. POSITIVO: la sesion de SISTEMA (sin usuario) lee la marca de A ==='
begin;
set local role authenticated;
select count(*)::int as marcas_leidas_por_sistema_deberia_ser_1 from restaurantes.demo_organization where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D2. POSITIVO: el owner de A lee la marca de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select count(*)::int as marcas_leidas_por_owner_a_deberia_ser_1 from restaurantes.demo_organization where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D3. CROSS-TENANT: el owner de B no ve la marca de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0012', true);
select count(*)::int as marcas_de_a_vistas_por_b_deberia_ser_0 from restaurantes.demo_organization where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D4. RECHAZADO (debe fallar): anon no lee la marca demo ==='
begin;
set local role anon;
select * from restaurantes.demo_organization; -- as should_fail
rollback;

\echo '=== D5. RECHAZADO (debe fallar): el owner de A no puede insertar marcas (ni de su propia organizacion) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000e0001', 'x');
rollback;

\echo '=== D6. RECHAZADO (debe fallar): el owner de B no puede marcar SU organizacion como demo ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0012', true);
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000e0002', 'x');
rollback;

\echo '=== D7. RECHAZADO (debe fallar): el owner de A no puede apagar ni cambiar la marca (UPDATE) ==='
begin;
-- as should_fail (UPDATE sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
update restaurantes.demo_organization set activo = false where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D8. RECHAZADO (debe fallar): el owner de A no puede quitar la marca (DELETE) ==='
begin;
-- as should_fail (DELETE sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
delete from restaurantes.demo_organization where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D9. RECHAZADO (debe fallar): demo_limpiar se niega sobre una organizacion NO marcada como demo ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0002', 'volumen') as should_fail;
rollback;

\echo '=== D10. RECHAZADO (debe fallar): demo_limpiar se niega con un usuario autenticado (guarda auth.uid()) aunque tenga EXECUTE ==='
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'volumen') as should_fail;
rollback;

\echo '=== D11. RECHAZADO (debe fallar): un rol de la aplicacion no tiene EXECUTE sobre demo_limpiar ==='
begin;
set local role authenticated;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'volumen') as should_fail;
rollback;

\echo '=== D12. RECHAZADO (debe fallar): modo invalido ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'borrar_todo_ya') as should_fail;
rollback;

\echo '=== D13. POSITIVO: limpiar el volumen de A borra el pedido ficticio 0001 ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'volumen');
select count(*)::int as pedidos_0001_de_a_tras_limpiar_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e0001' and customer_phone like '+520001%';
rollback;

\echo '=== D14. POSITIVO: limpiar el volumen NO toca los pedidos reales ni los del widget de A ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'volumen');
select count(*)::int as pedidos_restantes_de_a_deberia_ser_2 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D15. CROSS-TENANT: limpiar el volumen de A NO toca el pedido del mismo rango en B ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'volumen');
select count(*)::int as pedidos_de_b_intactos_deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e0002';
rollback;

\echo '=== D16. POSITIVO: limpiar sesiones del widget borra su conversacion Y su toma de handoff ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'sesiones_widget');
select count(*)::int as handoffs_del_widget_tras_limpiar_deberia_ser_0 from restaurantes.conversation_handoff where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D17. POSITIVO: limpiar sesiones del widget NO borra la conversacion real de A ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'sesiones_widget');
select count(*)::int as conversaciones_de_a_restantes_deberia_ser_1 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D18. POSITIVO: con horas=24 una sesion reciente del widget NO se borra (solo las viejas) ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'sesiones_widget', 24);
select count(*)::int as sesion_reciente_sigue_deberia_ser_2 from restaurantes.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D19. POSITIVO: limpiar todo borra la organizacion demo completa por cascada ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'todo');
select count(*)::int as pedidos_de_a_tras_todo_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e0001';
rollback;

\echo '=== D20. CROSS-TENANT: limpiar todo en A deja intacta la organizacion B ==='
begin;
select restaurantes.demo_limpiar('00000000-0000-0000-0000-0000000e0001', 'todo');
select count(*)::int as organizaciones_b_deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000e0002';
rollback;

\echo 'los escenarios 4/5/6/7/8/9/10/11/12 deben terminar en ERROR; el resto en el valor indicado por el alias.'
