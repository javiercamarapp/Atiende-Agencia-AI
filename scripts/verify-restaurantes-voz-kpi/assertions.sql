-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna + auth.uid() reales, nunca el repositorio en
-- memoria) de packages/domain-restaurantes/migrations/035_voz_kpi_alertas_costo.sql: KPI de voz por dia local,
-- costo en centavos MXN, umbrales y alertas internas, y el registro de eventos del servicio de voz.
--
--   A. voz_kpis_diarios: agregados correctos, llamada que cruza la medianoche (cuenta un solo dia), llamada justo
--      en la medianoche local, dia sin datos, zona horaria de la sucursal, preview excluido, costo en centavos con
--      tipo de cambio (y NULL sin tipo de cambio), telefonia de OTRA sucursal/organizacion y categoria 'voz' no
--      se suman, LLM solo con alcance de toda la organizacion.
--   B. Autorizacion de las lecturas: rol insuficiente, sucursal fuera de alcance, otro tenant, anon, sesion de
--      sistema, rango invalido.
--   C. voice_alert_config: owner/admin con alcance, GRANT por columna, firma de updated_by, cross-tenant.
--   D. voz_evaluar_alertas: dispara por costo y por tasa de error, idempotente, deja UNA fila en la bitacora, sin
--      configuracion no hace nada, autorizacion.
--   E. voz_registrar_evento (solo sistema) y tablas sin DML directo para authenticated/anon.
--   F. base SIN migrar: la funcion eliminada da 42883 y un bloque con subtransaccion (el mismo mecanismo que
--      SAVEPOINT) recupera la transaccion.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el
-- que debe terminar en ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

-- Ayudante de pruebas: ejecuta una sentencia y exige el SQLSTATE exacto (como invoker, sin cambiar de rol).
create or replace function public.t_esperar_error(p_sql text, p_estado text) returns void
language plpgsql as $$
declare
  v text;
begin
  begin
    execute p_sql;
  exception when others then
    get stacked diagnostics v = returned_sqlstate;
    if v <> p_estado then
      raise exception 'se esperaba SQLSTATE %, se obtuvo % (%)', p_estado, v, sqlerrm;
    end if;
    return;
  end;
  raise exception 'se esperaba SQLSTATE % y la sentencia no fallo', p_estado;
