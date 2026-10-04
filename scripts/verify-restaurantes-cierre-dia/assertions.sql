-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/041_cierre_dia_resumen_semanal.sql: cierre del dia y resumen semanal (R-42).
--
--   A. Agregados exactos del dia 2026-03-10 de la sucursal A1 (Mexico, UTC-6): pedidos, ventas, ticket, cancelados,
--      no recogidos, programado excluido, programado promovido ese dia incluido, trafico demo (0009) excluido, otra sucursal
--      excluida, pedido a las 23:59 local incluido y a las 00:00 local del dia siguiente excluido, por canal, tiempos de
--      entrega (promedio/mediana/p90), comparativo contra el mismo dia de la semana pasada.
--   B. Semana lunes-domingo (2026-03-09..15): total, por_dia de 7 dias y comparativo con la semana anterior.
--   C. Idempotencia: llamar dos veces genera UNA fila y la segunda devuelve creado = false con el mismo id; congelado (un
--      pedido nuevo despues no cambia el reporte).
--   D. Reglas: dia sin actividad omitido en barrido de sistema (sin fila), periodo que no termina, semana que no empieza en lunes.
--   E. Autorizacion: staff de piso, repartidor, admin fuera de alcance, otro tenant, anon, sucursal ajena declarando mi
--      organizacion; la sesion de sistema solo con sucursal de SU organizacion; lista de barrido solo de sistema y sin demo; la
--      tabla es de solo lectura para authenticated y aislada por tenant.
--   F. base SIN migrar: la funcion eliminada da 42883 y un bloque con subtransaccion recupera la transaccion.
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
  ('00000000-0000-0000-0000-0000000e4201', 'restaurantes', 'Cierre Org A', 'cierre-a'),
  ('00000000-0000-0000-0000-0000000e4202', 'restaurantes', 'Cierre Org B (ajena)', 'cierre-b'),
  ('00000000-0000-0000-0000-0000000e4203', 'restaurantes', 'Cierre Org Demo', 'cierre-demo')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e42a1', '00000000-0000-0000-0000-0000000e4201', 'Sucursal A1 (Mexico)'),
  ('00000000-0000-0000-0000-0000000e42a2', '00000000-0000-0000-0000-0000000e4201', 'Sucursal A2 (Auckland)'),
  ('00000000-0000-0000-0000-0000000e42b1', '00000000-0000-0000-0000-0000000e4202', 'Sucursal B1'),
  ('00000000-0000-0000-0000-0000000e42d1', '00000000-0000-0000-0000-0000000e4203', 'Sucursal D1 (demo)')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e42a1', '00000000-0000-0000-0000-0000000e4201', 'a1', null),
  ('00000000-0000-0000-0000-0000000e42a2', '00000000-0000-0000-0000-0000000e4201', 'a2', 'Pacific/Auckland'),
  ('00000000-0000-0000-0000-0000000e42b1', '00000000-0000-0000-0000-0000000e4202', 'b1', null),
  ('00000000-0000-0000-0000-0000000e42d1', '00000000-0000-0000-0000-0000000e4203', 'd1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4211', 'owner-a@cierre.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4212', 'admin-a1@cierre.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e4213', 'staff-a@cierre.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4214', 'rep-a@cierre.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4215', 'owner-b@cierre.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4211', '00000000-0000-0000-0000-0000000e4201', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4212', '00000000-0000-0000-0000-0000000e4201', array['00000000-0000-0000-0000-0000000e42a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4213', '00000000-0000-0000-0000-0000000e4201', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e4214', '00000000-0000-0000-0000-0000000e4201', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4215', '00000000-0000-0000-0000-0000000e4202', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.demo_organization (organization_id, seed_version) values ('00000000-0000-0000-0000-0000000e4203', 'verify');

-- Dia local 2026-03-10 en Mexico (UTC-6) = 2026-03-10 06:00Z .. 2026-03-11 06:00Z.
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at, delivered_at, promovido_at, programado_para) values
  -- w1/w2: WhatsApp entregados (30 y 60 min).
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C1', '+52 5511111111', 100.50, 'entregado', '[]', 'whatsapp', '2026-03-10 18:00:00+00', '2026-03-10 18:30:00+00', null, null),
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C2', '+52 5522222222', 200.00, 'entregado', '[]', 'whatsapp', '2026-03-10 19:00:00+00', '2026-03-10 20:00:00+00', null, null),
  -- voz pendiente.
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C3', '+52 5533333333', 50.00, 'pending', '[]', 'voice', '2026-03-10 21:00:00+00', null, null, null),
  -- web a las 23:59 local (05:59Z del 11): cuenta en el dia 10.
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C4', '+52 5544444444', 10.00, 'pending', '[]', 'web', '2026-03-11 05:59:00+00', null, null, null),
  -- web a las 00:00 local del dia 11: fuera del dia 10.
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C5', '+52 5555555555', 11.00, 'pending', '[]', 'web', '2026-03-11 06:00:00+00', null, null, null),
  -- cancelado y no recogido (web).
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C6', '+52 5566666666', 80.00, 'cancelado', '[]', 'web', '2026-03-10 22:00:00+00', null, null, null),
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C7', '+52 5577777777', 40.00, 'no_recogido', '[]', 'web', '2026-03-10 22:30:00+00', null, null, null),
  -- programado aun sin promover: no cuenta (aunque su created_at caiga en el dia).
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C8', '+52 5588888888', 300.00, 'programado', '[]', 'admin', '2026-03-10 17:00:00+00', null, null, '2026-03-20 18:00:00+00'),
  -- programado ya promovido el dia 10 (created_at del dia 5): cuenta en el dia 10 por promovido_at.
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C9', '+52 5599999999', 25.25, 'pending', '[]', 'admin', '2026-03-05 12:00:00+00', null, '2026-03-10 16:00:00+00', '2026-03-10 17:00:00+00'),
  -- trafico demo (0009): excluido.
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'Demo', '+52 0009123456', 999.00, 'pending', '[]', 'whatsapp', '2026-03-10 18:10:00+00', null, null, null),
  -- otra sucursal (A2) y otro tenant: excluidos del cierre de A1.
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a2', 'C10', '+52 5500000010', 777.00, 'pending', '[]', 'whatsapp', '2026-03-10 18:00:00+00', null, null, null),
  ('00000000-0000-0000-0000-0000000e4202', '00000000-0000-0000-0000-0000000e42b1', 'C11', '+52 5500000011', 555.00, 'pending', '[]', 'whatsapp', '2026-03-10 18:00:00+00', null, null, null),
  -- comparativo del dia 10: dia 3 (una semana antes): 1 pedido de 70.
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C12', '+52 5500000012', 70.00, 'pending', '[]', 'web', '2026-03-03 15:00:00+00', null, null, null),
  -- semana 9..15: un pedido el dia 12 (45) y otro el 15 (5); la semana anterior (2..8) trae el del dia 3 (70).
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C13', '+52 5500000013', 45.00, 'pending', '[]', 'whatsapp', '2026-03-12 15:00:00+00', null, null, null),
  ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'C14', '+52 5500000014', 5.00, 'pending', '[]', 'web', '2026-03-15 15:00:00+00', null, null, null);

