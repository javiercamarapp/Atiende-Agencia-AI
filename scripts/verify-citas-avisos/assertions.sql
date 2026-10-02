-- Verificación contra Postgres REAL de C-16 (centro de avisos de citas), migración 029
-- (packages/domain-citas/migrations/029_citas_avisos_escalaciones_seguimiento.sql):
--
--   (A) citas.set_escalation_follow_up: seguimiento de una escalación de crisis. Positivo (owner A), estado y actor reales,
--       nota recortada a 500, y negativos con SQLSTATE EXACTO: rol "staff" (42501), otro tenant (42501 / P0002 sin confirmar
--       que la fila existe), sistema sin usuario (42501), anon (sin GRANT), estado inválido (22023).
--   (B) El UPDATE/INSERT directo sobre citas.emergency_escalations sigue cerrado para authenticated (solo la función escribe).
--   (C) citas.system_avisos_resumen: conteos reales por organización (por confirmar 48 h, recordatorios agotados, escalaciones
--       sin seguimiento > 1 h), cross-tenant, y función de SOLO-SISTEMA (staff autenticado -> 42501; anon sin GRANT).
--   (D) Integración con el productor compartido: core.emit_notification con los parámetros EXACTOS de los eventos nuevos del
--       catálogo llega a los destinatarios correctos (owner/admin; "staff" solo en por_confirmar), resuelve {orgSlug} y es idempotente.
--
-- Cada escenario va en su propio begin; ... rollback; (el gate run-gate.mjs los ejecuta como conexiones independientes).

-- ============================================================================
-- Fixtures (se confirman fuera de los escenarios).
-- ============================================================================
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c1601', 'citas', 'Org Citas C16 (A)', 'org-citas-c16-a'),
  ('00000000-0000-0000-0000-0000000c1602', 'citas', 'Org Citas C16 (B, cross-tenant)', 'org-citas-c16-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c1611', 'owner-a-c16@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c1612', 'staff-a-c16@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000c1613', 'owner-b-c16@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c1611', '00000000-0000-0000-0000-0000000c1601', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c1612', '00000000-0000-0000-0000-0000000c1601', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c1613', '00000000-0000-0000-0000-0000000c1602', null, 'owner', 'owner')
on conflict do nothing;

insert into citas.providers (id, organization_id, display_name) values
  ('00000000-0000-0000-0000-0000000c1621', '00000000-0000-0000-0000-0000000c1601', 'Proveedor A')
on conflict do nothing;
insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-0000000c1622', '00000000-0000-0000-0000-0000000c1601', 'Consulta A', 30)
on conflict do nothing;
insert into citas.customers (id, organization_id, full_name, phone) values
  ('00000000-0000-0000-0000-0000000c1623', '00000000-0000-0000-0000-0000000c1601', 'Cliente A', '5215500001601')
on conflict do nothing;

