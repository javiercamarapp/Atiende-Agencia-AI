-- Fixtures + assertions contra Postgres REAL (RLS/GRANT por columna/auth.uid()/security
-- definer reales -- el repositorio en memoria de domain-rentas nunca los aplica) de
--   * Rn-03: la consulta de lectura del reporte de ocupacion e ingresos
--     (PostgresRentasReportesRepository, solo lee tablas de 001/003): RLS por property,
--     RLS de finanzas, cross-tenant, anon, y el calculo de noches por mes sin doble conteo.
--   * Rn-04: packages/domain-rentas/migrations/025_rentas_acceso_huesped.sql (liberacion de
--     instrucciones de acceso al huesped): politica, instrucciones (el secreto), pago
--     confirmado, ventana en zona America/Merida, funciones de SOLO-SISTEMA, bitacora sin PII.
--
-- Run via scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con
-- ./run.sh. Cada escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (reportes-acceso)', 'org-a-reportes-acceso'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (reportes-acceso, ajena)', 'org-b-reportes-acceso')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Property A1'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Property B1 (ajena)')
on conflict do nothing;

insert into rentas.property_config (property_id, organization_id, zona_horaria, moneda) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'America/Merida', 'MXN'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'America/Cancun', 'MXN')
on conflict do nothing;

insert into rentas.owner (id, name) values ('00000000-0000-0000-0000-0000000000e1', 'Ana Propietaria') on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, owner_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000e1', 'Unidad A1-1', 1),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', null, 'Unidad B1-1 (ajena)', 1)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-a-ra@example.com', 'Admin Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'contador-a-ra@example.com', 'Contador Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'admin-b-ra@example.com', 'Admin Org B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000014', 'limpieza-a-ra@example.com', 'Limpieza Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000015', 'operador-total-a-ra@example.com', 'Operador acceso total Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000016', 'operador-mensajeria-a-ra@example.com', 'Operador mensajeria Org A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-0000000000a1', null, 'viewer', 'contador'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a2', null, 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'limpieza'),
  ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:acceso_total'),
  ('00000000-0000-0000-0000-000000000016', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:calendario_mensajeria')
on conflict do nothing;

insert into rentas.guest_minimo (id, organization_id, property_id, nombre, contacto) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Huesped Uno', 'uno@example.com')
on conflict do nothing;

-- Reservas de la Org A, unidad c1 (todas 'reserva'):
--   d1 directa (manual) 10-12 mar 2027, confirmada, con huesped
--   d2 airbnb 12-15 mar 2027 (contigua: check-in = check-out de d1), confirmada
--   d3 booking 20-22 mar 2027, conflicto_pendiente no bloqueante (el segundo canal de una misma estancia)
--   d4 airbnb 30 mar - 3 abr 2027 (cruza de mes), confirmada
--   d5 airbnb 10-12 abr 2027, CANCELADA
--   d6 directa 20-22 abr 2027, PROVISIONAL
-- Org B, unidad c2: d9 airbnb 10-12 jun 2027 confirmada (lejos de las de la Org A: la funcion
-- devuelve UNA reserva por llamada, ordenada por check-in).
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id, external_id, huesped_minimo_id)
select v.id::uuid, v.org::uuid, v.prop::uuid, v.uni::uuid, daterange(v.ini::date, v.fin::date, '[)'), 'reserva', 'RESERVA_CANAL', v.estado, v.bloq::boolean, c.id, v.ext,
       case when v.id = '00000000-0000-0000-0000-0000000000d1' then '00000000-0000-0000-0000-0000000000f1'::uuid else null end
