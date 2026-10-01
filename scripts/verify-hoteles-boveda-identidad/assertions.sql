-- H-01 (P0) — BOVEDA DE IDENTIDAD + REGISTRO MIGRATORIO + PURGA CON DOBLE CONTROL.
-- Verifica contra Postgres REAL (nunca el mirror en memoria de domain-hoteles, que
-- jamas aplica RLS/GRANT/triggers/security definer) que
-- packages/domain-hoteles/migrations/031_hoteles_boveda_identidad.sql cierra lo que
-- dice cerrar. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs
-- (CI, auto-descubierto). Mismo patron que verify-hoteles-zona-horaria: fixtures
-- persistentes (superusuario) + cada escenario en su propio begin/rollback.
--
-- Convencion de los negativos: public.verify_expect_error(sql, sqlstate) ejecuta la
-- sentencia bajo el rol/auth.uid() activo y EXIGE el SQLSTATE exacto (42501 = RLS o
-- GRANT o funcion que rechaza, 23514 = CHECK, 23503 = guarda de trigger, 23505 =
-- unico, P0001/22023 = reglas de la funcion). Un negativo que fallara por OTRA razon
-- (p. ej. un typo) falla el escenario: no basta "algun error".
-- Los positivos/filtros silenciosos usan alias *_deberia_ser_N (valor exacto).
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures persistentes (superusuario, bypass RLS)
-- ---------------------------------------------------------------------------
create or replace function public.verify_expect_error(p_sql text, p_sqlstate text) returns void
language plpgsql as $$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_sqlstate then
      raise exception 'esperaba SQLSTATE %, obtuve % (%) en: %', p_sqlstate, v_state, v_msg, p_sql;
    end if;
    return;
  end;
  raise exception 'esperaba SQLSTATE % pero la sentencia no fallo: %', p_sqlstate, p_sql;
end;
$$;
grant execute on function public.verify_expect_error(text, text) to public;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-boveda'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-boveda')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a04', 'reservations-a@example.com', 'Reservations A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a05', 'housekeeping-a@example.com', 'Housekeeping A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001', null, 'member', 'reservations'),
  ('00000000-0000-0000-0000-0000000a0a05', '00000000-0000-0000-0000-00000000a001', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.guest (id, organization_id, property_id, full_name) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Huesped A'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Huesped B')
on conflict do nothing;

insert into hoteles.reservation (id, organization_id, property_id, guest_id, check_in_date, check_out_date, status, total_amount) values
  ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', '2026-01-01', '2026-01-05', 'confirmada', 4000),
  ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', '2026-02-01', '2026-02-03', 'confirmada', 2000),
  ('00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', '2026-03-10', '2026-03-12', 'confirmada', 2000),
  ('00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000c002', '2026-01-01', '2026-01-05', 'confirmada', 4000)
on conflict do nothing;

-- Boveda: v1 (revelar/verificar), v2 (solicitud de purga persistida), v3 (flujo de
-- purga), v4 (retencion vencida), vB (Hotel B). El sobre es un valor con el FORMATO
-- real (v1.<iv16>.<tag22>.<ct>), no un secreto.
insert into hoteles.identity_vault (id, property_id, guest_id, reservation_id, document_type, nationality, document_last4, payload_enc, retention_until) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000f101', 'pasaporte', 'USA', '1234', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', null, 'ine', 'MEX', '5678', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01'),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', null, 'licencia_conducir', 'MEX', '9012', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', null, 'otro', 'CAN', '3456', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2020-01-01'),
  ('00000000-0000-0000-0000-000000d00b01', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000c002', null, 'pasaporte', 'FRA', '7777', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01')
on conflict do nothing;

insert into hoteles.identity_purge_request (id, organization_id, property_id, vault_id, requested_by, reason) values
  ('00000000-0000-0000-0000-0000000e0001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000a0a01', 'Solicitud persistida de fixture')
on conflict do nothing;

-- Registro migratorio: reg1 pendiente (reserva f101), reg2 ya reportado (reserva f102).
insert into hoteles.migratory_registration (id, property_id, reservation_id, guest_id, vault_id) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000d0001'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000c001', null)
on conflict do nothing;
update hoteles.migratory_registration set status = 'reportado', constancia_ref = 'INM-0001'
 where id = '00000000-0000-0000-0000-0000000f0002' and status = 'pendiente';

-- =============================================================================
-- (a) Boveda: captura (positivo, trigger, GRANT de columna, cross-tenant)
-- =============================================================================

