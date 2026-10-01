-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna + funciones definer reales --
-- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/027_conversaciones_handoff_turnos.sql:
--
--   A. Turnos (branch_shift / branch_shift_member): positivo, rol insuficiente, cross-tenant,
--      alcance por sucursal (property_ids), GRANT por columna, FK compuesta, CHECK, anon.
--   B. Handoff (tomar / devolver / cerrar): positivo, toma concurrente (55006), idempotencia, rol,
--      cross-tenant, otra sucursal, DML directo denegado, anon, indice de una sola toma abierta.
--   C. Notas internas: autor fijado por la base, otra sucursal, cross-tenant, lectura por sucursal.
--   D. Respuesta humana por WhatsApp: solo quien tiene la toma, encola en el outbox.
--   E. Funciones de solo-sistema (solicitar / estado del agente): idempotencia, staff rechazado.
--   F. Bandeja unificada y lectura de transcripcion de voz solo para quien tomo la conversacion.
--   G. Callbacks: intento, resolucion, sucursal nula, cross-tenant.
--   H. Base SIN migrar: el SQL real que emite el repositorio falla con 42P01/42883 y el
--      SAVEPOINT/ROLLBACK TO SAVEPOINT recupera la transaccion.
--
-- Los rechazos se afirman con un bloque DO que exige el SQLSTATE EXACTO (un error por otra causa
-- hace fallar el escenario: no hay "falsos verdes" por un fallo distinto al esperado).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0001', 'restaurantes', 'Handoff Org A', 'handoff-org-a'),
  ('00000000-0000-0000-0000-0000000e0002', 'restaurantes', 'Handoff Org B (ajena)', 'handoff-org-b')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e00a2', '00000000-0000-0000-0000-0000000e0001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'Sucursal B1')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'ha1'), ('00000000-0000-0000-0000-0000000e00a2', '00000000-0000-0000-0000-0000000e0001', 'ha2'), ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'hb1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0011', 'owner-a@handoff.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0012', 'admin-a@handoff.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0013', 'staff-a1@handoff.example.com', 'Staff A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e0014', 'staff-a2@handoff.example.com', 'Staff A2', 'seed'),
  ('00000000-0000-0000-0000-0000000e0015', 'staff-a1b@handoff.example.com', 'Staff A1 bis', 'seed'),
  ('00000000-0000-0000-0000-0000000e0016', 'repartidor-a@handoff.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0017', 'owner-b@handoff.example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0011', '00000000-0000-0000-0000-0000000e0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e0012', '00000000-0000-0000-0000-0000000e0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e0013', '00000000-0000-0000-0000-0000000e0001', array['00000000-0000-0000-0000-0000000e00a1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e0014', '00000000-0000-0000-0000-0000000e0001', array['00000000-0000-0000-0000-0000000e00a2']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e0015', '00000000-0000-0000-0000-0000000e0001', array['00000000-0000-0000-0000-0000000e00a1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e0016', '00000000-0000-0000-0000-0000000e0001', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e0017', '00000000-0000-0000-0000-0000000e0002', null, 'owner', 'owner')
on conflict do nothing;
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id) values ('pnid-a1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1') on conflict do nothing;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages) values
  ('00000000-0000-0000-0000-0000000e00c1', '00000000-0000-0000-0000-0000000e0001', '5551000001', '00000000-0000-0000-0000-0000000e00a1', '[{"role":"user","content":"Hola, quiero tacos"}]'::jsonb),
  ('00000000-0000-0000-0000-0000000e00c2', '00000000-0000-0000-0000-0000000e0001', '5551000002', '00000000-0000-0000-0000-0000000e00a2', '[{"role":"user","content":"Hola A2"}]'::jsonb),
  ('00000000-0000-0000-0000-0000000e00c3', '00000000-0000-0000-0000-0000000e0001', '5551000003', null, '[{"role":"user","content":"Sin sucursal"}]'::jsonb),
  ('00000000-0000-0000-0000-0000000e00c4', '00000000-0000-0000-0000-0000000e0002', '5551000004', '00000000-0000-0000-0000-0000000e00b1', '[{"role":"user","content":"Org B"}]'::jsonb)
