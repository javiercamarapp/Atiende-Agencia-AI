-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/067_voz_modo_entrada_gasto_mes_y_latencia.sql (worker de telefonia de voz).
--
--   A. voz_marcar_modo_entrada (solo sistema): positivo, listas cerradas, cross-tenant, preview, staff y anon rechazados.
--   B. voz_gasto_mes_micro_usd (solo sistema): suma solo 'voz' de restaurantes de la organizacion en el mes de Merida (frontera de mes),
--      no suma telefonia ni otra organizacion; staff y anon rechazados.
--   C. voz_modo_entrada_kpi: llamadas/pedidos en desborde, ventas recuperadas sin cancelados, latencia p50/p95, dia sin datos,
--      autorizacion (rol, sucursal fuera de alcance, cross-tenant, anon, sistema, rango invalido).
--   D. Ciclo de una llamada tal como lo escribe el worker (iniciar, marcar, turnos, evento de latencia, costo idempotente, cerrar) y los CHECK
--      de voice_event para el tipo 'latencia_voz'.
--   E. base SIN migrar: la funcion eliminada da 42883 y un bloque con subtransaccion (el mismo mecanismo que SAVEPOINT) recupera la
--      transaccion.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar en
-- ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado.
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
  ('00000000-0000-0000-0000-0000000e1d01', 'restaurantes', 'Voz Worker Org A', 'voz-worker-a'),
  ('00000000-0000-0000-0000-0000000e1d02', 'restaurantes', 'Voz Worker Org B (ajena)', 'voz-worker-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e1da1', '00000000-0000-0000-0000-0000000e1d01', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e1da2', '00000000-0000-0000-0000-0000000e1d01', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e1db1', '00000000-0000-0000-0000-0000000e1d02', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e1da1', '00000000-0000-0000-0000-0000000e1d01', 'a1'),
  ('00000000-0000-0000-0000-0000000e1da2', '00000000-0000-0000-0000-0000000e1d01', 'a2'),
  ('00000000-0000-0000-0000-0000000e1db1', '00000000-0000-0000-0000-0000000e1d02', 'b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e1d11', 'owner-a@vozworker.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e1d12', 'admin-a1@vozworker.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e1d13', 'staff-a@vozworker.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e1d14', 'owner-b@vozworker.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e1d11', '00000000-0000-0000-0000-0000000e1d01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e1d12', '00000000-0000-0000-0000-0000000e1d01', array['00000000-0000-0000-0000-0000000e1da1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e1d13', '00000000-0000-0000-0000-0000000e1d01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e1d14', '00000000-0000-0000-0000-0000000e1d02', null, 'owner', 'owner')
on conflict do nothing;

-- Pedidos: o1 = 250 (pendiente), o2 = 100 (cancelado), o3 = 400 (entregado), o4 = pedido de OTRA organizacion.
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000e1de1', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'Cliente 1', '+52 9990000001', 250, 'pending', '[]', 'voice', '2026-03-10 18:00:00+00'),
  ('00000000-0000-0000-0000-0000000e1de2', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'Cliente 2', '+52 9990000002', 100, 'cancelado', '[]', 'voice', '2026-03-10 19:00:00+00'),
  ('00000000-0000-0000-0000-0000000e1de3', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'Cliente 3', '+52 9990000003', 400, 'entregado', '[]', 'voice', '2026-03-10 20:00:00+00'),
  ('00000000-0000-0000-0000-0000000e1de4', '00000000-0000-0000-0000-0000000e1d02', '00000000-0000-0000-0000-0000000e1db1', 'Cliente B', '+52 9990000004', 999, 'pending', '[]', 'voice', '2026-03-10 18:00:00+00');

-- Dia local 2026-03-10 en Mexico_City (UTC-6) = 2026-03-10 06:00Z .. 2026-03-11 06:00Z.
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, voice_id, started_at, ended_at, duration_s, resultado, order_id, modo_entrada, franja) values
  -- c1: desborde, pedido pendiente (250): cuenta en pedidos y ventas.
  ('00000000-0000-0000-0000-0000000e1dc1', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'vw-c1', 'llamada', 'gemini-3.8-live', 'Kore', '2026-03-10 18:00:00+00', '2026-03-10 18:03:00+00', 180, 'pedido_creado', '00000000-0000-0000-0000-0000000e1de1', 'desborde', 'tarde'),
  -- c2: desborde, pedido CANCELADO (100): cuenta como llamada en desborde pero no como venta.
  ('00000000-0000-0000-0000-0000000e1dc2', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'vw-c2', 'llamada', 'gemini-3.8-live', 'Kore', '2026-03-10 19:00:00+00', '2026-03-10 19:02:00+00', 120, 'pedido_creado', '00000000-0000-0000-0000-0000000e1de2', 'desborde', 'tarde'),
  -- c3: desborde, pedido entregado (400).
  ('00000000-0000-0000-0000-0000000e1dc3', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'vw-c3', 'llamada', 'gemini-3.8-live', 'Kore', '2026-03-10 20:00:00+00', '2026-03-10 20:02:00+00', 120, 'pedido_creado', '00000000-0000-0000-0000-0000000e1de3', 'desborde', 'noche'),
  -- c4: desborde sin pedido (escalada).
  ('00000000-0000-0000-0000-0000000e1dc4', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'vw-c4', 'llamada', 'gemini-3.8-live', 'Kore', '2026-03-10 21:00:00+00', '2026-03-10 21:01:00+00', 60, 'escalado', null, 'desborde', 'noche'),
  -- c5: modo total con pedido: NO es venta recuperada.
  ('00000000-0000-0000-0000-0000000e1dc5', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'vw-c5', 'llamada', 'gemini-3.8-live', 'Kore', '2026-03-10 22:00:00+00', '2026-03-10 22:02:00+00', 120, 'pedido_creado', null, 'total', 'noche'),
  -- c6: preview (no es trafico real).
  ('00000000-0000-0000-0000-0000000e1dc6', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'vw-c6', 'preview', 'gemini-3.8-live', 'Kore', '2026-03-10 18:30:00+00', '2026-03-10 18:40:00+00', 600, 'abandonado', null, null, null),
  -- c7: llamada vieja sin modo (antes de esta migracion): cuenta como llamada, no como desborde.
  ('00000000-0000-0000-0000-0000000e1dc7', '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'vw-c7', 'llamada', 'gemini-3.8-live', 'Kore', '2026-03-10 23:00:00+00', '2026-03-10 23:01:00+00', 60, 'abandonado', null, null, null),
  -- B1 (otra organizacion): desborde con pedido de 999.
  ('00000000-0000-0000-0000-0000000e1dc8', '00000000-0000-0000-0000-0000000e1d02', '00000000-0000-0000-0000-0000000e1db1', 'vw-b1', 'llamada', 'gemini-3.8-live', 'Kore', '2026-03-10 18:00:00+00', '2026-03-10 18:03:00+00', 180, 'pedido_creado', '00000000-0000-0000-0000-0000000e1de4', 'desborde', 'tarde');

-- Latencia de voz a voz de A1 dia 10 (eventos 'latencia_voz' de la llamada c1): 10 respuestas de 100..1000 ms (p50 = 500, p95 = 1000).
-- No cuentan: una llamada a herramienta lenta (tool_call), el evento de latencia de OTRA organizacion y el de otro dia.
insert into restaurantes.voice_event (organization_id, property_id, conversation_id, tipo, latencia_ms, ocurrido_at)
  select '00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', '00000000-0000-0000-0000-0000000e1dc1', 'latencia_voz', 100 * g, timestamptz '2026-03-10 18:00:10+00' + g * interval '1 second'
  from generate_series(1, 10) g;
insert into restaurantes.voice_event (organization_id, property_id, conversation_id, tipo, herramienta, latencia_ms, ocurrido_at) values
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', '00000000-0000-0000-0000-0000000e1dc1', 'tool_call', 'cotizar_pedido', 9999, '2026-03-10 18:01:00+00');
insert into restaurantes.voice_event (organization_id, property_id, tipo, latencia_ms, ocurrido_at) values
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'latencia_voz', 5555, '2026-03-12 18:00:00+00'),
  ('00000000-0000-0000-0000-0000000e1d02', '00000000-0000-0000-0000-0000000e1db1', 'latencia_voz', 7777, '2026-03-10 18:00:00+00');

-- Gasto de voz: marzo 2026 de A = 1000000 + 250000; abril no cuenta; telefonia no cuenta; B no cuenta.
-- Frontera de Merida (UTC-6 en marzo, sin horario de verano): 2026-04-01 05:59Z es 31-mar 23:59 local (marzo); 2026-04-01 06:00Z ya es abril.
insert into core.usage_cost_event (organization_id, property_id, vertical, occurred_at, categoria, proveedor, unidad, cantidad, costo_micro_usd, ref_tipo, ref_id) values
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'restaurantes', '2026-03-10 18:00:00+00', 'voz', 'gemini-3.8-live', 'segundo', 120, 1000000, 'voz_restaurantes', 'vw-gasto-1:gemini-3.8-live'),
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'restaurantes', '2026-04-01 05:59:00+00', 'voz', 'cascada-openrouter', 'segundo', 60, 250000, 'voz_restaurantes', 'vw-gasto-2:cascada-openrouter'),
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'restaurantes', '2026-04-01 06:00:00+00', 'voz', 'gemini-3.8-live', 'segundo', 60, 9000000, 'voz_restaurantes', 'vw-gasto-abril'),
  ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'restaurantes', '2026-03-10 18:00:00+00', 'telefonia', 'twilio', 'minuto', 5, 5000000, 'llamada', 'vw-tel-1'),
  ('00000000-0000-0000-0000-0000000e1d02', '00000000-0000-0000-0000-0000000e1db1', 'restaurantes', '2026-03-10 18:00:00+00', 'voz', 'gemini-3.8-live', 'segundo', 120, 7000000, 'voz_restaurantes', 'vw-gasto-b1');

