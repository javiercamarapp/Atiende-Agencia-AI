-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales --
-- nunca el repositorio en memoria de domain-licitaciones, que no aplica ninguno de
-- los dos), que packages/domain-licitaciones/migrations/027_organization_timezone.sql
-- cierra exactamente lo que dice cerrar (FASE 3, producto -- zona horaria por
-- negocio):
--
--   1. Positivo: owner real de la organización SÍ puede configurar su timezone.
--   2. Positivo: admin real TAMBIÉN puede (mismo umbral, `can_manage_org_settings`).
--   3. NEGATIVO (rol insuficiente): analyst/writer/reviewer/viewer -- RECHAZADOS,
--      esta configuración es MÁS angosta que `can_write_org` (que sí los incluye).
--   4. CROSS-TENANT: owner real de OTRA organización -- RECHAZADO al escribir la
--      fila de la organización ajena.
--   5. `anon` rechazado por completo (sin GRANT de INSERT/UPDATE).
--   6. Lectura: CUALQUIER staff real de la organización (incluido "viewer") ve su
--      propio `tenant_config` -- leer el valor vigente no es una decisión.
--   7. CROSS-TENANT (lectura): staff real de la Org B no ve la fila de la Org A --
--      0 filas (RLS filtra, nunca un error -- mismo criterio "cero filas" que el
--      resto del repo), nunca una fuga de datos.
--   8. `anon` rechazado por completo en lectura también (sin GRANT de SELECT).
--   9. `licitaciones.system_get_organization_timezone` -- función `security
--      definer` de SOLO-sistema: un caller autenticado real (staff, `auth.uid()`
--      no nulo) -- RECHAZADO (42501), aunque sea owner real de la organización.
--  10. `licitaciones.system_get_organization_timezone` -- sesión de sistema
--      (`auth.uid()` nulo) SÍ puede leer el valor real, incluso bypassando RLS
--      (por diseño -- el barrido de sistema no tiene `auth.uid()`).
--  11. Esquema de PRODUCCIÓN a medio migrar (027 no aplicada) -- SQLSTATE 42P01
--      (la tabla NO existe -- a diferencia de un GRANT faltante), recuperado con
--      SAVEPOINT/ROLLBACK TO SAVEPOINT (mismo mecanismo que
--      `runWithSavepointFallback` en producción) para `findTenantConfig` (lectura,
--      degrada a `null`) y para `upsertTenantConfig` (escritura, relanza
--      `TenantConfigNotMigratedError` -- aquí demostrado como el 42P01 crudo que
--      el repositorio real captura, ver postgres-repository.ts).
--
-- Run vía ./run.sh -- ver ese archivo para cómo se levanta el Postgres efímero + el
-- mock mínimo de plataforma (mismo patrón que scripts/verify-restaurantes-audit-log/).
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto persiste
-- (salvo las fixtures de abajo, insertadas directo como el superusuario que corre el
-- script, igual que el resto de scripts/verify-*/).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000e1', 'licitaciones', 'Org A (zona horaria)', 'org-a-zona-horaria'),
  ('00000000-0000-0000-0000-0000000000e2', 'licitaciones', 'Org B (zona horaria, ajena)', 'org-b-zona-horaria')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000041', 'owner-a-zh@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000042', 'admin-a-zh@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000043', 'analyst-a-zh@example.com', 'Analyst A', 'seed'),
  ('00000000-0000-0000-0000-000000000044', 'writer-a-zh@example.com', 'Writer A', 'seed'),
  ('00000000-0000-0000-0000-000000000045', 'reviewer-a-zh@example.com', 'Reviewer A', 'seed'),
  ('00000000-0000-0000-0000-000000000046', 'viewer-a-zh@example.com', 'Viewer A', 'seed'),
  ('00000000-0000-0000-0000-000000000047', 'owner-b-zh@example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

-- 41: owner real de la Org A. 42: admin real de la Org A. 43-46: analyst/writer/
-- reviewer/viewer reales de la Org A (todos con `can_write_org` -- WRITE_ROLES --
-- salvo viewer, pero NINGUNO con `can_manage_org_settings`, más angosto). 47: owner
-- real, pero de la Org B (ajeno).
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-0000000000e1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-0000000000e1', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000043', '00000000-0000-0000-0000-0000000000e1', null, 'member', 'analyst'),
  ('00000000-0000-0000-0000-000000000044', '00000000-0000-0000-0000-0000000000e1', null, 'member', 'writer'),
  ('00000000-0000-0000-0000-000000000045', '00000000-0000-0000-0000-0000000000e1', null, 'member', 'reviewer'),
  ('00000000-0000-0000-0000-000000000046', '00000000-0000-0000-0000-0000000000e1', null, 'viewer', 'viewer'),
  ('00000000-0000-0000-0000-000000000047', '00000000-0000-0000-0000-0000000000e2', null, 'owner', 'owner')
