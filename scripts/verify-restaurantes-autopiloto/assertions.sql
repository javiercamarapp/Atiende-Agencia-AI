-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/050_autopiloto_aprobaciones_y_estados.sql (autopiloto de restaurantes).
--
--   A. Historial de transiciones (order_status_events): una fila por transicion hecha por staff o por sistema, actor valido, append-only,
--      aislado por tenant, un actor arbitrario nunca rompe la actualizacion ni llega al historial.
--   B. Configuracion por sucursal: valores seguros por omision, solo owner/admin guarda, rangos validos, aislada por tenant, anon rechazado.
--   C. Pedido grande: retener (solo sistema) pasa a por_aprobar con su solicitud, idempotente; un usuario no puede.
--   D. Resolver: aprobar -> pending, rechazar -> cancelado con motivo de lista cerrada, doble clic = un efecto, cross-tenant, fuera de
--      alcance, sistema y anon rechazados; cancelacion (cancelar solo si no salio); compensacion (descuento de un solo uso con tope,
--      reposicion de $0 idempotente).
--   E. Escalado de solicitudes sin respuesta: una sola vez, solo sistema.
--   F. Estados sin clic: limpieza por tiempo, aceptacion automatica solo con bandera y comanda capturada, compare-and-set, pares permitidos.
--   G. Regreso automatico del handoff: una sola vez, no con pedido por aprobar, no con respuesta humana reciente, solo sistema.
--   H. Agotado solo por hoy: se repone al cambiar el dia de negocio de la sucursal (no el de UTC), un cambio manual lo cancela.
--   I. Muestras de tiempo de entrega y carga de cola; base SIN migrar (42883 recuperable).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias con sufijo deberia_ser_N marca el valor
-- esperado; un escenario sin alias debe terminar sin error (t_esperar_error exige el SQLSTATE exacto).
\pset pager off

create or replace function public.t_esperar_error(p_sql text, p_estado text) returns void
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;


insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e5001', 'restaurantes', 'Autopiloto Org A', 'autopiloto-a'),
  ('00000000-0000-0000-0000-0000000e5002', 'restaurantes', 'Autopiloto Org B (ajena)', 'autopiloto-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e50a2', '00000000-0000-0000-0000-0000000e5001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e50b1', '00000000-0000-0000-0000-0000000e5002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', 'a1', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e50a2', '00000000-0000-0000-0000-0000000e5001', 'a2', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e50b1', '00000000-0000-0000-0000-0000000e5002', 'b1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e5011', 'owner-a@autopiloto.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5012', 'admin-a1@autopiloto.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e5013', 'staff-a@autopiloto.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5014', 'rep-a@autopiloto.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5015', 'owner-b@autopiloto.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e5011', '00000000-0000-0000-0000-0000000e5001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e5012', '00000000-0000-0000-0000-0000000e5001', array['00000000-0000-0000-0000-0000000e50a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e5013', '00000000-0000-0000-0000-0000000e5001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e5014', '00000000-0000-0000-0000-0000000e5001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e5015', '00000000-0000-0000-0000-0000000e5002', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000e5001', 'pnid-autopiloto-a') on conflict do nothing;

insert into restaurantes.products (id, organization_id, name, price) values ('00000000-0000-0000-0000-0000000e50c1', '00000000-0000-0000-0000-0000000e5001', 'Taco de prueba', 50) on conflict do nothing;
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e50c1', 50, true) on conflict do nothing;

-- Pedidos de la organizacion A (sucursal A1 salvo indicacion).
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal, hora_recogida, programado_para) values
  ('00000000-0000-0000-0000-0000000e50d1', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C1', '5511111111', 100, 'pending', '[]', 'whatsapp', now(), null, 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e50d2', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C2', '5522222222', 5000, 'pending', '[]', 'whatsapp', now(), null, 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e50d3', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C3', '5511111112', 120, 'preparando', '[]', 'whatsapp', now(), null, 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e50d4', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C4', '5511111113', 130, 'en_camino', '[]', 'whatsapp', now(), null, 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e50d5', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C5', '5511111114', 140, 'entregado', '[]', 'web', '2026-03-09 23:00:00+00', '2026-03-10 00:00:00+00', 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e50d6', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C6', '5511111115', 150, 'listo_para_recoger', '[]', 'whatsapp', '2026-03-10 19:00:00+00', null, 'recoger', '2026-03-10 20:00:00+00', null),
  ('00000000-0000-0000-0000-0000000e50d7', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C7', '5511111116', 200, 'entregado', '[{"id":"p1","name":"Taco de pastor","price":50,"quantity":2},{"id":"p2","name":"Agua","price":20,"quantity":1}]', 'whatsapp', now() - interval '1 hour', now() - interval '10 minutes', 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e50d8', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C8', '5511111117', 80, 'pending', '[]', 'whatsapp', now(), null, 'recoger', null, null),
  ('00000000-0000-0000-0000-0000000e50d9', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C9', '5511111118', 4500, 'programado', '[]', 'voice', now(), null, 'domicilio', null, '2099-01-01 18:00:00+00'),
  ('00000000-0000-0000-0000-0000000e5d71', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C10', '5511111119', 200, 'entregado', '[{"id":"p1","name":"Taco de pastor","price":50,"quantity":2}]', 'whatsapp', now() - interval '1 hour', now() - interval '10 minutes', 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e5d72', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C11', '5511111120', 200, 'entregado', '[{"id":"p1","name":"Taco de pastor","price":50,"quantity":2}]', 'whatsapp', now() - interval '1 hour', now() - interval '10 minutes', 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e5d73', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'C12', '5511111121', 200, 'entregado', '[{"id":"p1","name":"Taco de pastor","price":50,"quantity":2}]', 'whatsapp', now() - interval '1 hour', now() - interval '10 minutes', 'domicilio', null, null),
  ('00000000-0000-0000-0000-0000000e50e1', '00000000-0000-0000-0000-0000000e5002', '00000000-0000-0000-0000-0000000e50b1', 'CB', '5599999999', 100, 'pending', '[]', 'web', now(), null, 'domicilio', null, null);
-- QA R2 caos-03: el plazo de no_recogido cuenta desde max(hora de recogida, cuando quedo listo). C6 quedo listo hace 2 h (el evento nace con la fila).
update restaurantes.order_status_events set at = now() - interval '2 hours' where order_id = '00000000-0000-0000-0000-0000000e50d6' and to_status = 'listo_para_recoger';

-- Pedidos ya retenidos (por_aprobar) con su solicitud pendiente.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal, programado_para) values
  ('00000000-0000-0000-0000-0000000e5da1', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'G1', '5522222222', 4500, 'por_aprobar', '[]', 'whatsapp', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e5da2', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'G2', '5522222223', 4600, 'por_aprobar', '[]', 'whatsapp', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e5da3', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'G3', '5522222224', 4700, 'por_aprobar', '[]', 'whatsapp', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e5da4', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'G4', '5522222225', 4800, 'por_aprobar', '[]', 'whatsapp', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e5da5', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'G5', '5522222226', 4900, 'por_aprobar', '[]', 'whatsapp', 'domicilio', null),
  ('00000000-0000-0000-0000-0000000e5da6', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'G6', '5522222227', 4950, 'por_aprobar', '[]', 'whatsapp', 'domicilio', '2099-01-01 18:00:00+00');

insert into restaurantes.solicitud_aprobacion (id, organization_id, property_id, tipo, order_id, detalle, solicitada_at) values
  ('00000000-0000-0000-0000-0000000e5101', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pedido_grande', '00000000-0000-0000-0000-0000000e5da1', '{"total":4500}', now()),
  ('00000000-0000-0000-0000-0000000e5102', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pedido_grande', '00000000-0000-0000-0000-0000000e5da2', '{"total":4600}', now()),
  ('00000000-0000-0000-0000-0000000e5103', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pedido_grande', '00000000-0000-0000-0000-0000000e5da3', '{"total":4700}', now()),
  ('00000000-0000-0000-0000-0000000e5104', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pedido_grande', '00000000-0000-0000-0000-0000000e5da4', '{"total":4800}', now() - interval '20 minutes'),
  ('00000000-0000-0000-0000-0000000e5105', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'pedido_grande', '00000000-0000-0000-0000-0000000e5da5', '{"total":4900}', now()),
  ('00000000-0000-0000-0000-0000000e5106', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pedido_grande', '00000000-0000-0000-0000-0000000e5da6', '{"total":4950}', now()),
  ('00000000-0000-0000-0000-0000000e5111', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'cancelacion', '00000000-0000-0000-0000-0000000e50d3', '{"origen":"cliente"}', now()),
  ('00000000-0000-0000-0000-0000000e5112', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'cancelacion', '00000000-0000-0000-0000-0000000e50d4', '{"origen":"cliente"}', now()),
  ('00000000-0000-0000-0000-0000000e5121', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'compensacion', '00000000-0000-0000-0000-0000000e50d7', '{"subtipo":"faltante"}', now()),
  ('00000000-0000-0000-0000-0000000e5122', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'compensacion', '00000000-0000-0000-0000-0000000e5d71', '{"subtipo":"equivocado"}', now()),
  ('00000000-0000-0000-0000-0000000e5123', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'compensacion', '00000000-0000-0000-0000-0000000e5d72', '{"subtipo":"frio"}', now()),
  ('00000000-0000-0000-0000-0000000e5124', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'compensacion', '00000000-0000-0000-0000-0000000e5d73', '{"subtipo":"tarde"}', now());

-- Handoffs tomados (WhatsApp) hace 2 horas.
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages) values
  ('00000000-0000-0000-0000-0000000e50f1', '00000000-0000-0000-0000-0000000e5001', '5533333333', '00000000-0000-0000-0000-0000000e50a1', '[{"role":"user","content":"hola"}]'),
  ('00000000-0000-0000-0000-0000000e50f3', '00000000-0000-0000-0000-0000000e5001', '5522222222', '00000000-0000-0000-0000-0000000e50a1', '[{"role":"user","content":"quiero 100 tacos"}]'),
  ('00000000-0000-0000-0000-0000000e50f5', '00000000-0000-0000-0000-0000000e5001', '5544444444', '00000000-0000-0000-0000-0000000e50a1', '[{"role":"user","content":"ayuda"}]'),
  ('00000000-0000-0000-0000-0000000e50f7', '00000000-0000-0000-0000-0000000e5001', '5566666666', '00000000-0000-0000-0000-0000000e50a1', '[{"role":"user","content":"ayer"}]');
insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, solicitada_at, ultimo_cliente_at, tomada_at) values
  ('00000000-0000-0000-0000-0000000e50f2', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'whatsapp', '00000000-0000-0000-0000-0000000e50f1', 'tomada', 'agente', now() - interval '3 hours', now() - interval '1 hour', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000e50f4', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'whatsapp', '00000000-0000-0000-0000-0000000e50f3', 'tomada', 'agente', now() - interval '3 hours', now() - interval '1 hour', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000e50f6', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'whatsapp', '00000000-0000-0000-0000-0000000e50f5', 'tomada', 'agente', now() - interval '3 hours', now() - interval '1 hour', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000e50f8', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'whatsapp', '00000000-0000-0000-0000-0000000e50f7', 'tomada', 'agente', now() - interval '60 hours', now() - interval '48 hours', now() - interval '47 hours');
insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload) values
  ('00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'whatsapp.handoff_reply', 'handoff-reply:00000000-0000-0000-0000-0000000e50f6:x1', '{"to":"5544444444","body":"un momento"}');

-- Comanda ya capturada a mano del pedido d8 (para la aceptacion automatica).
insert into restaurantes.pos_comanda_outbox (organization_id, property_id, order_id, idempotency_key, estado, modo, payload, folio) values
  ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e50d8', 'sr:autopiloto:d8', 'confirmada', 'activo', '{}', 'F-8');

-- Agotado hasta el 12-mar-2026 en A1 (hora de Mexico, UTC-6).
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-03-12' where property_id = '00000000-0000-0000-0000-0000000e50a1' and product_id = '00000000-0000-0000-0000-0000000e50c1';

\echo '=== A1. staff que mueve un pedido deja UNA fila de historial con su actor ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000e50d1';
select count(*) as eventos_staff_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e50d1' and from_status = 'pending' and to_status = 'preparando' and actor = 'staff:00000000-0000-0000-0000-0000000e5013';
rollback;

\echo '=== A2. el alta de un pedido ya deja su primera fila (from nulo) ==='
begin;
select count(*) as evento_alta_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e50d1' and from_status is null and to_status = 'pending';
rollback;

\echo '=== A3. sistema con actor pos: queda en el historial como pos con su motivo ==='
begin;
set local role authenticated;
select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d3', 'preparando', 'listo_para_recoger', 'pos', 'avance_pos');
reset role;
select count(*) as evento_pos_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e50d3' and actor = 'pos' and motivo = 'avance_pos' and to_status = 'listo_para_recoger';
rollback;

\echo '=== A4. un actor arbitrario en el setting nunca llega al historial ni rompe el UPDATE ==='
begin;
select set_config('app.actor', 'hacker; drop table x', true);
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000e50d1';
select count(*) as actor_sistema_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e50d1' and to_status = 'preparando' and actor = 'sistema';
rollback;

\echo '=== A5. append-only: authenticated no inserta, actualiza ni borra el historial -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$insert into restaurantes.order_status_events (order_id, organization_id, property_id, to_status, actor) values ('00000000-0000-0000-0000-0000000e50d1', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'x', 'sistema')$q$, '42501');
select public.t_esperar_error($q$update restaurantes.order_status_events set motivo = 'x'$q$, '42501');
select public.t_esperar_error($q$delete from restaurantes.order_status_events$q$, '42501');
rollback;

\echo '=== A6. cross-tenant: el owner de otra organizacion no ve el historial ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select count(*) as filas_ajenas_deberia_ser_0 from restaurantes.order_status_events where organization_id = '00000000-0000-0000-0000-0000000e5001';
rollback;

\echo '=== A7. el staff de la organizacion SI ve el historial de su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select (count(*) > 0)::int as ve_historial_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e50d1';
rollback;

\echo '=== A8. el repartidor no lee el historial ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select count(*) as filas_repartidor_deberia_ser_0 from restaurantes.order_status_events;
rollback;

\echo '=== A9. anon: sin acceso al historial -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.order_status_events$q$, '42501');
rollback;

\echo '=== B1. sin fila: la configuracion por omision es segura (cancelacion automatica apagada) ==='
begin;
set local role authenticated;
select cancelacion_auto::int as cancelacion_auto_deberia_ser_0 from restaurantes.autopiloto_config_leer('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1');
rollback;

\echo '=== B2. sin fila: minutos por omision (aprobacion 10) ==='
begin;
set local role authenticated;
select aprobacion_minutos as minutos_deberia_ser_10 from restaurantes.autopiloto_config_leer('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1');
rollback;

\echo '=== B3. owner guarda y lee de vuelta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select restaurantes.autopiloto_config_guardar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', true, false, 5, 20, 90, 8, 15, 10, 20, 15);
select aprobacion_minutos as minutos_guardados_deberia_ser_5 from restaurantes.autopiloto_config_leer('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1');
rollback;

\echo '=== B4. RECHAZADO: el staff de piso no guarda reglas de dinero -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select public.t_esperar_error($q$select restaurantes.autopiloto_config_guardar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', true, false, 5, 20, 90, 8, 15, null, null, 15)$q$, '42501');
rollback;

\echo '=== B5. RECHAZADO: la sesion de sistema no guarda configuracion -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.autopiloto_config_guardar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', true, false, 5, 20, 90, 8, 15, null, null, 15)$q$, '42501');
rollback;

\echo '=== B6. RECHAZADO: el owner de otra organizacion no guarda la de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select public.t_esperar_error($q$select restaurantes.autopiloto_config_guardar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', true, false, 5, 20, 90, 8, 15, null, null, 15)$q$, '42501');
rollback;

