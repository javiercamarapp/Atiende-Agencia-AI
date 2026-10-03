-- Verificación contra Postgres REAL de C-11 (bandeja de conversaciones de WhatsApp de citas con handoff a humano),
-- migración 031 (packages/domain-citas/migrations/031_citas_conversaciones_handoff.sql):
--
--   (A) citas.handoff_tomar: positivo (conversación sin sucursal y con sucursal), idempotente para quien ya la tiene,
--       segunda persona -> 55006, negativos con SQLSTATE EXACTO: otra sucursal, staff acotado a otra sucursal,
--       otro tenant, sistema y anon.
--   (B) devolver / cerrar: transiciones válidas, idempotencia, solo quien la tomó o un owner/admin, trigger que rechaza
--       volver de un estado final (55000), y que una conversación cerrada se pueda tomar de nuevo (historial).
--   (C) notas internas y respuesta humana por el outbox: autor = auth.uid(), tope de 2000, solo quien tiene la toma responde,
--       sin número de WhatsApp activo -> P0002, nada sale por otro tenant.
--   (D) bandeja: alcance por sucursal, aislamiento cross-tenant (RLS), marca de crisis, cita vinculada, filtro por estado,
--       DML directo cerrado.
--   (E) funciones de SOLO-SISTEMA del agente (solicitar humano / consultar si debe callar) y sus negativos.
--   (F) grants, e integración con core.emit_notification (citas.conversacion.handoff).
--
-- Cada escenario va en su propio begin; ... rollback; (el gate run-gate.mjs los ejecuta como conexiones independientes).

