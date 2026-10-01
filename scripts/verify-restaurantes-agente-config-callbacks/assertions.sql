-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna + funciones definer reales -- nunca el repositorio
-- en memoria) de packages/domain-restaurantes/migrations/033_agente_config_historial_y_callbacks_estado.sql:
--   PARTE A: columnas nuevas de restaurantes.whatsapp_agent_config + restaurantes.whatsapp_agent_config_history.
--   PARTE B: estado/asignacion de restaurantes.callback_requests + callback_actualizar / callbacks_sucursal_estado.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. Un escenario "RECHAZADO" termina en ERROR real de
-- Postgres (alias `as should_fail` en la sentencia que debe fallar); uno de conteo termina en `..._deberia_ser_N`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0001', 'restaurantes', 'CB Org A', 'cb-cfg-a'),
  ('00000000-0000-0000-0000-0000000e0002', 'restaurantes', 'CB Org B (ajena)', 'cb-cfg-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e00a2', '00000000-0000-0000-0000-0000000e0001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e00a1', '00000000-0000-0000-0000-0000000e0001', 'a1'),
  ('00000000-0000-0000-0000-0000000e00a2', '00000000-0000-0000-0000-0000000e0001', 'a2'),
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0011', 'owner-a@cbcfg.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0012', 'admin-a@cbcfg.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0013', 'staff-a@cbcfg.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0014', 'owner-b@cbcfg.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000e0015', 'staff-a2@cbcfg.example.com', 'Staff solo A2', 'seed'),
  ('00000000-0000-0000-0000-0000000e0016', 'staff-a-bis@cbcfg.example.com', 'Staff A bis', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0011', '00000000-0000-0000-0000-0000000e0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e0012', '00000000-0000-0000-0000-0000000e0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e0013', '00000000-0000-0000-0000-0000000e0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e0014', '00000000-0000-0000-0000-0000000e0002', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e0015', '00000000-0000-0000-0000-0000000e0001', array['00000000-0000-0000-0000-0000000e00a2']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e0016', '00000000-0000-0000-0000-0000000e0001', null, 'member', 'staff')
on conflict do nothing;

-- Datos previos (como superusuario): config de la organizacion A (v1) con su historial, y 4 callbacks.
insert into restaurantes.whatsapp_agent_config (organization_id, property_id, perfil, agent_name, delivery_time_text) values
  ('00000000-0000-0000-0000-0000000e0001', null, 'taqueria_pm', 'Lupita', 'de 40 a 50 minutos');
insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, anterior, nuevo, actor_id) values
  ('00000000-0000-0000-0000-0000000e0001', null, 1, 'actualizado', null, '{"agentName":"Lupita"}'::jsonb, '00000000-0000-0000-0000-0000000e0011');
