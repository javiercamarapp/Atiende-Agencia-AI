-- QA adversarial citas, ronda 1, lente AUTOMATIZACION (7-oct-2026): migracion 033.
--
-- Contra Postgres REAL (migraciones reales de supabase/migrations/, RLS + GRANT + auth.uid() reales). Cubre, con casos positivos,
-- negativos, cross-tenant y anon:
--   A. Recordatorio con clave por starts_at (QA-citas-R1-automatizacion-01): tras reagendar hay un recordatorio NUEVO despachable
--      con la hora nueva; la clave vieja sobre la fila ya enviada sigue sin hacer nada; el chat de datos cuenta ambas claves,
--      solo para owner/admin de SU organizacion.
--   B. Instante del paso a dead (QA-citas-R1-automatizacion-09): un recordatorio creado ANTES pero agotado DESPUES cambia la
--      clave de dedupe del aviso; la funcion sigue siendo solo de sistema.
--   C. Retencion de citas (QA-citas-R1-automatizacion-07): clases en el catalogo, purga solo de sistema, respeta ARCO abierta y
--      retencion legal, no cruza organizaciones, simula sin tocar y es idempotente.
-- Los escenarios que deben fallar usan verify_support.expect_sqlstate (SQLSTATE exacto).
\set ON_ERROR_STOP off
\pset pager off

create schema verify_support;
grant usage on schema verify_support to authenticated, anon;
create function verify_support.expect_sqlstate(p_sql text, p_expected text) returns void
language plpgsql as $f$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_expected then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_expected, v_state, v_msg;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE %, pero la sentencia no fallo', p_expected;
end $f$;
grant execute on function verify_support.expect_sqlstate(text, text) to authenticated, anon;

-- Exige que la sentencia falle con CUALQUIERA de los SQLSTATE dados (p. ej. un rechazo de RLS 42501 o un AT403 de la funcion).
create function verify_support.expect_any_sqlstate(p_sql text, p_expected text[]) returns void
language plpgsql as $f$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if not (v_state = any (p_expected)) then
      raise exception 'se esperaba uno de %, se obtuvo % (%)', p_expected, v_state, v_msg;
    end if;
    return;
  end;
  raise exception 'se esperaba un error (%), pero la sentencia no fallo', p_expected;
end $f$;
grant execute on function verify_support.expect_any_sqlstate(text, text[]) to authenticated, anon;


insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000aa01', 'citas', 'Clinica A (QA R1 automatizacion)', 'qa-r1-aut-clinica-a'),
  ('00000000-0000-0000-0000-00000000bb01', 'citas', 'Clinica B (QA R1 automatizacion, ajena)', 'qa-r1-aut-clinica-b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000aa01', 'citas', 'Sucursal A1'),
  ('00000000-0000-0000-0000-00000000b0b1', '00000000-0000-0000-0000-00000000bb01', 'citas', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0001', 'owner-a-aut@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0002', 'staff-a-aut@example.com', 'Staff A (rol staff)', 'seed'),
  ('00000000-0000-0000-0000-0000000b0001', 'owner-b-aut@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000aa01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000aa01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-00000000bb01', null, 'owner', 'owner')
on conflict do nothing;

insert into citas.providers (id, organization_id, property_id, display_name) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a1', 'Psicologa A1'),
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000b0b1', 'Doctora B1')
on conflict do nothing;
insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000aa01', 'Terapia individual', 50),
  ('00000000-0000-0000-0000-00000000d0b1', '00000000-0000-0000-0000-00000000bb01', 'Consulta B', 30)
on conflict do nothing;
insert into citas.customers (id, organization_id, full_name, phone, email) values
  ('00000000-0000-0000-0000-00000000e0a1', '00000000-0000-0000-0000-00000000aa01', 'Paciente A', '+5219990001001', null),
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-00000000bb01', 'Paciente B', '+5219990002001', null)
on conflict do nothing;
insert into citas.appointments (id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-00000000f0a1', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000e0a1', now() + interval '2 days', now() + interval '2 days 50 minutes', 'confirmed'),
  ('00000000-0000-0000-0000-00000000f0b1', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000b0b1', '00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000d0b1', '00000000-0000-0000-0000-00000000e0b1', now() + interval '2 days', now() + interval '2 days 30 minutes', 'confirmed')
on conflict do nothing;

-- Recordatorios ya en el outbox (fixture de sistema): clave VIEJA y clave NUEVA de la cita de A (mas el correo), y uno de B.
insert into citas.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status) values
  ('00000000-0000-0000-0000-00000000aa01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-00000000f0a1', '{"body":"cita a las 10:00"}'::jsonb, 'sent'),
  ('00000000-0000-0000-0000-00000000aa01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-00000000f0a1:2026-10-21T16:00:00.000Z', '{"body":"cita a las 10:00"}'::jsonb, 'sent'),
  ('00000000-0000-0000-0000-00000000aa01', 'email', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-00000000f0a1:2026-10-21T16:00:00.000Z', '{"to":"x@example.com"}'::jsonb, 'pending'),
  ('00000000-0000-0000-0000-00000000bb01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-00000000f0b1:2026-10-21T16:00:00.000Z', '{"body":"cita B"}'::jsonb, 'sent')
on conflict do nothing;

\echo ''
\echo '=== A) Recordatorio con clave por starts_at ==='
\echo ''

\echo '--- 1. [CIERRE QA-citas-R1-automatizacion-01] tras reagendar, el recordatorio con la hora NUEVA (clave con starts_at) SI queda despachable aunque el anterior ya se envio ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000aa01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-00000000f0a1:2026-10-22T17:00:00.000Z', '{"to":"5219990001001","phone_number_id":"1","body":"cita a las 11:00"}'::jsonb);
select count(*) as recordatorio_nuevo_despachable_deberia_ser_1 from citas.claim_messaging_outbox_batch(10, 120) where payload->>'body' like '%11:00%';
rollback;

\echo '--- 2. [CONTROL] con la clave VIEJA (sin starts_at) el reenvio sigue sin hacer nada sobre la fila ya enviada: por eso la clave cambio ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.enqueue_messaging_outbox('00000000-0000-0000-0000-00000000aa01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:00000000-0000-0000-0000-00000000f0a1', '{"to":"5219990001001","phone_number_id":"1","body":"cita a las 11:00"}'::jsonb);
select count(*) as clave_vieja_no_despachable_deberia_ser_0 from citas.claim_messaging_outbox_batch(10, 120) where payload->>'body' like '%11:00%';
rollback;

\echo '--- 3. [CIERRE QA-citas-R1-automatizacion-01] el chat de datos cuenta los recordatorios de clave vieja Y nueva (3 filas de la cita de A: 2 WhatsApp + 1 correo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select coalesce(sum(total), 0) as recordatorios_contados_deberia_ser_3 from citas.data_chat_reminder_delivery('00000000-0000-0000-0000-00000000aa01', null, now(), now() + interval '10 days');
rollback;

\echo '--- 4. [CROSS-TENANT] el owner de B no ve los recordatorios de A (pidiendo la organizacion A) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0001', true);
select coalesce(sum(total), 0) as owner_ajeno_deberia_ser_0 from citas.data_chat_reminder_delivery('00000000-0000-0000-0000-00000000aa01', null, now(), now() + interval '10 days');
rollback;

\echo '--- 5. [CONTROL] el owner de B ve SOLO el recordatorio de su organizacion (1 fila) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0001', true);
select coalesce(sum(total), 0) as owner_b_ve_lo_suyo_deberia_ser_1 from citas.data_chat_reminder_delivery('00000000-0000-0000-0000-00000000bb01', null, now(), now() + interval '10 days');
rollback;

\echo '--- 6. [CONTROL] un usuario con rol staff (no owner/admin) no ve el detalle de envios ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
select coalesce(sum(total), 0) as staff_deberia_ser_0 from citas.data_chat_reminder_delivery('00000000-0000-0000-0000-00000000aa01', null, now(), now() + interval '10 days');
rollback;

