-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0038_superadmin_gestion_organizaciones.sql (SA-06, gestion de organizaciones):
--
--   A) Doble control: suspender con contrato vigente exige la aprobacion de un SEGUNDO superadmin;
--      sin contrato (o con contrato vencido) sigue el flujo de un solo superadmin y vence a los 10 min.
--   B) Quien puede aprobar: solo otro superadmin real (no el solicitante, ni staff normal, ni el rol
--      `finanzas`, ni anon, ni una sesion de sistema, ni con caller-binding falso); una sola vez.
--   C) Un solo uso y vencimiento: confirmar dos veces, confirmar tras cancelar, aprobar o confirmar vencida.
--   D) El mundo cambia: un contrato que aparece despues de la solicitud obliga a rehacerla.
--   E) Cambio de plan atado al contrato: no se pasa a prueba con contrato vigente; la ejecucion registra
--      el contrato y su version.
--   F) Reactivar restaura el estado previo sin perder datos; nada se borra.
--   G) Bitacora y datos inmutables (guard, CHECK de la base, eventos append-only).
--   H) Sin acceso directo a la tabla, GRANT de funciones sin anon, search_path fijo.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias `should_fail` marca un escenario que debe terminar en ERROR; el alias
-- deberia_ser_N exige que la ultima fila valga N; el resto debe completar sin error. Sesion de SISTEMA =
-- rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (como dueño, sin pasar por las funciones).
--   O1 e7000: activa, CON contrato vigente (con 2 sucursales)   O2 e7001: activa, sin contrato
--   O3 e7002: activa, contrato VENCIDO                          O4 e7003: en prueba, con contrato vigente
--   O5 e7004: suspendida, sin contrato
insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000e7000', 'restaurantes', 'Org O1 gestion', 'org-go-1', 'active'),
  ('00000000-0000-0000-0000-0000000e7001', 'hoteles', 'Org O2 gestion', 'org-go-2', 'active'),
  ('00000000-0000-0000-0000-0000000e7002', 'citas', 'Org O3 gestion', 'org-go-3', 'active'),
  ('00000000-0000-0000-0000-0000000e7003', 'rentas', 'Org O4 gestion', 'org-go-4', 'trial'),
  ('00000000-0000-0000-0000-0000000e7004', 'despachos', 'Org O5 gestion', 'org-go-5', 'suspended')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000e7300', '00000000-0000-0000-0000-0000000e7000', 'restaurantes', 'Sucursal 1', 'active'),
  ('00000000-0000-0000-0000-0000000e7301', '00000000-0000-0000-0000-0000000e7000', 'restaurantes', 'Sucursal 2', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e7100', 'sa-go-1@example.com', 'Superadmin GO 1', 'seed'),
  ('00000000-0000-0000-0000-0000000e7101', 'sa-go-2@example.com', 'Superadmin GO 2', 'seed'),
  ('00000000-0000-0000-0000-0000000e7102', 'owner-go@example.com', 'Owner de O1', 'seed'),
  ('00000000-0000-0000-0000-0000000e7103', 'finanzas-go@example.com', 'Finanzas GO', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000e7100'), ('00000000-0000-0000-0000-0000000e7101'), ('00000000-0000-0000-0000-0000000e7103')
on conflict do nothing;

insert into core.cfo_zone_role (staff_user_id, rol, assigned_by, reason) values
  ('00000000-0000-0000-0000-0000000e7103', 'finanzas', '00000000-0000-0000-0000-0000000e7100', 'Fixture: rol de solo lectura para la verificacion.')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e7102', '00000000-0000-0000-0000-0000000e7000', null, 'owner', 'staff')
on conflict do nothing;

-- Contratos (como dueño): vigente sin fin (O1), vencido hace 10 dias (O3), vigente con fin futuro (O4).
insert into core.customer_contract_version (id, contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by) values
  ('00000000-0000-0000-0000-0000000e7500', '00000000-0000-0000-0000-0000000e7500', '00000000-0000-0000-0000-0000000e7000', 1,
   (now() at time zone 'America/Mexico_City')::date - 90, null, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato vigente de la organizacion O1.', '00000000-0000-0000-0000-0000000e7100'),
  ('00000000-0000-0000-0000-0000000e7502', '00000000-0000-0000-0000-0000000e7502', '00000000-0000-0000-0000-0000000e7002', 1,
   (now() at time zone 'America/Mexico_City')::date - 100, (now() at time zone 'America/Mexico_City')::date - 10, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato ya vencido de la organizacion O3.', '00000000-0000-0000-0000-0000000e7100'),
  ('00000000-0000-0000-0000-0000000e7503', '00000000-0000-0000-0000-0000000e7503', '00000000-0000-0000-0000-0000000e7003', 1,
   (now() at time zone 'America/Mexico_City')::date - 30, (now() at time zone 'America/Mexico_City')::date + 300, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato vigente de la organizacion O4.', '00000000-0000-0000-0000-0000000e7100');

-- Una enmienda (version 2) de O4: la version vigente hoy debe ser la 2.
insert into core.customer_contract_version (contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by) values
  ('00000000-0000-0000-0000-0000000e7503', '00000000-0000-0000-0000-0000000e7003', 2,
   (now() at time zone 'America/Mexico_City')::date - 5, (now() at time zone 'America/Mexico_City')::date + 300, 690000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: enmienda vigente de la organizacion O4.', '00000000-0000-0000-0000-0000000e7100');

-- Accion con doble control ya vencida (solicitada hace 2 h, vencio hace 1 h).
insert into core.org_admin_action (id, tipo, organization_id, payload, motivo, creado_por, creado_en, vence_en, requiere_doble_control) values
  ('00000000-0000-0000-0000-0000000e7600', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Fixture: solicitud con doble control que ya vencio.',
   '00000000-0000-0000-0000-0000000e7100', now() - interval '2 hours', now() - interval '1 hour', true);

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Doble control
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'A1. suspender con contrato vigente: la solicitud exige doble control, registra el contrato y vence a los 60 min -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
reset role;
select (requiere_doble_control and contrato_id = '00000000-0000-0000-0000-0000000e7500' and contrato_version = 1
        and vence_en - creado_en between interval '59 minutes' and interval '61 minutes' and estado = 'pending' and aprobado_por is null)::int as deberia_ser_1
from core.org_admin_action where id = (select id from _a);
rollback;

\echo 'A2. suspender SIN contrato: sin doble control y vence a los 10 min -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7001', '{}', 'Cliente en mora de 90 dias, se suspende sin contrato.')).id as id;
reset role;
select (not requiere_doble_control and contrato_id is null and contrato_version is null and vence_en - creado_en between interval '9 minutes' and interval '11 minutes')::int as deberia_ser_1
from core.org_admin_action where id = (select id from _a);
rollback;

\echo 'A3. suspender con contrato VENCIDO: tampoco exige doble control -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7002', '{}', 'Contrato vencido hace diez dias, se suspende la cuenta.')).id as id;
reset role;
select (not requiere_doble_control and contrato_id is null)::int as deberia_ser_1
from core.org_admin_action where id = (select id from _a);
rollback;

\echo 'A4. suspender con contrato vigente SIN aprobacion: confirmar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a)) as should_fail;
rollback;

\echo 'A5. el solicitante se aprueba a si mismo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a)) as should_fail;
rollback;

\echo 'A6. otro superadmin aprueba y el solicitante confirma: la organizacion queda suspendida y el resultado trae al aprobador y el contrato -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
reset role;
select ((select status from core.organization where id = '00000000-0000-0000-0000-0000000e7000') = 'suspended'
        and a.estado = 'executed' and a.aprobado_por = '00000000-0000-0000-0000-0000000e7101'
        and a.resultado->>'aprobado_por' = '00000000-0000-0000-0000-0000000e7101' and (a.resultado->>'contrato_version')::int = 1
        and (a.resultado->>'doble_control')::boolean)::int as deberia_ser_1
from core.org_admin_action a where a.id = (select id from _a);
rollback;

\echo 'A7. el aprobador NO es el solicitante: no puede confirmar la accion de otro -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a)) as should_fail;
rollback;

\echo 'A8. aprobar una accion que no requiere doble control -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7001', '{}', 'Cliente en mora de 90 dias, se suspende sin contrato.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a)) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Quien puede aprobar
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'B1. staff normal (owner de la propia organizacion) intenta aprobar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7102', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7102', (select id from _a)) as should_fail;
rollback;

\echo 'B2. superadmin restringido al rol finanzas (solo lectura) intenta aprobar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7103', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7103', (select id from _a)) as should_fail;
rollback;

\echo 'B3. anon no puede ejecutar approve_org_admin_action (sin GRANT EXECUTE) -- RECHAZADO'
begin;
set local role anon;
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', '00000000-0000-0000-0000-0000000e7600') as should_fail;
rollback;

\echo 'B4. sesion de sistema (auth.uid() nulo) intenta aprobar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', '00000000-0000-0000-0000-0000000e7600') as should_fail;
rollback;

\echo 'B5. caller-binding: p_caller_id de un superadmin pero auth.uid() de OTRO -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a)) as should_fail;
rollback;

\echo 'B6. aprobar dos veces la misma accion -- RECHAZADO la segunda'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a)) as should_fail;
rollback;