on conflict do nothing;

\echo ''
\echo '=== licitaciones.tenant_config -- configuracion editable (owner/admin), FASE 3 ==='
\echo ''

\echo '--- 1. positivo: owner de la Org A configura su timezone ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Tijuana')
  on conflict (organization_id) do update set timezone = excluded.timezone, updated_at = now()
  returning timezone;
rollback;

\echo '--- 2. positivo: admin de la Org A TAMBIEN puede (mismo umbral que owner) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Cancun')
  on conflict (organization_id) do update set timezone = excluded.timezone, updated_at = now()
  returning timezone;
rollback;

\echo '--- 3a. NEGATIVO (rol insuficiente): "analyst" real de la MISMA organizacion -- RECHAZADO (esta config es MAS angosta que can_write_org, que SI incluye analyst) ---'
begin;
-- as should_fail (INSERT no admite alias al final de VALUES(...); este comentario,
-- dentro del bloque begin;/rollback;, es lo que el runner automatico detecta para
-- marcar el escenario como "debe terminar en ERROR" -- mismo criterio que
-- scripts/verify-restaurantes-config-staff-baja/assertions.sql, escenario 12).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Merida');
rollback;

\echo '--- 3b. NEGATIVO (rol insuficiente): "writer" real -- RECHAZADO ---'
begin;
-- as should_fail (ver nota del escenario 3a).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000044', true);
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Merida');
rollback;

\echo '--- 3c. NEGATIVO (rol insuficiente): "reviewer" real -- RECHAZADO ---'
begin;
-- as should_fail (ver nota del escenario 3a).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000045', true);
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Merida');
rollback;

\echo '--- 3d. NEGATIVO (rol insuficiente): "viewer" real -- RECHAZADO ---'
begin;
-- as should_fail (ver nota del escenario 3a).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000046', true);
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Merida');
rollback;

\echo '--- 4. CROSS-TENANT: owner real de la Org B intenta configurar el timezone de la Org A -- RECHAZADO ---'
begin;
-- as should_fail (ver nota del escenario 3a).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000047', true);
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Merida');
rollback;

\echo '--- 5. ANON: sin GRANT de INSERT -- RECHAZADO por completo ---'
begin;
-- as should_fail (ver nota del escenario 3a).
set local role anon;
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Merida');
rollback;

-- Fixture real para los escenarios de LECTURA de abajo (fuera de cualquier
-- transacción de prueba -- insertada directo como superusuario, igual que las
-- fixtures de organización/staff de arriba).
insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Tijuana')
on conflict (organization_id) do update set timezone = excluded.timezone;

