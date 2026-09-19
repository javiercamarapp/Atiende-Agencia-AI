-- Fixtures + assertions que verifican, contra Postgres REAL (nunca el mirror en
-- memoria de domain-hoteles, que jamás aplica triggers/RLS/GRANT), las piezas SQL
-- de hoteles que la auditoría del 18-sep señaló como el hueco real de confianza de
-- este vertical: el trigger `revenue_engine_gate_transition_guard`
-- (migrations/011_revenue_engine_gate.sql), el índice anti-doble-captura de
-- night-audit (migrations/008_night_audit.sql, y el índice hermano de cargo de
-- hospedaje en migrations/001_hoteles_schema.sql), `hoteles.mark_charge_reversed()`
-- + el motor de folios (migrations/002/001), RLS de reputación
-- (migrations/013_reputacion.sql + migrations/021_reputacion_respuestas.sql), y
-- aislamiento cross-tenant básico de folios/cargos/CFDI. Corre vía ./run.sh (local)
-- o scripts/verify-real-postgres-ci/run-gate.mjs (CI) — ver esos archivos para cómo
-- se levanta el Postgres efímero y se aplican las migraciones reales primero.
--
-- Cada escenario vive en su propio `begin; ... rollback;` — nada de esta sección
-- persiste. Los fixtures de arriba (organización/properties/staff/membership/
-- reservación/folio/reseña/cfdi base) SÍ persisten (corren fuera de una
-- transacción, como superusuario, para poder poblar filas que ninguna policy RLS
-- dejaría insertar a un staff normal) — cada escenario los reutiliza vía sus IDs
-- fijos.
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS)
-- ---------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A', 'hotel-a-critico'),
  ('00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B', 'hotel-b-critico')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 1'),
  ('00000000-0000-0000-0000-0000000a1a02', '00000000-0000-0000-0000-00000000a001', 'hoteles', 'Hotel A - Property 2'),
  ('00000000-0000-0000-0000-0000000b1b01', '00000000-0000-0000-0000-00000000b001', 'hoteles', 'Hotel B - Property 1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0a01', 'owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a02', 'gm-a@example.com', 'GM A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a03', 'frontdesk-a@example.com', 'Frontdesk A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0a04', 'owner-a2-scoped@example.com', 'Owner A (solo property 2)', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b01', 'owner-b@example.com', 'Owner B', 'seed')
on conflict do nothing;

-- owner_a/gm_a/frontdesk_a: acceso a TODAS las properties de Hotel A (property_ids
-- null). staff_a2_scoped: acceso SOLO a property_a2 (para probar que el scoping por
-- property_ids realmente acota, no solo la organización). owner_b: Hotel B, sin
-- ninguna relación con Hotel A -- el caso "staff real pero de otra organización" de
-- cada escenario cross-tenant.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0a01', '00000000-0000-0000-0000-00000000a001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0a02', '00000000-0000-0000-0000-00000000a001', null, 'admin', 'gm'),
  ('00000000-0000-0000-0000-0000000a0a03', '00000000-0000-0000-0000-00000000a001', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-0000000a0a04', '00000000-0000-0000-0000-00000000a001',
     array['00000000-0000-0000-0000-0000000a1a02']::uuid[], 'member', 'owner'),
  ('00000000-0000-0000-0000-0000000b0b01', '00000000-0000-0000-0000-00000000b001', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.reservation (id, organization_id, property_id, check_in_date, check_out_date, status, total_amount) values
  ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '2026-01-01', '2026-01-05', 'confirmada', 4000)
on conflict do nothing;

insert into hoteles.folio (id, organization_id, property_id, reservation_id, label, is_primary) values
  ('00000000-0000-0000-0000-00000000f001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f101', 'Principal', true)
on conflict do nothing;

insert into hoteles.guest_review (id, organization_id, property_id, source, texto, sentiment, sentiment_score, created_by) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'encuesta_propia', 'Todo bien, gracias.', 'positivo', 0.500, '00000000-0000-0000-0000-0000000a0a03')
on conflict do nothing;