on conflict do nothing;
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, voice_id, started_at) values
  ('00000000-0000-0000-0000-0000000e00d1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'sala-h-1', 'llamada', 'gemini-3.8-live', 'Kore', now() - interval '5 minutes'),
  ('00000000-0000-0000-0000-0000000e00d2', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a2', 'sala-h-2', 'llamada', 'gemini-3.8-live', 'Kore', now() - interval '6 minutes')
on conflict do nothing;
insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto) values
  ('00000000-0000-0000-0000-0000000e00d1', '00000000-0000-0000-0000-0000000e0001', 0, 'cliente', 'Quiero hablar con una persona'),
  ('00000000-0000-0000-0000-0000000e00d1', '00000000-0000-0000-0000-0000000e0001', 1, 'agente', 'Con gusto, le comunico')
on conflict do nothing;
insert into restaurantes.callback_requests (id, organization_id, property_id, customer_name, customer_phone, reason, source) values
  ('00000000-0000-0000-0000-0000000e00e1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Cliente A1', '5552000001', 'queja', 'voice'),
  ('00000000-0000-0000-0000-0000000e00e2', '00000000-0000-0000-0000-0000000e0001', null, 'Cliente sin sucursal', '5552000002', 'facturacion', 'whatsapp'),
  ('00000000-0000-0000-0000-0000000e00e3', '00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00b1', 'Cliente B', '5552000003', 'queja', 'voice')
on conflict do nothing;
insert into restaurantes.branch_shift (id, organization_id, property_id, nombre, dias, inicia, termina) values
  ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Turno 1', array[0,1,2,3,4,5,6]::smallint[], '12:00', '18:30')
on conflict do nothing;

\echo '=== A1. POSITIVO: owner crea un turno en su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.branch_shift (organization_id, property_id, nombre, dias, inicia, termina) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Turno 2', array[1,2,3,4,5]::smallint[], '18:00', '01:00') returning nombre;
rollback;

\echo '=== A2. RECHAZADO: staff (rol staff) no crea turnos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
do $$ begin
  insert into restaurantes.branch_shift (organization_id, property_id, nombre, dias, inicia, termina) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Turno X', array[1]::smallint[], '10:00', '11:00');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A3. RECHAZADO: owner de B escribe un turno en una sucursal de A declarando SU organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  insert into restaurantes.branch_shift (organization_id, property_id, nombre, dias, inicia, termina) values ('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00a1', 'Turno X', array[1]::smallint[], '10:00', '11:00');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A4. RECHAZADO: owner de B declara la organizacion A (no es miembro) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  insert into restaurantes.branch_shift (organization_id, property_id, nombre, dias, inicia, termina) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Turno X', array[1]::smallint[], '10:00', '11:00');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A5. RECHAZADO: GRANT por columna, ni el owner mueve organization_id de un turno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  update restaurantes.branch_shift set organization_id = '00000000-0000-0000-0000-0000000e0002' where id = '00000000-0000-0000-0000-0000000e00f1';
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A6. RECHAZADO: GRANT por columna, ni el owner mueve property_id de un turno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  update restaurantes.branch_shift set property_id = '00000000-0000-0000-0000-0000000e00a2' where id = '00000000-0000-0000-0000-0000000e00f1';
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A7. POSITIVO: owner asigna a staff A1 como principal del turno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.branch_shift_member (shift_id, property_id, organization_id, user_id, orden) values ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0013', 1) returning user_id;
rollback;

