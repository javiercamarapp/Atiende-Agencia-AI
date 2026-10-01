-- H-02 (P0) — CONSENTIMIENTO + ARCO + BLOQUEO PREVIO A PURGA + RETENCION LEGAL + INCIDENTES.
-- Verifica contra Postgres REAL (nunca el mirror en memoria de domain-hoteles, que jamas
-- aplica RLS/GRANT/triggers/security definer) que
-- packages/domain-hoteles/migrations/032_hoteles_consentimiento_arco_incidentes.sql cierra lo
-- que dice cerrar. Corre via ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs
-- (CI, auto-descubierto). Mismo patron que verify-hoteles-boveda-identidad: fixtures
-- persistentes (superusuario) + cada escenario en su propio begin/rollback.
--
-- Convencion de los negativos: public.verify_expect_error(sql, sqlstate) ejecuta la sentencia
-- bajo el rol/auth.uid() activo y EXIGE el SQLSTATE exacto (42501 = RLS/GRANT/funcion que
-- rechaza, 23514 = CHECK, 23503 = guarda de trigger, 23505 = unico, P0001/22023 = reglas de la
-- funcion). Los positivos/filtros silenciosos usan alias *_deberia_ser_N (valor exacto).
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
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-privacidad'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-privacidad')
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
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Huesped A1'),
  ('00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'Huesped A2'),
  ('00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'Huesped B')
on conflict do nothing;

-- Boveda: d0001 (activa, 2099), d0002 (activa con retencion VENCIDA), d0003 (activa, otro huesped), vB (Hotel B).
insert into hoteles.identity_vault (id, property_id, guest_id, document_type, nationality, document_last4, payload_enc, retention_until) values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'pasaporte', 'USA', '1234', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', 'ine', 'MEX', '5678', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2020-01-01'),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', 'licencia_conducir', 'MEX', '9012', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01'),
  ('00000000-0000-0000-0000-000000d00b01', '00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000c002', 'pasaporte', 'FRA', '7777', 'v1.AAAAAAAAAAAAAAAA.BBBBBBBBBBBBBBBBBBBBBB.Y2lwaGVydGV4dA', '2099-01-01')
on conflict do nothing;

-- Avisos de privacidad v1 de A y de B (vigentes).
insert into hoteles.privacy_notice (id, organization_id, property_id, version, simplified_text, mandatory_purposes, optional_purposes) values
  ('00000000-0000-0000-0000-0000000f0a01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'v1',
   'Usamos tus datos para identificarte, cumplir el registro de huespedes y facturar. Aviso integral en el enlace.',
   array['identificar al huesped', 'registro de huespedes', 'facturacion'], array['promociones y marketing']),
  ('00000000-0000-0000-0000-0000000f0b01', '00000000-0000-0000-0000-00000000b001', '00000000-0000-0000-0000-0000000b1b01', 'v1',
   'Usamos tus datos para identificarte, cumplir el registro de huespedes y facturar. Aviso integral en el enlace.',
   array['identificar al huesped', 'registro de huespedes', 'facturacion'], array['promociones y marketing'])
on conflict do nothing;

-- Consentimiento de fixture (A): lo inserta el superusuario (el trigger sella org/version/fecha).
insert into hoteles.identity_consent (id, property_id, guest_id, vault_id, notice_id, accepted_mandatory, accepted_optional, channel, evidence_method)
values ('00000000-0000-0000-0000-0000000c0a01', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-0000000d0001',
        '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], array['promociones y marketing'], 'mostrador', 'casilla_electronica')
on conflict do nothing;

-- Incidente de fixture (A), via la funcion (el superusuario simula la sesion del owner).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', false);
select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'acceso_no_autorizado', 'alta', 'Acceso indebido a la tableta de recepcion',
  'Se detecto un acceso no autorizado a la tableta de recepcion durante el turno de la noche.', now() - interval '3 hours', 12, true);
select set_config('request.jwt.claim.sub', '', false);

-- =============================================================================
-- (a) Aviso de privacidad versionado
-- =============================================================================

\echo '=== 1. owner publica una version NUEVA del aviso: la anterior deja de ser la vigente y la nueva queda vigente (una sola vigente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v2', 'Aviso simplificado v2: identificarte, registro de huespedes y facturacion. Integral en el enlace.',
  array['identificar al huesped', 'registro de huespedes', 'facturacion'], array['promociones y marketing', 'encuestas'], 'https://hotel-a.example.com/aviso', null);
select count(*) as una_vigente_v2_deberia_ser_1 from hoteles.privacy_notice
 where property_id = '00000000-0000-0000-0000-0000000a1a01' and is_current and version = 'v2'
   and (select count(*) from hoteles.privacy_notice where property_id = '00000000-0000-0000-0000-0000000a1a01' and is_current) = 1;
rollback;

\echo '=== 2. frontdesk/reservations NO publican el aviso, owner de OTRA organizacion tampoco (cross-tenant), anon sin EXECUTE (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v9', 'Aviso simplificado v9 de prueba para frontdesk.', array['finalidad uno'], array[]::text[], null, null) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v9', 'Aviso simplificado v9 de prueba cross-tenant.', array['finalidad uno'], array[]::text[], null, null) $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v9', 'Aviso simplificado v9 de prueba anon.', array['finalidad uno'], array[]::text[], null, null) $q$, '42501');
rollback;

\echo '=== 3. validaciones del aviso: finalidades vacias, solapadas o demasiado cortas, y version repetida (22023 / 23505) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v3', 'Aviso simplificado v3 sin finalidades obligatorias.', array[]::text[], array[]::text[], null, null) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v3', 'Aviso simplificado v3 con finalidad repetida.', array['identificar'], array['identificar'], null, null) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v3', 'Aviso simplificado v3 con finalidad corta.', array['ab'], array[]::text[], null, null) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v1', 'Aviso simplificado repetido de la version v1.', array['finalidad uno'], array[]::text[], null, null) $q$, '23505');
select public.verify_expect_error($q$ select hoteles.publish_privacy_notice('00000000-0000-0000-0000-0000000a1a01', 'v3', 'Aviso simplificado v3 con enlace inseguro.', array['finalidad uno'], array[]::text[], 'http://hotel-a.example.com/aviso', null) $q$, '23514');
rollback;