end $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e1301', 'restaurantes', 'Voz KPI Org A', 'voz-kpi-a'),
  ('00000000-0000-0000-0000-0000000e1302', 'restaurantes', 'Voz KPI Org B (ajena)', 'voz-kpi-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e13a1', '00000000-0000-0000-0000-0000000e1301', 'Sucursal A1 (Mexico)'),
  ('00000000-0000-0000-0000-0000000e13a2', '00000000-0000-0000-0000-0000000e1301', 'Sucursal A2 (Auckland)'),
  ('00000000-0000-0000-0000-0000000e13a3', '00000000-0000-0000-0000-0000000e1301', 'Sucursal A3 (zona invalida)'),
  ('00000000-0000-0000-0000-0000000e13a4', '00000000-0000-0000-0000-0000000e1301', 'Sucursal A4 (alertas de hoy)'),
  ('00000000-0000-0000-0000-0000000e13b1', '00000000-0000-0000-0000-0000000e1302', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e13a1', '00000000-0000-0000-0000-0000000e1301', 'a1', null),
  ('00000000-0000-0000-0000-0000000e13a2', '00000000-0000-0000-0000-0000000e1301', 'a2', 'Pacific/Auckland'),
  ('00000000-0000-0000-0000-0000000e13a3', '00000000-0000-0000-0000-0000000e1301', 'a3', 'Marte/Fobos'),
  ('00000000-0000-0000-0000-0000000e13a4', '00000000-0000-0000-0000-0000000e1301', 'a4', null),
  ('00000000-0000-0000-0000-0000000e13b1', '00000000-0000-0000-0000-0000000e1302', 'b1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e1311', 'owner-a@vozkpi.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e1312', 'admin-a1@vozkpi.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e1313', 'staff-a@vozkpi.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e1314', 'owner-b@vozkpi.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e1311', '00000000-0000-0000-0000-0000000e1301', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e1312', '00000000-0000-0000-0000-0000000e1301', array['00000000-0000-0000-0000-0000000e13a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e1313', '00000000-0000-0000-0000-0000000e1301', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e1314', '00000000-0000-0000-0000-0000000e1302', null, 'owner', 'owner')
on conflict do nothing;

-- Mexico no tiene horario de verano desde 2022: America/Mexico_City es UTC-6 todo marzo de 2026.
-- Dia local 2026-03-10 = 2026-03-10 06:00Z .. 2026-03-11 06:00Z.
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, voice_id, started_at, ended_at, duration_s, costo_estimado_micro_usd, resultado) values
  -- c1: empieza 23:50 local del dia 10 y termina el dia 11 (cruza la medianoche): cuenta SOLO el dia 10.
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'kpi-c1', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-11 05:50:00+00', '2026-03-11 06:10:00+00', 1200, 1000000, 'pedido_creado'),
  ('00000000-0000-0000-0000-0000000e13c1', '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'kpi-c2', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-10 18:00:00+00', '2026-03-10 18:01:00+00', 60, 500000, 'escalado'),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'kpi-c3', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-10 20:00:00+00', '2026-03-10 20:00:30+00', 30, 0, 'abandonado'),
  -- c4: sin resultado = en curso: cuenta como llamada, no como cerrada.
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'kpi-c4', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-10 21:00:00+00', null, null, 0, null),
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'kpi-c5', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-11 07:00:00+00', '2026-03-11 07:01:30+00', 90, 200000, 'pedido_creado'),
  -- c6: preview del panel (no es trafico real): excluido de todo.
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'kpi-c6', 'preview', 'gemini-3.8-live', 'Puck', '2026-03-10 19:00:00+00', '2026-03-10 19:10:00+00', 600, 9000000, 'abandonado'),
  -- c7: exactamente 00:00 local del dia 11: pertenece al dia 11.
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'kpi-c7', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-11 06:00:00+00', '2026-03-11 06:00:10+00', 10, 0, 'abandonado'),
  -- A2 (Auckland, UTC+13 en marzo): 2026-03-10 12:00Z = 2026-03-11 01:00 local.
  ('00000000-0000-0000-0000-0000000e13c2', '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a2', 'kpi-a2-1', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-10 12:00:00+00', '2026-03-10 12:02:00+00', 120, 100000, 'pedido_creado'),
  -- B1 (otra organizacion).
  (gen_random_uuid(), '00000000-0000-0000-0000-0000000e1302', '00000000-0000-0000-0000-0000000e13b1', 'kpi-b1-1', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-10 18:00:00+00', '2026-03-10 18:05:00+00', 300, 777000, 'pedido_creado');

-- Eventos de A1, dia local 10: 20 llamadas a herramienta de 50..1000 ms (p95 = 950), 4 errores de proveedor.
insert into restaurantes.voice_event (organization_id, property_id, tipo, herramienta, latencia_ms, ocurrido_at)
  select '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'tool_call', 'cotizar_pedido', 50 * g, timestamptz '2026-03-10 18:00:10+00' + g * interval '1 second'
  from generate_series(1, 20) g;
insert into restaurantes.voice_event (organization_id, property_id, tipo, proveedor, codigo, ocurrido_at) values
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'error_proveedor', 'elevenlabs', '429', '2026-03-10 18:10:00+00'),
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'error_proveedor', 'elevenlabs', '500', '2026-03-10 18:11:00+00'),
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'error_proveedor', 'twilio', '31005', '2026-03-10 18:12:00+00'),
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'error_proveedor', 'gemini', '503', '2026-03-10 18:13:00+00'),
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'error_proveedor', 'twilio', '31005', '2026-03-11 08:00:00+00');

