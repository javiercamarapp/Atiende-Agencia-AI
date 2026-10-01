-- Verifica, contra Postgres REAL (RLS + GRANT + auth.uid() reales), la migracion
-- packages/db/migrations/0028_superadmin_costos_planes.sql:
--
--   A) record_usage_cost_event: solo-sistema (un authenticated no puede inflar el costo
--      de otra organizacion), anon sin EXECUTE, vertical derivado de la organizacion,
--      sucursal ajena rechazada, CHECKs (sin categoria 'llm', sin costo negativo),
--      idempotencia por (ref_tipo, ref_id).
--   B) Reporte de costo/margen: caller-binding, cero filas para quien no es superadmin,
--      aislamiento entre organizaciones, UNION LLM + eventos sin doble conteo, filtro mensual.
--   C) Tipo de cambio: superadmin real obligatorio, validaciones.
--   D) Catalogo: seeds de las 6 verticales, upsert/limites validados, vertical inmutable
--      con organizaciones asignadas.
--   E) Asignacion en dos pasos: solo el solicitante confirma/cancela, motivo, vertical
--      coincidente, una pendiente por organizacion, vencimiento, re-validacion al confirmar,
--      el tope LLM del plan se aplica a core.llm_org_budget.
--   F) Tablas sin GRANT directo (authenticated/anon) y bitacora append-only.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias de error esperado marca un escenario que debe terminar en
-- ERROR; el alias deberia_ser_N exige que la ultima fila valga N; el resto debe completar
-- sin error. Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

-- Fixtures (como dueño, sin pasar por las funciones).
insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000e1000', 'restaurantes', 'Org A restaurantes', 'org-cp-a', 'active'),
  ('00000000-0000-0000-0000-0000000e1001', 'hoteles', 'Org B hoteles', 'org-cp-b', 'trial'),
  ('00000000-0000-0000-0000-0000000e1002', 'citas', 'Org C suspendida', 'org-cp-c', 'suspended'),
  ('00000000-0000-0000-0000-0000000e1003', 'rentas', 'Org D rentas', 'org-cp-d', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000e3000', '00000000-0000-0000-0000-0000000e1000', 'restaurantes', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e3001', '00000000-0000-0000-0000-0000000e1001', 'hoteles', 'Hotel B1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0100', 'sa-cp-1@example.com', 'Superadmin CP 1', 'seed'),
  ('00000000-0000-0000-0000-0000000e0101', 'sa-cp-2@example.com', 'Superadmin CP 2', 'seed'),
  ('00000000-0000-0000-0000-0000000e0102', 'staff-normal-cp@example.com', 'Staff normal', 'seed')
on conflict do nothing;

insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000e0100'), ('00000000-0000-0000-0000-0000000e0101') on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0102', '00000000-0000-0000-0000-0000000e1000', null, 'owner', 'staff')
on conflict do nothing;

-- Marzo 2026: A = voz (3 min + 120 s = 5 min, 3_000_000), whatsapp (100 msj, 400_000); B = telefonia 250_000.
-- Abril 2026: A = voz 900_000 (no debe contarse en marzo).
insert into core.usage_cost_event (organization_id, property_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, costo_estimado, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000e1000', '00000000-0000-0000-0000-0000000e3000', 'restaurantes', '2026-03-15 12:00+00', 'voz', 'livekit', 'minuto', 3, 1500000, true, 'voice_call', 'va-1'),
  ('00000000-0000-0000-0000-0000000e1000', '00000000-0000-0000-0000-0000000e3000', 'restaurantes', '2026-03-16 12:00+00', 'voz', 'livekit', 'segundo', 120, 1500000, true, 'voice_call', 'va-2'),
  ('00000000-0000-0000-0000-0000000e1000', null, 'restaurantes', '2026-03-17 12:00+00', 'whatsapp', 'meta', 'mensaje', 100, 400000, false, 'whatsapp_msg', 'wa-1'),
  ('00000000-0000-0000-0000-0000000e1001', '00000000-0000-0000-0000-0000000e3001', 'hoteles', '2026-03-20 12:00+00', 'telefonia', 'twilio', 'unidad', 1, 250000, true, 'twilio_call', 'tw-1'),
  ('00000000-0000-0000-0000-0000000e1000', null, 'restaurantes', '2026-04-02 12:00+00', 'voz', 'livekit', 'minuto', 2, 900000, true, 'voice_call', 'va-3')
on conflict do nothing;

-- LLM (la fuente del LLM sigue siendo llm_usage_daily): A = 6_000_000 en dos modelos; B = 2_000_000.
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-0000000e1000', '2026-03-10', 'restaurantes', 'restaurantes:whatsapp_agent', 'anthropic', 'modelo-1', 'interactive', 5000000, 10),
  ('00000000-0000-0000-0000-0000000e1000', '2026-03-10', 'restaurantes', 'restaurantes:whatsapp_agent', 'anthropic', 'modelo-2', 'interactive', 1000000, 2),
  ('00000000-0000-0000-0000-0000000e1001', '2026-03-11', 'hoteles', 'hoteles:whatsapp_agent', 'anthropic', 'modelo-1', 'interactive', 2000000, 4)
on conflict do nothing;

-- Solicitud ya vencida para la organizacion D (nadie la confirmo a tiempo).
insert into core.plan_assignment_request (id, organization_id, plan_id, motivo, creado_por, creado_en, vence_en) values
  ('00000000-0000-0000-0000-0000000e2000', '00000000-0000-0000-0000-0000000e1003', 'rentas-estandar', 'Fixture: solicitud ya vencida que nadie confirmo.', '00000000-0000-0000-0000-0000000e0100', now() - interval '2 hours', now() - interval '1 hour')
on conflict do nothing;


\echo 'A1. record_usage_cost_event como authenticated con auth.uid() real -- RECHAZADO (solo sistema)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1') as should_fail;
rollback;

