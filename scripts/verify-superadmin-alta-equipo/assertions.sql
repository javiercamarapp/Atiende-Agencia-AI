-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0053_superadmin_alta_equipo.sql (SA-L-26 version minima, go-live G-07):
--
--   A) Autorizacion: solo un superadmin real con su propio uid; staff normal, uid ajeno (caller-binding), sesion de sistema y anon
--      no pueden crear, reenviar, revocar ni leer; motivo obligatorio.
--   B) Reglas de la invitacion: lista blanca de roles de la vertical, vertical sin lista, sucursales de otra organizacion, correo ya
--      miembro, invitacion pendiente duplicada, segundo owner solo con confirmacion, correo normalizado a minusculas.
--   C) Aceptar con core.accept_staff_invite: crea la membresia con el rol y las sucursales correctos; reenviar invalida el token viejo;
--      revocar impide aceptar; una invitacion de la org A no da acceso a la org B; no se reenvia una ya aceptada.
--   D) Lectura del equipo: correos enmascarados, sin hashes ni tokens, aislamiento entre organizaciones, cero datos para no superadmin.
--   E) Bitacora: cada accion deja su evento con el correo enmascarado (nunca el completo ni el token).
--   F) Aviso de aceptacion (solo sistema): solo para invitaciones creadas por un superadmin; una creada por el owner de la org no cuenta.
--   G) GRANT y estructura: sin EXECUTE para anon, security definer con search_path fijo.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio; un escenario con
-- alias de error esperado debe terminar en ERROR; el alias deberia_ser_N exige que la ultima fila valga N; el resto debe completar sin
-- error. Los rechazos con SQLSTATE exacto se prueban con bloques DO que lanzan si NO ocurre el codigo esperado.
-- Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f3000', 'restaurantes', 'Org A alta equipo', 'org-ae-a', 'active'),
  ('00000000-0000-0000-0000-0000000f3001', 'restaurantes', 'Org B alta equipo', 'org-ae-b', 'active'),
  ('00000000-0000-0000-0000-0000000f3002', 'citas', 'Org C alta equipo', 'org-ae-c', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f3300', '00000000-0000-0000-0000-0000000f3000', 'restaurantes', 'Sucursal A1', 'active'),
  ('00000000-0000-0000-0000-0000000f3301', '00000000-0000-0000-0000-0000000f3000', 'restaurantes', 'Sucursal A2', 'active'),
  ('00000000-0000-0000-0000-0000000f3310', '00000000-0000-0000-0000-0000000f3001', 'restaurantes', 'Sucursal B1', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f3100', 'sa-ae@example.com', 'Superadmin AE Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f3101', 'owner-b@example.com', 'Dueno B Secreto', 'seed'),
  ('00000000-0000-0000-0000-0000000f3102', 'staff-b@example.com', 'Staff B Secreto', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f3100') on conflict do nothing;
-- La organizacion A nace SIN miembros (el caso real de Los Taquitos de PM); la B ya tiene owner y un staff.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f3101', '00000000-0000-0000-0000-0000000f3001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f3102', '00000000-0000-0000-0000-0000000f3001', array['00000000-0000-0000-0000-0000000f3310']::uuid[], 'member', 'staff')
on conflict do nothing;

-- ═══════════════════════════════════════════════════════════════════════════
-- A) Autorizacion
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'A1. superadmin crea una invitacion owner en la org A sin miembros: una fila -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select (select count(*) from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false))::int as deberia_ser_1;
rollback;

\echo 'A2. staff normal (owner de B) no puede invitar en A: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3101', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3101', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'A3. caller-binding falso (uid de otro staff con el id del superadmin): 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3101', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'A4. sesion de sistema (uid nulo) como superadmin: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'A5. anon no tiene EXECUTE: 42501 -- RECHAZADO'
begin;
set local role anon;
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'A6. motivo corto (< 20): 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'corto', false); exception when sqlstate '22023' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 22023'; end if;
end $$;
rollback;

\echo 'A7. reenviar y revocar exigen superadmin: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3101', true);
do $$ declare v_ok boolean := false; begin
  begin perform core.superadmin_resend_staff_invite('00000000-0000-0000-0000-0000000f3101', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), repeat('b', 64), 'Alta del equipo inicial del go-live'); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