\echo '=== B7. RECHAZADO: valores fuera de rango -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select restaurantes.autopiloto_config_guardar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', true, false, 0, 20, 90, 8, 15, null, null, 15)$q$, '22023');
select public.t_esperar_error($q$select restaurantes.autopiloto_config_guardar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', true, false, 5, 20, 90, 8, 15, 10, 5, 15)$q$, '22023');
rollback;

\echo '=== B8. RECHAZADO: leer la configuracion de una sucursal ajena (sistema declarando otra organizacion) -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.autopiloto_config_leer('00000000-0000-0000-0000-0000000e5002', '00000000-0000-0000-0000-0000000e50a1')$q$, '42501');
rollback;

\echo '=== B9. RECHAZADO: anon no lee la configuracion -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.autopiloto_config_leer('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1')$q$, '42501');
rollback;

\echo '=== B10. RECHAZADO: la tabla de configuracion no es legible por authenticated -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.autopiloto_config$q$, '42501');
rollback;

\echo '=== C1. retener un pedido grande: pasa a por_aprobar ==='
begin;
set local role authenticated;
select creada::int as creada_deberia_ser_1 from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{"total":5000}');
rollback;

\echo '=== C2. retener deja el pedido en por_aprobar y UNA solicitud pendiente ==='
begin;
set local role authenticated;
select id from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{"total":5000}') r;
reset role;
select count(*) as pendientes_deberia_ser_1 from restaurantes.solicitud_aprobacion s join restaurantes.orders o on o.id = s.order_id where o.id = '00000000-0000-0000-0000-0000000e50d2' and o.status = 'por_aprobar' and s.estado = 'pendiente' and s.tipo = 'pedido_grande';
rollback;

\echo '=== C3. idempotente: retener dos veces deja UNA solicitud ==='
begin;
set local role authenticated;
select id from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{"total":5000}') r1;
select id from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{"total":5000}') r2;
reset role;
select count(*) as solicitudes_deberia_ser_1 from restaurantes.solicitud_aprobacion where order_id = '00000000-0000-0000-0000-0000000e50d2';
rollback;

\echo '=== C4. la segunda vez no crea ==='
begin;
set local role authenticated;
select id from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{"total":5000}') r1;
select creada::int as segunda_creada_deberia_ser_0 from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{"total":5000}') r2;
rollback;

\echo '=== C5. un pedido programado grande tambien se retiene ==='
begin;
set local role authenticated;
select creada::int as programado_creada_deberia_ser_1 from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d9', '{"total":4500}');
rollback;

\echo '=== C6. el historial registra pending -> por_aprobar con actor agente ==='
begin;
set local role authenticated;
select id from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{"total":5000}') r;
reset role;
select count(*) as evento_retenido_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e50d2' and from_status = 'pending' and to_status = 'por_aprobar' and actor = 'agente';
rollback;

\echo '=== C7. RECHAZADO: un usuario no retiene pedidos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d2', '{}')$q$, '42501');
rollback;