-- Tipo de cambio desde 2026-03-01 (20 MXN por USD). Antes de esa fecha NO hay tipo de cambio.
insert into core.fx_rate (fecha, mxn_por_usd, fuente) values ('2026-03-01', 20.0000, 'fixture de prueba');

-- Telefonia: A1 dia 10 = 500000; la categoria 'voz' NO se suma; la de A2 y la de B1 son de otra sucursal/organizacion.
insert into core.usage_cost_event (organization_id, property_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'restaurantes', '2026-03-10 19:00:00+00', 'telefonia', 'twilio', 'minuto', 5, 500000, 'llamada', 'kpi-tel-1'),
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'restaurantes', '2026-03-10 19:00:00+00', 'voz', 'gemini', 'minuto', 5, 9000000, 'llamada', 'kpi-voz-1'),
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a2', 'restaurantes', '2026-03-10 19:00:00+00', 'telefonia', 'twilio', 'minuto', 5, 7000000, 'llamada', 'kpi-tel-a2'),
  ('00000000-0000-0000-0000-0000000e1302', '00000000-0000-0000-0000-0000000e13b1', 'restaurantes', '2026-03-10 19:00:00+00', 'telefonia', 'twilio', 'minuto', 5, 6000000, 'llamada', 'kpi-tel-b1');

-- LLM de la organizacion A, dia 10: 3 USD = 6000 centavos.
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-0000000e1301', '2026-03-10', 'restaurantes', 'agente', 'prueba', 'modelo-x', 'interactive', 3000000, 10);

-- Umbrales: A1 (costo 3000 centavos, tasa 40%, minimo 3 llamadas) y A4 (costo 8000 centavos, tasa 40%, minimo 5).
insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error) values
  ('00000000-0000-0000-0000-0000000e13a1', '00000000-0000-0000-0000-0000000e1301', 3000, 40, 3),
  ('00000000-0000-0000-0000-0000000e13a4', '00000000-0000-0000-0000-0000000e1301', 8000, 40, 5);

-- A4: HOY (dia local de Mexico_City): 6 llamadas, 5 USD de voz = 10000 centavos >= 8000, y 3 errores = 50% >= 40%.
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, voice_id, started_at, costo_estimado_micro_usd, resultado)
  select '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4', 'kpi-a4-' || g, 'llamada', 'gemini-3.8-live', 'Puck', now(), case when g = 1 then 5000000 else 0 end, 'pedido_creado'
  from generate_series(1, 6) g;
insert into restaurantes.voice_event (organization_id, property_id, tipo, proveedor, codigo, ocurrido_at)
  select '00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4', 'error_proveedor', 'twilio', '31005', now()
  from generate_series(1, 3);

-- Una alerta ya registrada de A1 (para probar lectura cross-tenant).
insert into restaurantes.voice_alert (organization_id, property_id, fecha, tipo, valor, umbral) values
  ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', '2026-03-10', 'costo_dia', 4000, 3000);