\echo 'B7. aprobar una accion que no existe -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', '00000000-0000-0000-0000-0000000e76ff') as should_fail;
rollback;

\echo 'B8. la aprobacion queda en la bitacora de seguridad con aprobador y solicitante -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
reset role;
select count(*) as deberia_ser_1 from core.superadmin_security_event e
where e.event = 'org_action_approved' and e.actor_user_id = '00000000-0000-0000-0000-0000000e7101'
  and e.detail->>'action_id' = (select id::text from _a) and e.detail->>'solicitado_por' = '00000000-0000-0000-0000-0000000e7100';
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Un solo uso y vencimiento
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'C1. confirmar dos veces la misma accion aprobada (replay) -- RECHAZADO el segundo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a)) as should_fail;
rollback;

\echo 'C2. aprobar una accion ya cancelada -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select core.cancel_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a)) as should_fail;
rollback;

\echo 'C3. aprobar una accion con doble control YA VENCIDA -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', '00000000-0000-0000-0000-0000000e7600') as should_fail;
rollback;

\echo 'C4. confirmar una accion con doble control vencida: queda expirada y la organizacion NO cambia -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', '00000000-0000-0000-0000-0000000e7600');
reset role;
select ((select estado from core.org_admin_action where id = '00000000-0000-0000-0000-0000000e7600') = 'expired'
        and (select status from core.organization where id = '00000000-0000-0000-0000-0000000e7000') = 'active')::int as deberia_ser_1;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) El mundo cambia entre la solicitud y la confirmacion
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'D1. la organizacion obtiene un contrato vigente DESPUES de solicitar la suspension: confirmar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7001', '{}', 'Cliente en mora de 90 dias, se suspende sin contrato.')).id as id;
reset role;
insert into core.customer_contract_version (id, contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by) values
  ('00000000-0000-0000-0000-0000000e7501', '00000000-0000-0000-0000-0000000e7501', '00000000-0000-0000-0000-0000000e7001', 1,
   (now() at time zone 'America/Mexico_City')::date - 1, null, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato firmado despues de la solicitud.', '00000000-0000-0000-0000-0000000e7100');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a)) as should_fail;
rollback;

\echo 'D2. cambiar a prueba una organizacion que obtiene contrato vigente despues de la solicitud: confirmar -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'cambiar_plan', '00000000-0000-0000-0000-0000000e7001', '{"plan":"trial"}', 'Vuelve a cuenta de prueba por acuerdo comercial firmado.')).id as id;
reset role;
insert into core.customer_contract_version (id, contract_id, organization_id, version, vigente_desde, vigente_hasta, base_centavos, por_sucursal_centavos, sucursales_incluidas, bolsa_minutos, excedente_centavos_minuto, instalacion_centavos, descuento_bp, descuento_fijo_centavos, motivo, created_by) values
  ('00000000-0000-0000-0000-0000000e7501', '00000000-0000-0000-0000-0000000e7501', '00000000-0000-0000-0000-0000000e7001', 1,
   (now() at time zone 'America/Mexico_City')::date - 1, null, 590000, 400000, 1, 10000, 300, 0, 0, 0, 'Fixture: contrato firmado despues de la solicitud.', '00000000-0000-0000-0000-0000000e7100');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a)) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Cambio de plan de cuenta atado al contrato
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'E1. pasar a prueba una organizacion con contrato vigente -- RECHAZADO al solicitar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'cambiar_plan', '00000000-0000-0000-0000-0000000e7000', '{"plan":"trial"}', 'Vuelve a cuenta de prueba por acuerdo comercial firmado.') as should_fail;
rollback;