\echo '=== C8. RECHAZADO: retener un pedido de otra organizacion -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50e1', '{}')$q$, '42501');
rollback;

\echo '=== C9. RECHAZADO: un pedido que ya avanzo no se retiene -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.solicitud_pedido_grande_retener('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d3', '{}')$q$, '22023');
rollback;

\echo '=== D1. aprobar: el pedido pasa a pending ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select aplicado::int as aplicado_deberia_ser_1 from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null);
rollback;

\echo '=== D2. aprobar deja el pedido en pending y la solicitud resuelta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null) r;
select count(*) as pending_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e5da1' and status = 'pending';
rollback;

\echo '=== D2b. el motivo de texto libre al aprobar NO se guarda (solo la lista cerrada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', 'llamo Juan al 5512345678') r;
select count(*) as motivo_libre_guardado_deberia_ser_0 from restaurantes.solicitud_aprobacion where id = '00000000-0000-0000-0000-0000000e5101' and motivo_resolucion is not null;
rollback;

\echo '=== D3. doble clic: el segundo no aplica y el pedido sigue en pending ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null) r1;
select aplicado::int as segundo_aplicado_deberia_ser_0 from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null) r2;
rollback;

\echo '=== D4. doble clic: el historial tiene UNA transicion por_aprobar -> pending ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null) r1;
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null) r2;
select count(*) as transiciones_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e5da1' and from_status = 'por_aprobar' and to_status = 'pending' and actor = 'staff:00000000-0000-0000-0000-0000000e5013';
rollback;

\echo '=== D5. un pedido programado para el futuro aprobado vuelve a programado, no a cocina ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select estado_pedido from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5106', 'aprobar', null) r;
select count(*) as sigue_programado_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e5da6' and status = 'programado';
rollback;

\echo '=== D6. aprobar despues de rechazar no revive el pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5102', 'rechazar', 'sin_producto') r1;
select aplicado::int as aprobar_tras_rechazar_deberia_ser_0 from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5102', 'aprobar', null) r2;
rollback;

\echo '=== D7. rechazar: el pedido queda cancelado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5102', 'rechazar', 'fuera_de_zona') r;
select count(*) as cancelado_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e5da2' and status = 'cancelado';
rollback;

\echo '=== D8. rechazar deja el motivo en el historial ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5102', 'rechazar', 'fuera_de_zona') r;
select count(*) as motivo_historial_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e5da2' and to_status = 'cancelado' and motivo = 'fuera_de_zona';
rollback;

\echo '=== D9. RECHAZADO: rechazar sin motivo de la lista cerrada -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5102', 'rechazar', 'porque si')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5102', 'rechazar', null)$q$, '22023');
rollback;

\echo '=== D10. RECHAZADO: decision que no corresponde al tipo -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'cancelar', 'otro')$q$, '22023');
rollback;

\echo '=== D11. RECHAZADO: el owner de otra organizacion no resuelve (cross-tenant) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5002', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null)$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null)$q$, '42501');
rollback;

\echo '=== D12. RECHAZADO: el admin acotado a A1 no resuelve una solicitud de A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5012', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5105', 'aprobar', null)$q$, '42501');
rollback;

\echo '=== D13. RECHAZADO: el repartidor no resuelve -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5014', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null)$q$, '42501');
rollback;

\echo '=== D14. RECHAZADO: la sesion de sistema NUNCA aprueba -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null)$q$, '42501');
rollback;

\echo '=== D15. RECHAZADO: anon no resuelve -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null)$q$, '42501');
rollback;

\echo '=== D16. RECHAZADO: authenticated no escribe directo en la tabla de solicitudes -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$update restaurantes.solicitud_aprobacion set estado = 'resuelta'$q$, '42501');
select public.t_esperar_error($q$insert into restaurantes.solicitud_aprobacion (organization_id, property_id, tipo, order_id) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'cancelacion', '00000000-0000-0000-0000-0000000e50d1')$q$, '42501');
rollback;

\echo '=== D17. cross-tenant: el owner de otra organizacion no lee solicitudes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select count(*) as solicitudes_ajenas_deberia_ser_0 from restaurantes.solicitud_aprobacion where organization_id = '00000000-0000-0000-0000-0000000e5001';
rollback;

\echo '=== D18. el admin acotado a A1 solo lee las de A1 (no la de A2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5012', true);
select count(*) as de_a2_deberia_ser_0 from restaurantes.solicitud_aprobacion where property_id = '00000000-0000-0000-0000-0000000e50a2';
rollback;