\echo '=== 4. un aviso publicado es inmutable (UPDATE de contenido rechazado por trigger incluso para el superusuario, 42501) ==='
begin;
select public.verify_expect_error($q$ update hoteles.privacy_notice set simplified_text = 'Texto alterado despues de publicarse el aviso.' where id = '00000000-0000-0000-0000-0000000f0a01' $q$, '42501');
rollback;

\echo '=== 5. front-of-house lee el aviso de SU property (1 de A + ninguno de B); housekeeping y owner de otra organizacion ven 0; anon rechazado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_1 from hoteles.privacy_notice;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select count(*) as housekeeping_ve_deberia_ser_0 from hoteles.privacy_notice;
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select count(*) from hoteles.privacy_notice $q$, '42501');
rollback;

-- =============================================================================
-- (b) Ledger de consentimientos
-- =============================================================================

\echo '=== 6. frontdesk registra el consentimiento ligado a la identidad: el trigger copia la version del aviso y sella org/captured_by/fecha (el cliente no los manda) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.identity_consent (id, property_id, guest_id, vault_id, notice_id, accepted_mandatory, accepted_optional, channel, evidence_method)
values ('00000000-0000-0000-0000-0000000c1001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000d0003',
        '00000000-0000-0000-0000-0000000f0a01', array['facturacion', 'identificar al huesped', 'registro de huespedes'], array[]::text[], 'tableta', 'firma_electronica');
select count(*) as sellado_deberia_ser_1 from hoteles.identity_consent
 where id = '00000000-0000-0000-0000-0000000c1001' and notice_version = 'v1' and captured_by = '00000000-0000-0000-0000-0000000a0a03'
   and organization_id = '00000000-0000-0000-0000-00000000a001' and consented_at is not null and revoked_at is null;
rollback;

\echo '=== 7. consentimiento sin TODAS las finalidades obligatorias, o con una opcional que no esta en el aviso, o con una obligatoria de mas: rechazado (22023) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped'], 'mostrador', 'casilla_electronica') $q$, '22023');
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, accepted_optional, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], array['venta de datos'], 'mostrador', 'casilla_electronica') $q$, '22023');
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion', 'otra'], 'mostrador', 'casilla_electronica') $q$, '22023');
rollback;

\echo '=== 8. datos SENSIBLES exigen consentimiento expreso y por escrito: casilla/aviso mostrado rechazado por CHECK (23514); firma electronica aceptada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method, sensitive_data)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica', true) $q$, '23514');
insert into hoteles.identity_consent (id, property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method, sensitive_data)
values ('00000000-0000-0000-0000-0000000c1002', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01',
        array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'firma_electronica', true);
select count(*) as sensible_con_firma_deberia_ser_1 from hoteles.identity_consent where id = '00000000-0000-0000-0000-0000000c1002' and sensitive_data;
rollback;

\echo '=== 9. cross-tenant: huesped o identidad de OTRA property, aviso de otra property (23503) y front-of-house de A no escribe en B (RLS 42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica') $q$, '23503');
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, vault_id, notice_id, accepted_mandatory, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-000000d00b01', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica') $q$, '23503');
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0b01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica') $q$, '23503');
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000c002', '00000000-0000-0000-0000-0000000f0b01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica') $q$, '42501');
rollback;

\echo '=== 10. GRANT de columna: el cliente no puede fijar captured_by/notice_version/consented_at (42501); housekeeping y anon no insertan; no hay UPDATE ni DELETE directos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method, captured_by)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica', '00000000-0000-0000-0000-0000000a0a01') $q$, '42501');
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method, notice_version)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica', 'v-falsa') $q$, '42501');
select public.verify_expect_error($q$ update hoteles.identity_consent set channel = 'web' $q$, '42501');
select public.verify_expect_error($q$ delete from hoteles.identity_consent $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$ insert into hoteles.identity_consent (property_id, guest_id, notice_id, accepted_mandatory, channel, evidence_method)
  values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000f0a01', array['identificar al huesped', 'registro de huespedes', 'facturacion'], 'mostrador', 'casilla_electronica') $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select count(*) from hoteles.identity_consent $q$, '42501');
rollback;

\echo '=== 11. lectura del ledger: front-of-house de A ve 1; housekeeping y owner de B ven 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a04', true);
select count(*) as reservations_ve_deberia_ser_1 from hoteles.identity_consent;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajeno_ve_deberia_ser_0 from hoteles.identity_consent where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 12. revocacion: front-of-house revoca (sella revoked_*), una segunda revocacion es P0001, motivo corto 22023, y el consentimiento revocado es inmutable (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a04', true);
select public.verify_expect_error($q$ select hoteles.revoke_identity_consent('00000000-0000-0000-0000-0000000c0a01', 'corto') $q$, '22023');
select hoteles.revoke_identity_consent('00000000-0000-0000-0000-0000000c0a01', 'El titular retira su consentimiento de marketing');
select public.verify_expect_error($q$ select hoteles.revoke_identity_consent('00000000-0000-0000-0000-0000000c0a01', 'Segunda revocacion de prueba') $q$, 'P0001');
select count(*) as revocado_deberia_ser_1 from hoteles.identity_consent where id = '00000000-0000-0000-0000-0000000c0a01' and revoked_at is not null and revoked_by = '00000000-0000-0000-0000-0000000a0a04';
rollback;
begin;
select hoteles.revoke_identity_consent('00000000-0000-0000-0000-0000000c0a01', 'Revocacion como superusuario no aplica') where false;
update hoteles.identity_consent set revoked_at = now(), revoked_by = '00000000-0000-0000-0000-0000000a0a04', revoke_reason = 'Revocacion de fixture para probar inmutabilidad' where id = '00000000-0000-0000-0000-0000000c0a01';
select public.verify_expect_error($q$ update hoteles.identity_consent set channel = 'web' where id = '00000000-0000-0000-0000-0000000c0a01' $q$, '42501');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$ select hoteles.revoke_identity_consent('00000000-0000-0000-0000-0000000c0a01', 'Housekeeping no debe poder revocar') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.revoke_identity_consent('00000000-0000-0000-0000-0000000c0a01', 'Owner de otra organizacion no puede') $q$, '42501');
rollback;

-- =============================================================================
-- (c) Ventana de bloqueo y bloqueo manual
-- =============================================================================

