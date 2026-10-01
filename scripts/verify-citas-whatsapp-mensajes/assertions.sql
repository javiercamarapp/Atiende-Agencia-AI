-- Verificación contra Postgres REAL de C-04 (citas): mensajes de WhatsApp editables (migración 026).
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; una columna que termina en
-- `_deberia_ser_N` debe valer N; los bloques `do $$` lanzan una excepción BLOQUEANTE si el resultado no es el esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000c1', 'citas', 'Org mensajes (A)', 'org-mensajes-a'),
  ('00000000-0000-0000-0000-0000000000c2', 'citas', 'Org mensajes (B, cross-tenant)', 'org-mensajes-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000c3', 'owner-msg@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c4', 'admin-msg@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c5', 'staff-msg@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000000c6', 'owner-b-msg@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000000c3', '00000000-0000-0000-0000-0000000000c1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000000c4', '00000000-0000-0000-0000-0000000000c1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000000c5', '00000000-0000-0000-0000-0000000000c1', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000000c6', '00000000-0000-0000-0000-0000000000c2', null, 'owner', 'owner')
on conflict do nothing;

\echo '=== 1. (positivo) owner guarda: version 1, luego admin guarda: version 2 (deberia_ser_1 cada una) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select (citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado',
  '{"reminderText":"Hola {{nombre}}, te esperamos a las {{hora}}","reminderLeadHours":12,"sendWindowStart":9,"sendWindowEnd":20}'::jsonb) = 1)::int as owner_guarda_version_1_deberia_ser_1;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c4', true);
select (citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 1, 'actualizado',
  '{"confirmationEnabled":true,"confirmationText":"Listo {{nombre}}","reminderLeadHours":24}'::jsonb) = 2)::int as admin_guarda_version_2_deberia_ser_1;
select (reminder_lead_hours = 24 and confirmation_enabled and version = 2 and updated_by = '00000000-0000-0000-0000-0000000000c4')::int as fila_vigente_es_la_ultima_deberia_ser_1
  from citas.whatsapp_message_config where organization_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '=== 1b. (positivo) el historial guarda anterior/nuevo y el actor real (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{"reminderLeadHours":12}'::jsonb) is not null as ok1;
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 1, 'actualizado', '{"reminderLeadHours":6}'::jsonb) is not null as ok2;
select (count(*) = 2
  and bool_and(actor_id = '00000000-0000-0000-0000-0000000000c3')
  and bool_or(version = 2 and (anterior->>'reminderLeadHours')::int = 12 and (nuevo->>'reminderLeadHours')::int = 6)
  and bool_or(version = 1 and anterior is null))::int as historial_completo_deberia_ser_1
  from citas.whatsapp_message_config_history where organization_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '=== 2. (negativo, SQLSTATE exacto) staff sin rol de gestion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba 42501 (staff) pero el guardado tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 2b. (cross-tenant, SQLSTATE exacto) owner de B intenta guardar en A -> 42501 y A sigue sin fila (deberia_ser_0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c6', true);
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba 42501 (otra organizacion) pero el guardado tuvo exito';
exception when sqlstate '42501' then null;
end $$;
reset role;
select count(*) as sin_fila_en_a_deberia_ser_0 from citas.whatsapp_message_config where organization_id = '00000000-0000-0000-0000-0000000000c1';
rollback;

\echo '=== 2c. (negativo, SQLSTATE exacto) sesion de sistema (auth.uid() nulo) no guarda -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba 42501 (sin usuario) pero el guardado tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 2d. (anon) sin GRANT execute y la llamada da 42501 exacto ==='
begin;
select (not has_function_privilege('anon', 'citas.save_whatsapp_message_config(uuid, integer, text, jsonb)', 'execute')
  and not has_function_privilege('anon', 'citas.whatsapp_message_config_system(uuid)', 'execute')
  and not has_function_privilege('anon', 'citas.whatsapp_message_config_history_list(uuid, integer)', 'execute'))::int as anon_sin_execute_deberia_ser_1;
