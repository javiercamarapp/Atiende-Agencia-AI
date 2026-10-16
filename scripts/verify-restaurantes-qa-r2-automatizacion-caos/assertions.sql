-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/076_qa_r2_automatizacion_dia_de_negocio_y_estados.sql (QA R2, lentes automatizacion y caos).
--
--   A. Dia de negocio (PM abre 12:00-01:00): corte, agotado "hasta manana" que NO se repone con el turno abierto (Merida y Cancun) y SI al
--      terminar el turno; sin horario todo sigue por dia calendario; agotado_marcar acepta "manana de negocio" y rechaza el dia de negocio de hoy.
--   B. Saturacion: tiempo_entrega_muestras.abiertos solo cuenta pedidos de las ultimas 8 horas.
--   C. Estados sin clic: listo_para_recoger sin hora_recogida se limpia con referencia de respaldo (cuando quedo listo); un pedido recien
--      marcado listo NO es no_recogido aunque su hora de recogida ya paso; re-marcar listo reinicia el plazo; un en_camino olvidado no se cierra solo.
--   D. Alertas operativas: pedido pending sin aceptar y pedido estancado (listo_para_recoger / en_camino).
--   E. Muestras del tiempo prometido: franja circular a medianoche con dia de negocio; recoger con hora elegida no mide la hora del cliente.
--   F. Cierre del dia por dia de negocio (el turno que cruza la medianoche queda completo; sin horario sigue por dia calendario).
--   G. Regreso del handoff: no con el agente de WhatsApp apagado (si con el agente encendido).
--   I. Reimportar de cartera: corrige lo que una importacion anterior escribio (nombre, domicilio predeterminado), no pisa lo que una persona
--      cambio ni un cliente que ya existia; idempotente por huella; owner de otra organizacion, anon y sistema rechazados.
--   H. Alertas de voz del sistema: se evaluan solas, idempotentes, sin audit_log; autorizacion (usuario, anon, cross-tenant, helpers cerrados).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias con sufijo deberia_ser_N marca el valor esperado;
-- un escenario sin alias debe terminar sin error (t_esperar_error exige el SQLSTATE exacto). La sesion de SISTEMA es la que no tiene
-- request.jwt.claim.sub (auth.uid() nulo), igual que withAppSession({ userId: null }) del tick.
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
  ('00000000-0000-0000-0000-0000000e7601', 'restaurantes', 'QA R2 Org A', 'qa-r2-a'),
  ('00000000-0000-0000-0000-0000000e7602', 'restaurantes', 'QA R2 Org B (ajena)', 'qa-r2-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e7601', 'Merida (PM, cierra 01:00)'),
  ('00000000-0000-0000-0000-0000000e76a2', '00000000-0000-0000-0000-0000000e7601', 'Cancun (PM, cierra 01:00)'),
  ('00000000-0000-0000-0000-0000000e76a3', '00000000-0000-0000-0000-0000000e7601', 'Saturacion'),
  ('00000000-0000-0000-0000-0000000e76a4', '00000000-0000-0000-0000-0000000e7601', 'Cierre PM'),
  ('00000000-0000-0000-0000-0000000e76a5', '00000000-0000-0000-0000-0000000e7601', 'Sin horario (calendario)'),
  ('00000000-0000-0000-0000-0000000e76a6', '00000000-0000-0000-0000-0000000e7601', 'Voz'),
  ('00000000-0000-0000-0000-0000000e76b1', '00000000-0000-0000-0000-0000000e7602', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e7601', 'merida', 'America/Merida'),
  ('00000000-0000-0000-0000-0000000e76a2', '00000000-0000-0000-0000-0000000e7601', 'cancun', 'America/Cancun'),
  ('00000000-0000-0000-0000-0000000e76a3', '00000000-0000-0000-0000-0000000e7601', 'saturacion', 'America/Merida'),
  ('00000000-0000-0000-0000-0000000e76a4', '00000000-0000-0000-0000-0000000e7601', 'cierre-pm', 'America/Merida'),
  ('00000000-0000-0000-0000-0000000e76a5', '00000000-0000-0000-0000-0000000e7601', 'calendario', 'America/Merida'),
  ('00000000-0000-0000-0000-0000000e76a6', '00000000-0000-0000-0000-0000000e7601', 'voz', 'America/Mexico_City'),
  ('00000000-0000-0000-0000-0000000e76b1', '00000000-0000-0000-0000-0000000e7602', 'b1', null)
on conflict do nothing;

-- Horario real de PM: todos los dias 12:00 a 01:00 (el turno cruza la medianoche). A3, A5 y A6 NO tienen horario.
insert into restaurantes.branch_policy (property_id, organization_id, horario) values
  ('00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e7601', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]'::jsonb),
  ('00000000-0000-0000-0000-0000000e76a2', '00000000-0000-0000-0000-0000000e7601', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]'::jsonb),
  ('00000000-0000-0000-0000-0000000e76a4', '00000000-0000-0000-0000-0000000e7601', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]'::jsonb)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e7611', 'owner-a@qa-r2.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e7615', 'owner-b@qa-r2.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e7611', '00000000-0000-0000-0000-0000000e7601', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e7615', '00000000-0000-0000-0000-0000000e7602', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-0000000e76c1', '00000000-0000-0000-0000-0000000e7601', 'Gringa de pastor', 85),
  ('00000000-0000-0000-0000-0000000e76c2', '00000000-0000-0000-0000-0000000e7601', 'Agua de horchata', 35)