-- ============================================================================
-- Fixtures (se confirman fuera de los escenarios).
-- ============================================================================
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c1101', 'citas', 'Org Citas C11 (A)', 'org-citas-c11-a'),
  ('00000000-0000-0000-0000-0000000c1102', 'citas', 'Org Citas C11 (B, cross-tenant)', 'org-citas-c11-b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1101', 'citas', 'Sucursal 1 A'),
  ('00000000-0000-0000-0000-0000000c1122', '00000000-0000-0000-0000-0000000c1101', 'citas', 'Sucursal 2 A'),
  ('00000000-0000-0000-0000-0000000c1123', '00000000-0000-0000-0000-0000000c1102', 'citas', 'Sucursal B')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c1111', 'owner-a-c11@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c1112', 'staff-a-c11@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000c1113', 'staff-p2-c11@example.com', 'Staff Sucursal 2', 'seed'),
  ('00000000-0000-0000-0000-0000000c1114', 'owner-b-c11@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000c1115', 'admin-a-c11@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000c1116', 'staff-a2-c11@example.com', 'Staff A2', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c1111', '00000000-0000-0000-0000-0000000c1101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c1112', '00000000-0000-0000-0000-0000000c1101', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c1113', '00000000-0000-0000-0000-0000000c1101', array['00000000-0000-0000-0000-0000000c1122']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c1114', '00000000-0000-0000-0000-0000000c1102', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c1115', '00000000-0000-0000-0000-0000000c1101', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c1116', '00000000-0000-0000-0000-0000000c1101', null, 'member', 'staff')
on conflict do nothing;

insert into citas.whatsapp_config (organization_id, phone_number_id) values ('00000000-0000-0000-0000-0000000c1101', 'pnid-c11-a')
on conflict do nothing;

insert into citas.providers (id, organization_id, display_name) values ('00000000-0000-0000-0000-0000000c1151', '00000000-0000-0000-0000-0000000c1101', 'Proveedor A') on conflict do nothing;
insert into citas.services (id, organization_id, name, duration_minutes) values ('00000000-0000-0000-0000-0000000c1152', '00000000-0000-0000-0000-0000000c1101', 'Consulta A', 30) on conflict do nothing;
insert into citas.customers (id, organization_id, full_name, phone) values ('00000000-0000-0000-0000-0000000c1153', '00000000-0000-0000-0000-0000000c1101', 'Cliente A', '+5219981110002') on conflict do nothing;
insert into citas.appointments (id, organization_id, provider_id, service_id, customer_id, starts_at, ends_at, status) values
  ('00000000-0000-0000-0000-0000000c1154', '00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1151', '00000000-0000-0000-0000-0000000c1152', '00000000-0000-0000-0000-0000000c1153', now() + interval '20 hours', now() + interval '20 hours 30 minutes', 'confirmed')
on conflict do nothing;

-- Conversaciones: CV0 de A sin sucursal; CV1 de A en la sucursal 1 con una cita vinculada; CV2 de A en la sucursal 2; CVB de B.
insert into citas.whatsapp_conversations (id, organization_id, phone, property_id, messages, appointment_id) values
  ('00000000-0000-0000-0000-0000000c1131', '00000000-0000-0000-0000-0000000c1101', '+5219981110001', null, '[{"role":"user","content":"Necesito hablar con alguien"}]'::jsonb, null),
  ('00000000-0000-0000-0000-0000000c1132', '00000000-0000-0000-0000-0000000c1101', '+5219981110002', '00000000-0000-0000-0000-0000000c1121', '[{"role":"user","content":"Quiero mover mi cita"}]'::jsonb, '00000000-0000-0000-0000-0000000c1154'),
  ('00000000-0000-0000-0000-0000000c1133', '00000000-0000-0000-0000-0000000c1101', '+5219981110003', '00000000-0000-0000-0000-0000000c1122', '[{"role":"user","content":"Hola"}]'::jsonb, null),
  ('00000000-0000-0000-0000-0000000c1134', '00000000-0000-0000-0000-0000000c1102', '+5219981110004', null, '[{"role":"user","content":"Hola B"}]'::jsonb, null)
on conflict do nothing;

-- Una escalación de crisis SIN resolver del teléfono de CV0 (la bandeja la marca).
insert into citas.emergency_escalations (id, organization_id, customer_phone, channel, keyword_matched, message_excerpt, created_at) values
  ('00000000-0000-0000-0000-0000000c1141', '00000000-0000-0000-0000-0000000c1101', '+5219981110001', 'whatsapp', 'crisis', 'texto de crisis', now() - interval '1 hour')
on conflict do nothing;

-- ============================================================================
-- (A) citas.handoff_tomar
-- ============================================================================

\echo '=== A1. (positivo) un staff toma una conversacion SIN sucursal desde la sucursal 1: queda tomada por el, con sucursal nula (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1131');
select (estado = 'tomada' and tomada_por = '00000000-0000-0000-0000-0000000c1112' and tomada_at is not null and property_id is null and solicitado_por = 'staff')::int as toma_sin_sucursal_deberia_ser_1
  from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1131';
rollback;

\echo '=== A2. (positivo) toma de una conversacion de la sucursal 1: el handoff hereda la sucursal 1 y es idempotente para quien ya la tiene (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
select (count(*) = 1 and bool_and(property_id = '00000000-0000-0000-0000-0000000c1121') and bool_and(estado = 'tomada'))::int as una_sola_toma_con_sucursal_deberia_ser_1
  from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1132';
rollback;

\echo '=== A3. (negativo, SQLSTATE exacto) tomar una conversacion de la sucursal 2 declarando la sucursal 1: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
do $$
begin
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1133');
  raise exception 'BLOQUEANTE: se esperaba 42501 (la conversacion no es de esa sucursal) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A4. (negativo, SQLSTATE exacto) un staff ACOTADO a la sucursal 2 no puede tomar nada de la sucursal 1: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1113', true);
do $$
begin
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
  raise exception 'BLOQUEANTE: se esperaba 42501 (staff de otra sucursal) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A5. (negativo cross-tenant, SQLSTATE exacto) el owner de B declarando la organizacion A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
do $$
begin
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
  raise exception 'BLOQUEANTE: se esperaba 42501 (otro tenant) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A6. (negativo cross-tenant, SQLSTATE exacto) el owner de B con SU organizacion pero la conversacion de A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
