-- Fixtures + assertions contra Postgres REAL (RLS/GRANT/auth.uid() reales -- el repositorio en
-- memoria nunca los aplica) de packages/domain-rentas/migrations/030_rentas_pricing_borrado_politicas.sql
-- (Rn-23: editar y borrar la configuracion de precios de una unidad).
--
-- Que demuestra (positivo, negativo, cross-tenant, anon):
--   A. admin_gestora: edita (UPDATE, politica de 004) y borra temporada, descuento por duracion,
--      min-stay y regla de canal de su property.
--   B. tarifa_base NO se borra (historial versionado por vigente_desde): DELETE sin permiso, y si
--      se edita solo cambia su fila.
--   C. un rol sin escritura (operador, contador) borra 0 filas y no edita ninguna.
--   D. cross-tenant: el admin de otra organizacion borra/edita 0 filas.
--   E. admin acotado a OTRA property de la misma organizacion borra 0 filas.
--   F. anon y sesion de sistema (auth.uid() null) no pueden borrar (sin GRANT / sin politica).
--
-- Run via scripts/verify-real-postgres-ci/run-gate.mjs (auto-descubierto en CI) o con ./run.sh. Cada
-- escenario corre en su propio `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000a1', 'rentas', 'Org A (pricing)', 'org-a-pricing'),
  ('00000000-0000-0000-0000-0000000000a2', 'rentas', 'Org B (pricing, ajena)', 'org-b-pricing')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Casa Playa'),
  ('00000000-0000-0000-0000-0000000000b3', '00000000-0000-0000-0000-0000000000a1', 'rentas', 'Casa Centro'),
  ('00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000a2', 'rentas', 'Casa Ajena')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000011', 'admin-a-pricing@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000012', 'operador-a-pricing@example.com', 'Operador A', 'seed'),
  ('00000000-0000-0000-0000-000000000013', 'admin-b-pricing@example.com', 'Admin B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000014', 'admin-acotado-pricing@example.com', 'Admin acotado a Casa Centro', 'seed'),
  ('00000000-0000-0000-0000-000000000015', 'contador-a-pricing@example.com', 'Contador A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000011', '00000000-0000-0000-0000-0000000000a1', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000012', '00000000-0000-0000-0000-0000000000a1', null, 'member', 'operador:solo_calendario'),
  ('00000000-0000-0000-0000-000000000013', '00000000-0000-0000-0000-0000000000a2', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000014', '00000000-0000-0000-0000-0000000000a1', array['00000000-0000-0000-0000-0000000000b3']::uuid[], 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000015', '00000000-0000-0000-0000-0000000000a1', null, 'viewer', 'contador')
on conflict do nothing;
insert into rentas.unidad (id, organization_id, property_id, name, duracion_minima_noches) values
  ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', 'Suite 1', 1),
  ('00000000-0000-0000-0000-0000000000c2', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', 'Suite Ajena', 1)
on conflict do nothing;

insert into rentas.tarifa_base (id, organization_id, property_id, unidad_id, precio_noche_centavos, moneda, vigente_desde) values
  ('00000000-0000-0000-0000-0000000000e0', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 150000, 'MXN', '2027-01-01')
on conflict do nothing;
insert into rentas.tarifa_temporada (id, organization_id, property_id, unidad_id, nombre, fecha_inicio, fecha_fin, precio_noche_centavos, moneda) values
  ('00000000-0000-0000-0000-0000000000e1', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 'Verano', '2027-07-01', '2027-08-31', 220000, 'MXN'),
  ('00000000-0000-0000-0000-0000000000e9', '00000000-0000-0000-0000-0000000000a2', '00000000-0000-0000-0000-0000000000b2', '00000000-0000-0000-0000-0000000000c2', 'Verano ajeno', '2027-07-01', '2027-08-31', 90000, 'MXN')
on conflict do nothing;
insert into rentas.tarifa_descuento_duracion (id, organization_id, property_id, unidad_id, noches_minimas, porcentaje_descuento_basis_points, fuente) values
  ('00000000-0000-0000-0000-0000000000e2', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', 7, 1000, 'politica semanal')
on conflict do nothing;
insert into rentas.tarifa_min_stay (id, organization_id, property_id, unidad_id, fecha_inicio, fecha_fin, dia_semana_checkin, noches_minimas) values
  ('00000000-0000-0000-0000-0000000000e3', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', '2027-12-20', '2028-01-05', null, 5)
on conflict do nothing;
insert into rentas.tarifa_regla_canal (id, organization_id, property_id, unidad_id, canal_id, markup_basis_points, activo)
select '00000000-0000-0000-0000-0000000000e4', '00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-0000000000c1', c.id, 1500, true
from rentas.canal c where c.codigo = 'booking'
on conflict do nothing;

\echo ''
\echo '=== A. admin_gestora edita y borra su configuracion ==='
\echo ''
\echo '--- 1. borra la temporada de su unidad ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e1';
select count(*) as temporada_restante_deberia_ser_0 from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e1';
rollback;

\echo '--- 2. borra el descuento por duracion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.tarifa_descuento_duracion where id = '00000000-0000-0000-0000-0000000000e2';
select count(*) as descuento_restante_deberia_ser_0 from rentas.tarifa_descuento_duracion where id = '00000000-0000-0000-0000-0000000000e2';
rollback;

\echo '--- 3. borra la regla min-stay ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.tarifa_min_stay where id = '00000000-0000-0000-0000-0000000000e3';
select count(*) as minstay_restante_deberia_ser_0 from rentas.tarifa_min_stay where id = '00000000-0000-0000-0000-0000000000e3';
rollback;

\echo '--- 4. borra la regla de canal (DELETE ya existia desde 004) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
delete from rentas.tarifa_regla_canal where id = '00000000-0000-0000-0000-0000000000e4';
select count(*) as regla_restante_deberia_ser_0 from rentas.tarifa_regla_canal where id = '00000000-0000-0000-0000-0000000000e4';
rollback;

\echo '--- 5. edita el precio de la temporada ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.tarifa_temporada set precio_noche_centavos = 250000 where id = '00000000-0000-0000-0000-0000000000e1';
select count(*) as editada_deberia_ser_1 from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e1' and precio_noche_centavos = 250000;
rollback;

\echo '--- 6. edita descuento y min-stay y regla de canal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
update rentas.tarifa_descuento_duracion set porcentaje_descuento_basis_points = 1500 where id = '00000000-0000-0000-0000-0000000000e2';
update rentas.tarifa_min_stay set noches_minimas = 7 where id = '00000000-0000-0000-0000-0000000000e3';
update rentas.tarifa_regla_canal set markup_basis_points = 1800 where id = '00000000-0000-0000-0000-0000000000e4';
select (select count(*) from rentas.tarifa_descuento_duracion where id = '00000000-0000-0000-0000-0000000000e2' and porcentaje_descuento_basis_points = 1500)
     + (select count(*) from rentas.tarifa_min_stay where id = '00000000-0000-0000-0000-0000000000e3' and noches_minimas = 7)
     + (select count(*) from rentas.tarifa_regla_canal where id = '00000000-0000-0000-0000-0000000000e4' and markup_basis_points = 1800) as editadas_deberia_ser_3;
rollback;

\echo ''
\echo '=== B. la tarifa base conserva su historial: sin DELETE ==='
\echo ''
\echo '--- 7. el admin_gestora intenta borrar la tarifa base -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000011', true);
with d as (delete from rentas.tarifa_base where id = '00000000-0000-0000-0000-0000000000e0' returning 1) select count(*) as should_fail from d;
rollback;

\echo ''
\echo '=== C. roles sin escritura ==='
\echo ''
\echo '--- 8. el operador no borra la temporada (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
with d as (delete from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e1' returning 1) select count(*) as borradas_deberia_ser_0 from d;
rollback;

\echo '--- 9. el contador no borra el descuento (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000015', true);
with d as (delete from rentas.tarifa_descuento_duracion where id = '00000000-0000-0000-0000-0000000000e2' returning 1) select count(*) as borradas_deberia_ser_0 from d;
rollback;

\echo '--- 10. el operador no borra el min-stay (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
with d as (delete from rentas.tarifa_min_stay where id = '00000000-0000-0000-0000-0000000000e3' returning 1) select count(*) as borradas_deberia_ser_0 from d;
rollback;

\echo '--- 11. el operador no edita la temporada (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000012', true);
with u as (update rentas.tarifa_temporada set precio_noche_centavos = 1 where id = '00000000-0000-0000-0000-0000000000e1' returning 1) select count(*) as editadas_deberia_ser_0 from u;
rollback;

\echo ''
\echo '=== D. cross-tenant ==='
\echo ''
\echo '--- 12. el admin de la Org B no borra la temporada de la Org A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with d as (delete from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e1' returning 1) select count(*) as borradas_deberia_ser_0 from d;
rollback;

\echo '--- 13. el admin de la Org B no borra el min-stay de la Org A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with d as (delete from rentas.tarifa_min_stay where id = '00000000-0000-0000-0000-0000000000e3' returning 1) select count(*) as borradas_deberia_ser_0 from d;
rollback;

\echo '--- 14. el admin de la Org B no edita el descuento de la Org A (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with u as (update rentas.tarifa_descuento_duracion set porcentaje_descuento_basis_points = 1 where id = '00000000-0000-0000-0000-0000000000e2' returning 1) select count(*) as editadas_deberia_ser_0 from u;
rollback;

\echo '--- 15. el admin de la Org B SI borra su propia temporada (positivo del otro tenant) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000013', true);
with d as (delete from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e9' returning 1) select count(*) as borradas_deberia_ser_1 from d;
rollback;

\echo ''
\echo '=== E. admin acotado a otra property de la misma organizacion ==='
\echo ''
\echo '--- 16. el admin acotado a Casa Centro no borra la temporada de Casa Playa (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000014', true);
with d as (delete from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e1' returning 1) select count(*) as borradas_deberia_ser_0 from d;
rollback;

\echo ''
\echo '=== F. anon y sesion de sistema ==='
\echo ''
\echo '--- 17. anon intenta borrar una temporada -- RECHAZADO (sin GRANT) ---'
begin;
set local role anon;
with d as (delete from rentas.tarifa_temporada where id = '00000000-0000-0000-0000-0000000000e1' returning 1) select count(*) as should_fail from d;
rollback;

\echo '--- 18. sesion de sistema (auth.uid() null) no borra el descuento (0 filas) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with d as (delete from rentas.tarifa_descuento_duracion where id = '00000000-0000-0000-0000-0000000000e2' returning 1) select count(*) as borradas_deberia_ser_0 from d;
rollback;

\echo ''
\echo 'listo -- los escenarios 7/17 deben terminar en ERROR; el resto son chequeos de valor (deberia_ser_N).'