\echo '=== 13. sin configuracion la ventana es 7 dias; owner/gm la fijan (3-30) y queda en la bitacora quien y de que valor a que valor ==='
begin;
select hoteles.identity_block_window('00000000-0000-0000-0000-0000000a1a01') as ventana_default_deberia_ser_7;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.set_identity_block_window('00000000-0000-0000-0000-0000000a1a01', 14);
reset role;
select count(*) as ventana_14_con_huella_deberia_ser_1 from hoteles.privacy_settings s
 join hoteles.privacy_event_log l on l.property_id = s.property_id and l.action = 'ventana_bloqueo' and l.note = 'de 7 a 14 dias' and l.actor_user_id = '00000000-0000-0000-0000-0000000a0a02'
 where s.property_id = '00000000-0000-0000-0000-0000000a1a01' and s.block_window_days = 14 and s.updated_by = '00000000-0000-0000-0000-0000000a0a02';
rollback;

\echo '=== 14. ventana fuera de rango (2 o 31) = 22023; frontdesk y owner de otra organizacion = 42501; CHECK de la tabla 3-30 incluso para el superusuario (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.set_identity_block_window('00000000-0000-0000-0000-0000000a1a01', 2) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.set_identity_block_window('00000000-0000-0000-0000-0000000a1a01', 31) $q$, '22023');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.set_identity_block_window('00000000-0000-0000-0000-0000000a1a01', 10) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.set_identity_block_window('00000000-0000-0000-0000-0000000a1a01', 10) $q$, '42501');
rollback;
begin;
select public.verify_expect_error($q$ insert into hoteles.privacy_settings (property_id, organization_id, block_window_days) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 2) $q$, '23514');
rollback;

\echo '=== 15. owner bloquea a mano una identidad ACTIVA: queda bloqueada con la ventana y el sobre conservado; deja huella en la bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
reset role;
select count(*) as bloqueada_deberia_ser_1 from hoteles.identity_vault v
 join hoteles.identity_access_log l on l.vault_id = v.id and l.action = 'bloqueo' and l.actor_user_id = '00000000-0000-0000-0000-0000000a0a01'
 where v.id = '00000000-0000-0000-0000-0000000d0003' and v.status = 'bloqueada' and v.payload_enc is not null and v.block_reason = 'manual'
   and v.block_window_days = 7 and v.blocked_until > now() + interval '6 days';
rollback;

\echo '=== 16. bloquear: frontdesk/anon/cross-tenant = 42501; motivo corto 22023; ya bloqueada o purgada = P0001 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Frontdesk no puede bloquear identidades') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Owner de otra organizacion no puede bloquear') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'corto') $q$, '22023');
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select public.verify_expect_error($q$ select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Segundo bloqueo de la misma identidad') $q$, 'P0001');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Anon no puede bloquear identidades') $q$, '42501');
rollback;

\echo '=== 17. una identidad bloqueada NO tiene acceso operativo: revelar, verificar y solicitar purga fallan (P0001 identidad_bloqueada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_identity('00000000-0000-0000-0000-0000000d0003', 'Intento de revelar una identidad bloqueada') $q$, 'P0001');
select public.verify_expect_error($q$ select hoteles.verify_identity('00000000-0000-0000-0000-0000000d0003') $q$, 'P0001');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Solicitud de purga de una identidad bloqueada') $q$, 'P0001');
rollback;

\echo '=== 18. A NIVEL DE DATOS: ni siquiera el superusuario purga una identidad activa (purga_sin_bloqueo), una bloqueada con ventana vigente (bloqueo_vigente), ni desbloquea ni reescribe el bloqueo (42501) ==='
begin;
select public.verify_expect_error($q$ update hoteles.identity_vault set status = 'purgado', payload_enc = null, document_last4 = null, nationality = null, purged_at = now() where id = '00000000-0000-0000-0000-0000000d0003' $q$, '42501');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
reset role;
select public.verify_expect_error($q$ update hoteles.identity_vault set status = 'purgado', payload_enc = null, document_last4 = null, nationality = null, purged_at = now() where id = '00000000-0000-0000-0000-0000000d0003' $q$, '42501');
select public.verify_expect_error($q$ update hoteles.identity_vault set status = 'activo', blocked_at = null, blocked_until = null, block_window_days = null, block_reason = null where id = '00000000-0000-0000-0000-0000000d0003' $q$, '42501');
select public.verify_expect_error($q$ update hoteles.identity_vault set blocked_until = now() - interval '1 day' where id = '00000000-0000-0000-0000-0000000d0003' $q$, '42501');
rollback;

\echo '=== 19. CHECK de coherencia: una identidad bloqueada sin sus datos de bloqueo es rechazada (23514) ==='
begin;
select public.verify_expect_error($q$ update hoteles.identity_vault set status = 'bloqueada' where id = '00000000-0000-0000-0000-0000000d0003' $q$, '23514');
rollback;

\echo '=== 20. las columnas de bloqueo las lee front-of-house; el sobre sigue fuera del GRANT (42501 al seleccionarlo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as bloqueo_legible_deberia_ser_3 from (select blocked_at, blocked_until, block_window_days, block_reason, blocked_by from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000a1a01') x;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select payload_enc from hoteles.identity_vault $q$, '42501');
rollback;

-- =============================================================================
-- (d) Aprobacion de purga => bloqueo; barrido del sistema
-- =============================================================================

\echo '=== 21. doble control: owner solicita, GM aprueba: la identidad queda BLOQUEADA (ventana, sobre conservado) y la solicitud en_bloqueo (NO purgada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Cancelacion ARCO solicitada por el titular');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'Aprobada tras verificar la solicitud');
reset role;
select count(*) as en_bloqueo_deberia_ser_1 from hoteles.identity_purge_request r
 join hoteles.identity_vault v on v.id = r.vault_id
 where r.vault_id = '00000000-0000-0000-0000-0000000d0003' and r.status = 'en_bloqueo' and v.status = 'bloqueada' and v.block_reason = 'solicitud_purga' and v.payload_enc is not null;
rollback;

\echo '=== 22. el barrido de SISTEMA bloquea (no purga) lo vencido de UNA property: 1 bloqueada (d0002), 0 purgadas; Hotel B intacto ==='
begin;
set local role authenticated;
select out_blocked as bloqueadas_deberia_ser_1 from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
rollback;
begin;
set local role authenticated;
select out_purged as purgadas_deberia_ser_0 from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
rollback;
begin;
set local role authenticated;
select * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
select count(*) as activas_b_deberia_ser_1 from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000b1b01' and status = 'activo';
rollback;

