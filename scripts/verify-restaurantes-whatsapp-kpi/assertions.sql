-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/040_whatsapp_kpis_diarios.sql: KPI del agente de WhatsApp por dia local.
--
--   A. whatsapp_kpis_diarios: conteos exactos (conversaciones, con pedido, con handoff, pedidos, handoffs), pedido
--      cancelado excluido, pedido de otro canal excluido, conversacion que cruza la medianoche, medianoche exacta,
--      conversacion sin sucursal, zona horaria de la sucursal, dia sin datos, trafico demo (telefono 0009) excluido,
--      costo LLM solo de los roles del agente de WhatsApp, centavos MXN con y sin tipo de cambio, costo LLM y pedidos de
--      la organizacion solo con alcance de toda la organizacion, organizacion demo sin costo.
--   B. Autorizacion: staff de piso, repartidor, sucursal fuera de alcance, otro tenant, anon, sesion de sistema, rango invalido.
--   C. base SIN migrar: la funcion eliminada da 42883 y un bloque con subtransaccion recupera la transaccion.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el
-- que debe terminar en ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado.
\set ON_ERROR_STOP off
\pset pager off

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
  ('00000000-0000-0000-0000-0000000e3101', 'restaurantes', 'WA KPI Org A', 'wa-kpi-a'),
  ('00000000-0000-0000-0000-0000000e3102', 'restaurantes', 'WA KPI Org B (ajena)', 'wa-kpi-b'),
  ('00000000-0000-0000-0000-0000000e3103', 'restaurantes', 'WA KPI Org Demo', 'wa-kpi-demo')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e31a1', '00000000-0000-0000-0000-0000000e3101', 'Sucursal A1 (Mexico)'),
  ('00000000-0000-0000-0000-0000000e31a2', '00000000-0000-0000-0000-0000000e3101', 'Sucursal A2 (Auckland)'),
  ('00000000-0000-0000-0000-0000000e31b1', '00000000-0000-0000-0000-0000000e3102', 'Sucursal B1'),
  ('00000000-0000-0000-0000-0000000e31d1', '00000000-0000-0000-0000-0000000e3103', 'Sucursal D1 (demo)')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e31a1', '00000000-0000-0000-0000-0000000e3101', 'a1', null),
  ('00000000-0000-0000-0000-0000000e31a2', '00000000-0000-0000-0000-0000000e3101', 'a2', 'Pacific/Auckland'),
  ('00000000-0000-0000-0000-0000000e31b1', '00000000-0000-0000-0000-0000000e3102', 'b1', null),
  ('00000000-0000-0000-0000-0000000e31d1', '00000000-0000-0000-0000-0000000e3103', 'd1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e3111', 'owner-a@wakpi.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e3112', 'admin-a1@wakpi.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e3113', 'staff-a@wakpi.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e3114', 'rep-a@wakpi.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e3115', 'owner-b@wakpi.example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-0000000e3116', 'owner-d@wakpi.example.com', 'Owner Demo', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e3111', '00000000-0000-0000-0000-0000000e3101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e3112', '00000000-0000-0000-0000-0000000e3101', array['00000000-0000-0000-0000-0000000e31a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e3113', '00000000-0000-0000-0000-0000000e3101', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e3114', '00000000-0000-0000-0000-0000000e3101', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e3115', '00000000-0000-0000-0000-0000000e3102', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e3116', '00000000-0000-0000-0000-0000000e3103', null, 'owner', 'owner')
on conflict do nothing;

-- Marca demo de la organizacion D (la escribe el operador con la conexion del propietario, nunca un request).
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000e3103', 'verify');

