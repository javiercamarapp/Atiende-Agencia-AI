-- Verifica, contra Postgres REAL, packages/db/migrations/0085_superadmin_cfo_cockpit.sql:
-- supuestos de costo unitario, capturas mensuales del dueño, bitacora append-only y uso por cliente y mes
-- (llamadas, segundos por proveedor, pedidos), con caller binding, rol finanzas de solo lectura,
-- funciones de solo-sistema, anon sin acceso, tablas sin GRANT y organizaciones demo excluidas.
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): cada escenario es un
-- begin/rollback propio; `should_fail` exige ERROR; `deberia_ser_N` exige que la ultima fila valga N.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, status) values
  ('00000000-0000-0000-0000-0000000c0c01', 'restaurantes', 'Cockpit real', 'cockpit-real', 'active'),
  ('00000000-0000-0000-0000-0000000c0c02', 'hoteles', 'Cockpit hotel', 'cockpit-hotel', 'active'),
  ('00000000-0000-0000-0000-0000000c0c03', 'restaurantes', 'Cockpit demo', 'demo-cockpit', 'active')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000c0d01', '00000000-0000-0000-0000-0000000c0c01', 'Sucursal cockpit'),
  ('00000000-0000-0000-0000-0000000c0d03', '00000000-0000-0000-0000-0000000c0c03', 'Sucursal demo')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0e01', 'sa-cockpit@example.com', 'Superadmin cockpit', 'seed'),
  ('00000000-0000-0000-0000-0000000c0e02', 'fin-cockpit@example.com', 'Finanzas cockpit', 'seed'),
  ('00000000-0000-0000-0000-0000000c0e03', 'staff-cockpit@example.com', 'Staff normal', 'seed')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values
  ('00000000-0000-0000-0000-0000000c0e01'), ('00000000-0000-0000-0000-0000000c0e02')
on conflict do nothing;
insert into core.cfo_zone_role (staff_user_id, rol, assigned_by, reason) values
  ('00000000-0000-0000-0000-0000000c0e02', 'finanzas', '00000000-0000-0000-0000-0000000c0e01', 'Contadora externa con acceso de solo lectura')
