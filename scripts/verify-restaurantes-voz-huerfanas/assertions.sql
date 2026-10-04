-- Fixtures + escenarios contra Postgres REAL (GRANT + auth.uid() reales, nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/060_voz_cerrar_huerfanas.sql: barrido de llamadas de voz huerfanas
-- (QA-restaurantes-R1-automatizacion-08).
--
--   A. Cierre: una llamada abierta hace 3 h con turnos se cierra como 'abandonado' con duracion (ultimo turno - inicio), costo (suma de los
--      turnos) y p95 de latencia correctos; sin turnos queda con duracion 0 y costo 0; barre TODAS las organizaciones y tambien previews.
--   B. Lo que NO toca: llamada reciente en curso, llamada ya cerrada (su resultado se conserva).
--   C. Idempotencia y lote acotado (p_limite).
--   D. KPI: la llamada huerfana pasa de "en curso" a "abandonada" en voz_kpis_diarios (la tasa de abandono deja de subestimarse).
--   E. Autorizacion: un usuario autenticado (auth.uid() no nulo) -> 42501; anon -> 42501; parametros fuera de rango -> 22023.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar
-- en ERROR; los alias con sufijo deberia_ser_N marcan el valor esperado.
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
  ('00000000-0000-0000-0000-0000000e4201', 'restaurantes', 'Voz Huerfanas Org A', 'voz-huerfanas-a'),
  ('00000000-0000-0000-0000-0000000e4202', 'restaurantes', 'Voz Huerfanas Org B', 'voz-huerfanas-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e42a1', '00000000-0000-0000-0000-0000000e4201', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e42a2', '00000000-0000-0000-0000-0000000e4201', 'Sucursal A2 (KPI)'),
  ('00000000-0000-0000-0000-0000000e42b1', '00000000-0000-0000-0000-0000000e4202', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e42a1', '00000000-0000-0000-0000-0000000e4201', 'a1', null),
  ('00000000-0000-0000-0000-0000000e42a2', '00000000-0000-0000-0000-0000000e4201', 'a2', null),
  ('00000000-0000-0000-0000-0000000e42b1', '00000000-0000-0000-0000-0000000e4202', 'b1', null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4211', 'owner-a@vozhuerf.example.com', 'Owner A', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4211', '00000000-0000-0000-0000-0000000e4201', null, 'owner', 'owner')
on conflict do nothing;

-- h1: abierta hace 3 h, con dos turnos (a +10 s y +50 s): duracion 50, costo 500000, p95 900.
-- h2: abierta hace 5 h, sin turnos. h3: otra ORGANIZACION, abierta hace 4 h. p1: preview abierto hace 3 h.
-- r1: reciente (hace 10 min, en curso). c1: vieja pero YA cerrada como 'escalado'.
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, voice_id, started_at, ended_at, duration_s, resultado) values
  ('00000000-0000-0000-0000-0000000e42c1', '00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'huerf-h1', 'llamada', 'gemini-3.8-live', 'Puck', now() - interval '3 hours', null, null, null),
  ('00000000-0000-0000-0000-0000000e42c2', '00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'huerf-h2', 'llamada', 'gemini-3.8-live', 'Puck', now() - interval '5 hours', null, null, null),
  ('00000000-0000-0000-0000-0000000e42c3', '00000000-0000-0000-0000-0000000e4202', '00000000-0000-0000-0000-0000000e42b1', 'huerf-h3', 'llamada', 'gemini-3.8-live', 'Puck', now() - interval '4 hours', null, null, null),
  ('00000000-0000-0000-0000-0000000e42c4', '00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'huerf-p1', 'preview', 'gemini-3.8-live', 'Puck', now() - interval '3 hours', null, null, null),
  ('00000000-0000-0000-0000-0000000e42c5', '00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'huerf-r1', 'llamada', 'gemini-3.8-live', 'Puck', now() - interval '10 minutes', null, null, null),
  ('00000000-0000-0000-0000-0000000e42c6', '00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a1', 'huerf-c1', 'llamada', 'gemini-3.8-live', 'Puck', now() - interval '6 hours', now() - interval '5 hours', 3600, 'escalado');

insert into restaurantes.voice_turn (conversation_id, organization_id, seq, rol, texto, latencia_ms, costo_estimado_micro_usd, created_at)
  select '00000000-0000-0000-0000-0000000e42c1'::uuid, '00000000-0000-0000-0000-0000000e4201'::uuid, 0, 'cliente', 'hola', 100, 300000, c.started_at + interval '10 seconds'
  from restaurantes.voice_conversation c where c.id = '00000000-0000-0000-0000-0000000e42c1'
  union all
  select '00000000-0000-0000-0000-0000000e42c1'::uuid, '00000000-0000-0000-0000-0000000e4201'::uuid, 1, 'agente', 'buenas', 900, 200000, c.started_at + interval '50 seconds'
  from restaurantes.voice_conversation c where c.id = '00000000-0000-0000-0000-0000000e42c1';

-- KPI (D): un dia fijo en una sucursal aparte, sin otros datos. 2026-03-10 en America/Mexico_City (UTC-6).
insert into restaurantes.voice_conversation (id, organization_id, property_id, external_id, canal, proveedor, voice_id, started_at, ended_at, duration_s, resultado) values
  ('00000000-0000-0000-0000-0000000e42d1', '00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a2', 'huerf-kpi-1', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-10 18:00:00+00', null, null, null),
  ('00000000-0000-0000-0000-0000000e42d2', '00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a2', 'huerf-kpi-2', 'llamada', 'gemini-3.8-live', 'Puck', '2026-03-10 19:00:00+00', '2026-03-10 19:01:00+00', 60, 'pedido_creado');

\echo '=== A1. POSITIVO: la sesion de sistema cierra las 5 huerfanas (h1, h2, h3 de otra organizacion, el preview y la de KPI): se esperan 5 ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as cerradas_deberia_ser_5;
rollback;

\echo '=== A2. h1 queda abandonada con duracion 50 s, costo 500000 y p95 900 ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as cierre;
reset role;
select count(*) as h1_deberia_ser_1 from restaurantes.voice_conversation
  where id = '00000000-0000-0000-0000-0000000e42c1' and resultado = 'abandonado' and duration_s = 50 and costo_estimado_micro_usd = 500000 and latencia_p95_ms = 900 and ended_at = started_at + interval '50 seconds';
rollback;

\echo '=== A3. h2 (sin turnos) queda abandonada con duracion 0, costo 0 y p95 nulo ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as cierre;
reset role;
select count(*) as h2_deberia_ser_1 from restaurantes.voice_conversation
  where id = '00000000-0000-0000-0000-0000000e42c2' and resultado = 'abandonado' and duration_s = 0 and costo_estimado_micro_usd = 0 and latencia_p95_ms is null and ended_at = started_at;
rollback;

\echo '=== A4. barre todas las organizaciones: h3 (org B) y el preview tambien se cierran ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as cierre;
reset role;
select count(*) as otras_deberia_ser_2 from restaurantes.voice_conversation
  where id in ('00000000-0000-0000-0000-0000000e42c3', '00000000-0000-0000-0000-0000000e42c4') and resultado = 'abandonado';
rollback;

\echo '=== B1. la llamada RECIENTE en curso no se toca ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as cierre;
reset role;
select count(*) as reciente_intacta_deberia_ser_1 from restaurantes.voice_conversation
  where id = '00000000-0000-0000-0000-0000000e42c5' and resultado is null and ended_at is null and duration_s is null;
rollback;

\echo '=== B2. la llamada ya cerrada conserva su resultado y su fin ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as cierre;
reset role;
select count(*) as cerrada_intacta_deberia_ser_1 from restaurantes.voice_conversation
  where id = '00000000-0000-0000-0000-0000000e42c6' and resultado = 'escalado' and duration_s = 3600;
rollback;

\echo '=== C1. IDEMPOTENTE: una segunda corrida no encuentra nada ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as primera;
select restaurantes.voz_cerrar_huerfanas(120, 200) as segunda_deberia_ser_0;
rollback;

\echo '=== C2. el lote esta acotado por p_limite: con 1 cierra solo una ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 1) as un_lote_deberia_ser_1;
rollback;

\echo '=== C3. un umbral de inactividad mayor deja intactas las mas recientes (h1 de 3 h con umbral de 4 h = no se cierra) ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(240, 200) as cierre;
reset role;
select count(*) as h1_sigue_abierta_deberia_ser_1 from restaurantes.voice_conversation where id = '00000000-0000-0000-0000-0000000e42c1' and resultado is null;
rollback;

\echo '=== D1. KPI antes del barrido: la llamada huerfana cuenta como llamada pero NO como cerrada ni abandonada (cerradas 1: solo la de pedido_creado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select llamadas_cerradas as cerradas_antes_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a2', date '2026-03-10', date '2026-03-10') where fecha = date '2026-03-10';
rollback;

\echo '=== D2. KPI despues del barrido: la huerfana entra a las abandonadas  ==='
begin;
set local role authenticated;
select restaurantes.voz_cerrar_huerfanas(120, 200) as cierre;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select abandonadas as abandonadas_despues_deberia_ser_1 from restaurantes.voz_kpis_diarios('00000000-0000-0000-0000-0000000e4201', '00000000-0000-0000-0000-0000000e42a2', date '2026-03-10', date '2026-03-10') where fecha = date '2026-03-10';
rollback;

\echo '=== E1. RECHAZADO: un usuario autenticado no ejecuta el barrido -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$select restaurantes.voz_cerrar_huerfanas(120, 200)$q$, '42501');
rollback;

\echo '=== E2. RECHAZADO: anon no ejecuta el barrido -> 42501 ==='
begin;
set local role anon;
select public.t_esperar_error($q$select restaurantes.voz_cerrar_huerfanas(120, 200)$q$, '42501');
rollback;

\echo '=== E3. RECHAZADO: parametros fuera de rango (menos de 30 min, mas de 7 dias, lote 0 o enorme) -> 22023 ==='
begin;
set local role authenticated;
select public.t_esperar_error($q$select restaurantes.voz_cerrar_huerfanas(5, 200)$q$, '22023');
select public.t_esperar_error($q$select restaurantes.voz_cerrar_huerfanas(20000, 200)$q$, '22023');
select public.t_esperar_error($q$select restaurantes.voz_cerrar_huerfanas(120, 0)$q$, '22023');
select public.t_esperar_error($q$select restaurantes.voz_cerrar_huerfanas(120, 5000)$q$, '22023');
rollback;

\echo '=== E4. RECHAZADO: el rol authenticated no puede escribir directo las conversaciones (solo la funcion definer) -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4211', true);
select public.t_esperar_error($q$update restaurantes.voice_conversation set resultado = 'abandonado'$q$, '42501');
rollback;

\echo 'Todos los escenarios terminan con la expectativa del propio archivo: RECHAZADO = sin ERROR dentro de t_esperar_error (el helper exige el SQLSTATE exacto); alias deberia_ser_N = valor exacto.'
