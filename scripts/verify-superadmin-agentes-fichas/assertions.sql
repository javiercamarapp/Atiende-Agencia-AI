-- Verifica, contra Postgres REAL (GRANT + auth.uid() reales, datos sembrados), la migracion
-- packages/db/migrations/0049_superadmin_fichas_agente.sql (fichas de agente y Model Ops de la consola de superadmin,
-- SA-L-09 y SA-L-10): 5 funciones core.get_fichas_*_for_superadmin.
--
--   A) Cada funcion AGREGA bien sobre datos sembrados (positivo): documentos y requisitos extraidos por el LLM
--      (los invalidados y los extraidos por regla NO cuentan), movimientos conciliados vigentes por origen (un match
--      deshecho no cuenta) y sugerencias, minutos y costo de voz por vertical (segundos / 60 y minutos), serie diaria
--      por rol y costo por rol, proveedor, modelo y carril (lo anterior al rango queda fuera).
--   B) Fuente ausente: si la tabla de licitaciones o despachos no existe, SOLO esa funcion devuelve
--      razon = 'fuente_no_migrada' (cifras null, nunca 0); las demas siguen respondiendo.
--   C) Rechazo (negativo): staff normal (que ademas tiene datos propios), un uid que no coincide con p_caller_id y la
--      sesion de sistema (auth.uid() null) reciben CERO filas de cada funcion; anon no tiene EXECUTE (error).
--      Cross-tenant: el staff normal no lee directo core.llm_usage_daily ni core.usage_cost_event (permission denied).
--   D) Rangos invalidos (22023).
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un begin/rollback propio; el
-- alias `should_fail` marca un escenario que debe terminar en ERROR; el alias deberia_ser_N exige que la ultima fila
-- valga N. Sesion de SISTEMA = rol authenticated con request.jwt.claim.sub vacio.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000f9001', 'restaurantes', 'Fichas R1', 'org-fichas-r1', 'active'),
  ('00000000-0000-0000-0000-0000000f9002', 'licitaciones', 'Fichas L1', 'org-fichas-l1', 'active'),
  ('00000000-0000-0000-0000-0000000f9003', 'despachos', 'Fichas D1', 'org-fichas-d1', 'active'),
  ('00000000-0000-0000-0000-0000000f9004', 'citas', 'Fichas C1', 'org-fichas-c1', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9003', 'despachos', 'Cliente D1')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f9100', 'sa-fichas@example.com', 'Superadmin Fichas', 'seed'),
  ('00000000-0000-0000-0000-0000000f9102', 'staff-fichas@example.com', 'Staff normal Fichas', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-0000000f9100') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f9102', '00000000-0000-0000-0000-0000000f9001', null, 'owner', 'staff')
on conflict do nothing;

-- Licitaciones: 2 convocatorias y 3 documentos. Cuentan los requisitos del LLM NO invalidados: 2 de doc1, 1 de doc2 y 1 sin documento.
-- No cuentan: el requisito del LLM invalidado de doc1 ni el requisito por regla de doc3. Esperado: 2 documentos, 4 requisitos, 2 licitaciones.
insert into licitaciones.tender (id, organization_id, title) values
  ('00000000-0000-0000-0000-0000000f9301', '00000000-0000-0000-0000-0000000f9002', 'Convocatoria T1'),
  ('00000000-0000-0000-0000-0000000f9302', '00000000-0000-0000-0000-0000000f9002', 'Convocatoria T2')
on conflict do nothing;
insert into licitaciones.tender_document (id, organization_id, tender_id, storage_ref) values
  ('00000000-0000-0000-0000-0000000f9311', '00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9301', 'ref/doc1'),
  ('00000000-0000-0000-0000-0000000f9312', '00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9302', 'ref/doc2'),
  ('00000000-0000-0000-0000-0000000f9313', '00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9302', 'ref/doc3')