do $$
begin
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1102', '00000000-0000-0000-0000-0000000c1123', '00000000-0000-0000-0000-0000000c1131');
  raise exception 'BLOQUEANTE: se esperaba 42501 (conversacion ajena) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A7. (negativo, SQLSTATE exacto) sesion de SISTEMA (auth.uid null) no puede tomar: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
  raise exception 'BLOQUEANTE: se esperaba 42501 (sistema) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A8. (negativo, SQLSTATE exacto) anon no puede tomar: 42501 ==='
begin;
set local role anon;
do $$
begin
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
  raise exception 'BLOQUEANTE: se esperaba 42501 (anon) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A9. (concurrencia, SQLSTATE exacto) si otra persona ya la tiene tomada, la segunda toma recibe 55006 y no pisa a la primera ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
  raise exception 'BLOQUEANTE: se esperaba 55006 (ya tomada por otra persona) pero la llamada tuvo exito';
exception
  when sqlstate '55006' then null;
end $$;
rollback;

\echo '=== A10. (la primera toma sigue intacta tras el intento de la segunda) (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
do $$ begin
  perform set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
  perform citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
exception when sqlstate '55006' then null; end $$;
select (tomada_por = '00000000-0000-0000-0000-0000000c1112')::int as primera_toma_intacta_deberia_ser_1 from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1132';
rollback;

-- ============================================================================
-- (B) devolver / cerrar y transiciones
-- ============================================================================

\echo '=== B1. (positivo) quien tomo la conversacion la devuelve al agente: estado devuelta con fecha, y deja de estar abierta (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select citas.handoff_devolver('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
select (estado = 'devuelta' and devuelta_at is not null)::int as devuelta_con_fecha_deberia_ser_1 from citas.conversation_handoff where id = (select id from _h);
rollback;

\echo '=== B2. (idempotencia) devolver dos veces responde false la segunda y no cambia nada (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select citas.handoff_devolver('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
select (not citas.handoff_devolver('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h)))::int as segunda_devolucion_sin_cambio_deberia_ser_1;
rollback;

\echo '=== B3. (positivo) un admin puede devolver la toma de otra persona (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1115', true);
select citas.handoff_devolver('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
select (estado = 'devuelta')::int as admin_devuelve_ajena_deberia_ser_1 from citas.conversation_handoff where id = (select id from _h);
rollback;

\echo '=== B4. (negativo, SQLSTATE exacto) otro staff NO puede devolver la toma de una persona distinta: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1116', true);
do $$
begin
  perform citas.handoff_devolver('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
  raise exception 'BLOQUEANTE: se esperaba 42501 (otro staff) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== B5. (negativo cross-tenant, SQLSTATE exacto) el owner de B no puede cerrar un handoff de A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
do $$
begin
  perform citas.handoff_cerrar('00000000-0000-0000-0000-0000000c1102', '00000000-0000-0000-0000-0000000c1123', (select id from _h));
  raise exception 'BLOQUEANTE: se esperaba 42501 (handoff ajeno) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== B6. (negativo, SQLSTATE exacto) un staff acotado a la sucursal 2 no puede cerrar el handoff de la sucursal 1: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1113', true);
do $$
begin
  perform citas.handoff_cerrar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
  raise exception 'BLOQUEANTE: se esperaba 42501 (otra sucursal) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== B7. (negativo, SQLSTATE exacto) estado final invalido en la funcion generica: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
do $$
begin
  perform citas.handoff_liberar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), 'tomada');
  raise exception 'BLOQUEANTE: se esperaba 22023 (estado final invalido) pero la llamada tuvo exito';
exception
  when sqlstate '22023' then null;
end $$;
rollback;

\echo '=== B8. (positivo) cerrar deja la conversacion cerrada y se puede tomar de nuevo: queda el historial con 2 filas (deberia_ser_2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select citas.handoff_cerrar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
select count(*) as filas_de_historial_deberia_ser_2 from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1132';
rollback;