on conflict do nothing;
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values
  ('00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e76c1', 85, true),
  ('00000000-0000-0000-0000-0000000e76a2', '00000000-0000-0000-0000-0000000e76c2', 35, true),
  ('00000000-0000-0000-0000-0000000e76a5', '00000000-0000-0000-0000-0000000e76c1', 85, true)
on conflict do nothing;

-- Voz (A6, dia local de HOY): 6 llamadas, 5 USD de voz = 10000 centavos >= 8000 y 3 errores = 50% >= 40% -> las DOS alertas.
insert into core.fx_rate (fecha, mxn_por_usd, fuente) values ('2026-03-01', 20.0000, 'fixture de prueba') on conflict do nothing;
insert into restaurantes.voice_alert_config (property_id, organization_id, umbral_costo_dia_centavos_mxn, umbral_tasa_error_pct, min_llamadas_tasa_error) values
  ('00000000-0000-0000-0000-0000000e76a6', '00000000-0000-0000-0000-0000000e7601', 8000, 40, 5)
on conflict do nothing;
insert into restaurantes.voice_conversation (organization_id, property_id, external_id, canal, proveedor, voice_id, started_at, costo_estimado_micro_usd, resultado)
  select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a6', 'qa-r2-voz-' || g, 'llamada', 'gemini-3.8-live', 'Puck', now(), case when g = 1 then 5000000 else 0 end, 'pedido_creado'
  from generate_series(1, 6) g;
insert into restaurantes.voice_event (organization_id, property_id, tipo, proveedor, codigo, ocurrido_at)
  select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a6', 'error_proveedor', 'twilio', '31005', now()
  from generate_series(1, 3);

-- =====================================================================================================================
-- A. Dia de negocio y agotados (automatizacion-02)
-- =====================================================================================================================
\echo '=== A1. corte del dia de negocio de PM (turno 12:00-01:00) = 1 hora ==='
begin;
select (restaurantes.dia_negocio_corte('00000000-0000-0000-0000-0000000e76a1') = interval '1 hour')::int as corte_pm_deberia_ser_1;
rollback;

\echo '=== A2. sin horario el corte es 0 y el dia de negocio es el dia calendario ==='
begin;
select (restaurantes.dia_negocio('00000000-0000-0000-0000-0000000e76a5', timestamptz '2026-10-11 06:30:00+00') = date '2026-10-11')::int as dia_calendario_sin_horario_deberia_ser_1;
rollback;

\echo '=== A3. a las 00:30 del domingo (06:30Z) en Merida todavia es el dia de negocio del SABADO ==='
begin;
select (restaurantes.dia_negocio('00000000-0000-0000-0000-0000000e76a1', timestamptz '2026-10-11 06:30:00+00') = date '2026-10-10')::int as dia_negocio_sabado_deberia_ser_1;
rollback;

\echo '=== A4. agotado marcado el sabado: a las 00:10 del domingo (Merida, 06:10Z) NO se repone (turno abierto hasta la 01:00) ==='
begin;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-0000000e76a1' and product_id = '00000000-0000-0000-0000-0000000e76c1';
select count(*) as repuestos_merida_0010_deberia_ser_0 from restaurantes.agotados_reponer(timestamptz '2026-10-11 06:10:00+00') where property_id = '00000000-0000-0000-0000-0000000e76a1';
rollback;

\echo '=== A5. lo mismo en Cancun (UTC-5): a las 00:05 del domingo (05:05Z) NO se repone ==='
begin;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-0000000e76a2' and product_id = '00000000-0000-0000-0000-0000000e76c2';
select count(*) as repuestos_cancun_0005_deberia_ser_0 from restaurantes.agotados_reponer(timestamptz '2026-10-11 05:05:00+00') where property_id = '00000000-0000-0000-0000-0000000e76a2';
rollback;

\echo '=== A6. al terminar el turno (01:10 del domingo en Merida, 07:10Z) SI se repone, antes de que abra a las 12:00 ==='
begin;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-0000000e76a1' and product_id = '00000000-0000-0000-0000-0000000e76c1';
select count(*) as repuestos_merida_0110_deberia_ser_1 from restaurantes.agotados_reponer(timestamptz '2026-10-11 07:10:00+00') where property_id = '00000000-0000-0000-0000-0000000e76a1';
rollback;

\echo '=== A7. de dia (11:00 del domingo, 17:00Z) se repone y es idempotente (la segunda corrida no repone nada) ==='
begin;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-0000000e76a1' and product_id = '00000000-0000-0000-0000-0000000e76c1';
select count(*) from restaurantes.agotados_reponer(timestamptz '2026-10-11 17:00:00+00') where property_id = '00000000-0000-0000-0000-0000000e76a1';
select count(*) as repuestos_segunda_corrida_deberia_ser_0 from restaurantes.agotados_reponer(timestamptz '2026-10-11 17:05:00+00') where property_id = '00000000-0000-0000-0000-0000000e76a1';
rollback;

\echo '=== A8. sin horario (calendario) el comportamiento no cambia: se repone a las 00:10 del domingo ==='
begin;
update restaurantes.branch_products set is_available = false, agotado_hasta = date '2026-10-11'
 where property_id = '00000000-0000-0000-0000-0000000e76a5' and product_id = '00000000-0000-0000-0000-0000000e76c1';
select count(*) as repuestos_calendario_0010_deberia_ser_1 from restaurantes.agotados_reponer(timestamptz '2026-10-11 06:10:00+00') where property_id = '00000000-0000-0000-0000-0000000e76a5';
rollback;