insert into restaurantes.callback_requests (id, organization_id, property_id, customer_name, customer_phone, reason, source) values
  ('00000000-0000-0000-0000-0000000e0c01', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Cliente 1', '+5219990000001', 'escalada:queja', 'voice'),
  ('00000000-0000-0000-0000-0000000e0c02', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a2', 'Cliente 2', '+5219990000002', null, 'whatsapp'),
  ('00000000-0000-0000-0000-0000000e0c03', '00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e00b1', 'Cliente B', '+5219990000003', null, 'voice');
insert into restaurantes.callback_requests (id, organization_id, property_id, customer_name, customer_phone, resolved, source) values
  ('00000000-0000-0000-0000-0000000e0c04', '00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', 'Cliente historico', '+5219990000004', true, 'voice');

\echo '=== A1. POSITIVO: el upsert EXACTO del repositorio (organizacion, con columnas nuevas y version esperada 1) como owner de A actualiza y sube la version a 2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.whatsapp_agent_config as c (organization_id, property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, enabled, version, updated_at)
values ('00000000-0000-0000-0000-0000000e0001', null, 'taqueria_pm', 'Lupe', null, 'formal_directo', 'de 45 a 55 minutos', 'Hola, bienvenido', 'roja y verde', 'martes de nachos', array['pedido_grande']::text[], true, 1, now())
on conflict (organization_id) where property_id is null do update set
  perfil = excluded.perfil, agent_name = excluded.agent_name, business_name = excluded.business_name, tone_style = excluded.tone_style,
  delivery_time_text = excluded.delivery_time_text, greeting_text = excluded.greeting_text, salsas_text = excluded.salsas_text,
  promos_text = excluded.promos_text, escalation_reasons_off = excluded.escalation_reasons_off, enabled = true,
  version = c.version + 1, updated_at = excluded.updated_at
  where 1::int is null or c.version = 1::int
returning version;
insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, anterior, nuevo, actor_id)
values ('00000000-0000-0000-0000-0000000e0001', null, 2, 'actualizado', '{"agentName":"Lupita"}'::jsonb, '{"agentName":"Lupe"}'::jsonb, '00000000-0000-0000-0000-0000000e0011')
returning version;
rollback;

\echo '=== A2. CONCURRENCIA: con una version esperada vieja (0) el upsert no actualiza ninguna fila (el codigo lo devuelve como 409) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
with r as (
  insert into restaurantes.whatsapp_agent_config as c (organization_id, property_id, perfil, enabled, version, updated_at)
  values ('00000000-0000-0000-0000-0000000e0001', null, 'taqueria_pm', true, 1, now())
  on conflict (organization_id) where property_id is null do update set perfil = excluded.perfil, version = c.version + 1, updated_at = excluded.updated_at
    where 0::int is null or c.version = 0::int
  returning 1
)
select count(*)::int as filas_actualizadas_con_version_vieja_deberia_ser_0 from r;
rollback;

\echo '=== A3. RECHAZADO: staff de A no escribe historial ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, nuevo, actor_id)
values ('00000000-0000-0000-0000-0000000e0001', null, 9, 'actualizado', '{}'::jsonb, '00000000-0000-0000-0000-0000000e0013') returning version as should_fail;
rollback;

\echo '=== A4. RECHAZADO: el historial es append-only, owner no hace UPDATE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
update restaurantes.whatsapp_agent_config_history set accion = 'restablecido' where organization_id = '00000000-0000-0000-0000-0000000e0001' returning id as should_fail;
rollback;

\echo '=== A5. RECHAZADO: el historial es append-only, owner no hace DELETE ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
delete from restaurantes.whatsapp_agent_config_history where organization_id = '00000000-0000-0000-0000-0000000e0001' returning id as should_fail;
rollback;

\echo '=== A6. RECHAZADO: anon no lee el historial ==='
begin;
set local role anon;
select count(*) as should_fail from restaurantes.whatsapp_agent_config_history;
rollback;

\echo '=== A7. RECHAZADO (cross-tenant): owner de B no escribe historial de la organizacion A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, nuevo, actor_id)
values ('00000000-0000-0000-0000-0000000e0001', null, 9, 'actualizado', '{}'::jsonb, '00000000-0000-0000-0000-0000000e0014') returning version as should_fail;
rollback;

\echo '=== A8. RECHAZADO: owner de A no firma un cambio como otro usuario (actor_id distinto de auth.uid()) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, nuevo, actor_id)
values ('00000000-0000-0000-0000-0000000e0001', null, 9, 'actualizado', '{}'::jsonb, '00000000-0000-0000-0000-0000000e0012') returning version as should_fail;
rollback;

\echo '=== A9. RECHAZADO: sucursal de otra organizacion en el historial de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, nuevo, actor_id)
values ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00b1', 1, 'actualizado', '{}'::jsonb, '00000000-0000-0000-0000-0000000e0011') returning version as should_fail;
rollback;

\echo '=== A10. LECTURA: admin de A ve el historial de su organizacion (1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0012', true);
select count(*)::int as historial_visible_para_admin_deberia_ser_1 from restaurantes.whatsapp_agent_config_history;
rollback;

\echo '=== A11. LECTURA: staff de A (no owner/admin) no ve el historial ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as historial_visible_para_staff_deberia_ser_0 from restaurantes.whatsapp_agent_config_history;
rollback;

\echo '=== A12. LECTURA: owner de B no ve el historial de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as historial_ajeno_visible_deberia_ser_0 from restaurantes.whatsapp_agent_config_history;
rollback;

\echo '=== A13. RECHAZADO: un motivo de seguridad (queja) no se puede desactivar ==='
begin;
update restaurantes.whatsapp_agent_config set escalation_reasons_off = array['queja']::text[] where organization_id = '00000000-0000-0000-0000-0000000e0001' returning id as should_fail;
rollback;

\echo '=== A14. RECHAZADO: saludo de mas de 80 caracteres ==='
begin;
update restaurantes.whatsapp_agent_config set greeting_text = repeat('x', 81) where organization_id = '00000000-0000-0000-0000-0000000e0001' returning id as should_fail;
rollback;