on conflict do nothing;
-- Marzo 2026, America/Mexico_City (default de core.organization.timezone): 2 llamadas de ElevenLabs (120 s + 60 s),
-- 1 de gpt-live-1 (30 s), un preview y una en curso que NO cuentan, y una llamada de la demo que NO aparece.
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, started_at, duration_s) values
  ('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'cockpit-1', 'llamada', 'elevenlabs-agents', '2026-03-10T18:00:00Z', 120),
  ('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'cockpit-2', 'llamada', 'elevenlabs-agents', '2026-03-11T18:00:00Z', 60),
  ('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'cockpit-3', 'llamada', 'gpt-live-1', '2026-03-12T18:00:00Z', 30),
  ('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'cockpit-4', 'preview', 'elevenlabs-agents', '2026-03-12T18:00:00Z', 500),
  ('00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'cockpit-5', 'llamada', 'elevenlabs-agents', '2026-03-13T18:00:00Z', null),
  ('00000000-0000-0000-0000-0000000c0c03', '00000000-0000-0000-0000-0000000c0d03', 'cockpit-demo', 'llamada', 'elevenlabs-agents', '2026-03-10T18:00:00Z', 999)
on conflict do nothing;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000c0f01', '00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'Cliente A', '9990000001', 100.00, 'completado', '[]', 'voice', '2026-03-10T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000c0f02', '00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'Cliente B', '9990000002', 200.00, 'completado', '[]', 'whatsapp', '2026-03-11T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000c0f03', '00000000-0000-0000-0000-0000000c0c01', '00000000-0000-0000-0000-0000000c0d01', 'Cliente C', '9990000003', 50.00, 'cancelado', '[]', 'web', '2026-03-12T18:00:00Z')
on conflict do nothing;
insert into core.usage_cost_event (organization_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000c0c01', 'restaurantes', '2026-03-10T18:00:00Z', 'voz', 'elevenlabs', 'minuto', 2, 90000, 'verify_cockpit', 'e1')
on conflict do nothing;

-- ───────────── Uso por cliente ─────────────
\echo 'U1. superadmin ve el uso de la org real en marzo: 3 llamadas reales (sin preview ni en curso)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select llamadas as deberia_ser_3 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U2. segundos de voz por proveedor: elevenlabs-agents = 180'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select (segundos_por_proveedor ->> 'elevenlabs-agents')::int as deberia_ser_180 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U3. segundos de voz totales = 210'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select segundos_voz as deberia_ser_210 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U4. pedidos no cancelados = 2 (1 por voz, 1 por WhatsApp)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select (pedidos * 100 + pedidos_voz * 10 + pedidos_whatsapp) as deberia_ser_211 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U5. costo medido de eventos de marzo = 90000 micro-USD'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select eventos_micro_usd as deberia_ser_90000 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U6. la org demo NO aparece en el uso'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select count(*) as deberia_ser_0 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-01-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c03';
rollback;

\echo 'U7. una fila por mes del rango (enero a marzo = 3 para la org real)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select count(*) as deberia_ser_3 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-01-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U8. una org que no es de restaurantes trae llamadas NULL (no 0: no hay medidor de voz para ella)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select count(*) as deberia_ser_1 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c02' and llamadas is null and pedidos is null;
rollback;

\echo 'U9. sin el medidor de cobro (#771) las conversaciones facturables salen NULL, nunca 0 (o el valor del medidor si ya existe)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select count(*) as deberia_ser_1 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01'
    and ((to_regprocedure('restaurantes.uso_facturable_mes(uuid,uuid,date)') is null and conversaciones_wa is null)
      or (to_regprocedure('restaurantes.uso_facturable_mes(uuid,uuid,date)') is not null and conversaciones_wa is not null));
rollback;

\echo 'U10. el rol finanzas (solo lectura) SI lee el uso'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e02', true);
select count(*) as deberia_ser_1 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e02', '2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U11. staff que no es superadmin: cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e03', true);
select count(*) as deberia_ser_0 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e03', '2026-03-01', '2026-03-01');
rollback;

\echo 'U12. caller binding: el superadmin pasando el id de OTRO (sesion distinta) -> cero filas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e03', true);
select count(*) as deberia_ser_0 from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01');
rollback;

\echo 'U13. rango de mas de 24 meses -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select 1 as should_fail from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2023-01-01', '2026-03-01');
rollback;

\echo 'U14. anon no puede ejecutar el envoltorio del superadmin'
begin;
set local role anon;
select 1 as should_fail from core.get_cfo_uso_for_superadmin('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01');
rollback;

\echo 'U15. el cuerpo interno core.cfo_uso_rows no es invocable por authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select 1 as should_fail from core.cfo_uso_rows('00000000-0000-0000-0000-0000000c0e01', '2026-03-01', '2026-03-01');
rollback;

\echo 'U16. sesion de sistema (sin usuario) lee el uso para el cron'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select llamadas as deberia_ser_3 from core.get_cfo_uso_for_system('2026-03-01', '2026-03-01')
  where organization_id = '00000000-0000-0000-0000-0000000c0c01';
rollback;

\echo 'U17. una sesion con usuario NO puede usar la lectura de sistema'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select 1 as should_fail from core.get_cfo_uso_for_system('2026-03-01', '2026-03-01');
rollback;

-- ───────────── Supuestos ─────────────
\echo 'S1. superadmin fija el costo de voz de ElevenLabs y lo lee'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'voz_usd_minuto', 'elevenlabs-agents', 0.045, 'COSTOS-MEDIDOS 2026-11-07');
select count(*) as deberia_ser_1 from core.list_cfo_supuestos_for_superadmin('00000000-0000-0000-0000-0000000c0e01') where clave = 'voz_usd_minuto' and proveedor = 'elevenlabs-agents' and valor = 0.045;
rollback;

\echo 'S2. el cambio queda en la bitacora append-only'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'umbral_margen_pct', '*', 40, 'decision del dueño');
reset role;
select count(*) as deberia_ser_1 from core.cfo_cockpit_log where evento = 'supuesto_set' and detalle ->> 'clave' = 'umbral_margen_pct';
rollback;

\echo 'S3. valor NULL borra el supuesto (vuelve al medido del codigo)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'llm_usd_conversacion_wa', '*', 0.02, 'medicion C3');
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'llm_usd_conversacion_wa', '*', null, 'medicion C3');
select count(*) as deberia_ser_0 from core.list_cfo_supuestos_for_superadmin('00000000-0000-0000-0000-0000000c0e01') where clave = 'llm_usd_conversacion_wa';
rollback;

\echo 'S4. clave desconocida -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'precio_inventado', '*', 1, 'xxx') as should_fail;
rollback;

\echo 'S5. proveedor en una clave que no lo admite -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'umbral_margen_pct', 'elevenlabs-agents', 30, 'xxx') as should_fail;
rollback;

\echo 'S6. el rol finanzas NO puede escribir supuestos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e02', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e02', 'umbral_margen_pct', '*', 10, 'intento finanzas') as should_fail;
rollback;

\echo 'S7. staff normal NO puede escribir supuestos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e03', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e03', 'umbral_margen_pct', '*', 10, 'intento staff') as should_fail;
rollback;

\echo 'S8. caller binding: escribir con el id de otro superadmin -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e03', true);
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'umbral_margen_pct', '*', 10, 'suplantacion') as should_fail;
rollback;

