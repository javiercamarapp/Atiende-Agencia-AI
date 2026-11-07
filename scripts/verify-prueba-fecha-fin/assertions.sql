-- Verifica, contra Postgres REAL, la migracion packages/db/migrations/0072_prueba_con_fecha_de_fin_al_crear.sql:
-- una organizacion que nace en 'trial' sin fecha recibe trial_ends_at = now() + 14 dias; una fecha explicita se conserva; una organizacion
-- que nace 'active' no recibe fecha; un UPDATE no la toca; pasar a active la borra; el pago (sesion de sistema) activa solo una prueba;
-- el aviso de prueba vencida sale una vez sin apagar nada y nunca a una demo; las funciones no son invocables por usuarios ni anon.
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

\echo '7. pasar a active (cambiar_plan o pago) borra la fecha de prueba -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7205', 'citas', 'Prueba 7', 'prueba-fin-7', 'trial');
update core.organization set status = 'active' where id = '00000000-0000-0000-0000-0000000f7205';
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7205' and status = 'active' and trial_ends_at is null)::int as deberia_ser_1;
rollback;

\echo '8. suspender una prueba conserva su fecha (solo active la borra) -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7206', 'citas', 'Prueba 8', 'prueba-fin-8', 'trial');
update core.organization set status = 'suspended' where id = '00000000-0000-0000-0000-0000000f7206';
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7206' and trial_ends_at is not null)::int as deberia_ser_1;
rollback;

\echo '9. sesion de sistema: el pago activa una prueba (trial -> active, sin fecha) -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7207', 'licitaciones', 'Prueba 9', 'prueba-fin-9', 'trial');
select core.organization_activate_on_payment('00000000-0000-0000-0000-0000000f7207') as resultado_activacion;
select (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f7207' and status = 'active' and trial_ends_at is null)::int as deberia_ser_1;
rollback;

\echo '10. el pago NO reactiva una organizacion suspendida -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7208', 'citas', 'Prueba 10', 'prueba-fin-10', 'suspended');
select (core.organization_activate_on_payment('00000000-0000-0000-0000-0000000f7208') = 'suspendida'
   and (select status from core.organization where id = '00000000-0000-0000-0000-0000000f7208') = 'suspended')::int as deberia_ser_1;
rollback;

\echo '11. el pago sobre una activa no cambia nada; un id inexistente devuelve no_existe -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7209', 'hoteles', 'Prueba 11', 'prueba-fin-11', 'active');
select ((core.organization_activate_on_payment('00000000-0000-0000-0000-0000000f7209') = 'ya_activa')
   and (core.organization_activate_on_payment('00000000-0000-0000-0000-0000000f72ff') = 'no_existe'))::int as deberia_ser_1;
rollback;

\echo '12. un usuario autenticado (dueno de la propia organizacion) NO puede activarla -- RECHAZADO'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f720a', 'citas', 'Prueba 12', 'prueba-fin-12', 'trial');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f72a1', true);
select core.organization_activate_on_payment('00000000-0000-0000-0000-0000000f720a') as should_fail;
rollback;

\echo '13. anon NO puede activar una organizacion -- RECHAZADO'
begin;
set local role anon;
select core.organization_activate_on_payment('00000000-0000-0000-0000-0000000f720a') as should_fail;
rollback;

\echo '14. prueba vencida: se reclama UNA vez el aviso dias_antes = 0 y la organizacion sigue en trial (no se apaga) -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status, trial_ends_at) values ('00000000-0000-0000-0000-0000000f720b', 'citas', 'Prueba 14', 'prueba-fin-14', 'trial', now() - interval '1 day');
select count(*) from core.trial_notice_claim(now());
select ((select count(*) from core.trial_notice_log where organization_id = '00000000-0000-0000-0000-0000000f720b' and dias_antes = 0)
  + (select count(*) from core.trial_notice_claim(now()) where organization_id = '00000000-0000-0000-0000-0000000f720b')
  + (select count(*) from core.organization where id = '00000000-0000-0000-0000-0000000f720b' and status = 'trial'))::int as deberia_ser_2;
rollback;

\echo '15. una prueba vencida hace mas de 30 dias no dispara aviso -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status, trial_ends_at) values ('00000000-0000-0000-0000-0000000f720c', 'rentas', 'Prueba 15', 'prueba-fin-15', 'trial', now() - interval '31 days');
select (select count(*) from core.trial_notice_claim(now()) where organization_id = '00000000-0000-0000-0000-0000000f720c')::int as deberia_ser_0;
rollback;

\echo '16. una organizacion demo (restaurantes) en prueba no recibe avisos (ni previos ni de vencida) -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status, trial_ends_at) values
  ('00000000-0000-0000-0000-0000000f720d', 'restaurantes', 'Demo 16', 'prueba-fin-16', 'trial', now() - interval '1 day'),
  ('00000000-0000-0000-0000-0000000f720e', 'restaurantes', 'Demo 16b', 'prueba-fin-16b', 'trial', now() + interval '3 days');
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000f720d', 'v'), ('00000000-0000-0000-0000-0000000f720e', 'v');
select (select count(*) from core.trial_notice_claim(now()) where organization_id in ('00000000-0000-0000-0000-0000000f720d', '00000000-0000-0000-0000-0000000f720e'))::int as deberia_ser_0;
rollback;

\echo '17. una organizacion demo (citas) en prueba vencida no recibe aviso -- OK'
begin;
insert into core.organization (id, vertical, name, slug, status, trial_ends_at) values ('00000000-0000-0000-0000-0000000f720f', 'citas', 'Demo 17', 'prueba-fin-17', 'trial', now() - interval '1 day');
insert into citas.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000f720f', 'v');
select (select count(*) from core.trial_notice_claim(now()) where organization_id = '00000000-0000-0000-0000-0000000f720f')::int as deberia_ser_0;
rollback;

\echo '18. el log acepta dias_antes = 0 pero sigue rechazando un umbral desconocido -- RECHAZADO'
begin;
insert into core.organization (id, vertical, name, slug, status) values ('00000000-0000-0000-0000-0000000f7210', 'citas', 'Prueba 18', 'prueba-fin-18', 'trial');
insert into core.trial_notice_log (organization_id, dias_antes, trial_ends_at) values ('00000000-0000-0000-0000-0000000f7210', 5, now());
select 1 as should_fail;
rollback;

\echo ''
\echo 'Fin.'
