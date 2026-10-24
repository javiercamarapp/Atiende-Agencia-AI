-- Fixtures + assertions contra Postgres REAL para
-- packages/domain-restaurantes/migrations/096_resumen_horas_ahorradas_y_metas.sql
-- (configuracion del Resumen por organizacion: minutos por conversacion para «Horas de atencion ahorradas» y metas de adopcion de IA).
--
--   A. Lectura: cualquier miembro de la organizacion y la sesion de SISTEMA (auth.uid() NULL) ven la fila; otra organizacion (cross-tenant) no; anon no tiene ni SELECT.
--   B. Escritura: solo owner/admin de SU organizacion (upsert y update); staff, repartidor, otra organizacion y anon rechazados; `updated_by` debe ser quien
--      escribe (sin suplantacion); GRANT por columna (organization_id no cambia; sin DELETE).
--   C. CHECK por columna: minutos 1..120, metas 1..100; null = sin configurar.
--   D. Base SIN migrar: la tabla eliminada dentro de la transaccion da 42P01 y un SAVEPOINT real la recupera.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; `as should_fail` marca el que debe terminar en ERROR;
-- `..._deberia_ser_N` el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0a01', 'restaurantes', 'Resumen Org A', 'resumen-org-a'),
  ('00000000-0000-0000-0000-0000000e0a02', 'restaurantes', 'Resumen Org B', 'resumen-org-b'),
  ('00000000-0000-0000-0000-0000000e0a03', 'restaurantes', 'Resumen Org C (sin config)', 'resumen-org-c')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0c01', 'resumen-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0c02', 'resumen-admin-a@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0c03', 'resumen-staff-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0c04', 'resumen-repartidor-a@example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e0c05', 'resumen-owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0c01', '00000000-0000-0000-0000-0000000e0a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e0c02', '00000000-0000-0000-0000-0000000e0a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e0c03', '00000000-0000-0000-0000-0000000e0a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e0c04', '00000000-0000-0000-0000-0000000e0a01', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e0c05', '00000000-0000-0000-0000-0000000e0a02', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.resumen_settings (organization_id, minutos_por_conversacion, meta_pedidos_ia_pct, meta_ingresos_ia_pct, updated_by)
values ('00000000-0000-0000-0000-0000000e0a01', 5, 50, 40, '00000000-0000-0000-0000-0000000e0c01')
on conflict do nothing;

\echo ''
\echo '=== A) Lectura ==='

\echo '--- 1. owner de la Org A lee su configuracion ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c01', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.resumen_settings where organization_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '--- 2. staff de la Org A (miembro) tambien la lee, para calcular el Resumen ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c03', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.resumen_settings where organization_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '--- 3. sesion de SISTEMA (auth.uid() NULL) la lee ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as filas_visibles_deberia_ser_1 from restaurantes.resumen_settings where organization_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '--- 4. owner de la Org B NO ve la de la Org A (cross-tenant, RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c05', true);
select count(*) as filas_visibles_deberia_ser_0 from restaurantes.resumen_settings where organization_id = '00000000-0000-0000-0000-0000000e0a01';
rollback;

\echo '--- 5. anon no tiene ni SELECT: RECHAZADO ---'
begin;
set local role anon;
select count(*) as should_fail from restaurantes.resumen_settings;
rollback;

\echo ''
\echo '=== B) Escritura ==='

\echo '--- 6. owner de la Org A actualiza SU configuracion (1 fila) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c01', true);
with u as (update restaurantes.resumen_settings set minutos_por_conversacion = 7, updated_by = '00000000-0000-0000-0000-0000000e0c01', updated_at = now() where organization_id = '00000000-0000-0000-0000-0000000e0a01' returning minutos_por_conversacion) select count(*) as filas_con_minutos_7_deberia_ser_1 from u where minutos_por_conversacion = 7;
rollback;

\echo '--- 7. admin de la Org A actualiza (1 fila) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c02', true);
with u as (update restaurantes.resumen_settings set minutos_por_conversacion = 8, updated_by = '00000000-0000-0000-0000-0000000e0c02', updated_at = now() where organization_id = '00000000-0000-0000-0000-0000000e0a01' returning minutos_por_conversacion) select count(*) as filas_con_minutos_8_deberia_ser_1 from u where minutos_por_conversacion = 8;
rollback;

\echo '--- 8. staff de la Org A NO actualiza: 0 filas (RLS silencioso) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c03', true);
with u as (update restaurantes.resumen_settings set minutos_por_conversacion = 9, updated_by = '00000000-0000-0000-0000-0000000e0c03', updated_at = now() where organization_id = '00000000-0000-0000-0000-0000000e0a01' returning minutos_por_conversacion) select count(*) as filas_actualizadas_deberia_ser_0 from u;
rollback;

