-- Fixtures + escenarios contra Postgres REAL (GRANT + auth.uid() reales, nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/066_whatsapp_estados_entrega.sql: estados de entrega de WhatsApp (statuses de Meta).
--
--   A. complete_messaging_outbox_sent(uuid, text, text): guarda wamid y tipo de envio; la de un argumento sigue funcionando; un wamid repetido
--      no deja el mensaje en `processing`; staff -> 42501.
--   B. registrar_estado_entrega_whatsapp: avance sin retroceso, failed gana y conserva su primer error, idempotencia, motivo del fallo, pedido
--      ligado, conteo de fallos de la ultima hora.
--   C. Aislamiento: cross-tenant (mismo wamid en dos organizaciones), staff -> 42501, anon -> 42501, estado invalido -> 22023, la tabla cerrada al
--      staff, indice unico parcial.
--   D. KPI diario de entrega por sucursal: conteos, sucursal ajena, organizacion ajena, sin sesion de usuario, anon.
--   E. Retencion: el trigger y la purga de 046 borran wamid y estado de entrega junto con el payload.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar
-- en ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

-- Ayudante de pruebas: ejecuta una sentencia y exige el SQLSTATE exacto (como invoker, sin cambiar de rol).
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
  ('00000000-0000-0000-0000-0000000e5001', 'restaurantes', 'Entrega Org A', 'entrega-a'),
  ('00000000-0000-0000-0000-0000000e5002', 'restaurantes', 'Entrega Org B', 'entrega-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e50a2', '00000000-0000-0000-0000-0000000e5001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e50b1', '00000000-0000-0000-0000-0000000e5002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', 'a1', null),
  ('00000000-0000-0000-0000-0000000e50a2', '00000000-0000-0000-0000-0000000e5001', 'a2', null),
  ('00000000-0000-0000-0000-0000000e50b1', '00000000-0000-0000-0000-0000000e5002', 'b1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e5011', 'owner-a@entrega.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5012', 'owner-b@entrega.example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e5011', '00000000-0000-0000-0000-0000000e5001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e5012', '00000000-0000-0000-0000-0000000e5002', null, 'owner', 'owner')
on conflict do nothing;

-- Pedidos: oA1 y oA2 de la organizacion A (sucursales distintas), oB1 de la B.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, customer_email, branch, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000e50e1', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'Cliente Uno', '+5219990000001', 'uno@entrega.example.com', 'Sucursal A1', 100, 'en_camino', '[]'::jsonb, 'whatsapp', '2026-03-10 17:00:00+00'),
  ('00000000-0000-0000-0000-0000000e50e2', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'Cliente Dos', '+5219990000002', null, null, 100, 'en_camino', '[]'::jsonb, 'whatsapp', '2026-03-10 17:00:00+00'),
  ('00000000-0000-0000-0000-0000000e50e3', '00000000-0000-0000-0000-0000000e5002', '00000000-0000-0000-0000-0000000e50b1', 'Cliente Tres', '+5219990000003', 'tres@entrega.example.com', 'Sucursal B1', 100, 'en_camino', '[]'::jsonb, 'whatsapp', '2026-03-10 17:00:00+00')
on conflict do nothing;

-- Mensajes de la cola. 'r0' (A): aviso en_camino enviado como TEXTO con plantilla disponible, aun sin estado de entrega mas alla de `sent`.
-- 'r1' (A): aviso 'entregado' enviado como PLANTILLA. 'rb' (B): MISMO wamid que r0, otra organizacion.
-- 'p1','p2','p3' (A): en `processing`, listos para cerrarse. 'rt' (A): aviso que no es de pedido (respuesta del agente).
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, sent_at, provider_message_id, enviado_como, delivery_status, delivery_updated_at) values
  ('00000000-0000-0000-0000-0000000e5101', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.en_camino', 'order-status:00000000-0000-0000-0000-0000000e50e1:en_camino',
     '{"to": "+5219990000001", "phone_number_id": "pn-a", "body": "va en camino", "template": {"name": "pedido_en_camino", "language": "es_MX", "params": ["x"]}}'::jsonb,
     'sent', now(), 'wamid.R0', 'texto', 'sent', now()),
  ('00000000-0000-0000-0000-0000000e5102', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.entregado', 'order-status:00000000-0000-0000-0000-0000000e50e1:entregado',
     '{"to": "+5219990000001", "phone_number_id": "pn-a", "body": "entregado", "template": {"name": "pedido_entregado", "language": "es_MX", "params": ["x"]}}'::jsonb,
     'sent', now(), 'wamid.R1', 'plantilla', 'sent', now()),
  ('00000000-0000-0000-0000-0000000e5103', '00000000-0000-0000-0000-0000000e5002', 'whatsapp', 'order.status.en_camino', 'order-status:00000000-0000-0000-0000-0000000e50e3:en_camino',
     '{"to": "+5219990000003", "phone_number_id": "pn-b", "body": "va en camino"}'::jsonb,
     'sent', now(), 'wamid.R0', 'texto', 'sent', now()),
  ('00000000-0000-0000-0000-0000000e5104', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'whatsapp.inbound_reply', 'reply:abc',
     '{"to": "+5219990000001", "phone_number_id": "pn-a", "body": "hola"}'::jsonb,
     'sent', now(), 'wamid.RT', 'texto', 'sent', now()),
  ('00000000-0000-0000-0000-0000000e5111', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'whatsapp.inbound_reply', 'reply:p1', '{"to": "+5219990000001", "phone_number_id": "pn-a", "body": "p1"}'::jsonb, 'processing', null, null, null, null, null),
  ('00000000-0000-0000-0000-0000000e5112', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'whatsapp.inbound_reply', 'reply:p2', '{"to": "+5219990000001", "phone_number_id": "pn-a", "body": "p2"}'::jsonb, 'processing', null, null, null, null, null),
  ('00000000-0000-0000-0000-0000000e5113', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'whatsapp.inbound_reply', 'reply:p3', '{"to": "+5219990000001", "phone_number_id": "pn-a", "body": "p3"}'::jsonb, 'processing', null, null, null, null, null);