\echo 'S9. anon no puede escribir supuestos'
begin;
set local role anon;
select core.superadmin_set_cfo_supuesto('00000000-0000-0000-0000-0000000c0e01', 'umbral_margen_pct', '*', 10, 'anon') as should_fail;
rollback;

\echo 'S10. lectura de sistema de supuestos desde una sesion con usuario -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select 1 as should_fail from core.list_cfo_supuestos_for_system();
rollback;

\echo 'S11. lectura de sistema sin usuario funciona'
begin;
insert into core.cfo_supuesto (clave, proveedor, valor, fuente) values ('umbral_pool_pct', '*', 85, 'verify');
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as deberia_ser_1 from core.list_cfo_supuestos_for_system() where clave = 'umbral_pool_pct';
rollback;

\echo 'S12. la tabla de supuestos no se lee directo con authenticated'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select 1 as should_fail from core.cfo_supuesto limit 1;
rollback;

-- ───────────── Capturas ─────────────
\echo 'C1. superadmin captura un gasto fijo del mes pasado y lo lee'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', (date_trunc('month', current_date) - interval '1 month')::date, 'gasto_fijo', 'Nomina', 5000000);
select count(*) as deberia_ser_1 from core.list_cfo_capturas_for_superadmin('00000000-0000-0000-0000-0000000c0e01', (current_date - interval '2 months')::date, current_date)
  where tipo = 'gasto_fijo' and concepto = 'Nomina' and monto_mxn_centavos = 5000000;
rollback;

\echo 'C2. el mismo concepto (otra capitalizacion) sobrescribe, no duplica'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', date_trunc('month', current_date)::date, 'marketing', 'Meta Ads', 100000);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', date_trunc('month', current_date)::date, 'marketing', 'meta ads', 200000);
select count(*) as deberia_ser_1 from core.list_cfo_capturas_for_superadmin('00000000-0000-0000-0000-0000000c0e01', current_date, current_date) where tipo = 'marketing';
rollback;

\echo 'C3. un gasto en un mes FUTURO -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', (date_trunc('month', current_date) + interval '1 month')::date, 'gasto_fijo', 'Renta', 100) as should_fail;
rollback;

