-- QA adversarial citas, ronda 1, lente seguridad y datos (3-oct-2026).
--
-- Pruebas NUEVAS contra Postgres REAL (migraciones reales de supabase/migrations/,
-- RLS + GRANT + auth.uid() reales) que fijan el comportamiento SEGURO esperado.
-- Los escenarios marcados [DEFECTO] fallan HOY en main: documentan un hallazgo
-- del reporte de QA (QA-citas-R1-seguridad-NN) y deben pasar cuando se corrija.
-- Los marcados [CONTROL] pasan hoy y protegen contra regresiones.
--
-- Fixture: Org A con dos sucursales (A1, A2) y Org B (ajena). Un owner de A sin
-- restriccion de sucursal, un staff de A acotado a la sucursal A1 (rol 'staff'),
-- y un owner de B. Un proveedor por sucursal, un servicio por organizacion, un
-- cliente y una cita en la sucursal A2.
\set ON_ERROR_STOP off
\pset pager off

create schema verify_support;
grant usage on schema verify_support to authenticated, anon;
create function verify_support.expect_sqlstate(p_sql text, p_expected text) returns void
language plpgsql as $f$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> p_expected then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_expected, v_state, v_msg;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE %, pero la sentencia no fallo', p_expected;
end $f$;
grant execute on function verify_support.expect_sqlstate(text, text) to authenticated, anon;

-- Exige que la sentencia falle con CUALQUIERA de los SQLSTATE dados (p. ej. un rechazo de RLS 42501 o un AT403 de la funcion).
create function verify_support.expect_any_sqlstate(p_sql text, p_expected text[]) returns void
language plpgsql as $f$
declare
  v_state text;
  v_msg text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if not (v_state = any (p_expected)) then
      raise exception 'se esperaba uno de %, se obtuvo % (%)', p_expected, v_state, v_msg;
    end if;
    return;
  end;
  raise exception 'se esperaba un error (%), pero la sentencia no fallo', p_expected;
