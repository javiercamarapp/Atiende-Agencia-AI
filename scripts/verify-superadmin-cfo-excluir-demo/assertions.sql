-- Verifica, contra Postgres REAL, packages/db/migrations/0057_superadmin_cfo_excluir_demo.sql:
-- el dashboard CFO (core.get_cfo_dashboard_for_superadmin -> core.cfo_org_rows) NO cuenta las
-- organizaciones demo (marcadas en restaurantes.demo_organization o con slug `demo-%`), sigue
-- contando las reales, la foto mensual de ingreso tampoco las incluye, y la superficie de
-- seguridad no cambia (caller-binding, anon sin EXECUTE, cfo_org_rows sin GRANT).
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; `should_fail` exige ERROR; `deberia_ser_N` exige que la ultima fila valga N.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000e1000', 'restaurantes', 'Real restaurantes', 'real-rest', 'active'),
  ('00000000-0000-0000-0000-0000000e1001', 'restaurantes', 'Demo por marca', 'tizon-ficticio', 'active'),
  ('00000000-0000-0000-0000-0000000e1002', 'hoteles', 'Demo por slug', 'demo-hoteles', 'active')
on conflict do nothing;
insert into restaurantes.demo_organization (organization_id, seed_version) values
  ('00000000-0000-0000-0000-0000000e1001', 'verify')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0100', 'sa-demo-cfo@example.com', 'Superadmin demo CFO', 'seed'),
  ('00000000-0000-0000-0000-0000000e0102', 'staff-demo-cfo@example.com', 'Staff normal', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000e0100') on conflict do nothing;
insert into core.organization_plan (organization_id, plan_id) values
  ('00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar'),
  ('00000000-0000-0000-0000-0000000e1001', 'restaurantes-estandar'),
  ('00000000-0000-0000-0000-0000000e1002', 'hoteles-estandar')
on conflict do nothing;

\echo 'E1. la org real SI aparece en el dashboard CFO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as deberia_ser_1 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r
  where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'E2. la demo marcada en restaurantes.demo_organization NO aparece (aunque tenga plan)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r
  where r.organization_id = '00000000-0000-0000-0000-0000000e1001';
rollback;

\echo 'E3. la demo por slug demo-% NO aparece (aunque tenga plan)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r
  where r.organization_id = '00000000-0000-0000-0000-0000000e1002';
rollback;

\echo 'E4. ninguna fila del dashboard es de slug demo-% ni de la marca (mismo criterio, a nivel de todo el resultado)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r
  where r.organization_slug like 'demo-%' or r.organization_id in (select d.organization_id from restaurantes.demo_organization d);
rollback;

\echo 'E5. caller-binding intacto: un staff que no es superadmin recibe cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000e0102', '2026-03-01');
rollback;

\echo 'E6. anon no puede ejecutar el dashboard'
begin;
set local role anon;
select count(*) as should_fail from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01');
rollback;

\echo 'E7. cfo_org_rows sigue sin GRANT: authenticated no la ejecuta directo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as should_fail from core.cfo_org_rows('2026-03-01');
rollback;

\echo 'E8. la foto mensual (solo sistema) SI escribe la org real del mes en curso'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.snapshot_billing_monthly_for_system();
reset role;
select count(*) as deberia_ser_1 from core.billing_snapshot_monthly s
  where s.mes = date_trunc('month', current_date)::date and s.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'E9. la foto mensual NO escribe filas de organizaciones demo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.snapshot_billing_monthly_for_system();
reset role;
select count(*) as deberia_ser_0 from core.billing_snapshot_monthly s
  where s.organization_id in ('00000000-0000-0000-0000-0000000e1001', '00000000-0000-0000-0000-0000000e1002');
rollback;