\echo '=== B9. (transicion invalida, SQLSTATE exacto) una toma cerrada NO puede volver a tomada ni por UPDATE directo del dueno de la tabla: 55000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select citas.handoff_cerrar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
reset role;
do $$
begin
  update citas.conversation_handoff set estado = 'tomada' where id = (select id from _h);
  raise exception 'BLOQUEANTE: se esperaba 55000 (cerrada no reabre) pero la sentencia tuvo exito';
exception
  when sqlstate '55000' then null;
end $$;
rollback;

\echo '=== B10. (transicion invalida, SQLSTATE exacto) una toma devuelta NO puede volver a pendiente: 55000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select citas.handoff_devolver('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
reset role;
do $$
begin
  update citas.conversation_handoff set estado = 'pendiente' where id = (select id from _h);
  raise exception 'BLOQUEANTE: se esperaba 55000 (devuelta no reabre) pero la sentencia tuvo exito';
exception
  when sqlstate '55000' then null;
end $$;
rollback;

-- ============================================================================
-- (C) notas internas y respuesta humana
-- ============================================================================

\echo '=== C1. (positivo) una nota interna queda con el autor real (auth.uid), recortada, y la leen los del alcance (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select citas.handoff_agregar_nota('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), '  llamar al cliente despues de las 5  ');
select (count(*) = 1 and bool_and(texto = 'llamar al cliente despues de las 5') and bool_and(autor_id = '00000000-0000-0000-0000-0000000c1112'))::int as nota_con_autor_real_deberia_ser_1
  from citas.handoff_notas('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
rollback;

\echo '=== C2. (tope, SQLSTATE exacto) una nota de 2001 caracteres viola el CHECK de la base: 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
do $$
begin
  perform citas.handoff_agregar_nota('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), repeat('x', 2001));
  raise exception 'BLOQUEANTE: se esperaba 23514 (nota demasiado larga) pero la llamada tuvo exito';
exception
  when sqlstate '23514' then null;
end $$;
rollback;

\echo '=== C3. (negativo cross-tenant, SQLSTATE exacto) el owner de B no puede escribir una nota en un handoff de A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
do $$
begin
  perform citas.handoff_agregar_nota('00000000-0000-0000-0000-0000000c1102', '00000000-0000-0000-0000-0000000c1123', (select id from _h), 'intruso');
  raise exception 'BLOQUEANTE: se esperaba 42501 (handoff ajeno) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C4. (positivo) responder: el mensaje humano queda en el historial (autor humano) y se encola UNA vez en el outbox con el numero de la organizacion (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select citas.handoff_responder('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), '  Con gusto le ayudo  ');
reset role;
select ((select count(*) from citas.messaging_outbox where organization_id = '00000000-0000-0000-0000-0000000c1101' and event_type = 'whatsapp.handoff_reply'
          and payload ->> 'to' = '+5219981110002' and payload ->> 'phone_number_id' = 'pnid-c11-a' and payload ->> 'body' = 'Con gusto le ayudo') = 1
        and (select (messages -> 1 ->> 'autor') = 'humano' and (messages -> 1 ->> 'staff_id') = '00000000-0000-0000-0000-0000000c1112'::text from citas.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000c1132'))::int as respuesta_humana_en_outbox_e_historial_deberia_ser_1;
rollback;

\echo '=== C5. (negativo, SQLSTATE exacto) otro staff que NO tiene la toma no puede responder: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  perform citas.handoff_responder('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), 'hola');
  raise exception 'BLOQUEANTE: se esperaba 42501 (no es quien la tiene) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C6. (negativo, SQLSTATE exacto) responder sin haber tomado (toma pendiente del agente): 42501 ==='
