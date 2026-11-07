-- Verifica, contra Postgres REAL, la migracion packages/db/migrations/0072_prueba_con_fecha_de_fin_al_crear.sql:
-- una organizacion que nace en 'trial' sin fecha recibe trial_ends_at = now() + 14 dias; una fecha explicita se conserva; una organizacion
-- que nace 'active' no recibe fecha; un UPDATE no la toca; la funcion del trigger no es invocable como RPC.
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback; el alias deberia_ser_N exige
-- que la ultima fila valga N; un escenario con alias should_fail debe terminar en ERROR.
\set ON_ERROR_STOP off
\pset pager off

\echo '1. trial sin fecha: nace con trial_ends_at a 14 dias -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7200', 'citas', 'Prueba 1', 'prueba-fin-1', 'trial');
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7200'
  and trial_ends_at between now() + interval '13 days 23 hours' and now() + interval '14 days 1 hour')::int as deberia_ser_1;
rollback;

\echo '2. trial con fecha explicita: se conserva -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status, trial_ends_at) values ('00000000-0000-0000-0000-0000000f7201', 'licitaciones', 'Prueba 2', 'prueba-fin-2', 'trial', '2030-01-01 00:00:00+00');
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7201' and trial_ends_at = '2030-01-01 00:00:00+00')::int as deberia_ser_1;
rollback;

\echo '3. activa: sin fecha de prueba -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7202', 'hoteles', 'Prueba 3', 'prueba-fin-3', 'active');
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7202' and trial_ends_at is null)::int as deberia_ser_1;
rollback;

\echo '4. un UPDATE (soporte quita la fecha) no la vuelve a fijar -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7203', 'despachos', 'Prueba 4', 'prueba-fin-4', 'trial');
update core.organization set trial_ends_at = null where id = '00000000-0000-0000-0000-0000000f7203';
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7203' and trial_ends_at is null)::int as deberia_ser_1;
rollback;

\echo '5. sin default de columna: el estado por omision (trial, 0001) tambien recibe fecha -- OK'
begin;
insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000f7204', 'rentas', 'Prueba 5', 'prueba-fin-5');
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7204' and trial_ends_at is not null)::int as deberia_ser_1;
rollback;

\echo '6. authenticated no puede invocar la funcion del trigger -- RECHAZADO'
begin;
set local role authenticated;
select core.organization_trial_ends_at_default() as should_fail;
rollback;

\echo ''
\echo 'Fin.'