\echo '=== A8. CROSS-TENANT: owner de A no asigna a un usuario de la organizacion B a su turno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.branch_shift_member (shift_id, property_id, organization_id, user_id, orden) values ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0017', 1);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A9. ALCANCE: no se asigna a un staff cuyo property_ids solo cubre A2 a un turno de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.branch_shift_member (shift_id, property_id, organization_id, user_id, orden) values ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0014', 1);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A10. RECHAZADO: el repartidor no puede ser miembro de turno de handoff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.branch_shift_member (shift_id, property_id, organization_id, user_id, orden) values ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0016', 1);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A11. RECHAZADO: staff (rol staff) no asigna miembros ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
do $$ begin
  insert into restaurantes.branch_shift_member (shift_id, property_id, organization_id, user_id, orden) values ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0015', 2);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A12. FK COMPUESTA: un miembro no apunta a un turno de A1 declarando la sucursal A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.branch_shift_member (shift_id, property_id, organization_id, user_id, orden) values ('00000000-0000-0000-0000-0000000e00f1', '00000000-0000-0000-0000-0000000e00a2', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0012', 1);
  raise exception 'DEBIO FALLAR con 23503';
exception when sqlstate '23503' then null; end $$;
rollback;

\echo '=== A13. CHECK: un turno con inicia = termina se rechaza ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.branch_shift (organization_id, property_id, nombre, dias, inicia, termina) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Turno raro', array[1]::smallint[], '10:00', '10:00');
  raise exception 'DEBIO FALLAR con 23514';
exception when sqlstate '23514' then null; end $$;
rollback;

\echo '=== A14. CHECK: dias fuera de 0..6 se rechazan ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.branch_shift (organization_id, property_id, nombre, dias, inicia, termina) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Turno dias', array[7]::smallint[], '10:00', '11:00');
  raise exception 'DEBIO FALLAR con 23514';
exception when sqlstate '23514' then null; end $$;
rollback;

\echo '=== A15. LECTURA: staff A1 ve el turno de su sucursal (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as turnos_visibles_staff_a1_deberia_ser_1 from restaurantes.branch_shift;
rollback;

\echo '=== A16. LECTURA: staff A2 NO ve los turnos de A1 (RLS por sucursal) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as turnos_a1_visibles_staff_a2_deberia_ser_0 from restaurantes.branch_shift where property_id = '00000000-0000-0000-0000-0000000e00a1';
rollback;

\echo '=== A17. LECTURA: el repartidor no ve turnos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0016', true);
select count(*)::int as turnos_visibles_repartidor_deberia_ser_0 from restaurantes.branch_shift;
rollback;

\echo '=== A18. CROSS-TENANT: owner de B no ve turnos de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
select count(*)::int as turnos_visibles_owner_b_deberia_ser_0 from restaurantes.branch_shift;
rollback;

\echo '=== A19. ANON: sin privilegio sobre branch_shift ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform 1 from restaurantes.branch_shift;
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== A20. CROSS-TENANT: owner de B no borra ni ve turnos de A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
with d as (delete from restaurantes.branch_shift where id = '00000000-0000-0000-0000-0000000e00f1' returning 1) select count(*)::int as borrados_cross_tenant_deberia_ser_0 from d;
rollback;

\echo '=== B1. POSITIVO: staff A1 toma la conversacion de WhatsApp de su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1') as handoff_id;
rollback;

\echo '=== B2. ESTADO: tras tomar, el handoff queda 'tomada' por el staff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
select count(*)::int as tomadas_deberia_ser_1 from restaurantes.conversation_handoff where estado = 'tomada' and tomada_por = '00000000-0000-0000-0000-0000000e0013';
rollback;

\echo '=== B3. IDEMPOTENTE: tomar dos veces devuelve el mismo handoff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1') = restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::int as mismo_handoff_deberia_ser_1;
rollback;

\echo '=== B4. CONCURRENCIA: un segundo staff no pisa la toma (55006) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0015', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
  raise exception 'DEBIO FALLAR con 55006';
exception when sqlstate '55006' then null; end $$;
rollback;

\echo '=== B5. ALCANCE: staff A2 no toma una conversacion de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B6. ALCANCE: staff A2 no toma una conversacion de A2 declarando la sucursal A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c2');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B7. CROSS-TENANT: owner de B no toma una conversacion de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B8. CROSS-TENANT: owner de B declarando su organizacion no toma la conversacion de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00b1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B9. CROSS-TENANT: owner de A no toma una conversacion de la organizacion B ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c4');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B10. ROL: el repartidor no toma conversaciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0016', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B11. ANON: sin EXECUTE sobre handoff_tomar ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B12. POSITIVO: una conversacion de WhatsApp sin sucursal la toma el staff de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c3') as handoff_id;
rollback;