-- Citas de A: una pendiente en 20 h (cuenta), una pendiente en 60 h (fuera de las 48 h), una confirmada en 10 h (no cuenta).
insert into citas.appointments (id, organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-0000000c1631', '00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1621', '00000000-0000-0000-0000-0000000c1622', '00000000-0000-0000-0000-0000000c1623', now() + interval '20 hours', now() + interval '20 hours 30 minutes', 'pending'),
  ('00000000-0000-0000-0000-0000000c1632', '00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1621', '00000000-0000-0000-0000-0000000c1622', '00000000-0000-0000-0000-0000000c1623', now() + interval '60 hours', now() + interval '60 hours 30 minutes', 'pending'),
  ('00000000-0000-0000-0000-0000000c1633', '00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1621', '00000000-0000-0000-0000-0000000c1622', '00000000-0000-0000-0000-0000000c1623', now() + interval '10 hours', now() + interval '10 hours 30 minutes', 'confirmed')
on conflict do nothing;

-- Escalaciones: A tiene una de hace 2 h (cuenta como "sin seguimiento") y una de hace 10 min (aun no); B tiene dos de hace horas.
insert into citas.emergency_escalations (id, organization_id, customer_phone, channel, keyword_matched, message_excerpt, created_at) values
  ('00000000-0000-0000-0000-0000000c1641', '00000000-0000-0000-0000-0000000c1601', '+5219981110001', 'whatsapp', 'crisis', 'texto A1', now() - interval '2 hours'),
  ('00000000-0000-0000-0000-0000000c1642', '00000000-0000-0000-0000-0000000c1601', '+5219981110002', 'whatsapp', 'crisis', 'texto A2', now() - interval '10 minutes'),
  ('00000000-0000-0000-0000-0000000c1643', '00000000-0000-0000-0000-0000000c1602', '+5219981110003', 'whatsapp', 'crisis', 'texto B1', now() - interval '3 hours'),
  ('00000000-0000-0000-0000-0000000c1644', '00000000-0000-0000-0000-0000000c1602', '+5219981110004', 'voice', 'crisis', 'texto B2', now() - interval '4 hours')
on conflict do nothing;

-- Recordatorios de 24 h: A tiene uno agotado (dead, hace 5 h) y uno enviado; B tiene uno agotado.
insert into citas.messaging_outbox (organization_id, channel, event_type, dedupe_key, payload, status, created_at) values
  ('00000000-0000-0000-0000-0000000c1601', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:c16-a-dead', '{}'::jsonb, 'dead', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-0000000c1601', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:c16-a-sent', '{}'::jsonb, 'sent', now() - interval '5 hours'),
  ('00000000-0000-0000-0000-0000000c1602', 'whatsapp', 'appointment.reminder_24h', 'reminder-24h:c16-b-dead', '{}'::jsonb, 'dead', now() - interval '5 hours')
on conflict do nothing;

-- ============================================================================
-- (A) citas.set_escalation_follow_up
-- ============================================================================

\echo '=== A1. (positivo) owner de A toma el seguimiento de su escalacion: queda in_progress, con el actor real (auth.uid) y la fecha (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
select out_status from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'in_progress', null);
select (follow_up_status = 'in_progress' and follow_up_by = '00000000-0000-0000-0000-0000000c1611' and follow_up_at is not null)::int as seguimiento_con_actor_real_deberia_ser_1
  from citas.emergency_escalations where id = '00000000-0000-0000-0000-0000000c1641';
rollback;

\echo '=== A2. (positivo) resolver con nota: la nota se guarda recortada y la fila no cambia de organizacion ni de telefono (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
select out_status from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'resolved', '  llamado por telefono  ');
select (follow_up_status = 'resolved' and follow_up_note = 'llamado por telefono' and customer_phone = '+5219981110001' and organization_id = '00000000-0000-0000-0000-0000000c1601')::int as nota_recortada_y_fila_intacta_deberia_ser_1
  from citas.emergency_escalations where id = '00000000-0000-0000-0000-0000000c1641';
rollback;

\echo '=== A3. (tope) una nota de 600 caracteres se recorta a 500 DENTRO de la funcion (nunca viola el CHECK) (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
select out_status from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'resolved', repeat('x', 600));
select (char_length(follow_up_note) = 500)::int as nota_recortada_a_500_deberia_ser_1 from citas.emergency_escalations where id = '00000000-0000-0000-0000-0000000c1641';
rollback;

\echo '=== A4. (negativo, SQLSTATE exacto) un STAFF (vertical_role staff) de A NO puede dar seguimiento: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1612', true);
do $$
begin
  perform * from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'resolved', null);
  raise exception 'BLOQUEANTE: se esperaba 42501 para un staff sin rol owner/admin pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A5. (negativo cross-tenant, SQLSTATE exacto) el owner de B invocando la funcion con la organizacion A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1613', true);
do $$
begin
  perform * from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'resolved', null);
  raise exception 'BLOQUEANTE: se esperaba 42501 para el owner de otra organizacion pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A6. (negativo cross-tenant, sin confirmar existencia) el owner de B con SU organizacion pero el id de una escalacion de A: P0002 y la fila de A queda intacta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1613', true);
do $$
begin
  perform * from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1602', '00000000-0000-0000-0000-0000000c1641', 'resolved', null);
  raise exception 'BLOQUEANTE: se esperaba P0002 (no existe en su organizacion) pero la llamada tuvo exito';
exception
  when sqlstate 'P0002' then null;
end $$;
rollback;

\echo '=== A7. (la fila de A sigue intacta tras el intento cross-tenant) (deberia_ser_1) ==='
begin;
select (follow_up_status = 'pending' and follow_up_by is null)::int as fila_de_a_intacta_deberia_ser_1 from citas.emergency_escalations where id = '00000000-0000-0000-0000-0000000c1641';
rollback;

\echo '=== A8. (negativo, SQLSTATE exacto) sesion de SISTEMA (auth.uid null): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform * from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'resolved', null);
  raise exception 'BLOQUEANTE: se esperaba 42501 para la sesion de sistema pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A9. (negativo, causa raiz) anon no tiene GRANT execute sobre set_escalation_follow_up (deberia_ser_1) y su llamada falla con 42501 ==='
