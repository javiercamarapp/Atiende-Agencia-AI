-- Fixtures + escenarios que verifican, contra Postgres REAL (RLS + GRANT reales —
-- NUNCA el repositorio en memoria, que no aplica ninguno de los dos), la
-- autorización real de:
--   - despachos.property_config (migración 012): positivo (admin edita su
--     property), negativo (contador de la MISMA organización, con acceso a la
--     MISMA property, es RECHAZADO -- la policy filtra vertical_role='admin' en
--     SQL, no solo en la capa TS), cross-tenant (staff de otra organización no ve
--     ni edita), scope de property (admin con `property_ids` acotado a OTRA
--     property de su propia organización es RECHAZADO -- has_property_access
--     manda, no solo membership+rol), anon (cero acceso).
--   - restaurantes.branch_detail.zona_horaria (migración 022): positivo
--     (cualquier staff de la organización edita, mismo criterio ya establecido
--     por esta tabla para phone/address -- ver el comentario de cabecera de la
--     migración 022 para por qué NO se angosta aquí), cross-tenant (staff de otra
--     organización es RECHAZADO), SELECT público real (anon SÍ puede leer
--     zona_horaria -- mismo criterio que phone/address, información no sensible
--     de un negocio, consistente con el resto de la tabla desde antes de esta
--     fase), anon NUNCA puede escribir.
--
-- Cada escenario corre en su propio `begin; ... rollback;` -- nada de esto
-- persiste. `\set ON_ERROR_STOP off` dentro del bloque de escenarios: un
-- escenario "RECHAZADO" debe terminar en ERROR real de Postgres (visible arriba),
-- nunca abortar todo el script.
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures
-- ---------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000d001', 'despachos', 'Despacho D1', 'despacho-d1'),
  ('00000000-0000-0000-0000-00000000d002', 'despachos', 'Despacho D2 (otra org)', 'despacho-d2'),
  ('00000000-0000-0000-0000-00000000e001', 'restaurantes', 'Restaurante E1', 'restaurante-e1'),
  ('00000000-0000-0000-0000-00000000e002', 'restaurantes', 'Restaurante E2 (otra org)', 'restaurante-e2')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'Cliente A (despachos D1)'),
  ('00000000-0000-0000-0000-00000000d0a2', '00000000-0000-0000-0000-00000000d001', 'Cliente B (despachos D1, OTRA property)'),
  ('00000000-0000-0000-0000-00000000d0b1', '00000000-0000-0000-0000-00000000d002', 'Cliente de D2')
on conflict do nothing;

-- restaurantes.branch_detail exige slug/organization_id propios (migración 001) --
-- no basta con core.property, hay que sembrar el detalle de sucursal también.
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-00000000e0a1', '00000000-0000-0000-0000-00000000e001', 'Sucursal Centro (E1)'),
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-00000000e002', 'Sucursal de E2')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-00000000e0a1', '00000000-0000-0000-0000-00000000e001', 'centro'),
  ('00000000-0000-0000-0000-00000000e0b1', '00000000-0000-0000-0000-00000000e002', 'unica')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000000f1', 'admin-d1@example.com', 'Admin D1', 'seed'),
  ('00000000-0000-0000-0000-0000000000f2', 'contador-d1@example.com', 'Contador D1', 'seed'),
  ('00000000-0000-0000-0000-0000000000f3', 'staff-d2@example.com', 'Staff D2 (otra org)', 'seed'),
  ('00000000-0000-0000-0000-0000000000f4', 'admin-d1-scoped@example.com', 'Admin D1 acotado a otra property', 'seed'),
  ('00000000-0000-0000-0000-0000000000f5', 'owner-e1@example.com', 'Owner E1', 'seed'),
  ('00000000-0000-0000-0000-0000000000f6', 'staff-e2@example.com', 'Staff E2 (otra org)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  -- f1: admin real de D1, acceso a TODAS las properties de D1 (property_ids null).
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-00000000d001', null, 'owner', 'admin'),
  -- f2: MISMA organización D1, MISMA property real, pero rol 'contador' -- el
  -- caso que prueba que la policy filtra por rol, no solo por organización.
  ('00000000-0000-0000-0000-0000000000f2', '00000000-0000-0000-0000-00000000d001', null, 'admin', 'contador'),
  -- f3: staff real de la OTRA organización (D2) -- cross-tenant.
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-00000000d002', null, 'owner', 'admin'),
  -- f4: rol 'admin' de D1 (el rol correcto), pero `property_ids` acotado SOLO a
  -- d0a2 -- nunca a d0a1, la property objetivo de los escenarios de abajo.
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-00000000d001', array['00000000-0000-0000-0000-00000000d0a2']::uuid[], 'admin', 'admin'),
  -- f5: staff real de E1 (restaurantes) -- rol 'staff' a propósito (nunca
  -- 'owner'/'admin'): branch_detail NO filtra por vertical_role (ver comentario
  -- de cabecera de la migración 022), así que esto SÍ debe poder editar.
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-00000000e001', null, 'member', 'staff'),
  -- f6: staff real de la OTRA organización (E2) -- cross-tenant.
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-00000000e002', null, 'member', 'staff')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- despachos.property_config (migración 012)
-- ---------------------------------------------------------------------------

\echo '=== 1. POSITIVO: admin real de D1 inserta la config de SU property (d0a1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'America/Cancun')
  returning property_id, zona_horaria;
rollback;

\echo '=== 2. POSITIVO: el mismo admin ACTUALIZA la config ya existente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'America/Mexico_City');
update despachos.property_config set zona_horaria = 'America/Tijuana' where property_id = '00000000-0000-0000-0000-00000000d0a1'
  returning zona_horaria;
rollback;

\echo '=== 3. RECHAZADO (debe fallar): contador de la MISMA organización/property -- la policy filtra vertical_role=admin en SQL, no solo la capa TS ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...); este
-- comentario es lo que el runner automático detecta -- mismo patrón que
-- scripts/verify-flujos-sistema/assertions.sql escenario 8).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f2', true);
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'America/Hermosillo');
rollback;

