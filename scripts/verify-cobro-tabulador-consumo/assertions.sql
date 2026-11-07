-- Tabulador por sucursal, costos unitarios, reclamo de avisos de bolsa y detalle de consumo (packages/db/migrations/0081 +
-- packages/domain-restaurantes/migrations/201) contra Postgres REAL. Cada escenario en su propio `begin; ... rollback;`.
-- Alias `should_fail` = debe terminar en ERROR; `_deberia_ser_N` = valor esperado (scripts/verify-real-postgres-ci/run-gate.mjs).
-- Sujetos: c301 owner de A, c302 owner de B, c303 superadmin. Organizaciones A y B (restaurantes, America/Merida).
-- Cifras de PRUEBA, no precios del producto.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug, timezone) values
  ('00000000-0000-0000-0000-00000000b301', 'restaurantes', 'Resto A tab', 'resto-a-tab', 'America/Merida'),
  ('00000000-0000-0000-0000-00000000b302', 'restaurantes', 'Resto B tab', 'resto-b-tab', 'America/Merida')
on conflict do nothing;
insert into core.property (id, organization_id, vertical, name, status) values
  ('00000000-0000-0000-0000-00000000d301', '00000000-0000-0000-0000-00000000b301', 'restaurantes', 'A uno', 'active'),
  ('00000000-0000-0000-0000-00000000d302', '00000000-0000-0000-0000-00000000b301', 'restaurantes', 'A dos', 'active')
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-00000000c301', 'tab-owner-a@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-00000000c302', 'tab-owner-b@example.com', 'Owner B', 'seed'),
  ('00000000-0000-0000-0000-00000000c303', 'tab-super@example.com', 'Super', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000b301', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000b302', null, 'owner', 'owner')
on conflict do nothing;
insert into core.platform_superadmin (staff_user_id) values ('00000000-0000-0000-0000-00000000c303') on conflict do nothing;
insert into core.plan (id, nombre, vertical, modelo_cobro, minutos_voz_incluidos_por_sucursal) values ('tab-lista', 'Lista con tabulador', 'restaurantes', 'medido', 100)
on conflict do nothing;

\echo '=== TABULADOR ==='
\echo '1. el superadmin fija 5 tramos contiguos (el ultimo abierto y a cotizar)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select jsonb_array_length(core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c303', 'tab-lista',
  '[{"desde":1,"hasta":2,"precioCentavos":100},{"desde":3,"hasta":5,"precioCentavos":90},{"desde":6,"hasta":9,"precioCentavos":80},{"desde":10,"hasta":19,"precioCentavos":70},{"desde":20,"hasta":null,"precioCentavos":null}]'::jsonb)->'tramosSucursal') as tramos_deberia_ser_5;
rollback;

\echo '2. un hueco entre tramos se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c303', 'tab-lista', '[{"desde":1,"hasta":2,"precioCentavos":100},{"desde":4,"hasta":null,"precioCentavos":90}]'::jsonb) as should_fail;
rollback;

\echo '3. un tramo abierto que no es el ultimo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c303', 'tab-lista', '[{"desde":1,"hasta":null,"precioCentavos":100},{"desde":3,"hasta":5,"precioCentavos":90}]'::jsonb) as should_fail;
rollback;

\echo '4. el tabulador debe empezar en 1 sucursal'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c303', 'tab-lista', '[{"desde":2,"hasta":null,"precioCentavos":100}]'::jsonb) as should_fail;
rollback;

\echo '5. un precio con decimales se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c303', 'tab-lista', '[{"desde":1,"hasta":null,"precioCentavos":99.5}]'::jsonb) as should_fail;
rollback;

\echo '6. un owner no puede fijar el tabulador'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c301', 'tab-lista', '[{"desde":1,"hasta":null,"precioCentavos":100}]'::jsonb) as should_fail;
rollback;

