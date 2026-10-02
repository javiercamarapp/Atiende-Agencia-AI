-- Verifica, contra Postgres REAL (GRANT + auth.uid() reales, datos sembrados), la migracion
-- packages/db/migrations/0042_superadmin_consola_resumen.sql (resumen y actividad de agentes de la
-- consola de superadmin, SA-L-05 y SA-L-06): 8 funciones core.get_consola_*_for_superadmin.
--
--   A) Cada funcion AGREGA bien sobre datos sembrados (positivo): organizaciones por vertical y demo,
--      serie diaria con el corte de dia de Mexico (un pedido a las 23:30 hora de Mexico es del dia
--      anterior aunque en UTC ya sea el siguiente), historico por fuente, operaciones por vertical (con la
--      vertical SIN fuente: despachos), sucursales y usuarios (una persona que es staff y superadmin cuenta
--      una vez; el staff de una organizacion suspendida no cuenta), conversaciones de WhatsApp (solo
--      conteo), resueltas sin humano y actividad por rol.
--   B) Fuente ausente: si la tabla de una vertical no existe, SOLO esa fila sale con razon
--      'fuente_no_migrada'; el resto de la funcion sigue respondiendo.
--   C) Rechazo (negativo): staff normal (que ademas tiene datos propios), un uid que no coincide con
--      p_caller_id y la sesion de sistema (auth.uid() null) reciben CERO filas de cada funcion; anon no
--      tiene EXECUTE (error). Cross-tenant: el staff normal de una organizacion no ve agregados de la
--      plataforma ni lee directo las tablas fuente (permission denied).
--   D) Rangos invalidos (22023) y la bitacora 'resumen_mrr' del MRR (core.cfo_zone_log_access).
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; el alias `as should_fail` marca un escenario que debe terminar en
-- ERROR; el alias deberia_ser_N exige que la ultima fila valga N. Sesion de SISTEMA = rol
-- authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f5001', 'restaurantes', 'Consola R1', 'org-consola-r1', 'active'),
  ('00000000-0000-0000-0000-0000000f5002', 'restaurantes', 'Consola R2 demo', 'org-consola-r2', 'trial'),
  ('00000000-0000-0000-0000-0000000f5003', 'hoteles', 'Consola H1', 'org-consola-h1', 'active'),
  ('00000000-0000-0000-0000-0000000f5004', 'citas', 'Consola C1 demo por slug', 'demo-citas', 'active'),
  ('00000000-0000-0000-0000-0000000f5005', 'licitaciones', 'Consola S1 suspendida', 'org-consola-s1', 'suspended')
on conflict do nothing;
insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000f5002', 'verify-1') on conflict do nothing;
insert into core.property (id, organization_id, name, status) values
  ('00000000-0000-0000-0000-0000000f5011', '00000000-0000-0000-0000-0000000f5001', 'Sucursal R1', 'active'),
  ('00000000-0000-0000-0000-0000000f5012', '00000000-0000-0000-0000-0000000f5002', 'Sucursal R2 inactiva', 'inactive'),
  ('00000000-0000-0000-0000-0000000f5013', '00000000-0000-0000-0000-0000000f5003', 'Hotel H1', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f5100', 'sa-consola@example.com', 'Superadmin Consola', 'seed'),
  ('00000000-0000-0000-0000-0000000f5102', 'staff-consola@example.com', 'Staff normal Consola', 'seed'),
  ('00000000-0000-0000-0000-0000000f5103', 'staff-suspendida@example.com', 'Staff de org suspendida', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f5100') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f5102', '00000000-0000-0000-0000-0000000f5001', null, 'owner', 'staff'),
  ('00000000-0000-0000-0000-0000000f5100', '00000000-0000-0000-0000-0000000f5001', null, 'owner', 'staff'),
  ('00000000-0000-0000-0000-0000000f5103', '00000000-0000-0000-0000-0000000f5005', null, 'owner', 'staff')
on conflict do nothing;

-- Pedidos de restaurantes: 3 validos (uno a las 23:30 de Mexico del 30-sep = 05:30 UTC del 1-oct) y 1 cancelado.
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, created_at) values
  ('00000000-0000-0000-0000-0000000f5001', '00000000-0000-0000-0000-0000000f5011', 'Cliente A', '+520001000001', 100, 'entregado', '[]'::jsonb, timestamptz '2026-09-30 23:30:00-06'),
  ('00000000-0000-0000-0000-0000000f5001', '00000000-0000-0000-0000-0000000f5011', 'Cliente B', '+520001000002', 100, 'pending', '[]'::jsonb, timestamptz '2026-10-01 10:00:00-06'),
  ('00000000-0000-0000-0000-0000000f5001', '00000000-0000-0000-0000-0000000f5011', 'Cliente C', '+520001000003', 100, 'completado', '[]'::jsonb, timestamptz '2026-10-01 12:00:00-06'),
  ('00000000-0000-0000-0000-0000000f5001', '00000000-0000-0000-0000-0000000f5011', 'Cliente D', '+520001000004', 100, 'cancelado', '[]'::jsonb, timestamptz '2026-10-01 12:30:00-06');