\echo '=== 4. RECHAZADO (debe fallar): staff real de OTRA organización (cross-tenant) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'America/Mazatlan');
rollback;

\echo '=== 5. CROSS-TENANT: staff de OTRA organización nunca VE la config de D1 (SELECT, 0 filas -- nunca un error, nunca fuga) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f1', true);
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'America/Cancun');
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f3', true);
select count(*) as filas_visibles_deberia_ser_0 from despachos.property_config where property_id = '00000000-0000-0000-0000-00000000d0a1';
rollback;

\echo '=== 6. RECHAZADO (debe fallar): rol admin CORRECTO, pero membership.property_ids acotado a OTRA property de la MISMA organización -- has_property_access manda, no solo membership+rol ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f4', true);
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'America/Chihuahua');
rollback;

\echo '=== 7. POSITIVO (control): el MISMO admin acotado (f4) SÍ puede sobre SU property real asignada (d0a2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f4', true);
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a2', '00000000-0000-0000-0000-00000000d001', 'America/Chihuahua')
  returning property_id, zona_horaria;
rollback;

\echo '=== 8a. RECHAZADO (debe fallar): anon no tiene NINGÚN acceso de LECTURA ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from despachos.property_config as should_fail;
rollback;

\echo '=== 8b. RECHAZADO (debe fallar): anon no tiene NINGÚN acceso de ESCRITURA ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role anon;
insert into despachos.property_config (property_id, organization_id, zona_horaria)
  values ('00000000-0000-0000-0000-00000000d0a1', '00000000-0000-0000-0000-00000000d001', 'America/Cancun');
rollback;

-- ---------------------------------------------------------------------------
-- restaurantes.branch_detail.zona_horaria (migración 022)
-- ---------------------------------------------------------------------------

\echo '=== 9. POSITIVO: staff real de E1 (rol "staff", NUNCA owner/admin) actualiza la zona horaria de SU sucursal -- branch_detail no filtra por vertical_role (mismo criterio que phone/address desde antes de esta fase, ver comentario de cabecera de la migración 022) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f5', true);
update restaurantes.branch_detail set zona_horaria = 'America/Cancun' where property_id = '00000000-0000-0000-0000-00000000e0a1'
  returning property_id, zona_horaria;
rollback;

\echo '=== 10. RECHAZADO EN SILENCIO por RLS (0 filas actualizadas, nunca una excepción -- así es como Postgres real filtra un UPDATE cuyo USING no matchea ninguna fila): staff real de OTRA organización (E2) nunca edita la sucursal de E1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f6', true);
with actualizado as (
  update restaurantes.branch_detail set zona_horaria = 'America/Tijuana' where property_id = '00000000-0000-0000-0000-00000000e0a1' returning property_id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== 11. anon SÍ puede LEER zona_horaria (información no sensible, mismo criterio que phone/address -- migración 014, policy pública ya existente) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000000f5', true);
update restaurantes.branch_detail set zona_horaria = 'America/Cancun' where property_id = '00000000-0000-0000-0000-00000000e0a1';
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select property_id, zona_horaria from restaurantes.branch_detail where property_id = '00000000-0000-0000-0000-00000000e0a1';
rollback;

\echo '=== 12. RECHAZADO (debe fallar): anon NUNCA puede ESCRIBIR zona_horaria (permission denied real -- a diferencia del escenario 10, aquí ni siquiera hay GRANT de UPDATE para el rol) ==='
begin;
-- as should_fail (UPDATE sin RETURNING no admite `as alias` al final).
set local role anon;
update restaurantes.branch_detail set zona_horaria = 'America/Cancun' where property_id = '00000000-0000-0000-0000-00000000e0a1';
rollback;