from (values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '2027-03-10', '2027-03-12', 'confirmado', 'true', 'manual', null),
  ('00000000-0000-0000-0000-0000000000d2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '2027-03-12', '2027-03-15', 'confirmado', 'true', 'airbnb', 'uid-d2'),
  ('00000000-0000-0000-0000-0000000000d3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '2027-03-20', '2027-03-22', 'conflicto_pendiente', 'false', 'booking', 'uid-d3'),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '2027-03-30', '2027-04-03', 'confirmado', 'true', 'airbnb', 'uid-d4'),
  ('00000000-0000-0000-0000-0000000000d5', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '2027-04-10', '2027-04-12', 'cancelado', 'true', 'airbnb', 'uid-d5'),
  ('00000000-0000-0000-0000-0000000000d6', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '2027-04-20', '2027-04-22', 'provisional', 'true', 'manual', null),
  ('00000000-0000-0000-0000-0000000000d9', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c2', '2027-06-10', '2027-06-12', 'confirmado', 'true', 'airbnb', 'uid-d9')
) as v(id, org, prop, uni, ini, fin, estado, bloq, canal, ext)
join rentas.canal c on c.codigo = v.canal
on conflict do nothing;

-- Un bloqueo de propietario (capa bloqueo): nunca debe contar como reserva.
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante)
values ('00000000-0000-0000-0000-0000000000da', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', daterange('2027-03-16', '2027-03-18', '[)'), 'bloqueo', 'BLOQUEO_PROPIETARIO', 'confirmado', true)
on conflict do nothing;

insert into rentas.reserva_financiero (ocupacion_id, organization_id, property_id, moneda, monto_bruto_centavos, comision_canal_centavos, monto_recibido_centavos, neto_centavos) values
  ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'MXN', 100000, 0, 100000, 100000),
  ('00000000-0000-0000-0000-0000000000d4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'MXN', 200003, 20000, 180003, 180003)
on conflict do nothing;

-- Politica de acceso de la property A (24 h antes, check-in 15:00 hora local, exige pago,
-- OTA cuenta como pagada) e instrucciones de la unidad c1. La property B tiene politica
-- activa con la zona America/Cancun (UTC-5) para contrastar la ventana por zona.
insert into rentas.acceso_politica (property_id, organization_id, activo, horas_antes_checkin, hora_checkin, exigir_pago, ota_cuenta_como_pagada) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', true, 24, '15:00', true, true),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', true, 24, '15:00', true, true)
on conflict do nothing;
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_exacta, codigo_acceso, instrucciones) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Calle 60 #123, Centro, Merida', '4821', 'Caja de seguridad junto a la puerta'),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'Av. Tulum 9, Cancun', '9999', null)
on conflict do nothing;

\echo ''
\echo '=== A. Rn-03: lectura del reporte (misma consulta que PostgresRentasReportesRepository) ==='
\echo ''

\echo '--- 1. el staff de la property A (contador, con lectura de finanzas) ve las 3 reservas confirmadas del periodo (d1, d2, d4) con su canal y su movimiento financiero ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select count(*) as reservas_confirmadas_deberia_ser_3
from rentas.ocupacion o
join rentas.unidad u on u.id = o.unidad_id
left join rentas.canal c on c.id = o.canal_origen_id
left join rentas.reserva_financiero rf on rf.ocupacion_id = o.id
where o.property_id = '00000000-0000-0000-0000-0000000000b1' and o.capa = 'reserva' and o.estado = 'confirmado'
  and o.rango && daterange('2027-03-01'::date, '2027-05-01'::date, '[)');
rollback;

\echo '--- 2. el contador ve el dinero (RLS can_read_finanzas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select count(*) as movimientos_visibles_deberia_ser_2 from rentas.reserva_financiero where property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 3. limpieza (sin rol de finanzas) ve las reservas pero NO el dinero: el reporte degrada a solo noches ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select count(*) as dinero_visible_a_limpieza_deberia_ser_0 from rentas.reserva_financiero where property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 4. cross-tenant: el staff de la Org B no ve ninguna reserva ni movimiento de la property A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select (select count(*) from rentas.ocupacion where property_id = '00000000-0000-0000-0000-0000000000b1')
     + (select count(*) from rentas.reserva_financiero where property_id = '00000000-0000-0000-0000-0000000000b1') as cross_tenant_deberia_ser_0;
rollback;

\echo '--- 5. anon no puede leer reservas -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.ocupacion;
rollback;

\echo '--- 6. anon no puede leer el movimiento financiero -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.reserva_financiero;
rollback;

