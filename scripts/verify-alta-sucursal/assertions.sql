-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), packages/db/migrations/0071_alta_sucursal_propiedad.sql:
--   A) dueño/admin de toda la organizacion crea sucursal/propiedad; staff, admin acotado, otra organizacion, sistema y anon no.
--   B) detalle por vertical (restaurantes branch_detail con slug unico, citas/hoteles property_config, licitaciones solo core.property).
--   C) reglas: nombre, zona IANA, nombre repetido, tope de licitaciones, organizacion suspendida, despachos/rentas rechazadas.
--   D) superadmin: con su uid y motivo; staff normal no; caller-binding falso no.
--   E) bitacora: una fila por alta, legible solo por owner/admin de la organizacion; sin escritura directa; interno sin EXECUTE.
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): begin/rollback por escenario; deberia_ser_N = ultima fila vale N;
-- should_fail = el escenario debe terminar en ERROR.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000a7100', 'restaurantes', 'Resto alta', 'resto-alta', 'trial'),
  ('00000000-0000-0000-0000-0000000a7101', 'citas', 'Citas alta', 'citas-alta', 'trial'),
  ('00000000-0000-0000-0000-0000000a7102', 'hoteles', 'Hotel alta', 'hotel-alta', 'trial'),
  ('00000000-0000-0000-0000-0000000a7103', 'licitaciones', 'Lici alta', 'lici-alta', 'trial'),
  ('00000000-0000-0000-0000-0000000a7104', 'despachos', 'Desp alta', 'desp-alta', 'trial'),
  ('00000000-0000-0000-0000-0000000a7105', 'restaurantes', 'Resto suspendido', 'resto-susp', 'suspended')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a7200', 'dueno-alta@example.com', 'Dueno', 'seed'),
  ('00000000-0000-0000-0000-0000000a7201', 'staff-alta@example.com', 'Staff', 'seed'),
  ('00000000-0000-0000-0000-0000000a7202', 'otro-alta@example.com', 'Otro', 'seed'),
  ('00000000-0000-0000-0000-0000000a7203', 'sa-alta@example.com', 'Superadmin', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000a7203') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a7200', '00000000-0000-0000-0000-0000000a7100', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a7200', '00000000-0000-0000-0000-0000000a7101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a7200', '00000000-0000-0000-0000-0000000a7102', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a7200', '00000000-0000-0000-0000-0000000a7103', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a7200', '00000000-0000-0000-0000-0000000a7104', null, 'owner', 'admin'),
  ('00000000-0000-0000-0000-0000000a7200', '00000000-0000-0000-0000-0000000a7105', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a7201', '00000000-0000-0000-0000-0000000a7100', null, 'member', 'staff')
on conflict do nothing;

\echo 'A1. dueño de restaurantes crea su primera sucursal: branch_detail con slug derivado -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Centro Histórico', 'America/Merida');
reset role;
select (select count(*) from core.property p join restaurantes.branch_detail bd on bd.property_id = p.id
  where p.organization_id = '00000000-0000-0000-0000-0000000a7100' and bd.slug = 'sucursal-centro-historico' and bd.zona_horaria = 'America/Merida' and p.status = 'active')::int as deberia_ser_1;
rollback;

\echo 'A2. staff (member) no crea: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7201', true);
select * from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Norte', null) as should_fail;
rollback;

\echo 'A3. admin acotado a sucursales (property_ids no nulo) no crea -- RECHAZADO'
begin;
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000a7300', '00000000-0000-0000-0000-0000000a7100', 'Existente');
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a7202', '00000000-0000-0000-0000-0000000a7100', array['00000000-0000-0000-0000-0000000a7300']::uuid[], 'admin', 'admin');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7202', true);
select * from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Sur', null) as should_fail;
rollback;

\echo 'A4. cross-tenant: un usuario sin membresia en la organizacion no crea -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7202', true);
select * from core.crear_propiedad_organizacion('citas-alta', 'citas', 'Consultorio', null) as should_fail;
rollback;

\echo 'A5. sesion de sistema (uid nulo) no usa la funcion del dueño -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.crear_propiedad_organizacion('citas-alta', 'citas', 'Consultorio', null) as should_fail;
rollback;

\echo 'A6. anon no ejecuta -- RECHAZADO'
begin;
set local role anon;
select * from core.crear_propiedad_organizacion('citas-alta', 'citas', 'Consultorio', null) as should_fail;
rollback;

\echo 'B1. citas: property_config con la zona por omision America/Mexico_City -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('citas-alta', 'citas', 'Consultorio Norte', null);
reset role;
select (select count(*) from citas.property_config where organization_id = '00000000-0000-0000-0000-0000000a7101' and timezone = 'America/Mexico_City')::int as deberia_ser_1;
rollback;

\echo 'B2. hoteles: property_config con la zona indicada -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('hotel-alta', 'hoteles', 'Hotel Centro', 'America/Cancun');
reset role;
select (select count(*) from hoteles.property_config where organization_id = '00000000-0000-0000-0000-0000000a7102' and timezone = 'America/Cancun')::int as deberia_ser_1;
rollback;