\echo '=== A15. RECHAZADO: dos historiales con la misma version para la misma organizacion ==='
begin;
insert into restaurantes.whatsapp_agent_config_history (organization_id, property_id, version, accion, nuevo, actor_id)
values ('00000000-0000-0000-0000-0000000e0001', null, 1, 'actualizado', '{}'::jsonb, '00000000-0000-0000-0000-0000000e0011') returning version as should_fail;
rollback;

\echo '=== A16. RLS: staff de A no edita las columnas nuevas de la config ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
with r as (
  update restaurantes.whatsapp_agent_config set greeting_text = 'hola' where organization_id = '00000000-0000-0000-0000-0000000e0001' returning 1
)
select count(*)::int as filas_editadas_por_staff_deberia_ser_0 from r;
rollback;

-- ===================== PARTE B: callbacks con estado / asignacion =====================
-- Estado inicial de los 4 callbacks: c01 (A1, nuevo), c02 (A2, nuevo), c03 (B1, nuevo), c04 (A1, resuelto historico).

\echo '=== B1. BACKFILL/TRIGGER: el callback historico (resolved = true) quedo en status resuelto y los demas en nuevo ==='
begin;
select (
  (select status from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c04') = 'resuelto'
  and (select count(*) from restaurantes.callback_requests where status = 'nuevo') = 3
)::int as backfill_coherente_deberia_ser_1;
rollback;

\echo '=== B2. TRIGGER: un escritor historico que solo cambia resolved = true deja status resuelto y resolved_at ==='
begin;
update restaurantes.callback_requests set resolved = true where id = '00000000-0000-0000-0000-0000000e0c01';
select (status = 'resuelto' and resolved_at is not null)::int as trigger_traduce_resolved_deberia_ser_1 from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c01';
rollback;

\echo '=== B3. POSITIVO: staff de A toma c01 -> en_curso, asignado a el ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'tomar', null, null);
select (status = 'en_curso' and assigned_to = '00000000-0000-0000-0000-0000000e0013' and taken_at is not null)::int as tomado_deberia_ser_1
  from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c01';
rollback;

\echo '=== B4. RECHAZADO: otro staff no pisa un callback ya tomado (55006) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'tomar', null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0016', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'tomar', null, null) as should_fail;
rollback;

\echo '=== B5. POSITIVO: owner de A asigna c01 al staff valido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'asignar', '00000000-0000-0000-0000-0000000e0013', null);
select (status = 'en_curso' and assigned_to = '00000000-0000-0000-0000-0000000e0013')::int as asignado_deberia_ser_1
  from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c01';
rollback;

\echo '=== B6. RECHAZADO: staff (no owner/admin) no asigna ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'asignar', '00000000-0000-0000-0000-0000000e0016', null) as should_fail;
rollback;

\echo '=== B7. RECHAZADO (cross-tenant): asignar a un usuario de OTRA organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'asignar', '00000000-0000-0000-0000-0000000e0014', null) as should_fail;
rollback;

\echo '=== B8. RECHAZADO: asignar a alguien sin acceso a la sucursal del callback (staff solo de A2 sobre c01 de A1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'asignar', '00000000-0000-0000-0000-0000000e0015', null) as should_fail;
rollback;

\echo '=== B9. RECHAZADO (cross-tenant): owner de A actua sobre el callback de B declarando su propia organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c03', 'tomar', null, null) as should_fail;
rollback;

\echo '=== B10. RECHAZADO (cross-tenant): owner de A actua sobre el callback de B declarando la organizacion B ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0002', '00000000-0000-0000-0000-0000000e0c03', 'tomar', null, null) as should_fail;
rollback;

\echo '=== B11. RECHAZADO: staff solo de A2 no toca un callback de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0015', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'tomar', null, null) as should_fail;
rollback;

\echo '=== B12. POSITIVO: resolver con nota deja status resuelto, resolved = true, resolved_by y nota ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'resolver', null, '  Se le devolvio la llamada  ');
select (status = 'resuelto' and resolved and resolved_by = '00000000-0000-0000-0000-0000000e0013' and resolution_note = 'Se le devolvio la llamada' and resolved_at is not null)::int as resuelto_deberia_ser_1
  from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c01';
rollback;

\echo '=== B13. RECHAZADO: resolver uno ya resuelto (55000) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c04', 'resolver', null, null) as should_fail;
rollback;

\echo '=== B14. RECHAZADO: staff no reabre ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c04', 'reabrir', null, null) as should_fail;
rollback;

\echo '=== B15. POSITIVO: owner reabre el historico y vuelve a nuevo (resolved = false, sin resolved_at) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c04', 'reabrir', null, null);
select (status = 'nuevo' and not resolved and resolved_at is null)::int as reabierto_deberia_ser_1
  from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c04';