\echo '--- 7. anti doble conteo: una reserva confirmada que solapa otra confirmada de la misma unidad la rechaza el EXCLUDE (el mismo huesped por dos canales no puede estar confirmado dos veces) ---'
begin;
insert into rentas.ocupacion (organization_id, property_id, unidad_id, rango, capa, razon, estado, bloqueante, canal_origen_id)
select '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', daterange('2027-03-10', '2027-03-12', '[)'), 'reserva', 'RESERVA_CANAL', 'confirmado', true, c.id
from rentas.canal c where c.codigo = 'booking' returning 1 as should_fail;
rollback;

\echo '--- 8. cruce de meses: las 4 noches de d4 (30-mar a 3-abr) se reparten 2 en marzo y 2 en abril -- 4 en total, sin contar ninguna dos veces ---'
begin;
select count(*) as noches_totales_deberia_ser_4
from rentas.ocupacion o, generate_series(lower(o.rango), upper(o.rango) - 1, interval '1 day') as noche
where o.id = '00000000-0000-0000-0000-0000000000d4';
rollback;

\echo '--- 9. noches de marzo de d4 = 2 ---'
begin;
select count(*) as noches_marzo_deberia_ser_2
from rentas.ocupacion o, generate_series(lower(o.rango), upper(o.rango) - 1, interval '1 day') as noche
where o.id = '00000000-0000-0000-0000-0000000000d4' and to_char(noche, 'YYYY-MM') = '2027-03';
rollback;

\echo '--- 10. la consulta del reporte excluye cancelada, provisional, conflicto_pendiente y bloqueos: solo confirmadas de capa reserva (d1, d2, d4) ---'
begin;
select count(*) as solo_confirmadas_deberia_ser_3
from rentas.ocupacion o
where o.property_id = '00000000-0000-0000-0000-0000000000b1' and o.capa = 'reserva' and o.estado = 'confirmado'
  and o.rango && daterange('2027-03-01'::date, '2027-05-01'::date, '[)');
rollback;

\echo '--- 11. un unico movimiento financiero por reserva (UNIQUE ocupacion_id): el JOIN del reporte no duplica filas -- insertar un segundo se rechaza ---'
begin;
insert into rentas.reserva_financiero (ocupacion_id, organization_id, property_id, moneda, monto_bruto_centavos)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'MXN', 5) returning 1 as should_fail;
rollback;

\echo ''
\echo '=== B. Rn-04: autoridad, politica e instrucciones (el secreto) ==='
\echo ''

\echo '--- 12. admin_gestora lee las instrucciones de su property ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as instrucciones_admin_deberia_ser_1 from rentas.acceso_instruccion;
rollback;

\echo '--- 13. operador:acceso_total tambien las lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
select count(*) as instrucciones_operador_total_deberia_ser_1 from rentas.acceso_instruccion;
rollback;

\echo '--- 14. contador, limpieza y operador de calendario+mensajeria NO ven las instrucciones (ven la reserva, no la llave) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
select count(*) as contador_deberia_ser_0 from rentas.acceso_instruccion;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select count(*) as limpieza_deberia_ser_0 from rentas.acceso_instruccion;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000016', true);
select count(*) as mensajeria_deberia_ser_0 from rentas.acceso_instruccion;
rollback;

\echo '--- 15. cross-tenant: el admin de la Org B no ve las instrucciones de la Org A (solo las suyas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as solo_las_suyas_deberia_ser_1 from rentas.acceso_instruccion;
rollback;

\echo '--- 16. anon no lee instrucciones, politica ni bitacora -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.acceso_instruccion;
rollback;

begin;
set local role anon;
select count(*) as should_fail from rentas.acceso_politica;
rollback;

begin;
set local role anon;
select count(*) as should_fail from rentas.acceso_bitacora;
rollback;

\echo '--- 17. el admin A edita direccion y codigo de su unidad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.acceso_instruccion set codigo_acceso = '7777', updated_at = now(), updated_by = '00000000-0000-0000-0000-000000000011' where unidad_id = '00000000-0000-0000-0000-0000000000c1';
select count(*) as editadas_deberia_ser_1 from rentas.acceso_instruccion where codigo_acceso = '7777';
rollback;

