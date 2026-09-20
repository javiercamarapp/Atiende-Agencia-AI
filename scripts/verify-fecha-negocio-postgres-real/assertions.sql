-- f2-current-date-fecha-negocio (revisión del 19-sep): ejerce, contra Postgres REAL
-- (no el repositorio en memoria, que nunca ejecuta SQL), el SQL EXACTO -- copiado
-- literal de los 4 sitios corregidos, no reescrito de memoria -- que antes llamaba
-- `current_date` (día UTC de la SESIÓN de Postgres) para decidir "hoy" y ahora recibe
-- ese día como parámetro explícito ($n::date), resuelto UNA vez en TypeScript con
-- `@atiende/core-tenancy::hoyFechaNegocio()`:
--   1. `packages/domain-hoteles/src/postgres-repository.ts::findDueNoShowReservations`
--   2. `packages/domain-rentas/src/postgres-repository.ts::loadPricingContext`
--   3. `packages/domain-rentas/src/limpieza/aplicacion/tareas.ts::procesarCheckoutsPendientes`
--   4. `packages/domain-licitaciones/src/postgres-repository.ts::createApprovedRate`
--
-- Como no hay forma de correr el repositorio Postgres real desde vitest (ver
-- CLAUDE.md/brief de esta tarea), cada escenario reproduce la ventana horaria del bug
-- (18:00-23:59 CDMX, donde el día UTC de la sesión YA es MAÑANA) con
-- `set local timezone to 'Etc/GMT-12'` (UTC+12: exactamente 24h por delante de
-- 'Etc/GMT+12', así que `current_date` de ESTA sesión es SIEMPRE, sin depender del
-- reloj real de quien corre el gate, un día calendario por delante de
-- `current_date - 1` -- el equivalente determinista de "el día de negocio real" en la
-- ventana del bug) y demuestra que el SQL real, con el parámetro explícito
-- (`current_date - 1`), NUNCA ve una fila cuya fecha cae en `current_date` de la
-- sesión (que un `current_date` sin parametrizar SÍ habría visto) -- más un control
-- positivo por escenario (parámetro = `current_date`) para confirmar que la query no
-- es simplemente "siempre vacía".
--
-- Corre bajo `service_role` (bypassrls), mismo criterio y misma razón que
-- verify-despachos-fechas-postgres-real/: lo que se verifica es la VALIDEZ/
-- COMPORTAMIENTO del SQL en sí, no RLS/GRANT (ya cubierto por
-- verify-rentas-cron-rls/verify-outbox-grants/verify-hoteles-sql-critico).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000e0', 'hoteles', 'Hotel de Prueba SA', 'hotel-verify-fecha-negocio')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000e0', 'hoteles', 'Sede Centro')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000f0', 'rentas', 'Rentas de Prueba SA', 'rentas-verify-fecha-negocio')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f0', 'rentas', 'Depa Centro')
on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000f1', 'Depa 101')
on conflict do nothing;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000c0', 'licitaciones', 'Consultoria de Prueba SA', 'lic-verify-fecha-negocio')
on conflict do nothing;

\echo ''
\echo '=== 1. hoteles.reservation -- findDueNoShowReservations: check_in_date = current_date de la sesion, parametro = dia de negocio (current_date - 1) -> NUNCA la reclama ==='
begin;
set local role service_role;
set local timezone to 'Etc/GMT-12';
insert into hoteles.reservation (id, organization_id, property_id, check_in_date, check_out_date, status, total_amount)
  values ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', current_date, current_date + 1, 'confirmada', 1500.00);
select count(*) as reclamadas_con_dia_de_negocio_deberia_ser_0
  from hoteles.reservation
 where property_id = '00000000-0000-0000-0000-0000000000e1' and status = 'confirmada' and check_in_date <= (current_date - 1)::date;
rollback;

\echo '=== 2. ... CONTROL: mismo check_in_date, parametro = current_date (mismo dia) -> SI la reclama (la query no es siempre-vacia) ==='
begin;
set local role service_role;
set local timezone to 'Etc/GMT-12';
insert into hoteles.reservation (id, organization_id, property_id, check_in_date, check_out_date, status, total_amount)
  values ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000e1', current_date, current_date + 1, 'confirmada', 1500.00);
select count(*) as reclamadas_con_current_date_deberia_ser_1
  from hoteles.reservation
 where property_id = '00000000-0000-0000-0000-0000000000e1' and status = 'confirmada' and check_in_date <= current_date::date;
rollback;