\echo '=== 23. al vencer la ventana (simulada) la purga anula sobre/last4/nacionalidad, cierra la solicitud y deja huella purga_por_bloqueo_vencido con actor NULL ==='
begin;
set local role authenticated;
select hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
alter table hoteles.identity_vault disable trigger identity_vault_guard_trg;
update hoteles.identity_vault set blocked_until = now() - interval '1 hour', blocked_at = now() - interval '8 days' where id = '00000000-0000-0000-0000-0000000d0002';
alter table hoteles.identity_vault enable trigger identity_vault_guard_trg;
set local role authenticated;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
select count(*) as purgada_con_huella_deberia_ser_1 from hoteles.identity_vault v
 join hoteles.identity_access_log l on l.vault_id = v.id and l.action = 'purga_por_bloqueo_vencido' and l.actor_user_id is null
 where v.id = '00000000-0000-0000-0000-0000000d0002' and v.status = 'purgado' and v.payload_enc is null and v.document_last4 is null and v.nationality is null and v.purged_at is not null;
rollback;

\echo '=== 24. purge_expired_identities YA NO purga identidades ACTIVAS aunque su retencion este vencida (solo las bloqueadas con ventana vencida) ==='
begin;
set local role authenticated;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') as purgadas_deberia_ser_0;
rollback;

\echo '=== 25. un usuario authenticated (con auth.uid) NO dispara el barrido ni la purga de sistema (42501); anon sin EXECUTE (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') $q$, '42501');
select public.verify_expect_error($q$ select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') $q$, '42501');
rollback;

\echo '=== 26. las funciones internas (block_identity_internal, privacy_log_event, identity_block_window) NO son invocables por authenticated ni anon (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.block_identity_internal('00000000-0000-0000-0000-0000000d0003', 'manual', null, 'x') $q$, '42501');
select public.verify_expect_error($q$ select hoteles.privacy_log_event('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'arco', null, 'falsa', null) $q$, '42501');
select public.verify_expect_error($q$ select hoteles.identity_block_window('00000000-0000-0000-0000-0000000a1a01') $q$, '42501');
rollback;

-- =============================================================================
-- (e) Acceso excepcional a identidades bloqueadas (doble control, un solo uso, caduca)
-- =============================================================================

\echo '=== 27. owner pide, GM aprueba, owner revela UNA vez (huella acceso_excepcional_revelacion); el segundo intento es P0001 (usada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_blocked_access((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'Aprobado con el oficio a la vista');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select out_key_version as revelo_deberia_ser_1 from hoteles.reveal_blocked_identity((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'aprobada'));
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_blocked_access((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'Aprobado con el oficio a la vista');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select * from hoteles.reveal_blocked_identity((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'aprobada'));
select public.verify_expect_error($q$ select * from hoteles.reveal_blocked_identity((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003')) $q$, 'P0001');
reset role;
select count(*) as huella_y_usada_deberia_ser_1 from hoteles.identity_access_log l
 join hoteles.identity_blocked_access_request r on r.vault_id = l.vault_id and r.status = 'usada' and r.used_at is not null
 where l.vault_id = '00000000-0000-0000-0000-0000000d0003' and l.action = 'acceso_excepcional_revelacion' and l.actor_user_id = '00000000-0000-0000-0000-0000000a0a01';
rollback;

\echo '=== 28. DOBLE CONTROL del acceso excepcional: quien pide NO puede aprobar ni rechazar (42501); el CHECK de la tabla lo impide incluso para el superusuario (23514) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select public.verify_expect_error($q$ select hoteles.decide_blocked_access((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'auto-aprobacion') $q$, '42501');
select public.verify_expect_error($q$ select hoteles.decide_blocked_access((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), false, 'auto-rechazo') $q$, '42501');
reset role;
select public.verify_expect_error($q$ update hoteles.identity_blocked_access_request set status = 'aprobada', decided_by = requested_by, decided_at = now(), expires_at = now() + interval '1 hour' where vault_id = '00000000-0000-0000-0000-0000000d0003' $q$, '23514');
rollback;

\echo '=== 29. solo QUIEN PIDIO el acceso lo consume (otra persona recibe 42501); una aprobacion caducada o rechazada = P0001 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_blocked_access((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'Aprobado');
select public.verify_expect_error($q$ select * from hoteles.reveal_blocked_identity((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003')) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_blocked_identity((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003')) $q$, '42501');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_blocked_access((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'Aprobado');
reset role;
update hoteles.identity_blocked_access_request set expires_at = now() - interval '1 minute' where vault_id = '00000000-0000-0000-0000-0000000d0003';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_blocked_identity((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003')) $q$, 'P0001');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_blocked_access((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), false, 'Sin sustento suficiente');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select * from hoteles.reveal_blocked_identity((select id from hoteles.identity_blocked_access_request where vault_id = '00000000-0000-0000-0000-0000000d0003')) $q$, 'P0001');
rollback;

\echo '=== 30. pedir acceso excepcional: frontdesk/cross-tenant/anon = 42501; identidad ACTIVA = P0001 (se revela por el flujo normal); motivo corto = 22023; una sola solicitud abierta (23505) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'La identidad aun esta activa y no aplica') $q$, 'P0001');
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select public.verify_expect_error($q$ select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'corto') $q$, '22023');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select public.verify_expect_error($q$ select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Segunda solicitud abierta de la misma identidad') $q$, '23505');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Frontdesk no puede pedir acceso excepcional') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Owner de otra organizacion no puede pedir') $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Anon no puede pedir acceso excepcional') $q$, '42501');
rollback;

\echo '=== 31. solicitudes de acceso excepcional: owner/gm las leen; frontdesk y owner de otra organizacion ven 0; sin escritura directa (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.request_blocked_access('00000000-0000-0000-0000-0000000d0003', 'Requerimiento de autoridad con oficio 123');
select count(*) as owner_ve_deberia_ser_1 from hoteles.identity_blocked_access_request;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.identity_blocked_access_request;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ insert into hoteles.identity_blocked_access_request (organization_id, property_id, vault_id, requested_by, reason) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000a0a01', 'Escritura directa no permitida') $q$, '42501');
rollback;

-- =============================================================================
-- (f) Retencion legal por incidente (legal hold)
-- =============================================================================

\echo '=== 32. owner aplica una retencion legal (folio + motivo + autorizacion) a una identidad bloqueada con la ventana VENCIDA: la purga NO ocurre mientras dure el caso ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0003', 'FGR-2026-0042', 'Carpeta de investigacion abierta por el incidente de la tableta', 'Oficio FGR/2026/0042 recibido por direccion juridica', null);
reset role;
alter table hoteles.identity_vault disable trigger identity_vault_guard_trg;
update hoteles.identity_vault set blocked_until = now() - interval '1 hour', blocked_at = now() - interval '8 days' where id = '00000000-0000-0000-0000-0000000d0003';
alter table hoteles.identity_vault enable trigger identity_vault_guard_trg;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') as purgadas_con_hold_deberia_ser_0;
rollback;

\echo '=== 33. con retencion legal activa la identidad sigue BLOQUEADA y conservada; al liberarla (nota obligatoria) el siguiente barrido la purga ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0003', 'FGR-2026-0042', 'Carpeta de investigacion abierta por el incidente de la tableta', 'Oficio FGR/2026/0042 recibido por direccion juridica', null);
reset role;
alter table hoteles.identity_vault disable trigger identity_vault_guard_trg;
update hoteles.identity_vault set blocked_until = now() - interval '1 hour', blocked_at = now() - interval '8 days' where id = '00000000-0000-0000-0000-0000000d0003';
alter table hoteles.identity_vault enable trigger identity_vault_guard_trg;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.release_legal_hold((select id from hoteles.legal_hold where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'activa'), 'Caso cerrado por la autoridad; se libera la retencion');
reset role;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') as purgadas_tras_liberar_deberia_ser_1;
rollback;

\echo '=== 34. A NIVEL DE DATOS: con retencion legal activa ni el superusuario purga la identidad aunque la ventana haya vencido (42501 retencion_legal) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.block_identity('00000000-0000-0000-0000-0000000d0003', 'Bloqueo preventivo por solicitud del titular');
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0003', 'FGR-2026-0042', 'Carpeta de investigacion abierta por el incidente de la tableta', 'Oficio FGR/2026/0042 recibido por direccion juridica', null);
reset role;
alter table hoteles.identity_vault disable trigger identity_vault_guard_trg;
update hoteles.identity_vault set blocked_until = now() - interval '1 hour', blocked_at = now() - interval '8 days' where id = '00000000-0000-0000-0000-0000000d0003';
alter table hoteles.identity_vault enable trigger identity_vault_guard_trg;
select public.verify_expect_error($q$ update hoteles.identity_vault set status = 'purgado', payload_enc = null, document_last4 = null, nationality = null, purged_at = now() where id = '00000000-0000-0000-0000-0000000d0003' $q$, '42501');
rollback;

\echo '=== 35. retencion legal ligada a un incidente de la misma property; el hold tambien se aplica a una identidad ACTIVA y la bitacora deja huella (retencion_legal_aplicada) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'INC-LEGAL-1', 'Evidencia del incidente de la tableta de recepcion', 'Direccion juridica del hotel', (select id from hoteles.privacy_incident limit 1));
reset role;
select count(*) as hold_con_incidente_y_huella_deberia_ser_1 from hoteles.legal_hold h
 join hoteles.identity_access_log l on l.vault_id = h.vault_id and l.action = 'retencion_legal_aplicada'
 where h.vault_id = '00000000-0000-0000-0000-0000000d0001' and h.status = 'activa' and h.incident_id is not null and h.review_due_on > (now() at time zone 'utc')::date + 360;
rollback;

\echo '=== 36. retencion legal: frontdesk/cross-tenant/anon = 42501; folio, motivo o autorizacion cortos = 22023; incidente de otra property = 23503 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Frontdesk no puede aplicar retenciones', 'Direccion', null) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Owner de otra organizacion no puede', 'Direccion', null) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'ab', 'Folio demasiado corto para la retencion', 'Direccion', null) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'corto', 'Direccion', null) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Motivo suficiente para la retencion', 'ab', null) $q$, '22023');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Anon no puede aplicar retenciones', 'Direccion', null) $q$, '42501');
rollback;
begin;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000b1b01', 'perdida_robo', 'media', 'Perdida de un expediente en B', 'Se extravio un expediente fisico en la property de Hotel B.', now() - interval '1 hour', 1, false);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Incidente de otra property no es valido', 'Direccion juridica', (select id from hoteles.privacy_incident where property_id = '00000000-0000-0000-0000-0000000b1b01')) $q$, '23503');
rollback;