\echo 'A2. record_usage_cost_event como staff normal de la propia organizacion -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1') as should_fail;
rollback;

\echo 'A3. anon no puede ejecutar record_usage_cost_event (sin GRANT EXECUTE) -- RECHAZADO'
begin;
set local role anon;
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1') as should_fail;
rollback;

\echo 'A4. sistema registra un evento -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1');
rollback;

\echo 'A5. el mismo ref_tipo+ref_id otra vez no duplica (devuelve false)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1');
select (not core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1'))::int as deberia_ser_1;
rollback;

\echo 'A6. sucursal de OTRA organizacion -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', '00000000-0000-0000-0000-0000000e3001', '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1') as should_fail;
rollback;

\echo 'A7. organizacion inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e9999', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1') as should_fail;
rollback;

\echo 'A8. categoria 'llm' no existe en usage_cost_event (el LLM no se duplica aqui) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'llm', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1') as should_fail;
rollback;

\echo 'A9. costo negativo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, -1, true, 'voice_call', 't-1') as should_fail;
rollback;

\echo 'A10. el vertical se DERIVA de la organizacion, no del llamador'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1000', null, '2026-03-05 10:00+00', 'voz', 'livekit', 'minuto', 1, 100, true, 'voice_call', 't-1');
reset role;
select count(*) as deberia_ser_1 from core.usage_cost_event where ref_id = 't-1' and vertical = 'restaurantes';
rollback;

\echo 'B1. reporte marzo: la voz de A suma solo sus eventos de marzo (3_000_000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select (r.voz_micro_usd = 3000000)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'B2. reporte: minutos de voz (3 min + 120 s = 5) y mensajes (100)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select (r.minutos_voz = 5 and r.mensajes = 100)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'B3. reporte: UNE LLM (llm_usage_daily, 6_000_000) con eventos sin doble conteo y cuenta 3 eventos (2 estimados)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select (r.llm_micro_usd = 6000000 and r.eventos_total = 3 and r.eventos_estimados = 2 and r.whatsapp_micro_usd = 400000)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'B4. aislamiento: B no ve la voz/whatsapp de A y su telefonia es la suya (250_000)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select (r.voz_micro_usd = 0 and r.whatsapp_micro_usd = 0 and r.telefonia_micro_usd = 250000 and r.llm_micro_usd = 2000000)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1001';
rollback;

\echo 'B5. otro mes: abril solo trae el evento de abril de A (900_000) y nada de LLM'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select (r.voz_micro_usd = 900000 and r.llm_micro_usd = 0)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-04-15') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'B6. el reporte trae el tope LLM efectivo (default 100_000_000 sin fila propia) y el umbral 80'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select (r.llm_cap_micro_usd = 100000000 and r.llm_alert_pct = 80)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'B7. staff normal (no superadmin) pide el reporte con su propio id -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select count(*) as deberia_ser_0 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0102', '2026-03-01');
rollback;

\echo 'B8. caller-binding: p_caller_id de un superadmin pero auth.uid() de OTRO -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select count(*) as deberia_ser_0 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01');
rollback;

\echo 'B9. sesion de sistema (auth.uid() null) no lee el reporte -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01');
rollback;

\echo 'B10. anon no puede ejecutar el reporte -- RECHAZADO'
begin;
set local role anon;
select * from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') as should_fail;
rollback;