-- Reservas de hotel: 1 valida y 1 cancelada.
insert into hoteles.reservation (organization_id, property_id, check_in_date, check_out_date, status, total_amount, created_at) values
  ('00000000-0000-0000-0000-0000000f5003', '00000000-0000-0000-0000-0000000f5013', '2026-10-05', '2026-10-07', 'confirmada', 0, timestamptz '2026-10-01 09:00:00-06'),
  ('00000000-0000-0000-0000-0000000f5003', '00000000-0000-0000-0000-0000000f5013', '2026-10-08', '2026-10-09', 'cancelada', 0, timestamptz '2026-10-01 09:30:00-06');
-- Gasto de LLM.
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, tokens_in, tokens_out, cost_micro_usd, call_count, fallback_call_count) values
  ('00000000-0000-0000-0000-0000000f5001', '2026-09-30', 'restaurantes', 'restaurantes:whatsapp_agent', 'prov', 'm1', 'interactive', 100, 50, 2000000, 4, 1),
  ('00000000-0000-0000-0000-0000000f5001', '2026-10-01', 'restaurantes', 'restaurantes:whatsapp_agent', 'prov', 'm1', 'interactive', 20, 10, 1000000, 3, 0),
  ('00000000-0000-0000-0000-0000000f5003', '2026-09-10', 'hoteles', 'hoteles:whatsapp_agent', 'prov', 'm1', 'interactive', 10, 10, 1000000, 2, 0),
  ('00000000-0000-0000-0000-0000000f5003', '2026-07-01', 'hoteles', 'hoteles:whatsapp_agent', 'prov', 'm1', 'interactive', 5, 5, 500000, 1, 1);
-- Eventos de costo: WhatsApp a las 23:30 de Mexico del 30-sep (05:30 UTC del 1-oct) y voz de 120 s el 1-oct.
insert into core.usage_cost_event (organization_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000f5001', 'restaurantes', timestamptz '2026-09-30 23:30:00-06', 'whatsapp', 'meta', 'mensaje', 1, 5000, 'verify', 'consola-wa-1'),
  ('00000000-0000-0000-0000-0000000f5001', 'restaurantes', timestamptz '2026-10-01 10:00:00-06', 'voz', 'eleven', 'segundo', 120, 300000, 'verify', 'consola-voz-1');
-- Conversaciones de WhatsApp de restaurantes: c1 resuelta sin humano, c2 resuelta con toma humana, c3 activa, c4 de otro dia.
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, status, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000f5201', '00000000-0000-0000-0000-0000000f5001', '+520001100001', '00000000-0000-0000-0000-0000000f5011', 'completed', timestamptz '2026-10-01 08:00:00-06', timestamptz '2026-10-01 10:00:00-06'),
  ('00000000-0000-0000-0000-0000000f5202', '00000000-0000-0000-0000-0000000f5001', '+520001100002', '00000000-0000-0000-0000-0000000f5011', 'completed', timestamptz '2026-10-01 08:00:00-06', timestamptz '2026-10-01 11:00:00-06'),
  ('00000000-0000-0000-0000-0000000f5203', '00000000-0000-0000-0000-0000000f5001', '+520001100003', '00000000-0000-0000-0000-0000000f5011', 'active', timestamptz '2026-10-01 08:00:00-06', timestamptz '2026-10-01 12:00:00-06'),
  ('00000000-0000-0000-0000-0000000f5204', '00000000-0000-0000-0000-0000000f5001', '+520001100004', '00000000-0000-0000-0000-0000000f5011', 'completed', timestamptz '2026-09-30 08:00:00-06', timestamptz '2026-09-30 12:00:00-06');
insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por, solicitada_at, cerrada_at) values
  ('00000000-0000-0000-0000-0000000f5001', '00000000-0000-0000-0000-0000000f5011', 'whatsapp', '00000000-0000-0000-0000-0000000f5202', 'cerrada', 'agente', timestamptz '2026-10-01 10:30:00-06', timestamptz '2026-10-01 10:45:00-06');
