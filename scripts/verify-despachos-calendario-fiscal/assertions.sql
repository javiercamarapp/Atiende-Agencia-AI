-- D-26 (calendario fiscal) -- verificacion contra Postgres REAL de la migracion 019 (CHECK de `tipo` ampliado).
-- Cada escenario corre en su propio `begin; ... rollback;`. Alias `should_fail` = debe terminar en ERROR;
-- alias `..._deberia_ser_N` = valor esperado (ver run-gate.mjs). Cubre: positivo (los 6 tipos), negativo (tipo
-- inventado), cross-tenant (RLS de property intacta) y anon (sin acceso).
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-000000d26a01', 'despachos', 'Despacho A', 'despacho-a-cal-fiscal'),
  ('00000000-0000-0000-0000-000000d26a02', 'despachos', 'Despacho B', 'despacho-b-cal-fiscal')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-000000d26b01', '00000000-0000-0000-0000-000000d26a01', 'despachos', 'Cliente A'),
  ('00000000-0000-0000-0000-000000d26b02', '00000000-0000-0000-0000-000000d26a02', 'despachos', 'Cliente B')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000d26c01', 'cal-a@example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-000000d26c02', 'cal-b@example.com', 'Staff B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000d26c01', '00000000-0000-0000-0000-000000d26a01', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000d26c02', '00000000-0000-0000-0000-000000d26a02', null, 'admin', 'admin')
on conflict do nothing;

\echo '1. staff de A inserta los 6 tipos de vencimiento en su propia property (ISR/IVA/DIOT/Nomina/Balanza/Anual)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'ISR', '2026-06', '2026-07-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'IVA', '2026-06', '2026-07-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'DIOT', '2026-06', '2026-07-31', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Nómina', '2026-06', '2026-07-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Balanza', '2026-06', '2026-08-03', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Anual', '2026-12', '2027-03-31', 'baja');
select count(*) as seis_tipos_deberia_ser_6
  from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-000000d26b01' and periodo in ('2026-06', '2026-12');
rollback;

\echo '2. un tipo inventado sigue rechazado por el CHECK (lista cerrada)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Inventado', '2026-06', '2026-07-17', 'baja') returning 1 as should_fail;
rollback;

\echo '3. el CHECK del periodo sigue exigiendo YYYY-MM (la anual usa el periodo de diciembre, nunca solo el anio)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Anual', '2026', '2027-03-31', 'baja') returning 1 as should_fail;
rollback;

\echo '4. cross-tenant: staff de B NO puede insertar un Balanza en la property de A (RLS intacta)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c02', true);
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Balanza', '2026-06', '2026-08-03', 'baja') returning 1 as should_fail;
rollback;

\echo '5. cross-tenant (lectura): staff de B no ve los vencimientos de A'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Anual', '2026-12', '2027-03-31', 'baja');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c02', true);
select count(*) as filas_ajenas_deberia_ser_0 from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-000000d26b01';
rollback;

\echo '6. anon no puede insertar vencimientos'
begin;
set local role anon;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Balanza', '2026-06', '2026-08-03', 'baja') returning 1 as should_fail;
rollback;

\echo '7. anon no puede leer vencimientos (sin GRANT: ERROR de permiso)'
begin;
set local role anon;
select count(*) as filas_anon from despachos.fiscal_deadline;
rollback;

-- Lista explicita para scripts/verify-real-postgres-ci/run-gate.mjs: los escenarios 2/3/4/6/7 deben terminar en ERROR.
