-- Verificacion contra Postgres REAL de PL-31/PL-32, migracion 0048
-- (packages/db/migrations/0048_whatsapp_plantillas_y_opt_out.sql):
--
--   (A) core.whatsapp_plantilla (catalogo por organizacion): RLS solo owner/admin de SU organizacion, GRANT a nivel columna,
--       CHECKs, marcas de tiempo por estado. Positivo, rol member, otro tenant, anon.
--   (B) core.whatsapp_plantilla_resolver / core.whatsapp_plantilla_aprobada: solo-sistema; devuelven unicamente la plantilla
--       APROBADA de la organizacion pedida (cross-tenant), y 42501 para staff y anon.
--   (C) core.opt_out_registrar / opt_out_reactivar / opt_out_activo: baja idempotente, alta, aislamiento por organizacion,
--       solo-sistema (42501 staff/anon), telefono invalido 22023 y tabla cerrada a lectura directa.
--   (D) citas.ultimo_mensaje_entrante: marca de tiempo de la ultima entrada por organizacion; solo-sistema.
--
-- Cada escenario va en su propio begin; ... rollback; (el gate run-gate.mjs los ejecuta como conexiones independientes).

-- ============================================================================
-- Fixtures (se confirman fuera de los escenarios).
-- ============================================================================
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e3101', 'citas', 'Org PL31 (A)', 'org-pl31-a'),
  ('00000000-0000-0000-0000-0000000e3102', 'citas', 'Org PL31 (B, cross-tenant)', 'org-pl31-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e3111', 'owner-a-pl31@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e3112', 'member-a-pl31@example.com', 'Member A', 'seed'),
  ('00000000-0000-0000-0000-0000000e3113', 'owner-b-pl31@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e3111', '00000000-0000-0000-0000-0000000e3101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e3112', '00000000-0000-0000-0000-0000000e3101', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e3113', '00000000-0000-0000-0000-0000000e3102', null, 'owner', 'owner')
on conflict do nothing;

-- A tiene una plantilla aprobada y una en borrador; B tiene una aprobada con OTRO nombre para el mismo evento.
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, idioma, variables, estado) values
  ('00000000-0000-0000-0000-0000000e3101', 'citas', 'appointment.reminder_24h', 'recordatorio_cita_a', 'es_MX', array['nombre', 'fecha', 'hora'], 'aprobada'),
  ('00000000-0000-0000-0000-0000000e3101', 'citas', 'waitlist.slot_offered', 'hueco_lista_espera_a', 'es_MX', array['nombre'], 'borrador'),
  ('00000000-0000-0000-0000-0000000e3102', 'citas', 'appointment.reminder_24h', 'recordatorio_cita_b', 'es_MX', array['nombre', 'hora'], 'aprobada')
on conflict do nothing;

-- Una entrada de WhatsApp de A hace 2 h.
insert into citas.whatsapp_inbound_events (message_id, organization_id, phone_hash, status, claimed_at) values
  ('wamid.pl31.a1', '00000000-0000-0000-0000-0000000e3101', repeat('a', 64), 'processed', now() - interval '2 hours')
on conflict do nothing;

-- ============================================================================
-- (A) core.whatsapp_plantilla
-- ============================================================================

\echo '=== A1. (positivo) el owner de A ve SOLO las 2 plantillas de A (deberia_ser_2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select count(*)::int as plantillas_visibles_owner_a_deberia_ser_2 from core.whatsapp_plantilla;
rollback;

\echo '=== A2. (positivo) el owner de A da de alta una plantilla con su organizacion y su autor real (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, variables, estado, creado_por)
values ('00000000-0000-0000-0000-0000000e3101', 'citas', 'waitlist.slot_available_broadcast', 'hueco_difusion_a', array['nombre'], 'borrador', '00000000-0000-0000-0000-0000000e3111');
select count(*)::int as alta_propia_deberia_ser_1 from core.whatsapp_plantilla where nombre = 'hueco_difusion_a';
rollback;

\echo '=== A3. (negativo) un MEMBER de A no ve ninguna plantilla (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3112', true);
select count(*)::int as plantillas_visibles_member_deberia_ser_0 from core.whatsapp_plantilla;
rollback;

\echo '=== A4. (negativo cross-tenant) el owner de B solo ve la plantilla de B, nunca las de A (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3113', true);
select count(*)::int as plantillas_de_a_visibles_para_b_deberia_ser_0 from core.whatsapp_plantilla where organization_id = '00000000-0000-0000-0000-0000000e3101';
rollback;

