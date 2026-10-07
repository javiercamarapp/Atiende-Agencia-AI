-- QA restaurantes R2, lente CAOS: confirma contra Postgres REAL (efimero) los defectos R2-caos-02, -03 y -01 que las specs TS
-- prueban con dobles. Corre DESPUES de scripts/verify-restaurantes-autopiloto/assertions.sql (reusa sus fixtures: org A, sucursal A1,
-- staff e5013). Cada escenario es begin; ... rollback;. El alias `deberia_ser_N` es lo ESPERADO; si el valor impreso difiere, el defecto sigue.
\pset pager off

\echo '=== R2-caos-03 (SQL). Pedido para recoger a las T-65 min que cocina marca listo AHORA: no debe ser candidato a no_recogido ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-00000000c403', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'Tarde', '5512340001', 90,
        'preparando', '[]', 'whatsapp', now() - interval '2 hours', 'recoger', now() - interval '65 minutes');
update restaurantes.orders set status = 'listo_para_recoger' where id = '00000000-0000-0000-0000-00000000c403';
select count(*) as candidato_no_recogido_recien_listo_deberia_ser_0
  from restaurantes.autopiloto_candidatos_estados(now(), 1000) c
 where c.order_id = '00000000-0000-0000-0000-00000000c403' and c.to_status = 'no_recogido';
rollback;

\echo '=== R2-caos-02 (SQL). Cancelar con un clic (solicitud_resolver) un pedido cuya comanda sigue fallida en el outbox: la comanda debe quedar cortada ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal)
values ('00000000-0000-0000-0000-00000000c402', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'Cancela', '5512340002', 90,
        'pending', '[]', 'whatsapp', now(), 'domicilio');
insert into restaurantes.pos_comanda_outbox (organization_id, property_id, order_id, idempotency_key, estado, modo, payload)
values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-00000000c402', 'sr:qa-r2:c402', 'fallida', 'activo', '{}');
create temp table qa_sol on commit drop as
  select id from restaurantes.solicitud_crear('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'cancelacion', '00000000-0000-0000-0000-00000000c402', '{"origen":"cliente"}');
grant select on qa_sol to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5013', true);
select r.estado_pedido as estado_pedido_deberia_ser_cancelado
  from qa_sol, restaurantes.solicitud_resolver('00000000-0000-0000-0000-0000000e5001', qa_sol.id, 'cancelar', 'cliente_desistio') r;
reset role;
select count(*) as comandas_vivas_de_pedido_cancelado_deberia_ser_0
  from restaurantes.pos_comanda_outbox p
 where p.order_id = '00000000-0000-0000-0000-00000000c402' and p.estado in ('pendiente', 'fallida', 'captura_manual');
rollback;

\echo '=== R2-caos-01 (SQL). Agente de WhatsApp APAGADO en A1 y una toma `agente_apagado` tomada sin respuesta: el tick no debe devolverla al agente ==='
begin;
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo)
values ('00000000-0000-0000-0000-0000000e50a1', '00000000-0000-0000-0000-0000000e5001', false)
on conflict (property_id) do update set agente_activo = false;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages)
values ('00000000-0000-0000-0000-00000000c4f1', '00000000-0000-0000-0000-0000000e5001', '5512340003', '00000000-0000-0000-0000-0000000e50a1', '[{"role":"user","content":"quiero pedir"}]');
insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo, solicitada_at, ultimo_cliente_at, tomada_at)
values ('00000000-0000-0000-0000-00000000c4f2', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a1', 'whatsapp', '00000000-0000-0000-0000-00000000c4f1',
        'tomada', 'agente', 'agente_apagado', now() - interval '40 minutes', now() - interval '30 minutes', now() - interval '30 minutes');
select count(*) as devuelta_con_agente_apagado_deberia_ser_0
  from restaurantes.handoffs_devolver_vencidos(now(), 200) d
 where d.handoff_id = '00000000-0000-0000-0000-00000000c4f2';
select count(*) as frase_le_sigo_atendiendo_encolada_deberia_ser_0
  from restaurantes.messaging_outbox m
 where m.dedupe_key = 'handoff-regreso:00000000-0000-0000-0000-00000000c4f2';
rollback;

\echo '=== R2-caos-10 (SQL). Muestras del tiempo prometido para RECOGER: 20 pedidos de la semana pasada a esta hora, pedidos para pasar a recoger 90 min despues (hora elegida por el cliente) y listos en 15 ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal, hora_recogida)
select '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'Programa ' || g, '55990000' || lpad(g::text, 2, '0'), 90, 'entregado', '[]', 'whatsapp',
       now() - interval '7 days', now() - interval '7 days' + interval '92 minutes', 'recoger', now() - interval '7 days' + interval '90 minutes'
  from generate_series(1, 20) g;
-- Lo que mide la muestra: minutos de alta -> entrega (incluye la espera que eligio el cliente). La cocina tardo 15.
select (m->'muestras'->>0)::numeric >= 90 as muestra_mide_la_hora_elegida_por_el_cliente_deberia_ser_f,
       jsonb_array_length(m->'muestras') as muestras
  from (select restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e50a2', 'recoger', now()) as m) x;
rollback;