\echo '=== A1. POSITIVO: la sesion de sistema marca modo y franja de una llamada de su organizacion ==='
begin;
do $$
begin
  if restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc7', 'desborde', 'manana') is not true then
    raise exception 'A1: marcar debia devolver true';
  end if;
  if not exists (select 1 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000e1dc7' and modo_entrada = 'desborde' and franja = 'manana') then
    raise exception 'A1: las columnas no quedaron escritas';
  end if;
end $$;
rollback;

\echo '=== A2. POSITIVO: marcar es idempotente (repetir con los mismos valores sigue dando true y no cambia nada) ==='
begin;
do $$
begin
  perform restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc7', 'total', 'tarde');
  if restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc7', 'total', 'tarde') is not true then
    raise exception 'A2: la segunda vez debia devolver true';
  end if;
  if not exists (select 1 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000e1dc7' and modo_entrada = 'total' and franja = 'tarde') then
    raise exception 'A2: el valor final no es el esperado';
  end if;
end $$;
rollback;

\echo '=== A3. RECHAZADO cross-tenant: marcar la conversacion de B declarando la organizacion A no toca nada (false) ==='
begin;
do $$
begin
  if restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc8', 'total', 'noche') is not false then
    raise exception 'A3: una conversacion ajena debia devolver false';
  end if;
  if not exists (select 1 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000e1dc8' and modo_entrada = 'desborde' and franja = 'tarde') then
    raise exception 'A3: la conversacion ajena fue modificada';
  end if;
end $$;
rollback;

\echo '=== A4. RECHAZADO: una conversacion de preview no se marca (false) ==='
begin;
do $$
begin
  if restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc6', 'desborde', 'tarde') is not false then
    raise exception 'A4: el preview debia devolver false';
  end if;
  if exists (select 1 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000e1dc6' and modo_entrada is not null) then
    raise exception 'A4: el preview fue marcado';
  end if;
end $$;
rollback;

\echo '=== A5. RECHAZADO: modo fuera de la lista cerrada -> 22023 ==='
begin;
select public.t_esperar_error($q$select restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc7', 'otro', 'tarde')$q$, '22023');
rollback;

\echo '=== A6. RECHAZADO: franja fuera de la lista cerrada -> 22023 ==='
begin;
select public.t_esperar_error($q$select restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc7', 'total', 'madrugada')$q$, '22023');
rollback;

\echo '=== A7. RECHAZADO: una sesion de staff (owner) no puede marcar -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select public.t_esperar_error($q$select restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc7', 'total', 'tarde')$q$, '42501');
rollback;

\echo '=== A8. RECHAZADO: anon no ejecuta la funcion (sin GRANT) -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1dc7', 'total', 'tarde')$q$, '42501');
rollback;

\echo '=== A9. RECHAZADO: authenticated no puede escribir las columnas por DML directo -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select public.t_esperar_error($q$update restaurantes.voice_conversation set modo_entrada = 'total' where id = '00000000-0000-0000-0000-0000000e1dc7'$q$, '42501');
rollback;

\echo '=== A10. RECHAZADO: el CHECK de la columna rechaza un modo invalido escrito sin la funcion (23514) ==='
begin;
select public.t_esperar_error($q$update restaurantes.voice_conversation set modo_entrada = 'otro' where id = '00000000-0000-0000-0000-0000000e1dc7'$q$, '23514');
rollback;

\echo '=== B1. POSITIVO: gasto del mes de A en marzo (frontera: 31-mar 23:59 local cuenta, 1-abr 00:00 local no) ==='
begin;
select restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01', timestamptz '2026-03-15 12:00:00+00') as gasto_marzo_deberia_ser_1250000;
rollback;

\echo '=== B2. POSITIVO: gasto de abril de A (solo el evento de 1-abr 06:00Z) ==='
begin;
select restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01', timestamptz '2026-04-15 12:00:00+00') as gasto_abril_deberia_ser_9000000;
rollback;

\echo '=== B3. POSITIVO: un mes sin eventos devuelve 0 (no NULL) ==='
begin;
select restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01', timestamptz '2026-05-15 12:00:00+00') as gasto_mayo_deberia_ser_0;
rollback;

\echo '=== B4. Cross-tenant: el gasto de B no se mezcla con el de A ==='
begin;
select restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d02', timestamptz '2026-03-15 12:00:00+00') as gasto_b_deberia_ser_7000000;
rollback;

\echo '=== B5. La frontera usa la zona de Merida: el 1-abr 05:30Z todavia es marzo local (y 31-mar 23:30 local) ==='
begin;
select restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01', timestamptz '2026-04-01 05:30:00+00') as gasto_frontera_deberia_ser_1250000;
rollback;

\echo '=== B6. RECHAZADO: una sesion de staff no lee el gasto (ni el propio) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select public.t_esperar_error($q$select restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01')$q$, '42501');
rollback;