do $$ declare v_ok boolean := false; begin
  begin perform core.superadmin_revoke_staff_invite('00000000-0000-0000-0000-0000000f3101', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), 'Alta del equipo inicial del go-live'); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- B) Reglas de la invitacion
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'B1. rol fuera de la lista blanca (manager): 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'manager', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '22023' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 22023'; end if;
end $$;
rollback;

\echo 'B2. vertical sin lista blanca (citas): 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3002', 'nuevo@example.com', 'admin', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '22023' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 22023'; end if;
end $$;
rollback;

\echo 'B3. organizacion inexistente: P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f39ff', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate 'P0002' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE P0002'; end if;
end $$;
rollback;

\echo 'B4. sucursal de OTRA organizacion (B1 en A): 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'staff', array['00000000-0000-0000-0000-0000000f3310']::uuid[], repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '22023' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 22023'; end if;
end $$;
rollback;

\echo 'B5. arreglo de sucursales vacio: 22023 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'staff', array[]::uuid[], repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '22023' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 22023'; end if;
end $$;
rollback;

\echo 'B6. sucursales validas de A: queda con esas sucursales y platform_role member -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'staff', array['00000000-0000-0000-0000-0000000f3300','00000000-0000-0000-0000-0000000f3301']::uuid[], repeat('a', 64), 'Alta del equipo inicial del go-live', false);
reset role;
select (select count(*) from core.staff_invite where organization_id = '00000000-0000-0000-0000-0000000f3000' and platform_role = 'member' and vertical_role = 'staff' and property_ids = array['00000000-0000-0000-0000-0000000f3300','00000000-0000-0000-0000-0000000f3301']::uuid[] and status = 'pending')::int as deberia_ser_1;
rollback;

\echo 'B7. el correo se normaliza a minusculas y el hash es lo unico que se guarda -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'MAYUS@Example.COM', 'owner', null, repeat('c', 64), 'Alta del equipo inicial del go-live', false);
reset role;
select (select count(*) from core.staff_invite where organization_id = '00000000-0000-0000-0000-0000000f3000' and email = 'mayus@example.com' and token_hash = repeat('c', 64))::int as deberia_ser_1;
rollback;

\echo 'B8. correo que ya es miembro de la organizacion: 23505 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', 'staff-b@example.com', 'staff', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '23505' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 23505'; end if;
end $$;
rollback;

\echo 'B9. invitacion pendiente vigente del mismo correo: 23505 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'admin', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'admin', null, repeat('b', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '23505' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 23505'; end if;
end $$;
rollback;

\echo 'B10. B ya tiene owner: segundo owner sin confirmar: 55000 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '55000' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 55000'; end if;
end $$;
rollback;

\echo 'B11. B ya tiene owner: segundo owner CON confirmacion explicita -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select (select count(*) from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', true))::int as deberia_ser_1;
rollback;

\echo 'B12. dos owners pendientes en A sin confirmar: el segundo 55000 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'otro@example.com', 'owner', null, repeat('b', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '55000' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 55000'; end if;
end $$;
rollback;

\echo 'B13. un admin sin owner previo no necesita confirmar y no cuenta como segundo owner -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select (select count(*) from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', 'nuevo@example.com', 'admin', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false))::int as deberia_ser_1;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- C) Aceptar, reenviar, revocar y cross-tenant
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'C1. aceptar con core.accept_staff_invite crea la membresia con el rol y las sucursales de la invitacion -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'staff', array['00000000-0000-0000-0000-0000000f3300']::uuid[], repeat('a', 64), 'Alta del equipo inicial del go-live', false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.accept_staff_invite(repeat('a', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba');
reset role;
select (select count(*) from core.membership m join core.staff_user u on u.id = m.user_id where u.email = 'nuevo@example.com' and m.organization_id = '00000000-0000-0000-0000-0000000f3000' and m.platform_role = 'member' and m.vertical_role = 'staff' and m.property_ids = array['00000000-0000-0000-0000-0000000f3300']::uuid[])::int as deberia_ser_1;
rollback;