\echo '=== A1. dia 10: pedidos (w1,w2,voz,web 23:59,promovido; cancelado/no recogido/programado/demo/A2/00:00 fuera) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'pedidos')::int as pedidos_deberia_ser_5 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A2. dia 10: ventas en centavos (10050+20000+5000+1000+2525) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'ventas_centavos')::bigint as ventas_deberia_ser_38575 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A3. dia 10: ticket promedio en centavos (38575/5) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'ticket_promedio_centavos')::bigint as ticket_deberia_ser_7715 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A4. dia 10: cancelados ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'cancelados')::int as cancelados_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A5. dia 10: monto cancelado en centavos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'cancelados_centavos')::bigint as cancelados_centavos_deberia_ser_8000 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A6. dia 10: no recogidos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'no_recogidos')::int as no_recogidos_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A7. dia 10: porcentaje de cancelacion (1/6 = 16.7) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select ((datos->>'cancelacion_pct')::numeric * 10)::int as cancelacion_x10_deberia_ser_167 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A8. dia 10: whatsapp en centavos (30050) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (c->>'ventas_centavos')::bigint as whatsapp_centavos_deberia_ser_30050 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false), jsonb_array_elements(datos->'por_canal') c where c->>'canal' = 'whatsapp';
rollback;

\echo '=== A9. dia 10: canal web con 1 pedido y 1 cancelado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select ((c->>'pedidos')::int * 10 + (c->>'cancelados')::int) as web_pedidos_y_cancelados_deberia_ser_11 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false), jsonb_array_elements(datos->'por_canal') c where c->>'canal' = 'web';
rollback;