\echo '=== B7. RECHAZADO: anon no ejecuta la funcion (sin GRANT) -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01')$q$, '42501');
rollback;

\echo '=== C1. POSITIVO: llamadas en desborde de A1 dia 10 (c1, c2, c3, c4; c5 es total, c6 preview, c7 sin modo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select llamadas_desborde as desborde_deberia_ser_4 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C2. POSITIVO: pedidos de las llamadas en desborde, sin el cancelado (c1 y c3) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select pedidos_desborde as pedidos_deberia_ser_2 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C3. POSITIVO: ventas recuperadas = 250 + 400 (sin el cancelado de 100, sin el modo total, sin el pedido ajeno de 999) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select ventas_recuperadas::int as ventas_deberia_ser_650 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C4. POSITIVO: llamadas con modo registrado (c1..c5; c7 no tiene modo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select llamadas_con_modo as con_modo_deberia_ser_5 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C5. POSITIVO: latencia p50 de voz a voz (10 eventos de 100 a 1000 ms; la herramienta lenta y los ajenos no cuentan) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select latencia_p50_ms as p50_deberia_ser_500 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C6. POSITIVO: latencia p95 de voz a voz ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select latencia_p95_ms as p95_deberia_ser_1000 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C7. POSITIVO: llamadas con latencia medida ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select llamadas_con_latencia as con_latencia_deberia_ser_1 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C8. POSITIVO: un dia sin datos aparece con ceros y latencia NULL ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select (llamadas_desborde = 0 and ventas_recuperadas = 0 and latencia_p95_ms is null)::int as dia_vacio_deberia_ser_1 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-09', date '2026-03-11') where fecha = date '2026-03-09';
rollback;

