-- Lote QA R1 automatizacion (restaurantes) contra Postgres REAL: migracion 042.
--   S1/S1b (QA-04) la purga cuenta las llamadas PROCESADAS (con o sin caller_hash).
--   S2..S2d (QA-05) la purga vacia orders.call_*, messaging_outbox.payload y staff_order_notification.message vencidos,
--           sin tocar lo reciente, lo pendiente de enviar ni a un titular con ARCO abierto; staff y anon no la ejecutan.
--   S3..S3c (QA-02) pos_comanda_promovidos_sin_comanda: positivo, bandera apagada, ya encolado, cancelado, staff y anon.
-- Cada escenario es un bloque begin/rollback; los de exito usan DO + raise exception (el gate exige que terminen sin error).
\set ON_ERROR_STOP on
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'restaurantes', 'QA Auto Org', 'qa-auto-org'),
  ('00000000-0000-0000-0000-00000000a002', 'restaurantes', 'QA Auto Org B', 'qa-auto-org-b')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a001', 'Sucursal QA T7'),
  ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a002', 'Sucursal QA B')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a001', 'qa-t7'),
  ('00000000-0000-0000-0000-00000000a0b1', '00000000-0000-0000-0000-00000000a002', 'qa-b')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000a011', 'owner@qa-auto.example.com', 'Owner QA', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner')
on conflict do nothing;

-- ===========================================================================
\echo 'S1. QA-04: 3 llamadas preview vencidas SIN caller_hash (2 turnos c/u); purga con limite 2'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at, resultado) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-prev-1', 'preview', 'gemini-3.8-live', null, now() - interval '40 days', now() - interval '40 days' + interval '3 minutes', 'abandonado'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-prev-2', 'preview', 'gemini-3.8-live', null, now() - interval '39 days', now() - interval '39 days' + interval '3 minutes', 'abandonado'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-prev-3', 'preview', 'gemini-3.8-live', null, now() - interval '38 days', now() - interval '38 days' + interval '3 minutes', 'abandonado');
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto)
select c.id, c.organization_id, s.seq, 'cliente', 'turno de prueba ' || s.seq
  from restaurantes.voice_conversation c cross join (values (0), (1)) s(seq)
 where c.external_id like 'qa-prev-%';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table s1_out on commit drop as select * from restaurantes.system_purge_expired_privacy_data(2);
grant select on s1_out to public;
reset role;
do $$
declare r record;
begin
  select * into r from s1_out;
  if r.out_voice_turns_deleted <> 4 then raise exception 'S1: se esperaban 4 turnos borrados, hubo %', r.out_voice_turns_deleted; end if;
  if r.out_voice_calls_anonymized <> 2 then raise exception 'S1 (QA-04): el lote lleno de 2 llamadas sin caller_hash se reporto como % (debe ser 2)', r.out_voice_calls_anonymized; end if;
end $$;
rollback;

\echo 'S1b. cobertura: mismas llamadas CON caller_hash, el conteo sigue reflejando el lote'
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at, resultado) values
  ('00000000-0000-0000-0000-00000000c011', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-llam-1', 'llamada', 'gemini-3.8-live', repeat('1', 64), now() - interval '40 days', now() - interval '40 days' + interval '3 minutes', 'abandonado'),
  ('00000000-0000-0000-0000-00000000c012', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-llam-2', 'llamada', 'gemini-3.8-live', repeat('2', 64), now() - interval '39 days', now() - interval '39 days' + interval '3 minutes', 'abandonado');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table s1b_out on commit drop as select * from restaurantes.system_purge_expired_privacy_data(2);
grant select on s1b_out to public;
reset role;
do $$
begin
  if (select out_voice_calls_anonymized from s1b_out) <> 2 then raise exception 'S1b: el conteo con caller_hash ya no refleja el lote'; end if;
  if exists (select 1 from restaurantes.voice_conversation where external_id like 'qa-llam-%' and caller_hash is not null) then raise exception 'S1b: quedo un caller_hash vencido'; end if;
end $$;
rollback;

-- ===========================================================================
\echo 'S2. QA-05: la purga vacia orders.call_*, outbox y bandeja vencidos; conserva lo reciente, lo pendiente y un ARCO abierto'
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, customer_address, total, status, items, source, call_transcript, call_recording_url, created_at) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Cliente Voz', '+5219990000001', 'Calle 1 x 2 y 3', 300, 'completado', '[]'::jsonb, 'voice',
   'agente: hola / cliente: soy Cliente Voz, mi direccion es Calle 1 x 2 y 3', 'https://grabaciones.example/qa.mp3', now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Cliente Reciente', '+5219990000002', 'Calle 4', 300, 'completado', '[]'::jsonb, 'voice',
   'transcripcion reciente', 'https://grabaciones.example/reciente.mp3', now() - interval '2 days'),
  ('00000000-0000-0000-0000-00000000d003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Titular ARCO', '+5219990000003', 'Calle 5', 300, 'completado', '[]'::jsonb, 'voice',
   'transcripcion con ARCO abierto', 'https://grabaciones.example/arco.mp3', now() - interval '400 days');
insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, sent_at, created_at) values
  ('00000000-0000-0000-0000-00000000a001', 'whatsapp', 'order.status', 'qa-outbox-viejo',
   jsonb_build_object('to', '5219990000001', 'phone_number_id', '123', 'body', 'Cliente Voz, tu pedido va en camino'), 'sent', now() - interval '400 days', now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000000a001', 'whatsapp', 'order.status', 'qa-outbox-pendiente',
   jsonb_build_object('to', '5219990000001', 'phone_number_id', '123', 'body', 'sigue pendiente de enviar'), 'pending', null, now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000000a001', 'whatsapp', 'order.status', 'qa-outbox-reciente',
   jsonb_build_object('to', '5219990000002', 'phone_number_id', '123', 'body', 'mensaje reciente'), 'sent', now() - interval '2 days', now() - interval '2 days'),
  ('00000000-0000-0000-0000-00000000a001', 'whatsapp', 'order.status', 'qa-outbox-arco',
   jsonb_build_object('to', '5219990000003', 'phone_number_id', '123', 'body', 'mensaje de un titular con ARCO'), 'sent', now() - interval '400 days', now() - interval '400 days');
insert into restaurantes.staff_order_notification (organization_id, property_id, order_id, event_type, message, created_at) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000d001', 'order.created', 'Nuevo pedido de Cliente Voz - $300.00', now() - interval '400 days'),
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000d002', 'order.created', 'Nuevo pedido de Cliente Reciente - $300.00', now() - interval '2 days');
-- La solicitud ARCO se guarda con OTRO formato de telefono (espacios y guiones): la exclusion compara solo digitos.
insert into restaurantes.data_rights_requests (organization_id, customer_phone, right_type, status, confirmed_at, response_due_at, execution_due_at)
values ('00000000-0000-0000-0000-00000000a001', '+52 (1) 999-000-0003', 'acceso', 'en_proceso', now(), now() + interval '20 days', now() + interval '35 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table s2_out on commit drop as select * from restaurantes.system_purge_expired_privacy_data(500);
grant select on s2_out to public;
reset role;
do $$
begin
  if (select call_transcript is not null or call_recording_url is not null from restaurantes.orders where id = '00000000-0000-0000-0000-00000000d001') then
    raise exception 'S2 (QA-05): orders.call_transcript/call_recording_url de hace 400 dias siguen en el pedido'; end if;
  if (select payload ? 'body' from restaurantes.messaging_outbox where dedupe_key = 'qa-outbox-viejo') then
    raise exception 'S2 (QA-05): messaging_outbox conserva telefono y texto de hace 400 dias'; end if;
  if (select message like '%Cliente Voz%' from restaurantes.staff_order_notification where order_id = '00000000-0000-0000-0000-00000000d001') then
    raise exception 'S2 (QA-05): la bandeja del staff conserva el nombre del cliente de hace 400 dias'; end if;
  -- lo que NO debe tocar
  if (select call_transcript is null from restaurantes.orders where id = '00000000-0000-0000-0000-00000000d002') then raise exception 'S2: borro la transcripcion de un pedido reciente'; end if;
  if not (select payload ? 'body' from restaurantes.messaging_outbox where dedupe_key = 'qa-outbox-pendiente') then raise exception 'S2: toco un mensaje pendiente de enviar'; end if;
  if not (select payload ? 'body' from restaurantes.messaging_outbox where dedupe_key = 'qa-outbox-reciente') then raise exception 'S2: toco un mensaje reciente'; end if;
  if not (select message like '%Cliente Reciente%' from restaurantes.staff_order_notification where order_id = '00000000-0000-0000-0000-00000000d002') then raise exception 'S2: toco un aviso reciente'; end if;
  if (select call_transcript is null from restaurantes.orders where id = '00000000-0000-0000-0000-00000000d003') then raise exception 'S2: purgo datos de un titular con ARCO abierto'; end if;
  if not (select payload ? 'body' from restaurantes.messaging_outbox where dedupe_key = 'qa-outbox-arco') then raise exception 'S2: purgo el outbox de un titular con ARCO abierto'; end if;
  if (select out_orders_voice_cleared from s2_out) < 1 or (select out_outbox_payloads_erased from s2_out) < 1 or (select out_staff_notifications_erased from s2_out) < 1 then
    raise exception 'S2: los conteos nuevos no reflejan lo purgado'; end if;
end $$;
rollback;

\echo 'S2b. negativo: un staff autenticado no puede ejecutar la purga de sistema (42501)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a011', true);
select * from restaurantes.system_purge_expired_privacy_data(10) as should_fail;
rollback;