\echo 'E2. pasar a activa una organizacion en prueba con contrato: se ejecuta en un solo paso y registra el contrato y su version vigente (2, la enmienda) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'cambiar_plan', '00000000-0000-0000-0000-0000000e7003', '{"plan":"active"}', 'Cliente firmo y paga: se activa su cuenta segun contrato.')).id as id;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
reset role;
select ((select status from core.organization where id = '00000000-0000-0000-0000-0000000e7003') = 'active'
        and not a.requiere_doble_control and a.contrato_id = '00000000-0000-0000-0000-0000000e7503' and a.contrato_version = 2
        and a.resultado->>'contrato_id' = '00000000-0000-0000-0000-0000000e7503' and (a.resultado->>'contrato_version')::int = 2)::int as deberia_ser_1
from core.org_admin_action a where a.id = (select id from _a);
rollback;

\echo 'E3. pasar a prueba una organizacion SIN contrato sigue funcionando (nada que hoy funcione se rompe) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'cambiar_plan', '00000000-0000-0000-0000-0000000e7001', '{"plan":"trial"}', 'Vuelve a cuenta de prueba por acuerdo comercial firmado.')).id as id;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
reset role;
select ((select status from core.organization where id = '00000000-0000-0000-0000-0000000e7001') = 'trial'
        and (a.resultado->>'contrato_version') is null)::int as deberia_ser_1
