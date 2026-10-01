-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0034_superadmin_zona_cfo.sql (zona CFO segura, SA-41):
--
--   A) Rol `finanzas` (core.cfo_zone_set_role): solo un superadmin NO restringido lo asigna o lo
--      retira; nadie sobre si mismo; destino superadmin real; motivo >= 20; rechaza staff normal,
--      sesion de sistema, anon, otro usuario (caller-binding) y al propio restringido.
--   B) Guard comun de escritura (core.superadmin_require_caller redefinido): un superadmin
--      restringido NO puede ejecutar una escritura de superadmin (ejemplo: captura de infra, 0032),
--      uno sin restriccion SI, y el restringido SI conserva la LECTURA del dashboard CFO.
--   C) core.cfo_zone_resolve_role: superadmin / finanzas / NULL (staff normal, otro usuario, sistema).
--   D) core.cfo_zone_log_access: registra consulta/exportacion/denegado con el rol real; rechaza
--      a quien no tiene rol, acciones de rol, filtros que no son objeto o exceden 2000 caracteres,
--      sesion de sistema, anon y otro usuario.
--   E) Lectura de la bitacora y de los roles: solo el superadmin NO restringido (cero filas para
--      finanzas, staff normal, otro usuario y sistema; anon sin EXECUTE).
--   F) Bitacora append-only (UPDATE/DELETE rechazados) y tablas sin GRANT directo con RLS.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias `as should_fail` marca un escenario que debe terminar en
-- ERROR; el alias deberia_ser_N exige que la ultima fila valga N. Sesion de SISTEMA = rol
-- authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f4000', 'restaurantes', 'Zona CFO Org A', 'org-zona-cfo-a', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f4100', 'sa-zona-1@example.com', 'Superadmin Zona 1', 'seed'),
  ('00000000-0000-0000-0000-0000000f4101', 'sa-zona-2@example.com', 'Superadmin Zona 2', 'seed'),
  ('00000000-0000-0000-0000-0000000f4102', 'staff-normal-zona@example.com', 'Staff normal Zona', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f4100'), ('00000000-0000-0000-0000-0000000f4101') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f4102', '00000000-0000-0000-0000-0000000f4000', null, 'owner', 'staff')
on conflict do nothing;

\echo 'A1. superadmin asigna finanzas a otro superadmin: queda la fila y la bitacora'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
select ((select count(*) from core.cfo_zone_role where staff_user_id = '00000000-0000-0000-0000-0000000f4101' and rol = 'finanzas') = 1 and (select count(*) from core.cfo_access_log where accion = 'rol_asignado' and actor_user_id = '00000000-0000-0000-0000-0000000f4100') = 1)::int as deberia_ser_1;
rollback;

\echo 'A2. nadie se asigna el rol a si mismo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4100', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A3. staff normal (no superadmin) intenta asignar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4102', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A4. caller-binding: p_caller_id de un superadmin pero auth.uid() de OTRO -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A5. sesion de sistema (auth.uid() null) no asigna -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A6. anon no puede ejecutar la asignacion -- RECHAZADO'
begin;
set local role anon;
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A7. el destino debe ser superadmin de plataforma -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4102', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A8. motivo corto -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'corto') as should_fail;
rollback;

\echo 'A9. rol invalido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'superdios', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A10. un superadmin YA restringido no puede asignar roles -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4101', '00000000-0000-0000-0000-0000000f4100', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A11. un restringido no puede quitarse su propio rol -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4101', '00000000-0000-0000-0000-0000000f4101', null, 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'A12. el superadmin completo retira el rol: desaparece la fila y queda 'rol_retirado''
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', null, 'Motivo de prueba con mas de veinte caracteres');
reset role;
select ((select count(*) from core.cfo_zone_role) = 0 and (select count(*) from core.cfo_access_log where accion = 'rol_retirado') = 1)::int as deberia_ser_1;
rollback;

\echo 'B1. el superadmin restringido NO ejecuta una escritura de superadmin (captura de infra 0032) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f4101', '2026-03-17', 'Vercel Pro', 150000, null) as should_fail;
rollback;