\echo 'B11. listado de eventos de A como superadmin: 4 en total (3 de marzo + 1 de abril)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as deberia_ser_1 from (select 1 from core.list_usage_cost_events_for_superadmin('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 100) having count(*) = 4) q;
rollback;

\echo 'B12. listado de eventos como staff normal -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select count(*) as deberia_ser_0 from core.list_usage_cost_events_for_superadmin('00000000-0000-0000-0000-0000000e0102', '00000000-0000-0000-0000-0000000e1000', 100);
rollback;

\echo 'C1. superadmin fija el tipo de cambio y aparece en el listado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_set_fx_rate('00000000-0000-0000-0000-0000000e0100', '2026-03-01', 17.5, 'Banxico FIX (fixture)');
select count(*) as deberia_ser_1 from core.list_fx_rates_for_superadmin('00000000-0000-0000-0000-0000000e0100', 10) where mxn_por_usd = 17.5;
rollback;

\echo 'C2. staff normal intenta fijar el tipo de cambio -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select core.superadmin_set_fx_rate('00000000-0000-0000-0000-0000000e0102', '2026-03-01', 17.5, 'Banxico FIX (fixture)') as should_fail;
rollback;

\echo 'C3. caller-binding en fx: p_caller_id superadmin, auth.uid() de otro -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select core.superadmin_set_fx_rate('00000000-0000-0000-0000-0000000e0100', '2026-03-01', 17.5, 'Banxico FIX (fixture)') as should_fail;
rollback;

\echo 'C4. tipo de cambio negativo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_set_fx_rate('00000000-0000-0000-0000-0000000e0100', '2026-03-01', -3, 'Banxico FIX (fixture)') as should_fail;
rollback;

\echo 'C5. fecha futura -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_set_fx_rate('00000000-0000-0000-0000-0000000e0100', current_date + 30, 17.5, 'Banxico FIX (fixture)') as should_fail;
rollback;

\echo 'C6. staff normal no lista tipos de cambio -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select count(*) as deberia_ser_0 from core.list_fx_rates_for_superadmin('00000000-0000-0000-0000-0000000e0102', 10);
rollback;

\echo 'D1. seeds: las 6 verticales tienen plan y las 3 sin precio conocido quedan en NULL (no inventado)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as deberia_ser_6 from core.list_plans_for_superadmin('00000000-0000-0000-0000-0000000e0100') p where (p.id = 'hoteles-estandar' and p.precio_asiento_mxn_centavos = 8900 and p.asientos_incluidos = 5) or (p.id = 'restaurantes-estandar' and p.precio_asiento_mxn_centavos = 79900 and p.asientos_incluidos = 1) or (p.id = 'citas-estandar' and p.precio_asiento_mxn_centavos = 59900) or (p.id in ('rentas-estandar', 'licitaciones-estandar', 'despachos-estandar') and p.precio_asiento_mxn_centavos is null and p.precio_base_mxn_centavos is null);
rollback;

\echo 'D2. staff normal no lista el catalogo -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select count(*) as deberia_ser_0 from core.list_plans_for_superadmin('00000000-0000-0000-0000-0000000e0102');
rollback;

\echo 'D3. staff normal no puede crear un plan -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0102', 'plan-x-prueba', 'Plan X', 'restaurantes', 100, 100, 0, true) as should_fail;
rollback;

\echo 'D4. superadmin crea un plan y un limite; el listado trae el limite'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'restaurantes-pro', 'Restaurantes Pro', 'restaurantes', 590000, 79900, 1, true);
select core.superadmin_set_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-pro', 'minutos_voz_mes', 10000, 'cobrar');
select count(*) as deberia_ser_1 from core.list_plans_for_superadmin('00000000-0000-0000-0000-0000000e0100') p where p.id = 'restaurantes-pro' and jsonb_array_length(p.limites) = 1;
rollback;

\echo 'D5. id de plan invalido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'X', 'Plan X', 'restaurantes', 100, 100, 0, true) as should_fail;
rollback;

\echo 'D6. vertical inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'plan-x-prueba', 'Plan X', 'gimnasios', 100, 100, 0, true) as should_fail;
rollback;

\echo 'D7. precio negativo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'plan-x-prueba', 'Plan X', 'restaurantes', -5, 100, 0, true) as should_fail;
rollback;

\echo 'D8. metrica de limite invalida -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_set_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-estandar', 'cafes_mes', 10, 'avisar') as should_fail;
rollback;

\echo 'D9. limite LLM con accion pausar y valor 0 -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_set_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-estandar', 'llm_costo_micro_usd_mes', 0, 'pausar') as should_fail;
rollback;