\echo '=== A1. POSITIVO: owner de A, dia 10: llamadas (c1 cruza la medianoche y cuenta aqui; preview excluido) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select llamadas as llamadas_dia10_deberia_ser_4 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A2. POSITIVO: llamadas cerradas dia 10 (la llamada en curso no cuenta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select llamadas_cerradas as cerradas_dia10_deberia_ser_3 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A3. POSITIVO: duracion total dia 10 = 1200 + 60 + 30 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select duracion_total_s as duracion_dia10_deberia_ser_1290 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A4. POSITIVO: pedidos creados por voz dia 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select pedidos_voz as pedidos_dia10_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A5. POSITIVO: handoff a humano (escaladas) dia 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select escaladas as escaladas_dia10_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A6. POSITIVO: errores de proveedor dia 10 (2 elevenlabs + 1 twilio + 1 gemini) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select errores_proveedor as errores_dia10_deberia_ser_4 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A7. POSITIVO: errores de ElevenLabs dia 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select errores_elevenlabs as err_el_deberia_ser_2 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A8. POSITIVO: errores de otros proveedores (gemini) dia 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select errores_otros as err_otros_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A9. POSITIVO: p95 de latencia de herramientas dia 10 (20 muestras de 50 a 1000 ms) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select tool_p95_ms as p95_deberia_ser_950 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A10. POSITIVO: costo de voz dia 10 en micro-USD (el preview de 9 USD no cuenta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select costo_voz_micro_usd as costo_voz_deberia_ser_1500000 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A11. POSITIVO: telefonia dia 10 = solo la de A1 (la categoria voz, A2 y B1 no se suman) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select costo_telefonia_micro_usd as telefonia_deberia_ser_500000 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A12. POSITIVO: costo total del dia 10 en centavos MXN = (1.5 + 0.5) USD * 20 * 100 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select costo_total_centavos_mxn as costo_total_deberia_ser_4000 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A13. BORDE medianoche: dia 11 = c5 + c7 (c1 NO se cuenta dos veces; c7 justo a las 00:00 local si) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select llamadas as llamadas_dia11_deberia_ser_2 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-11';
rollback;

\echo '=== A14. BORDE medianoche: duracion del dia 11 = 90 + 10 (los 1200 s de c1 siguen en el dia 10) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select duracion_total_s as duracion_dia11_deberia_ser_100 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-11';
rollback;

\echo '=== A15. BORDE sin datos: un dia sin llamadas devuelve fila con 0, no la omite ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) as filas_rango_deberia_ser_3 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-09', date '2026-03-11');
rollback;

\echo '=== A16. BORDE sin datos: llamadas del dia vacio = 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select llamadas as llamadas_dia9_deberia_ser_0 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-09', date '2026-03-11') where fecha = date '2026-03-09';
rollback;

\echo '=== A17. BORDE sin datos: p95 sin muestras es NULL (no 0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select (tool_p95_ms is null)::int as p95_vacio_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-09', date '2026-03-11') where fecha = date '2026-03-09';
rollback;

\echo '=== A18. BORDE sin tipo de cambio: antes de la primera tasa los centavos son NULL (no 0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select (costo_total_centavos_mxn is null)::int as sin_fx_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-02-20', date '2026-02-20');
rollback;

\echo '=== A19. ZONA HORARIA: A2 (Auckland) ve la llamada de 12:00Z en el dia local 11 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select llamadas as llamadas_a2_dia11_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a2', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-11';
rollback;

\echo '=== A20. ZONA HORARIA: ...y el dia local 10 de A2 queda vacio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select llamadas as llamadas_a2_dia10_deberia_ser_0 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a2', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A21. ZONA HORARIA: una zona invalida cae a America/Mexico_City ==='
begin;
select (restaurantes.voz_zona_horaria('00000000-0000-0000-0000-0000000e13a3') = 'America/Mexico_City')::int as zona_invalida_deberia_ser_1;
rollback;

\echo '=== A22. LLM de la organizacion: el owner con alcance total lo ve en centavos (3 USD * 20 * 100) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select costo_llm_org_centavos_mxn as llm_deberia_ser_6000 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A23. LLM de la organizacion: el admin acotado a A1 NO lo ve (NULL) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1312', true);
select (costo_llm_org_micro_usd is null)::int as llm_oculto_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A24. POSITIVO: el admin acotado a A1 si lee los KPI de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1312', true);
select llamadas as llamadas_admin_deberia_ser_4 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== B1. RECHAZADO: el admin acotado a A1 no lee A2 (fuera de alcance) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1312', true);
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a2', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B2. RECHAZADO: el staff de piso no lee los KPI de voz -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1313', true);
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B3. RECHAZADO cross-tenant: el owner de B no lee los KPI de A1 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1314', true);
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B4. RECHAZADO cross-tenant: el owner de A no puede pedir la sucursal de B declarando su propia organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13b1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B5. RECHAZADO: anon no ejecuta voz_kpis_diarios -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B6. RECHAZADO: la sesion de sistema (sin usuario) no lee KPI de staff -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B7. RECHAZADO: rango de mas de 63 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-01-01', date '2026-03-11')$q$, '22023');
rollback;