\echo '=== 3. rentas.tarifa_base -- loadPricingContext: tarifa nueva vigente_desde = current_date de la sesion, parametro = dia de negocio (current_date - 1) -> usa la tarifa VIEJA, nunca la nueva ==='
begin;
set local role service_role;
set local timezone to 'Etc/GMT-12';
insert into rentas.tarifa_base (id, organization_id, property_id, unidad_id, precio_noche_centavos, moneda, vigente_desde) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', 100000, 'MXN', current_date - 30),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', 200000, 'MXN', current_date);
select precio_noche_centavos as precio_con_dia_de_negocio_deberia_ser_100000
  from rentas.tarifa_base
 where unidad_id = '00000000-0000-0000-0000-0000000000f2' and vigente_desde <= (current_date - 1)::date
 order by vigente_desde desc limit 1;
rollback;

\echo '=== 4. ... CONTROL: mismas 2 tarifas, parametro = current_date (mismo dia que la nueva) -> SI usa la nueva ==='
begin;
set local role service_role;
set local timezone to 'Etc/GMT-12';
insert into rentas.tarifa_base (id, organization_id, property_id, unidad_id, precio_noche_centavos, moneda, vigente_desde) values
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', 100000, 'MXN', current_date - 30),
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', 200000, 'MXN', current_date);
select precio_noche_centavos as precio_con_current_date_deberia_ser_200000
  from rentas.tarifa_base
 where unidad_id = '00000000-0000-0000-0000-0000000000f2' and vigente_desde <= current_date::date
 order by vigente_desde desc limit 1;
rollback;

\echo '=== 5. rentas.ocupacion -- procesarCheckoutsPendientes: checkout (upper(rango)) = current_date de la sesion, parametro = dia de negocio (current_date - 1) -> NUNCA lo procesa todavia ==='
begin;
set local role service_role;
set local timezone to 'Etc/GMT-12';
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante) values
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', daterange(current_date - 3, current_date, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true);
select count(*) as checkouts_pendientes_con_dia_de_negocio_deberia_ser_0
  from rentas.ocupacion o
 where o.capa = 'reserva' and o.estado = 'confirmado' and o.bloqueante
   and upper(o.rango) <= (current_date - 1)::date
   and not exists (select 1 from rentas.tarea_operativa t where t.ocupacion_unidad_id = o.id and t.tipo = 'limpieza');
rollback;

\echo '=== 6. ... CONTROL: mismo checkout, parametro = current_date (mismo dia) -> SI lo procesa ==='
begin;
set local role service_role;
set local timezone to 'Etc/GMT-12';
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante) values
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000f0', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f2', daterange(current_date - 3, current_date, '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true);
select count(*) as checkouts_pendientes_con_current_date_deberia_ser_1
  from rentas.ocupacion o
 where o.capa = 'reserva' and o.estado = 'confirmado' and o.bloqueante
   and upper(o.rango) <= current_date::date
   and not exists (select 1 from rentas.tarea_operativa t where t.ocupacion_unidad_id = o.id and t.tipo = 'limpieza');
rollback;

\echo '=== 7. licitaciones.approved_rate -- createApprovedRate: el INSERT ya NO hace coalesce(valid_from, current_date) -- un valid_from NULL debe FALLAR fuerte (columna not null), nunca caer en silencio al dia de la sesion ==='
begin;
set local role service_role;
insert into licitaciones.approved_rate (organization_id, concept, unit_price, approval_status, valid_from, valid_until)
  values ('00000000-0000-0000-0000-0000000000c0', 'concepto_verify_null', 100.00, 'pendiente_aprobacion', null::date, null)
  returning id as should_fail;
rollback;

\echo '=== 8. ... CONTROL: con valid_from explicito (el dia de negocio que TypeScript ya resolvio), INSERT ... RETURNING conserva ESE valor exacto ==='
begin;
set local role service_role;
insert into licitaciones.approved_rate (organization_id, concept, unit_price, approval_status, valid_from, valid_until)
  values ('00000000-0000-0000-0000-0000000000c0', 'concepto_verify_explicito', 100.00, 'pendiente_aprobacion', '2020-01-01'::date, null)
  returning case when valid_from = '2020-01-01'::date then 1 else 0 end as valid_from_es_el_parametro_explicito_deberia_ser_1;
rollback;

\echo ''
\echo '==> listo -- revisa arriba: los escenarios marcados "deberia_ser_0" deben dar 0 filas/0 (el dia de negocio ganó sobre current_date de la sesión), los "deberia_ser_1"/"_200000"/"_100000" deben dar ese valor exacto (la query no quedó siempre-vacía), y el escenario 7 ("should_fail") debe terminar en ERROR de Postgres real (columna not null), nunca en un INSERT silencioso con el día de la sesión.'
