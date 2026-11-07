-- Fixtures + escenarios contra Postgres REAL (rol `authenticated`, RLS/GRANT/auth.uid() reales) de las migraciones 160-163 de packages/domain-restaurantes:
-- analitica_demanda, analitica_zonas, analitica_productos, analitica_costo_producto_guardar, analitica_combo_sugerir, analitica_ratios,
-- analitica_alertas_candidatos y analitica_pregunta_estado. Corpus SINTETICO con valores calculados a mano. Rango 2026-03-01 .. 2026-03-31 (zona America/Mexico_City,
-- sin horario => corte 0). 2026-03-06 es viernes (ISO 5), 03-07 sabado, 03-08 domingo, 03-10 martes.
--
-- Organizacion A, sucursal A1 (ventas; hora local 13:00 salvo que se diga, importes en pesos):
--   D1..D5  domicilio Centro, clientes c1..c5, vie 03-06, total 100, entregados en 40/40/50/70/30 min con promesa de 45 min; D1-D3 efectivo, D4-D5 tarjeta;
--           items: bistec x1 + frijoles x1
--   D6, D7  domicilio Norte, cliente c6, sab 03-07 19:00, total 200, entregados en 35 y 45 min SIN promesa; D6 efectivo; items: bistec x2
--   D8      domicilio sin colonia conocida (c7), sab 03-07 19:00, total 150, en_camino (sin cierre)
--   R1, R2  recoger c8 y c9, dom 03-08, total 80, entregados en 10 min; items: refresco x1
--   E1      recoger c1, mar 03-10, total 90 (segunda compra de c1 a 4 dias)
--   => ventas A1: 11 pedidos, 130000 centavos, 4 dias con venta, 2 semanas (03-02 con 10 pedidos y 3 dias; 03-09 con 1).
--   Ruido que NO cuenta: K1 cancelado (500, c2; cuenta como cancelacion), pedido falso, trafico demo 0009, programado.
-- Sucursal A2: una venta de 300 (vie 03-06, sin cliente). Con A1 => owner ve 12 pedidos y 160000 centavos.
-- Chats A1 (creados en el rango): cv1 ligado a D1, cv2 ligado al cancelado K1, cv3 con solicitud de persona, cv4 sin respuesta. Respuestas medidas: 20 s agente,
--   120 s persona (cv1), 40 s agente (cv2), 480 s agente (cv3); cv4 no tiene respuesta aun.
-- Promocion de cortesia COMBO-BF: dispara bistec, regala frijoles. Organizacion B ajena (cross-tenant). Organizacion T: alertas (ETA y ya salio), solo sistema.
--
-- Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`; el alias `should_fail` marca el que debe terminar en ERROR; los alias con sufijo
-- de valor esperado marcan el entero esperado (siempre un count(*) entero).
\set ON_ERROR_STOP off
\pset pager off

create or replace function public.t_ped2(p_org uuid, p_prop uuid, p_cust uuid, p_dia date, p_hora time, p_total numeric, p_canal text, p_status text default 'entregado',
  p_entrega_min integer default null, p_prom_min integer default null, p_pago text default null, p_dir text default null, p_items jsonb default '[]'::jsonb,
  p_phone text default null, p_id uuid default gen_random_uuid(), p_tz text default 'America/Mexico_City') returns uuid
language plpgsql as $$
declare
  v_ts timestamptz := (p_dia + p_hora) at time zone p_tz;
begin
  insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, total, status, items, source, canal,
                                   payment_method, created_at, delivered_at, estimated_delivery_at, programado_para)
  values (p_id, p_org, p_prop, p_cust, 'Cliente', coalesce(p_phone, '+52 5500000000'), p_dir, p_total, p_status, p_items, 'whatsapp', p_canal, p_pago, v_ts,
          case when p_entrega_min is not null then v_ts + make_interval(mins => p_entrega_min) end,
          case when p_prom_min is not null then v_ts + make_interval(mins => p_prom_min) end,
          case when p_status = 'programado' then v_ts + interval '5 days' end);
  return p_id;
end $$;

create or replace function public.oa() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e5a01'::uuid $$;
create or replace function public.ob() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e5a02'::uuid $$;
create or replace function public.ot() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e5a03'::uuid $$;
create or replace function public.p1() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e5a11'::uuid $$;
create or replace function public.p2() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e5a12'::uuid $$;
create or replace function public.pb1() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e5a21'::uuid $$;
create or replace function public.pt1() returns uuid language sql immutable as $$ select '00000000-0000-0000-0000-0000000e5a31'::uuid $$;
create or replace function public.c(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000e5c' || lpad(to_hex(n), 2, '0'))::uuid $$;
create or replace function public.prod(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000e5b' || lpad(to_hex(n), 2, '0'))::uuid $$;
create or replace function public.u(n int) returns uuid language sql immutable as $$ select ('00000000-0000-0000-0000-0000000e5d' || lpad(to_hex(n), 2, '0'))::uuid $$;

insert into core.organization (id, vertical, name, slug) values
  (public.oa(), 'restaurantes', 'Analitica Org A', 'analitica-a'),
  (public.ob(), 'restaurantes', 'Analitica Org B', 'analitica-b'),
  (public.ot(), 'restaurantes', 'Analitica Org T', 'analitica-t')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  (public.p1(), public.oa(), 'Sucursal A1'),
  (public.p2(), public.oa(), 'Sucursal A2'),
  (public.pb1(), public.ob(), 'Sucursal B1'),
  (public.pt1(), public.ot(), 'Sucursal T1')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria, lat, lng) values
  (public.p1(), public.oa(), 'a1', null, 21.5, -90.0),
  (public.p2(), public.oa(), 'a2', null, 20.97, -89.62),
  (public.pb1(), public.ob(), 'b1', null, null, null),
  (public.pt1(), public.ot(), 't1', null, null, null)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  (public.u(1), 'owner-a@analitica.example.com', 'Owner A', 'seed'),
  (public.u(2), 'admin-a1@analitica.example.com', 'Admin A1', 'seed'),
  (public.u(3), 'staff-a@analitica.example.com', 'Staff A', 'seed'),
  (public.u(4), 'rep-a@analitica.example.com', 'Repartidor A', 'seed'),
  (public.u(5), 'owner-b@analitica.example.com', 'Owner B', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  (public.u(1), public.oa(), null, 'owner', 'owner'),
  (public.u(2), public.oa(), array[public.p1()]::uuid[], 'admin', 'admin'),
  (public.u(3), public.oa(), null, 'member', 'staff'),
  (public.u(4), public.oa(), null, 'member', 'repartidor'),
  (public.u(5), public.ob(), null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name) values
  (public.c(1), public.oa(), '+52 5500001001', 'c1'), (public.c(2), public.oa(), '+52 5500001002', 'c2'), (public.c(3), public.oa(), '+52 5500001003', 'c3'),
  (public.c(4), public.oa(), '+52 5500001004', 'c4'), (public.c(5), public.oa(), '+52 5500001005', 'c5'), (public.c(6), public.oa(), '+52 5500001006', 'c6'),
  (public.c(7), public.oa(), '+52 5500001007', 'c7'), (public.c(8), public.oa(), '+52 5500001008', 'c8'), (public.c(9), public.oa(), '+52 5500001009', 'c9'),
  (public.c(10), public.ob(), '+52 5500002001', 'bc1');
-- Domicilios con colonia conocida (c7 NO tiene fila: su domicilio queda «sin colonia»).
insert into restaurantes.customer_addresses (customer_id, address, colonia) values
  (public.c(1), 'Calle 1 #1', 'Centro'), (public.c(2), 'Calle 2 #2', 'Centro'), (public.c(3), 'Calle 3 #3', 'Centro'),
  (public.c(4), 'Calle 4 #4', 'Centro'), (public.c(5), 'Calle 5 #5', 'Centro'), (public.c(6), 'Calle 6 #6', 'Norte');

insert into restaurantes.products (id, organization_id, name, price) values
  (public.prod(1), public.oa(), 'Bistec', 60), (public.prod(2), public.oa(), 'Frijoles', 20), (public.prod(3), public.oa(), 'Refresco', 25),
  (public.prod(4), public.ob(), 'Producto ajeno', 10);
insert into restaurantes.branch_products (property_id, product_id, price, is_available) values
  (public.p1(), public.prod(1), 60, true), (public.p1(), public.prod(2), 20, true), (public.p1(), public.prod(3), 25, true);
insert into restaurantes.promotions (organization_id, code, name, type, value, is_active, product_ids, courtesy_product_ids, courtesy_quantity)
values (public.oa(), 'COMBO-BF', 'Combo bistec con frijoles', 'cortesia', 1, true, array[public.prod(1)]::uuid[], array[public.prod(2)]::uuid[], 1);

-- Ventas A1
select public.t_ped2(public.oa(), public.p1(), public.c(1), date '2026-03-06', time '13:00', 100, 'domicilio', p_entrega_min => 40, p_prom_min => 45, p_pago => 'efectivo', p_dir => 'Calle 1 #1', p_id => '00000000-0000-0000-0000-0000000e5f01',
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b01","name":"Bistec","price":60,"quantity":1},{"id":"00000000-0000-0000-0000-0000000e5b02","name":"Frijoles","price":20,"quantity":1}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(2), date '2026-03-06', time '13:00', 100, 'domicilio', p_entrega_min => 40, p_prom_min => 45, p_pago => 'efectivo', p_dir => 'Calle 2 #2',
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b01","name":"Bistec","price":60,"quantity":1},{"id":"00000000-0000-0000-0000-0000000e5b02","name":"Frijoles","price":20,"quantity":1}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(3), date '2026-03-06', time '13:00', 100, 'domicilio', p_entrega_min => 50, p_prom_min => 45, p_pago => 'efectivo', p_dir => 'Calle 3 #3',
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b01","name":"Bistec","price":60,"quantity":1},{"id":"00000000-0000-0000-0000-0000000e5b02","name":"Frijoles","price":20,"quantity":1}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(4), date '2026-03-06', time '13:00', 100, 'domicilio', p_entrega_min => 70, p_prom_min => 45, p_pago => 'tarjeta', p_dir => 'Calle 4 #4',
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b01","name":"Bistec","price":60,"quantity":1},{"id":"00000000-0000-0000-0000-0000000e5b02","name":"Frijoles","price":20,"quantity":1}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(5), date '2026-03-06', time '13:00', 100, 'domicilio', p_entrega_min => 30, p_prom_min => 45, p_pago => 'tarjeta', p_dir => 'Calle 5 #5',
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b01","name":"Bistec","price":60,"quantity":1},{"id":"00000000-0000-0000-0000-0000000e5b02","name":"Frijoles","price":20,"quantity":1}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(6), date '2026-03-07', time '19:00', 200, 'domicilio', p_entrega_min => 35, p_pago => 'efectivo', p_dir => 'Calle 6 #6',
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b01","name":"Bistec","price":60,"quantity":2}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(6), date '2026-03-07', time '19:00', 200, 'domicilio', p_entrega_min => 45, p_dir => 'Calle 6 #6',
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b01","name":"Bistec","price":60,"quantity":2}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(7), date '2026-03-07', time '19:00', 150, 'domicilio', p_status => 'en_camino', p_dir => 'Calle 8 #8');
select public.t_ped2(public.oa(), public.p1(), public.c(8), date '2026-03-08', time '13:00', 80, 'recoger', p_entrega_min => 10,
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b03","name":"Refresco","price":25,"quantity":1}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(9), date '2026-03-08', time '13:00', 80, 'recoger', p_entrega_min => 10,
  p_items => '[{"id":"00000000-0000-0000-0000-0000000e5b03","name":"Refresco","price":25,"quantity":1}]'::jsonb);
select public.t_ped2(public.oa(), public.p1(), public.c(1), date '2026-03-10', time '13:00', 90, 'recoger', p_entrega_min => 12);
-- Ruido que NO cuenta como venta
select public.t_ped2(public.oa(), public.p1(), public.c(2), date '2026-03-06', time '13:30', 500, 'recoger', p_status => 'cancelado', p_id => '00000000-0000-0000-0000-0000000e5f02');
select public.t_ped2(public.oa(), public.p1(), public.c(3), date '2026-03-06', time '13:40', 777, 'recoger', p_id => '00000000-0000-0000-0000-0000000e5f03');
update restaurantes.orders set pedido_falso_at = now() where id = '00000000-0000-0000-0000-0000000e5f03';
select public.t_ped2(public.oa(), public.p1(), public.c(4), date '2026-03-06', time '13:50', 888, 'recoger', p_phone => '+52 0009000002');
select public.t_ped2(public.oa(), public.p1(), public.c(5), date '2026-03-06', time '14:00', 666, 'recoger', p_status => 'programado');
-- A2 y B
select public.t_ped2(public.oa(), public.p2(), null, date '2026-03-06', time '13:00', 300, 'recoger');
select public.t_ped2(public.ob(), public.pb1(), public.c(10), date '2026-03-06', time '13:00', 9999, 'recoger');

-- Chats A1 (conversaciones nuevas del rango; mensajes con hora para medir la primera respuesta)
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages, status, order_id, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000e5e01', public.oa(), '+52 5500009001', public.p1(),
   '[{"role":"user","content":"hola","at":"2026-03-06T19:00:00.000Z"},{"role":"assistant","content":"ok","autor":"agente","at":"2026-03-06T19:00:20.000Z"},{"role":"user","content":"gracias","at":"2026-03-06T19:10:00.000Z"},{"role":"assistant","content":"x","autor":"humano","at":"2026-03-06T19:12:00.000Z"}]'::jsonb,
   'completed', '00000000-0000-0000-0000-0000000e5f01', '2026-03-06T19:00:00Z', '2026-03-06T19:12:00Z'),
  ('00000000-0000-0000-0000-0000000e5e02', public.oa(), '+52 5500009002', public.p1(),
   '[{"role":"user","content":"hola","at":"2026-03-06T19:00:00.000Z"},{"role":"assistant","content":"ok","autor":"agente","at":"2026-03-06T19:00:40.000Z"}]'::jsonb,
   'completed', '00000000-0000-0000-0000-0000000e5f02', '2026-03-06T19:00:00Z', '2026-03-06T19:00:40Z'),
  ('00000000-0000-0000-0000-0000000e5e03', public.oa(), '+52 5500009003', public.p1(),
   '[{"role":"user","content":"hola","at":"2026-03-06T19:00:00.000Z"},{"role":"assistant","content":"ok","autor":"agente","at":"2026-03-06T19:08:00.000Z"}]'::jsonb,
   'active', null, '2026-03-06T19:00:00Z', '2026-03-06T19:08:00Z'),
  ('00000000-0000-0000-0000-0000000e5e04', public.oa(), '+52 5500009004', public.p1(),
   '[{"role":"user","content":"hola","at":"2026-03-06T19:00:00.000Z"}]'::jsonb,
   'active', null, '2026-03-06T19:00:00Z', '2026-03-06T19:00:00Z');
insert into restaurantes.conversation_handoff (organization_id, property_id, canal, conversation_id, estado, solicitado_por)
values (public.oa(), public.p1(), 'whatsapp', '00000000-0000-0000-0000-0000000e5e03', 'pendiente', 'agente');

-- Organizacion T: alertas. Reloj de las pruebas: 2026-03-20 13:00 UTC.
insert into restaurantes.whatsapp_conversations (id, organization_id, phone, property_id, messages, status, created_at, updated_at) values
  ('00000000-0000-0000-0000-0000000e5e11', public.ot(), '+52 5500003001', public.pt1(), '[{"role":"user","content":"¿Ya salió mi pedido?","at":"2026-03-20T12:40:00.000Z"}]'::jsonb, 'active', '2026-03-20T12:30:00Z', '2026-03-20T12:40:00Z'),
  ('00000000-0000-0000-0000-0000000e5e12', public.ot(), '+52 5500003002', public.pt1(), '[{"role":"user","content":"ya salió?","at":"2026-03-20T12:40:00.000Z"}]'::jsonb, 'active', '2026-03-20T12:30:00Z', '2026-03-20T12:40:00Z'),
  ('00000000-0000-0000-0000-0000000e5e13', public.ot(), '+52 5500003003', public.pt1(), '[{"role":"user","content":"ya salió?","at":"2026-03-20T12:40:00.000Z"},{"role":"assistant","content":"va en camino","autor":"agente","at":"2026-03-20T12:41:00.000Z"}]'::jsonb, 'active', '2026-03-20T12:30:00Z', '2026-03-20T12:41:00Z'),
  ('00000000-0000-0000-0000-0000000e5e14', public.ot(), '+52 5500003004', public.pt1(), '[{"role":"user","content":"¿ya salieron los precios nuevos?","at":"2026-03-20T12:40:00.000Z"}]'::jsonb, 'active', '2026-03-20T12:30:00Z', '2026-03-20T12:40:00Z'),
  ('00000000-0000-0000-0000-0000000e5e15', public.ot(), '+52 5500003005', public.pt1(), '[{"role":"user","content":"ya salió?","at":"2026-03-20T12:58:00.000Z"}]'::jsonb, 'active', '2026-03-20T12:50:00Z', '2026-03-20T12:58:00Z');
-- Pedidos abiertos de T: de las conversaciones 3001, 3003, 3004 y 3005 (la 3002 NO tiene pedido abierto) y tres domicilios con promesa distinta.
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:30', 100, 'domicilio', p_status => 'pending', p_dir => 'Calle T #1', p_phone => '+52 5500003001', p_tz => 'America/Mexico_City');
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:30', 100, 'domicilio', p_status => 'pending', p_dir => 'Calle T #3', p_phone => '+52 5500003003');
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:30', 100, 'domicilio', p_status => 'pending', p_dir => 'Calle T #4', p_phone => '+52 5500003004');
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:30', 100, 'domicilio', p_status => 'pending', p_dir => 'Calle T #5', p_phone => '+52 5500003005');
-- ETA: 75 min prometidos (alerta), 50 (no), 75 pero entregado (no), 75 pero de hace 30 h (fuera de ventana), 75 para recoger (no)
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:00', 100, 'domicilio', p_status => 'preparando', p_prom_min => 75, p_dir => 'Calle T #6', p_phone => '+52 5500004001');
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:00', 100, 'domicilio', p_status => 'preparando', p_prom_min => 50, p_dir => 'Calle T #7', p_phone => '+52 5500004002');
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:00', 100, 'domicilio', p_status => 'entregado', p_entrega_min => 40, p_prom_min => 75, p_dir => 'Calle T #8', p_phone => '+52 5500004003');
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-19', time '00:00', 100, 'domicilio', p_status => 'preparando', p_prom_min => 75, p_dir => 'Calle T #9', p_phone => '+52 5500004004');
select public.t_ped2(public.ot(), public.pt1(), null, date '2026-03-20', time '06:00', 100, 'recoger', p_status => 'preparando', p_prom_min => 75, p_phone => '+52 5500004005');
analyze restaurantes.orders; analyze restaurantes.customers;

-- ===========================================================================
-- A. Demanda
-- ===========================================================================

\echo '=== A1. Totales de A1: 11 pedidos y 130000 centavos (cancelado, falso, demo y programado no cuentan) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_totales_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (j->'totales'->0->>'pedidos') = '11' and (j->'totales'->0->>'neta_centavos') = '130000' and jsonb_array_length(j->'totales') = 1;
rollback;

\echo '=== A2. Cuatro dias con venta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_dias_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (j->>'dias_con_venta') = '4';
rollback;

\echo '=== A3. Matriz: 4 celdas distintas que suman 11; 8 pedidos a las 13 h y 3 a las 19 h (picos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_matriz_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where jsonb_array_length(j->'matriz') = 4 and (select sum((x->>'pedidos')::int) from jsonb_array_elements(j->'matriz') x) = 11 and (select sum((x->>'pedidos')::int) from jsonb_array_elements(j->'matriz') x where (x->>'hora')::int = 13) = 8 and (select sum((x->>'pedidos')::int) from jsonb_array_elements(j->'matriz') x where (x->>'hora')::int = 19) = 3;
rollback;

\echo '=== A4. Viernes 13 h domicilio = 5 pedidos; domingo recoger = 2 (dia de la semana ISO) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_dow_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (select (x->>'pedidos')::int from jsonb_array_elements(j->'matriz') x where (x->>'dow')::int = 5 and (x->>'hora')::int = 13 and x->>'canal' = 'domicilio') = 5 and (select (x->>'pedidos')::int from jsonb_array_elements(j->'matriz') x where (x->>'dow')::int = 7 and x->>'canal' = 'recoger') = 2;
rollback;

\echo '=== A5. Mezcla de pago: 4 efectivo, 2 tarjeta, 5 sin dato ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_pago_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (select (x->>'pedidos')::int from jsonb_array_elements(j->'pago') x where x->>'forma_pago' = 'efectivo') = 4 and (select (x->>'pedidos')::int from jsonb_array_elements(j->'pago') x where x->>'forma_pago' = 'tarjeta') = 2 and (select (x->>'pedidos')::int from jsonb_array_elements(j->'pago') x where x->>'forma_pago' = 'sin_dato') = 5;
rollback;

\echo '=== A6. Ticket: domicilio 8 pedidos 105000 (mediana 10000, p90 20000); recoger 25000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_ticket_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (select (x->>'pedidos')::int from jsonb_array_elements(j->'ticket') x where x->>'canal' = 'domicilio') = 8 and (select (x->>'neta_centavos')::int from jsonb_array_elements(j->'ticket') x where x->>'canal' = 'domicilio') = 105000 and (select (x->>'mediana_centavos')::int from jsonb_array_elements(j->'ticket') x where x->>'canal' = 'domicilio') = 10000 and (select (x->>'p90_centavos')::int from jsonb_array_elements(j->'ticket') x where x->>'canal' = 'domicilio') = 20000 and (select (x->>'neta_centavos')::int from jsonb_array_elements(j->'ticket') x where x->>'canal' = 'recoger') = 25000;
rollback;

\echo '=== A7. Entrega real contra la promesa: 3 de 5 a tiempo, 2 sin promesa, 1 sin cierre, mediana real 40 contra 45 prometidos (desvio -5) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_promesa_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31')->'promesa'->0 as x) q where (x->>'domicilios')::int = 8 and (x->>'entregados')::int = 7 and (x->>'con_promesa')::int = 5 and (x->>'a_tiempo')::int = 3 and (x->>'sin_promesa')::int = 2 and (x->>'sin_cierre')::int = 1 and (x->>'real_mediana_min')::numeric = 40 and (x->>'prometido_mediana_min')::numeric = 45 and (x->>'desvio_mediana_min')::numeric = -5;
rollback;

\echo '=== A8. Tendencia semanal: semana del 2 de marzo (10 pedidos, 3 dias) y del 9 (1 pedido) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_semanas_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where jsonb_array_length(j->'semanas') = 2 and (j->'semanas'->0->>'semana') = '2026-03-02' and (j->'semanas'->0->>'pedidos') = '10' and (j->'semanas'->0->>'dias') = '3' and (j->'semanas'->1->>'semana') = '2026-03-09' and (j->'semanas'->1->>'pedidos') = '1';
rollback;

\echo '=== A9. El owner sin filtro ve las dos sucursales: 12 pedidos y 160000 centavos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as dem_owner_todas_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), null, date '2026-03-01', date '2026-03-31') as j) q where jsonb_array_length(j->'totales') = 2 and (select sum((x->>'pedidos')::int) from jsonb_array_elements(j->'totales') x) = 12 and (select sum((x->>'neta_centavos')::int) from jsonb_array_elements(j->'totales') x) = 160000;
rollback;

\echo '=== A10. El admin acotado a A1 sin filtro ve solo A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d02', true);
select count(*)::int as dem_acotado_deberia_ser_1 from (select restaurantes.analitica_demanda(public.oa(), null, date '2026-03-01', date '2026-03-31') as j) q where jsonb_array_length(j->'totales') = 1 and (j->'totales'->0->>'pedidos') = '11';
rollback;

\echo '=== A11. El owner de B ve solo lo suyo (cross-tenant) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d05', true);
select count(*)::int as dem_owner_b_deberia_ser_1 from (select restaurantes.analitica_demanda(public.ob(), null, date '2026-03-01', date '2026-03-31') as j) q where (j->'totales'->0->>'pedidos') = '1' and (j->'totales'->0->>'neta_centavos') = '999900' and jsonb_array_length(j->'totales') = 1;
rollback;

\echo '=== A12. Admin acotado a A1 pide A2: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d02', true);
select restaurantes.analitica_demanda(public.oa(), array[public.p2()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== A13. Staff: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d03', true);
select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== A14. Repartidor: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d04', true);
select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== A15. Owner de B pide la organizacion A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d05', true);
select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== A16. Anon: sin permiso de ejecucion ==='
begin;
set local role anon;
select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== A17. Rango invertido: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-03-31', date '2026-03-01') as should_fail;
rollback;

\echo '=== A18. Rango de 401 dias: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_demanda(public.oa(), array[public.p1()], date '2026-01-01', date '2027-02-05') as should_fail;
rollback;

-- ===========================================================================
-- B. Zonas
-- ===========================================================================

\echo '=== B1. Centro: 5 pedidos, 5 clientes, 5 entregas, mediana 40, p90 70, una de mas de 60 min ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as zona_centro_deberia_ser_1 from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') z where z.colonia = 'Centro' and z.pedidos = 5 and z.clientes = 5 and z.entregados = 5 and z.mediana_min = 40 and z.p90_min = 70 and z.mas_de_60 = 1 and z.sin_cierre = 0 and z.neta_centavos = 50000;
rollback;

\echo '=== B2. Norte (2 pedidos, 1 cliente) NO sale con nombre ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as zona_norte_oculta_deberia_ser_0 from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') z where z.colonia = 'Norte';
rollback;

\echo '=== B3. «(otras)» junta a Norte: 2 pedidos, 1 cliente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as zona_otras_deberia_ser_1 from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') z where z.colonia = '(otras)' and z.pedidos = 2 and z.clientes = 1 and z.domicilios = 2;
rollback;

\echo '=== B4. «sin colonia / recoge»: 4 pedidos (1 domicilio y 3 para recoger), sin cierre 1, sin tiempos inventados ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as zona_sin_colonia_deberia_ser_1 from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') z where z.colonia = 'sin colonia / recoge' and z.pedidos = 4 and z.domicilios = 1 and z.recogidas = 3 and z.entregados = 0 and z.sin_cierre = 1 and z.mediana_min is null and z.clientes = 4;
rollback;

\echo '=== B5. Tres filas en total y suman los 11 pedidos de venta ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as zona_total_deberia_ser_1 from (select count(*) as n, sum(pedidos) as s from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31')) z where z.n = 3 and z.s = 11;
rollback;

\echo '=== B6. Con k = 6 Centro (5 pedidos) tambien se agrupa en «(otras)» (7 pedidos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as zona_k6_deberia_ser_1 from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 6) z where z.colonia = '(otras)' and z.pedidos = 7 and not exists (select 1 from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 6) y where y.colonia = 'Centro');
rollback;

\echo '=== B7. k = 4 (menos del minimo de privacidad): 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select (select count(*) from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 4)) as should_fail;
rollback;

\echo '=== B8. Staff: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d03', true);
select (select count(*) from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31')) as should_fail;
rollback;

\echo '=== B9. Owner de B pide la organizacion A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d05', true);
select (select count(*) from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31')) as should_fail;
rollback;

\echo '=== B10. Anon: sin permiso de ejecucion ==='
begin;
set local role anon;
select (select count(*) from restaurantes.analitica_zonas(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31')) as should_fail;
rollback;

-- ===========================================================================
-- C. Productos, margen y combos
-- ===========================================================================

\echo '=== C1. Bistec: 9 unidades, 54000 centavos, en 7 pedidos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as prod_bistec_deberia_ser_1 from (select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where jsonb_array_length(j->'productos') = 3 and (select (x->>'unidades')::int from jsonb_array_elements(j->'productos') x where x->>'producto_ref' = public.prod(1)::text) = 9 and (select (x->>'ingreso_centavos')::int from jsonb_array_elements(j->'productos') x where x->>'producto_ref' = public.prod(1)::text) = 54000 and (select (x->>'pedidos')::int from jsonb_array_elements(j->'productos') x where x->>'producto_ref' = public.prod(1)::text) = 7;
rollback;

\echo '=== C2. Sin costo capturado el margen es nulo (no se estima) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as prod_sin_margen_deberia_ser_1 from (select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (select x->'margen_centavos' from jsonb_array_elements(j->'productos') x where x->>'producto_ref' = public.prod(1)::text) = 'null'::jsonb and (j->>'costos_cargados') = '0';
rollback;

\echo '=== C3. Un solo par con 5 pedidos juntos (bistec + frijoles); soporte sobre 9 pedidos con producto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as prod_pares_deberia_ser_1 from (select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where jsonb_array_length(j->'pares') = 1 and (j->'pares'->0->>'juntos') = '5' and (j->'pares'->0->>'pedidos_a') = '7' and (j->'pares'->0->>'pedidos_b') = '5' and (j->'pares'->0->>'pedidos_total') = '9' and (j->'pares'->0->>'producto_a') = public.prod(1)::text;
rollback;

\echo '=== C4. El par esta «en el menu»: hay una promocion de cortesia vigente que lo une ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as prod_en_menu_deberia_ser_1 from (select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (j->'pares'->0->>'en_menu') = 'true' and (j->'pares'->0->>'promocion_codigo') = 'COMBO-BF';
rollback;

\echo '=== C5. Con la promocion apagada el par es oportunidad: no existe como combo ==='
begin;
update restaurantes.promotions set is_active = false where code = 'COMBO-BF';
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as prod_oportunidad_deberia_ser_1 from (select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (j->'pares'->0->>'en_menu') = 'false' and (j->'pares'->0->'promocion_codigo') = 'null'::jsonb;
rollback;

\echo '=== C6. Con costo de 20 pesos el margen del bistec es 54000 - 9 x 2000 = 36000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(1), 20);
select count(*)::int as prod_margen_deberia_ser_1 from (select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (select (x->>'margen_centavos')::int from jsonb_array_elements(j->'productos') x where x->>'producto_ref' = public.prod(1)::text) = 36000 and (select (x->>'costo_unitario_centavos')::int from jsonb_array_elements(j->'productos') x where x->>'producto_ref' = public.prod(1)::text) = 2000 and (j->>'costos_cargados') = '1';
rollback;

\echo '=== C7. Borrar el costo (null) lo quita ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(1), 20);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(1), null);
select count(*)::int as costo_borrado_deberia_ser_0 from (select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (j->>'costos_cargados') <> '0';
rollback;

\echo '=== C8. Admin acotado no captura costos: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d02', true);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(1), 20) as should_fail;
rollback;

\echo '=== C9. Staff no captura costos: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d03', true);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(1), 20) as should_fail;
rollback;

\echo '=== C10. Owner de B no captura costos de A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d05', true);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(1), 20) as should_fail;
rollback;

\echo '=== C11. Producto de otra organizacion: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(4), 20) as should_fail;
rollback;

\echo '=== C12. Costo negativo: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_costo_producto_guardar(public.oa(), public.prod(1), -1) as should_fail;
rollback;

\echo '=== C13. La tabla de costos no se lee directo: sin permiso ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select (select count(*) from restaurantes.producto_costo) as should_fail;
rollback;

\echo '=== C14. Staff no ve productos: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d03', true);
select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== C15. Owner de B pide productos de A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d05', true);
select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== C16. Limite 0: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_productos(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 0, 5) as should_fail;
rollback;

-- ===========================================================================
-- D. Gancho de sugerencia de combo (solo sistema; viernes 13:00 hora local)
-- ===========================================================================

\echo '=== D1. Borrador con bistec: sugiere frijoles por COMBO-BF, sin precios ni descuentos ==='
begin;
select count(*)::int as combo_ok_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'ok' and (j->'sugerencia'->>'producto_id') = public.prod(2)::text and (j->'sugerencia'->>'promocion_codigo') = 'COMBO-BF' and (j->'sugerencia'->>'producto_nombre') = 'Frijoles' and j::text !~* 'precio|price|descuento|discount';
rollback;

\echo '=== D2. Borrador con bistec y frijoles: ya incluido, no sugiere ==='
begin;
select count(*)::int as combo_ya_incluido_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text, public.prod(2)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'ya_incluido' and (j->'sugerencia') = 'null'::jsonb;
rollback;

\echo '=== D3. Borrador con refresco: no hay combo, no sugiere nada ==='
begin;
select count(*)::int as combo_sin_combo_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(3)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente' and (j->'sugerencia') = 'null'::jsonb;
rollback;

\echo '=== D4. Borrador vacio: sin_borrador ==='
begin;
select count(*)::int as combo_vacio_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[]::text[], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_borrador';
rollback;

\echo '=== D5. Promocion apagada: no hay combo ==='
begin;
update restaurantes.promotions set is_active = false where code = 'COMBO-BF';
select count(*)::int as combo_inactivo_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente';
rollback;

\echo '=== D6. Frijoles agotados en la sucursal: agotado, no sugiere ==='
begin;
update restaurantes.branch_products set is_available = false where product_id = public.prod(2);
select count(*)::int as combo_agotado_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'agotado' and (j->'sugerencia') = 'null'::jsonb;
rollback;

\echo '=== D7. Frijoles agotados en el catalogo: agotado ==='
begin;
update restaurantes.products set is_available = false where id = public.prod(2);
select count(*)::int as combo_agotado_catalogo_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'agotado';
rollback;

\echo '=== D8. Promocion solo para recoger y el pedido es a domicilio: no hay combo ==='
begin;
update restaurantes.promotions set channels = array['recoger'] where code = 'COMBO-BF';
select count(*)::int as combo_canal_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente';
rollback;

\echo '=== D9. Promocion solo para recoger y el pedido es para recoger: sugiere ==='
begin;
update restaurantes.promotions set channels = array['recoger'] where code = 'COMBO-BF';
select count(*)::int as combo_canal_ok_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'recoger', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'ok';
rollback;

\echo '=== D10. Tope de usos agotado: no hay combo ==='
begin;
update restaurantes.promotions set max_uses = 1, times_used = 1 where code = 'COMBO-BF';
select count(*)::int as combo_tope_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente';
rollback;

\echo '=== D11. Promocion de domingo un viernes: no hay combo ==='
begin;
update restaurantes.promotions set days_of_week = array[0]::smallint[] where code = 'COMBO-BF';
select count(*)::int as combo_dia_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente';
rollback;

\echo '=== D12. Promocion de viernes un viernes: sugiere ==='
begin;
update restaurantes.promotions set days_of_week = array[5]::smallint[] where code = 'COMBO-BF';
select count(*)::int as combo_dia_ok_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'ok';
rollback;

\echo '=== D13. Horario de 14:00 a 16:00 a las 13:00 locales: no hay combo ==='
begin;
update restaurantes.promotions set start_time = time '14:00', end_time = time '16:00' where code = 'COMBO-BF';
select count(*)::int as combo_horario_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente';
rollback;

\echo '=== D14. Horario de 12:00 a 14:00 a las 13:00 locales: sugiere ==='
begin;
update restaurantes.promotions set start_time = time '12:00', end_time = time '14:00' where code = 'COMBO-BF';
select count(*)::int as combo_horario_ok_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'ok';
rollback;

\echo '=== D15. Promocion vencida: no hay combo ==='
begin;
update restaurantes.promotions set ends_at = timestamptz '2026-03-01 00:00:00+00' where code = 'COMBO-BF';
select count(*)::int as combo_vencida_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente';
rollback;

\echo '=== D16. Promocion de otra sucursal: no hay combo en A1 ==='
begin;
update restaurantes.promotions set property_ids = array[public.p2()]::uuid[] where code = 'COMBO-BF';
select count(*)::int as combo_otra_sucursal_deberia_ser_1 from (select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as j) q where (j->>'motivo') = 'sin_combo_vigente';
rollback;

\echo '=== D17. Sucursal de otra organizacion: 42501 ==='
begin;
select restaurantes.analitica_combo_sugerir(public.oa(), public.pb1(), array[public.prod(1)::text], 'domicilio', null) as should_fail;
rollback;

\echo '=== D18. Un usuario autenticado no la llama (solo sistema): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as should_fail;
rollback;

\echo '=== D19. Canal invalido: 22023 ==='
begin;
select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'delivery', null) as should_fail;
rollback;

\echo '=== D20. Anon: sin permiso de ejecucion ==='
begin;
set local role anon;
select restaurantes.analitica_combo_sugerir(public.oa(), public.p1(), array[public.prod(1)::text], 'domicilio', timestamptz '2026-03-06 19:00:00+00') as should_fail;
rollback;

-- ===========================================================================
-- E. Ratios
-- ===========================================================================

\echo '=== E1. A1: 11 pedidos, 130000 centavos, ticket 11818, 9 clientes, 11 pedidos con cliente, 9 nuevos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_basicos_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as j) q where jsonb_array_length(j->'filas') = 2 and (j->'filas'->0->>'property_id') = public.p1()::text and (j->'filas'->0->>'pedidos') = '11' and (j->'filas'->0->>'neta_centavos') = '130000' and (j->'filas'->0->>'ticket_centavos') = '11818' and (j->'filas'->0->>'clientes') = '9' and (j->'filas'->0->>'pedidos_con_cliente') = '11' and (j->'filas'->0->>'clientes_nuevos') = '9';
rollback;

\echo '=== E2. Recompra: a 14 dias 9 elegibles y 1 volvio (c1); a 30 y 60 dias nadie era elegible aun ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_recompra_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as j) q where (j->'filas'->0->'recompra'->'d14'->>'elegibles') = '9' and (j->'filas'->0->'recompra'->'d14'->>'recompraron') = '1' and (j->'filas'->0->'recompra'->'d30'->>'elegibles') = '0' and (j->'filas'->0->'recompra'->'d60'->>'elegibles') = '0';
rollback;

\echo '=== E3. 1 cancelado (los falsos, demo y programados no cuentan) y 2 pedidos de mas de 150 pesos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_cancel_grandes_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as j) q where (j->'filas'->0->>'cancelados') = '1' and (j->'filas'->0->>'grandes') = '2';
rollback;

\echo '=== E4. Chats: 4 conversaciones nuevas, 1 con pedido (la del cancelado no cuenta), 1 con solicitud de persona ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_chats_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as j) q where (j->'filas'->0->>'conv_chats') = '4' and (j->'filas'->0->>'conv_con_pedido') = '1' and (j->'filas'->0->>'conv_escaladas') = '1';
rollback;

\echo '=== E5. Primera respuesta: 4 rachas respondidas (20, 40, 120 y 480 s), mediana 40, p90 480, 3 en 5 min, 3 del agente y 1 de persona ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_resp_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as j) q where (j->'filas'->0->>'resp_n') = '4' and (j->'filas'->0->>'resp_mediana_seg')::numeric = 40 and (j->'filas'->0->>'resp_p90_seg')::numeric = 480 and (j->'filas'->0->>'resp_hasta_5min') = '3' and (j->'filas'->0->>'resp_agente_n') = '3' and (j->'filas'->0->>'resp_humano_n') = '1';
rollback;

\echo '=== E6. Sin tipo de cambio el costo es nulo (no se inventa) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_costo_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as j) q where (j->'filas'->0->'costo_total_centavos') = 'null'::jsonb and (j->'filas'->0->'costo_por_conversacion_centavos') = 'null'::jsonb;
rollback;

\echo '=== E7. La fila del conjunto (property_id nulo) cuadra con la unica sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_conjunto_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as j) q where (j->'filas'->1->'property_id') = 'null'::jsonb and (j->'filas'->1->>'pedidos') = '11' and (j->'filas'->1->>'conv_chats') = '4';
rollback;

\echo '=== E8. El owner sin filtro: dos sucursales mas el conjunto (12 pedidos) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_owner_todas_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), null, date '2026-03-01', date '2026-03-31') as j) q where jsonb_array_length(j->'filas') = 3 and (j->'filas'->2->>'pedidos') = '12';
rollback;

\echo '=== E9. El umbral de pedido grande por omision es $4,000: ningun pedido de A1 lo supera ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select count(*)::int as rat_grande_omision_deberia_ser_1 from (select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31') as j) q where (j->'filas'->0->>'grandes') = '0' and (j->'parametros'->>'grande_centavos') = '400000';
rollback;

\echo '=== E10. Staff: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d03', true);
select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as should_fail;
rollback;

\echo '=== E11. Repartidor: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d04', true);
select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as should_fail;
rollback;

\echo '=== E12. Admin acotado a A1 pide A2: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d02', true);
select restaurantes.analitica_ratios(public.oa(), array[public.p2()], date '2026-03-01', date '2026-03-31') as should_fail;
rollback;

\echo '=== E13. Owner de B pide la organizacion A: 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d05', true);
select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as should_fail;
rollback;

\echo '=== E14. Anon: sin permiso de ejecucion ==='
begin;
set local role anon;
select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 15000) as should_fail;
rollback;

\echo '=== E15. Umbral de pedido grande 0: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-03-01', date '2026-03-31', 0) as should_fail;
rollback;

\echo '=== E16. Rango de 401 dias: 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select restaurantes.analitica_ratios(public.oa(), array[public.p1()], date '2026-01-01', date '2027-02-05') as should_fail;
rollback;

-- ===========================================================================
-- F. Alertas operativas (solo sistema; reloj 2026-03-20 13:00 UTC)
-- ===========================================================================

\echo '=== F1. Hay exactamente 2 candidatos: un ETA alto y un «ya salio» sin contestar ==='
begin;
select count(*)::int as alertas_total_deberia_ser_2 from restaurantes.analitica_alertas_candidatos(timestamptz '2026-03-20 13:00:00+00') a where true;
rollback;

\echo '=== F2. ETA alto: el domicilio prometido a 75 min (no el de 50, ni el entregado, ni el de hace 30 h, ni el de recoger) ==='
begin;
select count(*)::int as alertas_eta_deberia_ser_1 from restaurantes.analitica_alertas_candidatos(timestamptz '2026-03-20 13:00:00+00') a where a.tipo = 'restaurantes.pedido.eta_alta' and a.minutos = 75 and a.conversation_id is null;
rollback;

\echo '=== F3. «Ya salio» sin contestar: solo el chat con pedido abierto, pregunta de estado y 20 min de silencio ==='
begin;
select count(*)::int as alertas_ya_salio_deberia_ser_1 from restaurantes.analitica_alertas_candidatos(timestamptz '2026-03-20 13:00:00+00') a where a.tipo = 'restaurantes.chat.ya_salio_sin_respuesta' and a.minutos = 20 and a.conversation_id = '00000000-0000-0000-0000-0000000e5e11' and a.order_number is not null;
rollback;

\echo '=== F4. Con un umbral de ETA de 90 minutos ya no hay alerta de ETA ==='
begin;
select count(*)::int as alertas_eta_90_deberia_ser_0 from restaurantes.analitica_alertas_candidatos(timestamptz '2026-03-20 13:00:00+00', 90, 5) a where a.tipo = 'restaurantes.pedido.eta_alta';
rollback;

\echo '=== F5. Con reloj 13:03 y umbral de 1 minuto cuenta tambien el chat de las 12:58 (2 «ya salio») ==='
begin;
select count(*)::int as alertas_ya_salio_13_deberia_ser_2 from restaurantes.analitica_alertas_candidatos(timestamptz '2026-03-20 13:03:00+00', 60, 1) a where a.tipo = 'restaurantes.chat.ya_salio_sin_respuesta';
rollback;

\echo '=== F6. Un reloj en el pasado no devuelve nada ==='
begin;
select count(*)::int as alertas_pasado_deberia_ser_0 from restaurantes.analitica_alertas_candidatos(timestamptz '2020-01-01 00:00:00+00') a where true;
rollback;

\echo '=== F7. El clasificador: positivos y falsos positivos ==='
begin;
select count(*)::int as pregunta_estado_deberia_ser_1 from (select 1) q where restaurantes.analitica_pregunta_estado('¿Ya salió mi pedido?') and restaurantes.analitica_pregunta_estado('cuánto falta?') and restaurantes.analitica_pregunta_estado('no ha llegado') and not restaurantes.analitica_pregunta_estado('¿ya salieron los precios nuevos?') and not restaurantes.analitica_pregunta_estado('hola buenas') and not restaurantes.analitica_pregunta_estado(null);
rollback;

\echo '=== F8. Un usuario autenticado no las llama (solo sistema): 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e5d01', true);
select (select count(*) from restaurantes.analitica_alertas_candidatos(timestamptz '2026-03-20 13:00:00+00') a) as should_fail;
rollback;

\echo '=== F9. Umbral de ETA fuera de rango: 22023 ==='
begin;
select (select count(*) from restaurantes.analitica_alertas_candidatos(null, 10, 5)) as should_fail;
rollback;

\echo '=== F10. Umbral de «ya salio» fuera de rango: 22023 ==='
begin;
select (select count(*) from restaurantes.analitica_alertas_candidatos(null, 60, 0)) as should_fail;
rollback;

\echo '=== F11. Anon: sin permiso de ejecucion ==='
begin;
set local role anon;
select (select count(*) from restaurantes.analitica_alertas_candidatos(timestamptz '2026-03-20 13:00:00+00') a) as should_fail;
rollback;

-- ===========================================================================
-- G. Postura de seguridad
-- ===========================================================================

\echo '=== G1. Las 9 funciones definer llevan search_path fijo ==='
begin;
select count(*)::int as postura_definer_deberia_ser_9 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'analitica\_%' and p.prosecdef and exists (select 1 from unnest(p.proconfig) c where c like 'search_path=%');
rollback;

\echo '=== G2. Ninguna funcion de analitica es ejecutable por anon ==='
begin;
select count(*)::int as postura_anon_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'analitica\_%' and has_function_privilege('anon', p.oid, 'execute');
rollback;

\echo '=== G3. Las dos funciones internas no son ejecutables por authenticated ==='
begin;
select count(*)::int as postura_internas_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('analitica_base', 'analitica_combos_vigentes') and has_function_privilege('authenticated', p.oid, 'execute');
rollback;

\echo '=== G4. La tabla de costos tiene RLS activado y ningun permiso para authenticated ni anon ==='
begin;
select count(*)::int as postura_tabla_deberia_ser_1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'restaurantes' and c.relname = 'producto_costo' and c.relrowsecurity and not has_table_privilege('authenticated', c.oid, 'select') and not has_table_privilege('anon', c.oid, 'select');
rollback;