\echo '=== B8. RECHAZADO: rango invertido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-11', date '2026-03-10')$q$, '22023');
rollback;

\echo '=== C1. POSITIVO: el owner de A ve su configuracion de umbrales (1 fila en A1 y A4) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) as umbrales_owner_deberia_ser_2 from restaurantes.voice_alert_config;
rollback;

\echo '=== C2. cross-tenant: el owner de B no ve ningun umbral de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1314', true);
select count(*) as umbrales_ajenos_deberia_ser_0 from restaurantes.voice_alert_config;
rollback;

\echo '=== C3. alcance: el admin acotado a A1 solo ve el umbral de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1312', true);
select count(*) as umbrales_admin_deberia_ser_1 from restaurantes.voice_alert_config;
rollback;

\echo '=== C4. el staff de piso no ve umbrales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1313', true);
select count(*) as umbrales_staff_deberia_ser_0 from restaurantes.voice_alert_config;
rollback;

\echo '=== C5. POSITIVO: el owner de A crea el umbral de A2 y actualiza el de A1 (upsert del repositorio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error, updated_by, updated_at)
  values ('00000000-0000-0000-0000-0000000e13a2', '00000000-0000-0000-0000-0000000e1301', 5000, 30, 4, '00000000-0000-0000-0000-0000000e1311', now())
  on conflict (property_id) do update set umbral_costo_dia_centavos_mxn = excluded.umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct = excluded.umbral_tasa_error_pct, min_llamadas_tasa_error = excluded.min_llamadas_tasa_error, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning property_id, umbral_costo_dia_centavos_mxn;
insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error, updated_by, updated_at)
  values ('00000000-0000-0000-0000-0000000e13a1', '00000000-0000-0000-0000-0000000e1301', 9999, null, 3, '00000000-0000-0000-0000-0000000e1311', now())
  on conflict (property_id) do update set umbral_costo_dia_centavos_mxn = excluded.umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct = excluded.umbral_tasa_error_pct, min_llamadas_tasa_error = excluded.min_llamadas_tasa_error, updated_by = excluded.updated_by, updated_at = excluded.updated_at
  returning property_id, umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct;
rollback;

\echo '=== C6. RECHAZADO: el admin acotado a A1 no crea umbral en A2 (fuera de alcance, RLS) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1312', true);
select public.t_esperar_error($q$insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn) values ('00000000-0000-0000-0000-0000000e13a2', '00000000-0000-0000-0000-0000000e1301', 100)$q$, '42501');
rollback;

\echo '=== C7. RECHAZADO: el staff de piso no crea umbrales -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1313', true);
select public.t_esperar_error($q$insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn) values ('00000000-0000-0000-0000-0000000e13a2', '00000000-0000-0000-0000-0000000e1301', 100)$q$, '42501');
rollback;

\echo '=== C8. RECHAZADO cross-tenant: el owner de A no crea un umbral para la sucursal de B -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn) values ('00000000-0000-0000-0000-0000000e13b1', '00000000-0000-0000-0000-0000000e1302', 100)$q$, '42501');
rollback;

\echo '=== C9. RECHAZADO: declarar la organizacion propia sobre una sucursal ajena tampoco pasa (RLS valida la pertenencia) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn) values ('00000000-0000-0000-0000-0000000e13b1', '00000000-0000-0000-0000-0000000e1301', 100)$q$, '42501');
rollback;