from core.org_admin_action a where a.id = (select id from _a);
rollback;

\echo 'E4. el alta de una organizacion nueva no cambia: un solo superadmin, queda en prueba -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'alta', null, '{"vertical":"citas","name":"Clinica Nueva","slug":"clinica-nueva-go"}', 'Cliente nuevo cerrado por ventas, se da de alta su organizacion.')).id as id;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
reset role;
select count(*) as deberia_ser_1 from core.organization where slug = 'clinica-nueva-go' and status = 'trial';
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) Reactivar restaura sin perder datos
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'F1. suspender (con doble control) y reactivar: vuelve a activa, sin doble control, y las sucursales siguen intactas -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
create temp table _b on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'reactivar', '00000000-0000-0000-0000-0000000e7000', '{}', 'El cliente regularizo su pago, se reactiva la cuenta.')).id as id;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _b));
reset role;
select ((select status from core.organization where id = '00000000-0000-0000-0000-0000000e7000') = 'active'
        and (select count(*) from core.property where organization_id = '00000000-0000-0000-0000-0000000e7000' and status = 'active') = 2
        and not (select requiere_doble_control from core.org_admin_action where id = (select id from _b)))::int as deberia_ser_1;
rollback;

\echo 'F2. suspender una organizacion en PRUEBA con contrato y reactivar: vuelve a prueba (estado previo) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7003', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
create temp table _b on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'reactivar', '00000000-0000-0000-0000-0000000e7003', '{}', 'El cliente regularizo su pago, se reactiva la cuenta.')).id as id;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _b));
reset role;
select count(*) as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000e7003' and status = 'trial';
rollback;

\echo 'F3. reactivar una organizacion suspendida sin historial: vuelve a activa -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'reactivar', '00000000-0000-0000-0000-0000000e7004', '{}', 'El cliente regularizo su pago, se reactiva la cuenta.')).id as id;
select core.confirm_org_admin_action('00000000-0000-0000-0000-0000000e7100', (select id from _a));
reset role;
select count(*) as deberia_ser_1 from core.organization where id = '00000000-0000-0000-0000-0000000e7004' and status = 'active';
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- G) Datos e historial inmutables
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'G1. el dueño intenta quitar el doble control de una solicitud -- RECHAZADO (guard 0A000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
reset role;
update core.org_admin_action set requiere_doble_control = false where id = (select id from _a) returning id as should_fail;
rollback;

\echo 'G2. la aprobacion no se reescribe (otro aprobador) -- RECHAZADO (guard 0A000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Cliente en mora de 90 dias, se suspende con doble control.')).id as id;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.approve_org_admin_action('00000000-0000-0000-0000-0000000e7101', (select id from _a));
reset role;
update core.org_admin_action set aprobado_por = '00000000-0000-0000-0000-0000000e7103' where id = (select id from _a) returning id as should_fail;
rollback;

\echo 'G3. CHECK de la base: aprobador igual al solicitante en una insercion directa -- RECHAZADO'
begin;
insert into core.org_admin_action (tipo, organization_id, payload, motivo, creado_por, vence_en, requiere_doble_control, aprobado_por, aprobado_en)
values ('suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Fixture: aprobacion del propio solicitante.', '00000000-0000-0000-0000-0000000e7100', now() + interval '1 hour', true,
        '00000000-0000-0000-0000-0000000e7100', now()) returning id as should_fail;
rollback;

\echo 'G4. CHECK de la base: aprobacion en una accion que no requiere doble control -- RECHAZADO'
begin;
insert into core.org_admin_action (tipo, organization_id, payload, motivo, creado_por, vence_en, requiere_doble_control, aprobado_por, aprobado_en)
values ('suspender', '00000000-0000-0000-0000-0000000e7001', '{}', 'Fixture: aprobacion sin doble control.', '00000000-0000-0000-0000-0000000e7100', now() + interval '1 hour', false,
        '00000000-0000-0000-0000-0000000e7101', now()) returning id as should_fail;
