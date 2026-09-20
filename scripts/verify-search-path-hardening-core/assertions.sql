-- Verificación contra Postgres real de
-- packages/db/migrations/0023_search_path_hardening_core_functions.sql:
--
--   1. `pg_proc.proconfig` incluye `search_path=core, pg_temp` para las 4
--      funciones endurecidas, tras aplicar TODAS las migraciones reales de
--      `supabase/migrations/` en orden (ver run.sh) — prueba que la cláusula
--      `set search_path` realmente quedó fijada en el catálogo, no solo que
--      el archivo SQL la menciona.
--   2. El comportamiento de cada función es IDÉNTICO al que tenía antes de
--      esta migración — mismos casos positivo/negativo que ya cubrían sus
--      migraciones originales:
--        - `core.set_property_vertical`: INSERT en `core.property` sigue
--          copiando `organization.vertical` a la fila (positivo), y sigue
--          fallando si `organization_id` no existe por el `not null` de la
--          columna (negativo — el trigger deja `new.vertical` en NULL cuando
--          el SELECT no encuentra fila, y la columna es `not null`).
--        - `core.default_llm_org_monthly_cap_micro_usd`: sigue devolviendo
--          exactamente 100000000 (positivo).
--        - `core.impersonation_block_mutation`: UPDATE/DELETE sobre
--          `core.impersonation_session` siguen fallando con SQLSTATE 0A000
--          (negativo — bitácora append-only), INSERT sigue funcionando
--          (positivo).
--        - `core.authz_audit_log_block_mutation`: mismo patrón sobre
--          `core.authz_audit_log`.
--
-- Convención "deberia_ser_0"/"should_fail" — mismo criterio que
-- scripts/verify-superadmin-impersonacion/assertions.sql: una fila con esos
-- prefijos debe devolver 0 filas o el bloque debe terminar en ERROR
-- (correcto); el resto debe devolver filas/RETURNING reales.

\set ON_ERROR_STOP off

select '== 1) proconfig incluye search_path fijo para las 4 funciones ==' as paso;

select
  p.proname,
  n.nspname as schema,
  p.proconfig
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core'
  and p.proname in (
    'set_property_vertical',
    'default_llm_org_monthly_cap_micro_usd',
    'impersonation_block_mutation',
    'authz_audit_log_block_mutation'
  )
order by p.proname;

-- deberia_ser_4: las 4 funciones deben tener 'search_path=core, pg_temp' en
-- proconfig (ninguna fila si falta en alguna).
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

select '== 2) default_llm_org_monthly_cap_micro_usd sigue devolviendo la constante ==' as paso;
select core.default_llm_org_monthly_cap_micro_usd() as deberia_ser_100000000;

select '== 3) set_property_vertical sigue copiando vertical (positivo) ==' as paso;
insert into core.organization (id, name, vertical, slug) values
  ('11111111-1111-1111-1111-111111111111', 'Verify Search Path Org', 'hoteles', 'verify-search-path-org');

insert into core.property (id, organization_id, name)
values ('22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'Verify Search Path Property');

select vertical as deberia_ser_hoteles from core.property where id = '22222222-2222-2222-2222-222222222222';

select '== 4) set_property_vertical: organization_id inexistente sigue fallando (negativo, not null) ==' as paso;
insert into core.property (id, organization_id, name)
values ('33333333-3333-3333-3333-333333333333', '99999999-9999-9999-9999-999999999999', 'should_fail_sin_organizacion');

select '== 5) impersonation_block_mutation: INSERT sigue funcionando (positivo) ==' as paso;
insert into core.staff_user (id, email, full_name) values
  ('44444444-4444-4444-4444-444444444444', 'verify-search-path@example.com', 'Verify Search Path Staff');

insert into core.impersonation_session (id, actor_user_id, actor_email, organization_id, reason, expires_at)
values (
  '55555555-5555-5555-5555-555555555555',
  '44444444-4444-4444-4444-444444444444',
  'verify-search-path@example.com',
  '11111111-1111-1111-1111-111111111111',
  'motivo de prueba con al menos veinte caracteres',
  now() + interval '10 minutes'
);

select count(*) as deberia_ser_1 from core.impersonation_session where id = '55555555-5555-5555-5555-555555555555';

select '== 6) impersonation_block_mutation: UPDATE sigue bloqueado con 0A000 (negativo, should_fail) ==' as paso;
update core.impersonation_session set reason = 'motivo modificado con veinte caracteres' where id = '55555555-5555-5555-5555-555555555555';

select '== 7) impersonation_block_mutation: DELETE sigue bloqueado con 0A000 (negativo, should_fail) ==' as paso;
delete from core.impersonation_session where id = '55555555-5555-5555-5555-555555555555';

select '== 8) authz_audit_log_block_mutation: INSERT sigue funcionando (positivo) ==' as paso;
insert into core.authz_audit_log (id, action, route, method, decision, reason, metadata, occurred_at)
values (
  '66666666-6666-6666-6666-666666666666',
  'admin:access',
  '/superadmin/verify-search-path',
  'GET',
  'denied',
  'insufficient_role',
  '{}'::jsonb,
  now()
);

select count(*) as deberia_ser_1 from core.authz_audit_log where id = '66666666-6666-6666-6666-666666666666';

select '== 9) authz_audit_log_block_mutation: UPDATE sigue bloqueado con 0A000 (negativo, should_fail) ==' as paso;
update core.authz_audit_log set reason = 'route_not_mapped' where id = '66666666-6666-6666-6666-666666666666';

select '== 10) authz_audit_log_block_mutation: DELETE sigue bloqueado con 0A000 (negativo, should_fail) ==' as paso;
delete from core.authz_audit_log where id = '66666666-6666-6666-6666-666666666666';

select '== listo ==' as paso;
