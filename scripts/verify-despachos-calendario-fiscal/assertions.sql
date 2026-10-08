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

-- ---------------------------------------------------------------------------------------------------------------
-- Migracion 024 (paridad3-despachos-fiscal-correcciones, D-P3-33): 5 tipos nuevos en el CHECK + ventana del barrido.
-- ---------------------------------------------------------------------------------------------------------------
\echo '8. (024) staff de A inserta los 5 tipos nuevos (Retenciones/IMSS/IMSS-bimestral/ISN/Informativa) en su propia property'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Retenciones', '2026-06', '2026-07-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'IMSS', '2026-06', '2026-07-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'IMSS-bimestral', '2026-06', '2026-07-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'ISN', '2026-06', '2026-07-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Informativa', '2026-12', '2027-02-15', 'baja');
select count(*) as cinco_tipos_nuevos_deberia_ser_5
  from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-000000d26b01' and tipo in ('Retenciones', 'IMSS', 'IMSS-bimestral', 'ISN', 'Informativa');
rollback;

\echo '9. (024) la lista sigue cerrada: un tipo parecido pero inventado (IMSS-mensual) se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'IMSS-mensual', '2026-06', '2026-07-17', 'baja') returning 1 as should_fail;
rollback;

\echo '10. (024) cross-tenant: staff de B NO puede insertar un ISN en la property de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c02', true);
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'ISN', '2026-06', '2026-07-17', 'baja') returning 1 as should_fail;
rollback;

\echo '11. (024) cross-tenant (lectura): staff de B no ve un Retenciones de A'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'Retenciones', '2026-06', '2026-07-17', 'baja');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c02', true);
select count(*) as filas_ajenas_nuevos_tipos_deberia_ser_0 from despachos.fiscal_deadline where property_id = '00000000-0000-0000-0000-000000d26b01';
rollback;

\echo '12. (024) anon no puede insertar un tipo nuevo'
begin;
set local role anon;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'IMSS', '2026-06', '2026-07-17', 'baja') returning 1 as should_fail;
rollback;

\echo '13. (024) un staff autenticado NO puede invocar system_vencimientos_por_escalar (solo sistema, 42501)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
select * from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-000000d26b01', '2026-07-01') as should_fail;
rollback;

\echo '14. (024) anon no puede invocar system_vencimientos_por_escalar (sin EXECUTE)'
begin;
set local role anon;
select * from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-000000d26b01', '2026-07-01') as should_fail;
rollback;

\echo '15. (024) la sesion de sistema ve vencimientos a 14 dias naturales (7 dias habiles) y NO uno a 30 dias'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'IVA', '2026-06', '2026-07-15', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'ISR', '2026-06', '2026-07-31', 'baja');
set local role authenticated;
select count(*) as ventana_21_dias_deberia_ser_1 from despachos.system_vencimientos_por_escalar('00000000-0000-0000-0000-000000d26b01', '2026-07-01');
rollback;

\echo '16. (024) la sesion de sistema lee los periodos con vencimientos de UNA property (y solo esa)'
begin;
insert into despachos.fiscal_deadline (organization_id, property_id, tipo, periodo, fecha_limite, prioridad) values
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'IVA', '2026-05', '2026-06-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a01', '00000000-0000-0000-0000-000000d26b01', 'ISR', '2026-05', '2026-06-17', 'baja'),
  ('00000000-0000-0000-0000-000000d26a02', '00000000-0000-0000-0000-000000d26b02', 'IVA', '2026-04', '2026-05-17', 'baja');
set local role authenticated;
select count(*) as periodos_de_a_deberia_ser_1 from despachos.system_vencimientos_periodos('00000000-0000-0000-0000-000000d26b01');
rollback;

\echo '17. (024) un staff autenticado NO puede invocar system_vencimientos_periodos ni system_cliente_nombre (solo sistema)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
select * from despachos.system_vencimientos_periodos('00000000-0000-0000-0000-000000d26b01') as should_fail;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000d26c01', true);
select despachos.system_cliente_nombre('00000000-0000-0000-0000-000000d26b01') as should_fail;
rollback;

\echo '18. (024) anon no puede invocar las funciones de solo sistema nuevas'
begin;
set local role anon;
select * from despachos.system_vencimientos_periodos('00000000-0000-0000-0000-000000d26b01') as should_fail;
rollback;

begin;
set local role anon;
select despachos.system_cliente_nombre('00000000-0000-0000-0000-000000d26b01') as should_fail;
rollback;

\echo '19. (024) la sesion de sistema obtiene la razon social del cliente con ficha y null sin ficha'
begin;
insert into despachos.cliente_ficha (property_id, organization_id, rfc, razon_social, regimenes_fiscales, cp_fiscal) values
  ('00000000-0000-0000-0000-000000d26b01', '00000000-0000-0000-0000-000000d26a01', 'AAA010101AAA', 'Cliente A SA de CV', array['601'], '06600');
set local role authenticated;
select (despachos.system_cliente_nombre('00000000-0000-0000-0000-000000d26b01') = 'Cliente A SA de CV')::int as con_ficha_deberia_ser_1;
select (despachos.system_cliente_nombre('00000000-0000-0000-0000-000000d26b02') is null)::int as sin_ficha_deberia_ser_1;
rollback;

-- Lista explicita para scripts/verify-real-postgres-ci/run-gate.mjs: los escenarios 2/3/4/6/7 deben terminar en ERROR.