\echo 'B2. el superadmin sin restriccion SI la ejecuta (el guard redefinido no rompe la escritura existente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.superadmin_set_infra_cost('00000000-0000-0000-0000-0000000f4100', '2026-03-17', 'Vercel Pro', 150000, null);
reset role;
select count(*) as deberia_ser_1 from core.infra_cost_monthly where concepto = 'Vercel Pro';
rollback;

\echo 'B3. el superadmin restringido SI conserva la lectura del dashboard CFO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select (count(*) >= 1)::int as deberia_ser_1 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f4101', null);
rollback;

\echo 'B4. el restringido no cambia el interruptor de plataforma (otra escritura via el mismo guard) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select core.set_platform_switch('00000000-0000-0000-0000-0000000f4101', 'global', 'all', true, 'Motivo de prueba con mas de veinte caracteres') as should_fail;
rollback;

\echo 'C1. resolve_role de un superadmin completo = superadmin'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select (core.cfo_zone_resolve_role('00000000-0000-0000-0000-0000000f4100') = 'superadmin')::int as deberia_ser_1;
rollback;

\echo 'C2. resolve_role de un restringido = finanzas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select (core.cfo_zone_resolve_role('00000000-0000-0000-0000-0000000f4101') = 'finanzas')::int as deberia_ser_1;
rollback;

\echo 'C3. resolve_role de staff normal = NULL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select (core.cfo_zone_resolve_role('00000000-0000-0000-0000-0000000f4102') is null)::int as deberia_ser_1;
rollback;

\echo 'C4. resolve_role con p_caller_id ajeno (caller-binding) = NULL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select (core.cfo_zone_resolve_role('00000000-0000-0000-0000-0000000f4100') is null)::int as deberia_ser_1;
rollback;

\echo 'C5. resolve_role en sesion de sistema = NULL'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (core.cfo_zone_resolve_role('00000000-0000-0000-0000-0000000f4100') is null)::int as deberia_ser_1;
rollback;

\echo 'C6. anon no puede ejecutar resolve_role -- RECHAZADO'
begin;
set local role anon;
select core.cfo_zone_resolve_role('00000000-0000-0000-0000-0000000f4100') as should_fail;
rollback;

\echo 'D1. superadmin registra una consulta: queda con actor, rol, recurso y filtros'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
select (count(*) = 1 and bool_and(actor_rol = 'superadmin') and bool_and(filtros->>'mes' = '2026-03'))::int as deberia_ser_1 from core.cfo_access_log where actor_user_id = '00000000-0000-0000-0000-0000000f4100' and accion = 'consulta';
rollback;

\echo 'D2. un restringido registra una exportacion: queda con rol finanzas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4101', 'exportacion', 'GET /superadmin/pyl/export.csv', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
select (count(*) = 1 and bool_and(actor_rol = 'finanzas'))::int as deberia_ser_1 from core.cfo_access_log where actor_user_id = '00000000-0000-0000-0000-0000000f4101' and accion = 'exportacion';
rollback;

\echo 'D3. un restringido registra una denegacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4101', 'denegado', 'POST /superadmin/organizaciones', '{}'::jsonb) as r;
reset role;
select count(*) as deberia_ser_1 from core.cfo_access_log where actor_user_id = '00000000-0000-0000-0000-0000000f4101' and accion = 'denegado';
rollback;

\echo 'D4. staff normal (sin rol en la zona) no puede registrar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4102', 'consulta', 'x', '{}'::jsonb) as should_fail;
rollback;

\echo 'D5. un usuario ajeno no registra a nombre de un superadmin (caller-binding) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'x', '{}'::jsonb) as should_fail;
rollback;

\echo 'D6. la accion 'rol_asignado' no se puede fabricar por esta via -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'rol_asignado', 'x', '{}'::jsonb) as should_fail;
rollback;

\echo 'D7. filtros que no son un objeto -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'x', '[1,2]'::jsonb) as should_fail;
rollback;

\echo 'D8. filtros de mas de 2000 caracteres -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'x', jsonb_build_object('a', repeat('z', 2100))) as should_fail;
rollback;

\echo 'D9. recurso vacio -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', '   ', '{}'::jsonb) as should_fail;
rollback;

\echo 'D10. sesion de sistema no registra -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'x', '{}'::jsonb) as should_fail;
rollback;

\echo 'D11. anon no puede ejecutar el registro -- RECHAZADO'
begin;
set local role anon;
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'x', '{}'::jsonb) as should_fail;
rollback;