insert into hoteles.whatsapp_conversations (organization_id, property_id, phone, status) values ('00000000-0000-0000-0000-0000000f5003', '00000000-0000-0000-0000-0000000f5013', '+520001200001', 'active');

-- ═══ A) Positivos con datos sembrados ═══

\echo 'A1. organizaciones: restaurantes 2 (1 demo por tabla), hoteles 1, citas 1 (demo por slug), licitaciones 1 suspendida (0 activas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select count(*) from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100')) = 4 and (select total = 2 and demo = 1 and activas = 1 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'restaurantes') and (select total = 1 and demo = 0 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'hoteles') and (select total = 1 and demo = 1 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'citas') and (select total = 1 and activas = 0 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'licitaciones'))::int as deberia_ser_1;
rollback;

\echo 'A2. costo diario: el WhatsApp de las 23:30 de Mexico cae en el 30-sep y los tokens suman in+out'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select count(*) from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01')) = 2 and (select llm_micro_usd = 2000000 and eventos_micro_usd = 5000 and tokens = 150 from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where dia = date '2026-09-30') and (select llm_micro_usd = 1000000 and eventos_micro_usd = 300000 and tokens = 30 from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where dia = date '2026-10-01'))::int as deberia_ser_1;
rollback;

\echo 'A3. costo historico: llm, voz (120 s = 2 min) y whatsapp, cada fuente por separado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select count(*) from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5100')) = 3 and (select costo_micro_usd = 4500000 and tokens_in = 135 and tokens_out = 75 and eventos = 10 from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5100') where fuente = 'llm') and (select costo_micro_usd = 300000 and minutos_voz = 2 from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5100') where fuente = 'voz') and (select costo_micro_usd = 5000 and minutos_voz is null from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5100') where fuente = 'whatsapp'))::int as deberia_ser_1;
rollback;

\echo 'A4. operaciones: pedidos sin cancelados (con el corte de Mexico), reservas sin canceladas, citas en 0 real y despachos SIN FUENTE'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select count(*) from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01')) = 16 and (select cantidad = 3 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'restaurantes' and dia is null) and (select cantidad = 1 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'restaurantes' and dia = date '2026-09-30') and (select cantidad = 2 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'restaurantes' and dia = date '2026-10-01') and (select cantidad = 1 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'hoteles' and dia is null) and (select cantidad = 0 and razon is null from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'citas' and dia is null) and (select cantidad is null and razon = 'sin_fuente' from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'despachos'))::int as deberia_ser_1;
rollback;

\echo 'A5. alcance: 2 sucursales activas; staff 2 (la org suspendida no cuenta); el superadmin que tambien es staff cuenta una sola vez (la migracion 0010 ya siembra otro superadmin)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select sucursales_activas = 2 and staff_con_membresia = 2 and superadmins >= 1 and usuarios_con_acceso = staff_con_membresia + superadmins - 1 from core.get_consola_alcance_for_superadmin('00000000-0000-0000-0000-0000000f5100')))::int as deberia_ser_1;
rollback;

\echo 'A6. conversaciones de WhatsApp: solo conteo; rentas/licitaciones/despachos sin whatsapp (razon, no 0)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select count(*) from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100')) = 6 and (select total = 4 from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'restaurantes') and (select total = 1 from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'hoteles') and (select total = 0 and razon is null from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'citas') and (select count(*) from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100') where razon = 'sin_whatsapp' and total is null) = 3)::int as deberia_ser_1;
rollback;

\echo 'A7. resueltas sin humano del 1-oct (dia de Mexico): 3 conversaciones con actividad, 1 resuelta sin toma humana'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select total = 3 and resueltas_sin_humano = 1 and razon is null from core.get_consola_resueltas_sin_humano_for_superadmin('00000000-0000-0000-0000-0000000f5100', timestamptz '2026-10-01 00:00:00-06', timestamptz '2026-10-02 00:00:00-06')))::int as deberia_ser_1;
rollback;

