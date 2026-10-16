-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/087_ajustes_agente_ambiente_tecleo_humano.sql
-- (extiende restaurantes.agent_runtime_settings con el preset de ambiente, el tecleo y el interruptor de naturalidad).
--
--   A. Valores por omision: una organizacion nueva nace SIN tecleo ni naturalidad y con el preset de siempre (el comportamiento anterior no cambia).
--   B. Escritura: owner/admin de SU organizacion guardan las columnas nuevas; staff, otra organizacion y anon rechazados (RLS/GRANT de la 055 siguen vigentes).
--   C. CHECK: preset de ambiente fuera de la lista, volumen de tecleo fuera de 0..25 y volumen de fondo > 20 mueren en la base.
--   D. Lectura: la sesion de SISTEMA (servicio de llamadas) lee las columnas nuevas; anon no.
--   E. Base SIN la migracion nueva: leer una columna inexistente da 42703 y un SAVEPOINT real lo recupera (lo que hace runWithSavepointFallback).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe terminar en ERROR;
-- `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0b01', 'restaurantes', 'Ambiente Org A', 'ambiente-org-a'),
  ('00000000-0000-0000-0000-0000000d0b02', 'restaurantes', 'Ambiente Org B', 'ambiente-org-b')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d0e01', 'ambiente-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0e02', 'ambiente-staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000d0e03', 'ambiente-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000d0e01', '00000000-0000-0000-0000-0000000d0b01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000d0e02', '00000000-0000-0000-0000-0000000d0b01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000d0e03', '00000000-0000-0000-0000-0000000d0b02', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.agent_runtime_settings (organization_id, updated_by)
values ('00000000-0000-0000-0000-0000000d0b01', '00000000-0000-0000-0000-0000000d0e01')
on conflict do nothing;

\echo ''
\echo '=== A) Valores por omision ==='
\echo ''

\echo '--- 1. una fila existente nace sin tecleo ni naturalidad (comportamiento anterior intacto) ---'
begin;
select count(*) as sin_tecleo_ni_naturalidad_deberia_ser_1 from restaurantes.agent_runtime_settings
  where organization_id = '00000000-0000-0000-0000-0000000d0b01' and voice_typing = false and voice_humanize = false and voice_typing_volume = 12 and voice_background_preset = 'cocina-taqueria';
rollback;

\echo ''
\echo '=== B) Escritura ==='
\echo ''

\echo '--- 2. owner de la Org A guarda ambiente, tecleo y naturalidad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0e01', true);
with u as (
  update restaurantes.agent_runtime_settings
     set voice_background_preset = 'sala-tranquila', voice_typing = true, voice_typing_volume = 15, voice_humanize = true,
         updated_by = '00000000-0000-0000-0000-0000000d0e01', updated_at = now()
   where organization_id = '00000000-0000-0000-0000-0000000d0b01' returning 1
)
select count(*) as update_owner_deberia_ser_1 from u;
rollback;

\echo '--- 3. staff de la Org A (no owner/admin) NO puede guardar: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0e02', true);
with u as (
  update restaurantes.agent_runtime_settings set voice_typing = true, updated_by = '00000000-0000-0000-0000-0000000d0e02'
   where organization_id = '00000000-0000-0000-0000-0000000d0b01' returning 1
)
select count(*) as update_staff_deberia_ser_0 from u;
rollback;

\echo '--- 4. owner de la Org B NO puede tocar los ajustes de la Org A (cross-tenant): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000d0e03', true);
with u as (
  update restaurantes.agent_runtime_settings set voice_humanize = true, updated_by = '00000000-0000-0000-0000-0000000d0e03'
   where organization_id = '00000000-0000-0000-0000-0000000d0b01' returning 1
)
select count(*) as update_otra_org_deberia_ser_0 from u;
rollback;

\echo '--- 5. anon no puede escribir las columnas nuevas: RECHAZADO ---'
begin;
set local role anon;
update restaurantes.agent_runtime_settings set voice_typing = true where organization_id = '00000000-0000-0000-0000-0000000d0b01' returning 1 as should_fail;
rollback;

\echo ''
\echo '=== C) CHECK por columna ==='
\echo ''

\echo '--- 6. preset de ambiente fuera de la lista: RECHAZADO ---'
begin;
update restaurantes.agent_runtime_settings set voice_background_preset = 'discoteca' where organization_id = '00000000-0000-0000-0000-0000000d0b01' returning 1 as should_fail;
rollback;

\echo '--- 7. volumen de tecleo 26 (> 25): RECHAZADO ---'
begin;
update restaurantes.agent_runtime_settings set voice_typing_volume = 26 where organization_id = '00000000-0000-0000-0000-0000000d0b01' returning 1 as should_fail;
rollback;

\echo '--- 8. volumen de fondo 21 (> 20) sigue rechazado ---'
begin;
update restaurantes.agent_runtime_settings set voice_background_volume = 21 where organization_id = '00000000-0000-0000-0000-0000000d0b01' returning 1 as should_fail;
rollback;

\echo ''
\echo '=== D) Lectura ==='
\echo ''

\echo '--- 9. la sesion de SISTEMA (servicio de llamadas) lee las columnas nuevas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as lectura_sistema_deberia_ser_1 from (select voice_background_preset, voice_typing, voice_typing_volume, voice_humanize from restaurantes.agent_runtime_settings where organization_id = '00000000-0000-0000-0000-0000000d0b01') q;
rollback;

\echo '--- 10. anon no lee las columnas nuevas: RECHAZADO ---'
begin;
set local role anon;
select voice_typing as should_fail from restaurantes.agent_runtime_settings;
rollback;

\echo ''
\echo '=== E) Base sin migrar ==='
\echo ''

\echo '--- 11. sin las columnas nuevas: 42703 se recupera con SAVEPOINT (como runWithSavepointFallback) y la transaccion sigue usable ---'
begin;
alter table restaurantes.agent_runtime_settings drop column voice_typing;
savepoint sp_verify_ambiente_tecleo;
do $$
declare
  v_state text;
begin
  begin
    perform voice_typing from restaurantes.agent_runtime_settings;
    raise exception 'se esperaba SQLSTATE 42703 y la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_ambiente_tecleo;
release savepoint sp_verify_ambiente_tecleo;
select count(*) as filas_tras_el_savepoint_deberia_ser_1 from restaurantes.agent_runtime_settings where organization_id = '00000000-0000-0000-0000-0000000d0b01';
rollback;
