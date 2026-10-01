-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0030_superadmin_cfo_dashboard.sql:
--
--   A) Lectura del dashboard (get_cfo_dashboard_for_superadmin): caller-binding, cero filas para
--      quien no es superadmin o para una sesion de sistema, anon sin EXECUTE, costo del mes
--      (LLM + eventos sin doble conteo), limites del plan, tipo de cambio vigente.
--   B) Lectura del cron (get_cfo_alert_inputs_for_system): solo-sistema; un usuario con sesion
--      o anon no la ejecutan.
--   C) Foto mensual (snapshot_billing_monthly_for_system): solo-sistema, formula de ingreso
--      esperado SIN inventar precios (sin plan / plan sin precio -> NULL con razon), idempotente,
--      y la historia de meses cerrados no se reescribe.
--   D) Lectura de la historia (list_billing_snapshots_for_superadmin): caller-binding.
--   E) Tablas y funcion interna sin GRANT directo (authenticated y anon, incluido un miembro de la
--      propia organizacion: no hay lectura cruzada entre organizaciones).
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias `as should_fail` marca un escenario que debe terminar en
-- ERROR; el alias deberia_ser_N exige que la ultima fila valga N. Sesion de SISTEMA = rol
-- authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (como dueño, sin pasar por las funciones).
insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f1000', 'restaurantes', 'CFO Org A restaurantes', 'org-cfo-a', 'active'),
  ('00000000-0000-0000-0000-0000000f1001', 'hoteles', 'CFO Org B hoteles', 'org-cfo-b', 'active'),
  ('00000000-0000-0000-0000-0000000f1002', 'rentas', 'CFO Org C sin plan', 'org-cfo-c', 'active'),
  ('00000000-0000-0000-0000-0000000f1003', 'rentas', 'CFO Org D plan sin precio', 'org-cfo-d', 'active')
on conflict do nothing;

-- A tiene 3 sucursales activas y 1 inactiva (no cuenta).
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-0000000f3000', '00000000-0000-0000-0000-0000000f1000', 'restaurantes', 'A1', 'active'),
  ('00000000-0000-0000-0000-0000000f3001', '00000000-0000-0000-0000-0000000f1000', 'restaurantes', 'A2', 'active'),
  ('00000000-0000-0000-0000-0000000f3002', '00000000-0000-0000-0000-0000000f1000', 'restaurantes', 'A3', 'active'),
  ('00000000-0000-0000-0000-0000000f3003', '00000000-0000-0000-0000-0000000f1000', 'restaurantes', 'A4 inactiva', 'inactive'),
  ('00000000-0000-0000-0000-0000000f3004', '00000000-0000-0000-0000-0000000f1001', 'hoteles', 'B1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0100', 'sa-cfo-1@example.com', 'Superadmin CFO 1', 'seed'),
  ('00000000-0000-0000-0000-0000000f0102', 'staff-normal-cfo@example.com', 'Staff normal CFO', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f0100') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0102', '00000000-0000-0000-0000-0000000f1000', null, 'owner', 'staff')
on conflict do nothing;

-- Planes: A (restaurantes-estandar: base 0, 799 MXN/asiento, 1 incluido), B (hoteles-estandar: 89 MXN/asiento,
-- 5 incluidos), D (rentas-estandar: sin precio). C no tiene plan.
insert into core.organization_plan (organization_id, plan_id) values
  ('00000000-0000-0000-0000-0000000f1000', 'restaurantes-estandar'),
  ('00000000-0000-0000-0000-0000000f1001', 'hoteles-estandar'),
  ('00000000-0000-0000-0000-0000000f1003', 'rentas-estandar')
on conflict do nothing;
insert into core.plan_limit (plan_id, metrica, limite, accion_al_exceder) values
  ('restaurantes-estandar', 'minutos_voz_mes', 3, 'avisar')
on conflict do nothing;