\echo '=== A5. (negativo cross-tenant, SQLSTATE exacto) el owner de B no puede insertar una plantilla en la organizacion A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3113', true);
do $$
begin
  insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, creado_por)
  values ('00000000-0000-0000-0000-0000000e3101', 'citas', 'evento.intruso', 'plantilla_intrusa', '00000000-0000-0000-0000-0000000e3113');
  raise exception 'BLOQUEANTE: se esperaba 42501 al insertar en la organizacion de otro tenant pero tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A6. (negativo cross-tenant) el owner de B no actualiza la plantilla de A: 0 filas afectadas y la fila de A intacta (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3113', true);
update core.whatsapp_plantilla set estado = 'rechazada' where organization_id = '00000000-0000-0000-0000-0000000e3101';
reset role;
select (estado = 'aprobada')::int as plantilla_de_a_intacta_deberia_ser_1 from core.whatsapp_plantilla where nombre = 'recordatorio_cita_a';
rollback;

\echo '=== A7. (negativo, SQLSTATE exacto) GRANT por columna: mover una plantilla a otra organizacion con UPDATE: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
do $$
begin
  update core.whatsapp_plantilla set organization_id = '00000000-0000-0000-0000-0000000e3102' where nombre = 'recordatorio_cita_a';
  raise exception 'BLOQUEANTE: se esperaba 42501 al cambiar organization_id pero el UPDATE tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A8. (negativo, SQLSTATE exacto) anon no lee la tabla: 42501 ==='
begin;
set local role anon;
do $$
begin
  perform count(*) from core.whatsapp_plantilla;
  raise exception 'BLOQUEANTE: se esperaba 42501 para anon pero la lectura tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== A9. (CHECK, SQLSTATE exacto) un nombre de plantilla con mayusculas o espacios se rechaza: 23514 ==='
begin;
do $$
begin
  insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre) values ('00000000-0000-0000-0000-0000000e3101', 'citas', 'evento.malo', 'Nombre Con Espacios');
  raise exception 'BLOQUEANTE: se esperaba 23514 pero el INSERT tuvo exito';
exception
  when sqlstate '23514' then null;
end $$;
rollback;

\echo '=== A10. (CHECK, SQLSTATE exacto) una variable con mayusculas o mas de 10 variables se rechaza: 23514 ==='
begin;
do $$
begin
  insert into core.whatsapp_plantilla (organization_id, vertical, evento, nombre, variables) values ('00000000-0000-0000-0000-0000000e3101', 'citas', 'evento.malo2', 'nombre_ok', array['Nombre']);
  raise exception 'BLOQUEANTE: se esperaba 23514 pero el INSERT tuvo exito';
exception
  when sqlstate '23514' then null;
end $$;
rollback;

\echo '=== A11. (marcas) pasar a aprobada pone aprobada_en; volver a rechazada la quita (deberia_ser_1) ==='
begin;
update core.whatsapp_plantilla set estado = 'aprobada' where nombre = 'hueco_lista_espera_a';
update core.whatsapp_plantilla set estado = 'rechazada' where nombre = 'recordatorio_cita_a';
select ((select aprobada_en is not null from core.whatsapp_plantilla where nombre = 'hueco_lista_espera_a') and (select aprobada_en is null from core.whatsapp_plantilla where nombre = 'recordatorio_cita_a'))::int as marcas_de_estado_deberia_ser_1;
rollback;

-- ============================================================================
-- (B) resolver / aprobada (solo-sistema)
-- ============================================================================

\echo '=== B1. (positivo, sistema) resolver devuelve la plantilla APROBADA de A con sus variables en orden (deberia_ser_1) ==='
begin;
set local role authenticated;
select (nombre = 'recordatorio_cita_a' and idioma = 'es_MX' and variables = array['nombre', 'fecha', 'hora'])::int as resolver_a_deberia_ser_1
  from core.whatsapp_plantilla_resolver('00000000-0000-0000-0000-0000000e3101', 'appointment.reminder_24h');
rollback;

\echo '=== B2. (cross-tenant, sistema) resolver para B devuelve la plantilla de B, nunca la de A (deberia_ser_1) ==='
begin;
set local role authenticated;
select (nombre = 'recordatorio_cita_b')::int as resolver_b_deberia_ser_1
  from core.whatsapp_plantilla_resolver('00000000-0000-0000-0000-0000000e3102', 'appointment.reminder_24h');
rollback;

\echo '=== B3. (negativo, sistema) una plantilla en borrador NO se resuelve (deberia_ser_0) ==='
begin;
set local role authenticated;
select count(*)::int as borrador_no_se_resuelve_deberia_ser_0 from core.whatsapp_plantilla_resolver('00000000-0000-0000-0000-0000000e3101', 'waitlist.slot_offered');
rollback;