-- Mexico no tiene horario de verano desde 2022: America/Mexico_City es UTC-6 en marzo de 2026.
-- Dia local 2026-03-10 = 2026-03-10 06:00Z .. 2026-03-11 06:00Z.
-- Pedidos (id fijo para ligarlos a conversaciones).
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  -- o1: pedido de WhatsApp de la conversacion k1 (cuenta como pedido Y como conversacion con pedido).
  ('00000000-0000-0000-0000-0000000e3191', '00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'Cliente 1', '+52 5511111111', 100, 'pending', '[]', 'whatsapp', '2026-03-10 18:05:00+00'),
  -- o2: pedido de WhatsApp CANCELADO de la conversacion k2: no cuenta.
  ('00000000-0000-0000-0000-0000000e3192', '00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'Cliente 2', '+52 5522222222', 100, 'cancelado', '[]', 'whatsapp', '2026-03-10 18:35:00+00'),
  -- o3: pedido de WhatsApp de un cliente antiguo (sin conversacion nueva ese dia): cuenta como pedido, no como conversacion con pedido.
  ('00000000-0000-0000-0000-0000000e3193', '00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'Cliente Viejo', '+52 5599999999', 100, 'entregado', '[]', 'whatsapp', '2026-03-10 20:00:00+00'),
  -- o4: pedido de VOZ: otro canal, no cuenta.
  ('00000000-0000-0000-0000-0000000e3194', '00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'Cliente Voz', '+52 5588888888', 100, 'pending', '[]', 'voice', '2026-03-10 20:10:00+00'),
  -- o5: pedido del widget demo (telefono 0009): excluido.
  ('00000000-0000-0000-0000-0000000e3195', '00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'Visitante Demo', '+52 0009123456', 100, 'pending', '[]', 'whatsapp', '2026-03-10 20:20:00+00'),
  -- o6: pedido de WhatsApp de A2: pedidos_org lo cuenta, pedidos de A1 no.
  ('00000000-0000-0000-0000-0000000e3196', '00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a2', 'Cliente A2', '+52 5577777777', 100, 'pending', '[]', 'whatsapp', '2026-03-10 12:00:00+00'),
  -- o7: dia 11 local (justo 00:00): pedido de A1 del dia 11.
  ('00000000-0000-0000-0000-0000000e3197', '00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'Cliente 7', '+52 5566666666', 100, 'pending', '[]', 'whatsapp', '2026-03-11 06:00:00+00'),
  -- o8: pedido de la organizacion B (otro tenant).
  ('00000000-0000-0000-0000-0000000e3198', '00000000-0000-0000-0000-0000000e3102', '00000000-0000-0000-0000-0000000e31b1', 'Cliente B', '+52 5544440000', 100, 'pending', '[]', 'whatsapp', '2026-03-10 18:00:00+00'),
  -- o9: pedido real en la organizacion demo.
  ('00000000-0000-0000-0000-0000000e3199', '00000000-0000-0000-0000-0000000e3103', '00000000-0000-0000-0000-0000000e31d1', 'Cliente D', '+52 5533330000', 100, 'pending', '[]', 'whatsapp', '2026-03-10 18:00:00+00');

insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, status, order_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000e31c1', '00000000-0000-0000-0000-0000000e3101', '+52 5511111111', '00000000-0000-0000-0000-0000000e31a1', 'completed', '00000000-0000-0000-0000-0000000e3191', '2026-03-10 18:00:00+00', '2026-03-10 18:10:00+00'),
  ('00000000-0000-0000-0000-0000000e31c2', '00000000-0000-0000-0000-0000000e3101', '+52 5522222222', '00000000-0000-0000-0000-0000000e31a1', 'completed', '00000000-0000-0000-0000-0000000e3192', '2026-03-10 18:30:00+00', '2026-03-10 18:40:00+00'),
  ('00000000-0000-0000-0000-0000000e31c3', '00000000-0000-0000-0000-0000000e3101', '+52 5533333333', '00000000-0000-0000-0000-0000000e31a1', 'active', null, '2026-03-10 19:00:00+00', '2026-03-10 19:20:00+00'),
  -- k4: 23:50 local del dia 10 (cruza a UTC dia 11): cuenta en el dia 10.
  ('00000000-0000-0000-0000-0000000e31c4', '00000000-0000-0000-0000-0000000e3101', '+52 5544444444', '00000000-0000-0000-0000-0000000e31a1', 'active', null, '2026-03-11 05:50:00+00', '2026-03-11 05:55:00+00'),
  -- k5: sesion del widget demo (telefono 0009): excluida aunque tenga handoff y pedido.
  ('00000000-0000-0000-0000-0000000e31c5', '00000000-0000-0000-0000-0000000e3101', '+52 0009123456', '00000000-0000-0000-0000-0000000e31a1', 'completed', '00000000-0000-0000-0000-0000000e3195', '2026-03-10 20:15:00+00', '2026-03-10 20:25:00+00'),
  -- k6: exactamente 00:00 local del dia 11: pertenece al dia 11.
  ('00000000-0000-0000-0000-0000000e31c6', '00000000-0000-0000-0000-0000000e3101', '+52 5555555555', '00000000-0000-0000-0000-0000000e31a1', 'active', null, '2026-03-11 06:00:00+00', '2026-03-11 06:00:00+00'),
  -- k7: sin sucursal: no se atribuye a ninguna.
  ('00000000-0000-0000-0000-0000000e31c7', '00000000-0000-0000-0000-0000000e3101', '+52 5500000007', null, 'active', null, '2026-03-10 19:30:00+00', '2026-03-10 19:30:00+00'),
  -- k8: conversacion de A2 (Auckland, UTC+13): 2026-03-10 12:00Z = 2026-03-11 01:00 local.
  ('00000000-0000-0000-0000-0000000e31c8', '00000000-0000-0000-0000-0000000e3101', '+52 5577777777', '00000000-0000-0000-0000-0000000e31a2', 'completed', '00000000-0000-0000-0000-0000000e3196', '2026-03-10 12:00:00+00', '2026-03-10 12:30:00+00'),
  -- Otro tenant y organizacion demo.
  ('00000000-0000-0000-0000-0000000e31c9', '00000000-0000-0000-0000-0000000e3102', '+52 5544440000', '00000000-0000-0000-0000-0000000e31b1', 'completed', '00000000-0000-0000-0000-0000000e3198', '2026-03-10 18:00:00+00', '2026-03-10 18:10:00+00'),
  ('00000000-0000-0000-0000-0000000e31ca', '00000000-0000-0000-0000-0000000e3103', '+52 5533330000', '00000000-0000-0000-0000-0000000e31d1', 'completed', '00000000-0000-0000-0000-0000000e3199', '2026-03-10 18:00:00+00', '2026-03-10 18:10:00+00'),
  ('00000000-0000-0000-0000-0000000e31cb', '00000000-0000-0000-0000-0000000e3103', '+52 0009777777', '00000000-0000-0000-0000-0000000e31d1', 'active', null, '2026-03-10 18:30:00+00', '2026-03-10 18:35:00+00');

-- Handoffs de WhatsApp en A1: k3 pidio un humano el dia 10; k1 lo pidio el dia 11 (cuenta como handoff del dia 11 y hace
-- que k1 sea "conversacion con handoff" de la cohorte del dia 10); k5 (demo) pidio uno el dia 10: excluido.
insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, solicitada_at, cerrada_at) values
  ('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'whatsapp', '00000000-0000-0000-0000-0000000e31c3', 'pendiente', 'agente', '2026-03-10 19:10:00+00', null),
  ('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'whatsapp', '00000000-0000-0000-0000-0000000e31c1', 'cerrada', 'agente', '2026-03-11 08:00:00+00', '2026-03-11 08:30:00+00'),
  ('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', 'whatsapp', '00000000-0000-0000-0000-0000000e31c5', 'pendiente', 'agente', '2026-03-10 20:30:00+00', null);

-- Tipo de cambio desde 2026-03-01 (20 MXN por USD). Antes de esa fecha NO hay tipo de cambio.
insert into core.fx_rate (fecha, mxn_por_usd, fuente) values ('2026-03-01', 20.0000, 'fixture de prueba');

-- LLM de la organizacion A, dia 10: solo los dos roles del agente de WhatsApp suman (2 + 1 USD = 3 USD = 6000 centavos);
-- data_chat (5 USD) y un rol de plataforma (9 USD) NO suman. Dia 8 (antes del tipo de cambio): 1 USD, centavos NULL.
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, cost_micro_usd, call_count) values
  ('00000000-0000-0000-0000-0000000e3101', '2026-03-10', 'restaurantes', 'restaurantes:whatsapp_agent', 'prueba', 'modelo-x', 'interactive', 2000000, 10),
  ('00000000-0000-0000-0000-0000000e3101', '2026-03-10', 'restaurantes', 'restaurantes:whatsapp_agent_escalated', 'prueba', 'modelo-y', 'interactive', 1000000, 2),
  ('00000000-0000-0000-0000-0000000e3101', '2026-03-10', 'restaurantes', 'restaurantes:data_chat', 'prueba', 'modelo-x', 'interactive', 5000000, 3),
  ('00000000-0000-0000-0000-0000000e3101', '2026-03-10', 'plataforma', 'plataforma:enrutador_turno', 'prueba', 'modelo-x', 'interactive', 9000000, 3),
  ('00000000-0000-0000-0000-0000000e3101', '2026-02-28', 'restaurantes', 'restaurantes:whatsapp_agent', 'prueba', 'modelo-x', 'interactive', 1000000, 1),
  ('00000000-0000-0000-0000-0000000e3102', '2026-03-10', 'restaurantes', 'restaurantes:whatsapp_agent', 'prueba', 'modelo-x', 'interactive', 777000, 1),
  ('00000000-0000-0000-0000-0000000e3103', '2026-03-10', 'restaurantes', 'restaurantes:whatsapp_agent', 'prueba', 'modelo-x', 'interactive', 4000000, 1);

\echo '=== A1. conversaciones nuevas del dia 10 (k1,k2,k3,k4; demo, sin sucursal, otra sucursal y otro tenant fuera) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select conversaciones as conversaciones_deberia_ser_4 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A2. conversaciones con pedido: solo k1 (k2 tiene pedido cancelado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select conversaciones_con_pedido as con_pedido_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A3. conversaciones con handoff: k3 (dia 10) y k1 (handoff del dia 11); el demo k5 no ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select conversaciones_con_handoff as con_handoff_deberia_ser_2 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A4. pedidos de WhatsApp de A1 del dia 10: o1 y o3 (cancelado, voz, demo y A2 fuera) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select pedidos as pedidos_deberia_ser_2 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A5. handoffs solicitados el dia 10: solo el de k3 (k5 demo fuera, el de k1 es del dia 11) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select handoffs as handoffs_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A6. pedidos de la organizacion el dia 10 (A1+A2, sin cancelado/voz/demo/otro tenant) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select pedidos_org as pedidos_org_deberia_ser_3 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A7. dia 11 local: la conversacion k6 a las 00:00 exactas cuenta aqui ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select conversaciones as conv_dia11_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-11';
rollback;

\echo '=== A8. dia 11 local: el pedido de las 00:00 exactas cuenta aqui ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select pedidos as pedidos_dia11_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-11';
rollback;

\echo '=== A9. dia 11 local: el handoff de k1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select handoffs as handoffs_dia11_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-11';
rollback;

\echo '=== A10. costo LLM del dia 10 en micro-USD: solo los 2 roles del agente de WhatsApp (data_chat y plataforma no) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select costo_llm_org_micro_usd as costo_llm_deberia_ser_3000000 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A11. costo LLM del dia 10 en centavos MXN = 3 USD * 20 * 100 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select costo_llm_org_centavos_mxn as centavos_deberia_ser_6000 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A12. tipo de cambio aplicado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select mxn_por_usd::integer as fx_deberia_ser_20 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A13. costo LLM 2026-02-28 (antes de cualquier tipo de cambio): micro-USD si hay ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select costo_llm_org_micro_usd as costo_sin_fx_deberia_ser_1000000 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-02-28', date '2026-03-01') where fecha = date '2026-02-28';
rollback;

\echo '=== A14. sin tipo de cambio los centavos son NULL (nunca 0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select count(*) as centavos_sin_fx_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-02-28', date '2026-03-01') where fecha = date '2026-02-28' and costo_llm_org_centavos_mxn is null;
rollback;

\echo '=== A15. dia sin datos: fila en cero (el dia 12) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select conversaciones + pedidos + handoffs as dia_vacio_deberia_ser_0 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-12') where fecha = date '2026-03-12';
rollback;

\echo '=== A16. A2 (Auckland UTC+13): 2026-03-10 12:00Z es dia 11 local; el dia 10 queda vacio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select conversaciones as a2_dia10_deberia_ser_0 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a2', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A17. A2 (Auckland): la conversacion cuenta en el dia 11 local ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select conversaciones as a2_dia11_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a2', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-11';
rollback;

\echo '=== A18. admin acotado a A1: ve las conversaciones de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3112', true);
select conversaciones as admin_conv_deberia_ser_4 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A19. admin acotado a A1: el costo LLM de la organizacion NO se devuelve (NULL) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3112', true);
select count(*) as admin_sin_costo_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10' and costo_llm_org_micro_usd is null;
rollback;

\echo '=== A20. admin acotado a A1: los pedidos de la organizacion NO se devuelven (NULL) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3112', true);
select count(*) as admin_sin_pedidos_org_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10' and pedidos_org is null;
rollback;

\echo '=== A21. admin acotado a A1: sus pedidos de sucursal si ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3112', true);
select pedidos as admin_pedidos_deberia_ser_2 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A22. organizacion B (otro tenant) solo ve lo suyo: 1 conversacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3115', true);
select conversaciones as b_conv_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3102', '00000000-0000-0000-0000-0000000e31b1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A23. organizacion B: su costo LLM es el suyo (777000), no el de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3115', true);
select costo_llm_org_micro_usd as b_costo_deberia_ser_777000 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3102', '00000000-0000-0000-0000-0000000e31b1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A24. organizacion demo: el widget (0009) no cuenta, queda 1 conversacion real ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3116', true);
select conversaciones as demo_conv_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3103', '00000000-0000-0000-0000-0000000e31d1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A25. organizacion demo: el costo LLM mezcla widget y uso real, se devuelve NULL ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3116', true);
select count(*) as demo_sin_costo_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3103', '00000000-0000-0000-0000-0000000e31d1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10' and costo_llm_org_micro_usd is null;
rollback;