\echo 'S2c. negativo: anon no tiene EXECUTE sobre la purga'
begin;
set local role anon;
select * from restaurantes.system_purge_expired_privacy_data(10) as should_fail;
rollback;

-- ===========================================================================
\echo 'S3. QA-02: pos_comanda_promovidos_sin_comanda devuelve solo promovidos vivos, sin comanda, de organizaciones con la bandera encendida'
begin;
insert into restaurantes.softrestaurant_config (organization_id, modo) values
  ('00000000-0000-0000-0000-00000000a001', 'sombra'),
  ('00000000-0000-0000-0000-00000000a002', 'apagado');
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, programado_para, promovido_at) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Sin comanda', '+5219990000011', 100, 'pending', '[]'::jsonb, 'web', now() - interval '2 hours', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000f002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Ya encolada', '+5219990000012', 100, 'pending', '[]'::jsonb, 'web', now() - interval '2 hours', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000f003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Cancelada', '+5219990000013', 100, 'cancelado', '[]'::jsonb, 'web', now() - interval '2 hours', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000f004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Muy vieja', '+5219990000014', 100, 'pending', '[]'::jsonb, 'web', now() - interval '60 hours', now() - interval '48 hours'),
  ('00000000-0000-0000-0000-00000000f005', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000a0b1', 'Bandera apagada', '+5219990000015', 100, 'pending', '[]'::jsonb, 'web', now() - interval '2 hours', now() - interval '1 hour'),
  ('00000000-0000-0000-0000-00000000f006', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Sin programar', '+5219990000016', 100, 'pending', '[]'::jsonb, 'web', null, null);
insert into restaurantes.pos_comanda_outbox (organization_id, property_id, order_id, idempotency_key, modo, payload) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000f002', 'sr:a001:f002', 'sombra', '{}'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table s3_out on commit drop as select id from restaurantes.pos_comanda_promovidos_sin_comanda(24, 100);
grant select on s3_out to public;
reset role;
do $$
begin
  if (select count(*) from s3_out) <> 1 or not exists (select 1 from s3_out where id = '00000000-0000-0000-0000-00000000f001') then
    raise exception 'S3 (QA-02): se esperaba solo f001 (promovido, vivo, sin comanda, bandera encendida); devolvio % filas', (select count(*) from s3_out);
  end if;
end $$;
rollback;

\echo 'S3b. negativo: un staff autenticado no puede ejecutar la reconciliacion de sistema (42501)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a011', true);
select * from restaurantes.pos_comanda_promovidos_sin_comanda(24, 10) as should_fail;
rollback;

\echo 'S3c. negativo: anon no tiene EXECUTE sobre la reconciliacion'
begin;
set local role anon;
select * from restaurantes.pos_comanda_promovidos_sin_comanda(24, 10) as should_fail;
rollback;