\echo 'D10. limite sobre un plan inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_set_plan_limit('00000000-0000-0000-0000-0000000e0100', 'no-existe', 'asientos', 5, 'avisar') as should_fail;
rollback;

\echo 'D11. borrar un limite inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_delete_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-estandar', 'asientos') as should_fail;
rollback;

\echo 'D12. borrar un limite existente -- OK'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_set_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-estandar', 'asientos', 5, 'avisar');
select core.superadmin_delete_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-estandar', 'asientos');
select count(*) as deberia_ser_0 from core.list_plans_for_superadmin('00000000-0000-0000-0000-0000000e0100') p where p.id = 'restaurantes-estandar' and jsonb_array_length(p.limites) > 0;
rollback;

\echo 'E1. solicitar asignacion NO asigna nada (aun no hay plan en el reporte)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar');
select count(*) as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000' and r.plan_id is null;
rollback;

\echo 'E2. motivo corto -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'corto') as should_fail;
rollback;

\echo 'E3. plan de OTRA vertical (hoteles a una org de restaurantes) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'hoteles-estandar', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'E4. organizacion suspendida -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1002', 'citas-estandar', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'E5. plan inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'no-existe', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'E6. organizacion inexistente -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e9999', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'E7. staff normal solicita -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0102', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Intento de un usuario que no es superadmin') as should_fail;
rollback;

\echo 'E8. plan inactivo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'restaurantes-estandar', 'Restaurantes - por agente de voz', 'restaurantes', 0, 79900, 1, false);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'E9. segunda solicitud pendiente para la misma organizacion -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar');
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'restaurantes-pro', 'Restaurantes Pro', 'restaurantes', 590000, 79900, 1, true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-pro', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'E10. otro superadmin NO puede confirmar la solicitud ajena -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
create temp table t_req as select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0101', true);
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0101', (select id from t_req)) as should_fail;
rollback;

\echo 'E11. el solicitante confirma: el reporte muestra el plan asignado con su precio'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q));
select count(*) as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000' and r.plan_id = 'restaurantes-estandar' and r.precio_asiento_mxn_centavos = 79900;
rollback;

\echo 'E12. asignar el mismo plan otra vez -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q));
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'E13. confirmar dos veces la misma solicitud -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
create temp table t_req2 as select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q;
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select id from t_req2));
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select id from t_req2)) as should_fail;
rollback;

\echo 'E14. el plan con limite LLM 'pausar' APLICA el tope a core.llm_org_budget al confirmar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'restaurantes-pro', 'Restaurantes Pro', 'restaurantes', 590000, 79900, 1, true);
select core.superadmin_set_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-pro', 'llm_costo_micro_usd_mes', 7000000, 'pausar');
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-pro', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q));
select (r.llm_cap_micro_usd = 7000000)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'E15. un limite LLM con accion 'avisar' NO toca el tope (sigue el default)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'restaurantes-pro', 'Restaurantes Pro', 'restaurantes', 590000, 79900, 1, true);
select core.superadmin_set_plan_limit('00000000-0000-0000-0000-0000000e0100', 'restaurantes-pro', 'llm_costo_micro_usd_mes', 7000000, 'avisar');
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-pro', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q));
select (r.llm_cap_micro_usd = 100000000)::int as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1000';
rollback;

\echo 'E16. confirmar una solicitud VENCIDA la marca expirada y NO asigna'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select (core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e2000')).estado = 'expired' as expirada;
select count(*) as deberia_ser_1 from core.get_cost_margin_report_for_superadmin('00000000-0000-0000-0000-0000000e0100', '2026-03-01') r where r.organization_id = '00000000-0000-0000-0000-0000000e1003' and r.plan_id is null;
rollback;

\echo 'E17. una pendiente vencida no bloquea una solicitud nueva sobre la misma organizacion'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1003', 'rentas-estandar', 'Cliente firmo contrato anual del plan estandar');
select count(*) as deberia_ser_1 from core.list_plan_assignments_for_superadmin('00000000-0000-0000-0000-0000000e0100', 50) a where a.organization_id = '00000000-0000-0000-0000-0000000e1003' and a.estado = 'pending';
rollback;

\echo 'E18. el listado MUESTRA como expirada una pendiente vencida aunque nadie la haya tocado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select count(*) as deberia_ser_1 from core.list_plan_assignments_for_superadmin('00000000-0000-0000-0000-0000000e0100', 50) a where a.id = '00000000-0000-0000-0000-0000000e2000' and a.estado = 'expired';
rollback;

\echo 'E19. re-validacion al confirmar: si la organizacion se suspendio en el intervalo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
create temp table t_req3 as select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q;
reset role;
update core.organization set status = 'suspended' where id = '00000000-0000-0000-0000-0000000e1000';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select id from t_req3)) as should_fail;
rollback;