\echo '--- 7. [ANON] el rol anon no puede ejecutar la funcion del chat de datos (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from citas.data_chat_reminder_delivery('00000000-0000-0000-0000-00000000aa01', null, now(), now() + interval '10 days')$q$, '42501') as expect_ok;
rollback;

\echo ''
\echo '=== B) Instante del paso a dead (aviso de recordatorios agotados) ==='
\echo ''

\echo '--- 8. [CIERRE QA-citas-R1-automatizacion-09] un recordatorio creado ANTES pero agotado DESPUES cambia la clave de dedupe del aviso ---'
begin;
insert into citas.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, created_at) values
  ('00000000-0000-0000-0000-00000000aa01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:qa-dead-1', '{}'::jsonb, 'dead', now() - interval '1 hour');
insert into citas.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, created_at, claimed_at) values
  ('00000000-0000-0000-0000-00000000aa01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:qa-dead-2', '{}'::jsonb, 'processing', now() - interval '3 hours', now());
create temp table qa_epoch (paso int, epoch bigint, agotados bigint);
grant all on qa_epoch to authenticated;
create temp table qa_ids as select id from citas.messaging_outbox where dedupe_key = 'reminder-24h:qa-dead-2';
grant select on qa_ids to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into qa_epoch select 1, ultimo_agotado_epoch, recordatorios_agotados from citas.system_avisos_resumen('00000000-0000-0000-0000-00000000aa01');
select citas.complete_messaging_outbox_dead(id, 5, 'http_500') from qa_ids;
insert into qa_epoch select 2, ultimo_agotado_epoch, recordatorios_agotados from citas.system_avisos_resumen('00000000-0000-0000-0000-00000000aa01');
select count(*) as clave_cambia_deberia_ser_1 from qa_epoch a join qa_epoch b on a.paso = 1 and b.paso = 2 and a.epoch is distinct from b.epoch and b.agotados = a.agotados + 1;
rollback;