\echo '--- 18. el admin B NO puede editar las instrucciones de la Org A (0 filas afectadas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with u as (update rentas.acceso_instruccion set codigo_acceso = '0000', updated_at = now(), updated_by = '00000000-0000-0000-0000-000000000013' where unidad_id = '00000000-0000-0000-0000-0000000000c1' returning 1)
select count(*) as ajenas_editadas_deberia_ser_0 from u;
rollback;

\echo '--- 19. las columnas de identidad son inmutables para el staff (GRANT por columna): cambiar property_id -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.acceso_instruccion set property_id = '00000000-0000-0000-0000-0000000000b2' where unidad_id = '00000000-0000-0000-0000-0000000000c1' returning 1 as should_fail;
rollback;

\echo '--- 20. un admin no puede crear instrucciones para una unidad de OTRA organizacion (with check amarra unidad-property-organizacion) -- RECHAZADO ---'
begin;
delete from rentas.acceso_instruccion where unidad_id = '00000000-0000-0000-0000-0000000000c2';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_exacta, updated_by)
values ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'x', '00000000-0000-0000-0000-000000000011') returning 1 as should_fail;
rollback;

\echo '--- 21. limpieza no puede escribir instrucciones -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
insert into rentas.acceso_instruccion (unidad_id, organization_id, property_id, direccion_exacta, updated_by)
values ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'x', '00000000-0000-0000-0000-000000000014') returning 1 as should_fail;
rollback;

\echo '--- 22. la direccion exacta no puede quedar vacia (CHECK) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.acceso_instruccion set direccion_exacta = '   ', updated_at = now(), updated_by = '00000000-0000-0000-0000-000000000011' where unidad_id = '00000000-0000-0000-0000-0000000000c1' returning 1 as should_fail;
rollback;

\echo '--- 23. el staff A (cualquier rol) lee la politica de su property; el de B no la ve ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select count(*) as politica_visible_deberia_ser_1 from rentas.acceso_politica;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as politica_ajena_deberia_ser_0 from rentas.acceso_politica where property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 24. el admin A cambia horas_antes_checkin; limpieza no puede (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.acceso_politica set horas_antes_checkin = 48, updated_at = now(), updated_by = '00000000-0000-0000-0000-000000000011' where property_id = '00000000-0000-0000-0000-0000000000b1';
select count(*) as politica_editada_deberia_ser_1 from rentas.acceso_politica where horas_antes_checkin = 48;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
with u as (update rentas.acceso_politica set activo = false, updated_at = now(), updated_by = '00000000-0000-0000-0000-000000000014' where property_id = '00000000-0000-0000-0000-0000000000b1' returning 1)
select count(*) as limpieza_edita_deberia_ser_0 from u;
rollback;

\echo '--- 25. horas_antes_checkin fuera de 1..168 se rechaza (CHECK) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.acceso_politica set horas_antes_checkin = 200, updated_at = now(), updated_by = '00000000-0000-0000-0000-000000000011' where property_id = '00000000-0000-0000-0000-0000000000b1' returning 1 as should_fail;
rollback;

\echo ''
\echo '=== C. Rn-04: confirmar pago ==='
\echo ''

\echo '--- 26. el admin A confirma el pago de la reserva directa d1: queda atribuido a el ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1');
select (pago_confirmado_en is not null and pago_confirmado_por = '00000000-0000-0000-0000-000000000011')::int as pago_atribuido_deberia_ser_1 from rentas.acceso_reserva where ocupacion_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 27. revocar el pago lo deja sin confirmar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1', false);
select (pago_confirmado_en is null and pago_confirmado_por is null)::int as pago_revocado_deberia_ser_1 from rentas.acceso_reserva where ocupacion_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 28. cross-tenant: el admin B no puede confirmar el pago de una reserva de la Org A (se trata como inexistente) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1') as should_fail;
rollback;

\echo '--- 29. limpieza no puede confirmar pagos -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1') as should_fail;
rollback;

\echo '--- 30. no se confirma el pago de una reserva cancelada -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d5') as should_fail;
rollback;

\echo '--- 31. no se confirma el pago de un bloqueo (capa bloqueo) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000da') as should_fail;
rollback;

\echo '--- 32. la sesion de sistema (auth.uid() NULL) no puede confirmar pagos -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1') as should_fail;
rollback;