\echo 'C2. aceptar un owner sin sucursales: membresia owner con property_ids nulo (todas) -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.accept_staff_invite(repeat('a', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba');
reset role;
select (select count(*) from core.membership m join core.staff_user u on u.id = m.user_id where u.email = 'nuevo@example.com' and m.organization_id = '00000000-0000-0000-0000-0000000f3000' and m.platform_role = 'owner' and m.vertical_role = 'owner' and m.property_ids is null)::int as deberia_ser_1;
rollback;

\echo 'C3. reenviar invalida el token viejo: aceptar con el viejo P0001 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
select * from core.superadmin_resend_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), repeat('b', 64), 'Alta del equipo inicial del go-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare v_ok boolean := false; begin
  begin perform core.accept_staff_invite(repeat('a', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba'); exception when sqlstate 'P0001' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE P0001'; end if;
end $$;
rollback;

\echo 'C4. reenviar: el token NUEVO si acepta -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
select * from core.superadmin_resend_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), repeat('b', 64), 'Alta del equipo inicial del go-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (select count(*) from core.accept_staff_invite(repeat('b', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba'))::int as deberia_ser_1;
rollback;

\echo 'C5. revocar impide aceptar: P0001 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
select core.superadmin_revoke_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), 'Alta del equipo inicial del go-live');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
do $$ declare v_ok boolean := false; begin
  begin perform core.accept_staff_invite(repeat('a', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba'); exception when sqlstate 'P0001' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE P0001'; end if;
end $$;
rollback;

\echo 'C6. revocar con la organizacion equivocada (invitacion de A, org B): P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
do $$ declare v_ok boolean := false; begin
  begin perform core.superadmin_revoke_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', (select id from t_inv), 'Alta del equipo inicial del go-live'); exception when sqlstate 'P0002' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE P0002'; end if;
end $$;
rollback;

\echo 'C7. reenviar con la organizacion equivocada: P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
do $$ declare v_ok boolean := false; begin
  begin perform core.superadmin_resend_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', (select id from t_inv), repeat('b', 64), 'Alta del equipo inicial del go-live'); exception when sqlstate 'P0002' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE P0002'; end if;
end $$;
rollback;

\echo 'C8. una invitacion ya aceptada no se reenvia ni se revoca: P0002 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.accept_staff_invite(repeat('a', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform core.superadmin_resend_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), repeat('b', 64), 'Alta del equipo inicial del go-live'); exception when sqlstate 'P0002' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE P0002'; end if;
end $$;
do $$ declare v_ok boolean := false; begin
  begin perform core.superadmin_revoke_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), 'Alta del equipo inicial del go-live'); exception when sqlstate 'P0002' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE P0002'; end if;
end $$;
rollback;

\echo 'C9. cross-tenant: aceptar la invitacion de A no crea membresia en B -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.accept_staff_invite(repeat('a', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba');
reset role;
select (select count(*) from core.membership m join core.staff_user u on u.id = m.user_id where u.email = 'nuevo@example.com' and m.organization_id = '00000000-0000-0000-0000-0000000f3001')::int as deberia_ser_0;
rollback;

\echo 'C10. un owner de B no puede escribir invitaciones de A con las funciones de superadmin (policy 0002 intacta): insert directo RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3101', true);
insert into core.staff_invite (email, organization_id, platform_role, vertical_role, token_hash, invited_by, expires_at) values ('x@example.com', '00000000-0000-0000-0000-0000000f3000', 'owner', 'owner', repeat('d', 64), '00000000-0000-0000-0000-0000000f3101', now() + interval '1 day') returning id as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- D) Lectura del equipo
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'D1. superadmin lee B: 2 miembros y su invitacion pendiente, correos enmascarados -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', 'pend@example.com', 'admin', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
select (select jsonb_array_length(core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001') -> 'miembros') = 2 and jsonb_array_length(core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001') -> 'invitaciones') = 1 and (core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001') -> 'invitaciones' -> 0 ->> 'correo') = 'p***@example.com')::int as deberia_ser_1;
rollback;

\echo 'D2. la lectura no contiene hashes, tokens ni correos completos -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001', 'pend@example.com', 'admin', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
select (select position('token' in core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001')::text) + position('pend@example.com' in core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001')::text) + position('owner-b@example.com' in core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001')::text) + position(repeat('a', 64) in core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001')::text))::int as deberia_ser_0;
rollback;