\echo '=== B4. (negativo, sistema) B no obtiene nada de un evento que solo A tiene aprobado (deberia_ser_0) ==='
begin;
set local role authenticated;
select count(*)::int as evento_de_a_para_b_deberia_ser_0 from core.whatsapp_plantilla_resolver('00000000-0000-0000-0000-0000000e3102', 'waitlist.slot_offered');
rollback;

\echo '=== B5. (negativo, SQLSTATE exacto) un STAFF con auth.uid() real no puede resolver plantillas: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
do $$
begin
  perform * from core.whatsapp_plantilla_resolver('00000000-0000-0000-0000-0000000e3101', 'appointment.reminder_24h');
  raise exception 'BLOQUEANTE: se esperaba 42501 para una sesion de staff pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== B6. (negativo, SQLSTATE exacto) anon no ejecuta el resolver: 42501 ==='
begin;
set local role anon;
do $$
begin
  perform * from core.whatsapp_plantilla_resolver('00000000-0000-0000-0000-0000000e3101', 'appointment.reminder_24h');
  raise exception 'BLOQUEANTE: se esperaba 42501 para anon pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== B7. (positivo y cross-tenant, sistema) aprobada(A, nombre de A) es true y aprobada(B, nombre de A) es false (deberia_ser_1) ==='
begin;
set local role authenticated;
select (core.whatsapp_plantilla_aprobada('00000000-0000-0000-0000-0000000e3101', 'recordatorio_cita_a') and not core.whatsapp_plantilla_aprobada('00000000-0000-0000-0000-0000000e3102', 'recordatorio_cita_a') and not core.whatsapp_plantilla_aprobada('00000000-0000-0000-0000-0000000e3101', 'hueco_lista_espera_a'))::int as aprobada_por_organizacion_deberia_ser_1;
rollback;

\echo '=== B8. (negativo, SQLSTATE exacto) un STAFF no ejecuta whatsapp_plantilla_aprobada: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3113', true);
do $$
begin
  perform core.whatsapp_plantilla_aprobada('00000000-0000-0000-0000-0000000e3102', 'recordatorio_cita_b');
  raise exception 'BLOQUEANTE: se esperaba 42501 para una sesion de staff pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

-- ============================================================================
-- (C) opt-out por organizacion
-- ============================================================================

\echo '=== C1. (positivo, sistema) la baja es nueva la primera vez e idempotente la segunda (deberia_ser_1) ==='
begin;
set local role authenticated;
select (core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp', 'whatsapp.citas') and not core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp', 'whatsapp.citas'))::int as baja_idempotente_deberia_ser_1;
rollback;

\echo '=== C2. (cross-tenant, sistema) la baja de A NO afecta a B (deberia_ser_1) ==='
begin;
set local role authenticated;
select core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp', 'whatsapp.citas');
select (core.opt_out_activo('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp') and not core.opt_out_activo('00000000-0000-0000-0000-0000000e3102', '+5219981110001', 'whatsapp') and not core.opt_out_activo('00000000-0000-0000-0000-0000000e3101', '+5219981110002', 'whatsapp'))::int as baja_aislada_por_organizacion_deberia_ser_1;
rollback;

\echo '=== C3. (positivo, sistema) ALTA: quita la baja y vuelve a ser contactable (deberia_ser_1) ==='
begin;
set local role authenticated;
select core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp', 'whatsapp.citas');
select core.opt_out_reactivar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp') as alta_quito_la_baja;
select (not core.opt_out_activo('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp') and not core.opt_out_reactivar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp'))::int as alta_reactiva_deberia_ser_1;
rollback;

\echo '=== C4. (cross-tenant, sistema) la ALTA de B no borra la baja de A (deberia_ser_1) ==='
begin;
set local role authenticated;
select core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp', 'whatsapp.citas');
select core.opt_out_reactivar('00000000-0000-0000-0000-0000000e3102', '+5219981110001', 'whatsapp');
select core.opt_out_activo('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp')::int as baja_de_a_sigue_deberia_ser_1;
rollback;

\echo '=== C5. (negativo, SQLSTATE exacto) un STAFF no registra bajas: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
do $$
begin
  perform core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp', 'whatsapp.citas');
  raise exception 'BLOQUEANTE: se esperaba 42501 para una sesion de staff pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C6. (negativo, SQLSTATE exacto) un STAFF no consulta ni borra bajas: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
do $$
begin
  perform core.opt_out_activo('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp');
  raise exception 'BLOQUEANTE: se esperaba 42501 en opt_out_activo para staff pero tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
do $$
begin
  perform core.opt_out_reactivar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp');
  raise exception 'BLOQUEANTE: se esperaba 42501 en opt_out_reactivar para staff pero tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C7. (negativo, SQLSTATE exacto) la tabla de bajas esta cerrada a lectura directa para authenticated: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
do $$
begin
  perform count(*) from core.messaging_opt_out;
  raise exception 'BLOQUEANTE: se esperaba 42501 al leer core.messaging_opt_out pero tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C8. (negativo, SQLSTATE exacto) anon no ejecuta las funciones de opt-out: 42501 ==='
begin;
set local role anon;
do $$
begin
  perform core.opt_out_activo('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp');
  raise exception 'BLOQUEANTE: se esperaba 42501 para anon pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== C9. (validacion, SQLSTATE exacto) un telefono que no es E.164 normalizado se rechaza: 22023 ==='
begin;
set local role authenticated;
do $$
begin
  perform core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '998 111 0001', 'whatsapp', 'whatsapp.citas');
  raise exception 'BLOQUEANTE: se esperaba 22023 para un telefono sin normalizar pero tuvo exito';