\echo '=== 1. frontdesk captura una identidad en SU property (insert real, RETURNING solo de columnas con GRANT) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.identity_vault (id, property_id, guest_id, document_type, nationality, document_last4, payload_enc, retention_until)
values ('00000000-0000-0000-0000-0000000d1001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'pasaporte', 'USA', '4321', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01')
returning id, status;
select count(*) as captura_visible_deberia_ser_1 from hoteles.identity_vault where id = '00000000-0000-0000-0000-0000000d1001' and status = 'activo';
rollback;

\echo '=== 2. el trigger DERIVA organization_id desde core.property, sella captured_by y fuerza estado activo/no verificado (el cliente no puede mandarlos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.identity_vault (id, property_id, guest_id, document_type, payload_enc, retention_until)
values ('00000000-0000-0000-0000-0000000d1002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01');
select count(*) as derivado_deberia_ser_1 from hoteles.identity_vault
 where id = '00000000-0000-0000-0000-0000000d1002'
   and organization_id = '00000000-0000-0000-0000-00000000a001'
   and captured_by = '00000000-0000-0000-0000-0000000a0a03'
   and verified_at is null and status = 'activo';
rollback;

\echo '=== 3. la captura deja huella automatica en la bitacora (accion captura) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.identity_vault (id, property_id, guest_id, document_type, payload_enc, retention_until)
values ('00000000-0000-0000-0000-0000000d1003', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select count(*) as huella_deberia_ser_1 from hoteles.identity_access_log where vault_id = '00000000-0000-0000-0000-0000000d1003' and action = 'captura' and actor_user_id = '00000000-0000-0000-0000-0000000a0a03';
rollback;

\echo '=== 4. housekeeping (rol sin acceso a identidad) NO puede capturar: RLS 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$
  insert into hoteles.identity_vault (property_id, guest_id, document_type, payload_enc, retention_until)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01')
$q$, '42501');
rollback;

\echo '=== 5. owner de Hotel B (cross-tenant) NO puede capturar en la property de Hotel A: RLS 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$
  insert into hoteles.identity_vault (property_id, guest_id, document_type, payload_enc, retention_until)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01')
$q$, '42501');
rollback;

\echo '=== 6. frontdesk de A intenta ligar un huesped de OTRA property (Hotel B): la guarda del trigger rechaza (23503) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$
  insert into hoteles.identity_vault (property_id, guest_id, document_type, payload_enc, retention_until)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c002', 'ine', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01')
$q$, '23503');
rollback;

\echo '=== 7. el CHECK de formato rechaza texto plano/JSON en payload_enc (23514): nadie guarda un documento sin cifrar por error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$
  insert into hoteles.identity_vault (property_id, guest_id, document_type, payload_enc, retention_until)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', '{"numero":"ABC123456"}', '2099-01-01')
$q$, '23514');
rollback;

\echo '=== 8. GRANT de columna: un INSERT que intenta fijar organization_id/status/captured_by es rechazado por Postgres (42501) ANTES de RLS ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$
  insert into hoteles.identity_vault (property_id, guest_id, document_type, payload_enc, retention_until, status)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01', 'purgado')
$q$, '42501');
rollback;

-- =============================================================================
-- (b) Boveda: lectura, el sobre cifrado nunca sale por SELECT
-- =============================================================================

\echo '=== 9. frontdesk SI ve los metadatos de la boveda de su property (4 fixtures activas de Hotel A) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as metadatos_deberia_ser_4 from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 10. NADIE con rol authenticated puede leer payload_enc por SELECT (sin GRANT de columna, 42501), ni siquiera owner ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select payload_enc from hoteles.identity_vault $q$, '42501');
select public.verify_expect_error($q$ select * from hoteles.identity_vault $q$, '42501');
rollback;

\echo '=== 11. cross-tenant en LECTURA: owner de Hotel B no ve ninguna identidad de Hotel A (solo la suya) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajenas_deberia_ser_0 from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 12. housekeeping no ve metadatos de identidad (RLS filtra en silencio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select count(*) as housekeeping_deberia_ser_0 from hoteles.identity_vault;
rollback;

\echo '=== 13. UPDATE y DELETE directos sobre la boveda estan cerrados para authenticated, owner incluido (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ update hoteles.identity_vault set status = 'purgado' $q$, '42501');
select public.verify_expect_error($q$ update hoteles.identity_vault set retention_until = '2000-01-01' $q$, '42501');
select public.verify_expect_error($q$ delete from hoteles.identity_vault $q$, '42501');
rollback;

