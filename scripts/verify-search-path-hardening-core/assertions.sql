-- Verificación contra Postgres real de
-- packages/db/migrations/0023_search_path_hardening_core_functions.sql --
-- mismo contrato de escenarios `begin;.../rollback;` que
-- scripts/verify-superadmin-impersonacion/assertions.sql (ver su cabecera
-- para la convención completa; la resume el propio
-- scripts/verify-real-postgres-ci/run-gate.mjs, que descubre y corre este
-- archivo automáticamente en CI):
--
--   1. `pg_proc.proconfig` incluye `search_path=core, pg_temp` para las 4
--      funciones endurecidas, tras aplicar TODAS las migraciones reales de
--      `supabase/migrations/` en orden (ver run.sh/CI) — prueba que la
--      cláusula `set search_path` realmente quedó fijada en el catálogo, no
--      solo que el archivo SQL la menciona.
--   2. El comportamiento de cada función es IDÉNTICO al que tenía antes de
--      esta migración — mismos casos positivo/negativo que ya cubrían sus
--      migraciones originales:
--        - `core.set_property_vertical`: INSERT en `core.property` sigue
--          copiando `organization.vertical` a la fila (positivo), y sigue
--          fallando si `organization_id` no existe (negativo — el trigger
--          deja `new.vertical` en NULL cuando el SELECT no encuentra fila, y
--          la columna es `not null`).
--        - `core.default_llm_org_monthly_cap_micro_usd`: sigue devolviendo
--          exactamente 100000000 (positivo).
--        - `core.impersonation_block_mutation`: INSERT sigue funcionando
--          (positivo), UPDATE/DELETE sobre `core.impersonation_session`
--          siguen fallando con SQLSTATE 0A000 (negativo — bitácora
--          append-only).
--        - `core.authz_audit_log_block_mutation`: mismo patrón sobre
--          `core.authz_audit_log`.
\set ON_ERROR_STOP off
\pset pager off

-- ═══════════════════════════════════════════════════════════════════════════
-- Fixtures (persisten para TODOS los escenarios de abajo -- insertadas
-- DIRECTO, como el superusuario `postgres` que corre este script, mismo
-- criterio que el resto de scripts/verify-*/assertions.sql)
-- ═══════════════════════════════════════════════════════════════════════════

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d9200', 'hoteles', 'Org Verify Search Path', 'org-verify-search-path')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000d9100', 'verify-search-path@example.com', 'Verify Search Path Staff', 'seed')
on conflict do nothing;

-- Positivo de `core.set_property_vertical`: el trigger copia
-- `organization.vertical` ('hoteles') a la fila al insertar -- se verifica en
-- el escenario 3, abajo, sobre esta misma fila ya persistida.
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d9201', '00000000-0000-0000-0000-0000000d9200', 'Verify Search Path Property')
on conflict do nothing;

-- Positivo de `core.impersonation_block_mutation`: INSERT directo (como el
-- superusuario) para tener una fila real sobre la que ejercitar el bloqueo de
-- UPDATE/DELETE en los escenarios 6/7.
insert into core.impersonation_session (id, actor_user_id, actor_email, organization_id, reason, expires_at) values
  ('00000000-0000-0000-0000-0000000d9300', '00000000-0000-0000-0000-0000000d9100', 'verify-search-path@example.com', '00000000-0000-0000-0000-0000000d9200', 'Motivo de prueba con al menos veinte caracteres.', now() + interval '10 minutes')
on conflict do nothing;

-- Positivo de `core.authz_audit_log_block_mutation`: INSERT directo, misma
-- razón que el fixture anterior, para los escenarios 9/10.
insert into core.authz_audit_log (id, action, route, method, decision, reason, metadata, occurred_at) values
  ('00000000-0000-0000-0000-0000000d9400', 'admin:access', '/superadmin/verify-search-path', 'GET', 'denied', 'insufficient_role', '{}'::jsonb, now())
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════

\echo '=== 1. proconfig incluye search_path=core, pg_temp para las 4 funciones endurecidas ==='
begin;
select count(*) as deberia_ser_4
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core'
  and p.proname in (
    'set_property_vertical',
    'default_llm_org_monthly_cap_micro_usd',
    'impersonation_block_mutation',
    'authz_audit_log_block_mutation'
  )
  and p.proconfig @> array['search_path=core, pg_temp'];
rollback;

\echo '=== 2. default_llm_org_monthly_cap_micro_usd: sigue devolviendo la constante sin cambios ==='
begin;
select core.default_llm_org_monthly_cap_micro_usd() as deberia_ser_100000000;
rollback;

\echo '=== 3. set_property_vertical: INSERT sigue copiando organization.vertical -> property.vertical (positivo, sin cambios) ==='
begin;
select (vertical = 'hoteles')::int as deberia_ser_1 from core.property where id = '00000000-0000-0000-0000-0000000d9201';
rollback;

\echo '=== 4. set_property_vertical: organization_id inexistente sigue fallando por not-null (negativo, sin cambios) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario, DENTRO del bloque begin;/rollback;, es lo que el runner
-- automático de scripts/verify-real-postgres-ci/run-gate.mjs detecta para
-- marcar el escenario como "debe terminar en ERROR" -- mismo criterio que
-- scripts/verify-superadmin-impersonacion/assertions.sql, escenario 18).
insert into core.property (id, organization_id, name)
values ('00000000-0000-0000-0000-0000000d9299', '00000000-0000-0000-0000-0000000d9999', 'organizacion inexistente');
rollback;

\echo '=== 5. impersonation_session: el fixture positivo (INSERT) persistió sin error ==='
begin;
select count(*) as deberia_ser_1 from core.impersonation_session where id = '00000000-0000-0000-0000-0000000d9300';
rollback;

\echo '=== 6. impersonation_block_mutation: UPDATE sigue bloqueado con SQLSTATE 0A000 (negativo, sin cambios) ==='
begin;
-- as should_fail (UPDATE no admite `as alias` sobre la sentencia completa;
-- ver nota del escenario 4).
update core.impersonation_session set reason = 'motivo modificado con veinte caracteres' where id = '00000000-0000-0000-0000-0000000d9300';
rollback;

\echo '=== 7. impersonation_block_mutation: DELETE sigue bloqueado con SQLSTATE 0A000 (negativo, sin cambios) ==='
begin;
-- as should_fail (ver nota del escenario 6).
delete from core.impersonation_session where id = '00000000-0000-0000-0000-0000000d9300';
rollback;

\echo '=== 8. authz_audit_log: el fixture positivo (INSERT) persistió sin error ==='
begin;
select count(*) as deberia_ser_1 from core.authz_audit_log where id = '00000000-0000-0000-0000-0000000d9400';
rollback;

\echo '=== 9. authz_audit_log_block_mutation: UPDATE sigue bloqueado con SQLSTATE 0A000 (negativo, sin cambios) ==='
begin;
-- as should_fail (ver nota del escenario 4).
update core.authz_audit_log set reason = 'route_not_mapped' where id = '00000000-0000-0000-0000-0000000d9400';
rollback;

\echo '=== 10. authz_audit_log_block_mutation: DELETE sigue bloqueado con SQLSTATE 0A000 (negativo, sin cambios) ==='
begin;
-- as should_fail (ver nota del escenario 6).
delete from core.authz_audit_log where id = '00000000-0000-0000-0000-0000000d9400';
rollback;
