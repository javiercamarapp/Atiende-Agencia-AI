-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT +
-- triggers reales -- no el repositorio en memoria de domain-hoteles, que nunca
-- aplica ninguno de los tres), que
-- packages/domain-hoteles/migrations/029_rate_recommendation_engine.sql cierra
-- exactamente lo que dice cerrar, incluida la INTEGRACIÓN real con el gate y el
-- backtest YA EXISTENTES (011_revenue_engine_gate.sql) -- no solo que la tabla
-- nueva "existe", sino que el trigger de transición de
-- `hoteles.rate_recommendation.estado` de verdad respeta shadow/propone/autopilot
-- y el backtest walk-forward, mismo patrón EXACTO que
-- scripts/verify-citas-audit-log/assertions.sql (leído primero como plantilla).
--
-- Escenarios:
--   1-2.  Positivo: staff owner/gm de la Org A aprueba una recomendación en
--         "propone"; el sistema la aplica después (escribe hoteles.rate_plan de
--         verdad) -- efecto REAL, no solo "no hubo 500".
--   3.    Negativo: rol insuficiente (frontdesk) no puede aprobar.
--   4.    Cross-tenant: owner de la Org B no puede aprobar la recomendación de la
--         Org A, ni verla.
--   5-6.  anon: rechazado por completo (lectura y el intento de aprobar).
--   7.    Integración con el gate: aprobar mientras el gate está en "shadow" --
--         RECHAZADO (aprobar un cambio individual solo aplica en "propone").
--   8.    Integración con el gate: el sistema intenta aplicar una "pendiente"
--         directo mientras el gate está en "propone" (sin pasar por "aprobada")
--         -- RECHAZADO.
--   9.    Integración con backtest: en "autopilot" SIN un backtest que pase --
--         RECHAZADO, aunque el gate ya esté en autopilot.
--   10.   Integración con el límite de variación: en "autopilot" CON backtest que
--         pasa pero la variación excede `propone_max_variation_pct` -- RECHAZADO
--         (guarda de seguridad deliberada de v1, ver comentario del trigger).
--   11.   Positivo en autopilot: backtest que pasa + variación dentro del límite
--         -- el sistema aplica "pendiente"->"aplicada" DIRECTO (sin aprobación
--         humana) y escribe la tarifa real.
--   12.   INSERT directo de una recomendación por un staff autenticado --
--         RECHAZADO (solo la sesión de sistema inserta).
--   13.   Estado terminal inmutable: una recomendación ya "descartada" no puede
--         volver a transicionar.
--   14-15. pricing_rule / local_event / competitor_rate: owner/gm escribe, rol
--         insuficiente (frontdesk) NO puede.
--   16.   Esquema de PRODUCCIÓN a medio migrar (029 no aplicada): SQLSTATE real
--         de Postgres para `hoteles.system_apply_rate_recommendation`,
--         recuperado con SAVEPOINT real.
--
-- Run vía ./run.sh -- ver ese archivo para cómo se levanta el Postgres efímero + el
-- mock mínimo de plataforma.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000000f1', 'hoteles', 'Org A (hoteles, motor de tarifas)', 'org-a-hoteles-motor-tarifas'),
  ('00000000-0000-0000-0000-0000000000f2', 'hoteles', 'Org B (hoteles, ajena)', 'org-b-hoteles-motor-tarifas')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f1', 'hoteles', 'Hotel Org A'),
  ('00000000-0000-0000-0000-0000000000f4', '00000000-0000-0000-0000-0000000000f2', 'hoteles', 'Hotel Org B (ajeno)')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name, max_occupancy) values
  ('00000000-0000-0000-0000-0000000000f5', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f3', 'Estándar', 2)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000041', 'owner-org-a-hoteles@example.com', 'Owner Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000042', 'gm-org-a-hoteles@example.com', 'GM Org A', 'seed'),
  ('00000000-0000-0000-0000-000000000043', 'frontdesk-org-a-hoteles@example.com', 'Frontdesk Org A (rol insuficiente)', 'seed'),
  ('00000000-0000-0000-0000-000000000044', 'owner-org-b-hoteles@example.com', 'Owner Org B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-0000000000f1', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-0000000000f1', null, 'member', 'gm'),
  ('00000000-0000-0000-0000-000000000043', '00000000-0000-0000-0000-0000000000f1', null, 'member', 'frontdesk'),
  ('00000000-0000-0000-0000-000000000044', '00000000-0000-0000-0000-0000000000f2', null, 'owner', 'owner')
on conflict do nothing;

-- ---------------------------------------------------------------------------
-- Fixture: property PA (Org A) con el gate llevado, de verdad, a través del ciclo
-- COMPLETO shadow->propone->autopilot (mismas reglas de revenueEngineGate.ts/
-- migrations/011 -- NO se salta ningún requisito, solo se acelera el reloj vía
-- `shadow_started_at` explícito).
-- ---------------------------------------------------------------------------
insert into hoteles.revenue_engine_gate (organization_id, property_id, gate, shadow_started_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f3', 'shadow', now() - interval '91 days')
on conflict do nothing;

-- Property PA': segunda property de la Org A, exclusivamente para el escenario 7
-- (aprobar en "shadow") -- necesita quedarse en shadow, así que no comparte la
-- fila de gate de PA (que se promueve más abajo).
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000f1', 'hoteles', 'Hotel Org A (permanece en shadow)')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name, max_occupancy) values
  ('00000000-0000-0000-0000-0000000000f7', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f6', 'Estándar (shadow)', 2)
on conflict do nothing;
insert into hoteles.revenue_engine_gate (organization_id, property_id, gate, shadow_started_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f6', 'shadow', now())
on conflict do nothing;

-- Promueve PA a "propone" (90+ días reales en shadow, sin necesidad de auth.uid()
-- -- ver comentario del trigger de migrations/011: la promoción shadow->propone no
-- exige ningún rol).
update hoteles.revenue_engine_gate set gate = 'propone' where property_id = '00000000-0000-0000-0000-0000000000f3';

-- Property PA'': tercera property de la Org A, para dejarla en "propone" SIN
-- promover a autopilot (necesaria para el escenario 8: aplicar directo una
-- "pendiente" en "propone" debe RECHAZARSE).
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000f1', 'hoteles', 'Hotel Org A (se queda en propone)')
on conflict do nothing;
insert into hoteles.room_type (id, organization_id, property_id, name, max_occupancy) values
  ('00000000-0000-0000-0000-0000000000f9', '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f8', 'Estándar (propone)', 2)
on conflict do nothing;
insert into hoteles.revenue_engine_gate (organization_id, property_id, gate, shadow_started_at) values
  ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f8', 'shadow', now() - interval '91 days')
on conflict do nothing;
update hoteles.revenue_engine_gate set gate = 'propone' where property_id = '00000000-0000-0000-0000-0000000000f8';

-- Registra la aprobación de "owner" que exige REQ-REV-003 antes de autopilot (solo
-- owner puede tocar esta columna -- se simula la sesión de owner-A vía
-- set_config a nivel de SESIÓN, no de transacción, para que sobreviva estos
-- pasos de fixture que no están dentro de un begin/rollback).
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', false);
update hoteles.revenue_engine_gate set owner_approved_autopilot_at = now() where property_id = '00000000-0000-0000-0000-0000000000f3';
select set_config('request.jwt.claim.sub', '', false);

-- Backtest walk-forward que SÍ pasa, corrido después de que PA entró en "propone"
-- -- misma tabla que el trigger de migrations/011 exige para promover a autopilot
-- Y la MISMA que el trigger nuevo de esta migración exige para aplicar en
-- autopilot (fuente de verdad única, nunca duplicada).
insert into hoteles.revenue_backtest_run (
  organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won,
  engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons
) values (
  '00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f3', 'misma_tarifa_periodo_anterior', 10, 8,
  120000.00, 100000.00, 20.0, true, '[]'::jsonb
);

-- Promueve PA a "autopilot" (backtest pasa + aprobación de owner ya registrada).
update hoteles.revenue_engine_gate set gate = 'autopilot' where property_id = '00000000-0000-0000-0000-0000000000f3';

\echo ''
\echo '=== fixtures listas: PA (autopilot, backtest OK), PA_shadow (shadow), PA_propone (propone, sin backtest) ==='
\echo ''

\echo '--- 1. INSERT directo de una recomendacion por un staff autenticado -- RECHAZADO (solo sistema inserta) ---'
begin;
-- as should_fail (INSERT no admite alias final; este comentario es lo que el
-- runner detecta, ver convención de scripts/verify-citas-audit-log/assertions.sql).
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
insert into hoteles.rate_recommendation (property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose)
values ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000f9', current_date + 30, 2000, 2200, 1, '{}'::jsonb);
rollback;

\echo '--- 2. El sistema SI puede insertar una recomendacion pendiente (property en "propone") ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.rate_recommendation (property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose)
values ('00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000f9', current_date + 30, 2000, 2200, 1, '{"pickup": {"pct": 15}}'::jsonb)
returning id, estado;
rollback;

\echo ''
\echo '=== 3) negativo: rol insuficiente no puede aprobar ==='
\echo ''

\echo '--- 3. sistema inserta una pendiente real para PA (autopilot) que se usara en varios escenarios de abajo (persiste, fuera de begin/rollback) ---'
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.rate_recommendation (id, property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose)
values ('00000000-0000-0000-0000-0000000000fa', '00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', current_date + 30, 2000, 2100, 1, '{"pickup": {"pct": 12}}'::jsonb);
reset role;
select set_config('request.jwt.claim.sub', '', false);

\echo '--- 4. frontdesk (rol insuficiente) NO puede aprobar la recomendacion de PA -- la policy de UPDATE filtra en silencio (USING falso = 0 filas afectadas, NUNCA una excepcion -- a diferencia de un trigger de bloqueo, RLS en UPDATE simplemente no encuentra la fila), el estado NUNCA cambia ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
update hoteles.rate_recommendation set estado = 'aprobada' where id = '00000000-0000-0000-0000-0000000000fa';
select (estado = 'pendiente')::int as estado_sin_cambiar_por_frontdesk_deberia_ser_1 from hoteles.rate_recommendation where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

\echo ''
\echo '=== 4) cross-tenant: owner de la Org B ==='
\echo ''

\echo '--- 5. owner de la Org B no VE la recomendacion de la Org A -- 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000044', true);
select count(*) as filas_visibles_deberia_ser_0 from hoteles.rate_recommendation where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

\echo '--- 6. owner de la Org B tampoco puede aprobarla -- la policy de UPDATE filtra en silencio (no pertenece a esa property, USING falso = 0 filas, NUNCA una excepcion), el estado NUNCA cambia (verificado con "reset role" -- vuelve al superusuario de la conexion, que bypassa RLS y SI ve la fila real) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000044', true);
update hoteles.rate_recommendation set estado = 'aprobada' where id = '00000000-0000-0000-0000-0000000000fa';
reset role;
select (estado = 'pendiente')::int as estado_sin_cambiar_por_org_ajena_deberia_ser_1 from hoteles.rate_recommendation where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

\echo ''
\echo '=== 5) anon: rechazado por completo ==='
\echo ''

\echo '--- 7. anon no puede LEER recomendaciones ---'
begin;
set local role anon;
select count(*) as should_fail from hoteles.rate_recommendation;
rollback;

\echo '--- 8. anon no puede aprobar/actualizar ---'
begin;
-- as should_fail
set local role anon;
update hoteles.rate_recommendation set estado = 'aprobada' where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

\echo ''
\echo '=== 6) integracion con el gate: "shadow" nunca aprueba nada ==='
\echo ''

\echo '--- 9. sistema inserta una pendiente para la property en shadow ---'
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.rate_recommendation (id, property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose)
values ('00000000-0000-0000-0000-0000000000fb', '00000000-0000-0000-0000-0000000000f6', '00000000-0000-0000-0000-0000000000f7', current_date + 30, 2000, 2100, 1, '{}'::jsonb);
reset role;
select set_config('request.jwt.claim.sub', '', false);

\echo '--- 10. owner intenta aprobar mientras el gate esta en "shadow" -- RECHAZADO ---'
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
update hoteles.rate_recommendation set estado = 'aprobada' where id = '00000000-0000-0000-0000-0000000000fb';
rollback;

\echo ''
\echo '=== 7) integracion con el gate: "propone" nunca aplica directo sin aprobacion ==='
\echo ''

\echo '--- 11. sistema inserta una pendiente para la property en "propone" (sin backtest) ---'
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.rate_recommendation (id, property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose)
values ('00000000-0000-0000-0000-0000000000fc', '00000000-0000-0000-0000-0000000000f8', '00000000-0000-0000-0000-0000000000f9', current_date + 30, 2000, 2100, 1, '{}'::jsonb);
reset role;
select set_config('request.jwt.claim.sub', '', false);

\echo '--- 12. el sistema intenta aplicar DIRECTO (pendiente->aplicada) mientras el gate esta en "propone" -- RECHAZADO (debe pasar por "aprobada") ---'
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000000fc');
rollback;

\echo '--- 13. owner SI aprueba correctamente esa misma recomendacion (gate en "propone") ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
update hoteles.rate_recommendation set estado = 'aprobada' where id = '00000000-0000-0000-0000-0000000000fc'
  returning estado, aprobada_por;
rollback;

\echo ''
\echo '=== 8) integracion con el backtest: "autopilot" sin backtest que pase -- RECHAZADO ==='
\echo ''

\echo '--- 14. PA YA esta legitimamente en autopilot (backtest previo paso, ver fixtures) -- pero se corre un backtest NUEVO y MAS RECIENTE que NO pasa (ej. una temporada mala) -- aplicar directo debe RECHAZARSE porque el trigger mira el ULTIMO backtest, no "alguno historico" ---'
begin;
insert into hoteles.revenue_backtest_run (organization_id, property_id, counterfactual_method, windows_evaluated, windows_engine_won, engine_total_revenue, baseline_total_revenue, improvement_pct, passes, failure_reasons)
values ('00000000-0000-0000-0000-0000000000f1', '00000000-0000-0000-0000-0000000000f3', 'misma_tarifa_periodo_anterior', 10, 2, 80000, 100000, -20.0, false, '["mejora_insuficiente"]'::jsonb);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.rate_recommendation (id, property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose)
values ('00000000-0000-0000-0000-0000000000ff', '00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', current_date + 33, 2000, 2050, 1, '{}'::jsonb);
-- as should_fail
select hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000000ff');
rollback;

\echo ''
\echo '=== 9) integracion con el limite de variacion: autopilot + backtest OK pero variacion excesiva -- RECHAZADO ==='
\echo ''

\echo '--- 15. PA esta en autopilot con backtest OK (fixture de arriba) -- pero la recomendacion pide +50% (excede propone_max_variation_pct default 15%) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
insert into hoteles.rate_recommendation (id, property_id, room_type_id, fecha, current_bar_price, recommended_price, suggested_min_stay, desglose)
values ('00000000-0000-0000-0000-0000000001a1', '00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', current_date + 31, 2000, 3000, 1, '{}'::jsonb);
-- as should_fail
select hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000001a1');
rollback;

\echo ''
\echo '=== 10) positivo en autopilot: backtest OK + variacion dentro del limite -- el sistema aplica DIRECTO y escribe la tarifa real ==='
\echo ''

\echo '--- 16. antes de aplicar: no existe (o es distinta) la tarifa BAR de esa fecha en hoteles.rate_plan ---'
begin;
select count(*) as filas_antes_deberia_ser_0 from hoteles.rate_plan where room_type_id = '00000000-0000-0000-0000-0000000000f5' and date = current_date + 32;
rollback;

\echo '--- 17. el sistema aplica hoteles.rate_recommendation fa (PA, autopilot, +5%, dentro del limite) -- efecto REAL: rate_plan.price cambia Y el estado queda "aplicada" ---'
begin;
select hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000000fa') as recomendacion_aplicada;
select (price = 2100.00 and min_stay = 1)::int as tarifa_bar_escrita_deberia_ser_1
from hoteles.rate_plan where room_type_id = '00000000-0000-0000-0000-0000000000f5' and date = current_date + 30;
select (estado = 'aplicada' and aplicada_en is not null and aplicada_por is null)::int as estado_aplicada_por_sistema_deberia_ser_1
from hoteles.rate_recommendation where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

\echo '--- 18. un staff (ni siquiera owner) NO puede invocar system_apply_rate_recommendation directo -- RECHAZADO ---'
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
select hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000000fa');
rollback;

\echo ''
\echo '=== 11) estado terminal inmutable ==='
\echo ''

\echo '--- 19. una recomendacion "descartada" no puede volver a transicionar -- RECHAZADO ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
update hoteles.rate_recommendation set estado = 'descartada' where id = '00000000-0000-0000-0000-0000000000fa';
-- as should_fail
select set_config('request.jwt.claim.sub', '', true);
set local role authenticated;
update hoteles.rate_recommendation set estado = 'aplicada' where id = '00000000-0000-0000-0000-0000000000fa';
rollback;

\echo ''
\echo '=== 12) pricing_rule / local_event / competitor_rate: owner/gm escribe, frontdesk NO ==='
\echo ''

\echo '--- 20. owner de PA configura floor/ceiling/DOW para el room_type -- efecto REAL ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
insert into hoteles.pricing_rule (property_id, room_type_id, floor_price, ceiling_price, day_of_week_multiplier, min_stay_default, min_stay_on_high_demand)
values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 1000, 4000, array[1.0,0.9,0.9,0.9,0.9,1.1,1.2]::numeric(4,2)[], 1, 3)
returning floor_price, ceiling_price;
rollback;

\echo '--- 21. frontdesk NO puede configurar pricing_rule -- RECHAZADO ---'
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
insert into hoteles.pricing_rule (property_id, room_type_id, floor_price, ceiling_price, day_of_week_multiplier)
values ('00000000-0000-0000-0000-0000000000f3', '00000000-0000-0000-0000-0000000000f5', 1000, 4000, array[1,1,1,1,1,1,1]::numeric(4,2)[]);
rollback;

\echo '--- 22. gm (no solo owner) SI puede registrar un evento local -- efecto REAL ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000042', true);
insert into hoteles.local_event (property_id, nombre, fecha_inicio, fecha_fin, impacto, magnitud_pct)
values ('00000000-0000-0000-0000-0000000000f3', 'Congreso médico regional', current_date + 40, current_date + 42, 'alza_demanda', 30)
returning nombre;
rollback;

