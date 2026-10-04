-- QA adversarial R1 (lente automatizacion, vertical restaurantes) contra Postgres REAL efimero.
-- Cada escenario imprime una columna `veredicto`: 'OK' cuando el sistema se comporta como debe, o
-- 'DEFECTO QA-restaurantes-R1-automatizacion-NN: ...' cuando reproduce el defecto. Nada aqui toca la base real.
--
--   S1  (NN=04) purga por retencion: llamadas de voz SIN caller_hash (preview / numero oculto) se procesan pero
--       la funcion las reporta como 0, y el cron (privacidad-interno.ts) corta su bucle de lotes con ese conteo.
--   S2  (NN=05) purga por retencion: lo que la funcion NO purga (orders.call_transcript / call_recording_url,
--       messaging_outbox.payload con telefono y texto, bandeja staff_order_notification con nombre del cliente).
--   S3  (NN=08) llamada de voz huerfana (el worker murio sin /cerrar): queda "en curso" para siempre y el KPI no
--       la cuenta como cerrada ni abandonada.
--   S4  (NN=07) promocion de un programado vencido hace horas (cron pausado por kill switch, caida): se manda a
--       cocina sin ninguna marca ni aviso.
--   S5  (cobertura) promocion en el cruce de anio (31-dic 23:50 Merida -> pedido 1-ene 00:15) y Tijuana con
--       horario de verano (cambio de hora del 1-nov-2026): el instante absoluto manda.
--   (S6, solapamiento real de dos ejecuciones concurrentes, lo corre run.sh con dos sesiones psql.)
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'restaurantes', 'QA Auto Org', 'qa-auto-org')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a001', 'Sucursal QA T7')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000a001', 'qa-t7')
on conflict do nothing;
update restaurantes.branch_detail set zona_horaria = 'America/Merida' where property_id = '00000000-0000-0000-0000-00000000a0a1';
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000a011', 'owner@qa-auto.example.com', 'Owner QA', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000a011', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner')
on conflict do nothing;

-- ===========================================================================
\echo '=== S1. QA-04: 3 llamadas preview vencidas SIN caller_hash (2 turnos c/u); purga con limite 2 ==='
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
reset role;
select out_conversations_cleared, out_voice_turns_deleted, out_voice_calls_anonymized,
       (select count(distinct t.conversation_id)::int from restaurantes.voice_turn t join restaurantes.voice_conversation c on c.id = t.conversation_id where c.external_id like 'qa-prev-%') as llamadas_con_turnos_restantes,
       case when out_voice_turns_deleted = 4 and out_voice_calls_anonymized < 2
            then 'DEFECTO QA-restaurantes-R1-automatizacion-04: proceso 2 llamadas (lote lleno) pero reporta out_voice_calls_anonymized=' || out_voice_calls_anonymized || '; el cron corta el bucle y deja vencidas'
            else 'OK' end as veredicto
  from s1_out;
rollback;

\echo '=== S1b. (cobertura) mismas llamadas CON caller_hash: el conteo si refleja el lote ==='
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at, ended_at, resultado) values
  ('00000000-0000-0000-0000-00000000c011', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-llam-1', 'llamada', 'gemini-3.8-live', repeat('1', 64), now() - interval '40 days', now() - interval '40 days', 'pedido_creado'),
  ('00000000-0000-0000-0000-00000000c012', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-llam-2', 'llamada', 'gemini-3.8-live', repeat('2', 64), now() - interval '39 days', now() - interval '39 days', 'pedido_creado');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select out_voice_calls_anonymized, case when out_voice_calls_anonymized = 2 then 'OK' else 'FALLA cobertura S1b' end as veredicto
  from restaurantes.system_purge_expired_privacy_data(2);
rollback;

-- ===========================================================================
\echo '=== S2. QA-05: datos personales que la purga por retencion NO alcanza ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, customer_address, total, status, items, source, call_transcript, call_recording_url, created_at) values
  ('00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Cliente Voz', '+5219990000001', 'Calle 1 x 2 y 3', 300, 'completado', '[]'::jsonb, 'voice',
   'agente: hola / cliente: soy Cliente Voz, mi direccion es Calle 1 x 2 y 3, tarjeta terminacion 4242', 'https://grabaciones.example/qa.mp3', now() - interval '400 days');
insert into restaurantes.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, sent_at, created_at) values
  ('00000000-0000-0000-0000-00000000a001', 'whatsapp', 'order.status', 'qa-outbox-viejo',
   jsonb_build_object('to', '5219990000001', 'phone_number_id', '123', 'body', 'Cliente Voz, tu pedido va en camino a Calle 1 x 2 y 3'), 'sent', now() - interval '400 days', now() - interval '400 days');
insert into restaurantes.staff_order_notification (organization_id, property_id, order_id, event_type, message, created_at) values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000d001', 'order.created', 'Nuevo pedido de Cliente Voz — $300.00', now() - interval '400 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.system_purge_expired_privacy_data(500);
reset role;
select (call_transcript is not null)::int as transcript_sigue, (call_recording_url is not null)::int as grabacion_sigue,
       case when call_transcript is not null or call_recording_url is not null
            then 'DEFECTO QA-restaurantes-R1-automatizacion-05: transcripcion/URL de grabacion de una llamada de hace 400 dias sigue en orders (retencion de voz 30 dias)'
            else 'OK' end as veredicto
  from restaurantes.orders where id = '00000000-0000-0000-0000-00000000d001';
select (payload ? 'body')::int as cuerpo_y_telefono_siguen,
       case when payload ? 'body' then 'DEFECTO QA-restaurantes-R1-automatizacion-05: messaging_outbox conserva telefono y texto enviado hace 400 dias (retencion de conversaciones 180 dias)' else 'OK' end as veredicto
  from restaurantes.messaging_outbox where dedupe_key = 'qa-outbox-viejo';
select (message like '%Cliente Voz%')::int as nombre_sigue,
       case when message like '%Cliente Voz%' then 'DEFECTO QA-restaurantes-R1-automatizacion-05: la bandeja staff_order_notification conserva el nombre del cliente de hace 400 dias' else 'OK' end as veredicto
  from restaurantes.staff_order_notification where order_id = '00000000-0000-0000-0000-00000000d001';
rollback;

-- ===========================================================================
\echo '=== S3. QA-08: llamada huerfana (iniciada hace 3 dias, nunca cerrada) ==='
begin;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, caller_hash, started_at) values
  ('00000000-0000-0000-0000-00000000c021', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'qa-huerfana', 'llamada', 'gemini-3.8-live', repeat('3', 64), now() - interval '3 days');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000a011', true);