\echo '=== 14. anon: rechazado por completo en la boveda (lectura y escritura, 42501) ==='
begin;
set local role anon;
select public.verify_expect_error($q$ select count(*) from hoteles.identity_vault $q$, '42501');
select public.verify_expect_error($q$
  insert into hoteles.identity_vault (property_id, guest_id, document_type, payload_enc, retention_until)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', 'v1.CCCCCCCCCCCCCCCC.DDDDDDDDDDDDDDDDDDDDDD.bnVldm8', '2099-01-01')
$q$, '42501');
rollback;

\echo '=== 15. inmutabilidad del sobre incluso para el superusuario/service_role: reescribir payload_enc es rechazado por el trigger (42501) ==='
begin;
select public.verify_expect_error($q$ update hoteles.identity_vault set payload_enc = 'v1.ZZZZZZZZZZZZZZZZ.YYYYYYYYYYYYYYYYYYYYYY.cmV3cml0dGVu' where id = '00000000-0000-0000-0000-0000000d0001' $q$, '42501');
rollback;

-- =============================================================================
-- (c) reveal_identity: autoriza, exige motivo, deja huella en la misma transaccion
-- =============================================================================

\echo '=== 16. frontdesk revela con motivo valido: recibe el sobre y queda UNA huella de revelacion legible por owner ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as sobres_deberia_ser_1 from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'Verificacion en mostrador al hacer check-in');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select count(*) as huella_revelacion_deberia_ser_1 from hoteles.identity_access_log
 where vault_id = '00000000-0000-0000-0000-0000000d0001' and action = 'revelacion' and actor_user_id = '00000000-0000-0000-0000-0000000a0a03' and reason like 'Verificacion%';
rollback;

\echo '=== 17. reservations (puede capturar pero no leer en claro) NO puede revelar (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a04', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'Intento sin permiso de rol') $q$, '42501');
rollback;

\echo '=== 18. owner de Hotel B (cross-tenant) NO puede revelar una identidad de Hotel A (42501, mismo error que id inexistente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'Intento cross-tenant de lectura') $q$, '42501');
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d9999', 'Id inexistente para sondear existencia') $q$, '42501');
rollback;

\echo '=== 19. motivo vacio o demasiado corto es rechazado (22023): no se revela sin justificacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'corto') $q$, '22023');
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', null) $q$, '22023');
rollback;

\echo '=== 20. anon NO puede ejecutar reveal_identity (42501, sin EXECUTE) y la sesion de SISTEMA tampoco revela (42501, exige staff) ==='
begin;
set local role anon;
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'Intento anonimo de lectura') $q$, '42501');
rollback;
begin;
set local role authenticated;
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'Intento de sesion de sistema') $q$, '42501');
rollback;

\echo '=== 21. una revelacion que falla (rol sin permiso) no deja huella falsa de acceso ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a04', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'Intento sin permiso de rol') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select count(*) as sin_huella_deberia_ser_0 from hoteles.identity_access_log where vault_id = '00000000-0000-0000-0000-0000000d0001' and action = 'revelacion';
rollback;

-- =============================================================================
-- (d) verify_identity
-- =============================================================================

\echo '=== 22. frontdesk verifica la identidad: verified_by/verified_at sellados server-side + huella ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select hoteles.verify_identity('00000000-0000-0000-0000-0000000d0001');
select count(*) as verificada_deberia_ser_1 from hoteles.identity_vault
 where id = '00000000-0000-0000-0000-0000000d0001' and verified_by = '00000000-0000-0000-0000-0000000a0a03' and verified_at is not null;
rollback;

\echo '=== 23. housekeeping y owner de Hotel B NO pueden verificar (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$ select hoteles.verify_identity('00000000-0000-0000-0000-0000000d0001') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.verify_identity('00000000-0000-0000-0000-0000000d0001') $q$, '42501');
rollback;

-- =============================================================================
-- (e) Purga con doble control
-- =============================================================================

\echo '=== 24. frontdesk NO puede solicitar una purga (solo owner/gm, 42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Solicitud de prueba sin permiso') $q$, '42501');
rollback;

\echo '=== 25. DOBLE CONTROL: quien solicita la purga NO puede aprobarla (42501 doble_control) ni rechazarla ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Solicitud de prueba para doble control');
select public.verify_expect_error($q$
  select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'auto-aprobacion')
