-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), packages/db/migrations/0071_alta_sucursal_propiedad.sql:
--   A) dueño/admin de toda la organizacion crea sucursal/propiedad; staff, admin acotado, otra organizacion, sistema y anon no.
--   B) detalle por vertical (restaurantes branch_detail con slug unico, citas/hoteles property_config, licitaciones solo core.property).
--   C) reglas: nombre, zona IANA, nombre repetido, tope de licitaciones, organizacion suspendida, despachos/rentas rechazadas.
--   D) superadmin: con su uid y motivo; staff normal no; caller-binding falso no.
--   E) bitacora: una fila por alta, legible solo por owner/admin de la organizacion; sin escritura directa; interno sin EXECUTE.
--   T) tope de una sola fuente (core.propiedad_tope_por_organizacion, tope temporal hasta ligarlo al plan); sin EXECUTE para authenticated.
--   S) slug: nunca empieza ni termina en '-' (btrim despues del corte a 60).
--   F) la sucursal nace inactiva; nearest_branch_by_colonia no la ofrece; activacion explicita (core.activar_propiedad_organizacion):
--      positivo con la configuracion completa, rechazo con pasos pendientes por vertical, staff/otra organizacion/propiedad ajena/
--      sistema/anon rechazados, sucursal que no vino del alta rechazada, idempotencia y bitacora 'activacion'.
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

\echo 'A1. dueño de restaurantes crea su primera sucursal INACTIVA: branch_detail con slug derivado -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Centro Histórico', 'America/Merida');
reset role;
select (select count(*) from core.property p join restaurantes.branch_detail bd on bd.property_id = p.id
  where p.organization_id = '00000000-0000-0000-0000-0000000a7100' and bd.slug = 'sucursal-centro-historico' and bd.zona_horaria = 'America/Merida' and p.status = 'inactive')::int as deberia_ser_1;
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

\echo 'T1. tope de restaurantes: 50 (una sola fuente) -- OK'
begin;
select core.propiedad_tope_por_organizacion('restaurantes') as deberia_ser_50;
rollback;

\echo 'T2. tope de licitaciones: 1 -- OK'
begin;
select core.propiedad_tope_por_organizacion('licitaciones') as deberia_ser_1;
rollback;

\echo 'T3. authenticated no ejecuta la funcion del tope -- RECHAZADO'
begin;
set local role authenticated;
select core.propiedad_tope_por_organizacion('restaurantes') as should_fail;
rollback;

\echo 'S1. el corte a 60 cae en un guion: el slug no termina en guion -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', repeat('a', 59) || ' b', null);
reset role;
select (select count(*) from restaurantes.branch_detail where organization_id = '00000000-0000-0000-0000-0000000a7100' and slug = repeat('a', 59))::int as deberia_ser_1;
rollback;

\echo 'S2. ningun slug empieza ni termina en guion (signos al inicio/fin y corte a 60) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select count(*) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', '¡¡Centro Norte!!', null);
select count(*) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', repeat('b', 59) || ' c', null);
reset role;
select (select count(*) from restaurantes.branch_detail where organization_id = '00000000-0000-0000-0000-0000000a7100' and slug ~ '(^-|-$)')::int as deberia_ser_0;
rollback;