\echo '=== B13. DML DIRECTO: authenticated no inserta en conversation_handoff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'tomada', 'staff');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B14. DML DIRECTO: authenticated no actualiza conversation_handoff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  update restaurantes.conversation_handoff set estado = 'cerrada';
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B15. POSITIVO: quien tomo la conversacion la devuelve al agente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_devolver('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid) as devuelta;
rollback;

\echo '=== B16. ROL: otro staff de la misma sucursal no devuelve una toma ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0015', true);
do $$ begin
  perform restaurantes.handoff_devolver('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B17. POSITIVO: un admin si puede devolver una toma ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0012', true);
select restaurantes.handoff_devolver('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid) as devuelta_por_admin;
rollback;

\echo '=== B18. POSITIVO: cerrar y volver a tomar crea una toma nueva ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_cerrar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid);
select (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1') <> current_setting('t.h')::uuid)::int as toma_nueva_deberia_ser_1;
rollback;

\echo '=== B19. CROSS-TENANT: owner de B no cierra un handoff de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  perform restaurantes.handoff_cerrar('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00b1', current_setting('t.h')::uuid);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== B20. INDICE: no hay dos tomas abiertas de la misma conversacion ==='
begin;
do $$ begin
  insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'pendiente', 'agente'), ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'pendiente', 'agente');
  raise exception 'DEBIO FALLAR con 23505';
exception when sqlstate '23505' then null; end $$;
rollback;

\echo '=== C1. POSITIVO: quien tomo agrega una nota; el autor lo fija la base ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_agregar_nota('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, 'Cliente pide factura') ;
select count(*)::int as notas_del_autor_deberia_ser_1 from restaurantes.conversation_note where autor_id = '00000000-0000-0000-0000-0000000e0013';
rollback;

\echo '=== C2. ALCANCE: staff A2 no agrega notas a un handoff de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
do $$ begin
  perform restaurantes.handoff_agregar_nota('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a2', current_setting('t.h')::uuid, 'x');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== C3. CROSS-TENANT: owner de B no agrega notas a un handoff de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  perform restaurantes.handoff_agregar_nota('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00b1', current_setting('t.h')::uuid, 'x');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== C4. DML DIRECTO: no se inserta una nota a nombre de otro ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.conversation_note (organization_id, property_id, handoff_id, autor_id, texto) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', gen_random_uuid(), '00000000-0000-0000-0000-0000000e0013', 'x');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== C5. CHECK: una nota vacia se rechaza ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
do $$ begin
  perform restaurantes.handoff_agregar_nota('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, '   ');
  raise exception 'DEBIO FALLAR con 23514';
exception when sqlstate '23514' then null; end $$;
rollback;

\echo '=== C6. LECTURA: staff A2 no ve las notas de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_agregar_nota('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, 'privada');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as notas_visibles_staff_a2_deberia_ser_0 from restaurantes.conversation_note;
rollback;

\echo '=== D1. POSITIVO: quien tomo responde por WhatsApp; se encola en el outbox con el numero de la sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_responder_whatsapp('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, 'Ya le atiendo, soy Ana');
reset role;
select count(*)::int as outbox_con_numero_de_sucursal_deberia_ser_1 from restaurantes.messaging_outbox where event_type = 'whatsapp.handoff_reply' and payload ->> 'phone_number_id' = 'pnid-a1' and payload ->> 'to' = '5551000001';
rollback;

\echo '=== D2. POSITIVO: la respuesta humana queda en el historial con autor humano ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_responder_whatsapp('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, 'Ya le atiendo');
reset role;
select count(*)::int as mensajes_humanos_deberia_ser_1 from restaurantes.whatsapp_conversations c, jsonb_array_elements(c.messages) m where c.id = '00000000-0000-0000-0000-0000000e00c1' and m ->> 'autor' = 'humano';
rollback;