end $f$;
grant execute on function verify_support.expect_any_sqlstate(text, text[]) to authenticated, anon;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000aa01', 'citas', 'Clinica A (QA R1)', 'qa-r1-clinica-a'),
  ('00000000-0000-0000-0000-00000000bb01', 'citas', 'Clinica B (QA R1, ajena)', 'qa-r1-clinica-b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000aa01', 'citas', 'Sucursal A1'),
  ('00000000-0000-0000-0000-00000000a0a2', '00000000-0000-0000-0000-00000000aa01', 'citas', 'Sucursal A2'),
  ('00000000-0000-0000-0000-00000000b0b1', '00000000-0000-0000-0000-00000000bb01', 'citas', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0001', 'owner-a-qa@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0002', 'staff-a1-qa@example.com', 'Staff A1 (sucursal A1, rol staff)', 'seed'),
  ('00000000-0000-0000-0000-0000000b0001', 'owner-b-qa@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000aa01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000aa01', array['00000000-0000-0000-0000-00000000a0a1']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-00000000bb01', null, 'owner', 'owner')
on conflict do nothing;

insert into citas.tenant_config (organization_id, rubro, default_timezone, owner_notification_phone) values
  ('00000000-0000-0000-0000-00000000aa01', 'psicologo', 'America/Merida', '+5219990001111')
on conflict do nothing;

insert into citas.providers (id, organization_id, property_id, display_name) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a1', 'Psicologa A1'),
  ('00000000-0000-0000-0000-00000000c0a2', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a2', 'Psiquiatra A2'),
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000b0b1', 'Doctora B1')
on conflict do nothing;

insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000aa01', 'Terapia individual', 50),
  ('00000000-0000-0000-0000-00000000d0b1', '00000000-0000-0000-0000-00000000bb01', 'Consulta B', 30)
on conflict do nothing;

insert into citas.customers (id, organization_id, full_name, phone, email) values
  ('00000000-0000-0000-0000-00000000e0a2', '00000000-0000-0000-0000-00000000aa01', 'Paciente de A2', '+5219990002222', null)
on conflict do nothing;

insert into citas.appointments (id, organization_id, property_id, provider_id, service_id, customer_id, starts_at, ends_at, status, notes) values
  ('00000000-0000-0000-0000-00000000f0a2', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a2', '00000000-0000-0000-0000-00000000c0a2', '00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000e0a2', now() + interval '2 days', now() + interval '2 days 50 minutes', 'confirmed', 'nota clinica sensible')
on conflict do nothing;

\echo ''
\echo '=== A) Configuracion de la organizacion (rubro = guardia de crisis, telefono de avisos) ==='
\echo ''

\echo '--- 1. [DEFECTO QA-citas-R1-seguridad-01] un staff de rol "staff" acotado a la sucursal A1 NO debe poder cambiar el rubro de toda la organizacion (apaga la guardia de crisis de salud) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
with u as (update citas.tenant_config set rubro = 'otro' where organization_id = '00000000-0000-0000-0000-00000000aa01' returning 1)
select count(*) as staff_cambia_rubro_deberia_ser_0 from u;
rollback;

\echo '--- 2. [DEFECTO QA-citas-R1-seguridad-01] ese mismo staff NO debe poder redirigir el telefono de avisos (crisis y callbacks con el telefono del paciente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
with u as (update citas.tenant_config set owner_notification_phone = '+5219999999999' where organization_id = '00000000-0000-0000-0000-00000000aa01' returning 1)
select count(*) as staff_redirige_avisos_deberia_ser_0 from u;
rollback;

\echo '--- 3. [CONTROL] el owner de A SI puede cambiar la configuracion de su organizacion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
with u as (update citas.tenant_config set default_timezone = 'America/Mexico_City' where organization_id = '00000000-0000-0000-0000-00000000aa01' returning 1)
select count(*) as owner_cambia_config_deberia_ser_1 from u;
rollback;

\echo '--- 4. [CONTROL] el owner de B (otra organizacion) no ve ni cambia la configuracion de A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0001', true);
with u as (update citas.tenant_config set rubro = 'otro' where organization_id = '00000000-0000-0000-0000-00000000aa01' returning 1)
select count(*) as owner_ajeno_cambia_config_deberia_ser_0 from u;
rollback;

\echo ''
\echo '=== B) Calendarios externos: la cuenta de sincronizacion de un proveedor es de SU sucursal ==='
\echo ''

\echo '--- 5. [DEFECTO QA-citas-R1-seguridad-02] el staff de la sucursal A1 NO debe poder conectar un calendario CalDAV propio al proveedor de la sucursal A2 (cada cita sincronizada lleva nombre, telefono, servicio y notas del paciente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
select verify_support.expect_sqlstate($q$insert into citas.provider_caldav_accounts (organization_id, provider_id, caldav_calendar_collection_url, caldav_username, sync_status) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000c0a2', 'https://caldav.example.net/qa/', 'qa', 'connected')$q$, '42501') as expect_ok;
rollback;

\echo '--- 6. [DEFECTO QA-citas-R1-seguridad-02] lo mismo para la cuenta de Google Calendar del proveedor de A2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
select verify_support.expect_sqlstate($q$insert into citas.provider_calendar_accounts (organization_id, provider_id, google_calendar_id, sync_status) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000c0a2', 'primary', 'connected')$q$, '42501') as expect_ok;
rollback;

\echo '--- 7. [CONTROL] el staff de A1 tampoco puede tocar las reglas de disponibilidad del proveedor de A2 (RLS por sucursal ya existente) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
select verify_support.expect_sqlstate($q$insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time) values ('00000000-0000-0000-0000-00000000c0a2', 1, '09:00', '10:00')$q$, '42501') as expect_ok;
rollback;

\echo '--- 8. [DEFECTO QA-citas-R1-seguridad-03] el staff NO debe poder escribir directo el id del secreto de Vault de una cuenta de calendario (solo la funcion de sistema lo asigna) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select verify_support.expect_sqlstate($q$insert into citas.provider_calendar_accounts (organization_id, provider_id, google_calendar_id, google_refresh_token_secret_id, sync_status) values ('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000c0a1', 'primary', gen_random_uuid(), 'connected')$q$, '42501') as expect_ok;
rollback;

\echo '--- 9. [CONTROL, causa raiz de QA-citas-R1-seguridad-04] citas.set_provider_calendar_refresh_token es SOLO de sistema: una sesion de staff recibe 42501 (el panel de CalDAV/Cal.com la llama desde la sesion del staff) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select verify_support.expect_sqlstate($q$select citas.set_provider_calendar_refresh_token(null, 'valor-de-prueba')$q$, '42501') as expect_ok;
rollback;

\echo ''
\echo '=== C) Alta de cita: proveedor y servicio deben ser de la organizacion y sucursal de la cita ==='
\echo ''

\echo '--- 10. [DEFECTO QA-citas-R1-seguridad-05] create_appointment_from_panel: el staff de A1 NO debe poder agendar con el proveedor de la sucursal A2 declarando la sucursal A1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
select verify_support.expect_any_sqlstate($q$select citas.create_appointment_from_panel('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000c0a2', '00000000-0000-0000-0000-00000000d0a1', 'X', '+5219990003333', null, now() + interval '5 days', now() + interval '5 days 50 minutes', null)$q$, array['AT403', 'AT400', '42501']) as expect_ok;
rollback;

\echo '--- 11. [DEFECTO QA-citas-R1-seguridad-05] create_appointment_from_panel: el owner de A NO debe poder ocupar la agenda del proveedor de OTRA organizacion (B) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select verify_support.expect_any_sqlstate($q$select citas.create_appointment_from_panel('00000000-0000-0000-0000-00000000aa01', null, '00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000d0b1', 'X', '+5219990003334', null, now() + interval '6 days', now() + interval '6 days 30 minutes', null)$q$, array['AT403', 'AT400', '42501']) as expect_ok;
rollback;

\echo '--- 12. [DEFECTO QA-citas-R1-seguridad-05] create_appointment_idempotent (sistema): una cita de A con el proveedor de B debe rechazarse ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_any_sqlstate($q$select citas.create_appointment_idempotent(jsonb_build_object('organization_id','00000000-0000-0000-0000-00000000aa01','provider_id','00000000-0000-0000-0000-00000000c0b1','service_id','00000000-0000-0000-0000-00000000d0b1','customer_id','00000000-0000-0000-0000-00000000e0a2','starts_at',(now() + interval '7 days')::text,'ends_at',(now() + interval '7 days 30 minutes')::text,'source','whatsapp'), repeat('a', 64), null)$q$, array['AT403', 'AT400', '42501', '23503']) as expect_ok;
rollback;

\echo '--- 13. [CONTROL] create_appointment_from_panel: el owner de B no puede crear citas en la organizacion A (AT403) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0001', true);
select verify_support.expect_sqlstate($q$select citas.create_appointment_from_panel('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000d0a1', 'X', '+5219990003335', null, now() + interval '8 days', now() + interval '8 days 50 minutes', null)$q$, 'AT403') as expect_ok;
rollback;

\echo ''
\echo '=== D) Controles de acceso a la cita y a los datos de salud ==='
\echo ''

\echo '--- 14. [CONTROL] el staff de A1 no puede cancelar la cita de la sucursal A2 (AT403) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
select verify_support.expect_sqlstate($q$select citas.cancel_appointment_from_panel('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000f0a2')$q$, 'AT403') as expect_ok;
rollback;

\echo '--- 15. [CONTROL] el staff de A1 no ve la cita (ni sus notas) de la sucursal A2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0002', true);
select count(*) as staff_a1_ve_cita_a2_deberia_ser_0 from citas.appointments where id = '00000000-0000-0000-0000-00000000f0a2';
rollback;

\echo '--- 16. [CONTROL] el owner de B no puede marcar no-show ni confirmar la cita de A (AT403) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0001', true);
select verify_support.expect_sqlstate($q$select citas.mark_appointment_no_show_from_panel('00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000f0a2')$q$, 'AT403') as expect_ok;
rollback;

\echo '--- 17. [CONTROL] el owner de B no ve clientes de A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0001', true);
select count(*) as owner_b_ve_clientes_a_deberia_ser_0 from citas.customers where organization_id = '00000000-0000-0000-0000-00000000aa01';
rollback;

\echo '--- 18. [CONTROL] anon no lee citas, clientes ni configuracion ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select count(*) from citas.appointments$q$, '42501') as expect_ok;
rollback;

\echo '--- 19. [CONTROL] anon no lee clientes ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select count(*) from citas.customers$q$, '42501') as expect_ok;
rollback;

\echo '--- 20. [CONTROL] un staff no puede leer un secreto de calendario (funcion solo de sistema, 42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select verify_support.expect_sqlstate($q$select citas.get_provider_calendar_refresh_token(gen_random_uuid())$q$, '42501') as expect_ok;
rollback;