rollback;
begin;
set local role anon;
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba 42501 (anon) pero el guardado tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 3. (conflicto, SQLSTATE exacto) version esperada vieja -> AT409; primera escritura con version distinta de 0 -> AT409 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb) as v1;
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{"reminderLeadHours":5}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba AT409 (ya existe la fila) pero el guardado tuvo exito';
exception when sqlstate 'AT409' then null;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 7, 'actualizado', '{}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba AT409 (version esperada 7 sin fila) pero el guardado tuvo exito';
exception when sqlstate 'AT409' then null;
end $$;
rollback;

\echo '=== 4. (restablecer) deja los valores de fabrica y agrega historial restablecido (deberia_ser_1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado',
  '{"reminderText":"X {{hora}}","reminderLeadHours":3,"cancellationEnabled":true,"cancellationText":"Y","sendWindowStart":8,"sendWindowEnd":18}'::jsonb) as v1;
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 1, 'restablecido', '{"reminderLeadHours":99}'::jsonb) as v2;
select (reminder_text is null and reminder_lead_hours = 24 and reminder_enabled and not cancellation_enabled and cancellation_text is null
  and send_window_start is null and send_window_end is null and version = 2)::int as valores_de_fabrica_deberia_ser_1
  from citas.whatsapp_message_config where organization_id = '00000000-0000-0000-0000-0000000000c1';
select count(*) as historial_restablecido_deberia_ser_1 from citas.whatsapp_message_config_history
  where organization_id = '00000000-0000-0000-0000-0000000000c1' and version = 2 and accion = 'restablecido';
rollback;

\echo '=== 5. (CHECK, SQLSTATE exacto) largo > 600, anticipacion fuera de rango y ventana invertida -> 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', jsonb_build_object('reminderText', repeat('a', 601)));
  raise exception 'BLOQUEANTE: se esperaba 23514 (texto largo) pero el guardado tuvo exito';
exception when sqlstate '23514' then null;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{"reminderLeadHours":73}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba 23514 (anticipacion 73) pero el guardado tuvo exito';
exception when sqlstate '23514' then null;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  perform citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{"sendWindowStart":20,"sendWindowEnd":9}'::jsonb);
  raise exception 'BLOQUEANTE: se esperaba 23514 (ventana invertida) pero el guardado tuvo exito';
exception when sqlstate '23514' then null;
end $$;
rollback;

\echo '=== 6. (lectura) owner ve su fila e historial (deberia_ser_1); staff, otra organizacion y anon ven 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{"reminderLeadHours":10}'::jsonb) as v1;
select count(*) as owner_ve_su_fila_deberia_ser_1 from citas.whatsapp_message_config where organization_id = '00000000-0000-0000-0000-0000000000c1';
select count(*) as owner_ve_su_historial_deberia_ser_1 from citas.whatsapp_message_config_history where organization_id = '00000000-0000-0000-0000-0000000000c1';
select count(*) as owner_lista_historial_con_nombre_deberia_ser_1 from citas.whatsapp_message_config_history_list('00000000-0000-0000-0000-0000000000c1', 10) where actor_nombre = 'Owner A';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
select count(*) as staff_ve_fila_deberia_ser_0 from citas.whatsapp_message_config;
select count(*) as staff_ve_historial_deberia_ser_0 from citas.whatsapp_message_config_history;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c6', true);
select count(*) as otra_org_ve_fila_deberia_ser_0 from citas.whatsapp_message_config;
select count(*) as otra_org_ve_historial_deberia_ser_0 from citas.whatsapp_message_config_history;
rollback;

begin;
select (not has_table_privilege('anon', 'citas.whatsapp_message_config', 'select') and not has_table_privilege('anon', 'citas.whatsapp_message_config_history', 'select'))::int as anon_sin_select_deberia_ser_1;
rollback;

\echo '=== 6b. (negativo, SQLSTATE exacto) staff y otra organizacion no listan el historial por funcion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c5', true);
do $$
begin
  perform * from citas.whatsapp_message_config_history_list('00000000-0000-0000-0000-0000000000c1', 10);
  raise exception 'BLOQUEANTE: se esperaba 42501 (staff) pero la lista tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c6', true);