-- B tiene suscripcion activa con 10 asientos; D esta en pago pendiente.
insert into core.organization_billing (organization_id, status, seats, current_period_end) values
  ('00000000-0000-0000-0000-0000000f1001', 'activa', 10, '2026-04-01 00:00+00'),
  ('00000000-0000-0000-0000-0000000f1003', 'pago_pendiente', 0, '2026-03-01 00:00+00')
on conflict do nothing;

-- Marzo 2026: A = voz 5 min (3_000_000) + whatsapp 400_000; B = telefonia 250_000.
insert into core.usage_cost_event (organization_id, property_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, costo_estimado, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000f1000', '00000000-0000-0000-0000-0000000f3000', 'restaurantes', '2026-03-15 12:00+00', 'voz', 'livekit', 'minuto', 3, 1500000, true, 'voice_call', 'cfo-va-1'),
  ('00000000-0000-0000-0000-0000000f1000', '00000000-0000-0000-0000-0000000f3000', 'restaurantes', '2026-03-16 12:00+00', 'voz', 'livekit', 'segundo', 120, 1500000, true, 'voice_call', 'cfo-va-2'),
  ('00000000-0000-0000-0000-0000000f1000', null, 'restaurantes', '2026-03-17 12:00+00', 'whatsapp', 'meta', 'mensaje', 100, 400000, false, 'whatsapp_msg', 'cfo-wa-1'),
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-0000000f3004', 'hoteles', '2026-03-20 12:00+00', 'telefonia', 'twilio', 'unidad', 1, 250000, true, 'twilio_call', 'cfo-tw-1')
on conflict do nothing;
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-0000000f1000', '2026-03-10', 'restaurantes', 'restaurantes:whatsapp_agent', 'anthropic', 'modelo-1', 'interactive', 6000000, 10)
on conflict do nothing;

-- Tipo de cambio: uno de marzo y uno posterior (no debe usarse para marzo).
insert into core.fx_rate (fecha, mxn_por_usd, fuente) values
  ('2026-03-10', 18.0, 'fixture marzo'),
  ('2026-04-10', 19.0, 'fixture abril')
on conflict do nothing;

-- Foto historica de marzo para A (la funcion del sistema no debe reescribirla).
insert into core.billing_snapshot_monthly (organization_id, mes, vertical, org_status, plan_id, billing_status, billing_seats, sucursales_activas, mrr_mxn_centavos, mrr_razon) values
  ('00000000-0000-0000-0000-0000000f1000', '2026-03-01', 'restaurantes', 'active', 'restaurantes-estandar', null, null, 3, 12345, null)
on conflict do nothing;


\echo 'A1. dashboard marzo como superadmin: LLM (6_000_000) y eventos sin doble conteo (voz 3_000_000, whatsapp 400_000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select (r.llm_micro_usd = 6000000 and r.voz_micro_usd = 3000000 and r.whatsapp_micro_usd = 400000 and r.eventos_total = 3 and r.eventos_estimados = 2 and r.minutos_voz = 5)::int as deberia_ser_1
  from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000f1000';
rollback;

\echo 'A2. aislamiento: B no ve el costo de A (solo su telefonia 250_000 y cero voz)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select (r.voz_micro_usd = 0 and r.telefonia_micro_usd = 250000 and r.llm_micro_usd = 0)::int as deberia_ser_1
  from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000f1001';
rollback;

\echo 'A3. sucursales activas de A = 3 (la inactiva no cuenta) y trae los limites del plan como json'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select (r.sucursales_activas = 3 and r.limites @> '[{"metrica":"minutos_voz_mes","limite":3,"accion":"avisar"}]'::jsonb)::int as deberia_ser_1
  from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000f1000';
rollback;

\echo 'A4. tipo de cambio de marzo = el de 2026-03-10 (18.0), no el posterior de abril'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select (r.mxn_por_usd = 18.0 and r.fx_fecha = '2026-03-10')::int as deberia_ser_1
  from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000f1000';
rollback;

\echo 'A5. mes sin tipo de cambio aplicable (enero 2026): mxn_por_usd NULL, nunca un valor inventado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-01-01') r where r.mxn_por_usd is not null;
rollback;