\echo '=== A9. agotados_reponer es solo de sistema: un usuario recibe 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select public.t_esperar_error($q$select * from restaurantes.agotados_reponer(timestamptz '2026-10-11 17:00:00+00')$q$, '42501');
rollback;

\echo '=== A10. agotado_marcar: "hasta manana de negocio" (dia de negocio de hoy + 1) se acepta ==='
begin;
create temp table t_dia on commit drop as select restaurantes.dia_negocio('00000000-0000-0000-0000-0000000e76a1', now()) as d;
grant select on t_dia to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select (restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e76c1', (select d + 1 from t_dia)))::int as marcado_manana_deberia_ser_1;
rollback;

\echo '=== A11. agotado_marcar: el dia de negocio de HOY (aunque el calendario ya sea el siguiente) se rechaza con 22023 ==='
begin;
create temp table t_dia on commit drop as select restaurantes.dia_negocio('00000000-0000-0000-0000-0000000e76a1', now()) as d;
grant select on t_dia to authenticated;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select public.t_esperar_error(format($q$select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e76c1', %L::date)$q$, (select d from t_dia)), '22023');
rollback;

\echo '=== A12. cross-tenant: el owner de B no marca agotados de A (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7615', true);
select public.t_esperar_error($q$select restaurantes.agotado_marcar('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e76c1', date '2099-01-01')$q$, '42501');
rollback;

\echo '=== A13. los helpers del dia de negocio no son invocables por clientes (authenticated y anon: 42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select public.t_esperar_error($q$select restaurantes.dia_negocio_corte('00000000-0000-0000-0000-0000000e76a1')$q$, '42501');
select public.t_esperar_error($q$select restaurantes.dia_negocio('00000000-0000-0000-0000-0000000e76a1', now())$q$, '42501');
rollback;

-- =====================================================================================================================
-- B. Saturacion con ventana (automatizacion-03)
-- =====================================================================================================================
\echo '=== B1. 12 pedidos olvidados de hace 2 a 4 dias NO cuentan como abiertos ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a3', 'Olvidado ' || g, '99900000' || lpad(g::text, 2, '0'), 100,
       case when g <= 8 then 'en_camino' else 'listo_para_recoger' end, '[]', case when g <= 8 then 'whatsapp' else 'web' end,
       timestamptz '2026-10-07 01:00:00+00' - make_interval(days => 1 + (g % 3)), case when g <= 8 then 'domicilio' else 'recoger' end, null
  from generate_series(1, 12) g;
select (restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a3', 'domicilio', timestamptz '2026-10-08 01:00:00+00', 30)->>'abiertos')::int as abiertos_historicos_deberia_ser_0;
rollback;

\echo '=== B2. un pedido abierto de hace 3 horas SI cuenta (y los viejos siguen sin contar) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal)
select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a3', 'Olvidado ' || g, '99900000' || lpad(g::text, 2, '0'), 100, 'en_camino', '[]', 'whatsapp',
       timestamptz '2026-10-07 01:00:00+00' - make_interval(days => 2), 'domicilio'
  from generate_series(1, 5) g;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal)
values ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a3', 'Hoy', '9991110000', 100, 'pending', '[]', 'whatsapp', timestamptz '2026-10-07 22:00:00+00', 'domicilio');
select (restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a3', 'domicilio', timestamptz '2026-10-08 01:00:00+00', 30)->>'abiertos')::int as abiertos_de_hoy_deberia_ser_1;
rollback;

\echo '=== B3. cross-tenant: el owner de B no consulta muestras de A (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7615', true);
select public.t_esperar_error($q$select restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a3', 'domicilio', now(), 30)$q$, '42501');
rollback;

-- =====================================================================================================================
-- C. Estados sin clic con referencia de respaldo (automatizacion-04, caos-03)
-- =====================================================================================================================
\echo '=== C1. recoger SIN hora_recogida, listo desde hace 7 h: candidato a no_recogido ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-0000000e76d1', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Recoge web', '9991112233', 170, 'listo_para_recoger', '[]', 'web', timestamptz '2026-10-07 17:00:00+00', 'recoger', null);
update restaurantes.order_status_events set at = timestamptz '2026-10-07 18:00:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d1' and to_status = 'listo_para_recoger';
select count(*) as candidato_recoger_sin_hora_deberia_ser_1 from restaurantes.autopiloto_candidatos_estados(timestamptz '2026-10-08 01:00:00+00', 1000) where order_id = '00000000-0000-0000-0000-0000000e76d1' and to_status = 'no_recogido';
rollback;

\echo '=== C2. el mismo pedido, a los 30 min de quedar listo: todavia NO es candidato (plazo de 60 min) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-0000000e76d1', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Recoge web', '9991112233', 170, 'listo_para_recoger', '[]', 'web', timestamptz '2026-10-07 17:00:00+00', 'recoger', null);
update restaurantes.order_status_events set at = timestamptz '2026-10-07 18:00:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d1' and to_status = 'listo_para_recoger';
select count(*) as candidato_a_los_30_min_deberia_ser_0 from restaurantes.autopiloto_candidatos_estados(timestamptz '2026-10-07 18:30:00+00', 1000) where order_id = '00000000-0000-0000-0000-0000000e76d1';
rollback;

\echo '=== C3. cocina atrasada: hora de recogida 13:00, el pedido queda listo a las 14:05 y el tick corre a las 14:05: NO es no_recogido ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-0000000e76d2', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Tarde', '5512340001', 90, 'listo_para_recoger', '[]', 'whatsapp', timestamptz '2026-10-05 17:00:00+00', 'recoger', timestamptz '2026-10-05 19:00:00+00');
update restaurantes.order_status_events set at = timestamptz '2026-10-05 20:05:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d2' and to_status = 'listo_para_recoger';
select count(*) as no_recogido_recien_listo_deberia_ser_0 from restaurantes.autopiloto_candidatos_estados(timestamptz '2026-10-05 20:05:00+00', 1000) where order_id = '00000000-0000-0000-0000-0000000e76d2' and to_status = 'no_recogido';
rollback;

\echo '=== C4. ...y 61 min despues de quedar listo SI es no_recogido ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-0000000e76d2', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Tarde', '5512340001', 90, 'listo_para_recoger', '[]', 'whatsapp', timestamptz '2026-10-05 17:00:00+00', 'recoger', timestamptz '2026-10-05 19:00:00+00');
update restaurantes.order_status_events set at = timestamptz '2026-10-05 20:05:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d2' and to_status = 'listo_para_recoger';
select count(*) as no_recogido_a_los_61_min_deberia_ser_1 from restaurantes.autopiloto_candidatos_estados(timestamptz '2026-10-05 21:06:00+00', 1000) where order_id = '00000000-0000-0000-0000-0000000e76d2' and to_status = 'no_recogido';
rollback;

\echo '=== C5. el cliente llega tarde: el staff re-marca listo (nuevo evento 21:10) y el tick de las 21:12 NO lo regresa a no_recogido ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-0000000e76d2', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Tarde', '5512340001', 90, 'listo_para_recoger', '[]', 'whatsapp', timestamptz '2026-10-05 17:00:00+00', 'recoger', timestamptz '2026-10-05 19:00:00+00');
update restaurantes.order_status_events set at = timestamptz '2026-10-05 20:00:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d2' and to_status = 'listo_para_recoger';
insert into restaurantes.order_status_events (order_id, organization_id, property_id, from_status, to_status, actor, at)
values ('00000000-0000-0000-0000-0000000e76d2', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'preparando', 'listo_para_recoger', 'sistema', timestamptz '2026-10-05 21:10:00+00');
select count(*) as re_marcado_listo_deberia_ser_0 from restaurantes.autopiloto_candidatos_estados(timestamptz '2026-10-05 21:12:00+00', 1000) where order_id = '00000000-0000-0000-0000-0000000e76d2' and to_status = 'no_recogido';
rollback;

\echo '=== C6. un en_camino olvidado de hace 37 h NO se cierra solo (ningun candidato de estado) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal)
values ('00000000-0000-0000-0000-0000000e76d3', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Olvidado', '9991112255', 150, 'en_camino', '[]', 'whatsapp', timestamptz '2026-10-06 12:00:00+00', 'domicilio');
update restaurantes.order_status_events set at = timestamptz '2026-10-06 12:30:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d3' and to_status = 'en_camino';
select count(*) as en_camino_olvidado_sin_cierre_solo_deberia_ser_0 from restaurantes.autopiloto_candidatos_estados(timestamptz '2026-10-08 01:00:00+00', 1000) where order_id = '00000000-0000-0000-0000-0000000e76d3';
rollback;

\echo '=== C7. autopiloto_candidatos_estados es solo de sistema: un usuario recibe 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select public.t_esperar_error($q$select * from restaurantes.autopiloto_candidatos_estados(now(), 10)$q$, '42501');
rollback;

-- =====================================================================================================================
-- D. Alertas operativas nuevas (automatizacion-04, -05)
-- =====================================================================================================================
\echo '=== D1. aviso de pedido ESTANCADO: listo_para_recoger desde hace 7 h ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-0000000e76d1', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Recoge web', '9991112233', 170, 'listo_para_recoger', '[]', 'web', timestamptz '2026-10-07 17:00:00+00', 'recoger', null);
update restaurantes.order_status_events set at = timestamptz '2026-10-07 18:00:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d1' and to_status = 'listo_para_recoger';
select count(*) as aviso_estancado_recoger_deberia_ser_1 from restaurantes.avisos_operativos_candidatos(timestamptz '2026-10-08 01:00:00+00') where order_id = '00000000-0000-0000-0000-0000000e76d1' and tipo = 'restaurantes.pedido.estancado';
rollback;

\echo '=== D2. aviso de pedido ESTANCADO: en_camino desde hace 30 h (la ventana de entrega tardia de 24 h ya paso) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal)
values ('00000000-0000-0000-0000-0000000e76d3', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Olvidado', '9991112255', 150, 'en_camino', '[]', 'whatsapp', timestamptz '2026-10-06 12:00:00+00', 'domicilio');
update restaurantes.order_status_events set at = timestamptz '2026-10-06 19:00:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d3' and to_status = 'en_camino';
select count(*) as aviso_estancado_en_camino_deberia_ser_1 from restaurantes.avisos_operativos_candidatos(timestamptz '2026-10-08 01:00:00+00') where order_id = '00000000-0000-0000-0000-0000000e76d3' and tipo = 'restaurantes.pedido.estancado';
rollback;

\echo '=== D3. un listo_para_recoger de hace 2 h todavia NO es estancado (umbral de 6 h) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal, hora_recogida)
values ('00000000-0000-0000-0000-0000000e76d1', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Recoge web', '9991112233', 170, 'listo_para_recoger', '[]', 'web', timestamptz '2026-10-07 22:00:00+00', 'recoger', null);
update restaurantes.order_status_events set at = timestamptz '2026-10-07 23:00:00+00' where order_id = '00000000-0000-0000-0000-0000000e76d1' and to_status = 'listo_para_recoger';
select count(*) as aviso_estancado_reciente_deberia_ser_0 from restaurantes.avisos_operativos_candidatos(timestamptz '2026-10-08 01:00:00+00') where order_id = '00000000-0000-0000-0000-0000000e76d1' and tipo = 'restaurantes.pedido.estancado';
rollback;

\echo '=== D4. aviso de pedido SIN ACEPTAR: pending desde hace 2 h ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal)
values ('00000000-0000-0000-0000-0000000e76d4', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Sin aceptar', '9991112244', 240, 'pending', '[]', 'whatsapp', timestamptz '2026-10-07 23:00:00+00', 'domicilio');
select count(*) as aviso_sin_aceptar_deberia_ser_1 from restaurantes.avisos_operativos_candidatos(timestamptz '2026-10-08 01:00:00+00') where order_id = '00000000-0000-0000-0000-0000000e76d4' and tipo = 'restaurantes.pedido.sin_aceptar';
rollback;

\echo '=== D5. un pending de hace 5 min NO genera aviso (umbral de 15 min) ==='
begin;
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, canal)
values ('00000000-0000-0000-0000-0000000e76d4', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Sin aceptar', '9991112244', 240, 'pending', '[]', 'whatsapp', timestamptz '2026-10-07 23:55:00+00', 'domicilio');
select count(*) as aviso_sin_aceptar_reciente_deberia_ser_0 from restaurantes.avisos_operativos_candidatos(timestamptz '2026-10-08 00:00:00+00') where order_id = '00000000-0000-0000-0000-0000000e76d4';
rollback;

\echo '=== D6. avisos_operativos_candidatos sigue siendo solo de sistema: un usuario recibe 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select public.t_esperar_error($q$select * from restaurantes.avisos_operativos_candidatos(now())$q$, '42501');
rollback;

-- =====================================================================================================================
-- E. Muestras del tiempo prometido (automatizacion-11, caos-10)
-- =====================================================================================================================
\echo '=== E1. las 25 entregas de las 23:xx de sabados anteriores cuentan a las 00:20 del domingo (turno del sabado, franja circular) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal)
select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Muestra ' || g, '99800000' || lpad(g::text, 2, '0'), 120, 'completado', '[]', 'whatsapp',
       timestamptz '2026-10-04 05:10:00+00' - make_interval(days => 7 * (g % 5)), timestamptz '2026-10-04 05:50:00+00' - make_interval(days => 7 * (g % 5)), 'domicilio'
  from generate_series(1, 25) g;
select jsonb_array_length(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'domicilio', timestamptz '2026-10-11 06:20:00+00', 30)->'muestras') as muestras_cruce_medianoche_deberia_ser_25;
rollback;

\echo '=== E2. las mismas entregas NO cuentan a mediodia del domingo (otra franja y otro dia de negocio) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal)
select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'Muestra ' || g, '99800000' || lpad(g::text, 2, '0'), 120, 'completado', '[]', 'whatsapp',
       timestamptz '2026-10-04 05:10:00+00' - make_interval(days => 7 * (g % 5)), timestamptz '2026-10-04 05:50:00+00' - make_interval(days => 7 * (g % 5)), 'domicilio'
  from generate_series(1, 25) g;
select jsonb_array_length(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'domicilio', timestamptz '2026-10-11 18:20:00+00', 30)->'muestras') as muestras_otra_franja_deberia_ser_0;
rollback;

\echo '=== E3. recoger: 20 pedidos con hora de recogida ELEGIDA (alta + 90 min) NO son muestras de la cocina ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal, hora_recogida)
select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Programa ' || g, '55990000' || lpad(g::text, 2, '0'), 90, 'entregado', '[]', 'whatsapp',
       timestamptz '2026-09-28 18:00:00+00', timestamptz '2026-09-28 18:00:00+00' + interval '92 minutes', 'recoger', timestamptz '2026-09-28 18:00:00+00' + interval '90 minutes'
  from generate_series(1, 20) g;
select jsonb_array_length(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'recoger', timestamptz '2026-10-05 18:30:00+00', 30)->'muestras') as muestras_hora_elegida_deberia_ser_0;
rollback;

\echo '=== E4. recoger sin hora elegida: la muestra mide hasta quedar LISTO (15 min), no hasta que el cliente pasa (92 min) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal, hora_recogida)
select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Inmediato ' || g, '55990000' || lpad(g::text, 2, '0'), 90, 'entregado', '[]', 'web',
       timestamptz '2026-09-28 18:00:00+00', timestamptz '2026-09-28 18:00:00+00' + interval '92 minutes', 'recoger', null
  from generate_series(1, 20) g;
insert into restaurantes.order_status_events (order_id, organization_id, property_id, from_status, to_status, actor, at)
select o.id, o.organization_id, o.property_id, 'preparando', 'listo_para_recoger', 'sistema', o.created_at + interval '15 minutes'
  from restaurantes.orders o where o.property_id = '00000000-0000-0000-0000-0000000e76a5' and o.canal = 'recoger';
select (restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'recoger', timestamptz '2026-10-05 18:30:00+00', 30)->'muestras'->>0)::numeric::int as minutos_de_cocina_deberia_ser_15;
rollback;

\echo '=== E5. domicilio no cambia: 20 entregas a 40 min en la misma franja son 20 muestras ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal)
select '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Dom ' || g, '55880000' || lpad(g::text, 2, '0'), 90, 'entregado', '[]', 'whatsapp',
       timestamptz '2026-09-28 18:00:00+00', timestamptz '2026-09-28 18:40:00+00', 'domicilio'
  from generate_series(1, 20) g;
select jsonb_array_length(restaurantes.tiempo_entrega_muestras('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'domicilio', timestamptz '2026-10-05 18:30:00+00', 30)->'muestras') as muestras_domicilio_deberia_ser_20;
rollback;

-- =====================================================================================================================
-- F. Cierre del dia por dia de negocio (automatizacion-08)
-- =====================================================================================================================
\echo '=== F1. sabado 3-oct: 2 pedidos a las 21:00 y 2 a las 00:30-00:40 del turno del sabado: el cierre del sabado cuenta los 4 ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Cena 1', '9997770001', 300, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 03:00:00+00', timestamptz '2026-10-04 03:40:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Cena 2', '9997770002', 300, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 03:05:00+00', timestamptz '2026-10-04 03:45:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Trasnoche 1', '9997770003', 500, 'entregado', '[]', 'voice', timestamptz '2026-10-04 06:30:00+00', timestamptz '2026-10-04 07:00:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Trasnoche 2', '9997770004', 500, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 06:40:00+00', timestamptz '2026-10-04 07:05:00+00', 'domicilio');
select (c.datos ->> 'pedidos')::int as pedidos_del_turno_deberia_ser_4 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'dia', date '2026-10-03') c;
rollback;

\echo '=== F2. ...con ventas de 1,600 MXN (160000 centavos) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Cena 1', '9997770001', 300, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 03:00:00+00', timestamptz '2026-10-04 03:40:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Cena 2', '9997770002', 300, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 03:05:00+00', timestamptz '2026-10-04 03:45:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Trasnoche 1', '9997770003', 500, 'entregado', '[]', 'voice', timestamptz '2026-10-04 06:30:00+00', timestamptz '2026-10-04 07:00:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Trasnoche 2', '9997770004', 500, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 06:40:00+00', timestamptz '2026-10-04 07:05:00+00', 'domicilio');
select (c.datos ->> 'ventas_centavos')::bigint / 100 as ventas_del_turno_deberia_ser_1600 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'dia', date '2026-10-03') c;
rollback;

\echo '=== F3. el cierre del DOMINGO 4-oct ya no recibe la cola del turno del sabado (0 pedidos) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Trasnoche 1', '9997770003', 500, 'entregado', '[]', 'voice', timestamptz '2026-10-04 06:30:00+00', timestamptz '2026-10-04 07:00:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Trasnoche 2', '9997770004', 500, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 06:40:00+00', timestamptz '2026-10-04 07:05:00+00', 'domicilio');
select (c.datos ->> 'pedidos_totales_incl_cancelados')::int as pedidos_del_domingo_deberia_ser_0 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'dia', date '2026-10-04') c;
rollback;

\echo '=== F4. un pedido del domingo a las 13:00 (19:00Z) SI cuenta en el cierre del domingo ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'Comida', '9997770009', 250, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 19:00:00+00', timestamptz '2026-10-04 19:40:00+00', 'domicilio');
select (c.datos ->> 'pedidos')::int as pedidos_del_domingo_comida_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'dia', date '2026-10-04') c;
rollback;