\echo '7. arreglo vacio quita el tabulador'
begin;
insert into core.plan_tramo_sucursal (plan_id, desde_sucursales, hasta_sucursales, precio_sucursal_mxn_centavos) values ('tab-lista', 1, null, 100);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select jsonb_array_length(core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c303', 'tab-lista', '[]'::jsonb)->'tramosSucursal') as sin_tramos_deberia_ser_0;
rollback;

\echo '8. anon no puede fijar el tabulador'
begin;
set local role anon;
select core.superadmin_set_plan_tramos('00000000-0000-0000-0000-00000000c303', 'tab-lista', '[]'::jsonb) as should_fail;
rollback;

\echo '=== COSTOS UNITARIOS ==='
\echo '9. el superadmin captura un costo y lo lee'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_cobro_costo_unitario('00000000-0000-0000-0000-00000000c303', 'minuto_voz', 1.2, 'prueba de costo medido');
select count(*)::int as costo_deberia_ser_1 from core.cobro_costos_unitarios('00000000-0000-0000-0000-00000000c303') where clave = 'minuto_voz';
rollback;

\echo '10. un owner no lee los costos (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select count(*)::int as owner_no_lee_deberia_ser_0 from core.cobro_costos_unitarios('00000000-0000-0000-0000-00000000c301');
rollback;

\echo '11. un costo negativo se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_cobro_costo_unitario('00000000-0000-0000-0000-00000000c303', 'minuto_voz', -1, 'prueba de costo') as should_fail;
rollback;

\echo '12. una clave de costo inventada se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_cobro_costo_unitario('00000000-0000-0000-0000-00000000c303', 'gasolina', 1, 'prueba de costo') as should_fail;
rollback;

\echo '13. un owner no puede capturar costos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select core.superadmin_set_cobro_costo_unitario('00000000-0000-0000-0000-00000000c301', 'minuto_voz', 1, 'prueba de costo') as should_fail;
rollback;

\echo '=== RECLAMO DE AVISOS DE BOLSA ==='
\echo '14. el primer reclamo del sistema gana'
begin;
select core.cobro_reclamar_aviso_bolsa('00000000-0000-0000-0000-00000000b301', '2026-10-15', 'minutos_voz', 80)::int as primero_deberia_ser_1;
rollback;

\echo '15. el segundo reclamo del mismo aviso (mismo mes, otro dia) ya no sale'
begin;
select core.cobro_reclamar_aviso_bolsa('00000000-0000-0000-0000-00000000b301', '2026-10-15', 'minutos_voz', 80);
select core.cobro_reclamar_aviso_bolsa('00000000-0000-0000-0000-00000000b301', '2026-10-20', 'minutos_voz', 80)::int as segundo_deberia_ser_0;
rollback;

\echo '16. un usuario (aun superadmin) no puede reclamar avisos'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.cobro_reclamar_aviso_bolsa('00000000-0000-0000-0000-00000000b301', '2026-10-15', 'minutos_voz', 80) as should_fail;
rollback;

\echo '17. un umbral fuera de 80/100/150 se rechaza'
begin;
select core.cobro_reclamar_aviso_bolsa('00000000-0000-0000-0000-00000000b301', '2026-10-15', 'minutos_voz', 90) as should_fail;
rollback;

\echo '=== ORGANIZACIONES CON PLAN MEDIDO ==='
\echo '18. el superadmin ve la organizacion con plan medido'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b301', 'tab-lista');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select count(*)::int as superadmin_ve_deberia_ser_1 from core.superadmin_cobro_organizaciones('00000000-0000-0000-0000-00000000c303') where organization_id = '00000000-0000-0000-0000-00000000b301';
rollback;

\echo '19. un owner no ve la lista (0 filas)'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b301', 'tab-lista');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select count(*)::int as owner_no_ve_deberia_ser_0 from core.superadmin_cobro_organizaciones('00000000-0000-0000-0000-00000000c301');
rollback;

\echo '20. el sistema (cron de avisos) ve la lista con las sucursales activas'
begin;
insert into core.organization_plan (organization_id, plan_id) values ('00000000-0000-0000-0000-00000000b301', 'tab-lista');
select sucursales_activas as sucursales_deberia_ser_2 from core.superadmin_cobro_organizaciones(null) where organization_id = '00000000-0000-0000-0000-00000000b301';
rollback;

\echo '=== DETALLE DE CONSUMO ==='
\echo '21. por sucursal: la sucursal uno suma 100 s + 50 s = 3 minutos'
begin;
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, started_at, duration_s) values
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 't1', 'llamada', 'elevenlabs-agents', '2026-10-10 18:00:00+00', 100),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 't2', 'llamada', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 50),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d302', 't3', 'llamada', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 60),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d302', 't4', 'preview', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 600);
select (s->>'minutosVoz')::int as sucursal_uno_deberia_ser_3 from jsonb_array_elements(restaurantes.consumo_detalle_mes(null, '00000000-0000-0000-0000-00000000b301', '2026-10-01')->'sucursales') s where s->>'nombre' = 'A uno';
rollback;