on conflict do nothing;
insert into licitaciones.requirement_item (organization_id, tender_id, document_id, description, extracted_by, invalidated_at) values
  ('00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9301', '00000000-0000-0000-0000-0000000f9311', 'Requisito 1', 'llm', null),
  ('00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9301', '00000000-0000-0000-0000-0000000f9311', 'Requisito 2', 'llm', null),
  ('00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9301', '00000000-0000-0000-0000-0000000f9311', 'Requisito invalidado', 'llm', now()),
  ('00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9302', '00000000-0000-0000-0000-0000000f9312', 'Requisito 3', 'llm', null),
  ('00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9302', null, 'Requisito sin documento', 'llm', null),
  ('00000000-0000-0000-0000-0000000f9002', '00000000-0000-0000-0000-0000000f9302', '00000000-0000-0000-0000-0000000f9313', 'Requisito por regla', 'rule', null);

-- Despachos: 4 movimientos; 3 matches vigentes (motor, llm_aprobado, manual) y 1 deshecho; 2 sugerencias (1 pendiente, 1 rechazada).
insert into despachos.invoice (id, organization_id, property_id, folio_fiscal, tipo, rfc_emisor, rfc_receptor, subtotal, total, iva, valido, fecha,
                               direccion, metodo_pago, forma_pago, uso_cfdi, moneda, subtotal_centavos, total_centavos, iva_trasladado_centavos, estado_sat) values
  ('00000000-0000-0000-0000-0000000f9411', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9421', 'I', 'CAA010101AB1', 'RRR010101RR1', 1000, 1160, 160, true, '2026-07-10', 'emitido', 'PUE', '03', 'G03', 'MXN', 100000, 116000, 16000, 'vigente'),
  ('00000000-0000-0000-0000-0000000f9412', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9422', 'I', 'CAA010101AB1', 'RRR010101RR1', 500, 580, 80, true, '2026-07-12', 'emitido', 'PUE', '03', 'G03', 'MXN', 50000, 58000, 8000, 'vigente'),
  ('00000000-0000-0000-0000-0000000f9413', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9423', 'I', 'CAA010101AB1', 'RRR010101RR1', 300, 348, 48, true, '2026-07-15', 'emitido', 'PUE', '03', 'G03', 'MXN', 30000, 34800, 4800, 'vigente'),
  ('00000000-0000-0000-0000-0000000f9414', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9424', 'I', 'CAA010101AB1', 'RRR010101RR1', 200, 232, 32, true, '2026-07-16', 'emitido', 'PUE', '03', 'G03', 'MXN', 20000, 23200, 3200, 'vigente'),
  ('00000000-0000-0000-0000-0000000f9415', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9425', 'I', 'CAA010101AB1', 'RRR010101RR1', 100, 116, 16, true, '2026-07-17', 'emitido', 'PUE', '03', 'G03', 'MXN', 10000, 11600, 1600, 'vigente')
on conflict do nothing;
insert into despachos.estado_cuenta_movimiento (id, organization_id, property_id, hash, cuenta, banco, formato, fecha, descripcion, abono, monto, lote_id, renglon) values
  ('00000000-0000-0000-0000-0000000f9511', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', md5('f1') || md5('f1b'), 'CTA1', 'bbva', 'csv', '2026-07-10', 'SPEI 1', 1160, 1160, '00000000-0000-0000-0000-0000000f95a1', 1),
  ('00000000-0000-0000-0000-0000000f9512', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', md5('f2') || md5('f2b'), 'CTA1', 'bbva', 'csv', '2026-07-12', 'SPEI 2', 580, 580, '00000000-0000-0000-0000-0000000f95a1', 2),
  ('00000000-0000-0000-0000-0000000f9513', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', md5('f3') || md5('f3b'), 'CTA1', 'bbva', 'csv', '2026-07-15', 'SPEI 3', 348, 348, '00000000-0000-0000-0000-0000000f95a1', 3),
  ('00000000-0000-0000-0000-0000000f9514', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', md5('f4') || md5('f4b'), 'CTA1', 'bbva', 'csv', '2026-07-16', 'SPEI 4', 232, 232, '00000000-0000-0000-0000-0000000f95a1', 4),
  ('00000000-0000-0000-0000-0000000f9515', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', md5('f5') || md5('f5b'), 'CTA1', 'bbva', 'csv', '2026-07-17', 'SPEI 5', 116, 116, '00000000-0000-0000-0000-0000000f95a1', 5)
on conflict do nothing;
insert into despachos.conciliacion_sesion (id, organization_id, property_id, periodo, cuenta) values
  ('00000000-0000-0000-0000-0000000f9611', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '2026-07', null)
on conflict do nothing;
insert into despachos.conciliacion_match (id, organization_id, property_id, sesion_id, movimiento_id, invoice_id, nivel, confianza, origen, deshecho_en, motivo_deshacer) values
  ('00000000-0000-0000-0000-0000000f9711', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9611', '00000000-0000-0000-0000-0000000f9511', '00000000-0000-0000-0000-0000000f9411', 1, 95, 'motor', null, null),
  ('00000000-0000-0000-0000-0000000f9712', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9611', '00000000-0000-0000-0000-0000000f9512', '00000000-0000-0000-0000-0000000f9412', 4, 80, 'llm_aprobado', null, null),
  ('00000000-0000-0000-0000-0000000f9713', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9611', '00000000-0000-0000-0000-0000000f9513', '00000000-0000-0000-0000-0000000f9413', null, null, 'manual', null, null),
  ('00000000-0000-0000-0000-0000000f9714', '00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9611', '00000000-0000-0000-0000-0000000f9514', '00000000-0000-0000-0000-0000000f9414', null, null, 'manual', now(), 'Deshecho de prueba');
insert into despachos.conciliacion_sugerencia (organization_id, property_id, sesion_id, movimiento_id, invoice_id, confianza, estado, resuelta_en) values
  ('00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9611', '00000000-0000-0000-0000-0000000f9515', '00000000-0000-0000-0000-0000000f9415', 70, 'pendiente', null),
  ('00000000-0000-0000-0000-0000000f9003', '00000000-0000-0000-0000-0000000f9011', '00000000-0000-0000-0000-0000000f9611', '00000000-0000-0000-0000-0000000f9514', '00000000-0000-0000-0000-0000000f9414', 60, 'rechazada', now());

-- Voz: restaurantes 120 s + 3 min = 5 min; citas 60 s = 1 min. El evento de whatsapp no cuenta como voz.
insert into core.usage_cost_event (organization_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000f9001', 'restaurantes', timestamptz '2026-10-01 10:00:00-06', 'voz', 'eleven', 'segundo', 120, 300000, 'verify', 'fichas-voz-1'),
  ('00000000-0000-0000-0000-0000000f9001', 'restaurantes', timestamptz '2026-10-01 11:00:00-06', 'voz', 'eleven', 'minuto', 3, 450000, 'verify', 'fichas-voz-2'),
  ('00000000-0000-0000-0000-0000000f9004', 'citas', timestamptz '2026-10-01 12:00:00-06', 'voz', 'eleven', 'segundo', 60, 150000, 'verify', 'fichas-voz-3'),
  ('00000000-0000-0000-0000-0000000f9001', 'restaurantes', timestamptz '2026-10-01 13:00:00-06', 'whatsapp', 'meta', 'mensaje', 1, 5000, 'verify', 'fichas-wa-1');

-- Gasto de LLM: dos modelos y dos carriles para whatsapp_agent, un escalado, un extractor y un registro de julio (fuera de rango).
insert into core.llm_usage_daily (organization_id, usage_date, vertical, role, provider_id, model, lane, tokens_in, tokens_out, cost_micro_usd, call_count, fallback_call_count) values
  ('00000000-0000-0000-0000-0000000f9001', '2026-09-30', 'restaurantes', 'restaurantes:whatsapp_agent', 'prov-a', 'm1', 'interactive', 100, 50, 2000000, 4, 1),
  ('00000000-0000-0000-0000-0000000f9001', '2026-10-01', 'restaurantes', 'restaurantes:whatsapp_agent', 'prov-a', 'm1', 'interactive', 20, 10, 1000000, 3, 0),
  ('00000000-0000-0000-0000-0000000f9001', '2026-10-01', 'restaurantes', 'restaurantes:whatsapp_agent', 'prov-b', 'm2', 'batch', 10, 5, 400000, 2, 2),
  ('00000000-0000-0000-0000-0000000f9001', '2026-10-01', 'restaurantes', 'restaurantes:whatsapp_agent_escalated', 'prov-a', 'm1', 'interactive', 7, 3, 500000, 1, 0),
  ('00000000-0000-0000-0000-0000000f9002', '2026-09-10', 'licitaciones', 'licitaciones:requirement_extractor', 'prov-a', 'm1', 'background', 30, 20, 300000, 5, 0),
  ('00000000-0000-0000-0000-0000000f9002', '2026-07-01', 'licitaciones', 'licitaciones:requirement_extractor', 'prov-a', 'm1', 'background', 5, 5, 100000, 1, 0);

-- ═══ A) Positivos con datos sembrados ═══

\echo 'A1. documentos extraidos: 2 documentos, 4 requisitos y 2 licitaciones (sin invalidados ni por regla)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select ((select documentos = 2 and requisitos = 4 and licitaciones = 2 and razon is null from core.get_fichas_documentos_extraidos_for_superadmin('00000000-0000-0000-0000-0000000f9100')))::int as deberia_ser_1;
rollback;

\echo 'A2. movimientos conciliados: 3 vigentes (1 motor, 1 llm aprobado, 1 manual; el deshecho no cuenta), 2 sugerencias (1 pendiente)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select ((select movimientos_conciliados = 3 and por_motor = 1 and por_llm_aprobado = 1 and por_manual = 1 and sugerencias_pendientes = 1 and sugerencias_total = 2 and razon is null from core.get_fichas_conciliados_for_superadmin('00000000-0000-0000-0000-0000000f9100')))::int as deberia_ser_1;
rollback;

\echo 'A3. voz por vertical: restaurantes 5 min (120 s + 3 min), citas 1 min; el evento de whatsapp no es voz'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select ((select count(*) from core.get_fichas_voz_por_vertical_for_superadmin('00000000-0000-0000-0000-0000000f9100')) = 2 and (select minutos_voz = 5 and costo_micro_usd = 750000 and eventos = 2 from core.get_fichas_voz_por_vertical_for_superadmin('00000000-0000-0000-0000-0000000f9100') where vertical = 'restaurantes') and (select minutos_voz = 1 and costo_micro_usd = 150000 and eventos = 1 from core.get_fichas_voz_por_vertical_for_superadmin('00000000-0000-0000-0000-0000000f9100') where vertical = 'citas'))::int as deberia_ser_1;
rollback;

\echo 'A4. serie diaria por rol: 30-sep y 1-oct; el 1-oct suma los dos modelos de whatsapp_agent y separa el escalado'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select ((select count(*) from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-30', date '2026-10-01')) = 3 and (select llamadas = 4 and costo_micro_usd = 2000000 and fallbacks = 1 from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-30', date '2026-10-01') where dia = date '2026-09-30' and role = 'restaurantes:whatsapp_agent') and (select llamadas = 5 and costo_micro_usd = 1400000 and fallbacks = 2 from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-30', date '2026-10-01') where dia = date '2026-10-01' and role = 'restaurantes:whatsapp_agent') and (select llamadas = 1 and costo_micro_usd = 500000 and fallbacks = 0 from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-30', date '2026-10-01') where dia = date '2026-10-01' and role = 'restaurantes:whatsapp_agent_escalated'))::int as deberia_ser_1;
rollback;

\echo 'A5. costo por modelo y carril del 1-sep al 1-oct: 4 grupos (julio queda fuera), el de mayor costo primero'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select ((select count(*) from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01')) = 4 and (select costo_micro_usd from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01') limit 1) = 3000000 and (select llamadas = 7 and fallbacks = 1 and tokens_in = 120 and tokens_out = 60 and lane = 'interactive' from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01') where role = 'restaurantes:whatsapp_agent' and model = 'm1') and (select llamadas = 2 and fallbacks = 2 and lane = 'batch' and provider_id = 'prov-b' from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01') where model = 'm2') and (select llamadas = 5 and lane = 'background' from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01') where role = 'licitaciones:requirement_extractor'))::int as deberia_ser_1;
rollback;

-- ═══ B) Fuente ausente: solo ESA funcion se degrada ═══

\echo 'B1. sin licitaciones.requirement_item: documentos extraidos sale fuente_no_migrada (cifras null, no 0) y conciliados sigue con datos'
begin;
drop table licitaciones.requirement_item cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select ((select documentos is null and requisitos is null and licitaciones is null and razon = 'fuente_no_migrada' from core.get_fichas_documentos_extraidos_for_superadmin('00000000-0000-0000-0000-0000000f9100')) and (select movimientos_conciliados = 3 from core.get_fichas_conciliados_for_superadmin('00000000-0000-0000-0000-0000000f9100')))::int as deberia_ser_1;
rollback;

\echo 'B2. sin despachos.conciliacion_match: conciliados sale fuente_no_migrada (cifras null, no 0) y documentos sigue con datos'
begin;
drop table despachos.conciliacion_match cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select ((select movimientos_conciliados is null and sugerencias_total is null and razon = 'fuente_no_migrada' from core.get_fichas_conciliados_for_superadmin('00000000-0000-0000-0000-0000000f9100')) and (select documentos = 2 from core.get_fichas_documentos_extraidos_for_superadmin('00000000-0000-0000-0000-0000000f9100')))::int as deberia_ser_1;
rollback;

-- ═══ C) Rechazo: staff normal, uid que no coincide, sesion de sistema y anon ═══

\echo 'C1a. documentos extraidos: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_documentos_extraidos_for_superadmin('00000000-0000-0000-0000-0000000f9102');
rollback;

\echo 'C1b. documentos extraidos: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_documentos_extraidos_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C1c. documentos extraidos: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_fichas_documentos_extraidos_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C1d. documentos extraidos: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_fichas_documentos_extraidos_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C2a. conciliados: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_conciliados_for_superadmin('00000000-0000-0000-0000-0000000f9102');
rollback;

\echo 'C2b. conciliados: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_conciliados_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C2c. conciliados: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_fichas_conciliados_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C2d. conciliados: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_fichas_conciliados_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C3a. voz por vertical: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_voz_por_vertical_for_superadmin('00000000-0000-0000-0000-0000000f9102');
rollback;

\echo 'C3b. voz por vertical: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_voz_por_vertical_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C3c. voz por vertical: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_fichas_voz_por_vertical_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C3d. voz por vertical: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_fichas_voz_por_vertical_for_superadmin('00000000-0000-0000-0000-0000000f9100');
rollback;

\echo 'C4a. serie diaria: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9102', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C4b. serie diaria: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C4c. serie diaria: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C4d. serie diaria: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-30', date '2026-10-01');
rollback;

\echo 'C5a. modelos por rol: staff normal (con datos propios) recibe CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9102', date '2026-09-01', date '2026-10-01');
rollback;

\echo 'C5b. modelos por rol: caller-binding, p_caller_id de un superadmin pero auth.uid() de OTRO -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as deberia_ser_0 from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01');
rollback;

\echo 'C5c. modelos por rol: sesion de sistema (auth.uid() null) -> CERO filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_0 from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01');
rollback;

\echo 'C5d. modelos por rol: anon no tiene EXECUTE -- RECHAZADO'
begin;
set local role anon;
select count(*) as should_fail from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-09-01', date '2026-10-01');
rollback;

\echo 'C6a. cross-tenant: el staff normal no lee directo core.llm_usage_daily -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as should_fail from core.llm_usage_daily;
rollback;

\echo 'C6b. cross-tenant: el staff normal no lee directo core.usage_cost_event -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9102', true);
select count(*) as should_fail from core.usage_cost_event;
rollback;

-- ═══ D) Rangos invalidos (22023) ═══

\echo 'D1. serie diaria: rango de mas de 400 dias -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select count(*) as should_fail from core.get_fichas_actividad_diaria_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2024-01-01', date '2026-10-01');
rollback;

\echo 'D2. costo por modelo: rango invertido -- RECHAZADO'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f9100', true);
select count(*) as should_fail from core.get_fichas_modelos_por_rol_for_superadmin('00000000-0000-0000-0000-0000000f9100', date '2026-10-02', date '2026-10-01');
rollback;