\echo 'E20. el solicitante cancela; confirmar despues -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
create temp table t_req4 as select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q;
select core.superadmin_cancel_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select id from t_req4));
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select id from t_req4)) as should_fail;
rollback;

\echo 'E21. otro superadmin NO puede cancelar la solicitud ajena -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
create temp table t_req5 as select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0101', true);
select core.superadmin_cancel_plan_assignment('00000000-0000-0000-0000-0000000e0101', (select id from t_req5)) as should_fail;
rollback;

\echo 'E22. no se puede cambiar la vertical de un plan con organizaciones asignadas -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q));
select core.superadmin_upsert_plan('00000000-0000-0000-0000-0000000e0100', 'restaurantes-estandar', 'Restaurantes - por agente de voz', 'hoteles', 0, 79900, 1, true) as should_fail;
rollback;

\echo 'E23. la bitacora registra solicitud y ejecucion (2 eventos para la asignacion)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.superadmin_confirm_plan_assignment('00000000-0000-0000-0000-0000000e0100', (select (r).id from (select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as r offset 0) q));
reset role;
select count(*) as deberia_ser_2 from core.plan_audit_log where organization_id = '00000000-0000-0000-0000-0000000e1000' and event in ('assignment_requested', 'assignment_executed');
rollback;

\echo 'E24. staff normal no lista solicitudes -- cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
select count(*) as deberia_ser_0 from core.list_plan_assignments_for_superadmin('00000000-0000-0000-0000-0000000e0102', 50);
rollback;

\echo 'E25. anon no puede solicitar una asignacion -- RECHAZADO'
begin;
set local role anon;
select core.superadmin_request_plan_assignment('00000000-0000-0000-0000-0000000e0100', '00000000-0000-0000-0000-0000000e1000', 'restaurantes-estandar', 'Cliente firmo contrato anual del plan estandar') as should_fail;
rollback;

\echo 'F-fx_rate. authenticated no puede leer core.fx_rate directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select * from core.fx_rate as should_fail;
rollback;

\echo 'F-usage_cost_event. authenticated no puede leer core.usage_cost_event directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select * from core.usage_cost_event as should_fail;
rollback;

\echo 'F-plan. authenticated no puede leer core.plan directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select * from core.plan as should_fail;
rollback;

\echo 'F-plan_limit. authenticated no puede leer core.plan_limit directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select * from core.plan_limit as should_fail;
rollback;

\echo 'F-organization_plan. authenticated no puede leer core.organization_plan directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select * from core.organization_plan as should_fail;
rollback;

\echo 'F-plan_assignment_request. authenticated no puede leer core.plan_assignment_request directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select * from core.plan_assignment_request as should_fail;
rollback;

\echo 'F-plan_audit_log. authenticated no puede leer core.plan_audit_log directo (sin GRANT, RLS sin policies) -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select * from core.plan_audit_log as should_fail;
rollback;

\echo 'F8. anon no puede leer core.usage_cost_event directo -- RECHAZADO'
begin;
set local role anon;
select * from core.usage_cost_event as should_fail;
rollback;

\echo 'F9. authenticated no puede insertar eventos de costo directo -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0102', true);
insert into core.usage_cost_event (organization_id, vertical, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values ('00000000-0000-0000-0000-0000000e1000', 'restaurantes', 'voz', 'x', 'minuto', 1, 1, 'voice_call', 'hack-1'); -- as should_fail
rollback;

\echo 'F10. la bitacora es append-only: UPDATE bloqueado aun para el dueño -- RECHAZADO'
begin;
select core.plan_audit_write('fx_set', null, null, null, '{}'::jsonb);
update core.plan_audit_log set detail = '{"x":1}'::jsonb; -- as should_fail
rollback;

\echo 'F11. la bitacora es append-only: DELETE bloqueado aun para el dueño -- RECHAZADO'
begin;
select core.plan_audit_write('fx_set', null, null, null, '{}'::jsonb);
delete from core.plan_audit_log; -- as should_fail
rollback;

\echo 'F12. el helper core.plan_audit_write no es ejecutable por authenticated -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0100', true);
select core.plan_audit_write('fx_set', null, null, null, '{}'::jsonb) as should_fail;
rollback;

\echo 'Listo: los escenarios marcados como RECHAZADO deben terminar en ERROR; los de valor, en el entero indicado.'