\echo '22. duracion promedio del mes: (100 + 50 + 60) / 3 = 70 s (el preview no cuenta)'
begin;
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, started_at, duration_s) values
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 't1', 'llamada', 'elevenlabs-agents', '2026-10-10 18:00:00+00', 100),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 't2', 'llamada', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 50),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d302', 't3', 'llamada', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 60),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d302', 't4', 'preview', 'elevenlabs-agents', '2026-10-11 18:00:00+00', 600);
select (restaurantes.consumo_detalle_mes(null, '00000000-0000-0000-0000-00000000b301', '2026-10-01')->'totales'->>'duracionPromedioS')::int as promedio_deberia_ser_70;
rollback;

\echo '23. la serie diaria de octubre tiene 31 dias'
begin;
select jsonb_array_length(restaurantes.consumo_detalle_mes(null, '00000000-0000-0000-0000-00000000b301', '2026-10-01')->'dias') as dias_deberia_ser_31;
rollback;

\echo '24. pedidos de los agentes: voz y WhatsApp cuentan; web y cancelados no'
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 'Cliente', '+5219990000001', 100, 'completado', '[]'::jsonb, 'voice', '2026-10-10 18:00:00+00'),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 'Cliente', '+5219990000001', 100, 'entregado', '[]'::jsonb, 'whatsapp', '2026-10-10 18:00:00+00'),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 'Cliente', '+5219990000001', 100, 'cancelado', '[]'::jsonb, 'voice', '2026-10-10 18:00:00+00'),
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 'Cliente', '+5219990000001', 100, 'completado', '[]'::jsonb, 'web', '2026-10-10 18:00:00+00');
select (restaurantes.consumo_detalle_mes(null, '00000000-0000-0000-0000-00000000b301', '2026-10-01')->'totales'->>'pedidosAgentes')::int as pedidos_deberia_ser_2;
rollback;

\echo '25. historial: septiembre aparece con su minuto'
begin;
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, started_at, duration_s) values
  ('00000000-0000-0000-0000-00000000b301', '00000000-0000-0000-0000-00000000d301', 'h1', 'llamada', 'elevenlabs-agents', '2026-09-10 18:00:00+00', 30);
select (h->>'minutosVoz')::int as septiembre_deberia_ser_1 from jsonb_array_elements(restaurantes.consumo_detalle_mes(null, '00000000-0000-0000-0000-00000000b301', '2026-10-01', 3)->'historial') h where h->>'mes' = '2026-09-01';
rollback;

\echo '26. el owner de B no ve el consumo de A (null)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c302', true);
select (restaurantes.consumo_detalle_mes('00000000-0000-0000-0000-00000000c302', '00000000-0000-0000-0000-00000000b301', '2026-10-01') is null)::int as cruzado_null_deberia_ser_1;
rollback;

\echo '27. el owner de A ve su consumo'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select (restaurantes.consumo_detalle_mes('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000b301', '2026-10-01') is not null)::int as owner_ve_deberia_ser_1;
rollback;

\echo '28. caller binding del detalle'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c302', true);
select restaurantes.consumo_detalle_mes('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000b301', '2026-10-01') as should_fail;
rollback;

\echo '29. anon no lee el detalle'
begin;
set local role anon;
select restaurantes.consumo_detalle_mes(null, '00000000-0000-0000-0000-00000000b301', '2026-10-01') as should_fail;
rollback;

\echo '=== SEMILLA DE REFERENCIA (0082) ==='
\echo '30. la semilla trae 11 tramos de referencia (anual 5, mensual 5, WhatsApp 1)'
begin;
select count(*)::int as tramos_semilla_deberia_ser_11 from core.plan_tramo_sucursal where plan_id like 'restaurantes-referencia-%';
rollback;

\echo '31. ningun tramo de referencia deja menos de 55 por ciento de margen bruto con la bolsa llena y los costos sembrados'
begin;
select count(*)::int as tramos_bajo_55_deberia_ser_0
from core.plan_tramo_sucursal t
join core.plan p on p.id = t.plan_id
cross join (select
    (select costo_mxn from core.cobro_costo_unitario where clave = 'minuto_voz') as cm,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'conversacion_wa') as cc,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'fijo_mensual_sucursal')
      + (select costo_mxn from core.cobro_costo_unitario where clave = 'numero_voz_mensual_sucursal') as cs) k
where t.plan_id like 'restaurantes-referencia-%' and t.precio_sucursal_mxn_centavos is not null
  and ((t.precio_sucursal_mxn_centavos / 100.0)
       - (coalesce(t.minutos_voz_incluidos_por_sucursal, p.minutos_voz_incluidos_por_sucursal) * k.cm
          + coalesce(t.conversaciones_wa_incluidas_por_sucursal, p.conversaciones_wa_incluidas_por_sucursal) * k.cc + k.cs))
      / (t.precio_sucursal_mxn_centavos / 100.0) < 0.55;