\echo '=== F5. sin horario el cierre sigue por dia calendario (21:00 cuenta, 00:30 del dia siguiente no) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, canal) values
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Cena', '9997770011', 300, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 03:00:00+00', timestamptz '2026-10-04 03:40:00+00', 'domicilio'),
  ('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'Trasnoche', '9997770012', 500, 'entregado', '[]', 'whatsapp', timestamptz '2026-10-04 06:30:00+00', timestamptz '2026-10-04 07:00:00+00', 'domicilio');
select (c.datos ->> 'pedidos')::int as pedidos_calendario_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a5', 'dia', date '2026-10-03') c;
rollback;

\echo '=== F6. el periodo de hoy (dia de negocio abierto) sigue sin poder cerrarse (22023) ==='
begin;
create temp table t_dia on commit drop as select restaurantes.dia_negocio('00000000-0000-0000-0000-0000000e76a4', now()) as d;
select public.t_esperar_error(format($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a4', 'dia', %L::date)$q$, (select d from t_dia)), '22023');
rollback;

-- =====================================================================================================================
-- G. Regreso del handoff con el agente apagado (caos-01)
-- =====================================================================================================================
\echo '=== G1. agente de WhatsApp APAGADO y una toma tomada hace 30 min sin respuesta: el tick NO la devuelve ==='
begin;
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo)
values ('00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e7601', false)
on conflict (property_id) do update set agente_activo = false;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages)
values ('00000000-0000-0000-0000-0000000e76f1', '00000000-0000-0000-0000-0000000e7601', '5512340003', '00000000-0000-0000-0000-0000000e76a1', '[{"role":"user","content":"quiero pedir"}]');
insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo, solicitada_at, ultimo_cliente_at, tomada_at)
values ('00000000-0000-0000-0000-0000000e76f2', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'whatsapp', '00000000-0000-0000-0000-0000000e76f1',
        'tomada', 'agente', 'agente_apagado', timestamptz '2026-10-07 11:20:00+00', timestamptz '2026-10-07 11:30:00+00', timestamptz '2026-10-07 11:30:00+00');
