-- Renglones regalados por la promocion (D12) y CFO, contra Postgres REAL: con la migracion 086 (restaurantes.cfo_renglones devuelve el precio de lista de un renglon
-- guardado a price 0 con listPrice), la venta bruta, el descuento de promocion y la neta del CFO son IGUALES a las de antes de D12 (renglones a precio de lista), aunque
-- ahora la suma de renglones sea el total. Casos: 2x1 de 4 tacos ($200/$100), nachos + 2 aguas ($152/$62), cortesia de cantidad 1 ($120/$30), mixto, kilo con propina y un
-- pedido anterior sin listPrice. Convenciones del gate (run-gate.mjs): cada escenario es `begin; ... rollback;`, alias *_deberia_ser_N = valor esperado.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values ('00000000-0000-0000-0000-0000000e8601', 'restaurantes', 'CFO Promo', 'cfo-promo') on conflict do nothing;
insert into core.property (id, organization_id, name) values ('00000000-0000-0000-0000-0000000e86a1', '00000000-0000-0000-0000-0000000e8601', 'Sucursal Promo') on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values ('00000000-0000-0000-0000-0000000e86a1', '00000000-0000-0000-0000-0000000e8601', 'promo', null) on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values ('00000000-0000-0000-0000-0000000e8611', 'owner@cfo-promo.example.com', 'Owner Promo', 'seed') on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values ('00000000-0000-0000-0000-0000000e8611', '00000000-0000-0000-0000-0000000e8601', null, 'owner', 'owner') on conflict do nothing;
insert into restaurantes.categories (id, organization_id, name, slug) values ('00000000-0000-0000-0000-0000000e86d1', '00000000-0000-0000-0000-0000000e8601', 'Todo', 'todo');
insert into restaurantes.products (id, organization_id, category_id, name, price) values
  ('00000000-0000-0000-0000-0000000e86c1', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86d1', 'Taco', 50.00),
  ('00000000-0000-0000-0000-0000000e86c2', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86d1', 'Refresco', 20.00),
  ('00000000-0000-0000-0000-0000000e86c3', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86d1', 'Nachos', 90.00),
  ('00000000-0000-0000-0000-0000000e86c4', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86d1', 'Agua de Jamaica', 30.00),
  ('00000000-0000-0000-0000-0000000e86c5', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86d1', 'Kilo de pastor', 900.00);

-- Renglones regalados: price 0 + listPrice (+ courtesy/promoCode, que el CFO ignora). Dia 2026-03-10 a las 18:00 UTC (12:00 Merida).
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, propina, payment_method, canal, created_at) values
  -- P1: lunes 2x1, 4 tacos de $50: 2 pagados + 2 a $0. Antes de D12: bruta 200, total 100, descuento 100.
  ('00000000-0000-0000-0000-00000e860001', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86a1', 'C1', '+52 5500008601', 100.00, 'entregado',
   '[{"id":"00000000-0000-0000-0000-0000000e86c1","name":"Taco","price":50,"quantity":2},{"id":"00000000-0000-0000-0000-0000000e86c1","name":"Taco","price":0,"quantity":2,"listPrice":50,"courtesy":true,"promoCode":"LUNES2X1"}]', 'whatsapp', null, 'efectivo', 'recoger', '2026-03-10 18:00+00'),
  -- P2: martes nachos + 2 aguas de cortesia. Antes: bruta 90+30+32 = 152, total 90, descuento 62.
  ('00000000-0000-0000-0000-00000e860002', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86a1', 'C2', '+52 5500008602', 90.00, 'entregado',
   '[{"id":"00000000-0000-0000-0000-0000000e86c3","name":"Nachos","price":90,"quantity":1},{"id":"00000000-0000-0000-0000-0000000e86c4","name":"Agua de Jamaica","price":0,"quantity":1,"listPrice":30,"courtesy":true,"promoCode":"MARTES"},{"id":"00000000-0000-0000-0000-0000000e86c5","name":"Horchata","price":0,"quantity":1,"listPrice":32,"courtesy":true,"promoCode":"MARTES"}]', 'voice', null, 'efectivo', 'recoger', '2026-03-10 18:10+00'),
  -- P3: cortesia de cantidad 1: nachos + 1 agua regalada. Antes: bruta 120, total 90, descuento 30.
  ('00000000-0000-0000-0000-00000e860003', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86a1', 'C3', '+52 5500008603', 90.00, 'entregado',
   '[{"id":"00000000-0000-0000-0000-0000000e86c3","name":"Nachos","price":90,"quantity":1},{"id":"00000000-0000-0000-0000-0000000e86c4","name":"Agua de Jamaica","price":0,"quantity":1,"listPrice":30,"courtesy":true,"promoCode":"MARTES"}]', 'whatsapp', null, 'efectivo', 'recoger', '2026-03-10 18:20+00'),
  -- P4: mixto: 3 tacos (2 pagados + 1 a $0) + 1 refresco. Antes: bruta 170, total 120, descuento 50.
  ('00000000-0000-0000-0000-00000e860004', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86a1', 'C4', '+52 5500008604', 120.00, 'entregado',
   '[{"id":"00000000-0000-0000-0000-0000000e86c1","name":"Taco","price":50,"quantity":2},{"id":"00000000-0000-0000-0000-0000000e86c1","name":"Taco","price":0,"quantity":1,"listPrice":50,"courtesy":true,"promoCode":"LUNES2X1"},{"id":"00000000-0000-0000-0000-0000000e86c2","name":"Refresco","price":20,"quantity":1}]', 'whatsapp', null, 'efectivo', 'recoger', '2026-03-10 18:30+00'),
  -- P5: kilo con propina y sin promocion: bruta 900, total 900, descuento 0, propina 90.
  ('00000000-0000-0000-0000-00000e860005', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86a1', 'C5', '+52 5500008605', 900.00, 'entregado',
   '[{"id":"00000000-0000-0000-0000-0000000e86c5","name":"Kilo de pastor","price":900,"quantity":1}]', 'whatsapp', 90.00, 'tarjeta', 'domicilio', '2026-03-10 18:40+00'),
  -- P6: pedido anterior a D12 (sin listPrice): bruta 100, total 100.
  ('00000000-0000-0000-0000-00000e860006', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86a1', 'C6', '+52 5500008606', 100.00, 'entregado',
   '[{"id":"00000000-0000-0000-0000-0000000e86c1","name":"Taco","price":50,"quantity":2}]', 'whatsapp', null, 'efectivo', 'recoger', '2026-03-10 18:50+00'),
  -- P7: listPrice mal formado (texto): se ignora y se usa price.
  ('00000000-0000-0000-0000-00000e860007', '00000000-0000-0000-0000-0000000e8601', '00000000-0000-0000-0000-0000000e86a1', 'C7', '+52 5500008607', 0.00, 'entregado',
   '[{"id":"00000000-0000-0000-0000-0000000e86c1","name":"Taco","price":0,"quantity":1,"listPrice":"abc"}]', 'whatsapp', null, 'efectivo', 'recoger', '2026-03-10 19:00+00');

\echo '=== R1. bruta del dia = 20000+15200+12000+17000+90000+10000+0 = 164200 centavos (igual que con renglones a precio de lista) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8611', true);
select sum(bruta_centavos)::int as bruta_deberia_ser_164200 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e8601', array['00000000-0000-0000-0000-0000000e86a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== R2. neta del dia = 10000+9000+9000+12000+90000+10000+0 = 140000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8611', true);
select sum(neta_centavos)::int as neta_deberia_ser_140000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e8601', array['00000000-0000-0000-0000-0000000e86a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== R3. descuento de promocion = 10000+6200+3000+5000 = 24200 (NO 0) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8611', true);
select sum(desc_promo_centavos)::int as promo_deberia_ser_24200 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e8601', array['00000000-0000-0000-0000-0000000e86a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== R4. la propina sigue aparte: 9000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8611', true);
select sum(propina_centavos)::int as propina_deberia_ser_9000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e8601', array['00000000-0000-0000-0000-0000000e86a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== R5. el filtro «con descuento» ve los 4 pedidos con promocion (P1-P4) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8611', true);
select count(*)::int as con_descuento_deberia_ser_4 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e8601', null, date '2026-03-10', date '2026-03-10', '{"con_descuento": true}'::jsonb, 200);
rollback;

\echo '=== R6. ingreso de «Agua de Jamaica» a precio de lista (P2 + P3 = 6000), igual que antes ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8611', true);
select sum(ingreso_centavos)::int as jamaica_deberia_ser_6000 from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e8601', array['00000000-0000-0000-0000-0000000e86a1'::uuid], date '2026-03-10', date '2026-03-10') where producto_ref = '00000000-0000-0000-0000-0000000e86c4';
rollback;

\echo '=== R7. unidades de «Taco»: 4 + 3 + 2 + 1 (P7) = 10 (las regaladas cuentan como unidades vendidas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e8611', true);
select sum(unidades)::int as taco_unidades_deberia_ser_10 from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e8601', array['00000000-0000-0000-0000-0000000e86a1'::uuid], date '2026-03-10', date '2026-03-10') where producto_ref = '00000000-0000-0000-0000-0000000e86c1';
rollback;

\echo '=== R8. listPrice mal formado ("abc") se ignora: el renglon vale su price (0) ==='
select sum((precio * cantidad * 100)::int)::int as renglon_mal_formado_deberia_ser_0 from restaurantes.cfo_renglones('[{"id":"x","name":"X","price":0,"quantity":1,"listPrice":"abc"}]'::jsonb);

\echo '=== R9. sin listPrice (pedidos anteriores) devuelve price, como en 081 ==='
select (precio * 100)::int as precio_anterior_deberia_ser_5000 from restaurantes.cfo_renglones('[{"id":"x","name":"X","price":50,"quantity":2}]'::jsonb);

\echo '=== R10. la funcion sigue cerrada: authenticated no puede ejecutarla (should_fail) ==='
begin;
set local role authenticated;
select * from restaurantes.cfo_renglones('[]'::jsonb) as should_fail;
rollback;