\echo 'A8. actividad de agentes: historico y 30 dias (el registro de julio queda fuera de 30 dias)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select count(*) from core.get_consola_agentes_actividad_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-01')) = 2 and (select llamadas_hist = 7 and costo_hist_micro_usd = 3000000 and fallback_hist = 1 and llamadas_30d = 7 and costo_30d_micro_usd = 3000000 from core.get_consola_agentes_actividad_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-01') where role = 'restaurantes:whatsapp_agent') and (select llamadas_hist = 3 and costo_hist_micro_usd = 1500000 and fallback_hist = 1 and llamadas_30d = 2 and costo_30d_micro_usd = 1000000 and fallback_30d = 0 from core.get_consola_agentes_actividad_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-01') where role = 'hoteles:whatsapp_agent'))::int as deberia_ser_1;
rollback;

-- ═══ B) Fuente ausente: solo ESA fila se degrada ═══

\echo 'B1. sin citas.appointments: citas sale fuente_no_migrada y las demas verticales siguen con datos'
begin;
drop table citas.appointments cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select cantidad is null and razon = 'fuente_no_migrada' from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'citas') and (select cantidad = 3 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01') where vertical = 'restaurantes' and dia is null))::int as deberia_ser_1;
rollback;

\echo 'B2. sin restaurantes.conversation_handoff: resueltas sin humano sale fuente_no_migrada (PL-14), no un 0'
begin;
drop table restaurantes.conversation_handoff cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select (select total is null and resueltas_sin_humano is null and razon = 'fuente_no_migrada' from core.get_consola_resueltas_sin_humano_for_superadmin('00000000-0000-0000-0000-0000000f5100', timestamptz '2026-10-01 00:00:00-06', timestamptz '2026-10-02 00:00:00-06'))::int as deberia_ser_1;
rollback;

\echo 'B3. sin restaurantes.demo_organization: organizaciones sigue respondiendo y cuenta la demo solo por slug'
begin;
drop table restaurantes.demo_organization cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select ((select demo = 0 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'restaurantes') and (select demo = 1 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100') where vertical = 'citas'))::int as deberia_ser_1;
rollback;

-- ═══ C) Rechazo: staff normal, uid que no coincide, sesion de sistema y anon ═══

\echo 'C1a. organizaciones: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5102');
rollback;

\echo 'C1b. organizaciones: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C1c. organizaciones: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C1d. organizaciones: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_organizaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C2a. costo_diario: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5102', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C2b. costo_diario: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C2c. costo_diario: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C2d. costo_diario: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C3a. costo_historico: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5102');
rollback;

\echo 'C3b. costo_historico: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C3c. costo_historico: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C3d. costo_historico: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_costo_historico_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C4a. operaciones: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5102', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C4b. operaciones: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C4c. operaciones: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C4d. operaciones: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C5a. alcance: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_alcance_for_superadmin('00000000-0000-0000-0000-0000000f5102');
rollback;

\echo 'C5b. alcance: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_alcance_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C5c. alcance: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_alcance_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C5d. alcance: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_alcance_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C6a. conversaciones_wa: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5102');
rollback;