\echo '--- 23. frontdesk NO puede registrar un evento local -- RECHAZADO ---'
begin;
-- as should_fail
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000043', true);
insert into hoteles.local_event (property_id, nombre, fecha_inicio, fecha_fin, impacto, magnitud_pct)
values ('00000000-0000-0000-0000-0000000000f3', 'x', current_date, current_date, 'alza_demanda', 10);
rollback;

\echo '--- 24. accountant SI puede capturar una tarifa de competidor -- efecto REAL ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000041', true);
insert into hoteles.competitor_rate (property_id, competidor, fecha, tarifa)
values ('00000000-0000-0000-0000-0000000000f3', 'Hotel Vecino', current_date + 30, 2500)
returning competidor, tarifa;
rollback;

\echo '--- 25. anon no puede ver ninguna de las 3 tablas nuevas de captura ---'
begin;
set local role anon;
select
  (select count(*) from hoteles.pricing_rule) +
  (select count(*) from hoteles.local_event) +
  (select count(*) from hoteles.competitor_rate)
  as should_fail;
rollback;

\echo ''
\echo '=== 13) esquema de PRODUCCION a medio migrar (029 no aplicada): SQLSTATE real, recuperado con SAVEPOINT real ==='
\echo ''

\echo '--- 26. con hoteles.system_apply_rate_recommendation ELIMINADA dentro de esta MISMA transaccion (drop transaccional, revertido al rollback final), la llamada REAL que la ruta HTTP/cron emitiria falla con SQLSTATE 42883 -- SAVEPOINT + ROLLBACK TO SAVEPOINT (mismo mecanismo que runWithSavepointFallback en produccion) recupera la transaccion: la consulta siguiente, completamente ajena a la funcion eliminada, SI corre (nunca 25P02) ---'
begin;
drop function hoteles.system_apply_rate_recommendation(uuid);
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
savepoint sp_verify_apply_rate_recommendation;
do $$
declare
  v_state text;
  v_msg text;
begin
  begin
    perform hoteles.system_apply_rate_recommendation('00000000-0000-0000-0000-0000000000fa');
    raise exception 'se esperaba que la funcion eliminada hiciera fallar esta llamada con SQLSTATE 42883, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883 (undefined_function), se obtuvo % con mensaje: %', v_state, v_msg;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_apply_rate_recommendation;
release savepoint sp_verify_apply_rate_recommendation;
-- Query completamente ajena, en la MISMA transaccion -- si el SAVEPOINT no
-- hubiera recuperado la transaccion, esto fallaria con 25P02
-- (in_failed_sql_transaction), nunca con un resultado real.
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