select count(*) as devuelta_con_agente_apagado_deberia_ser_0 from restaurantes.handoffs_devolver_vencidos(timestamptz '2026-10-07 12:00:00+00', 200) d where d.handoff_id = '00000000-0000-0000-0000-0000000e76f2';
rollback;

\echo '=== G2. ...y la frase "le sigo atendiendo yo" no se encola ==='
begin;
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo)
values ('00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e7601', false)
on conflict (property_id) do update set agente_activo = false;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages)
values ('00000000-0000-0000-0000-0000000e76f1', '00000000-0000-0000-0000-0000000e7601', '5512340003', '00000000-0000-0000-0000-0000000e76a1', '[{"role":"user","content":"quiero pedir"}]');
insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo, solicitada_at, ultimo_cliente_at, tomada_at)
values ('00000000-0000-0000-0000-0000000e76f2', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'whatsapp', '00000000-0000-0000-0000-0000000e76f1',
        'tomada', 'agente', 'agente_apagado', timestamptz '2026-10-07 11:20:00+00', timestamptz '2026-10-07 11:30:00+00', timestamptz '2026-10-07 11:30:00+00');
select count(*) from restaurantes.handoffs_devolver_vencidos(timestamptz '2026-10-07 12:00:00+00', 200);
select count(*) as frase_encolada_deberia_ser_0 from restaurantes.messaging_outbox m where m.dedupe_key = 'handoff-regreso:00000000-0000-0000-0000-0000000e76f2';
rollback;