update restaurantes.messaging_outbox set claimed_at = now() where status = 'processing';

-- KPI (D): 2026-03-10 (12:00 America/Mexico_City = 18:00 UTC), sucursal A1: 5 avisos de pedido con wamid.
--   k1 delivered, k2 read, k3 failed (plantilla sin usar), k4 failed (numero no entregable), k5 sent (sin estado).
-- No cuentan en A1: k6 (pedido de A2), k7 (organizacion B), k8 (no es aviso de pedido), k9 (sin wamid: anterior a la migracion).
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, sent_at, provider_message_id, enviado_como, delivery_status, delivery_failure_reason) values
  ('00000000-0000-0000-0000-0000000e5201', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.preparando', 'order-status:00000000-0000-0000-0000-0000000e50e1:preparando', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:00:00+00', 'wamid.K1', 'texto', 'delivered', null),
  ('00000000-0000-0000-0000-0000000e5202', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.en_camino', 'order-status:00000000-0000-0000-0000-0000000e50e1:en_camino:k2', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:05:00+00', 'wamid.K2', 'texto', 'read', null),
  ('00000000-0000-0000-0000-0000000e5203', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.listo_para_recoger', 'order-status:00000000-0000-0000-0000-0000000e50e1:listo_para_recoger', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:10:00+00', 'wamid.K3', 'texto', 'failed', 'fuera_de_ventana_plantilla_sin_usar'),
  ('00000000-0000-0000-0000-0000000e5204', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.cancelado', 'order-status:00000000-0000-0000-0000-0000000e50e1:cancelado', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:15:00+00', 'wamid.K4', 'texto', 'failed', 'numero_no_entregable'),
  ('00000000-0000-0000-0000-0000000e5205', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.entregado', 'order-status:00000000-0000-0000-0000-0000000e50e1:entregado:k5', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:20:00+00', 'wamid.K5', 'texto', 'sent', null),
  ('00000000-0000-0000-0000-0000000e5206', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.en_camino', 'order-status:00000000-0000-0000-0000-0000000e50e2:en_camino', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:00:00+00', 'wamid.K6', 'texto', 'delivered', null),
  ('00000000-0000-0000-0000-0000000e5207', '00000000-0000-0000-0000-0000000e5002', 'whatsapp', 'order.status.en_camino', 'order-status:00000000-0000-0000-0000-0000000e50e3:en_camino:k7', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:00:00+00', 'wamid.K7', 'texto', 'delivered', null),
  ('00000000-0000-0000-0000-0000000e5208', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'whatsapp.inbound_reply', 'reply:k8', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:00:00+00', 'wamid.K8', 'texto', 'delivered', null),
  ('00000000-0000-0000-0000-0000000e5209', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.en_camino', 'order-status:00000000-0000-0000-0000-0000000e50e1:en_camino:k9', '{"body": "x"}'::jsonb, 'sent', '2026-03-10 18:00:00+00', null, null, null, null);

-- Retencion (E): un aviso viejo con estado de entrega, y su payload todavia con datos.
insert into restaurantes.messaging_outbox (id, organization_id, channel, event_type, dedupe_key, payload, status, sent_at, created_at, provider_message_id, enviado_como, delivery_status, delivery_updated_at, delivery_error_code, delivery_error_title, delivery_failure_reason) values
  ('00000000-0000-0000-0000-0000000e5301', '00000000-0000-0000-0000-0000000e5001', 'whatsapp', 'order.status.en_camino', 'order-status:00000000-0000-0000-0000-0000000e50e1:en_camino:viejo',
     '{"to": "+5219990000001", "phone_number_id": "pn-a", "body": "viejo"}'::jsonb, 'sent', now() - interval '200 days', now() - interval '200 days', 'wamid.E1', 'texto', 'failed', now() - interval '200 days', 131047, 'Re-engagement message', 'fuera_de_ventana');

\echo '=== A1. POSITIVO: la sesion de sistema cierra p1 como enviado guardando el wamid y como salio ==='
begin;
set local role authenticated;
select restaurantes.complete_messaging_outbox_sent('00000000-0000-0000-0000-0000000e5111', 'wamid.P1', 'plantilla');
reset role;
select count(*) as p1_deberia_ser_1 from restaurantes.messaging_outbox
  where id = '00000000-0000-0000-0000-0000000e5111' and status = 'sent' and provider_message_id = 'wamid.P1' and enviado_como = 'plantilla' and delivery_status = 'sent' and sent_at is not null and delivery_updated_at is not null;
rollback;

\echo '=== A2. la sobrecarga de UN argumento (la que usa el TypeScript contra una base sin migrar) sigue cerrando sin wamid ==='
begin;
set local role authenticated;
select restaurantes.complete_messaging_outbox_sent('00000000-0000-0000-0000-0000000e5112');
reset role;
select count(*) as p2_deberia_ser_1 from restaurantes.messaging_outbox
  where id = '00000000-0000-0000-0000-0000000e5112' and status = 'sent' and provider_message_id is null and delivery_status is null;
rollback;

\echo '=== A3. un wamid repetido en la organizacion no deja el mensaje en processing: se cierra sin guardar el wamid ==='
begin;
set local role authenticated;
select restaurantes.complete_messaging_outbox_sent('00000000-0000-0000-0000-0000000e5113', 'wamid.R0', 'texto');
reset role;
select count(*) as p3_deberia_ser_1 from restaurantes.messaging_outbox
  where id = '00000000-0000-0000-0000-0000000e5113' and status = 'sent' and provider_message_id is null;
rollback;

\echo '=== A4. una fila que NO esta en processing no se toca ==='
begin;
set local role authenticated;
select restaurantes.complete_messaging_outbox_sent('00000000-0000-0000-0000-0000000e5101', 'wamid.OTRO', 'plantilla');
reset role;
select count(*) as r0_intacta_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5101' and provider_message_id = 'wamid.R0' and enviado_como = 'texto';
rollback;

\echo '=== A5. RECHAZADO: un staff autenticado no cierra mensajes con wamid -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select restaurantes.complete_messaging_outbox_sent('00000000-0000-0000-0000-0000000e5111', 'wamid.X', 'texto')$q$, '42501');
rollback;

\echo '=== B1. delivered avanza el estado de entrega de r0 ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'delivered');
reset role;
select count(*) as r0_delivered_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5101' and delivery_status = 'delivered';
rollback;

\echo '=== B2. read antes que delivered no retrocede: llega read y luego delivered, queda read ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'read');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'delivered');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'sent');
reset role;
select count(*) as r0_read_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5101' and delivery_status = 'read';
rollback;

\echo '=== B3. IDEMPOTENTE: el mismo estado repetido responde sin_cambio y no mueve delivery_updated_at ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'delivered');
reset role;
update restaurantes.messaging_outbox set delivery_updated_at = '2026-01-01 00:00:00+00' where id = '00000000-0000-0000-0000-0000000e5101';
set local role authenticated;
select count(*) as segunda_sin_cambio_deberia_ser_1 from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'delivered') where resultado = 'sin_cambio';
reset role;
select count(*) as updated_at_intacto_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5101' and delivery_updated_at = '2026-01-01 00:00:00+00';
rollback;

\echo '=== B4. failed gana: delivered, luego failed con error, luego read -> queda failed con el codigo del primer error ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'delivered');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'Re-engagement message');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'read');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131026, 'Otro error');
reset role;
select count(*) as r0_failed_deberia_ser_1 from restaurantes.messaging_outbox
  where id = '00000000-0000-0000-0000-0000000e5101' and delivery_status = 'failed' and delivery_error_code = 131047 and delivery_error_title = 'Re-engagement message' and status = 'sent';
rollback;

\echo '=== B5. 131047 con plantilla disponible pero enviado como TEXTO -> fuera_de_ventana_plantilla_sin_usar ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'Re-engagement message');
reset role;
select count(*) as motivo_plantilla_sin_usar_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5101' and delivery_failure_reason = 'fuera_de_ventana_plantilla_sin_usar';
rollback;

\echo '=== B6. 131047 enviado como PLANTILLA -> fuera_de_ventana (la plantilla si se uso) ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R1', 'failed', 131047, 'Re-engagement message');
reset role;
select count(*) as motivo_fuera_de_ventana_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5102' and delivery_failure_reason = 'fuera_de_ventana';
rollback;

\echo '=== B7. otros codigos de Meta: 131026 numero_no_entregable, 132001 plantilla, 131049 limite_marketing, 500 otro ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131026, 'Message undeliverable');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R1', 'failed', 132001, 'Template does not exist');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.RT', 'failed', 131049, 'Marketing limit');
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.K1', 'failed', 500, 'Otro');
reset role;
select count(*) as motivos_deberia_ser_4 from restaurantes.messaging_outbox
  where (id = '00000000-0000-0000-0000-0000000e5101' and delivery_failure_reason = 'numero_no_entregable')
     or (id = '00000000-0000-0000-0000-0000000e5102' and delivery_failure_reason = 'plantilla')
     or (id = '00000000-0000-0000-0000-0000000e5104' and delivery_failure_reason = 'limite_marketing')
     or (id = '00000000-0000-0000-0000-0000000e5201' and delivery_failure_reason = 'otro');