\echo '--- 33. anon no puede ejecutar confirmar_pago_reserva -- RECHAZADO ---'
begin;
set local role anon;
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1') as should_fail;
rollback;

\echo '--- 34. nadie fabrica un pago ni una liberacion con un UPDATE/INSERT directo sobre acceso_reserva -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.acceso_reserva (ocupacion_id, organization_id, property_id, liberado_en, liberado_via)
values ('00000000-0000-0000-0000-0000000000d1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', now(), 'email') returning 1 as should_fail;
rollback;

\echo '--- 34b. el panel de staff lista las reservas proximas con su estado de pago/liberacion (misma consulta que PostgresRentasAccesoRepository.listarReservasProximas): el admin A ve sus 3 reservas confirmadas y refleja el pago confirmado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1');
select count(*) filter (where ar.pago_confirmado_en is not null) * 10 + count(*) as reservas_y_pago_deberia_ser_13
from rentas.ocupacion o
join rentas.unidad u on u.id = o.unidad_id
left join rentas.property_config pc on pc.property_id = o.property_id
left join rentas.acceso_reserva ar on ar.ocupacion_id = o.id
where o.property_id = '00000000-0000-0000-0000-0000000000b1' and o.capa = 'reserva' and o.estado = 'confirmado'
  and upper(o.rango) >= (now() at time zone coalesce(pc.zona_horaria, 'America/Mexico_City'))::date;
rollback;

\echo '--- 34c. cross-tenant: el admin B no ve ninguna reserva de la property A en esa consulta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as reservas_ajenas_deberia_ser_0
from rentas.ocupacion o
where o.property_id = '00000000-0000-0000-0000-0000000000b1' and o.capa = 'reserva' and o.estado = 'confirmado';
rollback;

\echo ''
\echo '=== D. Rn-04: ventana de liberacion y pago (funcion de sistema, zona America/Merida UTC-6) ==='
\echo ''