\echo '=== D19. cancelacion: cancelar un pedido en preparacion lo deja cancelado con motivo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5111', 'cancelar', 'cliente_desistio') r;
select count(*) as cancelado_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e50d3' and status = 'cancelado';
rollback;

\echo '=== D20. cancelacion: un pedido que ya salio NO se cancela (queda mantener) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select aplicado::int as aplicado_deberia_ser_0 from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5112', 'cancelar', 'cliente_desistio');
rollback;

\echo '=== D21. cancelacion: el pedido en camino sigue en camino ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5112', 'cancelar', 'cliente_desistio') r;
select count(*) as en_camino_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e50d4' and status = 'en_camino';
rollback;

\echo '=== D22. cancelacion: mantener no toca el pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5111', 'mantener', null) r;
select count(*) as sigue_preparando_deberia_ser_1 from restaurantes.orders where id = '00000000-0000-0000-0000-0000000e50d3' and status = 'preparando';
rollback;

\echo '=== D23. compensacion descuento: crea un codigo de UN solo uso ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select codigo_descuento from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5123', 'descuento_proximo', null, 10) r;
select count(*) as codigo_un_uso_deberia_ser_1 from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000e5001' and code like 'GRACIAS-%' and max_uses = 1 and value = 10 and type = 'percentage';
rollback;

\echo '=== D24. compensacion descuento: sobre el tope de la sucursal -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5123', 'descuento_proximo', null, 50)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5123', 'descuento_proximo', null, null)$q$, '22023');
rollback;

\echo '=== D25. compensacion reponer: crea UN pedido de $0 a cocina con los renglones elegidos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select reposicion_order_id from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5121', 'reponer_producto', null, null, array[1]) r;
select count(*) as reposicion_deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e5001' and total = 0 and status = 'pending' and source = 'admin' and notes like 'Reposicion sin costo%' and (items->0->>'price')::numeric = 0 and items->0->>'name' = 'Agua';
rollback;

\echo '=== D26. compensacion reponer: doble clic no duplica la reposicion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select reposicion_order_id from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5121', 'reponer_producto', null, null, array[0, 1]) r1;
select reposicion_order_id from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5121', 'reponer_producto', null, null, array[0, 1]) r2;
select count(*) as reposiciones_deberia_ser_1 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e5001' and total = 0 and notes like 'Reposicion sin costo%';
rollback;

\echo '=== D27. compensacion reponer: sin renglones o con indices invalidos -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5121', 'reponer_producto', null, null, null)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5121', 'reponer_producto', null, null, array[9])$q$, '22023');
rollback;

\echo '=== D28. compensacion sin_compensacion: solo cierra, sin pedido ni codigo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select decision from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5124', 'sin_compensacion', null) r;
select count(*) as sin_efectos_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-0000000e5001' and total = 0;
rollback;

\echo '=== D29. crear una solicitud de cancelacion: idempotente por pedido ==='
begin;
set local role authenticated;
select id from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'cancelacion', '00000000-0000-0000-0000-0000000e50d1', '{"origen":"cliente"}') c1;
select creada::int as segunda_creada_deberia_ser_0 from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'cancelacion', '00000000-0000-0000-0000-0000000e50d1', '{"origen":"cliente"}') c2;
rollback;

\echo '=== D30. RECHAZADO: crear una solicitud con un pedido de otra organizacion -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'cancelacion', '00000000-0000-0000-0000-0000000e50e1', '{}')$q$, '42501');
rollback;

\echo '=== D31. RECHAZADO: el pedido grande no se crea por solicitud_crear -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pedido_grande', '00000000-0000-0000-0000-0000000e50d1', '{}')$q$, '22023');
rollback;

\echo '=== D32. pausa de sucursal: una sola pendiente por sucursal ==='
begin;
set local role authenticated;
select id from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pausa_sucursal', null, '{"abiertos":30}') p1;
select creada::int as segunda_pausa_creada_deberia_ser_0 from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'pausa_sucursal', null, '{"abiertos":31}') p2;
rollback;

\echo '=== E1. escalado: la solicitud de 20 minutos sale una sola vez ==='
begin;
set local role authenticated;
select id from restaurantes.solicitudes_por_escalar(now(), 100) e1 where organization_id = '00000000-0000-0000-0000-0000000e5001';
select count(*) as segunda_vuelta_deberia_ser_0 from restaurantes.solicitudes_por_escalar(now(), 100) e2;
rollback;

\echo '=== E2. escalado: solo la vencida (20 min) y no las recientes ==='
begin;
set local role authenticated;
select count(*) as escaladas_deberia_ser_1 from restaurantes.solicitudes_por_escalar(now(), 100);
rollback;

\echo '=== E3. RECHAZADO: un usuario no escala -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.solicitudes_por_escalar(now(), 10)$q$, '42501');
rollback;

\echo '=== E4. el minuto de la sucursal manda: con 5 minutos configurados salen todas las de A1 de mas de 5 minutos ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, aprobacion_minutos) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', 5) on conflict (property_id) do update set aprobacion_minutos = 5;
update restaurantes.solicitud_aprobacion set solicitada_at = now() - interval '6 minutes' where id = '00000000-0000-0000-0000-0000000e5101';
set local role authenticated;
select count(*) as escaladas_con_5_min_deberia_ser_2 from restaurantes.solicitudes_por_escalar(now(), 100) where organization_id = '00000000-0000-0000-0000-0000000e5001';
rollback;

\echo '=== F1. candidatos: el entregado de hace 6+ horas pasa a completado ==='
begin;
set local role authenticated;
select count(*) as candidato_completado_deberia_ser_1 from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e50d5' and to_status = 'completado';
rollback;

\echo '=== F2. candidatos: el listo para recoger vencido pasa a no_recogido ==='
begin;
set local role authenticated;
select count(*) as candidato_no_recogido_deberia_ser_1 from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e50d6' and to_status = 'no_recogido';
rollback;

\echo '=== F3. candidatos: sin bandera de aceptacion automatica NO se acepta ==='
begin;
set local role authenticated;
select count(*) as aceptacion_sin_bandera_deberia_ser_0 from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e50d8';
rollback;