\echo '=== C9. POSITIVO: el rango de 3 dias devuelve 3 filas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select count(*) as filas_deberia_ser_3 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-09', date '2026-03-11');
rollback;

\echo '=== C10. POSITIVO: el admin acotado a A1 lee los KPI de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d12', true);
select ventas_recuperadas::int as ventas_admin_deberia_ser_650 from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11') where fecha = date '2026-03-10';
rollback;

\echo '=== C11. RECHAZADO: el admin acotado a A1 no lee A2 (fuera de alcance) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d12', true);
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da2', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== C12. RECHAZADO: el staff de piso no lee el KPI -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d13', true);
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== C13. RECHAZADO cross-tenant: el owner de B no lee A1 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d14', true);
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== C14. RECHAZADO cross-tenant: el owner de A no lee la sucursal de B declarando su organizacion -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1db1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== C15. RECHAZADO: anon no ejecuta la funcion (sin GRANT) -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== C16. RECHAZADO: la sesion de sistema (sin usuario) no lee el KPI de staff -> 42501 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-10', date '2026-03-11')$q$, '42501');
rollback;

\echo '=== C17. RECHAZADO: rango invalido (hasta antes que desde, o mas de 63 dias) -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e1d11', true);
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-03-11', date '2026-03-10')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.voz_modo_entrada_kpi('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', date '2026-01-01', date '2026-03-10')$q$, '22023');
rollback;

\echo '=== D1. Ciclo de una llamada como lo escribe el worker: iniciar, marcar, turnos con latencia, costo idempotente, cerrar ==='
begin;
do $$
declare
  v_conv uuid;
