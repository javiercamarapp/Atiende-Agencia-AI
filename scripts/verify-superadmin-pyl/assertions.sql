-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0032_superadmin_pyl_infra.sql (infra compartida del P&L, SA-29):
--
--   A) Captura (superadmin_set_infra_cost): solo un superadmin real con caller-binding; rechaza
--      staff normal (miembro de una organizacion), sesion de sistema, anon, mes futuro, monto
--      negativo y concepto vacio; upsert sin duplicar (sin distinguir mayusculas); bitacora.
--   B) Lectura (list_infra_costs_for_superadmin): caller-binding, cero filas para quien no es
--      superadmin o para una sesion de sistema, anon sin EXECUTE.
--   C) La tabla no tiene GRANT directo para authenticated ni anon (ni lectura ni escritura) y
--      tiene RLS habilitado.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias `as should_fail` marca un escenario que debe terminar en
-- ERROR; el alias deberia_ser_N exige que la ultima fila valga N. Sesion de SISTEMA = rol
-- authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f2000', 'restaurantes', 'PYL Org A', 'org-pyl-a', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f2100', 'sa-pyl-1@example.com', 'Superadmin PYL 1', 'seed'),
  ('00000000-0000-0000-0000-0000000f2102', 'staff-normal-pyl@example.com', 'Staff normal PYL', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f2100') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f2102', '00000000-0000-0000-0000-0000000f2000', null, 'owner', 'staff')
on conflict do nothing;

\echo 'A1. superadmin captura un concepto de infra de un mes pasado: queda la fila'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-17', 'Vercel Pro', 150000, 'factura marzo');
reset role;
select count(*) as deberia_ser_1 from core.infra_cost_monthly where mes = '2026-03-01' and concepto = 'Vercel Pro' and monto_mxn_centavos = 150000 and nota = 'factura marzo';
rollback;

\echo 'A2. el mismo concepto en otras mayusculas actualiza, no duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-01', 'Vercel Pro', 150000, null);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-31', '  vercel pro ', 175000, null);
reset role;
select (count(*) = 1 and max(monto_mxn_centavos) = 175000)::int as deberia_ser_1 from core.infra_cost_monthly where mes = '2026-03-01';
rollback;

\echo 'A3. la captura queda en la bitacora append-only con el actor'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-01', 'Supabase', 90000, null);
reset role;
select count(*) as deberia_ser_1 from core.plan_audit_log where event = 'infra_set' and actor_user_id = '00000000-0000-0000-0000-0000000f2100' and (detail->>'monto_mxn_centavos')::bigint = 90000;
rollback;

\echo 'A4. staff normal (miembro de una organizacion, no superadmin) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2102', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2102', '2026-03-01', 'Vercel', 100, null) as should_fail;
rollback;

\echo 'A5. caller-binding: p_caller_id de un superadmin pero auth.uid() de OTRO -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2102', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-01', 'Vercel', 100, null) as should_fail;
rollback;

\echo 'A6. sesion de sistema (auth.uid() null) no captura infra -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-01', 'Vercel', 100, null) as should_fail;
rollback;

\echo 'A7. anon no puede ejecutar la captura -- RECHAZADO'
begin;
set local role anon;
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-01', 'Vercel', 100, null) as should_fail;
rollback;

\echo 'A8. mes futuro -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', (current_date + interval '2 months')::date, 'Vercel', 100, null) as should_fail;
rollback;

\echo 'A9. monto negativo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-01', 'Vercel', -1, null) as should_fail;
rollback;

\echo 'A10. concepto vacio -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-01', '   ', 100, null) as should_fail;
rollback;

\echo 'A11. mes nulo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', null, 'Vercel', 100, null) as should_fail;
rollback;

\echo 'B1. lectura como superadmin: ve los conceptos del rango, ordenados por mes'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-02-10', 'Vercel', 100000, null);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-10', 'Vercel', 120000, null);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-04-10', 'Vercel', 130000, null);
select count(*) as deberia_ser_2 from core.list_infra_costs_for_superadmin('00000000-0000-0000-0000-0000000f2100', '2026-02-15', '2026-03-20');
rollback;

\echo 'B2. staff normal pide la lectura con su propio id -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-10', 'Vercel', 120000, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2102', true);
select count(*) as deberia_ser_0 from core.list_infra_costs_for_superadmin('00000000-0000-0000-0000-0000000f2102', '2026-03-01', '2026-03-01');
rollback;

\echo 'B3. caller-binding en lectura: p_caller_id de superadmin con auth.uid() de otro -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-10', 'Vercel', 120000, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2102', true);
select count(*) as deberia_ser_0 from core.list_infra_costs_for_superadmin('00000000-0000-0000-0000-0000000f2100', '2026-03-01', '2026-03-01');
rollback;

\echo 'B4. sesion de sistema no lee la infra -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f2100', '2026-03-10', 'Vercel', 120000, null);
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_infra_costs_for_superadmin('00000000-0000-0000-0000-0000000f2100', '2026-03-01', '2026-03-01');
rollback;

\echo 'B5. anon no puede ejecutar la lectura -- RECHAZADO'
begin;
set local role anon;
select * from core.list_infra_costs_for_superadmin('00000000-0000-0000-0000-0000000f2100', '2026-03-01', '2026-03-01') as should_fail;
rollback;

\echo 'C1. authenticated no lee la tabla directo -- RECHAZADO'
begin;
set local role authenticated;
select * from core.infra_cost_monthly as should_fail;
rollback;

\echo 'C2. anon no lee la tabla directo -- RECHAZADO'
begin;
set local role anon;
select * from core.infra_cost_monthly as should_fail;
rollback;

\echo 'C3. authenticated no inserta directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
insert into core.infra_cost_monthly (mes, concepto, monto_mxn_centavos) values ('2026-03-01', 'directo', 1) returning 1 as should_fail;
rollback;

\echo 'C4. authenticated no actualiza directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f2100', true);
update core.infra_cost_monthly set monto_mxn_centavos = 0 returning 1 as should_fail;
rollback;

\echo 'C5. la tabla tiene RLS habilitado'
select count(*) as deberia_ser_1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'core' and c.relname = 'infra_cost_monthly' and c.relrowsecurity;

\echo 'C6. ni anon ni authenticated tienen privilegio alguno sobre la tabla (ni por columna)'
select count(*) as deberia_ser_0 from information_schema.column_privileges where table_schema = 'core' and table_name = 'infra_cost_monthly' and grantee in ('anon', 'authenticated', 'PUBLIC');