\echo '=== F4. candidatos: con la bandera y la comanda confirmada pasa a preparando ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, aceptacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set aceptacion_auto = true;
set local role authenticated;
select count(*) as aceptacion_deberia_ser_1 from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e50d8' and to_status = 'preparando';
rollback;

\echo '=== F5. candidatos: nunca incluye pedidos por aprobar ni cancelados ==='
begin;
set local role authenticated;
select count(*) as por_aprobar_deberia_ser_0 from restaurantes.autopiloto_candidatos_estados(now(), 500) where from_status in ('por_aprobar', 'cancelado');
rollback;

\echo '=== F6. candidatos: el minuto por sucursal manda (recogida hace 100 min con 720 configurados no es candidato) ==='
begin;
update restaurantes.orders set hora_recogida = now() - interval '100 minutes' where id = '00000000-0000-0000-0000-0000000e50d6';
insert into restaurantes.autopiloto_config (property_id, organization_id, no_recogido_minutos) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', 720) on conflict (property_id) do update set no_recogido_minutos = 720;
set local role authenticated;
select count(*) as no_recogido_con_720_min_deberia_ser_0 from restaurantes.autopiloto_candidatos_estados(now(), 500) where order_id = '00000000-0000-0000-0000-0000000e50d6';
rollback;

\echo '=== F7. aplicar: transicion valida aplica una vez (compare-and-set) ==='
begin;
set local role authenticated;
select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d5', 'entregado', 'completado', 'sistema', 'limpieza_entregado') as primera;
select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d5', 'entregado', 'completado', 'sistema', 'limpieza_entregado')::int as segunda_aplicada_deberia_ser_0;
rollback;

\echo '=== F8. RECHAZADO: un par de estados fuera de la lista (cancelar) -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d1', 'pending', 'cancelado', 'sistema', 'x')$q$, '22023');
select public.t_esperar_error($q$select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5da1', 'por_aprobar', 'pending', 'sistema', 'x')$q$, '22023');
rollback;

\echo '=== F9. RECHAZADO: un usuario no aplica transiciones de sistema -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d5', 'entregado', 'completado', 'sistema', 'x')$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.autopiloto_candidatos_estados(now(), 10)$q$, '42501');
rollback;

\echo '=== F10. RECHAZADO: actor invalido -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d5', 'entregado', 'completado', 'staff:x', 'x')$q$, '22023');
rollback;

\echo '=== F11. aplicar sobre un pedido de OTRA organizacion no hace nada ==='
begin;
set local role authenticated;
select restaurantes.autopiloto_aplicar_transicion('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50e1', 'pending', 'preparando', 'sistema', 'x')::int as ajeno_aplicado_deberia_ser_0;
rollback;

\echo '=== F12. comandas para avance: solo comandas confirmadas en modo activo de pedidos en cocina ==='
begin;
update restaurantes.orders set status = 'preparando' where id = '00000000-0000-0000-0000-0000000e50d8';
set local role authenticated;
select count(*) as avance_pos_deberia_ser_1 from restaurantes.autopiloto_comandas_para_avance(50) where order_id = '00000000-0000-0000-0000-0000000e50d8' and folio = 'F-8';
rollback;

\echo '=== F13. RECHAZADO: un usuario no lista comandas para avance -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.autopiloto_comandas_para_avance(10)$q$, '42501');
rollback;

\echo '=== G1. handoff tomado hace 2 h sin respuesta humana: se devuelve al agente ==='
begin;
set local role authenticated;
select count(*) as devueltos_deberia_ser_1 from restaurantes.handoffs_devolver_vencidos(now(), 50) where handoff_id = '00000000-0000-0000-0000-0000000e50f2';
rollback;

\echo '=== G2. se devuelve UNA sola vez ==='
begin;
set local role authenticated;
select handoff_id from restaurantes.handoffs_devolver_vencidos(now(), 50) h1;
select count(*) as segunda_vuelta_deberia_ser_0 from restaurantes.handoffs_devolver_vencidos(now(), 50) h2;
rollback;

\echo '=== G3. queda el estado devuelta y la nota en la conversacion ==='
begin;
set local role authenticated;
select handoff_id from restaurantes.handoffs_devolver_vencidos(now(), 50) h1;
reset role;
select count(*) as nota_deberia_ser_1 from restaurantes.conversation_note n join restaurantes.conversation_handoff h on h.id = n.handoff_id where h.id = '00000000-0000-0000-0000-0000000e50f2' and h.estado = 'devuelta' and n.texto like 'Devuelta al agente automaticamente%';
rollback;

\echo '=== G4. dentro de la ventana de 24 h sale la frase fija (un solo mensaje) ==='
begin;
set local role authenticated;
select handoff_id from restaurantes.handoffs_devolver_vencidos(now(), 50) h1;
select handoff_id from restaurantes.handoffs_devolver_vencidos(now(), 50) h2;
reset role;
select count(*) as mensajes_deberia_ser_1 from restaurantes.messaging_outbox where dedupe_key = 'handoff-regreso:00000000-0000-0000-0000-0000000e50f2' and payload->>'body' = 'Gracias por esperar; le sigo atendiendo yo.';
rollback;

\echo '=== G5. fuera de la ventana de 24 h no sale mensaje (se devuelve sin escribir) ==='
begin;
set local role authenticated;
select handoff_id from restaurantes.handoffs_devolver_vencidos(now(), 50) h1;
reset role;
select count(*) as mensajes_fuera_de_ventana_deberia_ser_0 from restaurantes.messaging_outbox where dedupe_key = 'handoff-regreso:00000000-0000-0000-0000-0000000e50f8';
rollback;

\echo '=== G6. con un pedido por aprobar del mismo telefono NO se devuelve ==='
begin;
set local role authenticated;
select count(*) as excluido_deberia_ser_0 from restaurantes.handoffs_devolver_vencidos(now(), 50) where handoff_id = '00000000-0000-0000-0000-0000000e50f4';
rollback;