rollback;

\echo '=== B8. el aviso de estado de pedido devuelve el pedido ligado y su estado; la respuesta del agente no ==='
begin;
set local role authenticated;
select count(*) as pedido_ligado_deberia_ser_1 from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'x')
  where order_id = '00000000-0000-0000-0000-0000000e50e1' and order_status = 'en_camino' and resultado = 'actualizado' and estado = 'failed';
select count(*) as sin_pedido_deberia_ser_1 from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.RT', 'failed', 131047, 'x')
  where order_id is null and order_status is null and event_type = 'whatsapp.inbound_reply';
rollback;

\echo '=== B8b. RESPALDO POR CORREO: al pasar a failed el aviso de pedido, la funcion devuelve correo, cliente, sucursal y total del pedido (la sesion de sistema no lee orders) ==='
begin;
set local role authenticated;
select count(*) as respaldo_correo_deberia_ser_1 from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'x')
  where pedido_correo = 'uno@entrega.example.com' and pedido_cliente = 'Cliente Uno' and pedido_sucursal = 'Sucursal A1' and pedido_total = 100;
rollback;

\echo '=== B8c. el correo SOLO sale en la transicion a failed: un status repetido, un delivered y un mensaje que no es de pedido no lo devuelven ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'x');
select count(*) as sin_correo_deberia_ser_3 from (
  select pedido_correo from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'x')
  union all select pedido_correo from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R1', 'delivered')
  union all select pedido_correo from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.RT', 'failed', 131047, 'x')
) t where pedido_correo is null;
rollback;