\echo '--- 6a. positivo (lectura): owner de la Org A ve su propio tenant_config ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select timezone from licitaciones.tenant_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 6b. positivo (lectura): "viewer" real TAMBIEN puede leer -- leer no es una decision ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000046', true);
select timezone from licitaciones.tenant_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 7. CROSS-TENANT (lectura): owner real de la Org B NO ve la fila de la Org A -- 0 filas, RLS filtra en silencio (nunca un error, nunca una fuga) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000047', true);
select count(*)::int as filas_visibles_deberia_ser_0 from licitaciones.tenant_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 8. ANON (lectura): sin GRANT de SELECT -- RECHAZADO por completo ---'
begin;
-- as should_fail (ver nota del escenario 3a).
set local role anon;
select timezone from licitaciones.tenant_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo ''
\echo '=== licitaciones.system_get_organization_timezone -- funcion de SOLO-sistema ==='
\echo ''

\echo '--- 9. NEGATIVO: caller autenticado real (owner de la Org A, auth.uid() NO nulo) -- RECHAZADO (42501), esta funcion es EXCLUSIVA de la sesion de sistema ---'
begin;
-- as should_fail (ver nota del escenario 3a).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select licitaciones.system_get_organization_timezone('00000000-0000-0000-0000-0000000000e1');
rollback;

\echo '--- 10. positivo: sesion de sistema (auth.uid() nulo) SI puede leer el valor real, aunque bypasse la policy de SELECT (por diseno -- el barrido de sistema no tiene auth.uid()) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select licitaciones.system_get_organization_timezone('00000000-0000-0000-0000-0000000000e1') as timezone_deberia_ser_america_tijuana;
rollback;

\echo ''
\echo '=== esquema de produccion a medio migrar (027 aun no aplicada) ==='
\echo ''

\echo '--- 11a. lectura (findTenantConfig): con licitaciones.tenant_config ELIMINADA dentro de esta MISMA transaccion, la llamada REAL que PostgresLicitacionesRepository.findTenantConfig emite falla con SQLSTATE 42P01 -- SAVEPOINT + ROLLBACK TO SAVEPOINT recupera la transaccion: la query siguiente SI corre (nunca 25P02) ---'
begin;
drop table licitaciones.tenant_config;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
savepoint sp_verify_find_tenant_config;
do $$
declare
  v_state text;
begin
  begin
    -- Mismo texto SQL EXACTO que PostgresLicitacionesRepository.findTenantConfig
    -- emite realmente, ver packages/domain-licitaciones/src/postgres-repository.ts.
    perform timezone from licitaciones.tenant_config where organization_id = '00000000-0000-0000-0000-0000000000e1';
    raise exception 'se esperaba SQLSTATE 42P01 (tabla eliminada), pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_find_tenant_config;
release savepoint sp_verify_find_tenant_config;
-- La transaccion sigue utilizable -- una consulta normal posterior SI corre.
select id, name from core.organization where id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 11b. escritura (upsertTenantConfig): mismo escenario -- el INSERT real que PostgresLicitacionesRepository.upsertTenantConfig emite tambien falla con 42P01, recuperado igual, y el repositorio real relanza TenantConfigNotMigratedError (no un 500 generico ni un 200 falso) -- aqui se demuestra el 42P01 crudo que ese repositorio captura ---'
begin;
drop table licitaciones.tenant_config;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
savepoint sp_verify_upsert_tenant_config;
do $$
declare
  v_state text;
begin
  begin
    -- Mismo texto SQL EXACTO que PostgresLicitacionesRepository.upsertTenantConfig
    -- emite realmente (el INSERT ... ON CONFLICT).
    insert into licitaciones.tenant_config (organization_id, timezone) values ('00000000-0000-0000-0000-0000000000e1', 'America/Merida')
      on conflict (organization_id) do update set timezone = case when true then excluded.timezone else licitaciones.tenant_config.timezone end, updated_at = now();
    raise exception 'se esperaba SQLSTATE 42P01 (tabla eliminada), pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_upsert_tenant_config;
release savepoint sp_verify_upsert_tenant_config;
select 1 as transaccion_recuperada_tras_42p01_deberia_ser_1;
rollback;