\echo '=== D3. ROL: otro staff que no tomo la conversacion no responde ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0015', true);
do $$ begin
  perform restaurantes.handoff_responder_whatsapp('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, 'hola');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== D4. ROL: ni un admin responde una toma ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0012', true);
do $$ begin
  perform restaurantes.handoff_responder_whatsapp('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, 'hola');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== D5. ESTADO: devuelta al agente, el staff ya no responde ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_devolver('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid);
do $$ begin
  perform restaurantes.handoff_responder_whatsapp('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, 'hola');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== D6. CHECK: mensaje de mas de 1000 caracteres se rechaza ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
do $$ begin
  perform restaurantes.handoff_responder_whatsapp('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid, repeat('x', 1001));
  raise exception 'DEBIO FALLAR con 22023';
exception when sqlstate '22023' then null; end $$;
rollback;

\echo '=== D7. SIN NUMERO: una sucursal sin numero de WhatsApp configurado no encola (P0002) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a2', 'whatsapp', '00000000-0000-0000-0000-0000000e00c2'))::text, true);
do $$ begin
  perform restaurantes.handoff_responder_whatsapp('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a2', current_setting('t.h')::uuid, 'hola');
  raise exception 'DEBIO FALLAR con P0002';
exception when sqlstate 'P0002' then null; end $$;
rollback;

\echo '=== E1. POSITIVO: el sistema (sin usuario) solicita un humano para una conversacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'Cliente pide humano') as handoff_id;
rollback;

\echo '=== E2. IDEMPOTENTE: solicitar dos veces devuelve la misma toma abierta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'a') = restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'b'))::int as misma_toma_deberia_ser_1;
rollback;

\echo '=== E3. RECHAZADO: un staff autenticado no puede usar handoff_solicitar (solo sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
do $$ begin
  perform restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'x');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== E4. CROSS-TENANT: el sistema no solicita sobre una conversacion de otra organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c4', 'x');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== E5. ANON: sin EXECUTE sobre handoff_solicitar ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'x');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== E6. AGENTE CALLA: con una toma pendiente, el estado para el agente es 'pendiente' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'x');
select (restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0001', '5551000001') = 'pendiente')::int as agente_calla_deberia_ser_1;
rollback;

\echo '=== E7. AGENTE CALLA: con la toma tomada por un humano el estado es 'tomada' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0001', '5551000001') = 'tomada')::int as agente_calla_deberia_ser_1;
rollback;

\echo '=== E8. AGENTE RESPONDE: sin toma abierta el estado es nulo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0001', '5551000001') is null)::int as agente_responde_deberia_ser_1;
rollback;

\echo '=== E9. AGENTE RESPONDE: tras devolver, el estado vuelve a nulo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1'))::text, true);
select restaurantes.handoff_devolver('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0001', '5551000001') is null)::int as agente_responde_deberia_ser_1;
rollback;

\echo '=== E10. AISLAMIENTO: la toma de la organizacion A no hace callar al agente de la organizacion B (mismo telefono) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0002', '5551000001') is null)::int as agente_b_responde_deberia_ser_1;
rollback;

\echo '=== E11. RECHAZADO: un staff autenticado no consulta el estado del agente (solo sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
do $$ begin
  perform restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0001', '5551000001');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== E12. PING: la consulta del agente registra ultimo_cliente_at en la toma abierta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c1', 'x');
select restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0001', '5551000001');
reset role;
select count(*)::int as pings_registrados_deberia_ser_1 from restaurantes.conversation_handoff where conversation_id = '00000000-0000-0000-0000-0000000e00c1' and ultimo_cliente_at is not null;
rollback;

\echo '=== E13. VOZ: el sistema solicita un humano para una llamada de la sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'voz', '00000000-0000-0000-0000-0000000e00d1', 'Pidio hablar con una persona') as handoff_id;
rollback;

\echo '=== E14. CROSS-TENANT: una llamada de A2 no se solicita declarando la sucursal A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'voz', '00000000-0000-0000-0000-0000000e00d2', 'x');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== F1. BANDEJA: staff A1 ve WhatsApp de A1 + sin sucursal + llamada de A1 (3 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as filas_deberia_ser_3 from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, null, 25, 0);
rollback;