select llamadas, llamadas_cerradas, abandonadas,
       case when llamadas = 1 and llamadas_cerradas = 0 and abandonadas = 0
            then 'DEFECTO QA-restaurantes-R1-automatizacion-08: la llamada sin cierre queda en curso para siempre (no cuenta como abandonada ni cerrada; nada la cierra)'
            else 'OK' end as veredicto
  from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1',
                                     ((now() - interval '3 days') at time zone 'America/Merida')::date, ((now() - interval '3 days') at time zone 'America/Merida')::date);
reset role;
select (ended_at is null and resultado is null)::int as sigue_en_curso from restaurantes.voice_conversation where external_id = 'qa-huerfana';
rollback;

-- ===========================================================================
\echo '=== S4. QA-07: programado vencido hace 6 h (cron pausado): se promueve a cocina sin marca ni aviso ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, programado_para) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Prog Atrasado', '+5219990000002', 250, 'programado', '[]'::jsonb, 'whatsapp', now() - interval '6 hours');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select jsonb_array_length(restaurantes.promover_pedidos_programados('00000000-0000-0000-0000-00000000a001', now(), 30, null)) as promovidos;
reset role;
select status, round(extract(epoch from (promovido_at - programado_para)) / 3600) as horas_tarde,
       case when status = 'pending' and promovido_at - programado_para > interval '1 hour'
            then 'DEFECTO QA-restaurantes-R1-automatizacion-07: entra a cocina ' || round(extract(epoch from (promovido_at - programado_para)) / 3600) || ' h despues de la hora pedida, como un pending normal (sin marca de atraso ni aviso)'
            else 'OK' end as veredicto
  from restaurantes.orders where id = '00000000-0000-0000-0000-00000000e001';
rollback;

-- ===========================================================================
\echo '=== S5. (cobertura) cruce de anio en Merida y horario de verano de Tijuana (reloj simulado p_now) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, programado_para, created_at) values
  ('00000000-0000-0000-0000-00000000e011', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Anio Nuevo', '+5219990000003', 250, 'programado', '[]'::jsonb, 'web', '2027-01-01T00:15:00-06:00', '2026-12-31T12:00:00-06:00'),
  ('00000000-0000-0000-0000-00000000e012', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Anio Nuevo Tarde', '+5219990000004', 250, 'programado', '[]'::jsonb, 'web', '2027-01-01T01:00:00-06:00', '2026-12-31T12:00:00-06:00'),
  -- Tijuana: 1-nov-2026 01:30 PDT (08:30Z) y 01:30 PST (09:30Z) son la MISMA hora local repetida; el instante manda.
  ('00000000-0000-0000-0000-00000000e013', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Tijuana PDT', '+5216640000001', 250, 'programado', '[]'::jsonb, 'web', '2026-11-01T01:30:00-07:00', '2026-10-31T12:00:00-07:00'),
  ('00000000-0000-0000-0000-00000000e014', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-00000000a0a1', 'Tijuana PST', '+5216640000002', 250, 'programado', '[]'::jsonb, 'web', '2026-11-01T01:30:00-08:00', '2026-10-31T12:00:00-07:00');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
-- Primero Tijuana (1-nov 08:05Z = 01:05 PDT): solo el de 01:30 PDT (08:30Z) cae dentro de la anticipacion de 30 min.
select (select array_agg(x->>'customer_name') from jsonb_array_elements(restaurantes.promover_pedidos_programados(null, '2026-11-01T08:05:00Z', 30, null)) x) as promovidos_0805z;
reset role;
select case when (select status from restaurantes.orders where customer_name = 'Tijuana PDT') = 'pending'
             and (select status from restaurantes.orders where customer_name = 'Tijuana PST') = 'programado' then 'OK' else 'FALLA cobertura S5 DST' end as veredicto_dst;
set local role authenticated;
-- Luego el cruce de anio: 31-dic 23:50 Merida promueve el de 00:15 del 1-ene y no el de 01:00.
select (select array_agg(x->>'customer_name' order by x->>'customer_name') from jsonb_array_elements(restaurantes.promover_pedidos_programados(null, '2026-12-31T23:50:00-06:00', 30, null)) x) as promovidos_31dic_2350;
reset role;
select case when (select status from restaurantes.orders where customer_name = 'Anio Nuevo') = 'pending'
             and (select status from restaurantes.orders where customer_name = 'Anio Nuevo Tarde') = 'programado' then 'OK' else 'FALLA cobertura S5 anio' end as veredicto_anio;
rollback;