$q$, '42501');
select public.verify_expect_error($q$
  select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), false, 'auto-rechazo')
$q$, '42501');
select count(*) as sigue_activa_deberia_ser_1 from hoteles.identity_vault where id = '00000000-0000-0000-0000-0000000d0003' and status = 'activo';
rollback;

\echo '=== 26. owner solicita, GM (otra persona) aprueba: desde 032 la identidad pasa a BLOQUEADA (no se purga de golpe): conserva el sobre y sella el bloqueo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Cancelacion ARCO solicitada por el titular');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'Aprobada tras verificar la solicitud');
reset role;
select count(*) as bloqueada_deberia_ser_1 from hoteles.identity_vault
 where id = '00000000-0000-0000-0000-0000000d0003' and status = 'bloqueada' and payload_enc is not null and purged_at is null
   and block_reason = 'solicitud_purga' and block_window_days = 7 and blocked_by = '00000000-0000-0000-0000-0000000a0a02' and blocked_until > now();
rollback;

\echo '=== 27. tras aprobar la purga la identidad esta bloqueada: revelar/verificar fallan (P0001 identidad_bloqueada) y la solicitud queda en_bloqueo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Cancelacion ARCO solicitada por el titular');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, null);
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0003', 'Intento de revelar tras purga') $q$, 'P0001');
select public.verify_expect_error($q$ select hoteles.verify_identity('00000000-0000-0000-0000-0000000d0003') $q$, 'P0001');
select count(*) as solicitud_en_bloqueo_deberia_ser_1 from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'en_bloqueo' and decided_by = '00000000-0000-0000-0000-0000000a0a02';
rollback;

\echo '=== 28. rechazar deja la identidad intacta y la solicitud en rechazada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Solicitud que sera rechazada en revision');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), false, 'Retencion aun vigente');
select count(*) as intacta_y_rechazada_deberia_ser_1 from hoteles.identity_vault v
 join hoteles.identity_purge_request r on r.vault_id = v.id
 where v.id = '00000000-0000-0000-0000-0000000d0003' and v.status = 'activo' and r.status = 'rechazada';
rollback;

\echo '=== 29. una solicitud ya resuelta no se puede decidir de nuevo (P0001) y no puede haber dos solicitudes pendientes de la misma identidad (23505) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Primera solicitud pendiente de prueba');
select public.verify_expect_error($q$ select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Segunda solicitud duplicada de prueba') $q$, '23505');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), false, 'Rechazada');
select public.verify_expect_error($q$
  select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'rechazada'), true, 'Reintento')
$q$, 'P0001');
rollback;

\echo '=== 30. el doble control tambien vive en los DATOS: ni el superusuario puede registrar decided_by = requested_by (23514) ==='
begin;
select public.verify_expect_error($q$
  update hoteles.identity_purge_request set status = 'ejecutada', decided_by = requested_by, decided_at = now() where id = '00000000-0000-0000-0000-0000000e0001'
$q$, '23514');
rollback;

\echo '=== 31. owner de Hotel B (cross-tenant) no puede decidir ni solicitar purgas de Hotel A (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.decide_identity_purge('00000000-0000-0000-0000-0000000e0001', true, 'Intento cross-tenant') $q$, '42501');
select public.verify_expect_error($q$ select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Solicitud cross-tenant de prueba') $q$, '42501');
rollback;

\echo '=== 32. solicitudes de purga: owner/gm las leen; frontdesk y owner de otra organizacion ven 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select count(*) as gm_ve_deberia_ser_1 from hoteles.identity_purge_request;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.identity_purge_request;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajeno_ve_deberia_ser_0 from hoteles.identity_purge_request;
rollback;

\echo '=== 33. las tablas de purga/bitacora no aceptan escritura directa de authenticated (42501) ni de anon ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$
  insert into hoteles.identity_purge_request (organization_id, property_id, vault_id, requested_by, reason)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000a0a01', 'Insert directo sin pasar por la funcion')
$q$, '42501');
select public.verify_expect_error($q$
  insert into hoteles.identity_access_log (organization_id, property_id, vault_id, actor_user_id, action)
  values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000a0a01', 'revelacion')
$q$, '42501');
rollback;

-- =============================================================================
-- (f) Purga por retencion (sistema) y bitacora
-- =============================================================================