\echo '=== F2. BANDEJA: no incluye conversaciones de A2 ni de la organizacion B ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as ajenas_deberia_ser_0 from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, null, 25, 0) where conversation_id in ('00000000-0000-0000-0000-0000000e00c2', '00000000-0000-0000-0000-0000000e00c4', '00000000-0000-0000-0000-0000000e00d2');
rollback;

\echo '=== F3. ALCANCE: staff A2 no abre la bandeja de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
do $$ begin
  perform * from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, null, 25, 0);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== F4. CROSS-TENANT: owner de B no abre la bandeja de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  perform * from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, null, 25, 0);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== F5. ROL: el repartidor no abre la bandeja ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0016', true);
do $$ begin
  perform * from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, null, 25, 0);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== F6. ANON: sin EXECUTE sobre la bandeja ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform * from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, null, 25, 0);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== F7. ESTADOS: una toma pendiente aparece primero con estado 'pendiente' ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.handoff_solicitar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'whatsapp', '00000000-0000-0000-0000-0000000e00c3', 'x');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as pendientes_deberia_ser_1 from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'pendiente', null, 25, 0);
rollback;

\echo '=== F8. FILTRO POR CANAL: voz devuelve solo la llamada de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as llamadas_deberia_ser_1 from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, 'voz', 25, 0);
rollback;

\echo '=== F9. TRANSCRIPCION: el staff NO lee los turnos de voz antes de tomar la llamada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as turnos_antes_de_tomar_deberia_ser_0 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000e00d1';
rollback;

\echo '=== F10. TRANSCRIPCION: tras tomar la llamada el staff lee SUS 2 turnos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'voz', '00000000-0000-0000-0000-0000000e00d1');
select count(*)::int as turnos_tras_tomar_deberia_ser_2 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000e00d1';
rollback;

\echo '=== F11. TRANSCRIPCION: otro staff de A1 no lee la llamada que tomo un companero ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'voz', '00000000-0000-0000-0000-0000000e00d1');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0015', true);
select count(*)::int as turnos_de_llamada_ajena_deberia_ser_0 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000e00d1';
rollback;

\echo '=== F12. TRANSCRIPCION: devuelta la llamada, el staff pierde el acceso a la transcripcion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select set_config('t.h', (restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'voz', '00000000-0000-0000-0000-0000000e00d1'))::text, true);
select restaurantes.handoff_devolver('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', current_setting('t.h')::uuid);
select count(*)::int as turnos_tras_devolver_deberia_ser_0 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000e00d1';
rollback;

\echo '=== F13. TRANSCRIPCION: el owner (025) sigue leyendo los 2 turnos sin tomar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select count(*)::int as turnos_owner_deberia_ser_2 from restaurantes.voice_turn where conversation_id = '00000000-0000-0000-0000-0000000e00d1';
rollback;

\echo '=== F14. TRANSCRIPCION: una llamada de A2 tomada por staff A2 no se abre a staff A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select restaurantes.handoff_tomar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a2', 'voz', '00000000-0000-0000-0000-0000000e00d2');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as turnos_a2_visibles_staff_a1_deberia_ser_0 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000e00d2';
rollback;

\echo '=== G1. POSITIVO: staff A1 registra un intento sin contacto; el callback sigue abierto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e1', 'no_contesto', 'Sonaba ocupado', null);
reset role;
select count(*)::int as abiertos_deberia_ser_1 from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e00e1' and resolved = false;
rollback;

\echo '=== G2. POSITIVO: un intento 'contactado' resuelve el callback ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e1', 'contactado', 'Se resolvio', null);
reset role;
select count(*)::int as resueltos_deberia_ser_1 from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e00e1' and resolved = true;
rollback;

\echo '=== G3. ALCANCE: staff A2 no registra intentos en un callback de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
do $$ begin
  perform restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e1', 'buzon', null, null);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== G4. ALCANCE: un staff acotado a A1 no registra en un callback sin sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
