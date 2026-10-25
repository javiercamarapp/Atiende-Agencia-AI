-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, rol `authenticated`) de
-- packages/domain-restaurantes/migrations/095_cfo_analisis_clientes.sql: restaurantes.cfo_clientes_rfm, cfo_clientes_reactivacion, cfo_intervalo_recompra y
-- cfo_pedidos_tortilla (Analisis de clientes del CFO, solo lectura). Corpus pequeno, SINTETICO, con valores calculados a mano.
--
-- Corpus de la organizacion A (rango 2026-01-01 .. 2026-03-31, p_hasta = 2026-03-31; montos en pesos, 1 venta = un pedido 'entregado' a las 13:00):
--   cliente ventas  venta  recencia  mediana  R F M  segmento              dormido   notas
--   C1      4       400    1         10       5 4 3  campeon               no        dias 02-28, 03-10, 03-20, 03-30 (+ ruido el 03-31 y el 04-01 que NO cuenta)
--   C2      5       1000   6         10       4 4 5  campeon               no        empata en monto con C5 (mismo puntaje M)
--   C3      1       150    3         -        5 1 2  nuevo_prometedor       no        una sola venta
--   C4      3       900    58        15.5     2 3 4  en_riesgo_alto_valor  si
--   C5      2       1000   70        15       2 2 5  en_riesgo_alto_valor  si
--   C6      2       160    3         8        5 2 2  ocasional             no        empata en recencia con C3 (mismo puntaje R)
--   C7      1       60     80        -        1 1 1  ocasional             no        una venta vieja: no es dormido (sin intervalo propio)
--   C8      2       500    21        18       3 2 4  ocasional             no        sucursal A2 (las demas, A1)
--   C9      2       200    16        -        3 2 3  ocasional             no        dos ventas el MISMO dia: sin intervalo propio
--   C10     2       40     77        10       1 2 1  dormido               si
--   total 4410 pesos; 10 clientes; recompra (venta en >= 2 dias distintos; C9 tiene 2 ventas el mismo dia y NO cuenta) 7; activos 30 d = 6; dormidos 3; venta en riesgo = C4 + C5 + C10 = 1940.
--   Reactivacion elegibles (>= 2 ventas y recencia > max(14, 1.5 x mediana) o > 30): C4, C5, C9, C10; prioridades 36078, 32143, 17500, 779 (pesos x 100 x factor).
--   Intervalos: global 13 (p25 10, p50 10, p75 14, p90 16.6); campeon 7 (p90 11.2); los demas segmentos < 5 intervalos => percentiles NULL.
--   Ruido que NO cuenta: cancelado, pedido falso, telefono demo 0009, programado, no_recogido, reposicion, venta sin cliente, venta fuera del rango.
-- Organizacion B: ajena (cross-tenant). Organizacion T: tortilla en items y dia de negocio con corte (01:00).
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar en ERROR; los alias
-- con sufijo deberia_ser_N marcan el valor esperado.
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

create or replace function public.t_ped(p_org uuid, p_prop uuid, p_cust uuid, p_dia date, p_hora time, p_total numeric, p_status text default 'entregado',
  p_phone text default null, p_id uuid default gen_random_uuid(), p_tz text default 'America/Mexico_City', p_items jsonb default '[]'::jsonb) returns uuid
language plpgsql as $$
declare
  v_ts timestamptz := (p_dia + p_hora) at time zone p_tz;
begin
  insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, canal, created_at, programado_para)
  values (p_id, p_org, p_prop, p_cust, 'Cliente', coalesce(p_phone, '+52 5500000000'), p_total, p_status, p_items, 'whatsapp', 'recoger', v_ts,
          case when p_status = 'programado' then v_ts + interval '5 days' end);
  return p_id;
end $$;

-- Atajos de identificadores (los escenarios del gate corren en conexiones aparte: los literales viven en funciones).
create or replace function public.oa() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e4a01'::uuid $$;
create or replace function public.ob() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e4a02'::uuid $$;
create or replace function public.ot() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e4a03'::uuid $$;
create or replace function public.p1() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e4a11'::uuid $$;
create or replace function public.p2() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e4a12'::uuid $$;
create or replace function public.c(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000e4c' || lpad(to_hex(n), 2, '0'))::uuid $$;

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e4a01', 'restaurantes', 'Analisis Org A', 'analisis-a'),
  ('00000000-0000-0000-0000-0000000e4a02', 'restaurantes', 'Analisis Org B', 'analisis-b'),
  ('00000000-0000-0000-0000-0000000e4a03', 'restaurantes', 'Analisis Org T', 'analisis-t')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e4a11', '00000000-0000-0000-0000-0000000e4a01', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000e4a12', '00000000-0000-0000-0000-0000000e4a01', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000e4a21', '00000000-0000-0000-0000-0000000e4a02', 'Sucursal B1'),
  ('00000000-0000-0000-0000-0000000e4a31', '00000000-0000-0000-0000-0000000e4a03', 'Sucursal T1')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria, lat, lng) values
  ('00000000-0000-0000-0000-0000000e4a11', '00000000-0000-0000-0000-0000000e4a01', 'a1', null, 21.5, -90.0),
  ('00000000-0000-0000-0000-0000000e4a12', '00000000-0000-0000-0000-0000000e4a01', 'a2', null, 20.97, -89.62),
  ('00000000-0000-0000-0000-0000000e4a21', '00000000-0000-0000-0000-0000000e4a02', 'b1', null, null, null),
  ('00000000-0000-0000-0000-0000000e4a31', '00000000-0000-0000-0000-0000000e4a03', 't1', null, null, null)