\echo '=== G3. con el agente ENCENDIDO la misma toma SI se devuelve (el regreso automatico sigue funcionando) ==='
begin;
insert into restaurantes.whatsapp_sucursal_control (property_id, organization_id, agente_activo)
values ('00000000-0000-0000-0000-0000000e76a1', '00000000-0000-0000-0000-0000000e7601', true)
on conflict (property_id) do update set agente_activo = true;
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages)
values ('00000000-0000-0000-0000-0000000e76f1', '00000000-0000-0000-0000-0000000e7601', '5512340003', '00000000-0000-0000-0000-0000000e76a1', '[{"role":"user","content":"quiero pedir"}]');
insert into restaurantes.conversation_handoff (id, organization_id, property_id, canal, conversation_id, estado, solicitado_por, motivo, solicitada_at, ultimo_cliente_at, tomada_at)
values ('00000000-0000-0000-0000-0000000e76f2', '00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a1', 'whatsapp', '00000000-0000-0000-0000-0000000e76f1',
        'tomada', 'agente', 'escalacion', timestamptz '2026-10-07 11:20:00+00', timestamptz '2026-10-07 11:30:00+00', timestamptz '2026-10-07 11:30:00+00');
select count(*) as devuelta_con_agente_encendido_deberia_ser_1 from restaurantes.handoffs_devolver_vencidos(timestamptz '2026-10-07 12:00:00+00', 200) d where d.handoff_id = '00000000-0000-0000-0000-0000000e76f2';
rollback;