\echo '=== 37. liberar la retencion: nota corta = 22023; ya liberada = P0001; frontdesk = 42501; la lectura de retenciones es solo owner/gm ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Motivo suficiente para la retencion', 'Direccion juridica', null);
select public.verify_expect_error($q$ select hoteles.release_legal_hold((select id from hoteles.legal_hold limit 1), 'corto') $q$, '22023');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.release_legal_hold((select id from hoteles.legal_hold limit 1), 'Frontdesk no puede liberar la retencion') $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.release_legal_hold((select id from hoteles.legal_hold limit 1), 'Caso cerrado por la autoridad; se libera la retencion');
select public.verify_expect_error($q$ select hoteles.release_legal_hold((select id from hoteles.legal_hold limit 1), 'Segunda liberacion de la misma retencion') $q$, 'P0001');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Motivo suficiente para la retencion', 'Direccion juridica', null);
select count(*) as owner_ve_deberia_ser_1 from hoteles.legal_hold;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0001', 'CASO-1', 'Motivo suficiente para la retencion', 'Direccion juridica', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.legal_hold;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ insert into hoteles.legal_hold (organization_id, property_id, vault_id, folio, reason, authorization_ref, placed_by, review_due_on) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-0000000d0001', 'CASO-X', 'Escritura directa no permitida', 'Direccion', '00000000-0000-0000-0000-0000000a0a01', current_date) $q$, '42501');
rollback;