\echo 'D3. aislamiento: A (sin miembros) no muestra los miembros de B -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select (select jsonb_array_length(core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000') -> 'miembros') + jsonb_array_length(core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000') -> 'invitaciones'))::int as deberia_ser_0;
rollback;

\echo 'D4. staff normal (uid propio, id de superadmin ajeno): NULL, sin datos -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3101', true);
select (core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001') is null)::int as deberia_ser_1;
rollback;

\echo 'D5. sesion de sistema: NULL -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001') is null)::int as deberia_ser_1;
rollback;

\echo 'D6. organizacion inexistente: NULL -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select (core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f39ff') is null)::int as deberia_ser_1;
rollback;

\echo 'D7. anon no ejecuta la lectura -- RECHAZADO'
begin;
set local role anon;
select core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3001') as should_fail;
rollback;

\echo 'D8. una invitacion revocada o aceptada ya no aparece como pendiente -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
select core.superadmin_revoke_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), 'Alta del equipo inicial del go-live');
select (jsonb_array_length(core.list_org_team_for_superadmin('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000') -> 'invitaciones'))::int as deberia_ser_0;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- E) Bitacora
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'E1. crear, reenviar y revocar dejan 3 eventos con correo enmascarado y sin correo completo ni token -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
create temp table t_inv on commit drop as select id from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'bitacora@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
grant select on t_inv to authenticated;
select * from core.superadmin_resend_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), repeat('b', 64), 'Alta del equipo inicial del go-live');
select core.superadmin_revoke_staff_invite('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', (select id from t_inv), 'Alta del equipo inicial del go-live');
reset role;
select (select count(*) from core.superadmin_security_event where organization_id = '00000000-0000-0000-0000-0000000f3000' and event in ('org_invite_created','org_invite_resent','org_invite_revoked') and detail ->> 'email' = 'b***@example.com' and position('bitacora@example.com' in detail::text) = 0 and position(repeat('a', 64) in detail::text) = 0 and position(repeat('b', 64) in detail::text) = 0 and actor_user_id = '00000000-0000-0000-0000-0000000f3100')::int as deberia_ser_3;
rollback;

\echo 'E2. una invitacion rechazada no deja evento -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ begin begin perform * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'manager', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false); exception when sqlstate '22023' then null; end; end $$;
reset role;
select (select count(*) from core.superadmin_security_event where organization_id = '00000000-0000-0000-0000-0000000f3000' and event = 'org_invite_created')::int as deberia_ser_0;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- F) Aviso de aceptacion (solo sistema)
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'F1. invitacion creada por superadmin y aceptada: el sistema recibe su id y organizacion -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.accept_staff_invite(repeat('a', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba');
select (select count(*) from core.superadmin_invite_acceptance_for_system(repeat('a', 64)) where organization_id = '00000000-0000-0000-0000-0000000f3000')::int as deberia_ser_1;
rollback;

\echo 'F2. invitacion aun pendiente: sin aviso -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
select * from core.superadmin_invite_staff('00000000-0000-0000-0000-0000000f3100', '00000000-0000-0000-0000-0000000f3000', 'nuevo@example.com', 'owner', null, repeat('a', 64), 'Alta del equipo inicial del go-live', false);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (select count(*) from core.superadmin_invite_acceptance_for_system(repeat('a', 64)))::int as deberia_ser_0;
rollback;