\echo '=== G7. con una respuesta humana reciente NO se devuelve ==='
begin;
set local role authenticated;
select count(*) as respuesta_reciente_deberia_ser_0 from restaurantes.handoffs_devolver_vencidos(now(), 50) where handoff_id = '00000000-0000-0000-0000-0000000e50f6';
rollback;

\echo '=== G8. el minuto por sucursal manda: con 200 minutos configurados no se devuelve la toma de 2 h ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, handoff_regreso_minutos) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', 200) on conflict (property_id) do update set handoff_regreso_minutos = 200;
set local role authenticated;
select count(*) as con_200_min_deberia_ser_0 from restaurantes.handoffs_devolver_vencidos(now(), 50) where handoff_id = '00000000-0000-0000-0000-0000000e50f2';
rollback;

\echo '=== G9. RECHAZADO: un usuario no devuelve handoffs en lote -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.handoffs_devolver_vencidos(now(), 10)$q$, '42501');
rollback;

\echo '=== H1. agotado hasta el 12: a las 22:00 del 11 en Mexico (04:00Z del 12) NO se repone ==='
begin;
set local role authenticated;
select count(*) as repuesto_antes_de_tiempo_deberia_ser_0 from restaurantes.agotados_reponer(timestamptz '2026-03-12 04:00:00+00');
rollback;

\echo '=== H2. agotado hasta el 12: a la 01:00 del 12 en Mexico (07:00Z) SI se repone ==='
begin;
set local role authenticated;
select count(*) as repuesto_deberia_ser_1 from restaurantes.agotados_reponer(timestamptz '2026-03-12 07:00:00+00');
rollback;

\echo '=== H3. al reponer queda disponible y sin fecha ==='
begin;
set local role authenticated;
select property_id from restaurantes.agotados_reponer(timestamptz '2026-03-12 07:00:00+00') r;
reset role;
select count(*) as disponible_deberia_ser_1 from restaurantes.branch_products where property_id = '00000000-0000-0000-0000-0000000e50a1' and is_available and agotado_hasta is null;
rollback;

\echo '=== H4. se repone UNA sola vez ==='
begin;
set local role authenticated;
select property_id from restaurantes.agotados_reponer(timestamptz '2026-03-12 07:00:00+00') r1;
select count(*) as segunda_vuelta_deberia_ser_0 from restaurantes.agotados_reponer(timestamptz '2026-03-12 07:00:00+00') r2;
rollback;

\echo '=== H5. un cambio manual de disponibilidad cancela el restablecimiento programado ==='
begin;
update restaurantes.branch_products set is_available = true where property_id = '00000000-0000-0000-0000-0000000e50a1';
update restaurantes.branch_products set is_available = false where property_id = '00000000-0000-0000-0000-0000000e50a1';
select count(*) as sin_fecha_deberia_ser_1 from restaurantes.branch_products where property_id = '00000000-0000-0000-0000-0000000e50a1' and agotado_hasta is null and not is_available;
rollback;

\echo '=== H6. marcar agotado hasta manana: staff con alcance ==='
begin;
update restaurantes.branch_products set is_available = true, agotado_hasta = null where property_id = '00000000-0000-0000-0000-0000000e50a1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e50c1', ((now() at time zone 'America/Mexico_City')::date + 1))::int as marcado_deberia_ser_1;
rollback;

\echo '=== H7. marcar agotado: deja no disponible con la fecha ==='
begin;
update restaurantes.branch_products set is_available = true, agotado_hasta = null where property_id = '00000000-0000-0000-0000-0000000e50a1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e50c1', ((now() at time zone 'America/Mexico_City')::date + 1));
select count(*) as no_disponible_deberia_ser_1 from restaurantes.branch_products where property_id = '00000000-0000-0000-0000-0000000e50a1' and not is_available and agotado_hasta is not null;
rollback;

\echo '=== H8. RECHAZADO: fecha de hoy o a mas de 7 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select public.t_esperar_error($q$select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e50c1', (now() at time zone 'America/Mexico_City')::date)$q$, '22023');
select public.t_esperar_error($q$select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e50c1', ((now() at time zone 'America/Mexico_City')::date + 30))$q$, '22023');
rollback;

\echo '=== H9. RECHAZADO: el owner de otra organizacion no marca agotados de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select public.t_esperar_error($q$select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e50c1', ((now() at time zone 'America/Mexico_City')::date + 1))$q$, '42501');
rollback;

\echo '=== H10. RECHAZADO: un usuario no repone en lote -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.agotados_reponer(now())$q$, '42501');
rollback;

\echo '=== I1. muestras: devuelve la carga de cola real (pedidos abiertos) ==='
begin;
set local role authenticated;
select (((restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'domicilio', now(), 30))->>'abiertos')::int > 0)::int as hay_abiertos_deberia_ser_1;
select (jsonb_typeof(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'domicilio', now(), 30)->'muestras') = 'array')::int as muestras_arreglo_deberia_ser_1;
rollback;

\echo '=== I2. muestras: sin entregas en la franja devuelve arreglo vacio ==='
begin;
set local role authenticated;
select jsonb_array_length(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'recoger', now(), 30)->'muestras') as vacias_deberia_ser_0;
rollback;

\echo '=== I3. muestras: filtra por franja (mismo dia de la semana y hora +-1) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, canal, created_at, delivered_at) values
  ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'M1', '5500000001', 10, 'entregado', '[]', 'whatsapp', 'domicilio', '2026-03-02 18:00:00+00', '2026-03-02 18:40:00+00'),
  ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'M2', '5500000002', 10, 'entregado', '[]', 'whatsapp', 'domicilio', '2026-03-02 18:30:00+00', '2026-03-02 19:30:00+00'),
  ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'M3', '5500000003', 10, 'entregado', '[]', 'whatsapp', 'domicilio', '2026-03-03 18:00:00+00', '2026-03-03 18:20:00+00'),
  ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'M4', '5500000004', 10, 'entregado', '[]', 'whatsapp', 'recoger', '2026-03-02 18:00:00+00', '2026-03-02 18:10:00+00');