-- =====================================================================================================================
-- I. Reimportar de cartera (caos-07)
-- =====================================================================================================================
\echo '=== I1. mapeo equivocado: reimportar con OTRA huella (otro mapeo) corrige el nombre que escribio la primera importacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Itzimná","address":"Sin dirección","notes":""}]'::jsonb);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[{"phone":"9991230001","name":"José Peña","address":"Calle 1 x 2 y 4, Itzimná","notes":""}]'::jsonb);
reset role;
select count(*) as nombre_corregido_deberia_ser_1 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e7601' and phone = '9991230001' and name = 'José Peña';
rollback;

\echo '=== I2. ...y el domicilio importado por error deja de ser el predeterminado (queda el nuevo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Itzimná","address":"Sin dirección","notes":""}]'::jsonb);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[{"phone":"9991230001","name":"José Peña","address":"Calle 1 x 2 y 4, Itzimná","notes":""}]'::jsonb);
reset role;
select count(*) as predeterminado_nuevo_deberia_ser_1 from restaurantes.customer_addresses a join restaurantes.customers c on c.id = a.customer_id where c.organization_id = '00000000-0000-0000-0000-0000000e7601' and c.phone = '9991230001' and a.is_default and a.address = 'Calle 1 x 2 y 4, Itzimná';
rollback;

\echo '=== I3. ...sin dejar dos predeterminados ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Itzimná","address":"Sin dirección","notes":""}]'::jsonb);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[{"phone":"9991230001","name":"José Peña","address":"Calle 1 x 2 y 4, Itzimná","notes":""}]'::jsonb);
reset role;
select count(*) as predeterminados_deberia_ser_1 from restaurantes.customer_addresses a join restaurantes.customers c on c.id = a.customer_id where c.organization_id = '00000000-0000-0000-0000-0000000e7601' and c.phone = '9991230001' and a.is_default;
rollback;

\echo '=== I4. la misma importacion (misma huella) es idempotente: ya_importado = true y no escribe nada ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Itzimná","address":"Sin dirección","notes":""}]'::jsonb);
select (select ya_importado from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Otro","address":"","notes":""}]'::jsonb))::int as ya_importado_deberia_ser_1;
rollback;

\echo '=== I5. NO pisa un nombre que una persona cambio despues de la importacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"Itzimná","address":"Sin dirección","notes":""}]'::jsonb);
reset role;
update restaurantes.customers set name = 'Pepe (el de siempre)' where organization_id = '00000000-0000-0000-0000-0000000e7601' and phone = '9991230001';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[{"phone":"9991230001","name":"José Peña","address":"Calle 1 x 2 y 4, Itzimná","notes":""}]'::jsonb);
reset role;
select count(*) as nombre_de_persona_intacto_deberia_ser_1 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e7601' and phone = '9991230001' and name = 'Pepe (el de siempre)';
rollback;