\echo '=== A26. organizacion demo: marcada como demo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3116', true);
select org_es_demo::integer as org_demo_deberia_ser_1 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3103', '00000000-0000-0000-0000-0000000e31d1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== A27. organizacion normal: no marcada como demo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select org_es_demo::integer as org_no_demo_deberia_ser_0 from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== B1. RECHAZADO: el staff de piso no lee los KPI -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3113', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B2. RECHAZADO: el repartidor no lee los KPI -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3114', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B3. RECHAZADO: el admin acotado a A1 no lee A2 (fuera de alcance) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3112', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a2', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B4. RECHAZADO cross-tenant: el owner de B no lee A1 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3115', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B5. RECHAZADO cross-tenant: el owner de A no pide la sucursal de B declarando su organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31b1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B6. RECHAZADO: anon no ejecuta la funcion -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B7. RECHAZADO: la sesion de sistema (sin usuario) no lee KPI de staff -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== B8. RECHAZADO: rango de mas de 63 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-01-01', date '2026-03-11')$q$, '22023');
rollback;

\echo '=== B9. RECHAZADO: rango invertido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e3111', true);
select public.t_esperar_error($q$select * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-11', date '2026-03-10')$q$, '22023');
rollback;

\echo '=== C1. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.whatsapp_kpis_diarios(uuid, uuid, date, date);
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.whatsapp_kpis_diarios('00000000-0000-0000-0000-0000000e3101', '00000000-0000-0000-0000-0000000e31a1', date '2026-03-10', date '2026-03-11');
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