\echo '=== 38. la aprobacion de una purga sobre una identidad con retencion legal BLOQUEA pero no purga: sigue bloqueada tras vencer la ventana ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.place_legal_hold('00000000-0000-0000-0000-0000000d0003', 'CASO-1', 'Motivo suficiente para la retencion', 'Direccion juridica', null);
select hoteles.request_identity_purge('00000000-0000-0000-0000-0000000d0003', 'Cancelacion ARCO solicitada por el titular');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.decide_identity_purge((select id from hoteles.identity_purge_request where vault_id = '00000000-0000-0000-0000-0000000d0003' and status = 'pendiente'), true, 'Aprobada tras verificar la solicitud');
reset role;
alter table hoteles.identity_vault disable trigger identity_vault_guard_trg;
update hoteles.identity_vault set blocked_until = now() - interval '1 hour', blocked_at = now() - interval '8 days' where id = '00000000-0000-0000-0000-0000000d0003';
alter table hoteles.identity_vault enable trigger identity_vault_guard_trg;
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
reset role;
select count(*) as sigue_bloqueada_deberia_ser_1 from hoteles.identity_vault where id = '00000000-0000-0000-0000-0000000d0003' and status = 'bloqueada' and payload_enc is not null;
rollback;

-- =============================================================================
-- (g) Solicitudes ARCO
-- =============================================================================

\echo '=== 39. owner abre una solicitud ARCO: folio ARCO-..., estado recibida, respuesta = recepcion + 20 dias, bitacora solicitud_recibida ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', 'juan@example.com', 'correo', 'Solicita copia de sus datos', (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c001', null);
select count(*) as abierta_deberia_ser_1 from hoteles.arco_request
 where folio like 'ARCO-%' and status = 'recibida' and response_due_on = received_on + 20 and execution_due_on is null and created_by = '00000000-0000-0000-0000-0000000a0a01';
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select count(*) as bitacora_deberia_ser_1 from hoteles.privacy_event_log where subject_type = 'arco' and action = 'solicitud_recibida';
rollback;

\echo '=== 40. abrir ARCO: frontdesk/cross-tenant/anon = 42501; derecho invalido = 23514; fecha futura o muy vieja = 22023; huesped o identidad de otra property = 23503 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'borrado', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null) $q$, '23514');
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date + 5, null, null) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date - 400, null, null) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c002', null) $q$, '23503');
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, '00000000-0000-0000-0000-000000d00b01') $q$, '23503');
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000d0001') $q$, '23503');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null) $q$, '42501');
rollback;

\echo '=== 41. flujo con plazos: recibida -> procedente (ejecucion = hoy + 15) -> ejecutada (executed_at); cada transicion exige nota y deja bitacora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'rectificacion', 'Maria Lopez', null, 'mostrador', null, (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c001', null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'Se verifica la identidad y procede la rectificacion', (now() at time zone 'utc')::date);
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'ejecutada', 'Se corrigieron los datos y se aviso al titular', (now() at time zone 'utc')::date);
select count(*) as ejecutada_deberia_ser_1 from hoteles.arco_request
 where status = 'ejecutada' and executed_at is not null and decided_on = (now() at time zone 'utc')::date and execution_due_on = (now() at time zone 'utc')::date + 15;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'rectificacion', 'Maria Lopez', null, 'mostrador', null, (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c001', null);
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'en_revision', 'Se solicita documentacion adicional', (now() at time zone 'utc')::date);
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'improcedente', 'No se acredita la identidad del solicitante', (now() at time zone 'utc')::date);
select count(*) as bitacora_deberia_ser_3 from hoteles.privacy_event_log where subject_type = 'arco' and action in ('solicitud_recibida', 'arco_en_revision', 'arco_improcedente');
rollback;

\echo '=== 42. transiciones invalidas = P0001 (recibida->ejecutada, improcedente es terminal); nota corta o fecha desfasada = 22023; frontdesk/cross-tenant = 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'oposicion', 'Maria Lopez', null, 'mostrador', null, (now() at time zone 'utc')::date, null, null);
select public.verify_expect_error($q$ select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'ejecutada', 'Intento de saltar la procedencia', (now() at time zone 'utc')::date) $q$, 'P0001');
select public.verify_expect_error($q$ select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'corto', (now() at time zone 'utc')::date) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'Fecha de negocio desfasada del servidor', (now() at time zone 'utc')::date + 10) $q$, '22023');
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'improcedente', 'La oposicion no procede por obligacion legal', (now() at time zone 'utc')::date);
select public.verify_expect_error($q$ select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'Un estado terminal no se reabre', (now() at time zone 'utc')::date) $q$, 'P0001');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'en_revision', 'Frontdesk no puede avanzar solicitudes', (now() at time zone 'utc')::date) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'en_revision', 'Owner de otra organizacion no puede avanzar', (now() at time zone 'utc')::date) $q$, '42501');
rollback;

\echo '=== 43. prorroga: una sola vez, con motivo, igual plazo que la fase abierta (respuesta +20); la segunda es P0001; tras procedente, la prorroga de ejecucion tambien cuenta como la unica ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select public.verify_expect_error($q$ select hoteles.extend_arco_request((select id from hoteles.arco_request limit 1), 'corto') $q$, '22023');
select hoteles.extend_arco_request((select id from hoteles.arco_request limit 1), 'Se requiere recabar informacion de varias areas del hotel');
select public.verify_expect_error($q$ select hoteles.extend_arco_request((select id from hoteles.arco_request limit 1), 'Segunda prorroga que no esta permitida') $q$, 'P0001');
select count(*) as prorrogada_deberia_ser_1 from hoteles.arco_request
 where extension_phase = 'respuesta' and response_due_on = received_on + 40 and extension_reason is not null and extended_by = '00000000-0000-0000-0000-0000000a0a01';
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'rectificacion', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'Procede la rectificacion solicitada', (now() at time zone 'utc')::date);
select hoteles.extend_arco_request((select id from hoteles.arco_request limit 1), 'La correccion requiere validar documentos con el area fiscal');
select count(*) as prorroga_ejecucion_deberia_ser_1 from hoteles.arco_request
 where extension_phase = 'ejecucion' and execution_due_on = (now() at time zone 'utc')::date + 30;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'oposicion', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'improcedente', 'La oposicion no procede por obligacion legal', (now() at time zone 'utc')::date);
select public.verify_expect_error($q$ select hoteles.extend_arco_request((select id from hoteles.arco_request limit 1), 'No se puede prorrogar una solicitud ya resuelta') $q$, 'P0001');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.extend_arco_request((select id from hoteles.arco_request limit 1), 'Frontdesk no puede prorrogar solicitudes') $q$, '42501');
rollback;