\echo 'B3. dos sucursales con el mismo slug base reciben slugs distintos -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Centro', null);
select count(*) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Centro!', null);
reset role;
select (select count(distinct slug) from restaurantes.branch_detail where organization_id = '00000000-0000-0000-0000-0000000a7100')::int as deberia_ser_2;
rollback;

\echo 'C1. licitaciones: la segunda propiedad excede el tope (54000) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('lici-alta', 'licitaciones', 'Empresa', null);
select * from core.crear_propiedad_organizacion('lici-alta', 'licitaciones', 'Otra empresa', null) as should_fail;
rollback;

\echo 'C2. nombre repetido sin distinguir mayusculas (23505) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('hotel-alta', 'hoteles', 'Hotel Centro', null);
select * from core.crear_propiedad_organizacion('hotel-alta', 'hoteles', 'HOTEL CENTRO', null) as should_fail;
rollback;

\echo 'C3. zona horaria inexistente (22023) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.crear_propiedad_organizacion('hotel-alta', 'hoteles', 'Hotel Playa', 'Mars/Olympus') as should_fail;
rollback;

\echo 'C4. despachos usa su cartera (22023) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.crear_propiedad_organizacion('desp-alta', 'despachos', 'Cliente', null) as should_fail;
rollback;

\echo 'C5. organizacion suspendida (42501) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.crear_propiedad_organizacion('resto-susp', 'restaurantes', 'Sucursal', null) as should_fail;
rollback;

\echo 'C6. slug de una vertical por la ruta de otra: P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.crear_propiedad_organizacion('hotel-alta', 'citas', 'Sucursal', null) as should_fail;
rollback;

\echo 'D1. superadmin crea con motivo; la bitacora dice origen superadmin -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7203', true);
select count(*) from core.superadmin_crear_propiedad('00000000-0000-0000-0000-0000000a7203', '00000000-0000-0000-0000-0000000a7102', 'Hotel Asistido', null, 'Alta asistida de la primera propiedad del hotel');
reset role;
select (select count(*) from core.propiedad_alta_log where organization_id = '00000000-0000-0000-0000-0000000a7102' and origen = 'superadmin' and actor_user_id = '00000000-0000-0000-0000-0000000a7203')::int as deberia_ser_1;
rollback;

\echo 'D2. superadmin con motivo corto (22023) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7203', true);
select * from core.superadmin_crear_propiedad('00000000-0000-0000-0000-0000000a7203', '00000000-0000-0000-0000-0000000a7102', 'Hotel Asistido', null, 'corto') as should_fail;
rollback;

\echo 'D3. un dueño no usa la funcion del superadmin (42501) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.superadmin_crear_propiedad('00000000-0000-0000-0000-0000000a7200', '00000000-0000-0000-0000-0000000a7102', 'Hotel Asistido', null, 'Alta asistida de la primera propiedad del hotel') as should_fail;
rollback;

\echo 'D4. caller-binding falso (uid del dueño con el id del superadmin) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.superadmin_crear_propiedad('00000000-0000-0000-0000-0000000a7203', '00000000-0000-0000-0000-0000000a7102', 'Hotel Asistido', null, 'Alta asistida de la primera propiedad del hotel') as should_fail;
rollback;

\echo 'E1. bitacora: el dueño ve su alta -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('citas-alta', 'citas', 'Consultorio Sur', null);
select (select count(*) from core.propiedad_alta_log where origen = 'dueno')::int as deberia_ser_1;
rollback;

\echo 'E2. bitacora: el staff (member) no la ve -- OK'
begin;
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000a7301', '00000000-0000-0000-0000-0000000a7100', 'Existente');
insert into core.propiedad_alta_log (organization_id, property_id, vertical, origen, actor_user_id) values
  ('00000000-0000-0000-0000-0000000a7100', '00000000-0000-0000-0000-0000000a7301', 'restaurantes', 'dueno', '00000000-0000-0000-0000-0000000a7200');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7201', true);
select (select count(*) from core.propiedad_alta_log)::int as deberia_ser_0;
rollback;

\echo 'E3. sin escritura directa en la bitacora -- RECHAZADO'
begin;
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000a7302', '00000000-0000-0000-0000-0000000a7100', 'Existente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
insert into core.propiedad_alta_log (organization_id, property_id, vertical, origen, actor_user_id) values
  ('00000000-0000-0000-0000-0000000a7100', '00000000-0000-0000-0000-0000000a7302', 'restaurantes', 'dueno', '00000000-0000-0000-0000-0000000a7200') returning 1 as should_fail;
rollback;

\echo 'E4. el cuerpo interno no es ejecutable por authenticated -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.crear_propiedad_interna('00000000-0000-0000-0000-0000000a7100', 'Atajo', null, '00000000-0000-0000-0000-0000000a7200', 'dueno', null) as should_fail;
rollback;

\echo ''
\echo 'Fin.'