rollback;

\echo '32. los planes de referencia nacen inactivos (no se asignan: son el piso del cotizador)'
begin;
select count(*)::int as activos_deberia_ser_0 from core.plan where id like 'restaurantes-referencia-%' and activo;
rollback;

\echo '=== COTIZACIONES (0082) ==='
\echo '33. una cotizacion con margen sobre el minimo se registra sin motivo'
begin;
insert into core.plan (id, nombre, vertical, modelo_cobro, precio_base_mxn_centavos, organizacion_exclusiva_id) values ('cot-a', 'A la medida A', 'restaurantes', 'medido', 100000, '00000000-0000-0000-0000-00000000b301');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select ((core.superadmin_registrar_cotizacion('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000b301', 'cot-a', '{"supuestos":{}}'::jsonb, 60, 55, null)->>'folio') is not null)::int as registrada_deberia_ser_1;
rollback;

\echo '34. debajo del minimo SIN motivo se rechaza'
begin;
insert into core.plan (id, nombre, vertical, modelo_cobro, precio_base_mxn_centavos, organizacion_exclusiva_id) values ('cot-a', 'A la medida A', 'restaurantes', 'medido', 100000, '00000000-0000-0000-0000-00000000b301');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_registrar_cotizacion('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000b301', 'cot-a', '{}'::jsonb, 40, 55, 'corto') as should_fail;
rollback;

\echo '35. debajo del minimo CON motivo se registra y queda en la bitacora'
begin;
insert into core.plan (id, nombre, vertical, modelo_cobro, precio_base_mxn_centavos, organizacion_exclusiva_id) values ('cot-a', 'A la medida A', 'restaurantes', 'medido', 100000, '00000000-0000-0000-0000-00000000b301');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_registrar_cotizacion('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000b301', 'cot-a', '{}'::jsonb, 40, 55, 'Cliente ancla del piloto, autorizado por el dueño');
reset role;
select count(*)::int as bitacora_deberia_ser_1 from core.plan_audit_log where plan_id = 'cot-a' and (detail->>'excepcion')::boolean;
rollback;

\echo '36. la cotizacion exige que el plan sea a la medida de ESA organizacion'
begin;
insert into core.plan (id, nombre, vertical, modelo_cobro, precio_base_mxn_centavos, organizacion_exclusiva_id) values ('cot-a', 'A la medida A', 'restaurantes', 'medido', 100000, '00000000-0000-0000-0000-00000000b301');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_registrar_cotizacion('00000000-0000-0000-0000-00000000c303', '00000000-0000-0000-0000-00000000b302', 'cot-a', '{}'::jsonb, 60, 55, null) as should_fail;
rollback;

\echo '37. las cotizaciones son append-only'
begin;
insert into core.plan (id, nombre, vertical, modelo_cobro, precio_base_mxn_centavos, organizacion_exclusiva_id) values ('cot-a', 'A la medida A', 'restaurantes', 'medido', 100000, '00000000-0000-0000-0000-00000000b301');
insert into core.cotizacion (organization_id, plan_id, detalle, margen_pct, margen_minimo_pct, creado_por) values ('00000000-0000-0000-0000-00000000b301', 'cot-a', '{}'::jsonb, 60, 55, '00000000-0000-0000-0000-00000000c303');
update core.cotizacion set margen_pct = 99 returning 1 as should_fail;
rollback;

\echo '38. un owner no registra cotizaciones'
begin;
insert into core.plan (id, nombre, vertical, modelo_cobro, precio_base_mxn_centavos, organizacion_exclusiva_id) values ('cot-a', 'A la medida A', 'restaurantes', 'medido', 100000, '00000000-0000-0000-0000-00000000b301');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select core.superadmin_registrar_cotizacion('00000000-0000-0000-0000-00000000c301', '00000000-0000-0000-0000-00000000b301', 'cot-a', '{}'::jsonb, 60, 55, null) as should_fail;
rollback;

\echo '39. un owner no lista cotizaciones (0 filas)'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select count(*)::int as owner_no_lista_deberia_ser_0 from core.superadmin_listar_cotizaciones('00000000-0000-0000-0000-00000000c301', null);
rollback;

\echo '40. Basico, Plus y Pro: con tarjeta y la bolsa llena dejan >= 55 por ciento (1 y 2 sucursales)'
begin;
select count(*)::int as planes_lista_bajo_minimo_deberia_ser_0
from core.plan p
cross join generate_series(1, 2) n
cross join (select
    (select costo_mxn from core.cobro_costo_unitario where clave = 'minuto_voz') as cm,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'conversacion_wa') as cc,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'fijo_mensual_sucursal') as cs,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'numero_voz_mensual_sucursal') as nv,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'comision_tarjeta_pct') as tp,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'comision_tarjeta_fijo_mxn') as tf) k