\echo '=== 44. ARCO de CANCELACION procedente bloquea la identidad ligada (y las activas del huesped si no hay una ligada); nunca purga de golpe ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'cancelacion', 'Huesped A2', null, 'correo', null, (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000d0003');
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'Procede la cancelacion de los datos del titular', (now() at time zone 'utc')::date);
reset role;
select count(*) as bloqueada_por_arco_deberia_ser_1 from hoteles.identity_vault where id = '00000000-0000-0000-0000-0000000d0003' and status = 'bloqueada' and block_reason = 'arco' and payload_enc is not null;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'cancelacion', 'Huesped A1', null, 'correo', null, (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c001', null);
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'Procede la cancelacion de los datos del titular', (now() at time zone 'utc')::date);
reset role;
select count(*) as bloqueadas_del_huesped_deberia_ser_2 from hoteles.identity_vault where guest_id = '00000000-0000-0000-0000-00000000c001' and status = 'bloqueada' and block_reason = 'arco';
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Huesped A2', null, 'correo', null, (now() at time zone 'utc')::date, '00000000-0000-0000-0000-00000000c003', '00000000-0000-0000-0000-0000000d0003');
select hoteles.advance_arco_request((select id from hoteles.arco_request limit 1), 'procedente', 'Procede el acceso a los datos del titular', (now() at time zone 'utc')::date);
reset role;
select count(*) as acceso_no_bloquea_deberia_ser_1 from hoteles.identity_vault where id = '00000000-0000-0000-0000-0000000d0003' and status = 'activo';
rollback;

\echo '=== 45. lectura ARCO: owner/gm la ven; frontdesk, housekeeping y owner de otra organizacion ven 0; anon rechazado; SIN escritura ni UPDATE directos (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
select count(*) as gm_ve_deberia_ser_1 from hoteles.arco_request;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.arco_request;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajeno_ve_deberia_ser_0 from hoteles.arco_request;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ insert into hoteles.arco_request (organization_id, property_id, folio, right_type, requester_name, channel, received_on, response_due_on) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'ARCO-X', 'acceso', 'Juan Perez', 'correo', current_date, current_date + 20) $q$, '42501');
select public.verify_expect_error($q$ update hoteles.arco_request set status = 'ejecutada' $q$, '42501');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select count(*) from hoteles.arco_request $q$, '42501');
rollback;

-- =============================================================================
-- (h) Incidentes / vulneraciones
-- =============================================================================

\echo '=== 46. frontdesk REPORTA un incidente (folio INC-..., detectada, riesgo significativo); no puede leerlo; owner lo lee ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'divulgacion', 'alta', 'Correo enviado al huesped equivocado', 'Se envio por error una confirmacion con datos personales a otro huesped.', now() - interval '30 minutes', 1, true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.privacy_incident;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'divulgacion', 'alta', 'Correo enviado al huesped equivocado', 'Se envio por error una confirmacion con datos personales a otro huesped.', now() - interval '30 minutes', 1, true);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select count(*) as owner_ve_deberia_ser_2 from hoteles.privacy_incident where status = 'detectada' and folio like 'INC-%' and significant_risk;
rollback;

\echo '=== 47. reportar: housekeeping/cross-tenant/anon = 42501; fecha futura = 22023; tipo o severidad invalidos y titulo corto = 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a05', true);
select public.verify_expect_error($q$ select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'otro', 'baja', 'Housekeeping reporta', 'Housekeeping no deberia poder reportar incidentes.', now(), null, false) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'otro', 'baja', 'Cross tenant reporta', 'Owner de otra organizacion no deberia poder reportar.', now(), null, false) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'otro', 'baja', 'Fecha en el futuro', 'La fecha de deteccion no puede estar en el futuro.', now() + interval '2 days', null, false) $q$, '22023');
select public.verify_expect_error($q$ select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'virus', 'baja', 'Tipo invalido de incidente', 'El tipo de incidente no pertenece al catalogo permitido.', now(), null, false) $q$, '23514');
select public.verify_expect_error($q$ select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'otro', 'critica', 'Severidad invalida', 'La severidad no pertenece al catalogo permitido.', now(), null, false) $q$, '23514');
select public.verify_expect_error($q$ select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'otro', 'baja', 'ab', 'El titulo es demasiado corto para registrarse.', now(), null, false) $q$, '23514');
rollback;
begin;
set local role anon;
select public.verify_expect_error($q$ select hoteles.report_privacy_incident('00000000-0000-0000-0000-0000000a1a01', 'otro', 'baja', 'Anon reporta', 'Anon no deberia poder reportar incidentes.', now(), null, false) $q$, '42501');
rollback;

\echo '=== 48. estados: contener (detectada->contenida), registrar la notificacion al titular (SOLO registro: canal + constancia), cerrar; repetir una accion = P0001 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'contener', 'Se desconecto la tableta y se cambiaron credenciales', null, null);
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'contener', 'Segunda contencion no permitida', null, null) $q$, 'P0001');
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'registrar_notificacion', null, 'x', 'ref') $q$, '22023');
select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'registrar_notificacion', null, 'correo electronico', 'Constancia de envio 2026-0007');
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'registrar_notificacion', null, 'correo electronico', 'Otra constancia') $q$, 'P0001');
select count(*) as contenida_y_notificada_deberia_ser_1 from hoteles.privacy_incident
 where status = 'contenida' and contained_at is not null and notified_at is not null and notified_by = '00000000-0000-0000-0000-0000000a0a01' and notification_channel = 'correo electronico';
rollback;

\echo '=== 49. cerrar un incidente con riesgo significativo SIN notificacion exige el motivo de no notificar (P0001); con motivo o con notificacion cierra; un incidente cerrado no admite acciones (P0001) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'cerrar', 'Se cierra el incidente tras la revision del caso', null, null) $q$, 'P0001');
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'cerrar', 'corto', null, 'Los datos expuestos no permiten un dano patrimonial ni moral') $q$, '22023');
select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'cerrar', 'Se cierra el incidente tras la revision del caso', null, 'Los datos expuestos no permiten un dano patrimonial ni moral');
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'contener', 'Un incidente cerrado no se modifica', null, null) $q$, 'P0001');
select count(*) as cerrado_con_motivo_deberia_ser_1 from hoteles.privacy_incident where status = 'cerrada' and closed_by = '00000000-0000-0000-0000-0000000a0a01' and no_notification_reason is not null;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'registrar_notificacion', null, 'correo electronico', 'Constancia de envio 2026-0007');
select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'cerrar', 'Se cierra el incidente con el titular notificado', null, null);
select count(*) as cerrado_notificado_deberia_ser_1 from hoteles.privacy_incident where status = 'cerrada' and notified_at is not null and no_notification_reason is null;
rollback;