\echo 'A6. cobranza: D en pago_pendiente con fin de periodo, B activa con 10 asientos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select count(*) as deberia_ser_2 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01') r
  where (r.organization_id = '00000000-0000-0000-0000-0000000f1003' and r.billing_status = 'pago_pendiente' and r.billing_period_end is not null)
     or (r.organization_id = '00000000-0000-0000-0000-0000000f1001' and r.billing_status = 'activa' and r.billing_seats = 10);
rollback;

\echo 'A7. staff normal (miembro de A, no superadmin) pide el dashboard con su propio id -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0102', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0102', '2026-03-01');
rollback;

\echo 'A8. caller-binding: p_caller_id de un superadmin pero auth.uid() de OTRO -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0102', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01');
rollback;

\echo 'A9. sesion de sistema (auth.uid() null) no lee el dashboard del superadmin -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01');
rollback;

\echo 'A10. anon no puede ejecutar el dashboard -- RECHAZADO'
begin;
set local role anon;
select * from core.get_cfo_dashboard_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01') as should_fail;
rollback;

\echo 'B1. entradas de alerta como sistema: devuelve las organizaciones con su costo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (r.llm_micro_usd = 6000000 and r.voz_micro_usd = 3000000)::int as deberia_ser_1
  from core.get_cfo_alert_inputs_for_system('2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000f1000';
rollback;

\echo 'B2. entradas de alerta con auth.uid() real (incluso superadmin) -- RECHAZADO (solo sistema)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select * from core.get_cfo_alert_inputs_for_system('2026-03-01') as should_fail;
rollback;

\echo 'B3. entradas de alerta como staff normal de la organizacion -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0102', true);
select * from core.get_cfo_alert_inputs_for_system('2026-03-01') as should_fail;
rollback;

\echo 'B4. anon no puede ejecutar las entradas de alerta -- RECHAZADO'
begin;
set local role anon;
select * from core.get_cfo_alert_inputs_for_system('2026-03-01') as should_fail;
rollback;

\echo 'C1. snapshot con auth.uid() real -- RECHAZADO (solo sistema)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select core.snapshot_billing_monthly_for_system() as should_fail;
rollback;

\echo 'C2. snapshot anon -- RECHAZADO'
begin;
set local role anon;
select core.snapshot_billing_monthly_for_system() as should_fail;
rollback;

\echo 'C3. snapshot de sistema: escribe una fila por organizacion del mes en curso (al menos las 4 del fixture)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.snapshot_billing_monthly_for_system();
reset role;
select (count(*) >= 4)::int as deberia_ser_1 from core.billing_snapshot_monthly where mes = date_trunc('month', current_date)::date and organization_id::text like '00000000-0000-0000-0000-0000000f10%';
rollback;

\echo 'C4. formula de ingreso: A = (3 sucursales - 1 incluida) x 79900 = 159800; B = 10 asientos de Stripe x 8900 = 89000'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.snapshot_billing_monthly_for_system();
reset role;
select count(*) as deberia_ser_2 from core.billing_snapshot_monthly s
  where s.mes = date_trunc('month', current_date)::date
    and ((s.organization_id = '00000000-0000-0000-0000-0000000f1000' and s.mrr_mxn_centavos = 159800 and s.mrr_razon is null)
      or (s.organization_id = '00000000-0000-0000-0000-0000000f1001' and s.mrr_mxn_centavos = 89000 and s.mrr_razon is null));
rollback;