\echo 'E1. el superadmin completo lee la bitacora'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select count(*) as deberia_ser_1 from core.list_cfo_access_log_for_superadmin('00000000-0000-0000-0000-0000000f4100', 100, null);
rollback;

\echo 'E2. el rol finanzas NO lee la bitacora -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select count(*) as deberia_ser_0 from core.list_cfo_access_log_for_superadmin('00000000-0000-0000-0000-0000000f4101', 100, null);
rollback;

\echo 'E3. staff normal no lee la bitacora -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select count(*) as deberia_ser_0 from core.list_cfo_access_log_for_superadmin('00000000-0000-0000-0000-0000000f4102', 100, null);
rollback;

\echo 'E4. caller-binding en lectura (p_caller_id de superadmin con auth.uid() ajeno) -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4102', true);
select count(*) as deberia_ser_0 from core.list_cfo_access_log_for_superadmin('00000000-0000-0000-0000-0000000f4100', 100, null);
rollback;

\echo 'E5. sesion de sistema no lee la bitacora -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.list_cfo_access_log_for_superadmin('00000000-0000-0000-0000-0000000f4100', 100, null);
rollback;

\echo 'E6. anon no puede ejecutar la lectura de bitacora -- RECHAZADO'
begin;
set local role anon;
select * from core.list_cfo_access_log_for_superadmin('00000000-0000-0000-0000-0000000f4100', 100, null) as should_fail;
rollback;

\echo 'E8. el superadmin completo lista los roles asignados'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select count(*) as deberia_ser_1 from core.list_cfo_zone_roles_for_superadmin('00000000-0000-0000-0000-0000000f4100');
rollback;

\echo 'E9. el rol finanzas NO lista los roles -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_set_role('00000000-0000-0000-0000-0000000f4100', '00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres');
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4101', true);
select count(*) as deberia_ser_0 from core.list_cfo_zone_roles_for_superadmin('00000000-0000-0000-0000-0000000f4101');
rollback;

\echo 'E10. anon no puede ejecutar la lista de roles -- RECHAZADO'
begin;
set local role anon;
select * from core.list_cfo_zone_roles_for_superadmin('00000000-0000-0000-0000-0000000f4100') as should_fail;
rollback;

\echo 'F1. la bitacora es append-only: UPDATE rechazado incluso para el dueño'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
update core.cfo_access_log set recurso = 'alterado' returning 1 as should_fail;
rollback;

\echo 'F2. la bitacora es append-only: DELETE rechazado incluso para el dueño'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f4100', 'consulta', 'GET /superadmin/cfo/dashboard', '{"mes":"2026-03"}'::jsonb) as r;
reset role;
delete from core.cfo_access_log returning 1 as should_fail;
rollback;

\echo 'F3. authenticated no lee la bitacora directo -- RECHAZADO'
begin;
set local role authenticated;
select * from core.cfo_access_log as should_fail;
rollback;

\echo 'F4. anon no lee el rol directo -- RECHAZADO'
begin;
set local role anon;
select * from core.cfo_zone_role as should_fail;
rollback;

\echo 'F5. authenticated no inserta un rol directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
insert into core.cfo_zone_role (staff_user_id, rol, reason) values ('00000000-0000-0000-0000-0000000f4101', 'finanzas', 'Motivo de prueba con mas de veinte caracteres') returning 1 as should_fail;
rollback;

\echo 'F6. authenticated no inserta en la bitacora directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f4100', true);
insert into core.cfo_access_log (actor_user_id, actor_rol, accion, recurso) values ('00000000-0000-0000-0000-0000000f4100', 'superadmin', 'consulta', 'x') returning 1 as should_fail;
rollback;

\echo 'F7. ambas tablas tienen RLS habilitado'
select count(*) as deberia_ser_2 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'core' and c.relname in ('cfo_zone_role', 'cfo_access_log') and c.relrowsecurity;

\echo 'F8. ni anon ni authenticated tienen privilegio alguno sobre las tablas (ni por columna)'
select count(*) as deberia_ser_0 from information_schema.column_privileges where table_schema = 'core' and table_name in ('cfo_zone_role', 'cfo_access_log') and grantee in ('anon', 'authenticated', 'PUBLIC');