insert into hoteles.cfdi_emision (id, organization_id, property_id, folio_id, tipo, status, subtotal, total, rfc_receptor, uso_cfdi, metodo_pago) values
  ('00000000-0000-0000-0000-00000000c001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'hospedaje', 'timbrado', 1000, 1160, 'XAXX010101000', 'G03', 'PUE')
on conflict do nothing;

insert into hoteles.guest_review_response (id, organization_id, property_id, review_id, texto, created_by) values
  ('00000000-0000-0000-0000-00000000ee01', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000e001', 'Respuesta real de Hotel A', '00000000-0000-0000-0000-0000000a0a03')
on conflict do nothing;

-- =============================================================================
-- (a) hoteles.revenue_engine_gate_transition_guard (migrations/011)
-- =============================================================================

\echo '=== 1. INSERT con gate != shadow es RECHAZADO (toda property nueva empieza en shadow) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (organization_id, property_id, gate)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'propone')
returning id as should_fail;
rollback;

\echo '=== 2. frontdesk (sin owner/gm) NO puede crear el gate de revenue (RLS insert) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.revenue_engine_gate (organization_id, property_id, gate)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow')
returning id as should_fail;
rollback;

\echo '=== 3. owner SI puede crear el gate en shadow (ensureRevenueGate) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (organization_id, property_id, gate)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow')
returning id;
rollback;

\echo '=== 4. Promover shadow->propone ANTES de 90 dias en shadow es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '10 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea001' returning id as should_fail;
rollback;

\echo '=== 5. Promover shadow->propone CON 90+ dias en shadow SI procede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea002' returning id;
rollback;

\echo '=== 6. Saltar directo de shadow a autopilot (sin pasar por propone) es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'autopilot' where id = '00000000-0000-0000-0000-0000000ea003' returning id as should_fail;
rollback;

-- NOTA (7-12): el trigger de INSERT (sección "1" arriba) exige que TODA fila nueva
-- empiece en 'shadow' -- ni siquiera el superusuario que corre los fixtures puede
-- insertar directo en 'propone'/'autopilot' (un trigger BEFORE ROW se ejecuta para
-- CUALQUIER rol, a diferencia de RLS). Por eso cada escenario de abajo construye el
-- estado 'propone'/'autopilot' pasando por las transiciones REALES (insert shadow
-- con shadow_started_at ya vencido -> update a propone), dentro de la MISMA
-- transacción -- `now()` es constante durante toda una transacción de Postgres, así
-- que "shadow_started_at = now() - 91 days" sigue siendo >= 90 días vencidos en el
-- momento del UPDATE aunque ambas sentencias corran en el mismo instante de reloj.

\echo '=== 7. Promover propone->autopilot SIN backtest vigente que pase es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea004';
update hoteles.revenue_engine_gate set gate = 'autopilot' where id = '00000000-0000-0000-0000-0000000ea004' returning id as should_fail;
rollback;

\echo '=== 8. gm NO puede registrar la aprobacion de autopilot (reservado a owner) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea005', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea005';
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
update hoteles.revenue_engine_gate set owner_approved_autopilot_at = now() where id = '00000000-0000-0000-0000-0000000ea005' returning id as should_fail;
rollback;

\echo '=== 9. Promover propone->autopilot CON backtest vigente que pasa PERO SIN aprobacion de owner es RECHAZADO ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea006', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea006';
insert into hoteles.revenue_backtest_run
  (organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won, engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons)
values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'misma_tarifa_periodo_anterior', 12, 9, 120000, 100000, 20.0, true, '[]'::jsonb);
update hoteles.revenue_engine_gate set gate = 'autopilot' where id = '00000000-0000-0000-0000-0000000ea006' returning id as should_fail;
rollback;

\echo '=== 10. owner SI puede registrar la aprobacion de autopilot mientras el gate esta en propone ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea007', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea007';
update hoteles.revenue_engine_gate set owner_approved_autopilot_at = now() where id = '00000000-0000-0000-0000-0000000ea007' returning id;
rollback;

\echo '=== 11. Con backtest vigente que pasa + aprobacion de owner ya registrada, promover propone->autopilot SI procede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea008', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea008';
insert into hoteles.revenue_backtest_run
  (organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won, engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons)
values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'misma_tarifa_periodo_anterior', 12, 9, 120000, 100000, 20.0, true, '[]'::jsonb);
update hoteles.revenue_engine_gate set owner_approved_autopilot_at = now() where id = '00000000-0000-0000-0000-0000000ea008';
update hoteles.revenue_engine_gate set gate = 'autopilot' where id = '00000000-0000-0000-0000-0000000ea008' returning id;
rollback;

\echo '=== 12. Democion autopilot->shadow SIEMPRE permitida (freno de emergencia, incluso para gm) y limpia la aprobacion de owner ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.revenue_engine_gate (id, organization_id, property_id, gate, shadow_started_at)
values ('00000000-0000-0000-0000-0000000ea009', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'shadow', now() - interval '91 days');
update hoteles.revenue_engine_gate set gate = 'propone' where id = '00000000-0000-0000-0000-0000000ea009';
insert into hoteles.revenue_backtest_run
  (organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won, engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons)