where p.id in ('restaurantes-basico', 'restaurantes-plus', 'restaurantes-pro')
  and (
    (n * p.precio_sucursal_mxn_centavos / 100.0)
    - n * (p.minutos_voz_incluidos_por_sucursal * k.cm + p.conversaciones_wa_incluidas_por_sucursal * k.cc + k.cs
           + case when p.minutos_voz_incluidos_por_sucursal > 0 then k.nv else 0 end)
    - ((n * p.precio_sucursal_mxn_centavos / 100.0) * (1 + p.tasa_iva_bp / 10000.0) * k.tp / 100.0 + k.tf) * 1.16
  ) / (n * p.precio_sucursal_mxn_centavos / 100.0) * 100 < 55;
rollback;

\echo '41. Basico, Plus y Pro: antes de comision cumplen el margen objetivo de cada plan'
begin;
select count(*)::int as objetivo_incumplido_deberia_ser_0
from core.plan p
cross join (select
    (select costo_mxn from core.cobro_costo_unitario where clave = 'minuto_voz') as cm,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'conversacion_wa') as cc,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'fijo_mensual_sucursal') as cs,
    (select costo_mxn from core.cobro_costo_unitario where clave = 'numero_voz_mensual_sucursal') as nv) k
where p.id in ('restaurantes-basico', 'restaurantes-plus', 'restaurantes-pro')
  and ((p.precio_sucursal_mxn_centavos / 100.0) - (p.minutos_voz_incluidos_por_sucursal * k.cm + p.conversaciones_wa_incluidas_por_sucursal * k.cc + k.cs
       + case when p.minutos_voz_incluidos_por_sucursal > 0 then k.nv else 0 end)) / (p.precio_sucursal_mxn_centavos / 100.0) * 100 < p.margen_minimo_pct;
rollback;

\echo '42. la tarifa expone el margen minimo del plan'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select (t->>'margenMinimoPct')::numeric::int as margen_pro_deberia_ser_60 from core.list_plan_tarifas_for_superadmin('00000000-0000-0000-0000-00000000c303') t where t->>'planId' = 'restaurantes-pro';
rollback;

\echo '43. pago por uso: cada banda con precio deja >= 55 por ciento por unidad despues de la comision de tarjeta'
begin;
select count(*)::int as bandas_bajo_55_deberia_ser_0
from core.plan_banda_uso b
cross join (select (select costo_mxn from core.cobro_costo_unitario where clave = 'comision_tarjeta_pct') as tp) k
where b.plan_id = 'restaurantes-por-uso' and b.precio_centavos is not null
  and ((b.precio_centavos / 100.0) - b.costo_unitario_mxn - (b.precio_centavos / 100.0) * 1.16 * k.tp / 100.0 * 1.16) / (b.precio_centavos / 100.0) < 0.55;
rollback;

\echo '44. bandas: un hueco se rechaza'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_plan_bandas('00000000-0000-0000-0000-00000000c303', 'tab-lista', 'minuto_voz', '[{"desde":0,"hasta":100,"precioCentavos":300,"costoUnitarioMxn":1},{"desde":200,"hasta":null,"precioCentavos":250,"costoUnitarioMxn":1}]'::jsonb) as should_fail;
rollback;

\echo '45. bandas: un owner no puede fijarlas'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c301', true);
select core.superadmin_set_plan_bandas('00000000-0000-0000-0000-00000000c301', 'tab-lista', 'minuto_voz', '[]'::jsonb) as should_fail;
rollback;

\echo '46. bandas: el superadmin las fija y aparecen en la tarifa'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-00000000c303', true);
select core.superadmin_set_plan_bandas('00000000-0000-0000-0000-00000000c303', 'tab-lista', 'minuto_voz', '[{"desde":0,"hasta":100,"precioCentavos":300,"costoUnitarioMxn":1},{"desde":100,"hasta":null,"precioCentavos":250,"costoUnitarioMxn":1}]'::jsonb);
select jsonb_array_length(t->'bandasUso') as bandas_deberia_ser_2 from core.list_plan_tarifas_for_superadmin('00000000-0000-0000-0000-00000000c303') t where t->>'planId' = 'tab-lista';
rollback;

\echo 'los escenarios 2/3/4/5/6/8/11/12/13/16/17/28/29/34/36/37/38/44/45 deben terminar en ERROR'