\echo '=== A10. dia 10: tiempo de entrega promedio 45 min ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->'tiempos'->>'promedio_min')::numeric::int as promedio_deberia_ser_45 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A11. dia 10: p90 de entrega 57 min ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->'tiempos'->>'p90_min')::numeric::int as p90_deberia_ser_57 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A12. dia 10: comparativo con el dia 3 (1 pedido) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->'comparativo'->>'pedidos')::int as comparativo_pedidos_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A13. dia 10: comparativo con el dia 3 (7000 centavos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->'comparativo'->>'ventas_centavos')::bigint as comparativo_ventas_deberia_ser_7000 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== A14. dia 10: sin PII en el reporte (no hay telefono ni nombre) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos::text ~ '5511111111|Demo|C1')::int as pii_deberia_ser_0 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== B1. semana 9..15: pedidos (dia 10: 5, dia 11: 1, dia 12: 1, dia 15: 1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'pedidos')::int as pedidos_semana_deberia_ser_8 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'semana', date '2026-03-09', false);
rollback;

\echo '=== B2. semana: por_dia trae los 7 dias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select jsonb_array_length(datos->'por_dia') as dias_deberia_ser_7 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'semana', date '2026-03-09', false);
rollback;

\echo '=== B3. semana: el dia 12 del por_dia suma 4500 centavos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (d->>'ventas_centavos')::bigint as dia12_deberia_ser_4500 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'semana', date '2026-03-09', false), jsonb_array_elements(datos->'por_dia') d where d->>'fecha' = '2026-03-12';
rollback;

\echo '=== B4. semana: comparativo con la semana anterior (7000 centavos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->'comparativo'->>'ventas_centavos')::bigint as semana_anterior_deberia_ser_7000 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'semana', date '2026-03-09', false);
rollback;

\echo '=== C1. idempotencia: dos llamadas dejan UNA fila ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) g1;
select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) g2;
select count(*) as filas_deberia_ser_1 from restaurantes.cierre_reporte where property_id = '00000000-0000-0000-0000-0000000e42a1' and tipo = 'dia' and fecha_inicio = date '2026-03-10';
rollback;

\echo '=== C2. idempotencia: la primera llamada crea ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select creado::int as primera_creado_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== C3. idempotencia: la segunda no crea y conserva el id ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
create temp table t1 as select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
select (creado or g.id <> t1.id)::int as segunda_distinta_deberia_ser_0 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) g, t1;
rollback;

\echo '=== C4. congelado: un pedido tardio no cambia el cierre ya generado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
create temp table t2 as select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
reset role;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'Tardio', '+52 5500000099', 1000, 'pending', '[]', 'web', '2026-03-10 20:00:00+00');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select ((g.datos->>'pedidos')::int - (t2.datos->>'pedidos')::int) as diferencia_deberia_ser_0 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) g, t2;
rollback;

\echo '=== C5. el sistema tambien genera, marcado como sistema ==='
begin;
set local role authenticated;
select (generado_por = 'sistema')::int as por_sistema_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== C6. el usuario queda marcado como staff ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (generado_por = 'staff')::int as por_staff_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false);
rollback;

\echo '=== D1. barrido de sistema: dia sin actividad no deja fila (id nulo) ==='
begin;
set local role authenticated;
select (id is null)::int as sin_fila_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-20', true);
rollback;

\echo '=== D2. barrido de sistema: dia sin actividad no deja fila en la tabla ==='
begin;
set local role authenticated;
select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-20', true) x;
select count(*) as filas_deberia_ser_0 from restaurantes.cierre_reporte where fecha_inicio = date '2026-03-20';
rollback;

\echo '=== D3. el staff SI puede generar un dia sin actividad (cierre en ceros) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'pedidos')::int as pedidos_deberia_ser_0 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-20', false);
rollback;

\echo '=== D4. dia sin pedidos: ticket promedio nulo, no cero ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select (datos->>'ticket_promedio_centavos' is null)::int as ticket_nulo_deberia_ser_1 from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-20', false);
rollback;

