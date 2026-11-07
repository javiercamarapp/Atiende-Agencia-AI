-- Verifica, contra Postgres REAL, packages/domain-hoteles/migrations/050_hoteles_inventario_e_impuestos_por_defecto.sql:
--   A) crear el primer tipo de habitacion siembra hoteles.tax_config con los DEFAULT (y no pisa una configuracion existente);
--   0) los DEFAULT sembrados quedan por confirmar (confirmed_at nulo) y el guardado de owner/gm (mismo upsert que set_tax_config de
--      #478) los confirma sin pisarse con la semilla;
--   B) hoteles.generar_inventario: owner/gm escribe; frontdesk, otra organizacion y anon no; rango validado; total_rooms = habitaciones
--      del tipo; idempotente; recalcula sin tocar booked_rooms y nunca deja total_rooms < booked_rooms;
--   C) hoteles.ajustar_inventario_tipo: +1 incremental sobre las noches existentes (respeta un total capturado a mano), crea solo las
--      faltantes, no toca otros tipos, -1 nunca baja de booked_rooms; mismos rechazos de autorizacion.
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): begin/rollback por escenario; deberia_ser_N = ultima fila vale N;
-- should_fail = el escenario debe terminar en ERROR.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000e5000', 'hoteles', 'Hotel A inventario', 'hotel-inv-a', 'active'),
  ('00000000-0000-0000-0000-0000000e5001', 'hoteles', 'Hotel B inventario', 'hotel-inv-b', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', 'hoteles', 'Propiedad A', 'active'),
  ('00000000-0000-0000-0000-0000000e5101', '00000000-0000-0000-0000-0000000e5001', 'hoteles', 'Propiedad B', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e5200', 'owner-a-inv@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5201', 'front-a-inv@example.com', 'Front A', 'seed'),
  ('00000000-0000-0000-0000-0000000e5202', 'owner-b-inv@example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e5200', '00000000-0000-0000-0000-0000000e5000', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e5201', '00000000-0000-0000-0000-0000000e5000', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000e5202', '00000000-0000-0000-0000-0000000e5001', null, 'owner', 'owner')
on conflict do nothing;
-- Hotel B ya tenia su tipo, habitaciones y una tax_config propia (ISH 5 %) antes de este archivo.
insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate) values
  ('00000000-0000-0000-0000-0000000e5101', '00000000-0000-0000-0000-0000000e5001', 0.16, 0.05)
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000e5301', '00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'Doble B')
on conflict do nothing;

\echo 'A1. owner crea su primer tipo de habitacion: la propiedad recibe tax_config con IVA 16 %, ISH 3 %, umbral 500 -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5200', true);
insert into hoteles.room_type (organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
reset role;
select (select count(*) from hoteles.tax_config where property_id = '00000000-0000-0000-0000-0000000e5100' and iva_rate = 0.16 and ish_rate = 0.03 and discount_threshold = 500
          and seeded_default and confirmed_at is null)::int as deberia_ser_1;
rollback;

\echo 'A2. una tax_config ya capturada no se pisa al crear otro tipo -- OK'
begin;
insert into hoteles.room_type (organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5001', '00000000-0000-0000-0000-0000000e5101', 'Suite B');
select (select count(*) from hoteles.tax_config where property_id = '00000000-0000-0000-0000-0000000e5101' and ish_rate = 0.05)::int as deberia_ser_1;
rollback;

\echo 'A3. authenticated no puede invocar la funcion del trigger -- RECHAZADO'
begin;
set local role authenticated;
select hoteles.room_type_tax_config_por_defecto() as should_fail;
rollback;

\echo 'A4. guardado del owner con el mismo upsert que set_tax_config (#478) sobre la fila sembrada: la confirma, sin conflicto -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5200', true);
insert into hoteles.room_type (organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
reset role;
-- set_tax_config es security definer (corre como el dueño de la funcion) con auth.uid() del owner: se reproduce igual.
insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate, discount_threshold, dsa_per_night)
values ('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', 0.16, 0.05, 500, 0)
on conflict (property_id) do update set iva_rate = excluded.iva_rate, ish_rate = excluded.ish_rate, updated_at = now();
select (select count(*) from hoteles.tax_config where property_id = '00000000-0000-0000-0000-0000000e5100' and ish_rate = 0.05
          and confirmed_at is not null and confirmed_by = '00000000-0000-0000-0000-0000000e5200')::int as deberia_ser_1;
rollback;

\echo 'A5. la semilla (generar_inventario) despues de un guardado confirmado no pisa nada -- OK'
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5200', true);
insert into hoteles.tax_config (property_id, organization_id, iva_rate, ish_rate) values ('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5000', 0.16, 0.05);
select set_config('request.jwt.claim.sub', '', true);
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date);
select (select count(*) from hoteles.tax_config where property_id = '00000000-0000-0000-0000-0000000e5100' and ish_rate = 0.05
          and not seeded_default and confirmed_at is not null)::int as deberia_ser_1;
rollback;

\echo 'B1. owner genera 30 noches: una fila por tipo y noche con total_rooms = habitaciones del tipo -- OK'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
insert into hoteles.room (organization_id, property_id, room_type_id, code) values
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', '101'),
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', '102');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5200', true);
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date + 29);
reset role;
select (select count(*) from hoteles.availability where property_id = '00000000-0000-0000-0000-0000000e5100' and total_rooms = 2 and booked_rooms = 0)::int as deberia_ser_30;
rollback;