on conflict do nothing;
-- T1: turno 12:00 -> 01:00 (corte de 1 h): una venta a las 00:30 pertenece al dia de negocio ANTERIOR.
insert into restaurantes.branch_policy (property_id, organization_id, horario) values
  ('00000000-0000-0000-0000-0000000e4a31', '00000000-0000-0000-0000-0000000e4a03', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]');

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4b01', 'owner-a@analisis.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4b02', 'admin-a1@analisis.example.com', 'Admin A1', 'seed'),
  ('00000000-0000-0000-0000-0000000e4b03', 'staff-a@analisis.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4b04', 'rep-a@analisis.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4b05', 'owner-b@analisis.example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4b01', '00000000-0000-0000-0000-0000000e4a01', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4b02', '00000000-0000-0000-0000-0000000e4a01', array['00000000-0000-0000-0000-0000000e4a11']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4b03', '00000000-0000-0000-0000-0000000e4a01', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e4b04', '00000000-0000-0000-0000-0000000e4a01', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4b05', '00000000-0000-0000-0000-0000000e4a02', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4b01', '00000000-0000-0000-0000-0000000e4a03', null, 'owner', 'owner')
on conflict do nothing;

-- Clientes C1..C10 + N1..N3 (ruido) + C0 (sin pedidos) + C11 (solo fuera de rango) de A; BC1 de B; TC de T.
insert into restaurantes.customers (id, organization_id, phone, name) values
  (public.c(1),  public.oa(), '+52 5500001001', 'c1'),  (public.c(2),  public.oa(), '+52 5500001002', 'c2'),
  (public.c(3),  public.oa(), '+52 5500001003', 'c3'),  (public.c(4),  public.oa(), '+52 5500001004', 'c4'),
  (public.c(5),  public.oa(), '+52 5500001005', 'c5'),  (public.c(6),  public.oa(), '+52 5500001006', 'c6'),
  (public.c(7),  public.oa(), '+52 5500001007', 'c7'),  (public.c(8),  public.oa(), '+52 5500001008', 'c8'),
  (public.c(9),  public.oa(), '+52 5500001009', 'c9'),  (public.c(10), public.oa(), '+52 5500001010', 'c10'),
  (public.c(11), public.oa(), '+52 5500001011', 'c11 solo fuera de rango'),
  (public.c(12), public.oa(), '+52 5500001012', 'c12 sin pedidos'),
  (public.c(13), public.oa(), '+52 5500001013', 'n1 solo cancelado'),
  (public.c(14), public.oa(), '+52 5500001014', 'n2 solo falso'),
  (public.c(15), public.oa(), '+52 5500001015', 'n3 solo demo'),
  (public.c(16), public.ob(), '+52 5500002001', 'bc1'),
  (public.c(17), public.ot(), '+52 5500003001', 'tc');

-- C1..C10 (ventas validas)
select public.t_ped(public.oa(), public.p1(), public.c(1), d, time '13:00', 100) from unnest(array[date '2026-02-28', '2026-03-10', '2026-03-20']) d;
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-03-30', time '13:00', 100, p_id => '00000000-0000-0000-0000-0000000e4f01');
select public.t_ped(public.oa(), public.p1(), public.c(2), d, time '13:00', 200) from unnest(array[date '2026-02-10', '2026-02-23', '2026-03-05', '2026-03-15', '2026-03-25']) d;
select public.t_ped(public.oa(), public.p1(), public.c(3), date '2026-03-28', time '13:00', 150);
select public.t_ped(public.oa(), public.p1(), public.c(4), d, time '13:00', 300) from unnest(array[date '2026-01-01', '2026-01-15', '2026-02-01']) d;
select public.t_ped(public.oa(), public.p1(), public.c(5), d, time '13:00', 500) from unnest(array[date '2026-01-05', '2026-01-20']) d;
select public.t_ped(public.oa(), public.p1(), public.c(6), d, time '13:00', 80) from unnest(array[date '2026-03-20', '2026-03-28']) d;
select public.t_ped(public.oa(), public.p1(), public.c(7), date '2026-01-10', time '13:00', 60);
select public.t_ped(public.oa(), public.p2(), public.c(8), d, time '13:00', 250) from unnest(array[date '2026-02-20', '2026-03-10']) d;
select public.t_ped(public.oa(), public.p1(), public.c(9), date '2026-03-15', time '13:00', 100);
select public.t_ped(public.oa(), public.p1(), public.c(9), date '2026-03-15', time '14:00', 100);
select public.t_ped(public.oa(), public.p1(), public.c(10), d, time '13:00', 20) from unnest(array[date '2026-01-03', '2026-01-13']) d;

-- Ruido que NO cuenta (todo a nombre de C1 el 31-mar, o de clientes que quedan sin ninguna venta valida)
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-03-31', time '13:00', 999, p_status => 'cancelado');
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-03-31', time '13:01', 888, p_id => '00000000-0000-0000-0000-0000000e4f02');
update restaurantes.orders set pedido_falso_at = now() where id = '00000000-0000-0000-0000-0000000e4f02';
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-03-31', time '13:02', 777, p_phone => '+52 0009000002');
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-03-31', time '13:03', 666, p_status => 'programado');
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-03-31', time '13:04', 444, p_status => 'no_recogido');
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-03-31', time '13:05', 555, p_id => '00000000-0000-0000-0000-0000000e4f03');
insert into restaurantes.solicitud_aprobacion (organization_id, property_id, tipo, estado, order_id, decision, resuelta_at, reposicion_order_id)
values (public.oa(), public.p1(), 'compensacion', 'resuelta', '00000000-0000-0000-0000-0000000e4f01', 'reponer_producto', now(), '00000000-0000-0000-0000-0000000e4f03');
select public.t_ped(public.oa(), public.p1(), null, date '2026-03-31', time '13:06', 333);
select public.t_ped(public.oa(), public.p1(), public.c(1), date '2026-04-01', time '13:00', 1000);
select public.t_ped(public.oa(), public.p1(), public.c(11), date '2025-12-31', time '13:00', 1000);
select public.t_ped(public.oa(), public.p1(), public.c(13), date '2026-03-30', time '13:00', 100, p_status => 'cancelado');
select public.t_ped(public.oa(), public.p1(), public.c(14), date '2026-03-30', time '13:00', 100, p_id => '00000000-0000-0000-0000-0000000e4f04');
update restaurantes.orders set pedido_falso_at = now() where id = '00000000-0000-0000-0000-0000000e4f04';
select public.t_ped(public.oa(), public.p1(), public.c(15), date '2026-03-30', time '13:00', 100, p_phone => '+52 0009000003');

-- Consentimiento de marketing (052): C4 otorgado, C5 revocado, C10 otorgado, C9 sin registro.
insert into restaurantes.marketing_consentimiento (organization_id, customer_id, canal, estado, fuente, version_aviso) values
  (public.oa(), public.c(4), 'whatsapp', 'otorgado', 'panel', 'v1'),
  (public.oa(), public.c(5), 'whatsapp', 'revocado', 'panel', 'v1'),
  (public.oa(), public.c(10), 'whatsapp', 'otorgado', 'panel', 'v1');

-- B: dos ventas de un cliente de la organizacion ajena.
select public.t_ped(public.ob(), '00000000-0000-0000-0000-0000000e4a21', public.c(16), d, time '13:00', 9999) from unnest(array[date '2026-03-01', '2026-03-20']) d;

-- T: tortilla en items (sin cliente salvo TC) y dia de negocio con corte.
select public.t_ped(public.ot(), '00000000-0000-0000-0000-0000000e4a31', null, date '2026-03-12', time '13:00', 120, p_items =>
  '[{"id":"p1","name":"Taco","price":50,"quantity":2,"tortilla":"maiz"},{"id":"p2","name":"Refresco","price":20,"quantity":1}]'::jsonb);
select public.t_ped(public.ot(), '00000000-0000-0000-0000-0000000e4a31', null, date '2026-03-12', time '14:00', 190, p_items =>
  '[{"id":"p1","name":"Taco","price":50,"quantity":3,"tortilla":"harina"},{"id":"p3","name":"Gordita","price":40,"quantity":1,"tortilla":"maiz"}]'::jsonb);
select public.t_ped(public.ot(), '00000000-0000-0000-0000-0000000e4a31', null, date '2026-03-12', time '15:00', 80);
select public.t_ped(public.ot(), '00000000-0000-0000-0000-0000000e4a31', null, date '2026-03-12', time '16:00', 70, p_status => 'cancelado', p_items =>
  '[{"id":"p1","name":"Taco","price":50,"quantity":9,"tortilla":"mixta"}]'::jsonb);
select public.t_ped(public.ot(), '00000000-0000-0000-0000-0000000e4a31', null, date '2026-03-12', time '17:00', 60, p_items =>
  '[{"id":"p1","name":"Taco","price":30,"quantity":"x","tortilla":"mixta"},{"id":"p4","name":"Quesadilla","price":30,"quantity":1,"tortilla":"integral"}]'::jsonb);
select public.t_ped(public.ot(), '00000000-0000-0000-0000-0000000e4a31', public.c(17), date '2026-03-10', time '12:00', 100);
select public.t_ped(public.ot(), '00000000-0000-0000-0000-0000000e4a31', public.c(17), date '2026-03-31', time '00:30', 100);
analyze restaurantes.orders; analyze restaurantes.customers;

-- ===========================================================================
-- A. Positivos: valores calculados a mano
-- ===========================================================================
\echo '=== A1. RFM: 10 clientes, recompra 7 (C9 no), activos 30 d = 6, dormidos 3, venta total 441000 y en riesgo 194000 centavos (ruido excluido) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j -> 'resumen' ->> 'clientes_con_venta' = '10' and j -> 'resumen' ->> 'clientes_recompra' = '7' and j -> 'resumen' ->> 'activos_30' = '6'
        and j -> 'resumen' ->> 'dormidos' = '3' and j -> 'resumen' ->> 'venta_total_centavos' = '441000' and j -> 'resumen' ->> 'venta_en_riesgo_centavos' = '194000')::int as resumen_deberia_ser_1
  from (select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== A2. RFM: segmentos en el orden de evaluacion (campeon 2, leal 0, en_riesgo 2, nuevo_prometedor 1, dormido 1, ocasional 4) con venta y pedidos esperados ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (jsonb_array_length(j -> 'segmentos') = 6
        and (select string_agg(s ->> 'segmento', ',' order by (s ->> 'orden')::int) from jsonb_array_elements(j -> 'segmentos') s) = 'campeon,leal,en_riesgo_alto_valor,nuevo_prometedor,dormido,ocasional'
        and (select string_agg((s ->> 'clientes') || ':' || (s ->> 'venta_centavos') || ':' || (s ->> 'pedidos'), ',' order by (s ->> 'orden')::int) from jsonb_array_elements(j -> 'segmentos') s)
            = '2:140000:9,0:0:0,2:190000:5,1:15000:1,1:4000:2,4:92000:7')::int as segmentos_deberia_ser_1
  from (select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== A3. RFM: ticket por segmento (campeon 140000/9 = 15556, leal sin dato) y recencia mediana (campeon 3.5, ocasional 18.5) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select ((j -> 'segmentos' -> 0 ->> 'ticket_centavos') = '15556' and (j -> 'segmentos' -> 1 -> 'ticket_centavos') = 'null'::jsonb
        and (j -> 'segmentos' -> 0 ->> 'recencia_mediana_dias')::numeric = 3.5 and (j -> 'segmentos' -> 5 ->> 'recencia_mediana_dias')::numeric = 18.5
        and (j -> 'segmentos' -> 1 -> 'recencia_mediana_dias') = 'null'::jsonb)::int as ticket_recencia_deberia_ser_1
  from (select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== A4. RFM: curva de concentracion (22.7 % de la venta en el 10 % de clientes, 65.8 % en el 30 %, 100 % al final; 30 % de clientes para el 50 % y 50 % para el 80 %) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (jsonb_array_length(j -> 'pareto' -> 'puntos') = 10 and (j -> 'pareto' -> 'puntos' -> 0 ->> 'venta_pct')::numeric = 22.7 and (j -> 'pareto' -> 'puntos' -> 2 ->> 'venta_pct')::numeric = 65.8
        and (j -> 'pareto' -> 'puntos' -> 9 ->> 'venta_pct')::numeric = 100.0 and (j -> 'pareto' -> 'puntos' -> 3 ->> 'venta_pct')::numeric = 77.1
        and (j -> 'pareto' ->> 'clientes_para_50_pct')::numeric = 30.0 and (j -> 'pareto' ->> 'clientes_para_80_pct')::numeric = 50.0)::int as pareto_deberia_ser_1
  from (select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== A5. EMPATES: C2 y C5 (mismo monto) obtienen el mismo puntaje M y C3 y C6 (misma recencia) el mismo R; los puntajes salen de la base interna ==='
begin;
select (count(*) filter (where customer_id = public.c(2) and m = 5) = 1 and count(*) filter (where customer_id = public.c(5) and m = 5) = 1
        and count(*) filter (where customer_id = public.c(3) and r = 5) = 1 and count(*) filter (where customer_id = public.c(6) and r = 5) = 1
        and count(*) filter (where customer_id = public.c(1) and r = 5 and f = 4 and m = 3) = 1
        and count(*) filter (where customer_id = public.c(4) and r = 2 and f = 3 and m = 4 and dormido) = 1
        and count(*) filter (where customer_id = public.c(7) and r = 1 and f = 1 and m = 1 and not dormido) = 1)::int as empates_deberia_ser_1
  from restaurantes.cfo_clientes_rfm_base(public.oa(), array[public.p1(), public.p2()], date '2026-01-01', date '2026-03-31');
rollback;

\echo '=== A6. Segmento por cliente (orden de evaluacion y DORMIDO unico): C1,C2 campeon; C3 nuevo; C4,C5 en riesgo; C10 dormido; C6..C9 ocasional ==='
begin;
select ((select string_agg(x.customer_id::text || '=' || x.segmento, ',' order by x.customer_id) from restaurantes.cfo_clientes_rfm_base(public.oa(), array[public.p1(), public.p2()], date '2026-01-01', date '2026-03-31') x)
       = (select string_agg(public.c(n)::text || '=' || s, ',' order by public.c(n)) from (values (1,'campeon'),(2,'campeon'),(3,'nuevo_prometedor'),(4,'en_riesgo_alto_valor'),(5,'en_riesgo_alto_valor'),(6,'ocasional'),(7,'ocasional'),(8,'ocasional'),(9,'ocasional'),(10,'dormido')) t(n, s)))::int
       as segmento_cliente_deberia_ser_1;
rollback;

\echo '=== B1. REACTIVACION: elegibles C4, C5, C9 (mismo dia, sin mediana: umbral 14) y C10; C8 (21 d < 27) y C6/C1/C2 no; 3 dormidos; venta en juego 214000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j ->> 'total_elegibles' = '4' and j ->> 'mostrados' = '4' and j ->> 'dormidos' = '3' and j ->> 'venta_en_juego_centavos' = '214000'
        and (select string_agg((f ->> 'dias_sin_pedir') || ':' || (f ->> 'ventas') || ':' || (f ->> 'dormido'), ',' order by (f ->> 'prioridad_centavos')::bigint desc) from jsonb_array_elements(j -> 'filas') f)
            = '58:3:true,70:2:true,16:2:false,77:2:true')::int as elegibles_deberia_ser_1
  from (select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== B2. REACTIVACION: prioridades (36078, 32143, 17500, 779), orden descendente, umbral e intervalo por fila, ticket y canal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select ((select string_agg(f ->> 'prioridad_centavos', ',' order by ord) from jsonb_array_elements(j -> 'filas') with ordinality t(f, ord)) = '36078,32143,17500,779'
        and j -> 'filas' -> 0 ->> 'umbral_dias' = '23.3' and j -> 'filas' -> 0 ->> 'intervalo_mediano_dias' = '15.5' and j -> 'filas' -> 0 ->> 'ticket_centavos' = '30000'
        and j -> 'filas' -> 2 ->> 'umbral_dias' = '14.0' and j -> 'filas' -> 2 -> 'intervalo_mediano_dias' = 'null'::jsonb
        and j -> 'filas' -> 0 ->> 'ultima_venta' = '2026-02-01' and j -> 'filas' -> 0 ->> 'canal_frecuente' = 'recoger')::int as prioridad_deberia_ser_1
  from (select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== B3. REACTIVACION: consentimiento visible por fila (C4 otorgado, C5 revocado, C9 sin_registro, C10 otorgado) y conteos sobre todos los elegibles ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select ((select string_agg(f ->> 'consentimiento', ',' order by ord) from jsonb_array_elements(j -> 'filas') with ordinality t(f, ord)) = 'otorgado,revocado,sin_registro,otorgado'
        and j -> 'consentimiento' ->> 'otorgado' = '2' and j -> 'consentimiento' ->> 'revocado' = '1' and j -> 'consentimiento' ->> 'sin_registro' = '1')::int as consentimiento_deberia_ser_1
  from (select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== B4. REACTIVACION: tope de filas (limite 2 => 2 mostrados de 4 elegibles, los de mayor prioridad); limite 0 y 201 => 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j ->> 'mostrados' = '2' and j ->> 'total_elegibles' = '4' and jsonb_array_length(j -> 'filas') = 2 and j -> 'filas' -> 0 ->> 'prioridad_centavos' = '36078' and j -> 'filas' -> 1 ->> 'prioridad_centavos' = '32143')::int as limite_deberia_ser_1
  from (select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31', 2) as j) q;
rollback;

\echo '=== B5. REACTIVACION: limite invalido (0, 201, nulo) => 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31', 0)$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31', 201)$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31', null)$q$
  ] loop
    perform public.t_esperar_error(v, '22023');
  end loop;
end $$;
select 1 as limite_invalido_ok;
rollback;

\echo '=== B6. SIN PII: ni customer_id (uuid), ni telefono, ni nombre en la lista; alias de exactamente 8 caracteres hexadecimales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}' and j::text !~ '[+]52' and j::text !~ 'Cliente|customer|phone|name'
        and (select bool_and((f ->> 'alias') ~ '^[0-9a-f]{8}$') from jsonb_array_elements(j -> 'filas') f))::int as sin_pii_deberia_ser_1
  from (select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== B7. SIN PII en RFM y tortilla: ningun uuid ni telefono en el jsonb ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}' and j::text !~ '[+]52' and t::text !~ '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}')::int as sin_pii_rfm_deberia_ser_1
  from (select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') as j, restaurantes.cfo_pedidos_tortilla(public.ot(), null, date '2026-03-01', date '2026-03-31') as t) q;
rollback;

\echo '=== C1. INTERVALO: global 13 intervalos (p25 10, p50 10, p75 14, p90 16.6) y 10 clientes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (r.clientes = 10 and r.intervalos = 13 and r.p25 = 10.0 and r.p50 = 10.0 and r.p75 = 14.0 and r.p90 = 16.6)::int as global_deberia_ser_1
  from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31') r where r.segmento = 'global';
rollback;

\echo '=== C2. INTERVALO: campeon 7 intervalos (p25..p75 = 10, p90 = 11.2); resto de segmentos con < 5 intervalos => percentiles NULL (supresion por muestra minima) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select ((select count(*) from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31')) = 7
        and (select (r.clientes = 2 and r.intervalos = 7 and r.p25 = 10.0 and r.p50 = 10.0 and r.p75 = 10.0 and r.p90 = 11.2) from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31') r where r.segmento = 'campeon')
        and (select bool_and(r.p25 is null and r.p50 is null and r.p75 is null and r.p90 is null) from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31') r where r.segmento not in ('global', 'campeon'))
        and (select r.intervalos = 3 from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31') r where r.segmento = 'en_riesgo_alto_valor'))::int as segmentos_deberia_ser_1;
rollback;

\echo '=== D1. CLIENTE SIN PEDIDOS / CON UNA SOLA VENTA: C12 (sin pedidos), C13..C15 (solo ruido) y C11 (fuera de rango) no aparecen; C3 y C7 (1 venta) aparecen sin intervalo ==='
begin;
select (count(*) filter (where customer_id in (public.c(11), public.c(12), public.c(13), public.c(14), public.c(15))) = 0
        and count(*) = 10 and count(*) filter (where customer_id in (public.c(3), public.c(7)) and mediana_intervalo is null and intervalos is null and ventas = 1) = 2
        and count(*) filter (where customer_id = public.c(9) and ventas = 2 and dias_con_venta = 1 and mediana_intervalo is null) = 1)::int as sin_ventas_deberia_ser_1
  from restaurantes.cfo_clientes_rfm_base(public.oa(), array[public.p1(), public.p2()], date '2026-01-01', date '2026-03-31');
rollback;

\echo '=== D2. ORGANIZACION SIN VENTAS EN EL RANGO: RFM con 0 clientes, 6 segmentos en cero, pareto vacio y sin porcentajes; reactivacion vacia; intervalo con 7 renglones en cero ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j -> 'resumen' ->> 'clientes_con_venta' = '0' and jsonb_array_length(j -> 'segmentos') = 6 and jsonb_array_length(j -> 'pareto' -> 'puntos') = 0
        and j -> 'pareto' -> 'clientes_para_50_pct' = 'null'::jsonb and j -> 'resumen' ->> 'venta_total_centavos' = '0'
        and r ->> 'total_elegibles' = '0' and jsonb_array_length(r -> 'filas') = 0
        and (select count(*) from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2024-01-01', date '2024-01-31') where clientes = 0 and intervalos = 0 and p50 is null) = 7)::int as vacio_deberia_ser_1
  from (select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2024-01-01', date '2024-01-31') as j, restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2024-01-01', date '2024-01-31') as r) q;
rollback;

\echo '=== D3. RECENCIA ANCLADA A p_hasta (no a hoy): con hasta = 2026-02-15, C2 (ultima venta 02-10) tiene recencia 5 y 1 venta; C4 (ultima 02-01) 14; con hasta = 2026-03-31, C4 tiene 58 ==='
begin;
select ((select x.recencia_dias = 5 and x.ventas = 1 from restaurantes.cfo_clientes_rfm_base(public.oa(), array[public.p1(), public.p2()], date '2026-01-01', date '2026-02-15') x where x.customer_id = public.c(2))
        and (select x.recencia_dias = 14 from restaurantes.cfo_clientes_rfm_base(public.oa(), array[public.p1(), public.p2()], date '2026-01-01', date '2026-02-15') x where x.customer_id = public.c(4))
        and (select x.recencia_dias = 58 from restaurantes.cfo_clientes_rfm_base(public.oa(), array[public.p1(), public.p2()], date '2026-01-01', date '2026-03-31') x where x.customer_id = public.c(4)))::int as ancla_deberia_ser_1;
rollback;

\echo '=== E1. TORTILLA: maiz 2 renglones / 3 unidades / 2 pedidos; harina 1 / 3 / 1; mixta 1 renglon sin unidades (cantidad invalida) / 1 pedido; "integral", cancelados y pedidos sin items fuera; 3 pedidos con items ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j ->> 'pedidos_con_items' = '3' and jsonb_array_length(j -> 'tortilla') = 3
        and (select string_agg((t ->> 'tipo') || ':' || (t ->> 'renglones') || ':' || (t ->> 'unidades') || ':' || (t ->> 'pedidos'), ',' order by ord) from jsonb_array_elements(j -> 'tortilla') with ordinality x(t, ord))
            = 'maiz:2:3:2,harina:1:3:1,mixta:1:0:1')::int as tortilla_deberia_ser_1
  from (select restaurantes.cfo_pedidos_tortilla(public.ot(), null, date '2026-03-01', date '2026-03-31') as j) q;
rollback;

\echo '=== E2. TORTILLA sin renglones con tortilla (org A: items vacios): los 3 tipos en cero y 0 pedidos con items ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j ->> 'pedidos_con_items' = '0' and (select bool_and((t ->> 'renglones') = '0') from jsonb_array_elements(j -> 'tortilla') t))::int as tortilla_vacia_deberia_ser_1
  from (select restaurantes.cfo_pedidos_tortilla(public.oa(), null, date '2026-01-01', date '2026-03-31') as j) q;
rollback;

\echo '=== F1. DIA DE NEGOCIO CON CORTE (T1, corte 01:00): la venta de las 00:30 del 31-mar pertenece al 30-mar, recencia 1 (no 0) y el cliente es ocasional con recencia mediana 1.0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select (j -> 'resumen' ->> 'clientes_con_venta' = '1' and (j -> 'segmentos' -> 5 ->> 'recencia_mediana_dias')::numeric = 1.0 and j -> 'segmentos' -> 5 ->> 'clientes' = '1')::int as corte_deberia_ser_1
  from (select restaurantes.cfo_clientes_rfm(public.ot(), null, date '2026-03-01', date '2026-03-31') as j) q;
rollback;

-- ===========================================================================
-- G. Seguridad: cross-tenant, alcance por sucursal, roles, anon, rango
-- ===========================================================================
\echo '=== G1. ALCANCE: sucursal A2 sola (solo C8) => 1 cliente; admin acotado a A1 sin sucursales => 9 clientes (sin C8, de A2); owner => 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select ((restaurantes.cfo_clientes_rfm(public.oa(), array[public.p2()]::uuid[], date '2026-01-01', date '2026-03-31') -> 'resumen' ->> 'clientes_con_venta') = '1'
        and (restaurantes.cfo_clientes_rfm(public.oa(), array[public.p1()]::uuid[], date '2026-01-01', date '2026-03-31') -> 'resumen' ->> 'clientes_con_venta') = '9'
        and (restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') -> 'resumen' ->> 'clientes_con_venta') = '10')::int as alcance_deberia_ser_1;
rollback;

\echo '=== G2. ADMIN ACOTADO a A1 (sin lista): ve solo A1 => 9 clientes en RFM y 4 elegibles de reactivacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b02', true);
select ((restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') -> 'resumen' ->> 'clientes_con_venta') = '9'
        and (restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31') ->> 'total_elegibles') = '4')::int as acotado_deberia_ser_1;
rollback;

\echo '=== G3. RECHAZADO: admin acotado pidiendo A2 => 42501 en las 4 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b02', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), array[public.p2()]::uuid[], date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), array[public.p2()]::uuid[], date '2026-01-01', date '2026-03-31')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra(public.oa(), array[public.p2()]::uuid[], date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla(public.oa(), array[public.p2()]::uuid[], date '2026-01-01', date '2026-03-31')$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as acotado_rechazado_ok;
rollback;

\echo '=== G4. CROSS-TENANT: el owner de B ve SOLO a su cliente (1, venta 1999800, sin elegibles) y no los de A; el owner de A sobre la organizacion B (con o sin sucursal) => 42501; el de B sobre A => 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b05', true);
select ((restaurantes.cfo_clientes_rfm(public.ob(), null, date '2026-01-01', date '2026-03-31') -> 'resumen' ->> 'clientes_con_venta') = '1'
        and (restaurantes.cfo_clientes_rfm(public.ob(), null, date '2026-01-01', date '2026-03-31') -> 'resumen' ->> 'venta_total_centavos') = '1999800'
        and (restaurantes.cfo_clientes_reactivacion(public.ob(), null, date '2026-01-01', date '2026-03-31') ->> 'total_elegibles') = '0')::int as b_solo_lo_suyo_deberia_ser_1;
rollback;

\echo '=== G5. CROSS-TENANT RECHAZADO: A sobre B y B sobre A => 42501 en las 4 funciones, con p_props nulo y con sucursal ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_rfm(public.ob(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_rfm(public.ob(), array['00000000-0000-0000-0000-0000000e4a21']::uuid[], date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), array['00000000-0000-0000-0000-0000000e4a21']::uuid[], date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.ob(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra(public.ob(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla(public.ob(), null, date '2026-01-01', date '2026-03-31')$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as a_sobre_b_ok;
rollback;

\echo '=== G6. CROSS-TENANT RECHAZADO (sentido inverso): el owner de B sobre la organizacion A => 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b05', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as b_sobre_a_ok;
rollback;

\echo '=== G7. RECHAZADO: staff de piso => 42501 en las 4 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b03', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as staff_rechazado_ok;
rollback;

\echo '=== G8. RECHAZADO: repartidor => 42501 en las 4 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b04', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as repartidor_rechazado_ok;
rollback;

\echo '=== G9. RECHAZADO: anon (sin execute) => 42501 permission denied en las 4 funciones; usuario autenticado sin membresia => 42501 ==='
begin;
set local role anon;
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_rfm('00000000-0000-0000-0000-0000000e4a01', null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion('00000000-0000-0000-0000-0000000e4a01', null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra('00000000-0000-0000-0000-0000000e4a01', null, date '2026-01-01', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla('00000000-0000-0000-0000-0000000e4a01', null, date '2026-01-01', date '2026-03-31')$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as anon_rechazado_ok;
rollback;

\echo '=== G10. RECHAZADO: el helper interno cfo_clientes_rfm_base no es ejecutable por authenticated ni anon => 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select count(*) as should_fail from restaurantes.cfo_clientes_rfm_base('00000000-0000-0000-0000-0000000e4a01', array['00000000-0000-0000-0000-0000000e4a11']::uuid[], date '2026-01-01', date '2026-03-31');
rollback;

\echo '=== G11. RECHAZADO: rango invertido, de 401 dias, nulo => 22023 en las 4 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
do $$
declare v text;
begin
  foreach v in array array[
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-03-31', date '2026-01-01')$q$,
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2025-02-24', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_rfm(public.oa(), null, null, date '2026-03-31')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-03-31', date '2026-01-01')$q$,
    $q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2025-02-24', date '2026-03-31')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-03-31', date '2026-01-01')$q$,
    $q$select * from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2025-02-24', date '2026-03-31')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla(public.oa(), null, date '2026-03-31', date '2026-01-01')$q$,
    $q$select restaurantes.cfo_pedidos_tortilla(public.oa(), null, date '2025-02-24', date '2026-03-31')$q$
  ] loop
    perform public.t_esperar_error(v, '22023');
  end loop;
end $$;
select 1 as rango_invalido_ok;
rollback;

\echo '=== G12. RANGO MAXIMO: exactamente 400 dias (2025-02-25 .. 2026-03-31) SI responde ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select ((restaurantes.cfo_clientes_rfm(public.oa(), null, date '2025-02-25', date '2026-03-31') -> 'resumen' ->> 'clientes_con_venta')::int >= 10)::int as rango_400_deberia_ser_1;
rollback;

\echo '=== G13. RECHAZADO: sucursal inexistente o lista invalida => 42501 / 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
do $$
begin
  perform public.t_esperar_error($q$select restaurantes.cfo_clientes_rfm(public.oa(), array['00000000-0000-0000-0000-0000000e4aff']::uuid[], date '2026-01-01', date '2026-03-31')$q$, '42501');
  perform public.t_esperar_error($q$select restaurantes.cfo_clientes_rfm(public.oa(), array[]::uuid[], date '2026-01-01', date '2026-03-31')$q$, '22023');
  perform public.t_esperar_error($q$select restaurantes.cfo_clientes_rfm(null, null, date '2026-01-01', date '2026-03-31')$q$, '22023');
end $$;
select 1 as sucursal_invalida_ok;
rollback;

-- ===========================================================================
-- H. Postura SQL, solo lectura, base sin migrar y rendimiento
-- ===========================================================================
\echo '=== H1. grants: las 4 publicas solo para authenticated (anon y public sin execute); el helper cerrado a authenticated, anon y public ==='
begin;
select count(*)::int as grants_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_rfm', 'cfo_clientes_reactivacion', 'cfo_intervalo_recompra', 'cfo_pedidos_tortilla', 'cfo_clientes_rfm_base')
   and ((p.proname <> 'cfo_clientes_rfm_base' and (not has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')))
     or (p.proname = 'cfo_clientes_rfm_base' and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))));
rollback;

\echo '=== H2. hay exactamente 5 funciones (4 publicas + 1 helper), sin sobrecargas ==='
begin;
select count(*)::int as funciones_deberia_ser_5 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_rfm', 'cfo_clientes_reactivacion', 'cfo_intervalo_recompra', 'cfo_pedidos_tortilla', 'cfo_clientes_rfm_base');
rollback;

\echo '=== H3. SECURITY DEFINER, STABLE y search_path fijo (restaurantes, core, pg_temp) en las 5 ==='
begin;
select count(*)::int as postura_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_rfm', 'cfo_clientes_reactivacion', 'cfo_intervalo_recompra', 'cfo_pedidos_tortilla', 'cfo_clientes_rfm_base')
   and (not p.prosecdef or p.provolatile <> 's' or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=restaurantes, core, pg_temp'));
rollback;

\echo '=== H4. las 4 publicas tienen COMMENT y ninguna firma devuelve columnas con nombre, telefono, direccion ni customer_id ==='
begin;
select count(*)::int as comentario_o_pii_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'restaurantes' and p.proname in ('cfo_clientes_rfm', 'cfo_clientes_reactivacion', 'cfo_intervalo_recompra', 'cfo_pedidos_tortilla')
   and (obj_description(p.oid, 'pg_proc') is null
     or exists (select 1 from unnest(coalesce(p.proargnames, '{}'::text[])) a where a ~ '(nombre|phone|telefono|address|direccion|customer_id)'));
rollback;

\echo '=== H5. SOLO LECTURA: las 4 publicas corren en una transaccion READ ONLY y no dejan ninguna fila nueva ==='
begin;
set transaction read only;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31') is not null as rfm_ok;
select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31') is not null as reactivacion_ok;
select count(*) as intervalos_ok from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31');
select restaurantes.cfo_pedidos_tortilla(public.ot(), null, date '2026-03-01', date '2026-03-31') is not null as tortilla_ok;
rollback;

\echo '=== H6. BASE SIN MIGRAR: si la funcion no existe, la llamada da 42883 (el TypeScript lo recupera con SAVEPOINT) ==='
begin;
drop function restaurantes.cfo_clientes_rfm(uuid, uuid[], date, date);
drop function restaurantes.cfo_clientes_reactivacion(uuid, uuid[], date, date, integer);
drop function restaurantes.cfo_intervalo_recompra(uuid, uuid[], date, date);
drop function restaurantes.cfo_pedidos_tortilla(uuid, uuid[], date, date);
do $$
begin
  perform public.t_esperar_error($q$select restaurantes.cfo_clientes_rfm(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$, '42883');
  perform public.t_esperar_error($q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31', 10)$q$, '42883');
  perform public.t_esperar_error($q$select * from restaurantes.cfo_intervalo_recompra(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$, '42883');
  perform public.t_esperar_error($q$select restaurantes.cfo_pedidos_tortilla(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$, '42883');
end $$;
select 1 as base_sin_migrar_ok;
rollback;

\echo '=== H7. SIN 052: sin la tabla de consentimiento la reactivacion da 42P01 (el TypeScript lo recupera) ==='
begin;
alter table restaurantes.marketing_consentimiento rename to marketing_consentimiento_x;
do $$
begin
  perform public.t_esperar_error($q$select restaurantes.cfo_clientes_reactivacion(public.oa(), null, date '2026-01-01', date '2026-03-31')$q$, '42P01');
end $$;
select 1 as sin_052_ok;
rollback;

\echo '=== H8. rendimiento acotado: 10000 ventas (1500 clientes) en 90 dias; cada una de las 4 funciones responde en menos de 2 s (transaccion con rollback) ==='
begin;
insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000e4af1', 'restaurantes', 'Analisis Perf', 'analisis-perf');
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000e4af2', '00000000-0000-0000-0000-0000000e4af1', 'Perf');
insert into restaurantes.branch_detail (property_id, organization_id, slug) values ('00000000-0000-0000-0000-0000000e4af2', '00000000-0000-0000-0000-0000000e4af1', 'perf');
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ('00000000-0000-0000-0000-0000000e4b01', '00000000-0000-0000-0000-0000000e4af1', null, 'owner', 'owner');
insert into restaurantes.customers (id, organization_id, phone, name)
select ('bbbbbbbb-0000-0000-0000-' || lpad(to_hex(g), 12, '0'))::uuid, '00000000-0000-0000-0000-0000000e4af1', '+52 99' || lpad(g::text, 8, '0'), 'c' from generate_series(1, 1500) g;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, canal, created_at)
select '00000000-0000-0000-0000-0000000e4af1', '00000000-0000-0000-0000-0000000e4af2', ('bbbbbbbb-0000-0000-0000-' || lpad(to_hex(1 + (g * 7) % 1500), 12, '0'))::uuid, 'Perf',
       '+52 5500' || lpad((g % 9000)::text, 6, '0'), 100 + (g % 50), 'entregado',
       '[{"id":"p1","name":"Taco","price":50,"quantity":2,"tortilla":"maiz"}]'::jsonb, 'whatsapp', 'recoger',
       timestamptz '2026-04-01 00:00+00' + (g * interval '777 seconds')
  from generate_series(1, 10000) g;
analyze restaurantes.orders; analyze restaurantes.customers;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4b01', true);
do $$
declare
  t0 timestamptz;
  v text;
  n bigint;
  o uuid := '00000000-0000-0000-0000-0000000e4af1';
begin
  foreach v in array array[
    format('select count(*) from (select restaurantes.cfo_clientes_rfm(%L, null, date ''2026-04-01'', date ''2026-06-29'')) x', o),
    format('select count(*) from (select restaurantes.cfo_clientes_reactivacion(%L, null, date ''2026-04-01'', date ''2026-06-29'', 200)) x', o),
    format('select count(*) from restaurantes.cfo_intervalo_recompra(%L, null, date ''2026-04-01'', date ''2026-06-29'')', o),
    format('select count(*) from (select restaurantes.cfo_pedidos_tortilla(%L, null, date ''2026-04-01'', date ''2026-06-29'')) x', o)
  ] loop
    t0 := clock_timestamp();
    execute v into n;
    if clock_timestamp() - t0 > interval '2 seconds' then
      raise exception 'demasiado lento (%): %', clock_timestamp() - t0, v;
    end if;
  end loop;
  if (restaurantes.cfo_clientes_rfm(o, null, date '2026-04-01', date '2026-06-29') -> 'resumen' ->> 'clientes_con_venta')::int <> 1500 then
    raise exception 'el RFM de rendimiento no devolvio los 1500 clientes';
  end if;
end $$;
select 1 as rendimiento_ok;
rollback;
