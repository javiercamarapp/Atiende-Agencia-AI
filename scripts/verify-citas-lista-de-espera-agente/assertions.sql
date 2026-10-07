-- QA citas R1 features-12 (corrección tras revisión): inscripción en la lista de espera desde el agente de WhatsApp/voz.
--
-- Contra Postgres REAL con las migraciones reales (RLS + GRANT + auth.uid() reales). La sesión de SISTEMA es el rol `authenticated` con sub vacío
-- (auth.uid() NULL): NO es service_role ni BYPASSRLS. Escenarios [DEFECTO] documentan la causa raíz (la política de staff nunca aplica a sistema);
-- [CONTROL] fijan el comportamiento seguro de la función nueva (migración 034).
--
-- Fixture: Org A (sucursal A1, proveedor y servicio, un owner) y Org B (ajena, proveedor y servicio propios). Una anotación activa ya existente en A
-- (creada por el staff) para comprobar que sistema no la ve por SELECT directo.
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

create function verify_support.expect_eq(p_actual text, p_expected text) returns void
language plpgsql as $f$
begin
  if p_actual is distinct from p_expected then
    raise exception 'se esperaba %, se obtuvo %', p_expected, p_actual;
  end if;
end $f$;
grant execute on function verify_support.expect_eq(text, text) to authenticated, anon;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000aa01', 'citas', 'Clinica A (lista de espera)', 'le-clinica-a'),
  ('00000000-0000-0000-0000-00000000bb01', 'citas', 'Clinica B (ajena)', 'le-clinica-b')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000a0a1', '00000000-0000-0000-0000-00000000aa01', 'citas', 'Sucursal A1'),
  ('00000000-0000-0000-0000-00000000b0b1', '00000000-0000-0000-0000-00000000bb01', 'citas', 'Sucursal B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0001', 'owner-a-le@example.com', 'Owner A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000aa01', null, 'owner', 'owner')
on conflict do nothing;

insert into citas.providers (id, organization_id, property_id, display_name) values
  ('00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000aa01', '00000000-0000-0000-0000-00000000a0a1', 'Psicologa A1'),
  ('00000000-0000-0000-0000-00000000c0b1', '00000000-0000-0000-0000-00000000bb01', '00000000-0000-0000-0000-00000000b0b1', 'Doctora B1')
on conflict do nothing;

insert into citas.services (id, organization_id, name, duration_minutes) values
  ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000aa01', 'Terapia individual', 50),
  ('00000000-0000-0000-0000-00000000d0b1', '00000000-0000-0000-0000-00000000bb01', 'Consulta B', 30)
on conflict do nothing;

-- Anotación preexistente de A (la creó el staff desde el panel).
insert into citas.appointment_waitlist (organization_id, customer_phone, customer_name, preferred_time_window) values
  ('00000000-0000-0000-0000-00000000aa01', '9991110000', 'Preexistente A', 'any');

\echo ''
\echo '=== A) Causa raiz: la sesion de sistema esta sujeta a RLS ==='
\echo ''

\echo '--- 1. [DEFECTO causa raiz] el INSERT directo en sesion de sistema (rol authenticated, auth.uid() NULL) es rechazado por RLS (42501) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$insert into citas.appointment_waitlist (organization_id, customer_phone, preferred_time_window) values ('00000000-0000-0000-0000-00000000aa01', '9992220000', 'any')$q$, '42501') as expect_ok;
rollback;

\echo '--- 2. [DEFECTO causa raiz] el SELECT directo en sesion de sistema devuelve 0 filas aunque la anotacion existe (por eso idempotencia y tope no funcionaban) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_lee_directo_deberia_ser_0 from citas.appointment_waitlist where organization_id = '00000000-0000-0000-0000-00000000aa01';
rollback;

\echo ''
\echo '=== B) La funcion de sistema inscribe, es idempotente y respeta el tope ==='
\echo ''

\echo '--- 3. [CONTROL] sistema inscribe y recibe la fila creada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_eq((select out_outcome from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9993330000', 'Cliente Agente', '00000000-0000-0000-0000-00000000c0a1', '00000000-0000-0000-0000-00000000d0a1', '2099-01-10', '2099-01-20', 'morning', 5)), 'created') as expect_ok;
rollback;

\echo '--- 4. [CONTROL] reintentar la MISMA anotacion devuelve la existente (already_waiting) con el mismo id, sin duplicar ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $t$
declare r1 record; r2 record;
begin
  select * into r1 from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9993330001', 'Cliente Agente', null, null, null, null, 'any', 5);
  select * into r2 from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9993330001', 'Cliente Agente', null, null, null, null, 'any', 5);
  if r1.out_outcome <> 'created' or r2.out_outcome <> 'already_waiting' or r1.out_id <> r2.out_id then
    raise exception 'idempotencia rota: % / % / % vs %', r1.out_outcome, r2.out_outcome, r1.out_id, r2.out_id;
  end if;
