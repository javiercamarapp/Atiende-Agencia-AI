-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), packages/db/migrations/0075_onboarding_progreso.sql:
-- guardar_onboarding_progreso (miembro de la organizacion guarda SU fila; otra organizacion, sistema y anon no; superadmin sin organizacion),
-- upsert idempotente (una fila por persona/organizacion/pista, «terminado» no se borra), formato cerrado, y lectura por RLS solo de la propia fila.
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback; deberia_ser_N = ultima fila
-- vale N; should_fail = el escenario debe terminar en ERROR.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f7500', 'restaurantes', 'Org A guia', 'org-guia-a', 'active'),
  ('00000000-0000-0000-0000-0000000f7501', 'citas', 'Org B guia', 'org-guia-b', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f7520', 'owner-a-guia@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f7521', 'staff-a-guia@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000f7522', 'owner-b-guia@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-0000000f7523', 'sa-guia@example.com', 'Superadmin', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f7520', '00000000-0000-0000-0000-0000000f7500', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f7521', '00000000-0000-0000-0000-0000000f7500', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000f7522', '00000000-0000-0000-0000-0000000f7501', null, 'owner', 'owner')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f7523') on conflict do nothing;

\echo '1. owner de A guarda su progreso: lo lee de vuelta -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', 'pedidos.que', true, false, false, true, false);
select (select count(*) from core.onboarding_progreso where paso = 'pedidos.que' and activo)::int as deberia_ser_1;
rollback;

\echo '2. upsert: dos guardados dejan UNA fila con el ultimo paso -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', 'pedidos.que', true, false, false, true, false);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'completo', 'productos.clave', true, false, false, true, false);
select (select count(*) from core.onboarding_progreso where paso = 'productos.clave' and modo = 'completo')::int
     + (select count(*) from core.onboarding_progreso)::int * 10 as deberia_ser_11;
rollback;

\echo '3. terminado es un hito: guardar despues sin terminar no lo borra -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', null, true, false, false, false, true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', 'pedidos.ir', true, false, false, true, false);
select (select count(*) from core.onboarding_progreso where terminado_en is not null)::int as deberia_ser_1;
rollback;

\echo '4. staff (member) de A guarda SU fila y no ve la del owner -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', 'pedidos.que', true, false, false, true, false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7521', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.staff', 'corto', 'historial.que', true, false, false, true, false);
select (select count(*) from core.onboarding_progreso)::int as deberia_ser_1;
rollback;

\echo '5. cross-tenant: owner de B no guarda en A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7522', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', null, true, false, false, false, false) as should_fail;
rollback;

\echo '6. cross-tenant: owner de B no ve la fila del owner de A -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', 'pedidos.que', true, false, false, true, false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7522', true);
select (select count(*) from core.onboarding_progreso)::int as deberia_ser_0;
rollback;

\echo '7. organizacion inexistente: 42501 (no revela si existe) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('no-existe', 'restaurantes.owner', null, null, true, false, false, false, false) as should_fail;
rollback;

\echo '8. pista de otra vertical: 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'citas.owner', null, null, true, false, false, false, false) as should_fail;
rollback;

\echo '9. paso con caracteres fuera del formato: 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', null, '<script>', true, false, false, false, false) as should_fail;
rollback;

\echo '10. sesion de sistema (uid nulo): 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', null, null, true, false, false, false, false) as should_fail;
rollback;

\echo '11. superadmin sin organizacion guarda la pista superadmin -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7523', true);
select core.guardar_onboarding_progreso(null, 'superadmin', 'completo', 'organizaciones.que', true, false, false, true, false);
select (select count(*) from core.onboarding_progreso where organization_id is null)::int as deberia_ser_1;
rollback;

\echo '12. un owner (no superadmin) no guarda la pista superadmin -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso(null, 'superadmin', null, null, true, false, false, false, false) as should_fail;
rollback;

\echo '13. anon no ejecuta -- RECHAZADO'
begin;
set local role anon;
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', null, null, true, false, false, false, false) as should_fail;
rollback;

\echo '14. insert directo en la tabla (owner): sin GRANT -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
insert into core.onboarding_progreso (user_id, organization_id, pista) values ('00000000-0000-0000-0000-0000000f7520', '00000000-0000-0000-0000-0000000f7500', 'restaurantes.owner') returning 1 as should_fail;
rollback;

\echo '15. update directo de la fila propia: sin GRANT -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f7520', true);
select core.guardar_onboarding_progreso('org-guia-a', 'restaurantes.owner', 'corto', 'pedidos.que', true, false, false, true, false);
update core.onboarding_progreso set paso = 'x' returning 1 as should_fail;
rollback;

\echo '16. anon no lee la tabla -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.onboarding_progreso;
rollback;

\echo ''
\echo 'Fin.'