\echo '=== 50. gestionar incidentes: frontdesk y owner de otra organizacion = 42501; accion desconocida = 22023; sin escritura directa (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'contener', null, null, null) $q$, '42501');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident where property_id = '00000000-0000-0000-0000-0000000a1a01' limit 1), 'contener', null, null, null) $q$, '42501');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ select hoteles.update_privacy_incident((select id from hoteles.privacy_incident limit 1), 'borrar', null, null, null) $q$, '22023');
select public.verify_expect_error($q$ update hoteles.privacy_incident set status = 'cerrada' $q$, '42501');
select public.verify_expect_error($q$ delete from hoteles.privacy_incident $q$, '42501');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ajeno_ve_deberia_ser_0 from hoteles.privacy_incident where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 51. CHECKs de coherencia del incidente: cerrada sin closed_at, o notificada sin notified_by, rechazadas incluso para el superusuario (23514) ==='
begin;
select public.verify_expect_error($q$ update hoteles.privacy_incident set status = 'cerrada' $q$, '23514');
select public.verify_expect_error($q$ update hoteles.privacy_incident set notified_at = now() $q$, '23514');
rollback;

-- =============================================================================
-- (i) Bitacora de privacidad, ajustes y GRANT en general
-- =============================================================================

\echo '=== 52. la bitacora de privacidad es append-only (UPDATE rechazado por trigger incluso para el superusuario, 42501), sin escritura directa de authenticated y solo owner/gm la leen ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select public.verify_expect_error($q$ insert into hoteles.privacy_event_log (organization_id, property_id, subject_type, action) values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'arco', 'falsa') $q$, '42501');
reset role;
select public.verify_expect_error($q$ update hoteles.privacy_event_log set action = 'alterada' $q$, '42501');
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.privacy_event_log;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.open_arco_request('00000000-0000-0000-0000-0000000a1a01', 'acceso', 'Juan Perez', null, 'correo', null, (now() at time zone 'utc')::date, null, null);
select count(*) as owner_ve_deberia_ser_1 from hoteles.privacy_event_log where subject_type = 'arco';
rollback;

\echo '=== 53. anon NO tiene acceso a NINGUNA tabla nueva (42501) ==='
begin;
set local role anon;
select public.verify_expect_error($q$ select count(*) from hoteles.privacy_event_log $q$, '42501');
select public.verify_expect_error($q$ select count(*) from hoteles.privacy_settings $q$, '42501');
select public.verify_expect_error($q$ select count(*) from hoteles.privacy_incident $q$, '42501');
select public.verify_expect_error($q$ select count(*) from hoteles.legal_hold $q$, '42501');
select public.verify_expect_error($q$ select count(*) from hoteles.identity_blocked_access_request $q$, '42501');
rollback;

\echo '=== 54. ajustes: owner/gm los leen; frontdesk y owner de otra organizacion ven 0; sin escritura directa (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.set_identity_block_window('00000000-0000-0000-0000-0000000a1a01', 10);
select count(*) as owner_ve_deberia_ser_1 from hoteles.privacy_settings;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select hoteles.set_identity_block_window('00000000-0000-0000-0000-0000000a1a01', 10);
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
select count(*) as frontdesk_ve_deberia_ser_0 from hoteles.privacy_settings;
rollback;
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
select public.verify_expect_error($q$ insert into hoteles.privacy_settings (property_id, organization_id, block_window_days) values ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 9) $q$, '42501');
rollback;

-- =============================================================================
-- (j) Base a medio migrar (032 sin aplicar): 42P01/42883/42703 reales, recuperados con
-- SAVEPOINT real -- mismo mecanismo que runWithSavepointFallback. DDL transaccional.
-- =============================================================================

\echo '=== 55. con las tablas de 032 ELIMINADAS (42P01) el SAVEPOINT recupera la transaccion: la consulta siguiente, ajena, SI corre (nunca 25P02) ==='
begin;
drop table hoteles.identity_consent cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
savepoint sp_verify_consent_missing;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from hoteles.identity_consent limit 1;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_consent_missing;
release savepoint sp_verify_consent_missing;
select count(*) as transaccion_recuperada_deberia_ser_1 from hoteles.privacy_notice;
rollback;

\echo '=== 56. con sweep_identity_retention ELIMINADA (42883) el SAVEPOINT recupera la transaccion y el camino anterior (purge_expired_identities) SI corre ==='
begin;
drop function hoteles.sweep_identity_retention(uuid, date);
set local role authenticated;
savepoint sp_verify_sweep_missing;
do $$
declare
  v_state text;
begin
  begin
    perform * from hoteles.sweep_identity_retention('00000000-0000-0000-0000-0000000a1a01', '2026-01-01');
    raise exception 'se esperaba SQLSTATE 42883 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_sweep_missing;
release savepoint sp_verify_sweep_missing;
select hoteles.purge_expired_identities('00000000-0000-0000-0000-0000000a1a01', '2026-01-01') as camino_anterior_deberia_ser_0;
rollback;

\echo '=== 57. con las columnas de bloqueo AUSENTES (42703) el SAVEPOINT recupera la transaccion y la consulta con las columnas de 031 SI corre (lista la boveda sin bloqueo) ==='
begin;
alter table hoteles.identity_vault drop column blocked_at cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
savepoint sp_verify_cols_missing;
do $$
declare
  v_state text;
begin
  begin
    perform blocked_at from hoteles.identity_vault limit 1;
    raise exception 'se esperaba SQLSTATE 42703 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_cols_missing;
release savepoint sp_verify_cols_missing;
select count(*) as boveda_legada_deberia_ser_3 from (select id, status, retention_until from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000a1a01') x;
rollback;

\echo '=== 58. control: tras los DDL destructivos de 55-57 (revertidos), las tablas y fixtures siguen intactas (3 identidades de A) ==='
select count(*) as boveda_intacta_deberia_ser_3 from hoteles.identity_vault where property_id = '00000000-0000-0000-0000-0000000a1a01';