\echo 'C5. sin plan -> NULL con razon sin_plan; plan sin precio -> NULL con razon precio_no_configurado (nunca 0)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.snapshot_billing_monthly_for_system();
reset role;
select count(*) as deberia_ser_2 from core.billing_snapshot_monthly s
  where s.mes = date_trunc('month', current_date)::date and s.mrr_mxn_centavos is null
    and ((s.organization_id = '00000000-0000-0000-0000-0000000f1002' and s.mrr_razon = 'sin_plan')
      or (s.organization_id = '00000000-0000-0000-0000-0000000f1003' and s.mrr_razon = 'precio_no_configurado'));
rollback;

\echo 'C6. idempotente: correr el snapshot dos veces no duplica filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.snapshot_billing_monthly_for_system();
select core.snapshot_billing_monthly_for_system();
reset role;
select (count(*) = count(distinct (organization_id, mes)))::int as deberia_ser_1 from core.billing_snapshot_monthly;
rollback;

\echo 'C7. la foto de un mes ya cerrado (marzo) no se reescribe por el snapshot del mes en curso'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.snapshot_billing_monthly_for_system();
reset role;
select count(*) as deberia_ser_1 from core.billing_snapshot_monthly where organization_id = '00000000-0000-0000-0000-0000000f1000' and mes = '2026-03-01' and mrr_mxn_centavos = 12345;
rollback;

\echo 'D1. historia como superadmin: ve la foto de marzo de A'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select count(*) as deberia_ser_1 from core.list_billing_snapshots_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01', '2026-03-31') where organization_id = '00000000-0000-0000-0000-0000000f1000' and mrr_mxn_centavos = 12345;
rollback;

\echo 'D2. historia como staff normal (miembro de A) -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0102', true);
select count(*) as deberia_ser_0 from core.list_billing_snapshots_for_superadmin('00000000-0000-0000-0000-0000000f0102', '2026-03-01', '2026-03-31');
rollback;

\echo 'D3. historia con caller-binding roto -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0102', true);
select count(*) as deberia_ser_0 from core.list_billing_snapshots_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01', '2026-03-31');
rollback;

\echo 'D4. historia anon -- RECHAZADO'
begin;
set local role anon;
select * from core.list_billing_snapshots_for_superadmin('00000000-0000-0000-0000-0000000f0100', '2026-03-01', '2026-03-31') as should_fail;
rollback;

\echo 'E1. authenticated (miembro de A) no lee billing_snapshot_monthly directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0102', true);
select * from core.billing_snapshot_monthly as should_fail;
rollback;

\echo 'E2. anon no lee billing_snapshot_monthly -- RECHAZADO'
begin;
set local role anon;
select * from core.billing_snapshot_monthly as should_fail;
rollback;

\echo 'E3. authenticated no escribe billing_snapshot_monthly directo (ni siquiera la foto de su propia organizacion) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0102', true);
update core.billing_snapshot_monthly set mrr_mxn_centavos = 1 where organization_id = '00000000-0000-0000-0000-0000000f1000' returning 1 as should_fail;
rollback;

\echo 'E4. la funcion interna core.cfo_org_rows no es invocable por authenticated (cuerpo unico sin GRANT) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0100', true);
select * from core.cfo_org_rows('2026-03-01') as should_fail;
rollback;

\echo 'E5. la foto no admite meses que no sean el primer dia (CHECK) -- RECHAZADO'
begin;
insert into core.billing_snapshot_monthly (organization_id, mes, vertical, org_status, sucursales_activas, mrr_razon)
values ('00000000-0000-0000-0000-0000000f1002', '2026-05-15', 'rentas', 'active', 0, 'sin_plan') returning 1 as should_fail;
rollback;

\echo 'E6. mrr NULL exige razon y mrr con valor no admite razon (CHECK) -- RECHAZADO'
begin;
insert into core.billing_snapshot_monthly (organization_id, mes, vertical, org_status, sucursales_activas, mrr_mxn_centavos)
values ('00000000-0000-0000-0000-0000000f1002', '2026-05-01', 'rentas', 'active', 0, null) returning 1 as should_fail;
rollback;