\echo '=== I6. NO pisa el nombre de un cliente que ya existia (lo escribio otro flujo, no una importacion) ==='
begin;
insert into restaurantes.customers (organization_id, phone, name) values ('00000000-0000-0000-0000-0000000e7601', '9991230001', 'Nombre del agente');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[{"phone":"9991230001","name":"José Peña","address":"Calle 1 x 2 y 4, Itzimná","notes":""}]'::jsonb);
reset role;
select count(*) as nombre_previo_intacto_deberia_ser_1 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-0000000e7601' and phone = '9991230001' and name = 'Nombre del agente';
rollback;

\echo '=== I7. un domicilio confirmado por el cliente (no vino de una importacion) sigue siendo el predeterminado ==='
begin;
insert into restaurantes.customers (id, organization_id, phone, name) values ('00000000-0000-0000-0000-0000000e76c9', '00000000-0000-0000-0000-0000000e7601', '9991230001', 'Ana');
insert into restaurantes.customer_addresses (customer_id, address, is_default) values ('00000000-0000-0000-0000-0000000e76c9', 'Casa de Ana', true);
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select ya_importado, creados, actualizados, sin_cambios from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', '[{"phone":"9991230001","name":"Ana","address":"Calle 1 x 2 y 4, Itzimná","notes":""}]'::jsonb);
reset role;
select count(*) as domicilio_confirmado_sigue_deberia_ser_1 from restaurantes.customer_addresses where customer_id = '00000000-0000-0000-0000-0000000e76c9' and is_default and address = 'Casa de Ana';
rollback;

\echo '=== I8. cross-tenant: el owner de B no importa clientes a la organizacion A (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7615', true);
select public.t_esperar_error($q$select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"X","address":"","notes":""}]'::jsonb)$q$, '42501');
rollback;

\echo '=== I9. la sesion de sistema y anon no importan clientes (42501) ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"X","address":"","notes":""}]'::jsonb)$q$, '42501');
rollback;

begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.importar_clientes('00000000-0000-0000-0000-0000000e7601', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', '[{"phone":"9991230001","name":"X","address":"","notes":""}]'::jsonb)$q$, '42501');
rollback;

-- =====================================================================================================================
-- H. Alertas de voz evaluadas por el sistema (automatizacion-09)
-- =====================================================================================================================
\echo '=== H1. el sistema evalua sin boton: costo del dia y tasa de error disparan 2 alertas nuevas ==='
begin;
select count(*) as alertas_nuevas_deberia_ser_2 from restaurantes.voz_alertas_evaluar_sistema();
rollback;

\echo '=== H2. idempotente: la segunda evaluacion del dia no devuelve alertas nuevas ==='
begin;
select count(*) from restaurantes.voz_alertas_evaluar_sistema();
select count(*) as segunda_evaluacion_deberia_ser_0 from restaurantes.voz_alertas_evaluar_sistema();
rollback;

\echo '=== H3. las alertas quedan en voice_alert (2 filas) y NO escribe audit_log (actor_user_id es NOT NULL) ==='
begin;
select count(*) from restaurantes.voz_alertas_evaluar_sistema();
select count(*) as filas_en_voice_alert_deberia_ser_2 from restaurantes.voice_alert where property_id = '00000000-0000-0000-0000-0000000e76a6';
rollback;

\echo '=== H4. sin audit_log de sistema ==='
begin;
select count(*) from restaurantes.voz_alertas_evaluar_sistema();
select count(*) as audit_log_de_voz_deberia_ser_0 from restaurantes.audit_log where action like 'voz.alerta%';
rollback;

\echo '=== H5. RECHAZADO: un usuario autenticado no llama al barrido de sistema (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select public.t_esperar_error($q$select * from restaurantes.voz_alertas_evaluar_sistema()$q$, '42501');
rollback;

\echo '=== H6. RECHAZADO: anon no ejecuta el barrido (permiso denegado 42501) ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.voz_alertas_evaluar_sistema()$q$, '42501');
rollback;

\echo '=== H7. RECHAZADO: un usuario no usa las copias de sistema (42501) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select public.t_esperar_error($q$select * from restaurantes.voz_evaluar_alertas_sistema('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a6')$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios_sistema('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a6', current_date, current_date)$q$, '42501');
rollback;

\echo '=== H8. cross-tenant: el sistema no evalua una sucursal de OTRA organizacion (42501) ==='
begin;
select public.t_esperar_error($q$select * from restaurantes.voz_evaluar_alertas_sistema('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76b1')$q$, '42501');
rollback;

\echo '=== H9. las funciones ORIGINALES de usuario no cambian: la sesion de sistema sigue sin leer KPI ni evaluar con ellas (42501) ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a6')$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a6', current_date, current_date)$q$, '42501');
rollback;

\echo '=== H10. el owner de A sigue pudiendo evaluar con la funcion de usuario (positivo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e7611', true);
select count(*) as alertas_del_owner_deberia_ser_2 from restaurantes.voz_evaluar_alertas('00000000-0000-0000-0000-0000000e7601', '00000000-0000-0000-0000-0000000e76a6');
rollback;