begin;
reset role;
create temp table _h as select h.id from (select citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110002', 'cliente pide una persona', false) as id) h;
grant select on _h to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
do $$
begin
  perform citas.handoff_responder('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), 'hola');
  raise exception 'BLOQUEANTE: se esperaba 42501 (toma pendiente) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C7. (negativo, SQLSTATE exacto) mensaje vacio: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
do $$
begin
  perform citas.handoff_responder('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), '   ');
  raise exception 'BLOQUEANTE: se esperaba 22023 (mensaje vacio) pero la llamada tuvo exito';
exception
  when sqlstate '22023' then null;
end $$;
rollback;

\echo '=== C8. (negativo, SQLSTATE exacto) una organizacion SIN numero de WhatsApp activo no puede responder: P0002 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
create temp table _hb as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1102', '00000000-0000-0000-0000-0000000c1123', '00000000-0000-0000-0000-0000000c1134') as id;
grant select on _hb to authenticated;
do $$
begin
  perform citas.handoff_responder('00000000-0000-0000-0000-0000000c1102', '00000000-0000-0000-0000-0000000c1123', (select id from _hb), 'hola');
  raise exception 'BLOQUEANTE: se esperaba P0002 (sin numero de WhatsApp) pero la llamada tuvo exito';
exception
  when sqlstate 'P0002' then null;
end $$;
rollback;

\echo '=== C9. (negativo, SQLSTATE exacto) anon no puede responder: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132') as id;
grant select on _h to authenticated;
reset role;
set local role anon;
do $$
begin
  perform citas.handoff_responder('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h), 'hola');
  raise exception 'BLOQUEANTE: se esperaba 42501 (anon) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

-- ============================================================================
-- (D) bandeja, alcance por sucursal y RLS
-- ============================================================================

\echo '=== D1. (positivo) un staff ve en la sucursal 1 la conversacion sin sucursal y la de la sucursal 1, NO la de la sucursal 2 ni la de otro tenant (deberia_ser_2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select count(*) as conversaciones_de_la_sucursal_1_deberia_ser_2 from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0);
rollback;

\echo '=== D2. (crisis) la conversacion con una escalacion de crisis sin resolver sale MARCADA y primera; la otra no (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select ((select conversation_id from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0) limit 1) = '00000000-0000-0000-0000-0000000c1131'
        and (select crisis from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0) where conversation_id = '00000000-0000-0000-0000-0000000c1131')
        and not (select crisis from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0) where conversation_id = '00000000-0000-0000-0000-0000000c1132'))::int as crisis_marcada_y_primera_deberia_ser_1;
rollback;

\echo '=== D3. (crisis resuelta) al resolver el seguimiento la marca desaparece (deberia_ser_1) ==='
begin;
update citas.emergency_escalations set follow_up_status = 'resolved' where id = '00000000-0000-0000-0000-0000000c1141';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select (not (select crisis from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0) where conversation_id = '00000000-0000-0000-0000-0000000c1131'))::int as sin_marca_si_esta_resuelta_deberia_ser_1;
rollback;

\echo '=== D4. (cita vinculada) la conversacion con una cita muestra su id, inicio y estado (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select (cita_id = '00000000-0000-0000-0000-0000000c1154' and cita_estado = 'confirmed' and cita_inicio is not null)::int as cita_vinculada_deberia_ser_1
  from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0) where conversation_id = '00000000-0000-0000-0000-0000000c1132';
rollback;

\echo '=== D5. (alcance) un staff acotado a la sucursal 2 ve la sin sucursal y la suya: 2 (deberia_ser_2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1113', true);
select count(*) as conversaciones_de_la_sucursal_2_deberia_ser_2 from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1122', null, 50, 0);
rollback;

\echo '=== D6. (negativo, SQLSTATE exacto) ese staff acotado NO puede abrir la bandeja de la sucursal 1: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1113', true);
do $$
begin
  perform citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0);
  raise exception 'BLOQUEANTE: se esperaba 42501 (otra sucursal) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D7. (negativo cross-tenant, SQLSTATE exacto) el owner de B no puede abrir la bandeja de A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
do $$
begin
  perform citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0);
  raise exception 'BLOQUEANTE: se esperaba 42501 (otro tenant) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D8. (cross-tenant) el owner de B ve SOLO su propia conversacion en su bandeja (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
select count(*) as solo_la_de_b_deberia_ser_1 from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1102', '00000000-0000-0000-0000-0000000c1123', null, 50, 0);
rollback;