\echo '--- 9. [CONTROL] sin un agotado nuevo la clave NO cambia (el aviso no se repite) ---'
begin;
insert into citas.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, created_at) values
  ('00000000-0000-0000-0000-00000000aa01', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:qa-dead-3', '{}'::jsonb, 'dead', now() - interval '1 hour');
create temp table qa_epoch (paso int, epoch bigint);
grant all on qa_epoch to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into qa_epoch select 1, ultimo_agotado_epoch from citas.system_avisos_resumen('00000000-0000-0000-0000-00000000aa01');
insert into qa_epoch select 2, ultimo_agotado_epoch from citas.system_avisos_resumen('00000000-0000-0000-0000-00000000aa01');
select count(*) as clave_estable_deberia_ser_1 from qa_epoch a join qa_epoch b on a.paso = 1 and b.paso = 2 and a.epoch = b.epoch;
rollback;

\echo '--- 10. [CONTROL] system_avisos_resumen sigue siendo solo de sistema: un usuario con sesion recibe 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select verify_support.expect_sqlstate($q$select * from citas.system_avisos_resumen('00000000-0000-0000-0000-00000000aa01')$q$, '42501') as expect_ok;
rollback;

\echo '--- 11. [ANON] el rol anon no ejecuta system_avisos_resumen (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from citas.system_avisos_resumen('00000000-0000-0000-0000-00000000aa01')$q$, '42501') as expect_ok;
rollback;

\echo ''
\echo '=== C) Retencion y purga de datos de salud de citas ==='
\echo ''

\echo '--- 12. [CIERRE QA-citas-R1-automatizacion-07] el catalogo tiene las tres clases de retencion de citas ---'
begin;
select count(*) as clases_citas_en_catalogo_deberia_ser_3 from core.retention_class where vertical = 'citas' and data_class in ('citas_whatsapp_conversaciones', 'citas_escalaciones_crisis', 'citas_notas_conversacion');
rollback;

-- Datos de salud de A y B: conversaciones (vencidas, vencida con ARCO abierta, reciente, ajena), escalaciones de crisis y notas.
insert into citas.whatsapp_conversations (id, organization_id, phone, messages, status, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000aa01', '+5219990000001', '[{"role":"user","content":"hola"}]'::jsonb, 'completed', now() - interval '500 days', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000aa01', '+5219990000002', '[{"role":"user","content":"hola"}]'::jsonb, 'completed', now() - interval '500 days', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000aa01', '+5219990000003', '[{"role":"user","content":"hola"}]'::jsonb, 'active', now() - interval '20 days', now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000c0004', '00000000-0000-0000-0000-00000000bb01', '+5219990000004', '[{"role":"user","content":"hola"}]'::jsonb, 'completed', now() - interval '500 days', now() - interval '400 days')
on conflict do nothing;
insert into citas.emergency_escalations (id, organization_id, customer_phone, channel, keyword_matched, message_excerpt, created_at) values
  ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-00000000aa01', '+5219990000001', 'whatsapp', 'crisis', '', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000e5002', '00000000-0000-0000-0000-00000000aa01', '+5219990000002', 'whatsapp', 'crisis', '', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000e5003', '00000000-0000-0000-0000-00000000aa01', '+5219990000003', 'whatsapp', 'crisis', '', now() - interval '10 days'),
  ('00000000-0000-0000-0000-0000000e5004', '00000000-0000-0000-0000-00000000bb01', '+5219990000004', 'voice', 'crisis', '', now() - interval '400 days')
on conflict do nothing;
insert into citas.conversation_handoff (id, organization_id, property_id, conversation_id, estado, solicitado_por) values
  ('00000000-0000-0000-0000-0000000b0a01', '00000000-0000-0000-0000-00000000aa01', null, '00000000-0000-0000-0000-0000000c0001', 'cerrada', 'agente'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000bb01', null, '00000000-0000-0000-0000-0000000c0004', 'cerrada', 'agente')
on conflict do nothing;
insert into citas.conversation_note (id, organization_id, property_id, handoff_id, texto, created_at) values
  ('00000000-0000-0000-0000-0000000a0e01', '00000000-0000-0000-0000-00000000aa01', null, '00000000-0000-0000-0000-0000000b0a01', 'nota vieja A', now() - interval '400 days'),
  ('00000000-0000-0000-0000-0000000a0e02', '00000000-0000-0000-0000-00000000aa01', null, '00000000-0000-0000-0000-0000000b0a01', 'nota reciente A', now() - interval '5 days'),
  ('00000000-0000-0000-0000-0000000b0e01', '00000000-0000-0000-0000-00000000bb01', null, '00000000-0000-0000-0000-0000000b0b01', 'nota vieja B', now() - interval '400 days')
on conflict do nothing;
-- Solicitud ARCO abierta del titular del telefono ...0002 (la conversacion y la escalacion vencidas de ese telefono se conservan).
insert into citas.data_rights_requests (organization_id, customer_phone, right_type, channel, status, confirmed_at, response_due_at, execution_due_at) values
  ('00000000-0000-0000-0000-00000000aa01', '+5219990000002', 'cancelacion', 'whatsapp', 'recibida', now() - interval '2 days', now() + interval '18 days', now() + interval '33 days');

\echo '--- 13. [SEGURIDAD] un owner con sesion NO puede disparar la purga (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select verify_support.expect_sqlstate($q$select * from citas.system_purge_retencion(500, false)$q$, '42501') as expect_ok;
rollback;

\echo '--- 14. [ANON] el rol anon no puede ejecutar la purga (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from citas.system_purge_retencion(500, false)$q$, '42501') as expect_ok;
rollback;

\echo '--- 15. [CONTROL] la simulacion cuenta (2 conversaciones, 2 escalaciones, 2 notas vencidas; 2 protegidas por ARCO) y NO toca nada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare r record;
begin
  select * into r from citas.system_purge_retencion(500, true);
  if r.out_conversaciones <> 2 or r.out_escalaciones <> 2 or r.out_notas <> 2 or r.out_protegidas <> 2 then
    raise exception 'conteos de simulacion inesperados: %, %, %, %', r.out_conversaciones, r.out_escalaciones, r.out_notas, r.out_protegidas;
  end if;
end $$;
reset role;
select count(*) as conversaciones_con_mensajes_tras_simulacion_deberia_ser_4 from citas.whatsapp_conversations where messages <> '[]'::jsonb;
rollback;

\echo '--- 16. [CIERRE QA-citas-R1-automatizacion-07] la purga real vacia las conversaciones vencidas sin ARCO (quedan con mensajes: la ARCO abierta y la reciente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_purga from citas.system_purge_retencion(500, false);
reset role;
select count(*) as conversaciones_con_mensajes_deberia_ser_2 from citas.whatsapp_conversations where messages <> '[]'::jsonb;
rollback;

\echo '--- 17. [CIERRE QA-citas-R1-automatizacion-07] la purga real borra las escalaciones de crisis vencidas sin ARCO (quedan la ARCO abierta y la reciente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_purga from citas.system_purge_retencion(500, false);
reset role;
select count(*) as escalaciones_restantes_deberia_ser_2 from citas.emergency_escalations;
rollback;

\echo '--- 18. [CIERRE QA-citas-R1-automatizacion-07] la purga real borra las notas vencidas (queda solo la reciente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_purga from citas.system_purge_retencion(500, false);
reset role;
select count(*) as notas_restantes_deberia_ser_1 from citas.conversation_note;
rollback;

\echo '--- 19. [CONTROL] la fila de la conversacion y su vinculo se conservan (solo se vacian los mensajes) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_purga from citas.system_purge_retencion(500, false);
reset role;
select count(*) as conversaciones_filas_deberia_ser_4 from citas.whatsapp_conversations;
rollback;

\echo '--- 20. [CROSS-TENANT] con retencion legal activa en A la purga no toca a A pero SI a B (A conserva sus 3 con mensajes) ---'
begin;
insert into core.purge_hold (organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-00000000aa01', null, 'retencion legal de prueba del verify', '00000000-0000-0000-0000-0000000a0001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_purga from citas.system_purge_retencion(500, false);
reset role;
select count(*) as conversaciones_org_a_con_mensajes_deberia_ser_3 from citas.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-00000000aa01' and messages <> '[]'::jsonb;
rollback;

\echo '--- 21. [CROSS-TENANT] ... y la organizacion B (sin bloqueo) si se purga ---'
begin;
insert into core.purge_hold (organization_id, data_class, reason, placed_by) values ('00000000-0000-0000-0000-00000000aa01', null, 'retencion legal de prueba del verify', '00000000-0000-0000-0000-0000000a0001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_purga from citas.system_purge_retencion(500, false);
reset role;
select count(*) as conversaciones_org_b_con_mensajes_deberia_ser_0 from citas.whatsapp_conversations where organization_id = '00000000-0000-0000-0000-00000000bb01' and messages <> '[]'::jsonb;
rollback;

\echo '--- 22. [CONTROL] la purga es idempotente: una segunda corrida no encuentra nada vencido (solo quedan las 2 protegidas por ARCO) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as primera_corrida from citas.system_purge_retencion(500, false);
do $$
declare r record;
begin
  select * into r from citas.system_purge_retencion(500, false);
  if r.out_conversaciones <> 0 or r.out_escalaciones <> 0 or r.out_notas <> 0 or r.out_protegidas <> 2 then
    raise exception 'segunda corrida inesperada: %, %, %, %', r.out_conversaciones, r.out_escalaciones, r.out_notas, r.out_protegidas;
  end if;
end $$;
rollback;

\echo '--- 23. [CONTROL] el lote es acotado: con limite 1 solo se vacia 1 conversacion por corrida ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
declare r record;
begin
  select * into r from citas.system_purge_retencion(1, false);
  if r.out_conversaciones <> 1 then
    raise exception 'el lote no se acoto: %', r.out_conversaciones;
  end if;
end $$;
rollback;