\echo '=== C10. RECHAZADO: updated_by firmado por otro usuario -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$update restaurantes.voice_alert_config set umbral_tasa_error_pct = 50, updated_by = '00000000-0000-0000-0000-0000000e1314' where property_id = '00000000-0000-0000-0000-0000000e13a1'$q$, '42501');
rollback;

\echo '=== C11. RECHAZADO: GRANT por columna, organization_id no se reescribe -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$update restaurantes.voice_alert_config set organization_id = '00000000-0000-0000-0000-0000000e1302' where property_id = '00000000-0000-0000-0000-0000000e13a1'$q$, '42501');
rollback;

\echo '=== C12. RECHAZADO: sin DELETE para authenticated -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$delete from restaurantes.voice_alert_config where property_id = '00000000-0000-0000-0000-0000000e13a1'$q$, '42501');
rollback;

\echo '=== C13. RECHAZADO: CHECK de la tasa (101%) -> 23514 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$update restaurantes.voice_alert_config set umbral_tasa_error_pct = 101 where property_id = '00000000-0000-0000-0000-0000000e13a1'$q$, '23514');
rollback;

\echo '=== C14. RECHAZADO: anon no lee umbrales -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.voice_alert_config$q$, '42501');
rollback;

\echo '=== D1. POSITIVO: evaluar alertas en A4 (hoy): dispara costo y tasa de error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) as alertas_deberia_ser_2 from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4');
rollback;

\echo '=== D2. IDEMPOTENTE: dos evaluaciones dejan UNA alerta por tipo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4');
select count(*) from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4');
select count(*) as alertas_a4_deberia_ser_2 from restaurantes.voice_alert where property_id = '00000000-0000-0000-0000-0000000e13a4';
rollback;

\echo '=== D3. BITACORA: la alerta de costo deja UNA fila de auditoria aunque se evalue dos veces ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4');
select count(*) from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4');
select count(*) as bitacora_costo_deberia_ser_1 from restaurantes.audit_log where action = 'voz.alerta_costo_dia' and entity_id = '00000000-0000-0000-0000-0000000e13a4';
rollback;

\echo '=== D4. BITACORA: la alerta de tasa de error tambien (actor = quien evalua) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4');
select count(*) as bitacora_tasa_deberia_ser_1 from restaurantes.audit_log where action = 'voz.alerta_tasa_error' and entity_id = '00000000-0000-0000-0000-0000000e13a4' and actor_user_id = '00000000-0000-0000-0000-0000000e1311';
rollback;

\echo '=== D5. SIN configuracion no hay alertas (A3 no tiene umbrales) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) as alertas_sin_config_deberia_ser_0 from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a3');
rollback;

\echo '=== D6. SIN trafico de hoy no hay alertas (A1 solo tiene datos de marzo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) as alertas_sin_trafico_deberia_ser_0 from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1');
rollback;

\echo '=== D7. RECHAZADO: el staff de piso no evalua alertas -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1313', true);
select public.t_esperar_error($q$select * from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4')$q$, '42501');
rollback;

\echo '=== D8. RECHAZADO: el admin acotado a A1 no evalua A4 (fuera de alcance) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1312', true);
select public.t_esperar_error($q$select * from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4')$q$, '42501');
rollback;

\echo '=== D9. RECHAZADO cross-tenant: el owner de B no evalua alertas de A -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1314', true);
select public.t_esperar_error($q$select * from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4')$q$, '42501');
rollback;

\echo '=== D10. RECHAZADO: anon y la sesion de sistema no evaluan alertas -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a4')$q$, '42501');
rollback;

\echo '=== D11. lectura de alertas: el owner de A ve la alerta ya registrada de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) as alertas_owner_deberia_ser_1 from restaurantes.voice_alert;
rollback;

