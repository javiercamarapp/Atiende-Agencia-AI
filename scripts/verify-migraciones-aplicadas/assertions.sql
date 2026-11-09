-- Verifica, contra Postgres REAL, packages/db/migrations/0101_migraciones_aplicadas.sql (Ola 4, G4):
--   S) sesion de SISTEMA (rol authenticated, auth.uid() nulo): lee las versiones de supabase_migrations.schema_migrations.
--   U) usuario autenticado real (auth.uid() con valor): CERO filas, aunque sea superadmin -- es solo de sistema.
--   A) anon: sin EXECUTE (ERROR).
--   D) acceso directo a supabase_migrations.schema_migrations como authenticated: ERROR (la funcion es la unica puerta).
--   N) base sin el registro de la CLI (sin supabase_migrations): cero filas, sin error.
--   F) search_path fijo y security definer; sin EXECUTE para public.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio;
-- `should_fail` marca un escenario que debe terminar en ERROR; deberia_ser_N exige que la ultima fila valga N; el resto
-- debe completar sin error. Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

-- S1) sistema: ve las 3 versiones registradas (el registro se crea dentro del escenario, como dueño).
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20240101000001', 'a'), ('20240101000900', 'b'), ('20240101000901', 'c') on conflict do nothing;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_3 from core.migraciones_aplicadas();
rollback;

-- S2) sistema: la maxima es la mayor version registrada.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20240101000001', 'a'), ('20240101000901', 'c') on conflict do nothing;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select case when max(v) = '20240101000901' then 1 else 0 end as deberia_ser_1 from core.migraciones_aplicadas() v;
rollback;

-- U1) usuario real autenticado: cero filas.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
insert into supabase_migrations.schema_migrations (version, name) values ('20240101000001', 'a') on conflict do nothing;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0101', true);
select count(*) as deberia_ser_0 from core.migraciones_aplicadas();
rollback;

-- A1) anon: sin EXECUTE.
begin;
set local role anon;
select count(*) as should_fail from core.migraciones_aplicadas();
rollback;

-- D1) authenticated no lee el registro directo.
begin;
create schema if not exists supabase_migrations;
create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from supabase_migrations.schema_migrations;
rollback;

-- N1) sin el schema supabase_migrations (gate/CI/local): cero filas, sin error.
begin;
drop schema if exists supabase_migrations cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.migraciones_aplicadas();
rollback;

-- F1) security definer + search_path fijo + public sin EXECUTE.
begin;
select count(*) as deberia_ser_1
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.proname = 'migraciones_aplicadas' and p.prosecdef
  and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%')
  and not has_function_privilege('public', p.oid, 'execute')
  and not has_function_privilege('anon', p.oid, 'execute')
  and has_function_privilege('authenticated', p.oid, 'execute');
rollback;