rollback;

\echo '=== B16. RECHAZADO: liberar el callback de otra persona sin ser owner/admin ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'tomar', null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0016', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'liberar', null, null) as should_fail;
rollback;

\echo '=== B17. RECHAZADO: accion invalida ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'borrar', null, null) as should_fail;
rollback;

\echo '=== B18. RECHAZADO: anon no ejecuta callback_actualizar ==='
begin;
set local role anon;
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'tomar', null, null) as should_fail;
rollback;

\echo '=== B19. RECHAZADO: sesion de sistema (sin auth.uid()) no ejecuta callback_actualizar ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.callback_actualizar('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'tomar', null, null) as should_fail;
rollback;

\echo '=== B20. RECHAZADO: ni siquiera owner hace UPDATE directo sobre callback_requests (solo funciones definer) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0011', true);
update restaurantes.callback_requests set status = 'resuelto' where id = '00000000-0000-0000-0000-0000000e0c01' returning id as should_fail;
rollback;

\echo '=== B21. LECTURA: la bandeja con estado de A1 (staff de A, solo abiertos) devuelve c01 (A1) y nada de la org B (c02 es de A2 y no aparece: 1 fila) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select count(*)::int as abiertos_de_a1_deberia_ser_1 from restaurantes.callbacks_sucursal_estado('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', true, 50);
rollback;

\echo '=== B22. RECHAZADO: staff solo de A2 no lee la bandeja de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0015', true);
select count(*) as should_fail from restaurantes.callbacks_sucursal_estado('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', true, 50);
rollback;

\echo '=== B23. RECHAZADO (cross-tenant): owner de B no lee la bandeja de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*) as should_fail from restaurantes.callbacks_sucursal_estado('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', true, 50);
rollback;

\echo '=== B24. INTEGRACION con 028: registrar un intento "no_contesto" mueve nuevo -> en_curso y asigna a quien intento ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'no_contesto', null, null);
select (status = 'en_curso' and assigned_to = '00000000-0000-0000-0000-0000000e0013')::int as intento_mueve_a_en_curso_deberia_ser_1
  from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c01';
rollback;

\echo '=== B25. INTEGRACION con 028: un intento "contactado" deja el callback resuelto (resolved = true) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
select restaurantes.callback_registrar_intento('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e0c01', 'contactado', null, null);
select (status = 'resuelto' and resolved and resolved_by = '00000000-0000-0000-0000-0000000e0013')::int as intento_contactado_resuelve_deberia_ser_1
  from restaurantes.callback_requests where id = '00000000-0000-0000-0000-0000000e0c01';
rollback;

\echo ''
\echo '=== B26. base SIN la migracion 033 (drop transaccional): el SQL real del lector falla con 42883 y SAVEPOINT + ROLLBACK TO SAVEPOINT recupera la transaccion ==='
begin;
drop function restaurantes.callbacks_sucursal_estado(uuid, uuid, boolean, integer);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0013', true);
savepoint sp_verify_callbacks_estado_read;
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.callbacks_sucursal_estado('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-0000000e00a1', true, 50);
    raise exception 'se esperaba 42883';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_callbacks_estado_read;
release savepoint sp_verify_callbacks_estado_read;
select 1 as transaccion_recuperada_tras_42883_deberia_ser_1;
rollback;

\echo '=== B27. base SIN las columnas nuevas de whatsapp_agent_config (drop transaccional de greeting_text): el SELECT con columnas nuevas falla con 42703 y SAVEPOINT recupera; el SELECT legacy sigue funcionando ==='
begin;
alter table restaurantes.whatsapp_agent_config drop column greeting_text;
savepoint sp_verify_agent_config_read;
do $$
declare
  v_state text;
begin
  begin
    perform property_id, perfil, agent_name, business_name, tone_style, delivery_time_text, greeting_text, salsas_text, promos_text, escalation_reasons_off, version
      from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000e0001' and enabled = true;
    raise exception 'se esperaba 42703';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_agent_config_read;
release savepoint sp_verify_agent_config_read;
select count(*)::int as lector_legacy_funciona_tras_42703_deberia_ser_1
  from (select property_id, perfil, agent_name, business_name, tone_style, delivery_time_text from restaurantes.whatsapp_agent_config where organization_id = '00000000-0000-0000-0000-0000000e0001' and enabled = true) q;
rollback;

\echo ''
\echo 'Fin de las verificaciones de 033.'