set local role authenticated;
select jsonb_array_length(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'domicilio', timestamptz '2026-03-09 18:10:00+00', 30)->'muestras') as muestras_deberia_ser_2;
rollback;

\echo '=== I4. RECHAZADO: sucursal ajena -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5002', '00000000-0000-0000-0000-0000000e50a1', 'domicilio', now(), 30)$q$, '42501');
rollback;

\echo '=== I5. RECHAZADO: canal invalido -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'volando', now(), 30)$q$, '22023');
rollback;

\echo '=== I6. RECHAZADO: anon no lee muestras -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'domicilio', now(), 30)$q$, '42501');
rollback;

\echo '=== I7. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.solicitud_resolver(uuid, uuid, text, text, integer, integer[]);
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'aprobar', null);
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '=== J1. cancelacion automatica con la politica APAGADA (por omision): no cancela ==='
begin;
set local role authenticated;
select aplicado::int as cancela_con_politica_apagada_deberia_ser_0 from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d1', 'cliente_desistio');
rollback;

\echo '=== J2. cancelacion automatica con la politica encendida y sin comanda: cancela con actor agente y motivo ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select aplicado from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d1', 'cliente_desistio');
reset role;
select count(*) as evento_cancelacion_deberia_ser_1 from restaurantes.order_status_events where order_id = '00000000-0000-0000-0000-0000000e50d1' and to_status = 'cancelado' and actor = 'agente' and motivo = 'cliente_desistio';
rollback;

\echo '=== J3. cancelacion automatica: doble llamada cancela una sola vez ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select aplicado from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d1', 'cliente_desistio');
select aplicado::int as segunda_deberia_ser_0 from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d1', 'cliente_desistio');
rollback;

\echo '=== J4. cancelacion automatica: un pedido con comanda en el POS NO se cancela solo ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select aplicado::int as cancela_con_comanda_deberia_ser_0 from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d8', 'cliente_desistio');
rollback;

\echo '=== J5. cancelacion automatica: un pedido en preparacion NO se cancela solo ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select aplicado::int as cancela_en_cocina_deberia_ser_0 from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d3', 'cliente_desistio');
rollback;

\echo '=== J6. cancelacion automatica: un pedido programado sin comanda si se cancela ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select aplicado::int as cancela_programado_deberia_ser_1 from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d9', 'duplicado');
rollback;

\echo '=== J7. RECHAZADO: un usuario no usa la cancelacion de sistema -> 42501 ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d1', 'otro')$q$, '42501');
rollback;

\echo '=== J8. RECHAZADO: motivo fuera de la lista cerrada -> 22023 ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50d1', 'no quiero')$q$, '22023');
rollback;

\echo '=== J9. RECHAZADO: pedido de otra organizacion -> 42501 ==='
begin;
insert into restaurantes.autopiloto_config (property_id, organization_id, cancelacion_auto) values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', true) on conflict (property_id) do update set cancelacion_auto = true;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.pedido_cancelar_cliente('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50e1', 'otro')$q$, '42501');
rollback;

\echo '=== K1. la bandera de cancelacion del agente esta APAGADA por omision (sistema) ==='
begin;
set local role authenticated;
select restaurantes.autopiloto_org_config_leer('00000000-0000-0000-0000-0000000e5001')::int as bandera_por_omision_deberia_ser_0;
rollback;

\echo '=== K2. owner de toda la organizacion la enciende y se lee de vuelta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select restaurantes.autopiloto_org_config_guardar('00000000-0000-0000-0000-0000000e5001', true);
select restaurantes.autopiloto_org_config_leer('00000000-0000-0000-0000-0000000e5001')::int as bandera_encendida_deberia_ser_1;
rollback;

\echo '=== K3. la sesion de sistema lee la bandera encendida ==='
begin;
insert into restaurantes.autopiloto_org_config (organization_id, cancelacion_agente) values ('00000000-0000-0000-0000-0000000e5001', true) on conflict (organization_id) do update set cancelacion_agente = true;
set local role authenticated;
select restaurantes.autopiloto_org_config_leer('00000000-0000-0000-0000-0000000e5001')::int as sistema_lee_deberia_ser_1;
rollback;

\echo '=== K4. RECHAZADO: el admin acotado a una sucursal no cambia una regla de toda la organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5012', true);
select public.t_esperar_error($q$select restaurantes.autopiloto_org_config_guardar('00000000-0000-0000-0000-0000000e5001', true)$q$, '42501');
rollback;

\echo '=== K5. RECHAZADO: staff de piso no la cambia -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select public.t_esperar_error($q$select restaurantes.autopiloto_org_config_guardar('00000000-0000-0000-0000-0000000e5001', true)$q$, '42501');
rollback;

\echo '=== K6. RECHAZADO: la sesion de sistema no la cambia -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.autopiloto_org_config_guardar('00000000-0000-0000-0000-0000000e5001', true)$q$, '42501');
rollback;

\echo '=== K7. RECHAZADO: el owner de otra organizacion no la lee ni la cambia (cross-tenant) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5015', true);
select public.t_esperar_error($q$select restaurantes.autopiloto_org_config_leer('00000000-0000-0000-0000-0000000e5001')$q$, '42501');
select public.t_esperar_error($q$select restaurantes.autopiloto_org_config_guardar('00000000-0000-0000-0000-0000000e5001', true)$q$, '42501');
rollback;

\echo '=== K8. RECHAZADO: anon no la lee -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.autopiloto_org_config_leer('00000000-0000-0000-0000-0000000e5001')$q$, '42501');
rollback;

\echo '=== K9. RECHAZADO: la tabla no es legible por authenticated -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.autopiloto_org_config$q$, '42501');
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
