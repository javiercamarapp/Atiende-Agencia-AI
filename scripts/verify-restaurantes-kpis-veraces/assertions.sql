-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales) de
-- packages/domain-restaurantes/migrations/036_kpis_veraces.sql (R-30, KPIs con rotulo veraz):
--
--   A. orders_bucketed_stats: ventas netas (sin cancelados), conteo de ordenes sin cancelados, clientes por
--      customer_id (dos "Juan" distintos = 2; una misma persona con dos grafias = 1), cross-tenant.
--   B. orders_channel_stats / orders_channel_stats_periodo: ingresos sin cancelados (los conteos de pedidos si
--      incluyen cancelados), ventana de periodo, cross-tenant y anon sin acceso a la funcion nueva.
--   C. get_customer_overview_kpis: ticket promedio sin pedidos cancelados.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`: un escenario
-- "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000f0001', 'restaurantes', 'KV Org A', 'kv-org-a'),
  ('00000000-0000-0000-0000-0000000f0002', 'restaurantes', 'KV Org B (ajena)', 'kv-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f0001', 'kv-a1'),
  ('00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f0002', 'kv-b1')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000f0011', 'owner-a@kv.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000f0014', 'owner-b@kv.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000f0011', '00000000-0000-0000-0000-0000000f0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000f0014', '00000000-0000-0000-0000-0000000f0002', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000f00c1', '00000000-0000-0000-0000-0000000f0001', '+5219991230001', 'Juan'),
  ('00000000-0000-0000-0000-0000000f00c2', '00000000-0000-0000-0000-0000000f0001', '+5219991230002', 'Juan'),
  ('00000000-0000-0000-0000-0000000f00c3', '00000000-0000-0000-0000-0000000f0001', '+5219991230003', 'Maria'),
  ('00000000-0000-0000-0000-0000000f00c9', '00000000-0000-0000-0000-0000000f0002', '+5219991230009', 'Cliente B')
on conflict do nothing;

-- Org A, dentro de la ventana 2026-09-01..2026-09-08: voz 100 (completado, Juan c1), voz 1000 (cancelado, c1),
-- whatsapp 200 (entregado, Juan c2), whatsapp 50 (pending, Maria c3), whatsapp 50 (pending, "Maria" con otra
-- grafia pero el MISMO customer_id c3). Fuera de la ventana: web 900 (completado, c1, 2026-01-01).
-- Org B: voz 7000 (completado).
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000f00e1', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c1', 'Juan', '+5219991230001', 100, 'completado', '[]'::jsonb, 'voice', '2026-09-03 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000f00e2', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c1', 'Juan', '+5219991230001', 1000, 'cancelado', '[]'::jsonb, 'voice', '2026-09-03 13:00:00+00'),
  ('00000000-0000-0000-0000-0000000f00e3', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c2', 'Juan', '+5219991230002', 200, 'entregado', '[]'::jsonb, 'whatsapp', '2026-09-04 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000f00e4', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c3', 'Maria', '+5219991230003', 50, 'pending', '[]'::jsonb, 'whatsapp', '2026-09-04 13:00:00+00'),
  ('00000000-0000-0000-0000-0000000f00e5', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c3', 'María', '+5219991230003', 50, 'pending', '[]'::jsonb, 'whatsapp', '2026-09-05 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000f00e6', '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c1', 'Juan', '+5219991230001', 900, 'completado', '[]'::jsonb, 'web', '2026-01-01 12:00:00+00'),
  ('00000000-0000-0000-0000-0000000f00f1', '00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-0000000f00b1', '00000000-0000-0000-0000-0000000f00c9', 'Cliente B', '+5219991230009', 7000, 'completado', '[]'::jsonb, 'voice', '2026-09-03 12:00:00+00')
on conflict do nothing;

-- ===========================================================================
-- A. orders_bucketed_stats (ventana 2026-09-01 .. 2026-09-08)
-- ===========================================================================
\echo '=== A1. POSITIVO: ventas netas sin cancelados = 100+200+50+50 = 400 (el cancelado de 1000 no suma) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select revenue::int as ventas_netas_deberia_ser_400
from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0001', null, array['2026-09-01 00:00:00+00'::timestamptz], array['2026-09-08 00:00:00+00'::timestamptz]);
rollback;

\echo '=== A2. POSITIVO: ordenes sin cancelados = 4 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select order_count::int as ordenes_deberia_ser_4
from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0001', null, array['2026-09-01 00:00:00+00'::timestamptz], array['2026-09-08 00:00:00+00'::timestamptz]);
rollback;

\echo '=== A3. POSITIVO: clientes por customer_id = 3 (c1, c2 y c3; el pedido de Maria con otra grafia no suma un cliente nuevo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select customer_count::int as clientes_por_id_deberia_ser_3
from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0001', null, array['2026-09-01 00:00:00+00'::timestamptz], array['2026-09-08 00:00:00+00'::timestamptz]);
rollback;

\echo '=== A4. POSITIVO: dos clientes con el MISMO nombre (Juan c1 y Juan c2) cuentan 2 en una ventana que solo los contiene a ellos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select customer_count::int as juanes_distintos_deberia_ser_2
from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0001', null, array['2026-09-03 00:00:00+00'::timestamptz], array['2026-09-04 12:30:00+00'::timestamptz]);
rollback;

\echo '=== A4b. POSITIVO (H61 / 5f7cbb9): 1,200 pedidos de $10 suman EXACTAMENTE 12000 en ventas (agregado en SQL, sin tope de 1000 filas de la API) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at)
select '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c1', 'Juan', '+5219991230001', 10, 'completado', '[]'::jsonb, 'web',
       '2026-10-01 12:00:00+00'::timestamptz + (g || ' seconds')::interval
from generate_series(1, 1200) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select revenue::int as ventas_deberia_ser_12000
from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0001', null, array['2026-10-01 00:00:00+00'::timestamptz], array['2026-10-02 00:00:00+00'::timestamptz]);
rollback;

\echo '=== A4c. POSITIVO (H61 / 5f7cbb9): los mismos 1,200 pedidos cuentan EXACTAMENTE 1200 ordenes ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source, created_at)
select '00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-0000000f00a1', '00000000-0000-0000-0000-0000000f00c1', 'Juan', '+5219991230001', 10, 'completado', '[]'::jsonb, 'web',
       '2026-10-01 12:00:00+00'::timestamptz + (g || ' seconds')::interval
from generate_series(1, 1200) g;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select order_count::int as ordenes_deberia_ser_1200
from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0001', null, array['2026-10-01 00:00:00+00'::timestamptz], array['2026-10-02 00:00:00+00'::timestamptz]);
rollback;

\echo '=== A5. CROSS-TENANT: el owner de A pidiendo la organizacion B ve ventas 0 (RLS), nunca los 7000 ajenos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select revenue::int as ventas_ajenas_deberia_ser_0
from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0002', null, array['2026-09-01 00:00:00+00'::timestamptz], array['2026-09-08 00:00:00+00'::timestamptz]);
rollback;

\echo '=== A6. RECHAZADO (debe fallar): anon no puede leer orders por la funcion ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.orders_bucketed_stats('00000000-0000-0000-0000-0000000f0001', null, array['2026-09-01 00:00:00+00'::timestamptz], array['2026-09-08 00:00:00+00'::timestamptz]) as should_fail;
rollback;

-- ===========================================================================
-- B. canales
-- ===========================================================================
\echo '=== B1. POSITIVO: canales con periodo: ingreso total sin cancelados = 400 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select total_revenue::int as ingreso_periodo_deberia_ser_400
from restaurantes.orders_channel_stats_periodo('00000000-0000-0000-0000-0000000f0001', null, '2026-09-01 00:00:00+00', '2026-09-08 00:00:00+00');
rollback;

\echo '=== B2. POSITIVO: ingreso de voz del periodo = 100 (sin el cancelado de 1000) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select voice_revenue::int as voz_periodo_deberia_ser_100
from restaurantes.orders_channel_stats_periodo('00000000-0000-0000-0000-0000000f0001', null, '2026-09-01 00:00:00+00', '2026-09-08 00:00:00+00');
rollback;

\echo '=== B3. POSITIVO: los conteos SI incluyen al cancelado: pedidos de voz del periodo = 2 y cancelados de voz = 1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select (voice_orders = 2 and voice_cancelled = 1)::int as conteos_con_cancelados_deberia_ser_1
from restaurantes.orders_channel_stats_periodo('00000000-0000-0000-0000-0000000f0001', null, '2026-09-01 00:00:00+00', '2026-09-08 00:00:00+00');
rollback;

\echo '=== B4. POSITIVO: la ventana acota: el pedido web de enero (900) no entra en septiembre; total_orders del periodo = 5 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select total_orders::int as pedidos_periodo_deberia_ser_5
from restaurantes.orders_channel_stats_periodo('00000000-0000-0000-0000-0000000f0001', null, '2026-09-01 00:00:00+00', '2026-09-08 00:00:00+00');
rollback;

\echo '=== B5. POSITIVO: la funcion sin periodo (historico) tambien excluye cancelados: 400 + 900 = 1300 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select total_revenue::int as ingreso_historico_deberia_ser_1300
from restaurantes.orders_channel_stats('00000000-0000-0000-0000-0000000f0001', null);
rollback;

\echo '=== B6. CROSS-TENANT: el owner de A pidiendo canales de B ve 0 pedidos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select total_orders::int as pedidos_ajenos_deberia_ser_0
from restaurantes.orders_channel_stats_periodo('00000000-0000-0000-0000-0000000f0002', null, '2026-09-01 00:00:00+00', '2026-09-08 00:00:00+00');
rollback;

\echo '=== B7. RECHAZADO (debe fallar): anon no tiene EXECUTE sobre orders_channel_stats_periodo ==='
begin;
set local role anon;
select set_config('request.jwt.claim.sub', '', true);
select * from restaurantes.orders_channel_stats_periodo('00000000-0000-0000-0000-0000000f0001', null, '2026-09-01 00:00:00+00', '2026-09-08 00:00:00+00') as should_fail;
rollback;

-- ===========================================================================
-- C. ticket promedio de clientes
-- ===========================================================================
\echo '=== C1. POSITIVO: ticket promedio sin cancelados = (100+200+50+50+900)/5 = 260 (con el cancelado de 1000 daria 383) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select round(average_order_value)::int as ticket_sin_cancelados_deberia_ser_260
from restaurantes.get_customer_overview_kpis('00000000-0000-0000-0000-0000000f0001');
rollback;

\echo '=== C2. CROSS-TENANT: el owner de A pidiendo clientes de B ve total_customers = 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000f0011', true);
select total_customers::int as clientes_ajenos_deberia_ser_0
from restaurantes.get_customer_overview_kpis('00000000-0000-0000-0000-0000000f0002');
rollback;