\echo 'F3. invitacion creada por el owner de la organizacion (no por superadmin) y aceptada: sin aviso -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3101', true);
insert into core.staff_invite (email, organization_id, platform_role, vertical_role, token_hash, invited_by, expires_at) values ('porowner@example.com', '00000000-0000-0000-0000-0000000f3001', 'member', 'staff', repeat('e', 64), '00000000-0000-0000-0000-0000000f3101', now() + interval '1 day');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select * from core.accept_staff_invite(repeat('e', 64), 'Nombre Nuevo', 'hash-de-password-de-prueba');
select (select count(*) from core.superadmin_invite_acceptance_for_system(repeat('e', 64)))::int as deberia_ser_0;
rollback;

\echo 'F4. un usuario con sesion (uid) no puede llamarla: 42501 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f3100', true);
do $$ declare v_ok boolean := false; begin
  begin perform * from core.superadmin_invite_acceptance_for_system(repeat('a', 64)); exception when sqlstate '42501' then v_ok := true; end;
  if not v_ok then raise exception 'esperaba SQLSTATE 42501'; end if;
end $$;
rollback;

\echo 'F5. anon no puede llamarla -- RECHAZADO'
begin;
set local role anon;
select * from core.superadmin_invite_acceptance_for_system(repeat('a', 64)) as should_fail;
rollback;

-- ═══════════════════════════════════════════════════════════════════════════
-- G) GRANT y estructura
-- ═══════════════════════════════════════════════════════════════════════════
\echo 'G1. ninguna funcion nueva es ejecutable por anon -- OK'
begin;
select (select count(*) from unnest(array['core.superadmin_invite_staff(uuid, uuid, text, text, uuid[], text, text, boolean)'::regprocedure,
  'core.superadmin_resend_staff_invite(uuid, uuid, uuid, text, text)'::regprocedure,
  'core.superadmin_revoke_staff_invite(uuid, uuid, uuid, text)'::regprocedure,
  'core.list_org_team_for_superadmin(uuid, uuid)'::regprocedure,
  'core.superadmin_invite_acceptance_for_system(text)'::regprocedure, 'core.mask_email(text)'::regprocedure]) f where has_function_privilege('anon', f, 'execute'))::int as deberia_ser_0;
rollback;

\echo 'G2. las cinco funciones de gestion las ejecuta authenticated -- OK'
begin;
select (select count(*) from unnest(array['core.superadmin_invite_staff(uuid, uuid, text, text, uuid[], text, text, boolean)'::regprocedure,
  'core.superadmin_resend_staff_invite(uuid, uuid, uuid, text, text)'::regprocedure,
  'core.superadmin_revoke_staff_invite(uuid, uuid, uuid, text)'::regprocedure,
  'core.list_org_team_for_superadmin(uuid, uuid)'::regprocedure,
  'core.superadmin_invite_acceptance_for_system(text)'::regprocedure]) f where has_function_privilege('authenticated', f, 'execute'))::int as deberia_ser_5;
rollback;

\echo 'G3. las cinco son security definer con search_path fijo -- OK'
begin;
select (select count(*) from unnest(array['core.superadmin_invite_staff(uuid, uuid, text, text, uuid[], text, text, boolean)'::regprocedure,
  'core.superadmin_resend_staff_invite(uuid, uuid, uuid, text, text)'::regprocedure,
  'core.superadmin_revoke_staff_invite(uuid, uuid, uuid, text)'::regprocedure,
  'core.list_org_team_for_superadmin(uuid, uuid)'::regprocedure,
  'core.superadmin_invite_acceptance_for_system(text)'::regprocedure]) f join pg_proc p on p.oid = f where p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%core%'))::int as deberia_ser_5;
rollback;

\echo 'G4. el guard core.superadmin_require_caller sigue sin EXECUTE para authenticated -- OK'
begin;
select has_function_privilege('authenticated', 'core.superadmin_require_caller(uuid, text)'::regprocedure, 'execute')::int as deberia_ser_0;
rollback;

\echo ''
\echo 'Fin: todos los escenarios deben terminar sin ERROR, salvo los marcados RECHAZADO con alias de error esperado (terminan en ERROR).'