values
  ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'misma_tarifa_periodo_anterior', 12, 9, 120000, 100000, 20.0, true, '[]'::jsonb);
update hoteles.revenue_engine_gate set owner_approved_autopilot_at = now() where id = '00000000-0000-0000-0000-0000000ea009';
update hoteles.revenue_engine_gate set gate = 'autopilot' where id = '00000000-0000-0000-0000-0000000ea009';
-- Prueba la democion con "gm" (no solo owner): el freno de emergencia debe
-- funcionar para CUALQUIER rol que ya pase la RLS de owner/gm.
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a02', true);
update hoteles.revenue_engine_gate set gate = 'shadow' where id = '00000000-0000-0000-0000-0000000ea009';
select count(*) as gate_reseteado_deberia_ser_1 from hoteles.revenue_engine_gate
  where id = '00000000-0000-0000-0000-0000000ea009' and gate = 'shadow' and owner_approved_autopilot_at is null;
rollback;

-- =============================================================================
-- (b) Anti-doble-captura de night-audit (migrations/008_night_audit.sql) y del
--     cargo nocturno de hospedaje (migrations/001_hoteles_schema.sql)
-- =============================================================================

\echo '=== 13. Primer night_audit_run del dia para una property SI se inserta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.night_audit_run (organization_id, property_id, business_date, status)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '2026-02-01', 'en_progreso')
returning id;
rollback;

\echo '=== 14. SEGUNDA corrida de night_audit_run el MISMO dia/property es RECHAZADA por el indice unico ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.night_audit_run (organization_id, property_id, business_date, status)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '2026-02-02', 'en_progreso');
insert into hoteles.night_audit_run (organization_id, property_id, business_date, status)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '2026-02-02', 'en_progreso')
returning id as should_fail;
rollback;

\echo '=== 15. Primer cargo de hospedaje de una noche para un folio SI se inserta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Hospedaje noche 1', 1000, 160, 'hospedaje', '2026-02-10')
returning id;
rollback;

\echo '=== 16. SEGUNDO cargo de hospedaje de la MISMA noche/folio es RECHAZADO por el indice unico anti-doble-captura ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Hospedaje noche 2', 1000, 160, 'hospedaje', '2026-02-11');
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Hospedaje noche 2 (duplicado)', 1000, 160, 'hospedaje', '2026-02-11')
returning id as should_fail;
rollback;

-- =============================================================================
-- (c) hoteles.mark_charge_reversed() + motor de folios (migrations/002/001)
-- =============================================================================