\echo '=== D9. (negativo, SQLSTATE exacto) sesion de sistema no abre la bandeja: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0);
  raise exception 'BLOQUEANTE: se esperaba 42501 (sistema) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D10. (negativo, SQLSTATE exacto) anon no abre la bandeja: 42501 ==='
begin;
set local role anon;
do $$
begin
  perform citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', null, 50, 0);
  raise exception 'BLOQUEANTE: se esperaba 42501 (anon) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D11. (filtro por estado) tras tomar una, el filtro 'tomada' devuelve solo esa y 'agente' devuelve las demas (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
select ((select count(*) from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', 'tomada', 50, 0)) = 1
        and (select count(*) from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', 'agente', 50, 0)) = 1
        and (select tomada_por_nombre from citas.bandeja_conversaciones('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', 'tomada', 50, 0)) = 'Staff A')::int as filtro_por_estado_deberia_ser_1;
rollback;

\echo '=== D12. (RLS cross-tenant de lectura directa) el owner de B ve 0 handoffs de A por SELECT directo (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1114', true);
select count(*) as handoffs_de_a_visibles_para_b_deberia_ser_0 from citas.conversation_handoff;
rollback;

\echo '=== D13. (RLS por sucursal de lectura directa) un staff acotado a la sucursal 2 NO ve el handoff de la sucursal 1 (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1113', true);
select count(*) as handoff_de_otra_sucursal_visible_deberia_ser_0 from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1132';
rollback;

\echo '=== D14. (RLS) ese mismo staff SI ve el handoff de una conversacion sin sucursal de su organizacion (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1131');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1113', true);
select count(*) as handoff_sin_sucursal_visible_deberia_ser_1 from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1131';
rollback;

\echo '=== D15. (negativo, SQLSTATE exacto) el owner de A NO puede hacer conversation_handoff INSERT directo (sin GRANT): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  insert into citas.conversation_handoff (organization_id, conversation_id, estado, solicitado_por) values ('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1133', 'tomada', 'staff');
  raise exception 'BLOQUEANTE: se esperaba 42501 por falta de GRANT (conversation_handoff INSERT) pero la escritura directa tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D15. (negativo, SQLSTATE exacto) el owner de A NO puede hacer conversation_handoff UPDATE directo (sin GRANT): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  update citas.conversation_handoff set estado = 'cerrada';
  raise exception 'BLOQUEANTE: se esperaba 42501 por falta de GRANT (conversation_handoff UPDATE) pero la escritura directa tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D15. (negativo, SQLSTATE exacto) el owner de A NO puede hacer conversation_handoff DELETE directo (sin GRANT): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  delete from citas.conversation_handoff;
  raise exception 'BLOQUEANTE: se esperaba 42501 por falta de GRANT (conversation_handoff DELETE) pero la escritura directa tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D15. (negativo, SQLSTATE exacto) el owner de A NO puede hacer conversation_note INSERT directo (sin GRANT): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  insert into citas.conversation_note (organization_id, handoff_id, texto) values ('00000000-0000-0000-0000-0000000c1101', gen_random_uuid(), 'x');
  raise exception 'BLOQUEANTE: se esperaba 42501 por falta de GRANT (conversation_note INSERT) pero la escritura directa tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

-- ============================================================================
-- (E) funciones de SOLO-SISTEMA del agente
-- ============================================================================

\echo '=== E1. (positivo) el agente pide un humano por crisis: toma PENDIENTE con la sucursal de la conversacion y la marca de crisis; repetirlo no duplica (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110002', 'escalacion de crisis', true);
select citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110002', 'escalacion de crisis', true);
reset role;
select (count(*) = 1 and bool_and(estado = 'pendiente' and solicitado_por = 'agente' and crisis and property_id = '00000000-0000-0000-0000-0000000c1121'))::int as una_sola_pendiente_de_crisis_deberia_ser_1
  from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1132';
rollback;