\echo '=== D12. cross-tenant: el owner de B no ve alertas de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1314', true);
select count(*) as alertas_ajenas_deberia_ser_0 from restaurantes.voice_alert;
rollback;

\echo '=== D13. RECHAZADO: authenticated no inserta alertas directo (solo la funcion) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$insert into restaurantes.voice_alert (organization_id, property_id, fecha, tipo, valor, umbral) values ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', '2026-03-12', 'costo_dia', 1, 1)$q$, '42501');
rollback;

\echo '=== E1. POSITIVO: el servicio de voz (sesion de sistema) registra una llamada a herramienta ==='
begin;
set local role authenticated;
select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', null, 'tool_call', null, 'buscar_producto', 120, null, now()) is not null as should_succeed;
rollback;

\echo '=== E2. POSITIVO: registra un error de proveedor ligado a una conversacion de la misma sucursal ==='
begin;
set local role authenticated;
select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', '00000000-0000-0000-0000-0000000e13c1', 'error_proveedor', 'twilio', null, null, '31005', now()) is not null as should_succeed;
rollback;

\echo '=== E3. RECHAZADO: un staff autenticado no registra eventos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', null, 'tool_call', null, 'buscar_producto', 120, null, now())$q$, '42501');
rollback;

\echo '=== E4. RECHAZADO: la sucursal debe pertenecer a la organizacion declarada -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1302', '00000000-0000-0000-0000-0000000e13a1', null, 'tool_call', null, 'buscar_producto', 120, null, now())$q$, '42501');
rollback;

\echo '=== E5. RECHAZADO: la conversacion debe ser de esa sucursal (kpi-a2-1 es de A2) -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', '00000000-0000-0000-0000-0000000e13c2', 'tool_call', null, 'buscar_producto', 120, null, now())$q$, '42501');
rollback;

\echo '=== E6. RECHAZADO: tool_call sin herramienta ni latencia -> 23514 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', null, 'tool_call', null, null, null, null, now())$q$, '23514');
rollback;

\echo '=== E7. RECHAZADO: proveedor fuera del catalogo -> 23514 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', null, 'error_proveedor', 'otro-proveedor-x', null, null, '500', now())$q$, '23514');
rollback;

\echo '=== E8. RECHAZADO: authenticated no inserta eventos directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$insert into restaurantes.voice_event (organization_id, property_id, tipo, herramienta, latencia_ms) values ('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', 'tool_call', 'x', 1)$q$, '42501');
rollback;

\echo '=== E9. RECHAZADO: authenticated no borra ni edita eventos -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$delete from restaurantes.voice_event$q$, '42501');
rollback;

\echo '=== E10. RECHAZADO: anon no ejecuta voz_registrar_evento ni lee eventos -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', null, 'tool_call', null, 'buscar_producto', 120, null, now())$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.voice_event$q$, '42501');
rollback;

\echo '=== E11. lectura: el owner de A ve los eventos de A (25 de A1 + 3 de A4 = 28); el owner de B ninguno ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select count(*) as eventos_owner_deberia_ser_28 from restaurantes.voice_event;
rollback;

begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1314', true);
select count(*) as eventos_ajenos_deberia_ser_0 from restaurantes.voice_event;
rollback;

\echo '=== E12. RECHAZADO: el helper de zona horaria es interno (authenticated no lo ejecuta) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1311', true);
select public.t_esperar_error($q$select restaurantes.voz_zona_horaria('00000000-0000-0000-0000-0000000e13a1')$q$, '42501');
rollback;

\echo '=== F1. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.voz_kpis_diarios(uuid, uuid, date, date);
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e1301', '00000000-0000-0000-0000-0000000e13a1', date '2026-03-10', date '2026-03-11');
    raise exception 'se esperaba SQLSTATE 42883 y la llamada no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42883' then
      raise exception 'se esperaba SQLSTATE 42883, se obtuvo %', v_state;
    end if;
  end;
end $$;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