\echo '--- 9. repartidor de la Org A NO actualiza: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c04', true);
with u as (update restaurantes.resumen_settings set minutos_por_conversacion = 9, updated_by = '00000000-0000-0000-0000-0000000e0c04', updated_at = now() where organization_id = '00000000-0000-0000-0000-0000000e0a01' returning minutos_por_conversacion) select count(*) as filas_actualizadas_deberia_ser_0 from u;
rollback;

\echo '--- 10. owner de la Org B NO actualiza la de la Org A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c05', true);
with u as (update restaurantes.resumen_settings set minutos_por_conversacion = 9, updated_by = '00000000-0000-0000-0000-0000000e0c05', updated_at = now() where organization_id = '00000000-0000-0000-0000-0000000e0a01' returning minutos_por_conversacion) select count(*) as filas_actualizadas_deberia_ser_0 from u;
rollback;

\echo '--- 11. suplantacion: owner A guarda con updated_by de otro: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c01', true);
update restaurantes.resumen_settings set minutos_por_conversacion = 6, updated_by = '00000000-0000-0000-0000-0000000e0c02' where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 12. owner de la Org A crea la de la Org C (otra organizacion): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c01', true);
insert into restaurantes.resumen_settings (organization_id, minutos_por_conversacion, updated_by) values ('00000000-0000-0000-0000-0000000e0a03', 4, '00000000-0000-0000-0000-0000000e0c01') ;
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 13. staff de la Org A no puede crear: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c03', true);
insert into restaurantes.resumen_settings (organization_id, minutos_por_conversacion, updated_by) values ('00000000-0000-0000-0000-0000000e0a01', 4, '00000000-0000-0000-0000-0000000e0c03') on conflict (organization_id) do update set minutos_por_conversacion = 4, updated_by = excluded.updated_by;
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 14. organization_id no cambia (GRANT por columna): RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c01', true);
update restaurantes.resumen_settings set organization_id = '00000000-0000-0000-0000-0000000e0a02' where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 15. sin DELETE para authenticated: RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0c01', true);
delete from restaurantes.resumen_settings where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo ''
\echo '=== C) CHECK por columna ==='

\echo '--- 16. minutos 0: RECHAZADO por CHECK ---'
begin;
update restaurantes.resumen_settings set minutos_por_conversacion = 0 where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 17. minutos 121: RECHAZADO por CHECK ---'
begin;
update restaurantes.resumen_settings set minutos_por_conversacion = 121 where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 18. meta de pedidos 0: RECHAZADO por CHECK ---'
begin;
update restaurantes.resumen_settings set meta_pedidos_ia_pct = 0 where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 19. meta de pedidos 101: RECHAZADO por CHECK ---'
begin;
update restaurantes.resumen_settings set meta_pedidos_ia_pct = 101 where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 20. meta de ingresos 101: RECHAZADO por CHECK ---'
begin;
update restaurantes.resumen_settings set meta_ingresos_ia_pct = 101 where organization_id = '00000000-0000-0000-0000-0000000e0a01';
select 1 as should_fail from (select 1/0) x;
rollback;

\echo '--- 21. null = sin configurar es valido ---'
begin;
with u as (update restaurantes.resumen_settings set minutos_por_conversacion = null, meta_pedidos_ia_pct = null where organization_id = '00000000-0000-0000-0000-0000000e0a01' returning minutos_por_conversacion, meta_pedidos_ia_pct) select count(*) as filas_con_null_deberia_ser_1 from u where minutos_por_conversacion is null and meta_pedidos_ia_pct is null;
rollback;

\echo '--- 22. limites 1 y 120 / 1 y 100 validos ---'
begin;
with u as (update restaurantes.resumen_settings set minutos_por_conversacion = 120, meta_pedidos_ia_pct = 1, meta_ingresos_ia_pct = 100 where organization_id = '00000000-0000-0000-0000-0000000e0a01' returning minutos_por_conversacion, meta_pedidos_ia_pct, meta_ingresos_ia_pct) select count(*) as filas_en_el_limite_deberia_ser_1 from u where minutos_por_conversacion = 120 and meta_pedidos_ia_pct = 1 and meta_ingresos_ia_pct = 100;
rollback;

\echo ''
\echo '=== D) Base sin migrar ==='

\echo '--- 23. sin la tabla (42P01) un SAVEPOINT + ROLLBACK TO SAVEPOINT deja la transaccion usable ---'
begin;
drop table restaurantes.resumen_settings;
savepoint sp_verify_resumen_config;
do $$
declare
  v_state text;
begin
  begin
    perform 1 from restaurantes.resumen_settings;
    raise exception 'se esperaba SQLSTATE 42P01 y la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_resumen_config;
release savepoint sp_verify_resumen_config;
select 1 as siguiente_consulta_del_request_deberia_ser_1;
rollback;

\echo '--- 24. SIN el SAVEPOINT, el mismo 42P01 deja la transaccion abortada (25P02) ---'
begin;
drop table restaurantes.resumen_settings;
select 1 from restaurantes.resumen_settings;
select 1 as should_fail;
rollback;