\echo '=== B8d. CROSS-TENANT: el correo del pedido de la organizacion A nunca sale por un webhook de la B, ni siquiera con el mismo wamid ==='
begin;
set local role authenticated;
select count(*) as correo_ajeno_deberia_ser_0 from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5002', 'wamid.R0', 'failed', 131047, 'x') where pedido_correo = 'uno@entrega.example.com';
rollback;

\echo '=== B9. fallidas_ultima_hora cuenta los fallos recientes de la organizacion (dos fallos nuevos -> 2) ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'x');
select fallidas_ultima_hora as fallidas_deberia_ser_2 from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R1', 'failed', 131047, 'x');
rollback;

\echo '=== C1. CROSS-TENANT: la organizacion B no ve ni toca el wamid que solo tiene la A (desconocido) ==='
begin;
set local role authenticated;
select count(*) as desconocido_deberia_ser_1 from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5002', 'wamid.R1', 'failed', 131047, 'x') where resultado = 'desconocido';
reset role;
select count(*) as r1_intacta_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5102' and delivery_status = 'sent';
rollback;

\echo '=== C2. CROSS-TENANT: el MISMO wamid existe en A y en B; registrar con la organizacion B solo cambia la fila de B ==='
begin;
set local role authenticated;
select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5002', 'wamid.R0', 'failed', 131026, 'x');
reset role;
select count(*) as solo_b_cambio_deberia_ser_1 from restaurantes.messaging_outbox
  where (id = '00000000-0000-0000-0000-0000000e5103' and delivery_status = 'failed') or (id = '00000000-0000-0000-0000-0000000e5101' and delivery_status = 'failed');
