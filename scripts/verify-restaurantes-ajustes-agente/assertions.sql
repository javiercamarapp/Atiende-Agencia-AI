-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/055_ajustes_agente_modelo_voz_fondo.sql
-- (ajustes del agente por organizacion: modelo y temperatura de WhatsApp, cascada y habla de voz, sonido de fondo).
--
--   A. Lectura: owner/admin de la organizacion y la sesion de SISTEMA (auth.uid() NULL: webhook y servicio de llamadas) ven la fila; staff y repartidor no;
--      otra organizacion (cross-tenant) no; anon no tiene ni SELECT.
--   B. Escritura: solo owner/admin de SU organizacion (insert/upsert y update); staff, repartidor, otra organizacion y anon rechazados; `updated_by` debe ser
--      quien escribe (sin suplantacion); GRANT por columna (organization_id no cambia; sin DELETE).
--   C. CHECK por columna: formato del id de modelo, temperatura 0..1, ritmo/estilo de listas cerradas, volumen del fondo 0..20; valores por omision (fondo apagado).
--   D. Base SIN migrar: la tabla eliminada dentro de la transaccion da 42P01 y un SAVEPOINT real la recupera (lo que hace runWithSavepointFallback).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe terminar en ERROR;
-- `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0a01', 'restaurantes', 'Ajustes Org A', 'ajustes-org-a'),
  ('00000000-0000-0000-0000-0000000d0a02', 'restaurantes', 'Ajustes Org B', 'ajustes-org-b'),
  ('00000000-0000-0000-0000-0000000d0a03', 'restaurantes', 'Ajustes Org C (sin ajustes)', 'ajustes-org-c')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0c01', 'ajustes-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0c02', 'ajustes-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0c03', 'ajustes-staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0c04', 'ajustes-repartidor-a@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0c05', 'ajustes-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0c01', '00000000-0000-0000-0000-0000000d0a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0c02', '00000000-0000-0000-0000-0000000d0a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000d0c03', '00000000-0000-0000-0000-0000000d0a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000d0c04', '00000000-0000-0000-0000-0000000d0a01', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000d0c05', '00000000-0000-0000-0000-0000000d0a02', null, 'owner', 'owner')
on conflict do nothing;

-- Ajustes vigentes de la Org A (fixture directa, superusuario).
insert into restaurantes.agent_runtime_settings (organization_id, whatsapp_model, whatsapp_temperature, voice_pace, voice_style, voice_background, voice_background_volume, updated_by)
values ('00000000-0000-0000-0000-0000000d0a01', 'google/gemini-2.5-flash-lite', 0.30, 'pausado', 'calido', true, 10, '00000000-0000-0000-0000-0000000d0c01')
on conflict do nothing;

\echo ''
\echo '=== A) Lectura ==='
\echo ''

\echo '--- 1. owner de la Org A lee los ajustes de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.agent_runtime_settings where organization_id = '00000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '--- 2. admin de la Org A tambien los lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c02', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.agent_runtime_settings;
rollback;

\echo '--- 3. sesion de SISTEMA (auth.uid() NULL: webhook de WhatsApp / servicio de llamadas) los lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.agent_runtime_settings where organization_id = '00000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '--- 4. staff de la Org A (no owner/admin) NO los lee (RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.agent_runtime_settings;
rollback;

\echo '--- 5. repartidor de la Org A NO los lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c04', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.agent_runtime_settings;
rollback;

\echo '--- 6. owner de la Org B NO ve los ajustes de la Org A (cross-tenant, RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c05', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.agent_runtime_settings where organization_id = '00000000-0000-0000-0000-0000000d0a01';
rollback;

\echo '--- 7. anon no tiene ni SELECT: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.agent_runtime_settings;
rollback;

\echo ''
\echo '=== B) Escritura ==='
\echo ''

\echo '--- 8. owner de la Org A hace upsert de sus ajustes (insert ... on conflict do update) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
with up as (
  insert into restaurantes.agent_runtime_settings (organization_id, whatsapp_model, whatsapp_temperature, voice_cascade_model, voice_temperature, voice_pace, voice_style, voice_background, voice_background_volume, updated_by, updated_at)
  values ('00000000-0000-0000-0000-0000000d0a01', 'deepseek/deepseek-v4.1-flash', 0.50, 'google/gemini-3.8-flash', 0.40, 'agil', 'animado', false, 5, '00000000-0000-0000-0000-0000000d0c01', now())
  on conflict (organization_id) do update set
    whatsapp_model = excluded.whatsapp_model, whatsapp_temperature = excluded.whatsapp_temperature, voice_cascade_model = excluded.voice_cascade_model,
    voice_temperature = excluded.voice_temperature, voice_pace = excluded.voice_pace, voice_style = excluded.voice_style,
    voice_background = excluded.voice_background, voice_background_volume = excluded.voice_background_volume,
    updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning whatsapp_model
)
select count(*) as upsert_owner_deberia_ser_1 from up;
rollback;

\echo '--- 9. admin de la Org A actualiza los ajustes ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c02', true);
with u as (
  update restaurantes.agent_runtime_settings set voice_pace = 'normal', updated_by = '00000000-0000-0000-0000-0000000d0c02', updated_at = now()
  where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1
)
select count(*) as update_admin_deberia_ser_1 from u;
rollback;

\echo '--- 10. staff de la Org A intenta actualizar: 0 filas (RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
with u as (
  update restaurantes.agent_runtime_settings set voice_pace = 'agil', updated_by = '00000000-0000-0000-0000-0000000d0c03'
  where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1
)
select count(*) as update_staff_deberia_ser_0 from u;
rollback;

\echo '--- 11. repartidor de la Org A intenta actualizar: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c04', true);
with u as (
  update restaurantes.agent_runtime_settings set voice_pace = 'agil', updated_by = '00000000-0000-0000-0000-0000000d0c04'
  where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1
)
select count(*) as update_repartidor_deberia_ser_0 from u;
rollback;

\echo '--- 12. owner de la Org B intenta actualizar los ajustes de la Org A (cross-tenant): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c05', true);
with u as (
  update restaurantes.agent_runtime_settings set voice_pace = 'agil', updated_by = '00000000-0000-0000-0000-0000000d0c05'
  where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1
)
select count(*) as update_cross_tenant_deberia_ser_0 from u;
rollback;

\echo '--- 13. owner de la Org B inserta ajustes para la Org C (donde no es owner): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c05', true);
insert into restaurantes.agent_runtime_settings (organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000d0a03', '00000000-0000-0000-0000-0000000d0c05') returning 1 as should_fail;
rollback;

\echo '--- 14. staff de la Org A inserta ajustes para una organizacion nueva (Org C): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c03', true);
insert into restaurantes.agent_runtime_settings (organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000d0a03', '00000000-0000-0000-0000-0000000d0c03') returning 1 as should_fail;
rollback;

\echo '--- 15. owner de la Org A escribe `updated_by` a nombre de OTRO usuario (suplantacion): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set voice_pace = 'normal', updated_by = '00000000-0000-0000-0000-0000000d0c02'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 16. owner de la Org A intenta mover la fila a otra organizacion (organization_id no tiene GRANT de UPDATE): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set organization_id = '00000000-0000-0000-0000-0000000d0a02', updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 17. owner de la Org A intenta BORRAR (sin GRANT de DELETE): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
delete from restaurantes.agent_runtime_settings where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 18. sesion de sistema (auth.uid() NULL) NO puede escribir: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into restaurantes.agent_runtime_settings (organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000d0a03', '00000000-0000-0000-0000-0000000d0c01') returning 1 as should_fail;
rollback;

\echo '--- 19. anon no puede escribir: RECHAZADO ---'
begin;
set local role anon;
insert into restaurantes.agent_runtime_settings (organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000d0a03', '00000000-0000-0000-0000-0000000d0c01') returning 1 as should_fail;
rollback;

\echo ''
\echo '=== C) CHECK por columna y valores por omision ==='
\echo ''

\echo '--- 20. id de modelo con formato invalido (mayusculas y espacios): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set whatsapp_model = 'EVIL MODEL', updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 21. id de modelo sin autor ("modelo-suelto"): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set voice_cascade_model = 'modelo-suelto', updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 22. temperatura fuera de 0..1: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set voice_temperature = 1.50, updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 23. ritmo de habla fuera de la lista: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set voice_pace = 'rapidisimo', updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 24. estilo de habla fuera de la lista: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set voice_style = 'gritado', updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 25. volumen del fondo mayor al tope de 20: RECHAZADO (el fondo nunca tapa la voz) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set voice_background_volume = 21, updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 26. volumen del fondo negativo: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c01', true);
update restaurantes.agent_runtime_settings set voice_background_volume = -1, updated_by = '00000000-0000-0000-0000-0000000d0c01'
where organization_id = '00000000-0000-0000-0000-0000000d0a01' returning 1 as should_fail;
rollback;

\echo '--- 27. una organizacion nueva nace con los valores por omision: sin modelo propio, fondo APAGADO, ritmo normal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0c05', true);
with ins as (
  insert into restaurantes.agent_runtime_settings (organization_id, updated_by)
  values ('00000000-0000-0000-0000-0000000d0a02', '00000000-0000-0000-0000-0000000d0c05')
  returning whatsapp_model, voice_background, voice_pace, voice_style, voice_background_volume
)
select (count(*) = 1 and bool_and(whatsapp_model is null and voice_background = false and voice_pace = 'normal' and voice_style = 'neutro' and voice_background_volume = 8))::int as omision_deberia_ser_1 from ins;
rollback;

\echo ''
\echo '=== D) base SIN migrar: 42P01 recuperado con SAVEPOINT real ==='
\echo ''

\echo '--- 28. sin la tabla (42P01) un SAVEPOINT + ROLLBACK TO SAVEPOINT deja la transaccion usable (lo que hace runWithSavepointFallback) ---'
begin;
drop table restaurantes.agent_runtime_settings;
savepoint sp_verify_ajustes_agente;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from restaurantes.agent_runtime_settings;
    raise exception 'se esperaba SQLSTATE 42P01 y la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_ajustes_agente;
release savepoint sp_verify_ajustes_agente;
select 1 as siguiente_consulta_del_request_deberia_ser_1;
rollback;

\echo '--- 29. SIN el SAVEPOINT, el mismo 42P01 deja la transaccion abortada (25P02): la razon del helper ---'
begin;
drop table restaurantes.agent_runtime_settings;
select 1 from restaurantes.agent_runtime_settings;
select 1 as should_fail;
rollback;