\echo '=== 34. sesion de SISTEMA: el barrido BLOQUEA (no purga) lo vencido de UNA property: 1 bloqueada (v4) y 0 purgadas ==='
begin;
set local role authenticated;
select out_blocked as bloqueadas_deberia_ser_1 from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
rollback;
begin;
set local role authenticated;
select out_purged as purgadas_deberia_ser_0 from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
rollback;

\echo '=== 35. tras el barrido quedan 3 activas en Hotel A (las vigentes) y la de Hotel B intacta ==='
begin;
set local role authenticated;
select * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
select count(*) as activas_a_deberia_ser_3 from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000a1a01' and status = 'activo';
rollback;
begin;
set local role authenticated;
select * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
select count(*) as activas_b_deberia_ser_1 from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000b1b01' and status = 'activo';
rollback;

\echo '=== 36. el barrido bloquea la identidad vencida (la solicitud pendiente sigue abierta); al vencer la ventana la purga cierra la solicitud y deja huella purga_por_bloqueo_vencido con actor NULL ==='
begin;
update hoteles.identity_vault set retention_until = '2020-01-01' where id = '00000000-0000-0000-0000-0000000d0002';
set local role authenticated;
select * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
select count(*) as bloqueada_con_solicitud_abierta_deberia_ser_1 from hoteles.identity_purge_request r
 join hoteles.identity_vault v on v.id = r.vault_id and v.status = 'bloqueada' and v.block_reason = 'retencion_vencida'
 where r.vault_id = '00000000-0000-0000-0000-0000000d0002' and r.status = 'pendiente';
rollback;
begin;
update hoteles.identity_vault set retention_until = '2020-01-01' where id = '00000000-0000-0000-0000-0000000d0002';
set local role authenticated;
select * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
-- La guarda impide reescribir el bloqueo: para simular que pasaron los dias, el fixture
-- (superusuario) la desactiva solo dentro de esta transaccion revertida.
alter table hoteles.identity_vault disable trigger identity_vault_guard_trg;
update hoteles.identity_vault set blocked_until = now() - interval '1 hour', blocked_at = now() - interval '8 days' where id = '00000000-0000-0000-0000-0000000d0002';
alter table hoteles.identity_vault enable trigger identity_vault_guard_trg;
set local role authenticated;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
select count(*) as cerrada_y_con_huella_deberia_ser_1 from hoteles.identity_purge_request r
 join hoteles.identity_access_log l on l.vault_id = r.vault_id and l.action = 'purga_por_bloqueo_vencido' and l.actor_user_id is null
 join hoteles.identity_vault v on v.id = r.vault_id and v.status = 'purgado' and v.payload_enc is null
 where r.vault_id = '00000000-0000-0000-0000-0000000d0002' and r.status = 'ejecutada';
rollback;

\echo '=== 37. un usuario authenticated (con auth.uid) NO puede disparar el barrido de sistema (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') $q$, '42501');
rollback;

\echo '=== 38. anon NO puede ejecutar el barrido (42501, sin EXECUTE) ==='
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') $q$, '42501');
rollback;

\echo '=== 39. bitacora: owner de A ve solo la de su property (4 capturas de fixture), frontdesk 0, owner de B 0 de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select count(*) as bitacora_a_deberia_ser_4 from hoteles.identity_access_log;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as bitacora_frontdesk_deberia_ser_0 from hoteles.identity_access_log;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as bitacora_ajena_deberia_ser_1 from hoteles.identity_access_log;
rollback;

\echo '=== 40. la bitacora es append-only: UPDATE rechazado por trigger incluso para el superusuario (42501) ==='
begin;
select public.verify_expect_error($q$ update hoteles.identity_access_log set reason = 'reescrita' $q$, '42501');
rollback;

-- =============================================================================
-- (g) Registro migratorio
-- =============================================================================

\echo '=== 41. frontdesk crea el registro migratorio: el trigger copia fechas de la RESERVA y nacionalidad de la boveda, estado pendiente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.migratory_registration (property_id, reservation_id, guest_id, vault_id)
values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000d0001');
select count(*) as derivado_deberia_ser_1 from hoteles.migratory_registration
 where reservation_id = '00000000-0000-0000-0000-00000000f103' and arrival_date = '2026-03-10' and departure_date = '2026-03-12'
   and nationality = 'USA' and status = 'pendiente' and created_by = '00000000-0000-0000-0000-0000000a0a03'
   and organization_id = '00000000-0000-0000-0000-00000000a001';
rollback;