rollback;

\echo '=== C3. RECHAZADO: un staff autenticado no registra estados de entrega -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'x')$q$, '42501');
rollback;

\echo '=== C4. RECHAZADO: anon no registra estados de entrega -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'failed', 131047, 'x')$q$, '42501');
rollback;

\echo '=== C5. RECHAZADO: estado o wamid invalidos -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', 'wamid.R0', 'borrado')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.registrar_estado_entrega_whatsapp('00000000-0000-0000-0000-0000000e5001', '', 'read')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.registrar_estado_entrega_whatsapp(null, 'wamid.R0', 'read')$q$, '22023');
rollback;

\echo '=== C6. RECHAZADO: el staff no lee ni escribe messaging_outbox directamente (sigue cerrada) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select provider_message_id from restaurantes.messaging_outbox$q$, '42501');
select public.t_esperar_error($q$update restaurantes.messaging_outbox set delivery_status = 'read'$q$, '42501');
rollback;

\echo '=== C7. el indice unico parcial: el mismo wamid dos veces en la MISMA organizacion -> 23505 ==='
begin;
select public.t_esperar_error($q$update restaurantes.messaging_outbox set provider_message_id = 'wamid.R0' where id = '00000000-0000-0000-0000-0000000e5102'$q$, '23505');
rollback;

\echo '=== C8. un estado de entrega fuera del catalogo no entra a la tabla -> 23514 ==='
begin;
select public.t_esperar_error($q$update restaurantes.messaging_outbox set delivery_status = 'borrado' where id = '00000000-0000-0000-0000-0000000e5102'$q$, '23514');
rollback;

\echo '=== D1. KPI: el owner de A ve en la sucursal A1 5 enviados, 2 entregados, 1 leido, 2 fallidos y 1 sin estado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select count(*) as kpi_a1_deberia_ser_1 from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', date '2026-03-10', date '2026-03-10')
  where fecha = date '2026-03-10' and enviados = 5 and entregados = 2 and leidos = 1 and fallidos = 2 and sin_estado = 1;