\echo '--- 35. d2 (airbnb, check-in 12-mar 15:00 Merida = 21:00 UTC): 1 segundo ANTES de abrir la ventana (11-mar 20:59:59 UTC) no se libera ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as antes_de_ventana_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 20:59:59+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 36. d2 justo al abrir la ventana (11-mar 21:00:00 UTC) SI se libera (canal OTA cuenta como pagado) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as en_ventana_deberia_ser_1 from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 21:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 37. la zona importa: a las 15:00 UTC del 11-mar son las 09:00 en Merida, aun faltan 30 horas -- no se libera (una cuenta ingenua en UTC la liberaria) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as zona_merida_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 15:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 38. d1 (directa) dentro de la ventana pero SIN pago confirmado: no se libera ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sin_pago_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-10 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 39. d1 con pago confirmado por el staff y dentro de la ventana: se libera con los datos del correo (contacto y secreto) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.confirmar_pago_reserva('00000000-0000-0000-0000-0000000000d1');
select set_config('request.jwt.claim.sub', '', true);
select (tiene_instrucciones and huesped_contacto = 'uno@example.com' and codigo_acceso = '4821' and direccion_exacta like 'Calle 60%' and check_in = '2027-03-10' and check_out = '2027-03-12')::int as con_pago_deberia_ser_1
from rentas.acceso_siguiente_liberacion('{}', '2027-03-10 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 40. con la politica en exigir_pago=false la reserva directa se libera sin confirmar pago ---'
begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sin_exigir_pago_deberia_ser_1 from rentas.acceso_siguiente_liberacion('{}', '2027-03-10 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 41. con ota_cuenta_como_pagada=false un canal OTA tambien necesita pago confirmado ---'
begin;
update rentas.acceso_politica set ota_cuenta_como_pagada = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ota_sin_pago_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-12 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 42. el limite superior: d1 termina el 12-mar; a las 05:59:59 UTC (23:59:59 del 11 en Merida) aun se libera ---'
begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as ultimo_segundo_deberia_ser_1 from rentas.acceso_siguiente_liberacion('{}', '2027-03-12 05:59:59+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 43. el dia de check-out en Merida (12-mar 06:00:00 UTC) ya no se libera nada de d1 ---'
begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as despues_de_checkout_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-12 06:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d1';
rollback;

\echo '--- 44. nunca se libera una reserva cancelada (d5), provisional (d6), en conflicto_pendiente (d3) ni un bloqueo (da), aun con la ventana abierta y sin exigir pago ---'
begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as cancelada_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-04-10 12:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d5';
rollback;

begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as provisional_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-04-20 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d6';
rollback;

begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as conflicto_pendiente_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-20 00:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d3';
rollback;

begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as bloqueo_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-16 12:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000da';
rollback;

\echo '--- 45. politica apagada (activo=false): no se libera nada de esa property ---'
begin;
update rentas.acceso_politica set activo = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as politica_apagada_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-12 00:00:00+00') where property_id = '00000000-0000-0000-0000-0000000000b1';
rollback;

\echo '--- 46. horas_antes_checkin=48 abre la ventana 24 h antes: d2 ya sale el 10-mar 21:00 UTC y no un segundo antes ---'
begin;
update rentas.acceso_politica set horas_antes_checkin = 48 where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (select count(*) from rentas.acceso_siguiente_liberacion('{}', '2027-03-10 20:59:59+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2') * 10
     + (select count(*) from rentas.acceso_siguiente_liberacion('{}', '2027-03-10 21:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2') as ventana_48h_deberia_ser_1;
rollback;

\echo '--- 47. la zona de la property B (Cancun, UTC-5) es distinta: d9 (10-jun 15:00 Cancun = 20:00 UTC) abre 9-jun 20:00 UTC, una hora ANTES que con la zona de Merida ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (select count(*) from rentas.acceso_siguiente_liberacion('{}', '2027-06-09 19:59:59+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d9') * 10
     + (select count(*) from rentas.acceso_siguiente_liberacion('{}', '2027-06-09 20:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d9') as ventana_cancun_deberia_ser_1;
rollback;

\echo '--- 48. una reserva sin instrucciones configuradas se reporta con tiene_instrucciones=false y sin secretos ---'
begin;
delete from rentas.acceso_instruccion where unidad_id = '00000000-0000-0000-0000-0000000000c1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (not tiene_instrucciones and codigo_acceso is null and direccion_exacta is null)::int as sin_instrucciones_deberia_ser_1
from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 21:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 49. p_excluir salta las reservas ya intentadas en la corrida ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as excluida_deberia_ser_0 from rentas.acceso_siguiente_liberacion(array['00000000-0000-0000-0000-0000000000d2']::uuid[], '2027-03-11 21:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 50. devuelve UNA reserva por llamada (limit 1) aunque haya varias elegibles ---'
begin;
update rentas.acceso_politica set exigir_pago = false where property_id = '00000000-0000-0000-0000-0000000000b1';
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as una_por_llamada_deberia_ser_1 from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 21:00:00+00');
rollback;

\echo ''
\echo '=== E. Rn-04: funciones de SOLO-SISTEMA, idempotencia y bitacora sin PII ==='
\echo ''

\echo '--- 51. un staff autenticado NO puede pedir la siguiente liberacion (traeria el secreto) -- RECHAZADO (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as should_fail from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 21:00:00+00');
rollback;

\echo '--- 52. anon no puede ejecutar acceso_siguiente_liberacion -- RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 21:00:00+00');
rollback;

\echo '--- 53. un staff autenticado NO puede marcar una liberacion -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email') as should_fail;
rollback;

\echo '--- 54. un staff autenticado NO puede escribir la bitacora -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select rentas.acceso_registrar_evento('00000000-0000-0000-0000-0000000000d2', 'error_envio', 'email') as should_fail;
rollback;

\echo '--- 55. la sesion de sistema marca la liberacion: la primera vez true, la segunda false (idempotente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email'))::int as primera_deberia_ser_1;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email');
select (rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email'))::int as segunda_deberia_ser_0;
rollback;

\echo '--- 56. liberar deja UNA sola fila en la bitacora (evento liberada) con el tenant derivado de la reserva ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email');
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email');
reset role;
select count(*) as bitacora_liberada_deberia_ser_1 from rentas.acceso_bitacora
where ocupacion_id = '00000000-0000-0000-0000-0000000000d2' and evento = 'liberada' and organization_id = '00000000-0000-0000-0000-0000000000a1' and property_id = '00000000-0000-0000-0000-0000000000b1' and canal = 'email';
rollback;

\echo '--- 57. una reserva ya liberada no vuelve a salir de acceso_siguiente_liberacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email');
select count(*) as ya_liberada_deberia_ser_0 from rentas.acceso_siguiente_liberacion('{}', '2027-03-11 21:00:00+00') where ocupacion_id = '00000000-0000-0000-0000-0000000000d2';
rollback;

\echo '--- 58. canal no soportado en acceso_marcar_liberada -- RECHAZADO (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'sms') as should_fail;
rollback;

\echo '--- 59. marcar una reserva inexistente se rechaza (P0002), sin crear filas huerfanas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-00000000dead', 'email') as should_fail;
rollback;