\echo 'C4. el presupuesto SI admite meses futuros'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', (date_trunc('month', current_date) + interval '2 months')::date, 'presupuesto_ingreso', 'MRR meta', 10000000);
select count(*) as deberia_ser_1 from core.list_cfo_capturas_for_superadmin('00000000-0000-0000-0000-0000000c0e01', current_date, (current_date + interval '3 months')::date) where tipo = 'presupuesto_ingreso';
rollback;

\echo 'C5. monto negativo -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', date_trunc('month', current_date)::date, 'gasto_fijo', 'Renta', -1) as should_fail;
rollback;

\echo 'C6. tipo desconocido -> ERROR'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', date_trunc('month', current_date)::date, 'ingreso_inventado', 'X', 1) as should_fail;
rollback;

\echo 'C7. monto NULL borra el concepto y lo deja en la bitacora'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e01', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', date_trunc('month', current_date)::date, 'saldo_caja', 'Banco', 900000);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e01', date_trunc('month', current_date)::date, 'saldo_caja', 'Banco', null);
reset role;
select count(*) as deberia_ser_1 from core.cfo_cockpit_log where evento = 'captura_borrada' and detalle ->> 'concepto' = 'Banco';
rollback;

\echo 'C8. el rol finanzas NO puede capturar'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e02', true);
select core.superadmin_set_cfo_captura('00000000-0000-0000-0000-0000000c0e02', date_trunc('month', current_date)::date, 'gasto_fijo', 'Renta', 100) as should_fail;
rollback;

\echo 'C9. el rol finanzas SI lee las capturas'
begin;
insert into core.cfo_captura_mensual (mes, tipo, concepto, monto_mxn_centavos) values (date_trunc('month', current_date)::date, 'gasto_fijo', 'Renta', 100);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e02', true);
select count(*) as deberia_ser_1 from core.list_cfo_capturas_for_superadmin('00000000-0000-0000-0000-0000000c0e02', current_date, current_date);
rollback;

\echo 'C10. staff normal: cero filas de capturas'
begin;
insert into core.cfo_captura_mensual (mes, tipo, concepto, monto_mxn_centavos) values (date_trunc('month', current_date)::date, 'gasto_fijo', 'Renta', 100);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0e03', true);
select count(*) as deberia_ser_0 from core.list_cfo_capturas_for_superadmin('00000000-0000-0000-0000-0000000c0e03', current_date, current_date);
rollback;

\echo 'C11. anon no lee capturas'
begin;
set local role anon;
select 1 as should_fail from core.list_cfo_capturas_for_superadmin('00000000-0000-0000-0000-0000000c0e01', current_date, current_date);
rollback;

\echo 'C12. la tabla de capturas no se lee directo con authenticated'
begin;
set local role authenticated;
select 1 as should_fail from core.cfo_captura_mensual limit 1;
rollback;

-- ───────────── Bitacora ─────────────
\echo 'B1. la bitacora rechaza UPDATE incluso al dueño'
begin;
insert into core.cfo_cockpit_log (actor_user_id, evento) values ('00000000-0000-0000-0000-0000000c0e01', 'supuesto_set');
update core.cfo_cockpit_log set evento = 'captura_set' where actor_user_id = '00000000-0000-0000-0000-0000000c0e01';
select 1 as should_fail;
rollback;

\echo 'B2. la bitacora rechaza DELETE incluso al dueño'
begin;
insert into core.cfo_cockpit_log (actor_user_id, evento) values ('00000000-0000-0000-0000-0000000c0e01', 'supuesto_set');
delete from core.cfo_cockpit_log where actor_user_id = '00000000-0000-0000-0000-0000000c0e01';
select 1 as should_fail;
rollback;

\echo 'B3. authenticated no lee la bitacora directo'
begin;
set local role authenticated;
select 1 as should_fail from core.cfo_cockpit_log limit 1;
rollback;