\echo '=== D5. RECHAZADO: periodo que no termina (hoy) -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2099-01-01', false)$q$, '22023');
rollback;

\echo '=== D6. RECHAZADO: semana que no empieza en lunes -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'semana', date '2026-03-10', false)$q$, '22023');
rollback;

\echo '=== D7. RECHAZADO: tipo invalido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'mes', date '2026-03-10')$q$, '22023');
rollback;

\echo '=== E1. RECHAZADO: staff de piso no genera -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4213', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false)$q$, '42501');
rollback;

\echo '=== E2. RECHAZADO: repartidor no genera -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4214', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false)$q$, '42501');
rollback;

\echo '=== E3. RECHAZADO: admin acotado a A1 no genera A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4212', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a2', 'dia', date '2026-03-10', false)$q$, '42501');
rollback;

\echo '=== E4. RECHAZADO cross-tenant: owner de B no genera A1 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4215', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false)$q$, '42501');
rollback;

\echo '=== E5. RECHAZADO cross-tenant: owner de A no declara su org sobre la sucursal de B -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42b1', 'dia', date '2026-03-10', false)$q$, '42501');
rollback;

\echo '=== E6. RECHAZADO: sesion de sistema no cruza tenants (sucursal de B con la org de A) -> 42501 ==='
begin;
set local role authenticated;

select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42b1', 'dia', date '2026-03-10', false)$q$, '42501');
rollback;

\echo '=== E7. RECHAZADO: anon no ejecuta -> 42501 ==='
begin;
set local role authenticated;
reset role;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false)$q$, '42501');
rollback;

\echo '=== E8. lectura: el owner de A ve el cierre; el owner de B no ve ninguna fila de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) x;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4215', true);
select count(*) as filas_ajenas_deberia_ser_0 from restaurantes.cierre_reporte where organization_id = '00000000-0000-0000-0000-0000000e4201';
rollback;

\echo '=== E9. lectura: el staff de piso no ve cierres ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) x;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4213', true);
select count(*) as filas_deberia_ser_0 from restaurantes.cierre_reporte;
rollback;

\echo '=== E10. lectura: el admin acotado a A1 ve su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) x;
reset role;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4212', true);
select count(*) as filas_deberia_ser_1 from restaurantes.cierre_reporte;
rollback;

\echo '=== E11. RECHAZADO: authenticated no inserta directo en la tabla -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$insert into restaurantes.cierre_reporte (organization_id, property_id, tipo, fecha_inicio, fecha_fin, zona_horaria, datos, generado_por) values ('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-01', date '2026-03-01', 'America/Mexico_City', '{}', 'staff')$q$, '42501');
rollback;

\echo '=== E12. RECHAZADO: authenticated no actualiza ni borra -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select id from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10', false) x;
select public.t_esperar_error($q$update restaurantes.cierre_reporte set datos = '{}'$q$, '42501');
rollback;

\echo '=== E13. RECHAZADO: el helper de agregados no es ejecutable por authenticated -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$select restaurantes.cierre_agregados('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', now() - interval '1 day', now())$q$, '42501');
rollback;

\echo '=== E14. barrido: la sesion de sistema lista las sucursales de A, B y NO la demo ==='
begin;
set local role authenticated;
select count(*) as sucursales_demo_deberia_ser_0 from restaurantes.cierre_sucursales_sistema() where property_id = '00000000-0000-0000-0000-0000000e42d1';
rollback;

\echo '=== E15. barrido: lista las sucursales reales (A1, A2, B1) ==='
begin;
set local role authenticated;
select count(*) as sucursales_deberia_ser_3 from restaurantes.cierre_sucursales_sistema() where property_id in ('00000000-0000-0000-0000-0000000e42a1','00000000-0000-0000-0000-0000000e42a2','00000000-0000-0000-0000-0000000e42b1');
rollback;

\echo '=== E16. RECHAZADO: un usuario no lista el barrido -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$select * from restaurantes.cierre_sucursales_sistema()$q$, '42501');
rollback;

\echo '=== E17. RECHAZADO: anon no lista el barrido -> 42501 ==='
begin;
set local role authenticated;
reset role;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.cierre_sucursales_sistema()$q$, '42501');
rollback;

\echo '=== F1. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.generar_cierre(uuid, uuid, text, date, boolean);
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.generar_cierre('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'dia', date '2026-03-10');
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