begin
  v_conv := restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'llamada-ciclo-1', 'llamada', 'gemini-3.8-live', 'Kore', null, timestamptz '2026-03-12 18:00:00+00');
  if v_conv <> restaurantes.voz_iniciar_conversacion('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'llamada-ciclo-1', 'llamada', 'gemini-3.8-live', 'Kore', null, timestamptz '2026-03-12 18:00:00+00') then
    raise exception 'D1: iniciar debia ser idempotente por llamada (mismo external_id, misma conversacion)';
  end if;
  if restaurantes.voz_marcar_modo_entrada('00000000-0000-0000-0000-0000000e1d01', v_conv, 'desborde', 'tarde') is not true then
    raise exception 'D1: marcar debia devolver true';
  end if;
  -- Sin consentimiento de grabacion (migracion 030) los turnos NO se guardan: el worker lo registra a partir de la respuesta del titular.
  if restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000e1d01', v_conv, 0, 'agente', 'no se guarda', null, null, 0) is not false then
    raise exception 'D1: sin consentimiento el turno no debia guardarse';
  end if;
  perform restaurantes.system_set_voice_recording_consent('00000000-0000-0000-0000-0000000e1d01', v_conv, true);
  perform restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000e1d01', v_conv, 0, 'agente', 'Gracias por llamar', null, null, 0);
  perform restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000e1d01', v_conv, 1, 'cliente', 'Quiero tacos', null, null, 0);
  perform restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000e1d01', v_conv, 2, 'agente', 'Claro', null, 900, 18000);
  if restaurantes.voz_registrar_turno('00000000-0000-0000-0000-0000000e1d01', v_conv, 2, 'agente', 'Claro', null, 900, 18000) is not false then
    raise exception 'D1: reintentar el mismo seq debia devolver false (idempotente)';
  end if;
  perform restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', v_conv, 'latencia_voz', null, null, 900, null, timestamptz '2026-03-12 18:00:30+00');
  if core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', timestamptz '2026-03-12 18:00:00+00', 'voz', 'gemini-3.8-live', 'segundo', 60, 18000, true, 'voz_restaurantes', 'llamada-ciclo-1:gemini-3.8-live') is not true then
    raise exception 'D1: el primer evento de costo debia registrarse';
  end if;
  if core.record_usage_cost_event('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', timestamptz '2026-03-12 18:00:00+00', 'voz', 'gemini-3.8-live', 'segundo', 60, 18000, true, 'voz_restaurantes', 'llamada-ciclo-1:gemini-3.8-live') is not false then
    raise exception 'D1: el reintento del evento de costo debia ser idempotente';
  end if;
  if restaurantes.voz_cerrar_conversacion('00000000-0000-0000-0000-0000000e1d01', v_conv, 'escalado', timestamptz '2026-03-12 18:01:00+00', null) is not true then
    raise exception 'D1: cerrar debia devolver true';
  end if;
  if not exists (select 1 from restaurantes.voice_conversation c where c.id = v_conv and c.modo_entrada = 'desborde' and c.franja = 'tarde' and c.latencia_p95_ms = 900 and c.costo_estimado_micro_usd = 18000 and c.resultado = 'escalado' and c.duration_s = 60) then
    raise exception 'D1: la conversacion cerrada no trae modo, franja, p95, costo, resultado y duracion esperados';
  end if;
  if restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01', timestamptz '2026-03-15 12:00:00+00') <> 1268000 then
    raise exception 'D1: el gasto del mes debia incluir el costo de la llamada (1000000 + 250000 + 18000)';
  end if;
end $$;
rollback;

\echo '=== D2. RECHAZADO: un evento latencia_voz sin latencia_ms viola el CHECK de campos por tipo (23514) ==='
begin;
select public.t_esperar_error($q$insert into restaurantes.voice_event (organization_id, property_id, tipo) values ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'latencia_voz')$q$, '23514');
rollback;

\echo '=== D3. RECHAZADO: un tipo fuera de la lista cerrada viola el CHECK (23514) ==='
begin;
select public.t_esperar_error($q$insert into restaurantes.voice_event (organization_id, property_id, tipo, latencia_ms) values ('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1da1', 'inventado', 10)$q$, '23514');
rollback;

\echo '=== D4. RECHAZADO cross-tenant: un evento de latencia de una sucursal ajena a la organizacion declarada -> 42501 ==='
begin;
select public.t_esperar_error($q$select restaurantes.voz_registrar_evento('00000000-0000-0000-0000-0000000e1d01', '00000000-0000-0000-0000-0000000e1db1', null, 'latencia_voz', null, null, 100, null, null)$q$, '42501');
rollback;

\echo '=== E1. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.voz_gasto_mes_micro_usd(uuid, timestamptz);
do $$
declare
  v_state text;
begin
  begin
    perform restaurantes.voz_gasto_mes_micro_usd('00000000-0000-0000-0000-0000000e1d01');
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