\echo 'C6b. conversaciones_wa: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C6c. conversaciones_wa: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C6d. conversaciones_wa: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_conversaciones_wa_for_superadmin('00000000-0000-0000-0000-0000000f5100');
rollback;

\echo 'C7a. resueltas_sin_humano: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_resueltas_sin_humano_for_superadmin('00000000-0000-0000-0000-0000000f5102', timestamptz '2026-10-01 00:00:00-06', timestamptz '2026-10-02 00:00:00-06');
rollback;

\echo 'C7b. resueltas_sin_humano: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_resueltas_sin_humano_for_superadmin('00000000-0000-0000-0000-0000000f5100', timestamptz '2026-10-01 00:00:00-06', timestamptz '2026-10-02 00:00:00-06');
rollback;

\echo 'C7c. resueltas_sin_humano: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_resueltas_sin_humano_for_superadmin('00000000-0000-0000-0000-0000000f5100', timestamptz '2026-10-01 00:00:00-06', timestamptz '2026-10-02 00:00:00-06');
rollback;

\echo 'C7d. resueltas_sin_humano: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_resueltas_sin_humano_for_superadmin('00000000-0000-0000-0000-0000000f5100', timestamptz '2026-10-01 00:00:00-06', timestamptz '2026-10-02 00:00:00-06');
rollback;

\echo 'C8a. agentes_actividad: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_agentes_actividad_for_superadmin('00000000-0000-0000-0000-0000000f5102', date '2026-10-01');
rollback;

\echo 'C8b. agentes_actividad: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as deberia_ser_0 from core.get_consola_agentes_actividad_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-01');
rollback;

\echo 'C8c. agentes_actividad: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_consola_agentes_actividad_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-01');
rollback;

\echo 'C8d. agentes_actividad: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_consola_agentes_actividad_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-01');
rollback;

\echo 'C9. cross-tenant: el staff normal no lee directo las tablas fuente de plataforma -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as should_fail from core.llm_usage_daily;
rollback;

\echo 'C10. cross-tenant: el staff normal no lee directo core.usage_cost_event -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5102', true);
select count(*) as should_fail from core.usage_cost_event;
rollback;

-- ═══ D) Rangos invalidos y bitacora del MRR ═══

\echo 'D1. costo diario con rango invertido -- RECHAZADO (22023)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select count(*) as should_fail from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-02', date '2026-10-01');
rollback;

\echo 'D2. costo diario con rango de mas de 400 dias -- RECHAZADO (22023)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select count(*) as should_fail from core.get_consola_costo_diario_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2024-01-01', date '2026-10-01');
rollback;

\echo 'D3. operaciones con rango invalido -- RECHAZADO (22023)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select count(*) as should_fail from core.get_consola_operaciones_for_superadmin('00000000-0000-0000-0000-0000000f5100', date '2026-10-02', date '2026-10-01');
rollback;

\echo 'D4. resueltas sin humano con rango vacio -- RECHAZADO (22023)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select count(*) as should_fail from core.get_consola_resueltas_sin_humano_for_superadmin('00000000-0000-0000-0000-0000000f5100', timestamptz '2026-10-02 00:00:00-06', timestamptz '2026-10-01 00:00:00-06');
rollback;

\echo 'D5. la lectura del MRR deja una fila resumen_mrr en cfo_access_log (misma funcion de bitacora que la zona CFO)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f5100', true);
select core.cfo_zone_log_access('00000000-0000-0000-0000-0000000f5100', 'consulta', 'resumen_mrr', '{"_ruta":"/superadmin/consola/resumen"}'::jsonb);
reset role;
select ((select count(*) from core.cfo_access_log where actor_user_id = '00000000-0000-0000-0000-0000000f5100' and accion = 'consulta' and recurso = 'resumen_mrr') = 1)::int as deberia_ser_1;
rollback;