end $t$;
rollback;

\echo '--- 5. [CONTROL] el tope: con 5 anotaciones activas distintas del mismo telefono, la sexta es too_many y no se inserta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $t$
declare r record; i integer;
begin
  for i in 1..5 loop
    select * into r from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9994440000', null, null, null, ('2099-02-0' || i)::date, null, 'any', 5);
    if r.out_outcome <> 'created' then raise exception 'la anotacion % deberia crearse, fue %', i, r.out_outcome; end if;
  end loop;
  select * into r from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9994440000', null, null, null, '2099-03-01', null, 'any', 5);
  if r.out_outcome <> 'too_many' or r.out_id is not null then raise exception 'la sexta deberia ser too_many, fue %', r.out_outcome; end if;
end $t$;
rollback;

\echo '--- 6. [CONTROL] el tope y la idempotencia ven la anotacion preexistente del staff: repetirla es already_waiting (no duplica) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_eq((select out_outcome from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9991110000', 'Preexistente A', null, null, null, null, 'any', 5)), 'already_waiting') as expect_ok;
rollback;

\echo '--- 7. [CONTROL] una franja invalida es rechazada por la restriccion de la tabla (23514), no inserta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9995550000', null, null, null, null, null, 'madrugada', 5)$q$, '23514') as expect_ok;
rollback;

\echo ''
\echo '=== C) Cross-tenant ==='
\echo ''

\echo '--- 8. [CONTROL] el mismo telefono en OTRA organizacion es otra anotacion: la preexistente de A no cuenta ni se devuelve en B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_eq((select out_outcome from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000bb01', '9991110000', 'Mismo telefono en B', null, null, null, null, 'any', 5)), 'created') as expect_ok;
rollback;

\echo '--- 9. [CONTROL] un proveedor de la organizacion A no se puede usar para anotar en B (AT404) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000bb01', '9996660000', null, '00000000-0000-0000-0000-00000000c0a1', null, null, null, 'any', 5)$q$, 'AT404') as expect_ok;
rollback;

\echo '--- 10. [CONTROL] un servicio de la organizacion A no se puede usar para anotar en B (AT404) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select verify_support.expect_sqlstate($q$select * from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000bb01', '9996660001', null, null, '00000000-0000-0000-0000-00000000d0a1', null, null, 'any', 5)$q$, 'AT404') as expect_ok;
rollback;

\echo ''
\echo '=== D) Solo sistema: staff y anon no la invocan ==='
\echo ''

\echo '--- 11. [CONTROL] una sesion de staff (auth.uid() presente) recibe 42501 de la funcion: el panel sigue usando la politica de staff ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
select verify_support.expect_sqlstate($q$select * from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9997770000', null, null, null, null, null, 'any', 5)$q$, '42501') as expect_ok;
rollback;

\echo '--- 12. [CONTROL] anon no tiene EXECUTE (42501) ---'
begin;
set local role anon;
select verify_support.expect_sqlstate($q$select * from citas.system_enroll_waitlist('00000000-0000-0000-0000-00000000aa01', '9997770001', null, null, null, null, null, 'any', 5)$q$, '42501') as expect_ok;
rollback;

\echo '--- 13. [CONTROL] anon no tiene EXECUTE (consulta de privilegios) ---'
begin;
set local role authenticated;
select count(*) as anon_ejecuta_deberia_ser_0 from (select 1 where has_function_privilege('anon', 'citas.system_enroll_waitlist(uuid,text,text,uuid,uuid,date,date,text,integer)', 'execute')) t;
rollback;

\echo '--- 14. [CONTROL] la funcion es security definer con search_path fijo ---'
begin;
set local role authenticated;
select count(*) as definer_con_search_path_fijo_deberia_ser_1 from pg_proc where proname = 'system_enroll_waitlist' and prosecdef and exists (select 1 from unnest(proconfig) c where c like 'search_path=%');
rollback;

\echo '--- 15. [CONTROL] el staff del panel sigue inscribiendo con su politica de RLS (sin pasar por la funcion) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0001', true);
with i as (insert into citas.appointment_waitlist (organization_id, customer_phone, preferred_time_window) values ('00000000-0000-0000-0000-00000000aa01', '9998880000', 'any') returning 1)
select count(*) as staff_inscribe_deberia_ser_1 from i;
rollback;