rollback;

\echo '=== D2. KPI: los fallos vienen por motivo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select count(*) as kpi_motivos_deberia_ser_1 from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', date '2026-03-10', date '2026-03-10')
  where fallos_por_motivo = '{"numero_no_entregable": 1, "fuera_de_ventana_plantilla_sin_usar": 1}'::jsonb;
rollback;

\echo '=== D3. KPI: la sucursal A2 solo ve su propio aviso (1 enviado, 1 entregado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select count(*) as kpi_a2_deberia_ser_1 from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', date '2026-03-09', date '2026-03-11')
  where fecha = date '2026-03-10' and enviados = 1 and entregados = 1;
rollback;

\echo '=== D3a. KPI: los dias sin datos salen en ceros (2 de los 3 dias del rango) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select count(*) as kpi_dias_en_cero_deberia_ser_2 from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', date '2026-03-09', date '2026-03-11')
  where fecha <> date '2026-03-10' and enviados = 0 and fallos_por_motivo = '{}'::jsonb;
rollback;

\echo '=== D3b. KPI: un rango de 3 dias devuelve 3 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select count(*) as kpi_filas_deberia_ser_3 from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', date '2026-03-09', date '2026-03-11');
rollback;

\echo '=== D4. RECHAZADO: el owner de B no lee el KPI de la sucursal de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5012', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', date '2026-03-10', date '2026-03-10')$q$, '42501');
rollback;

\echo '=== D5. RECHAZADO: la sesion de sistema (sin usuario) no lee el KPI del panel -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', date '2026-03-10', date '2026-03-10')$q$, '42501');
rollback;

\echo '=== D6. RECHAZADO: anon no lee el KPI -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', date '2026-03-10', date '2026-03-10')$q$, '42501');
rollback;

\echo '=== D7. RECHAZADO: rango invalido (mas de 63 dias o invertido) -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5011', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', date '2026-01-01', date '2026-03-10')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.whatsapp_entrega_diaria('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', date '2026-03-10', date '2026-03-09')$q$, '22023');
rollback;

\echo '=== E1. RETENCION: reemplazar el payload por erased borra tambien wamid y estado de entrega de esa fila ==='
begin;
update restaurantes.messaging_outbox set payload = '{"erased": true}'::jsonb where id = '00000000-0000-0000-0000-0000000e5301';
select count(*) as e1_limpia_deberia_ser_1 from restaurantes.messaging_outbox
  where id = '00000000-0000-0000-0000-0000000e5301' and provider_message_id is null and enviado_como is null and delivery_status is null and delivery_updated_at is null
    and delivery_error_code is null and delivery_error_title is null and delivery_failure_reason is null;
rollback;

\echo '=== E2. RETENCION: la purga real de 046 (sesion de sistema) vacia el payload Y el estado de entrega del aviso viejo ==='
begin;
set local role authenticated;
select * from restaurantes.system_purge_expired_privacy_data(500);
reset role;
select count(*) as e2_purga_deberia_ser_1 from restaurantes.messaging_outbox
  where id = '00000000-0000-0000-0000-0000000e5301' and payload = '{"erased": true}'::jsonb and provider_message_id is null and delivery_status is null and delivery_error_code is null;
rollback;

\echo '=== E3. RETENCION: la purga no toca los avisos recientes (r0 conserva wamid y estado) ==='
begin;
set local role authenticated;
select * from restaurantes.system_purge_expired_privacy_data(500);
reset role;
select count(*) as e3_reciente_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5101' and provider_message_id = 'wamid.R0' and delivery_status = 'sent';
rollback;

\echo '=== E4. un UPDATE del payload que NO es el borrado (reencolar) no toca el estado de entrega ==='
begin;
update restaurantes.messaging_outbox set payload = '{"body": "otro"}'::jsonb where id = '00000000-0000-0000-0000-0000000e5101';
select count(*) as e4_intacto_deberia_ser_1 from restaurantes.messaging_outbox where id = '00000000-0000-0000-0000-0000000e5101' and provider_message_id = 'wamid.R0' and delivery_status = 'sent';
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