\echo '--- 60. registrar un evento omitido: la primera vez true, la repeticion dentro de 24 h false (tope anti-spam) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (rentas.acceso_registrar_evento('00000000-0000-0000-0000-0000000000d2', 'omitida_sin_contacto', 'email'))::int as primera_omision_deberia_ser_1;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_registrar_evento('00000000-0000-0000-0000-0000000000d2', 'omitida_sin_contacto', 'email');
select (rentas.acceso_registrar_evento('00000000-0000-0000-0000-0000000000d2', 'omitida_sin_contacto', 'email'))::int as repeticion_deberia_ser_0;
rollback;

\echo '--- 61. registrar_evento no acepta el evento liberada (solo acceso_marcar_liberada lo escribe) -- RECHAZADO (22023) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_registrar_evento('00000000-0000-0000-0000-0000000000d2', 'liberada', 'email') as should_fail;
rollback;

\echo '--- 62. el admin A lee la bitacora de su property; el admin B no ve nada; limpieza tampoco ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
select count(*) as admin_ve_bitacora_deberia_ser_1 from rentas.acceso_bitacora;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
select count(*) as admin_ajeno_deberia_ser_0 from rentas.acceso_bitacora;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select rentas.acceso_marcar_liberada('00000000-0000-0000-0000-0000000000d2', 'email');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
select count(*) as limpieza_deberia_ser_0 from rentas.acceso_bitacora;
rollback;

\echo '--- 63. el staff no puede escribir ni borrar la bitacora directamente (append-only) -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
insert into rentas.acceso_bitacora (organization_id, property_id, ocupacion_id, evento, canal)
values ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000d2', 'liberada', 'email') returning 1 as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.acceso_bitacora returning 1 as should_fail;
rollback;

\echo '--- 64. la bitacora no tiene ninguna columna de PII ni de secreto (contacto, correo, codigo, direccion) ---'
begin;
select count(*) as columnas_pii_deberia_ser_0 from information_schema.columns
where table_schema = 'rentas' and table_name = 'acceso_bitacora' and column_name in ('contacto', 'huesped_contacto', 'email', 'correo', 'codigo_acceso', 'direccion_exacta', 'instrucciones', 'nombre');
rollback;

\echo '--- 65. toda funcion security definer nueva fija search_path ---'
begin;
select count(*) as sin_search_path_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'rentas' and p.prosecdef and p.proname in ('can_manage_acceso', 'confirmar_pago_reserva', 'acceso_siguiente_liberacion', 'acceso_marcar_liberada', 'acceso_registrar_evento')
  and not exists (select 1 from unnest(coalesce(p.proconfig, '{}')) c where c like 'search_path=%');
rollback;

\echo '--- 66. anon no tiene EXECUTE sobre ninguna funcion nueva ---'
begin;
select count(*) as anon_con_execute_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'rentas' and p.proname in ('can_manage_acceso', 'confirmar_pago_reserva', 'acceso_siguiente_liberacion', 'acceso_marcar_liberada', 'acceso_registrar_evento')
  and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo ''
\echo '==> listo -- los escenarios marcados con should_fail deben terminar en ERROR; los demas devuelven el valor indicado en el alias.'