\echo '=== E2. (sin conversacion) un telefono sin conversacion devuelve null y no crea nada (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table _r as select citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219990000000', 'x', false) as id;
reset role;
select ((select count(*) from _r where id is not null) = 0 and (select count(*) from citas.conversation_handoff) = 0)::int as sin_conversacion_devuelve_null_y_no_crea_nada_deberia_ser_1;
rollback;

\echo '=== E3. (cross-tenant) pedir un humano para el telefono de una conversacion de B desde la organizacion A no crea nada (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
create temp table _r as select citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110004', 'x', false) as id;
reset role;
select count(*) as nada_cruzado_deberia_ser_0 from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1134';
rollback;

\echo '=== E4. (negativo, SQLSTATE exacto) un staff autenticado NO puede usar la funcion de solo-sistema: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  perform citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110002', 'x', false);
  raise exception 'BLOQUEANTE: se esperaba 42501 (solo sistema) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== E5. (negativo, SQLSTATE exacto) anon no puede pedir un humano: 42501 ==='
begin;
set local role anon;
do $$
begin
  perform citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110002', 'x', false);
  raise exception 'BLOQUEANTE: se esperaba 42501 (anon) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== E6. (el agente calla) con la toma pendiente o tomada el agente recibe el estado y se registra el ping del cliente; devuelta -> null (deberia_ser_1) ==='
begin;
reset role;
create temp table _r (paso text, estado text);
grant all on _r to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110002', 'x', false);
insert into _r select 'pendiente', citas.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000c1101', '+5219981110002');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
create temp table _h as select id from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1132';
grant select on _h to authenticated;
select citas.handoff_tomar('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', '00000000-0000-0000-0000-0000000c1132');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into _r select 'tomada', citas.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000c1101', '+5219981110002');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1112', true);
select citas.handoff_devolver('00000000-0000-0000-0000-0000000c1101', '00000000-0000-0000-0000-0000000c1121', (select id from _h));
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into _r select 'devuelta', citas.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000c1101', '+5219981110002');
select ((select estado from _r where paso = 'pendiente') = 'pendiente'
        and (select estado from _r where paso = 'tomada') = 'tomada'
        and (select estado from _r where paso = 'devuelta') is null)::int as el_agente_calla_y_se_reactiva_deberia_ser_1;
rollback;

\echo '=== E7. (ping del cliente) el estado registra ultimo_cliente_at solo mientras la toma esta abierta (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select citas.handoff_solicitar_whatsapp('00000000-0000-0000-0000-0000000c1101', '+5219981110002', 'x', false);
select citas.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000c1101', '+5219981110002');
reset role;
select (ultimo_cliente_at is not null)::int as ping_registrado_deberia_ser_1 from citas.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000c1132';
rollback;

\echo '=== E8. (negativo, SQLSTATE exacto) un staff autenticado NO puede consultar el estado como si fuera el agente: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c1111', true);
do $$
begin
  perform citas.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000c1101', '+5219981110002');
  raise exception 'BLOQUEANTE: se esperaba 42501 (solo sistema) pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== E9. (cross-tenant) el estado de un telefono de B consultado con la organizacion A es null (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (citas.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000c1101', '+5219981110004') is null)::int as estado_cruzado_nulo_deberia_ser_1;
rollback;

-- ============================================================================
-- (F) grants e integracion con el productor de notificaciones
-- ============================================================================

\echo '=== F1. (causa raiz) anon no tiene NINGUN privilegio sobre las tablas ni EXECUTE sobre las funciones nuevas (deberia_ser_1) ==='
begin;
select (not has_table_privilege('anon', 'citas.conversation_handoff', 'select')
        and not has_table_privilege('anon', 'citas.conversation_note', 'select')
        and not has_function_privilege('anon', 'citas.handoff_tomar(uuid, uuid, uuid)', 'execute')
        and not has_function_privilege('anon', 'citas.bandeja_conversaciones(uuid, uuid, text, integer, integer)', 'execute')
        and not has_function_privilege('anon', 'citas.handoff_responder(uuid, uuid, uuid, text)', 'execute')
        and not has_function_privilege('anon', 'citas.handoff_solicitar_whatsapp(uuid, text, text, boolean)', 'execute')
        and not has_function_privilege('anon', 'citas.handoff_whatsapp_estado(uuid, text)', 'execute'))::int as anon_sin_privilegios_deberia_ser_1;
