-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna reales -- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/057_sucursal_directorio_y_domicilio.sql: columnas nuevas de
-- restaurantes.branch_policy (visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada).
--
--   A. Positivo: owner y admin escriben las columnas nuevas (INSERT y UPDATE por columna concedida).
--   B. Negativo: rol staff no escribe; anon no lee ni escribe; CHECKs de dias_domicilio; defaults.
--   C. Cross-tenant: owner de otra organizacion no escribe ni ve; organization_id no se puede mover.
--   D. Lectura publica: la sesion de SISTEMA (auth.uid() null, storefront) lee las columnas nuevas.
--   E. Base SIN migrar: la lectura con las columnas nuevas falla con 42703 y SAVEPOINT recupera la transaccion.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`: un escenario "RECHAZADO"
-- termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c0001', 'restaurantes', 'PM Org A', 'pm-org-a'),
  ('00000000-0000-0000-0000-0000000c0002', 'restaurantes', 'PM Org B (ajena)', 'pm-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 'a1'),
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001', 'a2'),
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c0002', 'b1')
on conflict do nothing;

insert into restaurantes.known_zone (id, organization_id, name, lat, lng) values
  ('00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001', 'Zona A', 20.99, -89.62),
  ('00000000-0000-0000-0000-0000000c00e2', '00000000-0000-0000-0000-0000000c0002', 'Zona B', 21.05, -89.55)
on conflict do nothing;

insert into restaurantes.categories (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-0000000c00c1', '00000000-0000-0000-0000-0000000c0001', 'Bebidas A', 'bebidas-a')
on conflict do nothing;
insert into restaurantes.products (id, organization_id, category_id, name, price) values
  ('00000000-0000-0000-0000-0000000c00d1', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00c1', 'Cerveza A', 50)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0011', 'owner-a@pm.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0012', 'admin-a@pm.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0013', 'staff-a@pm.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0014', 'owner-b@pm.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c0011', '00000000-0000-0000-0000-0000000c0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c0012', '00000000-0000-0000-0000-0000000c0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c0013', '00000000-0000-0000-0000-0000000c0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c0014', '00000000-0000-0000-0000-0000000c0002', null, 'owner', 'owner')
on conflict do nothing;

-- Datos previos (insertados como superusuario): A2 ya tiene politica con restriccion de domicilio.
insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, dias_domicilio, visible_en_directorio, de_temporada) values
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001',
   '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]'::jsonb, 200, '{5,6,0}', true, true)
on conflict do nothing;

\echo '=== A1. POSITIVO: owner de A crea la politica de A1 con las columnas nuevas (solo recoger, de temporada, visible) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_policy (property_id, organization_id, visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', true, false, null, true)
  returning property_id, acepta_domicilio, de_temporada;
rollback;

\echo '=== A2. POSITIVO: admin de A actualiza dias_domicilio de A2 (UPDATE por columna concedida) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0012', true);
update restaurantes.branch_policy set dias_domicilio = '{5,6}', acepta_domicilio = true, updated_at = now()
  where property_id = '00000000-0000-0000-0000-0000000c00a2'
  returning property_id, dias_domicilio;
rollback;

\echo '=== A3. DEFAULTS: una politica de 023 sin las columnas nuevas conserva el comportamiento anterior (acepta domicilio, no es de temporada, dias y directorio null) ==='
begin;
with nueva as (
  insert into restaurantes.branch_policy (property_id, organization_id, pedido_minimo_domicilio)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 50)
  returning acepta_domicilio, de_temporada, dias_domicilio, visible_en_directorio
)
select count(*)::int as filas_con_defaults_deberia_ser_1
  from nueva
  where acepta_domicilio is true and de_temporada is false and dias_domicilio is null and visible_en_directorio is null;
rollback;

\echo '=== B1. RLS: staff de A no actualiza ninguna fila (0 filas, nunca cambia el domicilio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
with actualizado as (
  update restaurantes.branch_policy set acepta_domicilio = false where property_id = '00000000-0000-0000-0000-0000000c00a2' returning property_id
)
select count(*)::int as filas_actualizadas_por_staff_deberia_ser_0 from actualizado;
rollback;

\echo '=== B2. RECHAZADO (debe fallar): anon no lee branch_policy (las columnas nuevas tampoco son publicas por esta via) ==='
begin;
set local role anon;
select visible_en_directorio, acepta_domicilio, dias_domicilio from restaurantes.branch_policy as should_fail;
rollback;

\echo '=== B3. RECHAZADO (debe fallar): anon no escribe las columnas nuevas ==='
begin;
set local role anon;
update restaurantes.branch_policy set acepta_domicilio = false returning 1 as should_fail;
rollback;

\echo '=== B4. RECHAZADO (debe fallar): CHECK dias_domicilio fuera de 0-6 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.branch_policy set dias_domicilio = '{7}' where property_id = '00000000-0000-0000-0000-0000000c00a2' returning 1 as should_fail;
rollback;

\echo '=== B5. RECHAZADO (debe fallar): CHECK dias_domicilio vacio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.branch_policy set dias_domicilio = '{}' where property_id = '00000000-0000-0000-0000-0000000c00a2' returning 1 as should_fail;
rollback;

\echo '=== B6. RECHAZADO (debe fallar): CHECK dias_domicilio con nulo dentro ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.branch_policy set dias_domicilio = '{5,NULL}' where property_id = '00000000-0000-0000-0000-0000000c00a2' returning 1 as should_fail;
rollback;

\echo '=== C1. CROSS-TENANT: owner de B no actualiza las columnas nuevas de A2 (RLS filtra: 0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with actualizado as (
  update restaurantes.branch_policy set acepta_domicilio = false, visible_en_directorio = false where property_id = '00000000-0000-0000-0000-0000000c00a2' returning property_id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== C2. RECHAZADO (debe fallar): owner de B inserta una politica con las columnas nuevas para una property de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
insert into restaurantes.branch_policy (property_id, organization_id, acepta_domicilio)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', false) returning 1 as should_fail;
rollback;

\echo '=== C3. RECHAZADO (debe fallar): GRANT por columna -- ni el owner mueve organization_id ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.branch_policy set organization_id = '00000000-0000-0000-0000-0000000c0002' where property_id = '00000000-0000-0000-0000-0000000c00a2' returning 1 as should_fail;
rollback;

\echo '=== C4. CROSS-TENANT LECTURA: owner de B ve 0 filas de la politica de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
select count(*)::int as filas_visibles_cross_tenant_deberia_ser_0 from restaurantes.branch_policy where property_id = '00000000-0000-0000-0000-0000000c00a2';
rollback;

\echo '=== D1. LECTURA PUBLICA: la sesion de SISTEMA del storefront (sin usuario) lee las columnas nuevas de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as filas_visibles_sistema_deberia_ser_1
  from restaurantes.branch_policy
  where property_id = '00000000-0000-0000-0000-0000000c00a2' and dias_domicilio = '{5,6,0}' and visible_en_directorio is true and de_temporada is true;
rollback;

\echo '=== E1. BASE SIN MIGRAR: sin la columna dias_domicilio la lectura nueva falla con 42703 y SAVEPOINT recupera la transaccion ==='
begin;
alter table restaurantes.branch_policy drop column dias_domicilio;
savepoint sp_verify_branch_policy_057_read;
do $$
declare
  v_state text;
begin
  begin
    perform visible_en_directorio, acepta_domicilio, dias_domicilio, de_temporada
      from restaurantes.branch_policy where property_id = '00000000-0000-0000-0000-0000000c00a2';
    raise exception 'se esperaba SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_branch_policy_057_read;
release savepoint sp_verify_branch_policy_057_read;
select 1 as transaccion_recuperada_tras_42703_deberia_ser_1;
rollback;