\echo 'B2. idempotente y recalcula: tras una reserva y una habitacion nueva, total_rooms sube y booked_rooms se conserva -- OK'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
insert into hoteles.room (organization_id, property_id, room_type_id, code) values
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', '101');
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date + 2);
select * from hoteles.book_availability('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', current_date, 1);
insert into hoteles.room (organization_id, property_id, room_type_id, code) values
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', '102');
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date + 2);
select (select count(*) from hoteles.availability where property_id = '00000000-0000-0000-0000-0000000e5100' and date = current_date and total_rooms = 2 and booked_rooms = 1)::int as deberia_ser_1;
rollback;

\echo 'B3. frontdesk (sin rol de catalogo) no genera: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5201', true);
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date + 1) as should_fail;
rollback;

\echo 'B4. cross-tenant: owner de B no genera en A -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5202', true);
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date + 1) as should_fail;
rollback;

\echo 'B5. rango de mas de 400 noches -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5200', true);
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date + 400) as should_fail;
rollback;

\echo 'B6. rango en el pasado -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5200', true);
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date - 10, current_date) as should_fail;
rollback;

\echo 'B7. anon no ejecuta -- RECHAZADO'
begin;
set local role anon;
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date + 1) as should_fail;
rollback;

\echo 'B8. sesion de sistema genera; tambien siembra tax_config si faltaba (hotel anterior a este archivo) -- OK'
begin;
alter table hoteles.room_type disable trigger room_type_tax_config_por_defecto;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
alter table hoteles.room_type enable trigger room_type_tax_config_por_defecto;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date);
reset role;
select ((select count(*) from hoteles.tax_config where property_id = '00000000-0000-0000-0000-0000000e5100') + (select count(*) from hoteles.availability where property_id = '00000000-0000-0000-0000-0000000e5100' and total_rooms = 0))::int as deberia_ser_2;
rollback;

\echo 'B9. propiedad que no es de hoteles: P0002 -- RECHAZADO'
begin;
select * from hoteles.generar_inventario('00000000-0000-0000-0000-000000000000', current_date, current_date) as should_fail;
rollback;

\echo 'B10. generar_inventario nunca deja total_rooms por debajo de booked_rooms (se borro una habitacion con noches vendidas) -- OK'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
insert into hoteles.room (id, organization_id, property_id, room_type_id, code) values
  ('00000000-0000-0000-0000-0000000e5400', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', '101'),
  ('00000000-0000-0000-0000-0000000e5401', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', '102');
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date);
update hoteles.availability set booked_rooms = 2 where property_id = '00000000-0000-0000-0000-0000000e5100' and date = current_date;
delete from hoteles.room where id = '00000000-0000-0000-0000-0000000e5401';
select * from hoteles.generar_inventario('00000000-0000-0000-0000-0000000e5100', current_date, current_date);
select (select count(*) from hoteles.availability where property_id = '00000000-0000-0000-0000-0000000e5100' and date = current_date and total_rooms = 2 and booked_rooms = 2)::int as deberia_ser_1;
rollback;

\echo 'C1. ajustar_inventario_tipo +1: suma a lo capturado a mano, crea solo las noches faltantes y no toca otro tipo -- OK'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble'),
  ('00000000-0000-0000-0000-0000000e5302', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Suite');
-- Noche de hoy capturada a mano con 5 (otro criterio); la de manana no existe. La Suite tiene 7 capturadas.
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms) values
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', current_date, 5),
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5302', current_date, 7);
insert into hoteles.room (organization_id, property_id, room_type_id, code) values
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', '101');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5200', true);
select * from hoteles.ajustar_inventario_tipo('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', 1, current_date, current_date + 1);
reset role;
select ((select count(*) from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000e5300' and date = current_date and total_rooms = 6)
      + (select count(*) from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000e5300' and date = current_date + 1 and total_rooms = 1)
      + (select count(*) from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000e5302' and date = current_date and total_rooms = 7))::int as deberia_ser_3;
rollback;

\echo 'C2. ajustar_inventario_tipo -1 nunca baja de booked_rooms -- OK'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms, booked_rooms) values
  ('00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', current_date, 2, 2);
select * from hoteles.ajustar_inventario_tipo('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', -1, current_date, current_date);
select (select count(*) from hoteles.availability where room_type_id = '00000000-0000-0000-0000-0000000e5300' and date = current_date and total_rooms = 2 and booked_rooms = 2)::int as deberia_ser_1;
rollback;

\echo 'C3. frontdesk no ajusta: 42501 -- RECHAZADO'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5201', true);
select * from hoteles.ajustar_inventario_tipo('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', 1, current_date, current_date) as should_fail;
rollback;

\echo 'C4. cross-tenant: owner de B no ajusta un tipo de A -- RECHAZADO'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5202', true);
select * from hoteles.ajustar_inventario_tipo('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', 1, current_date, current_date) as should_fail;
rollback;

\echo 'C5. tipo de otra propiedad (B) pasado con la propiedad A: P0002 -- RECHAZADO'
begin;
select * from hoteles.ajustar_inventario_tipo('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5301', 1, current_date, current_date) as should_fail;
rollback;

\echo 'C6. delta distinto de -1/+1 -- RECHAZADO'
begin;
insert into hoteles.room_type (id, organization_id, property_id, name) values ('00000000-0000-0000-0000-0000000e5300', '00000000-0000-0000-0000-0000000e5000', '00000000-0000-0000-0000-0000000e5100', 'Doble');
select * from hoteles.ajustar_inventario_tipo('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', 5, current_date, current_date) as should_fail;
rollback;

\echo 'C7. anon no ejecuta -- RECHAZADO'
begin;
set local role anon;
select * from hoteles.ajustar_inventario_tipo('00000000-0000-0000-0000-0000000e5100', '00000000-0000-0000-0000-0000000e5300', 1, current_date, current_date) as should_fail;
rollback;

\echo ''
\echo 'Fin.'