do $$
begin
  perform * from citas.whatsapp_message_config_history_list('00000000-0000-0000-0000-0000000000c1', 10);
  raise exception 'BLOQUEANTE: se esperaba 42501 (otra organizacion) pero la lista tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 7. (sin escritura directa, SQLSTATE exacto) ni el owner puede insertar/actualizar/borrar las tablas -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  insert into citas.whatsapp_message_config (organization_id) values ('00000000-0000-0000-0000-0000000000c1');
  raise exception 'BLOQUEANTE: se esperaba 42501 (insert directo) pero tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  insert into citas.whatsapp_message_config_history (organization_id, version, accion, nuevo, actor_id)
    values ('00000000-0000-0000-0000-0000000000c1', 1, 'actualizado', '{}'::jsonb, '00000000-0000-0000-0000-0000000000c3');
  raise exception 'BLOQUEANTE: se esperaba 42501 (insert directo al historial) pero tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb) as v1;
do $$
begin
  update citas.whatsapp_message_config set reminder_lead_hours = 1 where organization_id = '00000000-0000-0000-0000-0000000000c1';
  raise exception 'BLOQUEANTE: se esperaba 42501 (update directo) pero tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb) as v1;
do $$
begin
  delete from citas.whatsapp_message_config_history where organization_id = '00000000-0000-0000-0000-0000000000c1';
  raise exception 'BLOQUEANTE: se esperaba 42501 (delete directo del historial) pero tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 7b. (append-only, SQLSTATE exacto) ni el dueno de la tabla reescribe ni borra el historial -> 0A000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{}'::jsonb) as v1;
reset role;
do $$
begin
  update citas.whatsapp_message_config_history set accion = 'restablecido' where organization_id = '00000000-0000-0000-0000-0000000000c1';
  raise exception 'BLOQUEANTE: se esperaba 0A000 (update) pero tuvo exito';
exception when sqlstate '0A000' then null;
end $$;
do $$
begin
  delete from citas.whatsapp_message_config_history where organization_id = '00000000-0000-0000-0000-0000000000c1';
  raise exception 'BLOQUEANTE: se esperaba 0A000 (delete) pero tuvo exito';
exception when sqlstate '0A000' then null;
end $$;
rollback;

\echo '=== 8. (solo-sistema) con auth.uid() nulo devuelve la configuracion de ESA organizacion (deberia_ser_1); un usuario real -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
select citas.save_whatsapp_message_config('00000000-0000-0000-0000-0000000000c1', 0, 'actualizado', '{"reminderLeadHours":8,"sendWindowStart":9,"sendWindowEnd":21}'::jsonb) as v1;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_lee_su_org_deberia_ser_1 from citas.whatsapp_message_config_system('00000000-0000-0000-0000-0000000000c1')
  where reminder_lead_hours = 8 and send_window_start = 9 and send_window_end = 21;
select count(*) as sistema_org_sin_fila_deberia_ser_0 from citas.whatsapp_message_config_system('00000000-0000-0000-0000-0000000000c2');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000c3', true);
do $$
begin
  perform * from citas.whatsapp_message_config_system('00000000-0000-0000-0000-0000000000c1');
  raise exception 'BLOQUEANTE: se esperaba 42501 (usuario real en la funcion de sistema) pero tuvo exito';
exception when sqlstate '42501' then null;
end $$;
rollback;

\echo '=== 9. (esquema a medias) sin la funcion el SQLSTATE es 42883, el que captura runWithSavepointFallback ==='
begin;
drop function citas.whatsapp_message_config_system(uuid);
do $$
begin
  perform * from citas.whatsapp_message_config_system('00000000-0000-0000-0000-0000000000c1');
  raise exception 'BLOQUEANTE: se esperaba 42883 (funcion inexistente) pero tuvo exito';
exception when sqlstate '42883' then null;
end $$;
rollback;
