-- Fixtures + assertions contra Postgres REAL (RLS / GRANT por columna / auth.uid() / security definer / triggers reales: el repositorio en
-- memoria de domain-rentas nunca los aplica) de la migracion packages/domain-rentas/migrations/035_rentas_finanzas_autopiloto.sql:
--   A. columnas codigo_confirmacion / telefono_ultimos4 de rentas.ocupacion (forma, RLS heredada)
--   B. rentas.importacion_pagos(+_linea): RLS por rol y entre tenants, anon, unique por huella (idempotencia), GRANT por columna
--   C. trigger que marca reserva_financiero.requiere_revision al cambiar fechas o cancelar (security definer, cualquier staff de la property)
--   D. rentas.system_reservas_sin_movimiento: solo sesion de sistema, conteos por organizacion
--   E. purga de retencion rentas_huesped_pii: tambien limpia telefono_ultimos4 (y sigue anonimizando huespedes como en 028)
--   F. el statement del mes incluye los movimientos creados por la importacion (misma consulta que PostgresRentasRepository)
--
-- Run via scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con ./run.sh. Cada escenario corre en su propio
-- `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000f35001', 'rentas', 'Org A (finanzas autopiloto)', 'org-a-finanzas-autopiloto'),
  ('00000000-0000-0000-0000-000000f35002', 'rentas', 'Org B (finanzas autopiloto, ajena)', 'org-b-finanzas-autopiloto')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35001', 'rentas', 'Property A'),
  ('00000000-0000-0000-0000-000000f35011', '00000000-0000-0000-0000-000000f35002', 'rentas', 'Property B (ajena)')
on conflict do nothing;
insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values
  ('00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35001', 'America/Merida', 'MXN'),
  ('00000000-0000-0000-0000-000000f35011', '00000000-0000-0000-0000-000000f35002', 'America/Merida', 'MXN')
on conflict do nothing;
insert into rentas.owner (id, name) values ('00000000-0000-0000-0000-000000f35070', 'Propietario de prueba') on conflict do nothing;
insert into rentas.owner_organization (owner_id, organization_id) values ('00000000-0000-0000-0000-000000f35070', '00000000-0000-0000-0000-000000f35001') on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches, owner_id) values
  ('00000000-0000-0000-0000-000000f35020', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', 'Unidad A1', 1, '00000000-0000-0000-0000-000000f35070'),
  ('00000000-0000-0000-0000-000000f35021', '00000000-0000-0000-0000-000000f35002', '00000000-0000-0000-0000-000000f35011', 'Unidad B1 (ajena)', 1, null)
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000f35030', 'admin-a-fin@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000f35031', 'contador-a-fin@example.com', 'Contador Org A', 'seed'),
  ('00000000-0000-0000-0000-000000f35032', 'admin-b-fin@example.com', 'Admin Org B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000f35033', 'operador-a-fin@example.com', 'Operador Org A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000f35030', '00000000-0000-0000-0000-000000f35001', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000f35031', '00000000-0000-0000-0000-000000f35001', null, 'viewer', 'contador'),
  ('00000000-0000-0000-0000-000000f35032', '00000000-0000-0000-0000-000000f35002', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000f35033', '00000000-0000-0000-0000-000000f35001', null, 'member', 'operador:acceso_total')
on conflict do nothing;

-- Reservas de la property A (canal Airbnb): o1 sin movimiento (con codigo y telefono), o2 con movimiento, o3 pasada con telefono (purga),
-- o4 cancelada despues. Property B: oB sin movimiento (otra organizacion).
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id, codigo_confirmacion, telefono_ultimos4) values
  ('00000000-0000-0000-0000-000000f35050', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35020', daterange('2027-03-10', '2027-03-12', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o1', 'HMAB12CD34', '0123'),
  ('00000000-0000-0000-0000-000000f35051', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35020', daterange('2027-03-15', '2027-03-18', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o2', 'HMZZ99YY88', null),
  ('00000000-0000-0000-0000-000000f35052', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35020', daterange('2024-01-10', '2024-01-12', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-o3', 'HMOLD00001', '4455'),
  ('00000000-0000-0000-0000-000000f35053', '00000000-0000-0000-0000-000000f35002', '00000000-0000-0000-0000-000000f35011', '00000000-0000-0000-0000-000000f35021', daterange('2027-03-10', '2027-03-12', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, (select id from rentas.canal where codigo = 'airbnb'), 'uid-oB', 'HMBBBBBBBB', null)
on conflict do nothing;
insert into rentas.reserva_financiero (id, organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, ya_neto_de_comision, monto_recibido_centavos, neto_centavos, origen) values
  ('00000000-0000-0000-0000-000000f35060', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35051', 'MXN', 450000, true, 450000, 450000, 'manual')
on conflict do nothing;
-- Linea ya importada (property A) para las pruebas de unique y de UPDATE por columna.
insert into rentas.importacion_pagos (id, organization_id, property_id, canal_id, archivo_sha256, lineas_total, pendientes) values
  ('00000000-0000-0000-0000-000000f35080', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), repeat('a', 64), 1, 1)
on conflict do nothing;
insert into rentas.importacion_pagos_linea (id, importacion_id, organization_id, property_id, canal_id, huella, codigo_confirmacion, tipo_linea, moneda, monto_neto_centavos, resultado, nota) values
  ('00000000-0000-0000-0000-000000f35081', '00000000-0000-0000-0000-000000f35080', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), repeat('b', 64), 'HMAB12CD34', 'reserva', 'MXN', 873000, 'pendiente', 'sin reserva')
on conflict do nothing;

\echo ''
\echo '=== A. columnas nuevas de rentas.ocupacion ==='
\echo ''

\echo '--- A1. un codigo con forma invalida (espacios) es RECHAZADO por el CHECK ---'
begin;
update rentas.ocupacion set codigo_confirmacion = 'HM AB 12' where id = '00000000-0000-0000-0000-000000f35050' returning 1 as should_fail;
rollback;

\echo '--- A2. telefono_ultimos4 solo admite 4 digitos: 5 digitos y letras son RECHAZADOS ---'
begin;
update rentas.ocupacion set telefono_ultimos4 = '12345' where id = '00000000-0000-0000-0000-000000f35050' returning 1 as should_fail;
rollback;

\echo '--- A3. el staff de la property A puede GUARDAR el codigo en una reserva (RLS heredada de ocupacion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35033', true);
update rentas.ocupacion set codigo_confirmacion = 'HMNUEVO001' where id = '00000000-0000-0000-0000-000000f35051';
select count(*) as guardado_deberia_ser_1 from rentas.ocupacion where id = '00000000-0000-0000-0000-000000f35051' and codigo_confirmacion = 'HMNUEVO001';
rollback;

\echo '--- A4. el staff de la Org B NO puede escribir el codigo en una reserva de la Org A (RLS): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35032', true);
with u as (update rentas.ocupacion set codigo_confirmacion = 'HMROBADO01' where id = '00000000-0000-0000-0000-000000f35050' returning 1)
select count(*) as filas_afectadas_deberia_ser_0 from u;
rollback;

\echo ''
\echo '=== B. rentas.importacion_pagos / importacion_pagos_linea ==='
\echo ''

\echo '--- B1. admin_gestora de la property A inserta una importacion y una linea (RLS de escritura) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
insert into rentas.importacion_pagos (id, organization_id, property_id, canal_id, archivo_sha256, lineas_total, creadas, creado_por) values
  ('00000000-0000-0000-0000-000000f35082', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), repeat('c', 64), 1, 1, '00000000-0000-0000-0000-000000f35030');
insert into rentas.importacion_pagos_linea (importacion_id, organization_id, property_id, canal_id, huella, codigo_confirmacion, tipo_linea, moneda, monto_neto_centavos, ocupacion_id, resultado) values
  ('00000000-0000-0000-0000-000000f35082', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), repeat('d', 64), 'HMAB12CD34', 'reserva', 'MXN', 873000, '00000000-0000-0000-0000-000000f35050', 'creada');
select count(*) as insertadas_deberia_ser_1 from rentas.importacion_pagos_linea where huella = repeat('d', 64);
rollback;

\echo '--- B2. el contador LEE las lineas pero NO puede insertar (solo admin_gestora escribe) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35031', true);
select count(*) as contador_lee_deberia_ser_1 from rentas.importacion_pagos_linea where property_id = '00000000-0000-0000-0000-000000f35010';
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35031', true);
insert into rentas.importacion_pagos (organization_id, property_id, canal_id, archivo_sha256, lineas_total, creado_por) values
  ('00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), repeat('e', 64), 0, '00000000-0000-0000-0000-000000f35031') returning 1 as should_fail;
rollback;

\echo '--- B3. un operador (rol sin finanzas) NO ve las lineas ni las importaciones ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35033', true);
select (select count(*) from rentas.importacion_pagos_linea) + (select count(*) from rentas.importacion_pagos) as operador_ve_deberia_ser_0;
rollback;

\echo '--- B4. entre tenants: el admin de la Org B no ve ni escribe sobre la property A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35032', true);
select count(*) as otra_org_ve_deberia_ser_0 from rentas.importacion_pagos_linea where property_id = '00000000-0000-0000-0000-000000f35010';
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35032', true);
insert into rentas.importacion_pagos_linea (importacion_id, organization_id, property_id, canal_id, huella, tipo_linea, moneda, monto_neto_centavos, resultado) values
  ('00000000-0000-0000-0000-000000f35080', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), repeat('f', 64), 'reserva', 'MXN', 1, 'pendiente') returning 1 as should_fail;
rollback;

\echo '--- B5. anon no tiene ningun GRANT sobre las tablas nuevas ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.importacion_pagos_linea;
rollback;

\echo '--- B6. idempotencia: la misma huella en la misma property y canal NO se puede registrar dos veces (unique) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
insert into rentas.importacion_pagos_linea (importacion_id, organization_id, property_id, canal_id, huella, tipo_linea, moneda, monto_neto_centavos, resultado) values
  ('00000000-0000-0000-0000-000000f35080', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), repeat('b', 64), 'reserva', 'MXN', 873000, 'pendiente') returning 1 as should_fail;
rollback;

\echo '--- B7. subir el MISMO archivo dos veces da los mismos conteos: el emparejamiento por huella de la app (findLineasImportadas) deja las lineas existentes fuera del INSERT ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
-- primera subida: inserta solo las huellas que no existen (misma consulta de existentes que PostgresRentasRepository.findLineasImportadas).
with entrantes(huella) as (values (repeat('b', 64)), (repeat('1', 64)), (repeat('2', 64))),
nuevas as (select e.huella from entrantes e where not exists (select 1 from rentas.importacion_pagos_linea l where l.property_id = '00000000-0000-0000-0000-000000f35010' and l.canal_id = (select id from rentas.canal where codigo = 'airbnb') and l.huella = e.huella))
insert into rentas.importacion_pagos_linea (importacion_id, organization_id, property_id, canal_id, huella, tipo_linea, moneda, monto_neto_centavos, resultado)
select '00000000-0000-0000-0000-000000f35080', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), huella, 'reserva', 'MXN', 100, 'pendiente' from nuevas;
-- segunda subida del mismo archivo: no inserta nada.
with entrantes(huella) as (values (repeat('b', 64)), (repeat('1', 64)), (repeat('2', 64))),
nuevas as (select e.huella from entrantes e where not exists (select 1 from rentas.importacion_pagos_linea l where l.property_id = '00000000-0000-0000-0000-000000f35010' and l.canal_id = (select id from rentas.canal where codigo = 'airbnb') and l.huella = e.huella))
insert into rentas.importacion_pagos_linea (importacion_id, organization_id, property_id, canal_id, huella, tipo_linea, moneda, monto_neto_centavos, resultado)
select '00000000-0000-0000-0000-000000f35080', '00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', (select id from rentas.canal where codigo = 'airbnb'), huella, 'reserva', 'MXN', 100, 'pendiente' from nuevas;
select count(*) as lineas_deberia_ser_3 from rentas.importacion_pagos_linea where property_id = '00000000-0000-0000-0000-000000f35010';
rollback;

\echo '--- B8. GRANT por COLUMNA: el admin reevalua una linea pendiente (resultado, nota, ocupacion_id) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
update rentas.importacion_pagos_linea set resultado = 'creada', nota = null, ocupacion_id = '00000000-0000-0000-0000-000000f35050', actualizado_en = now() where id = '00000000-0000-0000-0000-000000f35081';
select count(*) as reevaluada_deberia_ser_1 from rentas.importacion_pagos_linea where id = '00000000-0000-0000-0000-000000f35081' and resultado = 'creada';
rollback;

\echo '--- B9. ...pero NO puede cambiar el monto ni la huella de una linea ya registrada (sin UPDATE de esas columnas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
update rentas.importacion_pagos_linea set monto_neto_centavos = 1 where id = '00000000-0000-0000-0000-000000f35081' returning 1 as should_fail;
rollback;

\echo '--- B10. ...ni borrar lineas (no hay DELETE para authenticated) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
delete from rentas.importacion_pagos_linea where id = '00000000-0000-0000-0000-000000f35081' returning 1 as should_fail;
rollback;

\echo '--- B11. el emparejamiento por codigo (misma consulta que findCandidatasImportacion) solo ve reservas de la property y canal pedidos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
select count(*) as candidatas_deberia_ser_2
  from rentas.ocupacion o
  left join rentas.reserva_financiero rf on rf.ocupacion_id = o.id
 where o.property_id = '00000000-0000-0000-0000-000000f35010' and o.canal_origen_id = (select id from rentas.canal where codigo = 'airbnb') and o.capa = 'reserva'
   and o.codigo_confirmacion = any(array['HMAB12CD34', 'HMZZ99YY88', 'HMBBBBBBBB']::text[]);
rollback;

\echo ''
\echo '=== C. trigger de revision del movimiento ==='
\echo ''

\echo '--- C1. cambiar las fechas de una reserva con movimiento la marca requiere_revision (motivo reserva_modificada) y NO toca los montos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
update rentas.ocupacion set rango = daterange('2027-03-16', '2027-03-19', '[)') where id = '00000000-0000-0000-0000-000000f35051';
select count(*) as marcada_deberia_ser_1 from rentas.reserva_financiero where ocupacion_id = '00000000-0000-0000-0000-000000f35051' and requiere_revision and motivo_revision = 'reserva_modificada' and neto_centavos = 450000 and monto_bruto_centavos = 450000;
rollback;

\echo '--- C2. cancelar la reserva la marca con motivo reserva_cancelada, aunque quien cancela (operador) NO tiene permiso de UPDATE sobre reserva_financiero (security definer) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35033', true);
update rentas.ocupacion set estado = 'cancelado' where id = '00000000-0000-0000-0000-000000f35051';
reset role;
select count(*) as cancelada_marcada_deberia_ser_1 from rentas.reserva_financiero where ocupacion_id = '00000000-0000-0000-0000-000000f35051' and requiere_revision and motivo_revision = 'reserva_cancelada';
rollback;

\echo '--- C2b. ...y ese mismo operador NO puede editar reserva_financiero directamente (RLS): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35033', true);
with u as (update rentas.reserva_financiero set requiere_revision = false where ocupacion_id = '00000000-0000-0000-0000-000000f35051' returning 1)
select count(*) as filas_deberia_ser_0 from u;
rollback;

\echo '--- C3. un cambio que NO es de fechas ni cancelacion (huesped, version) NO marca nada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
update rentas.ocupacion set version = version + 1, codigo_confirmacion = 'HMOTRO0001' where id = '00000000-0000-0000-0000-000000f35051';
select count(*) as sin_marca_deberia_ser_0 from rentas.reserva_financiero where ocupacion_id = '00000000-0000-0000-0000-000000f35051' and requiere_revision;
rollback;

\echo '--- C4. una reserva SIN movimiento que cambia de fechas no falla ni crea nada (el trigger solo marca la fila 1:1 si existe) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
update rentas.ocupacion set rango = daterange('2027-03-11', '2027-03-13', '[)') where id = '00000000-0000-0000-0000-000000f35050';
select count(*) as sin_movimiento_deberia_ser_0 from rentas.reserva_financiero where ocupacion_id = '00000000-0000-0000-0000-000000f35050';
rollback;

\echo '--- C5. la funcion del trigger NO es invocable por authenticated (EXECUTE revocado) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
select rentas.ocupacion_marcar_movimiento_revision() as should_fail;
rollback;

\echo '--- C6. coherencia: un motivo de revision sin requiere_revision es RECHAZADO; un origen desconocido tambien ---'
begin;
update rentas.reserva_financiero set motivo_revision = 'reserva_modificada', requiere_revision = false where id = '00000000-0000-0000-0000-000000f35060' returning 1 as should_fail;
rollback;

begin;
update rentas.reserva_financiero set origen = 'inventado' where id = '00000000-0000-0000-0000-000000f35060' returning 1 as should_fail;
rollback;

\echo '--- C7. el admin_gestora puede marcar el movimiento como revisado (UPDATE por RLS de escritura de finanzas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
update rentas.ocupacion set rango = daterange('2027-03-16', '2027-03-19', '[)') where id = '00000000-0000-0000-0000-000000f35051';
update rentas.reserva_financiero set requiere_revision = false, motivo_revision = null where ocupacion_id = '00000000-0000-0000-0000-000000f35051' and requiere_revision;
select count(*) as revisado_deberia_ser_0 from rentas.reserva_financiero where ocupacion_id = '00000000-0000-0000-0000-000000f35051' and requiere_revision;
rollback;

\echo ''
\echo '=== D. rentas.system_reservas_sin_movimiento (barrido de sistema) ==='
\echo ''

\echo '--- D1. un usuario autenticado NO puede llamarla (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
select count(*) as should_fail from rentas.system_reservas_sin_movimiento('2027-03-01', '2027-04-01');
rollback;

\echo '--- D2. anon no tiene EXECUTE ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.system_reservas_sin_movimiento('2027-03-01', '2027-04-01');
rollback;

\echo '--- D3. la sesion de sistema (auth.uid() NULL, rol authenticated) cuenta por organizacion: A=1 (o1 sin movimiento; o2 si tiene), B=1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_deberia_ser_2 from rentas.system_reservas_sin_movimiento('2027-03-01', '2027-04-01');
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select cantidad as org_a_deberia_ser_1 from rentas.system_reservas_sin_movimiento('2027-03-01', '2027-04-01') where organization_id = '00000000-0000-0000-0000-000000f35001';
rollback;

\echo '--- D4. con un movimiento nuevo para o1 la Org A deja de aparecer; una reserva cancelada nunca cuenta ---'
begin;
insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, monto_recibido_centavos, neto_centavos, origen) values
  ('00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35050', 'MXN', 1, 1, 1, 'importacion_csv');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as org_a_ausente_deberia_ser_0 from rentas.system_reservas_sin_movimiento('2027-03-01', '2027-04-01') where organization_id = '00000000-0000-0000-0000-000000f35001';
rollback;

\echo '--- D5. una ventana invertida o de mas de 62 dias es RECHAZADA ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as should_fail from rentas.system_reservas_sin_movimiento('2027-01-01', '2027-06-01');
rollback;

\echo ''
\echo '=== E. retencion rentas_huesped_pii: telefono_ultimos4 ==='
\echo ''

\echo '--- E1. simulacion: cuenta la reserva pasada con telefono (o3) y NO la futura (o1) ---'
begin;
select set_config('request.jwt.claim.sub', '', true);
select out_afectadas as simulacion_deberia_ser_1 from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f35001', 'rentas_huesped_pii', now(), true, 500);
rollback;

\echo '--- E2. ejecucion: pone en NULL el telefono de o3, conserva la reserva y su codigo, y NO toca el telefono de la reserva futura ---'
begin;
select set_config('request.jwt.claim.sub', '', true);
select out_afectadas from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f35001', 'rentas_huesped_pii', now(), false, 500);
select count(*) as telefono_limpio_y_reserva_viva_deberia_ser_1 from rentas.ocupacion where id = '00000000-0000-0000-0000-000000f35052' and telefono_ultimos4 is null and codigo_confirmacion = 'HMOLD00001' and estado = 'confirmado';
rollback;

begin;
select set_config('request.jwt.claim.sub', '', true);
select out_afectadas from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f35001', 'rentas_huesped_pii', now(), false, 500);
select count(*) as futura_intacta_deberia_ser_1 from rentas.ocupacion where id = '00000000-0000-0000-0000-000000f35050' and telefono_ultimos4 = '0123';
rollback;

\echo '--- E3. la purga sigue siendo solo de sistema: un usuario autenticado recibe 42501 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
select count(*) as should_fail from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f35001', 'rentas_huesped_pii', now(), true, 10);
rollback;

\echo '--- E4. y la otra clase de 028 (rentas_acceso_instrucciones) sigue funcionando con el cuerpo reemplazado ---'
begin;
select set_config('request.jwt.claim.sub', '', true);
select out_afectadas as acceso_sin_filas_deberia_ser_0 from rentas.system_purge_retencion('00000000-0000-0000-0000-000000f35001', 'rentas_acceso_instrucciones', now(), true, 10);
rollback;

\echo ''
\echo '=== F. el statement del mes incluye los movimientos creados por la importacion ==='
\echo ''

\echo '--- F1. con el movimiento de importacion de o1, la consulta del statement (la de PostgresRentasRepository) ve o1 y o2 para el propietario ---'
begin;
insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, ya_neto_de_comision, monto_recibido_centavos, neto_centavos, origen) values
  ('00000000-0000-0000-0000-000000f35001', '00000000-0000-0000-0000-000000f35010', '00000000-0000-0000-0000-000000f35050', 'MXN', 873000, true, 873000, 785700, 'importacion_csv');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
select count(*) as statement_deberia_ser_2
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
 where o.property_id = '00000000-0000-0000-0000-000000f35010' and u.owner_id = '00000000-0000-0000-0000-000000f35070' and o.estado <> 'cancelado'
   and upper(o.rango) >= '2027-03-01'::date and upper(o.rango) < '2027-04-01'::date;
rollback;

\echo '--- F2. una reserva cancelada deja de sumar en el statement aunque su movimiento siga marcado en revision ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000f35030', true);
update rentas.ocupacion set estado = 'cancelado' where id = '00000000-0000-0000-0000-000000f35051';
select count(*) as statement_sin_cancelada_deberia_ser_0
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
 where o.property_id = '00000000-0000-0000-0000-000000f35010' and u.owner_id = '00000000-0000-0000-0000-000000f35070' and o.estado <> 'cancelado'
   and upper(o.rango) >= '2027-03-01'::date and upper(o.rango) < '2027-04-01'::date;
rollback;

\echo ''
\echo '=== listo: los escenarios *_deberia_ser_N deben devolver N; los marcados should_fail deben terminar en ERROR ==='