\echo '=== 42. housekeeping no puede crear registro migratorio (RLS 42501) y owner de Hotel B tampoco (cross-tenant) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$
  insert into hoteles.migratory_registration (property_id, reservation_id, guest_id)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000c001')
$q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$
  insert into hoteles.migratory_registration (property_id, reservation_id, guest_id)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000c001')
$q$, '42501');
rollback;

\echo '=== 43. una reserva de OTRA property no se puede ligar al registro de A (guarda del trigger, 23503) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$
  insert into hoteles.migratory_registration (property_id, reservation_id, guest_id)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f201', '00000000-0000-0000-0000-00000000c001')
$q$, '23503');
rollback;

\echo '=== 44. un solo registro por reserva+huesped (23505) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$
  insert into hoteles.migratory_registration (property_id, reservation_id, guest_id)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000c001')
$q$, '23505');
rollback;

\echo '=== 45. frontdesk marca como reportado con constancia: reported_by/reported_at sellados por el trigger ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
update hoteles.migratory_registration set status = 'reportado', constancia_ref = 'INM-2026-0042' where id = '00000000-0000-0000-0000-0000000f0001';
select count(*) as reportado_deberia_ser_1 from hoteles.migratory_registration
 where id = '00000000-0000-0000-0000-0000000f0001' and status = 'reportado' and reported_by = '00000000-0000-0000-0000-0000000a0a03' and reported_at is not null;
rollback;

\echo '=== 46. reportado SIN constancia es rechazado por el CHECK (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ update hoteles.migratory_registration set status = 'reportado' where id = '00000000-0000-0000-0000-0000000f0001' $q$, '23514');
rollback;

\echo '=== 47. GRANT de columna: UPDATE de organization_id/reservation_id es rechazado (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ update hoteles.migratory_registration set organization_id = '00000000-0000-0000-0000-00000000b001' where id = '00000000-0000-0000-0000-0000000f0001' $q$, '42501');
select public.verify_expect_error($q$ update hoteles.migratory_registration set reported_by = '00000000-0000-0000-0000-0000000a0a03' where id = '00000000-0000-0000-0000-0000000f0001' $q$, '42501');
rollback;

\echo '=== 48. un registro ya reportado no retrocede a pendiente (trigger, 42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ update hoteles.migratory_registration set status = 'pendiente', constancia_ref = null where id = '00000000-0000-0000-0000-0000000f0002' $q$, '42501');
rollback;

\echo '=== 49. lectura del registro: front-of-house ve los 2 de su property; owner de B y housekeeping ven 0; anon rechazado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a04', true);
select count(*) as reservations_ve_deberia_ser_2 from hoteles.migratory_registration;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajeno_ve_deberia_ser_0 from hoteles.migratory_registration;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select count(*) as housekeeping_ve_deberia_ser_0 from hoteles.migratory_registration;
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select count(*) from hoteles.migratory_registration $q$, '42501');
rollback;

-- =============================================================================
-- (h) Esquema de PRODUCCION a medio migrar (031 sin aplicar): 42P01/42883 reales,
-- recuperados con SAVEPOINT real -- mismo mecanismo que runWithSavepointFallback.
-- DDL transaccional: cada escenario revierte y las tablas siguen intactas.
-- =============================================================================

\echo '=== 50. con identity_vault ELIMINADA (42P01) el SAVEPOINT recupera la transaccion: la consulta siguiente, ajena, SI corre (nunca 25P02) ==='
begin;
drop table hoteles.migratory_registration;
drop table hoteles.identity_purge_request;
drop table hoteles.identity_access_log;
drop table hoteles.identity_vault cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
savepoint sp_verify_vault_missing;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from hoteles.identity_vault limit 1;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_vault_missing;
release savepoint sp_verify_vault_missing;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '=== 51. con reveal_identity ELIMINADA (42883) el SAVEPOINT recupera la transaccion ==='
begin;
drop function hoteles.reveal_identity(uuid, text);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
savepoint sp_verify_reveal_missing;
do $$
declare
  v_state text;
begin
  begin
    perform * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0001', 'Motivo suficientemente largo');
    raise exception 'se esperaba SQLSTATE 42883 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_reveal_missing;
release savepoint sp_verify_reveal_missing;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo '=== 52. control: tras los DDL destructivos de 50/51 (revertidos), la boveda y sus fixtures siguen intactas (5 filas) ==='
select count(*) as boveda_intacta_deberia_ser_5 from hoteles.identity_vault;