\echo '=== 17. Reversar un cargo real SI procede (mark_charge_reversed) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept)
values ('00000000-0000-0000-0000-0000000ca001', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Minibar', 500, 80, 'extras');
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
values ('00000000-0000-0000-0000-0000000ca002', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Reverso: Minibar', -500, -80, 'reverso', '00000000-0000-0000-0000-0000000ca001');
select hoteles.mark_charge_reversed('00000000-0000-0000-0000-0000000ca001', '00000000-0000-0000-0000-0000000ca002');
rollback;

\echo '=== 18. Un cargo YA reversado NO puede reversarse una segunda vez (idempotencia real) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept)
values ('00000000-0000-0000-0000-0000000ca003', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Propina', 200, 0, 'propina');
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
values ('00000000-0000-0000-0000-0000000ca004', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Reverso: Propina', -200, 0, 'reverso', '00000000-0000-0000-0000-0000000ca003');
select hoteles.mark_charge_reversed('00000000-0000-0000-0000-0000000ca003', '00000000-0000-0000-0000-0000000ca004');
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
values ('00000000-0000-0000-0000-0000000ca005', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Segundo intento de reverso', -200, 0, 'reverso', '00000000-0000-0000-0000-0000000ca003');
select hoteles.mark_charge_reversed('00000000-0000-0000-0000-0000000ca003', '00000000-0000-0000-0000-0000000ca005') as should_fail;
rollback;

\echo '=== 19. Un cargo reversado CONSERVA trazabilidad (reversed_by apunta al cargo de reverso real) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept)
values ('00000000-0000-0000-0000-0000000ca006', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Ajuste', 300, 0, 'ajuste');
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
values ('00000000-0000-0000-0000-0000000ca007', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Reverso: Ajuste', -300, 0, 'reverso', '00000000-0000-0000-0000-0000000ca006');
select hoteles.mark_charge_reversed('00000000-0000-0000-0000-0000000ca006', '00000000-0000-0000-0000-0000000ca007');
select count(*) as trazabilidad_deberia_ser_1 from hoteles.charge
  where id = '00000000-0000-0000-0000-0000000ca006' and reversed_by = '00000000-0000-0000-0000-0000000ca007';
rollback;

\echo '=== 20. Los totales del folio CUADRAN tras un reverso completo (cargo + reverso = saldo neto 0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a01', true);
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept)
values ('00000000-0000-0000-0000-0000000ca008', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Descuento aplicado luego revertido', 750, 0, 'extras');
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id)
values ('00000000-0000-0000-0000-0000000ca009', '00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Reverso', -750, 0, 'reverso', '00000000-0000-0000-0000-0000000ca008');
select hoteles.mark_charge_reversed('00000000-0000-0000-0000-0000000ca008', '00000000-0000-0000-0000-0000000ca009');
select (coalesce(sum(amount), 0))::numeric::int as saldo_neto_deberia_ser_0
  from hoteles.charge where id in ('00000000-0000-0000-0000-0000000ca008', '00000000-0000-0000-0000-0000000ca009');
rollback;

-- =============================================================================
-- (d) RLS de reputación (migrations/013_reputacion.sql) y guest_review_response
--     (migrations/021_reputacion_respuestas.sql)
-- =============================================================================

\echo '=== 21. frontdesk de la property SI puede capturar una reseña ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.guest_review (organization_id, property_id, source, texto, sentiment, sentiment_score, created_by)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'encuesta_propia', 'Excelente estancia', 'positivo', 0.800, '00000000-0000-0000-0000-0000000a0a03')
returning id;
rollback;

\echo '=== 22. staff de OTRA ORGANIZACION no ve NINGUNA reseña de Hotel A (RLS de reputación) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ve_resenas_de_otro_hotel_deberia_ser_0 from hoteles.guest_review where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== 23. staff de Hotel A pero ACOTADO A OTRA property (property_ids) NO puede capturar reseña de property_a1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a04', true);
insert into hoteles.guest_review (organization_id, property_id, source, texto, sentiment, sentiment_score, created_by)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', 'encuesta_propia', 'Intento fuera de alcance', 'neutral', 0.000, '00000000-0000-0000-0000-0000000a0a04')
returning id as should_fail;
rollback;

\echo '=== 24. frontdesk de Hotel A SI puede responder una reseña real de su property (guest_review_response) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0a03', true);
insert into hoteles.guest_review_response (organization_id, property_id, review_id, texto, created_by)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000e001', 'Gracias por tu comentario', '00000000-0000-0000-0000-0000000a0a03')
returning id;
rollback;

\echo '=== 25. staff de OTRA ORGANIZACION NO puede insertar una respuesta sobre la reseña de Hotel A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
insert into hoteles.guest_review_response (organization_id, property_id, review_id, texto, created_by)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000e001', 'Respuesta ajena inyectada', '00000000-0000-0000-0000-0000000b0b01')
returning id as should_fail;
rollback;

\echo '=== 26. staff de OTRA ORGANIZACION no ve NINGUNA respuesta de reseña de Hotel A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ve_respuestas_de_otro_hotel_deberia_ser_0 from hoteles.guest_review_response where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

-- =============================================================================
-- (e) Aislamiento cross-tenant basico de folios/cargos/CFDI
-- =============================================================================

\echo '=== 27. staff de Hotel B no ve NINGUN folio de Hotel A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ve_folio_ajeno_deberia_ser_0 from hoteles.folio where id = '00000000-0000-0000-0000-00000000f001';
rollback;

\echo '=== 28. staff de Hotel B NO puede insertar un cargo sobre el folio de Hotel A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept)
values ('00000000-0000-0000-0000-00000000a001', '00000000-0000-0000-0000-0000000a1a01', '00000000-0000-0000-0000-00000000f001', 'Cargo inyectado por staff ajeno', 999, 0, 'extras')
returning id as should_fail;
rollback;

\echo '=== 29. staff de Hotel B no ve NINGUN cfdi_emision de Hotel A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b01', true);
select count(*) as ve_cfdi_ajeno_deberia_ser_0 from hoteles.cfdi_emision where property_id = '00000000-0000-0000-0000-0000000a1a01';
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver una fila real (RETURNING/SELECT exitoso). ==='