begin;
select (not has_function_privilege('anon', 'citas.set_escalation_follow_up(uuid, uuid, text, text)', 'execute'))::int as anon_sin_grant_execute_deberia_ser_1;
rollback;

begin;
set local role anon;
do $$
begin
  perform * from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'resolved', null);
  raise exception 'BLOQUEANTE: se esperaba 42501 para anon pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A10. (negativo, SQLSTATE exacto) estado invalido (pending no se puede fijar a mano): 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
do $$
begin
  perform * from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'pending', null);
  raise exception 'BLOQUEANTE: se esperaba 22023 para un estado fuera de in_progress/resolved pero la llamada tuvo exito';
exception
  when sqlstate '22023' then null;
end $$;
rollback;

-- ============================================================================
-- (B) La tabla sigue cerrada a la escritura directa.
-- ============================================================================

\echo '=== B1. (negativo, SQLSTATE exacto) el owner de A NO puede hacer UPDATE directo sobre emergency_escalations (sin GRANT): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
do $$
begin
  update citas.emergency_escalations set follow_up_status = 'resolved' where id = '00000000-0000-0000-0000-0000000c1641';
  raise exception 'BLOQUEANTE: se esperaba 42501 por falta de GRANT UPDATE pero el UPDATE directo tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== B2. (negativo, SQLSTATE exacto) el owner de A NO puede insertar escalaciones a mano: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
do $$
begin
  insert into citas.emergency_escalations (organization_id, customer_phone, keyword_matched, message_excerpt) values ('00000000-0000-0000-0000-0000000c1601', '+52', 'k', 'm');
  raise exception 'BLOQUEANTE: se esperaba 42501 por falta de GRANT INSERT pero el INSERT directo tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== B3. (cross-tenant de lectura) el owner de B ve 0 escalaciones de A por SELECT directo (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1613', true);
select count(*) as owner_b_no_ve_escalaciones_de_a_deberia_ser_0 from citas.emergency_escalations where organization_id = '00000000-0000-0000-0000-0000000c1601';
rollback;

-- ============================================================================
-- (C) citas.system_avisos_resumen (solo sistema)
-- ============================================================================

\echo '=== C1. (positivo) sesion de SISTEMA: A tiene 1 por confirmar (48 h), 1 recordatorio agotado y 1 escalacion sin seguimiento (>1 h) (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (por_confirmar = 1 and recordatorios_agotados = 1 and escalaciones_sin_seguimiento = 1 and ultimo_agotado_epoch is not null)::int as conteos_de_a_deberia_ser_1
  from citas.system_avisos_resumen('00000000-0000-0000-0000-0000000c1601');
rollback;

\echo '=== C2. (cross-tenant) los conteos de B son los de B: 0 por confirmar, 1 agotado y 2 escalaciones sin seguimiento; nunca mezclan los de A (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (por_confirmar = 0 and recordatorios_agotados = 1 and escalaciones_sin_seguimiento = 2)::int as conteos_de_b_deberia_ser_1
  from citas.system_avisos_resumen('00000000-0000-0000-0000-0000000c1602');
rollback;

\echo '=== C3. (seguimiento descuenta) tras tomar la escalacion de A el conteo de sin seguimiento baja a 0 (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
select out_status from citas.set_escalation_follow_up('00000000-0000-0000-0000-0000000c1601', '00000000-0000-0000-0000-0000000c1641', 'in_progress', null);
select set_config('request.jwt.claim.sub', '', true);
select (escalaciones_sin_seguimiento = 0)::int as sin_seguimiento_baja_a_cero_deberia_ser_1 from citas.system_avisos_resumen('00000000-0000-0000-0000-0000000c1601');
rollback;

\echo '=== C4. (negativo, SQLSTATE exacto) un STAFF autenticado real NO puede usar la funcion de solo-sistema (ni para su propia organizacion): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1611', true);
do $$
begin
  perform * from citas.system_avisos_resumen('00000000-0000-0000-0000-0000000c1601');
  raise exception 'BLOQUEANTE: se esperaba 42501 (guard auth.uid() is null) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C5. (negativo, causa raiz) anon no tiene GRANT execute sobre system_avisos_resumen (deberia_ser_1) y su llamada falla con 42501 ==='
begin;
select (not has_function_privilege('anon', 'citas.system_avisos_resumen(uuid)', 'execute'))::int as anon_sin_grant_execute_resumen_deberia_ser_1;
rollback;