exception
  when sqlstate '22023' then null;
end $$;
rollback;

\echo '=== C10. (validacion, SQLSTATE exacto) un canal desconocido se rechaza: 22023 ==='
begin;
set local role authenticated;
do $$
begin
  perform core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'sms', 'whatsapp.citas');
  raise exception 'BLOQUEANTE: se esperaba 22023 para un canal desconocido pero tuvo exito';
exception
  when sqlstate '22023' then null;
end $$;
rollback;

\echo '=== C11. (privacidad) la tabla guarda solo el hash: ninguna columna contiene el telefono en claro (deberia_ser_1) ==='
begin;
set local role authenticated;
select core.opt_out_registrar('00000000-0000-0000-0000-0000000e3101', '+5219981110001', 'whatsapp', 'whatsapp.citas');
reset role;
select (count(*) = 1 and bool_and(telefono_hash ~ '^[0-9a-f]{64}$') and bool_and(row(o.*)::text not like '%5219981110001%'))::int as solo_hash_guardado_deberia_ser_1 from core.messaging_opt_out o;
rollback;

-- ============================================================================
-- (D) citas.ultimo_mensaje_entrante
-- ============================================================================

\echo '=== D1. (positivo, sistema) devuelve la marca de la ultima entrada de A (hace unas 2 h) (deberia_ser_1) ==='
begin;
set local role authenticated;
select (citas.ultimo_mensaje_entrante('00000000-0000-0000-0000-0000000e3101', array[repeat('b', 64), repeat('a', 64)]) between now() - interval '3 hours' and now() - interval '1 hour')::int as ultima_entrada_de_a_deberia_ser_1;
rollback;

\echo '=== D2. (cross-tenant, sistema) para B el mismo telefono no tiene entradas: null (deberia_ser_1) ==='
begin;
set local role authenticated;
select (citas.ultimo_mensaje_entrante('00000000-0000-0000-0000-0000000e3102', array[repeat('a', 64)]) is null)::int as sin_entradas_en_b_deberia_ser_1;
rollback;

\echo '=== D3. (negativo, SQLSTATE exacto) un STAFF no ejecuta ultimo_mensaje_entrante: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
do $$
begin
  perform citas.ultimo_mensaje_entrante('00000000-0000-0000-0000-0000000e3101', array[repeat('a', 64)]);
  raise exception 'BLOQUEANTE: se esperaba 42501 para una sesion de staff pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== D4. (validacion, SQLSTATE exacto) un hash mal formado se rechaza: 22023 ==='
begin;
set local role authenticated;
do $$
begin
  perform citas.ultimo_mensaje_entrante('00000000-0000-0000-0000-0000000e3101', array['no-es-un-hash']);
  raise exception 'BLOQUEANTE: se esperaba 22023 para un hash invalido pero tuvo exito';
exception
  when sqlstate '22023' then null;
end $$;
rollback;

\echo '=== D5. (negativo, SQLSTATE exacto) anon no ejecuta ultimo_mensaje_entrante: 42501 ==='
begin;
set local role anon;
do $$
begin
  perform citas.ultimo_mensaje_entrante('00000000-0000-0000-0000-0000000e3101', array[repeat('a', 64)]);
  raise exception 'BLOQUEANTE: se esperaba 42501 para anon pero la llamada tuvo exito';
exception
  when sqlstate '42501' then null;
end $$;
rollback;