rollback;

\echo '=== F2. (causa raiz) authenticated solo tiene SELECT en las tablas (sin DML) y el helper interno no es ejecutable por nadie (deberia_ser_1) ==='
begin;
select (has_table_privilege('authenticated', 'citas.conversation_handoff', 'select')
        and not has_table_privilege('authenticated', 'citas.conversation_handoff', 'insert')
        and not has_table_privilege('authenticated', 'citas.conversation_handoff', 'update')
        and not has_table_privilege('authenticated', 'citas.conversation_handoff', 'delete')
        and not has_table_privilege('authenticated', 'citas.conversation_note', 'insert')
        and not has_function_privilege('authenticated', 'citas.handoff_conversacion_valida(uuid, uuid, uuid)', 'execute')
        and not has_function_privilege('service_role', 'citas.handoff_conversacion_valida(uuid, uuid, uuid)', 'execute'))::int as authenticated_solo_lectura_deberia_ser_1;
rollback;

\echo '=== F3. (notificaciones) citas.conversacion.handoff llega al owner Y al staff de A (roles [staff]) con {orgSlug} resuelto, y jamas al owner de B (deberia_ser_1) ==='
begin;
select core.emit_notification('00000000-0000-0000-0000-0000000c1101', null, 'citas.conversacion.handoff', 'agentes', 'atencion', 'Un cliente necesita a una persona en WhatsApp', 'El agente derivó una conversación: tómala desde Conversaciones.', '/citas/{orgSlug}/conversaciones', 'conversation_handoff', '00000000-0000-0000-0000-0000000c1161', 'citas.conversacion.handoff:00000000-0000-0000-0000-0000000c1161', array['staff'], interval '3 days');
select (count(*) filter (where staff_user_id in ('00000000-0000-0000-0000-0000000c1111', '00000000-0000-0000-0000-0000000c1112') and enlace = '/citas/org-citas-c11-a/conversaciones') = 2
        and count(*) filter (where staff_user_id = '00000000-0000-0000-0000-0000000c1114') = 0)::int as handoff_a_owner_y_staff_de_a_deberia_ser_1
  from core.notification where tipo = 'citas.conversacion.handoff';
rollback;

\echo '=== F4. (idempotencia) emitir dos veces la misma clave inserta una sola fila por destinatario (deberia_ser_1) ==='
begin;
select core.emit_notification('00000000-0000-0000-0000-0000000c1101', null, 'citas.conversacion.handoff', 'agentes', 'atencion', 'Un cliente necesita a una persona en WhatsApp', 'El agente derivó una conversación: tómala desde Conversaciones.', '/citas/{orgSlug}/conversaciones', 'conversation_handoff', '00000000-0000-0000-0000-0000000c1161', 'citas.conversacion.handoff:00000000-0000-0000-0000-0000000c1161', array['staff'], interval '3 days');
select core.emit_notification('00000000-0000-0000-0000-0000000c1101', null, 'citas.conversacion.handoff', 'agentes', 'atencion', 'Un cliente necesita a una persona en WhatsApp', 'El agente derivó una conversación: tómala desde Conversaciones.', '/citas/{orgSlug}/conversaciones', 'conversation_handoff', '00000000-0000-0000-0000-0000000c1161', 'citas.conversacion.handoff:00000000-0000-0000-0000-0000000c1161', array['staff'], interval '3 days');
select (count(*) = 1)::int as una_fila_por_clave_deberia_ser_1 from core.notification where tipo = 'citas.conversacion.handoff' and staff_user_id = '00000000-0000-0000-0000-0000000c1112';
rollback;

\echo '=== fin: ningun escenario debe haber lanzado BLOQUEANTE; los *_deberia_ser_N deben coincidir con N ==='