do $$ begin
  perform restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e2', 'buzon', null, null);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== G5. POSITIVO: el owner (sin acotar) si registra en un callback sin sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e2', 'buzon', null, now() + interval '1 hour') as intento;
rollback;

\echo '=== G6. CROSS-TENANT: owner de B no registra intentos en un callback de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  perform restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e1', 'buzon', null, null);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== G7. CROSS-TENANT: owner de B declarando su organizacion no alcanza el callback de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0017', true);
do $$ begin
  perform restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00e1', 'buzon', null, null);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== G8. ANON: sin EXECUTE sobre callback_registrar_intento ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
do $$ begin
  perform restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e1', 'buzon', null, null);
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== G9. CHECK: un resultado fuera del catalogo se rechaza ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
do $$ begin
  perform restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e1', 'inventado', null, null);
  raise exception 'DEBIO FALLAR con 23514';
exception when sqlstate '23514' then null; end $$;
rollback;

\echo '=== G10. LECTURA: staff A2 no ve los intentos de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00e1', 'buzon', null, null);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as intentos_visibles_staff_a2_deberia_ser_0 from restaurantes.callback_attempt;
rollback;

\echo '=== G11. DML DIRECTO: authenticated no inserta intentos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
do $$ begin
  insert into restaurantes.callback_attempt (organization_id, property_id, callback_request_id, resultado) values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e00e1', 'buzon');
  raise exception 'DEBIO FALLAR con 42501';
exception when sqlstate '42501' then null; end $$;
rollback;

\echo '=== H1. BASE SIN MIGRAR: sin conversation_handoff el repositorio falla con 42P01 y el SAVEPOINT recupera la transaccion ==='
begin;
drop table restaurantes.conversation_note; drop table restaurantes.conversation_handoff cascade;
savepoint sp_verify_handoff;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from restaurantes.conversation_handoff where organization_id = '00000000-0000-0000-0000-0000000e0001';
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_handoff;
release savepoint sp_verify_handoff;
select count(*)::int as whatsapp_sigue_leyendo_deberia_ser_1 from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000e00c1';
rollback;

\echo '=== H2. BASE SIN MIGRAR: sin las funciones, el consulta-con-ping del agente falla con 42883 y el camino anterior sigue ==='
begin;
drop function restaurantes.handoff_whatsapp_estado(uuid, text);
savepoint sp_verify_handoff;
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.handoff_whatsapp_estado('00000000-0000-0000-0000-0000000e0001', '5551000001');
    raise exception 'se esperaba SQLSTATE 42883, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_handoff;
release savepoint sp_verify_handoff;
select count(*)::int as whatsapp_sigue_leyendo_deberia_ser_1 from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000e00c1';
rollback;

\echo '=== H3. BASE SIN MIGRAR: sin branch_shift la cobertura falla con 42P01 y la transaccion se recupera ==='
begin;
drop table restaurantes.branch_shift_member; drop table restaurantes.branch_shift cascade;
savepoint sp_verify_handoff;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from restaurantes.branch_shift where property_id = '00000000-0000-0000-0000-0000000e00a1';
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_handoff;
release savepoint sp_verify_handoff;
select count(*)::int as pedidos_o_conversaciones_siguen_deberia_ser_1 from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000e00c1';
rollback;

\echo '=== H4. BASE SIN MIGRAR: sin la bandeja el listado falla con 42883 ==='
begin;
drop function restaurantes.bandeja_conversaciones(uuid, uuid, text, text, integer, integer);
savepoint sp_verify_handoff;
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.bandeja_conversaciones('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', null, null, 25, 0);
    raise exception 'se esperaba SQLSTATE 42883, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_handoff;
release savepoint sp_verify_handoff;
select count(*)::int as whatsapp_sigue_leyendo_deberia_ser_1 from restaurantes.whatsapp_conversations where id = '00000000-0000-0000-0000-0000000e00c1';
rollback;

\echo 'Fin: cada escenario con "deberia_ser_N" debe devolver N; los que usan bloque DO afirman el SQLSTATE exacto (si el escenario falla, el gate lo marca).'