begin;
set local role anon;
do $$
begin
  perform * from citas.system_avisos_resumen('00000000-0000-0000-0000-0000000c1601');
  raise exception 'BLOQUEANTE: se esperaba 42501 para anon pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

-- ============================================================================
-- (D) Integracion con core.emit_notification (productor compartido, 0039) con los parametros exactos del catalogo.
-- ============================================================================

\echo '=== D1. (critica) citas.escalacion.crisis llega SOLO al owner de A (rol vacio = owner/admin), con {orgSlug} resuelto en el enlace (deberia_ser_1) ==='
begin;
select core.emit_notification('00000000-0000-0000-0000-0000000c1601', null, 'citas.escalacion.crisis', 'agentes', 'critica', 'Un cliente escribió un mensaje de crisis', 'El agente respondió con el aviso de crisis y registró la escalación para tu seguimiento.', '/citas/{orgSlug}/avisos', 'emergency_escalation', '00000000-0000-0000-0000-0000000c1641', 'citas.escalacion.crisis:00000000-0000-0000-0000-0000000c1641', null, interval '14 days');
select (count(*) filter (where staff_user_id = '00000000-0000-0000-0000-0000000c1611' and enlace = '/citas/org-citas-c16-a/avisos' and severidad = 'critica') = 1
        and count(*) filter (where staff_user_id = '00000000-0000-0000-0000-0000000c1612') = 0
        and count(*) filter (where staff_user_id = '00000000-0000-0000-0000-0000000c1613') = 0)::int as crisis_solo_al_owner_de_a_deberia_ser_1
  from core.notification where tipo = 'citas.escalacion.crisis';
rollback;

\echo '=== D2. (por confirmar) citas.cita.por_confirmar llega al owner Y al staff de A (roles [staff]); jamas al owner de B (deberia_ser_1) ==='
begin;
select core.emit_notification('00000000-0000-0000-0000-0000000c1601', null, 'citas.cita.por_confirmar', 'operacion', 'atencion', 'Citas por confirmar en las próximas 48 horas', 'Por confirmar: 1.', '/citas/{orgSlug}/avisos', null, null, 'citas.cita.por_confirmar:x:2026-10-01', array['staff'], interval '3 days');
select (count(*) filter (where staff_user_id in ('00000000-0000-0000-0000-0000000c1611', '00000000-0000-0000-0000-0000000c1612')) = 2
        and count(*) filter (where staff_user_id = '00000000-0000-0000-0000-0000000c1613') = 0)::int as por_confirmar_a_owner_y_staff_de_a_deberia_ser_1
  from core.notification where tipo = 'citas.cita.por_confirmar';
rollback;

\echo '=== D3. (idempotencia) emitir dos veces la misma clave de dedupe inserta una sola fila por destinatario (deberia_ser_1) ==='
begin;
select core.emit_notification('00000000-0000-0000-0000-0000000c1601', null, 'citas.recordatorio.agotado', 'salud', 'atencion', 'Recordatorios que no se pudieron entregar', 'Agotaron sus reintentos: 1.', '/citas/{orgSlug}/avisos', null, null, 'citas.recordatorio.agotado:k1', null, interval '5 days');
select core.emit_notification('00000000-0000-0000-0000-0000000c1601', null, 'citas.recordatorio.agotado', 'salud', 'atencion', 'Recordatorios que no se pudieron entregar', 'Agotaron sus reintentos: 1.', '/citas/{orgSlug}/avisos', null, null, 'citas.recordatorio.agotado:k1', null, interval '5 days');
select (count(*) = 1)::int as una_fila_por_clave_deberia_ser_1 from core.notification where tipo = 'citas.recordatorio.agotado' and staff_user_id = '00000000-0000-0000-0000-0000000c1611';
rollback;

\echo '=== D4. (nada fuera del tenant) la campana del owner de B no recibe nada de los avisos de A (deberia_ser_0) ==='
begin;
select core.emit_notification('00000000-0000-0000-0000-0000000c1601', null, 'citas.escalacion.sin_seguimiento', 'agentes', 'critica', 'Escalaciones de crisis sin seguimiento', 'Sin seguimiento: 1.', '/citas/{orgSlug}/avisos', null, null, 'citas.escalacion.sin_seguimiento:x:2026-10-01', null, interval '3 days');
select count(*) as owner_b_sin_avisos_de_a_deberia_ser_0 from core.notification where staff_user_id = '00000000-0000-0000-0000-0000000c1613';
rollback;