\echo 'F1. sucursal recien creada (inactiva) con coordenadas y colonia conocida: nearest_branch_by_colonia NO la ofrece -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Oculta', null);
reset role;
update restaurantes.branch_detail set lat = 20.97, lng = -89.62 where property_id = current_setting('verify.prop')::uuid;
insert into restaurantes.known_zone (organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000a7100', 'Colonia Verificada', 20.97, -89.62);
select (select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000a7100', 'Colonia Verificada'))::int as deberia_ser_0;
rollback;

\echo 'F2. control: la misma sucursal ya activa SI la ofrece (el filtro de status es lo que la excluye) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Oculta', null);
reset role;
update restaurantes.branch_detail set lat = 20.97, lng = -89.62 where property_id = current_setting('verify.prop')::uuid;
insert into restaurantes.known_zone (organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000a7100', 'Colonia Verificada', 20.97, -89.62);
update core.property set status = 'active' where id = current_setting('verify.prop')::uuid;
select (select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000a7100', 'Colonia Verificada'))::int as deberia_ser_1;
rollback;

\echo 'F3. restaurantes: activar sin menu/horario/cobertura (55000) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Vacia', null);
select * from core.activar_propiedad_organizacion('resto-alta', 'restaurantes', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F4. restaurantes: con menu y horario pero sin cobertura de entrega -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Casi', null);
reset role;
insert into restaurantes.products (id, organization_id, name, price) values ('00000000-0000-0000-0000-0000000a7400', '00000000-0000-0000-0000-0000000a7100', 'Taco', 25);
insert into restaurantes.branch_products (property_id, product_id, price) values (current_setting('verify.prop')::uuid, '00000000-0000-0000-0000-0000000a7400', 25);
insert into restaurantes.branch_policy (property_id, organization_id, horario) values (current_setting('verify.prop')::uuid, '00000000-0000-0000-0000-0000000a7100', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"22:00"}]'::jsonb);
set local role authenticated;
select * from core.activar_propiedad_organizacion('resto-alta', 'restaurantes', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F5. restaurantes: configuracion completa -> el dueño la activa, queda active, bitacora activacion y nearest_branch ya la ofrece -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('resto-alta', 'restaurantes', 'Sucursal Lista', null);
reset role;
insert into restaurantes.products (id, organization_id, name, price) values ('00000000-0000-0000-0000-0000000a7401', '00000000-0000-0000-0000-0000000a7100', 'Taco', 25);
insert into restaurantes.branch_products (property_id, product_id, price) values (current_setting('verify.prop')::uuid, '00000000-0000-0000-0000-0000000a7401', 25);
insert into restaurantes.branch_policy (property_id, organization_id, horario) values (current_setting('verify.prop')::uuid, '00000000-0000-0000-0000-0000000a7100', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"22:00"}]'::jsonb);
insert into restaurantes.known_zone (id, organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000a7500', '00000000-0000-0000-0000-0000000a7100', 'Colonia Verificada', 20.97, -89.62);
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id) values (current_setting('verify.prop')::uuid, '00000000-0000-0000-0000-0000000a7500', '00000000-0000-0000-0000-0000000a7100');
update restaurantes.branch_detail set lat = 20.97, lng = -89.62 where property_id = current_setting('verify.prop')::uuid;
set local role authenticated;
select count(*) from core.activar_propiedad_organizacion('resto-alta', 'restaurantes', current_setting('verify.prop')::uuid);
reset role;
select ((select count(*) from core.property where id = current_setting('verify.prop')::uuid and status = 'active')
      + (select count(*) from core.propiedad_alta_log where property_id = current_setting('verify.prop')::uuid and accion = 'activacion' and actor_user_id = '00000000-0000-0000-0000-0000000a7200')
      + (select count(*) from restaurantes.nearest_branch_by_colonia('00000000-0000-0000-0000-0000000a7100', 'Colonia Verificada')))::int as deberia_ser_3;
rollback;

\echo 'F6. citas: activar sin servicio/proveedor/horario -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('citas-alta', 'citas', 'Consultorio Nuevo', null);
select * from core.activar_propiedad_organizacion('citas-alta', 'citas', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F7. hoteles: activar sin habitaciones ni tarifas -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('hotel-alta', 'hoteles', 'Hotel Nuevo', null);
select * from core.activar_propiedad_organizacion('hotel-alta', 'hoteles', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F8. licitaciones (sin pasos): activacion explicita; repetirla es idempotente (una sola fila activacion) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('lici-alta', 'licitaciones', 'Empresa', null);
select count(*) from core.activar_propiedad_organizacion('lici-alta', 'licitaciones', current_setting('verify.prop')::uuid);
select count(*) from core.activar_propiedad_organizacion('lici-alta', 'licitaciones', current_setting('verify.prop')::uuid);
reset role;
select ((select count(*) from core.property where id = current_setting('verify.prop')::uuid and status = 'active')
      + (select count(*) from core.propiedad_alta_log where property_id = current_setting('verify.prop')::uuid and accion = 'activacion'))::int as deberia_ser_2;
rollback;

\echo 'F9. staff (member) no activa -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('lici-alta', 'licitaciones', 'Empresa', null);
reset role;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a7201', '00000000-0000-0000-0000-0000000a7103', null, 'member', 'staff');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7201', true);
select * from core.activar_propiedad_organizacion('lici-alta', 'licitaciones', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F10. cross-tenant: usuario sin membresia en la organizacion no activa -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('lici-alta', 'licitaciones', 'Empresa', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7202', true);
select * from core.activar_propiedad_organizacion('lici-alta', 'licitaciones', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F11. cross-tenant: el dueño no activa por su organizacion una propiedad de OTRA organizacion (P0002) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('lici-alta', 'licitaciones', 'Empresa', null);
select * from core.activar_propiedad_organizacion('resto-alta', 'restaurantes', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F12. sesion de sistema (uid nulo) no activa -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select set_config('verify.prop', out_property_id::text, true) from core.crear_propiedad_organizacion('lici-alta', 'licitaciones', 'Empresa', null);
select set_config('request.jwt.claim.sub', '', true);
select * from core.activar_propiedad_organizacion('lici-alta', 'licitaciones', current_setting('verify.prop')::uuid) as should_fail;
rollback;

\echo 'F13. anon no ejecuta la activacion -- RECHAZADO'
begin;
set local role anon;
select * from core.activar_propiedad_organizacion('lici-alta', 'licitaciones', '00000000-0000-0000-0000-0000000a7399') as should_fail;
rollback;

\echo 'F14. una sucursal inactiva que NO vino del alta (la dejo inactiva la plataforma) no la activa el dueño (42501) -- RECHAZADO'
begin;
insert into core.property (id, organization_id, name, status) values ('00000000-0000-0000-0000-0000000a7303', '00000000-0000-0000-0000-0000000a7103', 'De plataforma', 'inactive');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.activar_propiedad_organizacion('lici-alta', 'licitaciones', '00000000-0000-0000-0000-0000000a7303') as should_fail;
rollback;

\echo 'F15. organizacion suspendida: no activa (42501) -- RECHAZADO'
begin;
insert into core.property (id, organization_id, name, status) values ('00000000-0000-0000-0000-0000000a7304', '00000000-0000-0000-0000-0000000a7105', 'Suspendida', 'inactive');
insert into core.propiedad_alta_log (organization_id, property_id, vertical, origen, accion, actor_user_id) values
  ('00000000-0000-0000-0000-0000000a7105', '00000000-0000-0000-0000-0000000a7304', 'restaurantes', 'dueno', 'alta', '00000000-0000-0000-0000-0000000a7200');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.activar_propiedad_organizacion('resto-susp', 'restaurantes', '00000000-0000-0000-0000-0000000a7304') as should_fail;
rollback;

\echo 'F16. los pasos de activacion son internos: authenticated no los ejecuta -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a7200', true);
select * from core.propiedad_pasos_activacion('00000000-0000-0000-0000-0000000a7399') as should_fail;
rollback;

\echo ''
\echo 'Fin.'