rollback;

\echo 'G5. DELETE sobre la bitacora de acciones -- RECHAZADO'
begin;
delete from core.org_admin_action where id = '00000000-0000-0000-0000-0000000e7600' returning id as should_fail;
rollback;

\echo 'G6. UPDATE sobre la bitacora de seguridad (eventos append-only) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7001', '{}', 'Cliente en mora de 90 dias, se suspende sin contrato.')).id as id;
reset role;
update core.superadmin_security_event set detail = '{}'::jsonb where event = 'org_action_requested' returning id as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- H) Acceso, GRANT y search_path
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'H1. staff normal solicita suspender su propia organizacion -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7102', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000e7102', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Staff normal intentando suspender a su propia organizacion.') as should_fail;
rollback;

\echo 'H2. anon no puede solicitar ni confirmar (sin GRANT EXECUTE) -- RECHAZADO'
begin;
set local role anon;
select core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'anon intentando suspender una organizacion cualquiera.') as should_fail;
rollback;

\echo 'H3. un tenant autenticado no lee ni escribe la tabla de acciones directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7102', true);
select count(*) as should_fail from core.org_admin_action;
rollback;

\echo 'H4. anon no lee la tabla de acciones -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.org_admin_action;
rollback;

\echo 'H5. cross-tenant: el owner de O1 (staff normal) lista las acciones por la funcion y recibe CERO filas -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7102', true);
select count(*) as deberia_ser_0 from core.list_org_admin_actions_for_superadmin('00000000-0000-0000-0000-0000000e7102', 50);
rollback;

\echo 'H6. el superadmin SI ve las acciones (incluida la bandera de doble control) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select count(*) as deberia_ser_1 from core.list_org_admin_actions_for_superadmin('00000000-0000-0000-0000-0000000e7100', 50) where requiere_doble_control;
rollback;

\echo 'H7. anon no tiene EXECUTE sobre las funciones de gestion de organizaciones y el helper de contrato no es ejecutable por ningun rol de la aplicacion -- OK'
begin;
select count(*) as deberia_ser_0 from (values
  (has_function_privilege('anon', 'core.approve_org_admin_action(uuid, uuid)', 'execute')),
  (has_function_privilege('anon', 'core.request_org_admin_action(uuid, text, uuid, jsonb, text)', 'execute')),
  (has_function_privilege('anon', 'core.confirm_org_admin_action(uuid, uuid)', 'execute')),
  (has_function_privilege('authenticated', 'core.org_contrato_vigente(uuid)', 'execute')),
  (has_function_privilege('anon', 'core.org_contrato_vigente(uuid)', 'execute'))
) t(x) where x;
rollback;

\echo 'H8. las funciones definer de gestion de organizaciones tienen search_path fijo -- OK'
begin;
select count(*) as deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'core' and p.proname in ('approve_org_admin_action', 'request_org_admin_action', 'confirm_org_admin_action', 'org_contrato_vigente', 'org_admin_action_guard')
  and (p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%'));
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- I) Una solicitud caducada no bloquea a la organizacion
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'I1. una solicitud pendiente YA VENCIDA (de otro superadmin) no bloquea una solicitud nueva: queda vencida con su evento y la nueva se crea -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
create temp table _a on commit drop as select (core.request_org_admin_action('00000000-0000-0000-0000-0000000e7101', 'suspender', '00000000-0000-0000-0000-0000000e7000', '{}', 'Nueva solicitud de suspension con doble control.')).id as id;
reset role;
select ((select estado from core.org_admin_action where id = '00000000-0000-0000-0000-0000000e7600') = 'expired'
        and (select estado from core.org_admin_action where id = (select id from _a)) = 'pending'
        and (select count(*) from core.superadmin_security_event e where e.event = 'org_action_expired' and e.detail->>'action_id' = '00000000-0000-0000-0000-0000000e7600') = 1)::int as deberia_ser_1;
rollback;

\echo 'I2. una solicitud vigente (no vencida) SI sigue bloqueando otra para la misma organizacion -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7100', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000e7100', 'suspender', '00000000-0000-0000-0000-0000000e7001', '{}', 'Primera solicitud de suspension sin contrato.');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7101', true);
select core.request_org_admin_action('00000000-0000-0000-0000-0000000e7101', 'cambiar_plan', '00000000-0000-0000-0000-0000000e7001', '{"plan":"trial"}', 'Segunda solicitud sobre la misma organizacion.') as should_fail;
rollback;
