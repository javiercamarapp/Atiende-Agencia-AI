-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT + auth.uid() reales, rol `authenticated`) de
-- packages/domain-restaurantes/migrations/081_cfo_ventas_productos.sql: funciones restaurantes.cfo_* del modulo CFO (ventas, productos, canasta, horas,
-- detalle de pedidos, cortesias y cobertura).
--
-- Dataset a mano (organizacion A: A1 Mexico con corte 01:00, A2 Mexico sin corte, A3 Pacific/Auckland; organizacion B: B1). Dia de negocio de interes: 2026-03-10.
--   A. Reglas de venta y dia de negocio (A1): corte 01:00 (00:30 -> dia anterior, 01:05 -> dia nuevo; A2 sin corte lo contrasta), programado fuera y promovido dentro,
--      demo 0009, por_aprobar, pedido falso y reposicion fuera de la venta, bruta - neta = descuento, compensacion GRACIAS- aparte, propina aparte, tiempos.
--   B. Cortesias (reposicion a precio de la sucursal), horas, productos, canasta, cobertura, detalle sin PII (columnas, alias, filtros, cursor).
--   C. Aditividad: consolidado (owner, p_props nulo) == union de las sucursales, para ventas_diarias, productos y ventas_hora; sin fila «No asignado».
--   D. Seguridad: owner, admin acotado, staff, repartidor, otra organizacion, anon, sistema cruzando organizaciones, rangos/listas invalidas, helpers cerrados.
--   E. Grants / SECURITY DEFINER / search_path / STABLE / sin PII en las firmas, idempotencia y base SIN migrar (42883 recuperable con subtransaccion).
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

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e4301', 'restaurantes', 'CFO Org A', 'cfo-a'),
  ('00000000-0000-0000-0000-0000000e4302', 'restaurantes', 'CFO Org B (ajena)', 'cfo-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e4301', 'Sucursal A1 (Mexico, corte 01:00)'),
  ('00000000-0000-0000-0000-0000000e43a2', '00000000-0000-0000-0000-0000000e4301', 'Sucursal A2 (Mexico)'),
  ('00000000-0000-0000-0000-0000000e43a3', '00000000-0000-0000-0000-0000000e4301', 'Sucursal A3 (Auckland)'),
  ('00000000-0000-0000-0000-0000000e43b1', '00000000-0000-0000-0000-0000000e4302', 'Sucursal B1'),
  ('00000000-0000-0000-0000-0000000e43b2', '00000000-0000-0000-0000-0000000e4302', 'Sucursal B2 (Madrid, corte 02:00)'),
  ('00000000-0000-0000-0000-0000000e43b3', '00000000-0000-0000-0000-0000000e4302', 'Sucursal B3 (Tijuana)')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, zona_horaria) values
  ('00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e4301', 'a1', null),
  ('00000000-0000-0000-0000-0000000e43a2', '00000000-0000-0000-0000-0000000e4301', 'a2', null),
  ('00000000-0000-0000-0000-0000000e43a3', '00000000-0000-0000-0000-0000000e4301', 'a3', 'Pacific/Auckland'),
  ('00000000-0000-0000-0000-0000000e43b1', '00000000-0000-0000-0000-0000000e4302', 'b1', null),
  ('00000000-0000-0000-0000-0000000e43b2', '00000000-0000-0000-0000-0000000e4302', 'b2', 'Europe/Madrid'),
  ('00000000-0000-0000-0000-0000000e43b3', '00000000-0000-0000-0000-0000000e4302', 'b3', 'America/Tijuana')
on conflict do nothing;

-- Turno 12:00 -> 01:00 en A1: el corte del dia de negocio es 1 h.
insert into restaurantes.branch_policy (property_id, organization_id, horario) values
  ('00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e4301', '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]'),
  ('00000000-0000-0000-0000-0000000e43b2', '00000000-0000-0000-0000-0000000e4302', '[{"dias":[0,1,2,3,4,5,6],"abre":"20:00","cierra":"02:00"}]');

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e4311', 'owner-a@cfo.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4312', 'admin-a1@cfo.example.com', 'Admin A1 (solo A1)', 'seed'),
  ('00000000-0000-0000-0000-0000000e4313', 'staff-a@cfo.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4314', 'rep-a@cfo.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000e4315', 'owner-b@cfo.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e4311', '00000000-0000-0000-0000-0000000e4301', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000e4312', '00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1']::uuid[], 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000e4313', '00000000-0000-0000-0000-0000000e4301', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000e4314', '00000000-0000-0000-0000-0000000e4301', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000e4315', '00000000-0000-0000-0000-0000000e4302', null, 'owner', 'owner')
on conflict do nothing;

insert into restaurantes.categories (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-0000000e43d1', '00000000-0000-0000-0000-0000000e4301', 'Tacos', 'tacos'),
  ('00000000-0000-0000-0000-0000000e43d2', '00000000-0000-0000-0000-0000000e4301', 'Bebidas', 'bebidas');
insert into restaurantes.products (id, organization_id, category_id, name, price) values
  ('00000000-0000-0000-0000-0000000e43c1', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43d1', 'Taco al pastor', 50.00),
  ('00000000-0000-0000-0000-0000000e43c2', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43d2', 'Refresco', 20.00);
-- P3 ('Taco viejo') NO existe en products: producto eliminado (solo vive en los renglones de los pedidos).
-- El precio vigente de P1 en A1 es 55.00 (branch_products es la fuente de verdad por sucursal); en A2/A3 aplica products.price.
insert into restaurantes.branch_products (property_id, product_id, price) values ('00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43c1', 55.00);

insert into restaurantes.customers (id, organization_id, phone, name) values
  ('00000000-0000-0000-0000-0000000e43e1', '00000000-0000-0000-0000-0000000e4301', '+52 5511110001', 'Cliente Uno'),
  ('00000000-0000-0000-0000-0000000e43e2', '00000000-0000-0000-0000-0000000e4301', '+52 5511110002', 'Cliente Dos');

insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, customer_address, total, status, items, source, notes, payment_method, propina, canal, created_at, delivered_at, promovido_at, programado_para, pedido_falso_at) values
  ('00000000-0000-0000-0000-00000e4f0001', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43e1', 'Cliente 1', '+52 5500000001', 'Calle 1 #10', 120.00, 'entregado', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 2}, {"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 1}]', 'whatsapp', null, 'tarjeta', 10.00, 'domicilio', '2026-03-10 18:00+00', '2026-03-10 18:30+00', null, null, null),
  ('00000000-0000-0000-0000-00000e4f0002', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43e2', 'Cliente 2', '+52 5500000002', null, 81.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 1}, {"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 2}]', 'voice', 'Promoción aplicada: PROMO10 (-$9.00).', 'efectivo', null, null, '2026-03-10 19:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0003', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-0000000e43e1', 'Cliente 3', '+52 5500000003', null, 80.00, 'entregado', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 1}, {"id": "00000000-0000-0000-0000-0000000e43c3", "name": "Taco viejo", "price": 30, "quantity": 1}]', 'whatsapp', null, 'efectivo', null, null, '2026-03-10 20:00+00', '2026-03-10 21:00+00', null, null, null),
  ('00000000-0000-0000-0000-00000e4f0004', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 4', '+52 5500000004', null, 50.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 1}]', 'whatsapp', null, null, null, null, '2026-03-11 06:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0005', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 5', '+52 5500000005', null, 50.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 1}]', 'whatsapp', null, null, null, null, '2026-03-11 07:05+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0006', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 6', '+52 5500000006', null, 70.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 2}]', 'whatsapp', 'Promoción aplicada: GRACIAS-ABCD (-$30.00).', null, null, null, '2026-03-10 21:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0007', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 7', '+52 5500000007', null, 80.00, 'cancelado', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 1}, {"id": "00000000-0000-0000-0000-0000000e43c3", "name": "Taco viejo", "price": 30, "quantity": 1}]', 'whatsapp', null, null, null, null, '2026-03-10 22:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0008', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 8', '+52 5500000008', null, 40.00, 'no_recogido', '[{"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 2}]', 'whatsapp', null, null, null, 'recoger', '2026-03-10 22:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0009', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 9', '+52 5500000009', null, 300.00, 'programado', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 6}]', 'admin', null, null, null, null, '2026-03-10 17:00+00', null, null, '2026-03-20 18:00+00', null),
  ('00000000-0000-0000-0000-00000e4f0010', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 10', '+52 5500000010', null, 25.25, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c3", "name": "Taco viejo", "price": 25.25, "quantity": 1}]', 'admin', null, null, null, null, '2026-03-05 12:00+00', null, '2026-03-10 16:00+00', '2026-03-10 17:00+00', null),
  ('00000000-0000-0000-0000-00000e4f0011', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 11', '+52 0009123456', null, 999.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 1}]', 'whatsapp', null, null, null, null, '2026-03-10 18:10+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0012', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 12', '+52 5500000012', null, 500.00, 'por_aprobar', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 10}]', 'whatsapp', null, null, null, null, '2026-03-10 18:20+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0013', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 13', '+52 5500000013', null, 200.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 4}]', 'whatsapp', null, null, null, null, '2026-03-10 18:30+00', null, null, null, now()),
  ('00000000-0000-0000-0000-00000e4f0014', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 14', '+52 5500000014', null, 0.00, 'entregado', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 1}, {"id": "00000000-0000-0000-0000-0000000e43c3", "name": "Taco viejo", "price": 30, "quantity": 1}]', 'admin', null, null, null, null, '2026-03-10 23:00+00', '2026-03-10 23:30+00', null, null, null),
  ('00000000-0000-0000-0000-00000e4f0015', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 15', '+52 5500000015', null, 100.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 2}]', 'whatsapp', null, null, null, null, '2026-03-12 18:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0016', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', null, 'Cliente 16', '+52 5500000016', null, 60.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 3}]', 'voice', null, null, null, null, '2026-03-09 18:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0021', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', null, 'Cliente 21', '+52 5500000021', null, 200.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 4}]', 'voice', null, 'efectivo', null, null, '2026-03-10 18:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0022', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', null, 'Cliente 22', '+52 5500000022', null, 40.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 2}]', 'whatsapp', null, null, null, null, '2026-03-11 05:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0023', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', null, 'Cliente 23', '+52 5500000023', null, 60.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 3}]', 'whatsapp', null, null, null, null, '2026-03-11 06:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0024', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', null, 'Cliente 24', '+52 5500000024', null, 30.00, 'cancelado', '[{"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 1}]', 'whatsapp', null, null, null, null, '2026-03-10 19:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0031', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a3', null, 'Cliente 31', '+52 5500000031', null, 150.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c1", "name": "Taco", "price": 50, "quantity": 3}]', 'whatsapp', null, null, null, null, '2026-03-10 18:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0032', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a3', null, 'Cliente 32', '+52 5500000032', null, 40.00, 'pending', '[{"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 2}]', 'whatsapp', null, null, null, null, '2026-03-10 10:00+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0051', '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', null, 'Cliente 51', '+52 5500000051', null, 30.00, 'completado', '[{"id": "00000000-0000-0000-0000-0000000e43c2", "name": "Refresco", "price": 20, "quantity": 1}]', 'whatsapp', null, null, null, null, '2026-03-03 18:00+00', '2026-03-03 18:40+00', null, null, null),
  ('00000000-0000-0000-0000-00000e4f0052', '00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43b2', null, 'Cliente 52', '+52 5500000052', null, 10.00, 'pending', '[]', 'whatsapp', null, null, null, null, '2026-03-29 00:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0053', '00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43b2', null, 'Cliente 53', '+52 5500000053', null, 10.00, 'pending', '[]', 'whatsapp', null, null, null, null, '2026-03-29 01:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0054', '00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43b2', null, 'Cliente 54', '+52 5500000054', null, 10.00, 'pending', '[]', 'whatsapp', null, null, null, null, '2026-03-29 02:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0055', '00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43b3', null, 'Cliente 55', '+52 5500000055', null, 10.00, 'pending', '[]', 'whatsapp', null, null, null, null, '2026-03-10 07:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0056', '00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43b3', null, 'Cliente 56', '+52 5500000056', null, 10.00, 'pending', '[]', 'whatsapp', null, null, null, null, '2026-03-08 09:30+00', null, null, null, null),
  ('00000000-0000-0000-0000-00000e4f0041', '00000000-0000-0000-0000-0000000e4302', '00000000-0000-0000-0000-0000000e43b1', null, 'Cliente 41', '+52 5500000041', null, 555.00, 'pending', '[]', 'whatsapp', null, null, null, null, '2026-03-10 18:00+00', null, null, null, null);

-- Reposicion: el pedido 14 repone el pedido 7 (cancelado).
insert into restaurantes.solicitud_aprobacion (organization_id, property_id, tipo, estado, order_id, decision, resuelta_at, reposicion_order_id)
values ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', 'compensacion', 'resuelta', '00000000-0000-0000-0000-00000e4f0007', 'reponer_producto', now(), '00000000-0000-0000-0000-00000e4f0014');

-- Comanda del pedido 1 en el outbox del POS (para comanda_estado).
insert into restaurantes.pos_comanda_outbox (organization_id, property_id, order_id, idempotency_key, estado, modo, payload)
values ('00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a1', '00000000-0000-0000-0000-00000e4f0001', 'cfo-verify-1', 'pendiente', 'sombra', '{}');

\echo '=== A1. A1 dia 10: pedidos (a1,a2,a3,a4 00:30,a6,a10 promovido); a5 01:05, cancelado, no recogido, programado, demo, por_aprobar, falso, reposicion y otras sucursales fuera ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(pedidos)::int as pedidos_deberia_ser_6 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A2. A1 dia 10: bruta en centavos (12000+9000+8000+5000+10000+2525) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(bruta_centavos)::int as bruta_deberia_ser_46525 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A3. A1 dia 10: neta en centavos (12000+8100+8000+5000+7000+2525) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(neta_centavos)::int as neta_deberia_ser_42625 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A4. A1 dia 10: bruta - neta = descuento (promocion + compensacion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(bruta_centavos) - sum(neta_centavos) - sum(desc_promo_centavos) - sum(desc_comp_centavos))::int as cuadre_deberia_ser_0 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A5. A1 dia 10: descuento de promocion (PROMO10: 9.00) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(desc_promo_centavos)::int as promo_deberia_ser_900 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A6. A1 dia 10: compensacion GRACIAS- (30.00) va aparte de la promocion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(desc_comp_centavos)::int as comp_deberia_ser_3000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A7. A1 dia 10: propina aparte (10.00) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(propina_centavos)::int as propina_deberia_ser_1000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A8. A1 dia 10: cancelados (1) y su monto (80.00); la reposicion no cuenta como cancelado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(cancelados) * 100000 + sum(cancelados_centavos))::int as canc_deberia_ser_108000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A9. A1 dia 10: no recogidos (1) y su monto (40.00) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(no_recogidos) * 100000 + sum(no_recogidos_centavos))::int as norec_deberia_ser_104000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A10. A1 dia 10: reposiciones (1) y unidades (2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(reposiciones) * 10 + sum(reposicion_unidades))::int as repos_deberia_ser_12 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A11. A1 dia 10: entregados (2), minutos (30 + 60) y entregas tarde con promesa 50 (1) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(entregados) * 100000 + sum(entrega_min_suma) * 100 + sum(entrega_tarde) * 10000000)::int as entrega_deberia_ser_10209000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A12. A1 dia 10: con promesa de 20 minutos las 2 entregas son tarde ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(entrega_tarde)::int as tarde_deberia_ser_2 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', 20);
rollback;

\echo '=== A13. A1 dia 11: solo el pedido de las 01:05 (a5); el de las 00:30 cuenta en el dia 10 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(pedidos) * 100000 + sum(neta_centavos))::int as dia11_deberia_ser_105000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-11', date '2026-03-11');
rollback;

\echo '=== A14. A2 (sin corte): el pedido de las 00:30 del 11 cuenta en el dia 11 (a3: 6000) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(pedidos) * 100000 + sum(neta_centavos))::int as a2_dia11_deberia_ser_106000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-11', date '2026-03-11');
rollback;

\echo '=== A15. A3 (Auckland): 18:00Z del 10 es el dia 11 local (15000) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(pedidos) * 100000 + sum(neta_centavos))::int as a3_dia11_deberia_ser_115000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-11', date '2026-03-11');
rollback;

\echo '=== A16. A1: el programado promovido el 10 (creado el 5) aparece en el rango 10..10 y no en 5..5 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select ((select count(*) from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') where source = 'admin') * 10 + (select count(*) from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-05', date '2026-03-05')))::int as promovido_deberia_ser_10;
rollback;

\echo '=== A17. otra organizacion: B1 ve sus 555.00 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4315', true);
select sum(neta_centavos)::int as b1_deberia_ser_55500 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4302', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== A18. el owner de A con p_props nulo nunca ve filas de la sucursal B1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*)::int as ajeno_deberia_ser_0 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-10') where property_id = '00000000-0000-0000-0000-0000000e43b1';
rollback;

\echo '=== B1. cortesias A1 dia 10: 1 reposicion, valor 55.00 (precio de la sucursal; el renglon de producto eliminado cuenta sin precio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (reposiciones * 1000000 + valor_lista_centavos * 10 + renglones_sin_precio)::int as cortesias_deberia_ser_1055001 from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== B2. ventas por hora A1 dia 10: el de las 00:30 cae en dow 2 hora 0 (5000) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (pedidos * 100000 + neta_centavos)::int as hora0_deberia_ser_105000 from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') where dow_negocio = 2 and hora_local = 0;
rollback;

\echo '=== B3. ventas por hora A1 dia 10: total 6 pedidos (12,13,14,0,15,10 h) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(pedidos)::int as horas_deberia_ser_6 from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== B4. productos A1 dia 10: taco 7 unidades / 35000 / 5 pedidos / categoria Tacos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (unidades * 10000000 + ingreso_centavos * 100 + pedidos)::bigint - 0 + (case when categoria = 'Tacos' and nombre_actual = 'Taco al pastor' and dow_negocio = 2 then 0 else 999999999999 end) as taco_deberia_ser_73500005 from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') where producto_ref = '00000000-0000-0000-0000-0000000e43c1';
rollback;

\echo '=== B5. productos A1 dia 10: refresco 3 unidades / 6000 / 2 pedidos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (unidades * 10000000 + ingreso_centavos * 100 + pedidos)::bigint as refresco_deberia_ser_30600002 from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') where producto_ref = '00000000-0000-0000-0000-0000000e43c2';
rollback;

\echo '=== B6. productos A1 dia 10: producto eliminado conserva el nombre del renglon, sin categoria, 2 unidades / 5525 / 2 pedidos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (unidades * 10000000 + ingreso_centavos * 100 + pedidos)::bigint + (case when categoria = '(sin categoría)' and nombre_actual = 'Taco viejo' then 0 else 999999999999 end) as eliminado_deberia_ser_20552502 from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') where producto_ref = '00000000-0000-0000-0000-0000000e43c3';
rollback;

\echo '=== B7. productos: solo ventas (las 10 unidades del por_aprobar y las 4 del falso no cuentan): total de unidades A1 dia 10 = 12 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select sum(unidades)::int as unidades_deberia_ser_12 from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== B8. canasta A1 dia 10: pares (taco, refresco) = 2 y (taco, eliminado) = 1; sin otros pares ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select ((select (e ->> 'pedidos_juntos')::int from jsonb_array_elements(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') -> 'pares') e where e ->> 'producto_a' = '00000000-0000-0000-0000-0000000e43c1' and e ->> 'producto_b' = '00000000-0000-0000-0000-0000000e43c2') * 10
  + (select (e ->> 'pedidos_juntos')::int from jsonb_array_elements(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') -> 'pares') e where e ->> 'producto_a' = '00000000-0000-0000-0000-0000000e43c1' and e ->> 'producto_b' = '00000000-0000-0000-0000-0000000e43c3')
  + jsonb_array_length(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') -> 'pares') * 100) as pares_deberia_ser_221;
rollback;

\echo '=== B9. canasta A1 dia 10: pedidos totales 6 y taco en 5 pedidos ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select ((select (e ->> 'pedidos_totales')::int from jsonb_array_elements(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') -> 'totales') e) * 10
  + (select (e ->> 'pedidos_con_producto')::int from jsonb_array_elements(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') -> 'productos') e where e ->> 'producto_ref' = '00000000-0000-0000-0000-0000000e43c1')) as totales_deberia_ser_65;
rollback;

\echo '=== B10. canasta A1 dia 10: distribucion del ticket: 1 producto = 3 pedidos / 14525; 2 productos = 3 pedidos / 28100 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select ((select (e ->> 'pedidos')::int * 1000000 + (e ->> 'neta_centavos')::int from jsonb_array_elements(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') -> 'tickets') e where (e ->> 'n_productos')::int = 1)
  + (select (e ->> 'pedidos')::int * 1000000 + (e ->> 'neta_centavos')::int from jsonb_array_elements(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') -> 'tickets') e where (e ->> 'n_productos')::int = 2)) as tickets_deberia_ser_6042625;
rollback;

\echo '=== B11. canasta: el limite recorta el top por sucursal (limite 1 deja 1 par) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select jsonb_array_length(restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', 1) -> 'pares') as un_par_deberia_ser_1;
rollback;

\echo '=== B12. cobertura A1: primer dia 9, ultimo dia 12, zona de Mexico y corte de 1 hora ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (case when primer_dia = date '2026-03-09' and ultimo_dia = date '2026-03-12' and zona = 'America/Mexico_City' and corte = '01:00:00' then 1 else 0 end) as cobertura_a1_deberia_ser_1
  from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid]);
rollback;

\echo '=== B13. cobertura A3: zona Pacific/Auckland, sin corte, primer dia 10 y ultimo dia 11 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (case when primer_dia = date '2026-03-10' and ultimo_dia = date '2026-03-11' and zona = 'Pacific/Auckland' and corte = '00:00:00' then 1 else 0 end) as cobertura_a3_deberia_ser_1
  from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid]);
rollback;

\echo '=== B14. detalle A1 dia 10: 11 pedidos (todos menos programado y demo; incluye cancelado, no recogido, por_aprobar, falso y reposicion) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*)::int as detalle_deberia_ser_11 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== B15. detalle: cursor pagina de 4 en 4 sin repetir ni omitir filas (4 + 4 + 3) y la ultima pagina termina ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
do $$
declare
  v_cur text := null;
  v_n integer;
  v_total integer := 0;
  v_pag integer := 0;
  v_vistos uuid[] := '{}';
  r record;
begin
  loop
    v_n := 0;
    for r in select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', null, 4, v_cur) loop
      if r.order_id = any (v_vistos) then raise exception 'fila repetida %', r.order_id; end if;
      v_vistos := v_vistos || r.order_id;
      v_cur := r.cursor_pagina;
      v_n := v_n + 1;
    end loop;
    exit when v_n = 0;
    v_total := v_total + v_n;
    v_pag := v_pag + 1;
    exit when v_pag > 10;
  end loop;
  if v_total <> 11 or v_pag <> 3 then raise exception 'paginacion inesperada: % filas en % paginas', v_total, v_pag; end if;
end $$;
select 1 as paginacion_deberia_ser_1;
rollback;

\echo '=== B16. detalle: sin PII (ninguna columna con nombre, telefono o direccion) y el alias es un hash de 8 caracteres ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname in ('cfo_ventas_diarias','cfo_cortesias','cfo_ventas_hora','cfo_productos','cfo_canasta_pares','cfo_pedidos_detalle','cfo_cobertura') and pg_get_function_result(p.oid) ~* '(customer_name|customer_phone|customer_address|customer_id|telefono|direccion)')
  + (select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') where cliente_alias is not null and cliente_alias !~ '^[0-9a-f]{8}$') as pii_deberia_ser_0;
rollback;

\echo '=== B17. detalle: los clientes distintos tienen alias distintos y el pedido sin cliente no tiene alias ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(distinct cliente_alias)::int as alias_deberia_ser_2 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== B18. detalle: filtro de compensacion devuelve solo el pedido GRACIAS- ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*)::int as comp_deberia_ser_1 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"es_compensacion": true}'::jsonb);
rollback;

\echo '=== B19. detalle: filtro de entrega tarde devuelve solo el de 60 minutos; con canal domicilio solo el pedido 1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select ((select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"entrega_tarde": true}'::jsonb)) * 10 + (select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"canal": "domicilio"}'::jsonb))) as filtros_deberia_ser_11;
rollback;

\echo '=== B20. detalle: filtro por producto eliminado, solo ventas con descuento y hora 0 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select ((select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"producto_ref": "00000000-0000-0000-0000-0000000e43c3", "es_venta": true}'::jsonb)) * 100
  + (select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"con_descuento": true}'::jsonb)) * 10
  + (select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"hora_local": 0}'::jsonb))) as filtros2_deberia_ser_221;
rollback;

\echo '=== B21. detalle: la comanda del POS aparece (pendiente) solo en el pedido 1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*)::int as comandas_deberia_ser_1 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10') where comanda_estado = 'pendiente';
rollback;

\echo '=== B22. RECHAZADO: filtro fuera de la lista cerrada -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"customer_name": "x"}'::jsonb)$q$, '22023');
rollback;

\echo '=== B23. RECHAZADO: tipo de filtro erroneo y cursor invalido -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', '{"es_venta": "si"}'::jsonb)$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10', null, 5, 'basura')$q$, '22023');
rollback;

\echo '=== B24. detalle: tope de 200 filas aunque se pida mas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (count(*) <= 200)::int as tope_deberia_ser_1 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-01', date '2026-03-31', null, 100000);
rollback;

\echo '=== C1. aditividad cfo_ventas_diarias: el consolidado (owner, p_props nulo) es EXACTAMENTE la union de las 3 sucursales, todas las columnas ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (select count(*) from (select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14') except select * from (select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-08', date '2026-03-14')) u) x)
  + (select count(*) from (select * from (select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-08', date '2026-03-14')) u except select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14')) y) as dif_ventas_deberia_ser_0;
rollback;

\echo '=== C2. aditividad cfo_productos: el consolidado es EXACTAMENTE la union de las 3 sucursales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (select count(*) from (select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14') except select * from (select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-08', date '2026-03-14')) u) x)
  + (select count(*) from (select * from (select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-08', date '2026-03-14')) u except select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14')) y) as dif_productos_deberia_ser_0;
rollback;

\echo '=== C3. aditividad cfo_ventas_hora: el consolidado es EXACTAMENTE la union de las 3 sucursales ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (select count(*) from (select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14') except select * from (select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-08', date '2026-03-14')) u) x)
  + (select count(*) from (select * from (select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-08', date '2026-03-14') union all select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-08', date '2026-03-14')) u except select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14')) y) as dif_horas_deberia_ser_0;
rollback;

\echo '=== C4. consolidado: 14 pedidos y 112625 de venta neta en la semana 8..14 (A1 9 + A2 3 + A3 2) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(pedidos) * 1000000 + sum(neta_centavos))::bigint as total_deberia_ser_14112625 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14');
rollback;

\echo '=== C5. Σ sucursales = consolidado en venta neta: 63625 + 30000 + 19000 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select ((select sum(neta_centavos) from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14'))
  + (select sum(neta_centavos) from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-08', date '2026-03-14'))
  + (select sum(neta_centavos) from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-03-08', date '2026-03-14'))
  - (select sum(neta_centavos) from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14'))) as suma_vs_consolidado_deberia_ser_0;
rollback;

\echo '=== C6. no hay fila «No asignado» (property_id nulo) en esta migracion; la pone la 082 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*)::int as sin_sucursal_deberia_ser_0 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14') where property_id is null;
rollback;

\echo '=== C7. A1 por canal en la semana: domicilio (pedido 1) = 1 pedido; el resto recoger ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*)::int as domicilio_deberia_ser_1 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-08', date '2026-03-14') where canal = 'domicilio';
rollback;

\echo '=== D1. owner ve las 3 sucursales de su organizacion y ninguna ajena ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(distinct property_id)::int as sucursales_deberia_ser_3 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14');
rollback;

\echo '=== D2. admin acotado a A1: p_props nulo devuelve solo A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4312', true);
select (count(distinct property_id) * 10 + count(*) filter (where property_id <> '00000000-0000-0000-0000-0000000e43a1'))::int as admin_deberia_ser_10 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14');
rollback;

\echo '=== D3. RECHAZADO: el admin acotado pide A2 -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4312', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-10', date '2026-03-10')$q$, '42501');
rollback;

\echo '=== D4. RECHAZADO: el admin acotado pide A1 y A2 juntas -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4312', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid,'00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-10', date '2026-03-10')$q$, '42501');
rollback;

\echo '=== D5. el admin acotado ve cobertura y detalle solo de A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4312', true);
select ((select count(*) from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', null)) * 10 + (select count(*) from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-10') where property_id <> '00000000-0000-0000-0000-0000000e43a1')) as cobertura_admin_deberia_ser_10;
rollback;

\echo '=== D6. RECHAZADO: staff de piso -> 42501 en las 7 funciones (p_props nulo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4313', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D7. RECHAZADO: repartidor -> 42501 en las 7 funciones (p_props nulo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4314', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D8. RECHAZADO: staff pide una sucursal concreta -> 42501 en las 7 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4313', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D9. RECHAZADO: owner de otra organizacion pide la organizacion A (p_props nulo) -> 42501 en las 7 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4315', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D10. RECHAZADO: owner de otra organizacion pide sucursales de A -> 42501 en las 7 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4315', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D11. RECHAZADO: owner de A declara su organizacion pero pide la sucursal de B -> 42501 en las 7 funciones ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D12. RECHAZADO: anon sin execute -> 42501 en las 7 funciones ==='
begin;
set local role anon;
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', null)$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D13. RECHAZADO: sistema (sin usuario) con una sucursal de otra organizacion -> 42501 en las 7 funciones ==='
begin;
set local role authenticated;
do $$
declare
  v text;
begin
  foreach v in array array[
    $q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cortesias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_productos('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select restaurantes.cfo_canasta_pares('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid], date '2026-03-10', date '2026-03-11')$q$,
    $q$select * from restaurantes.cfo_cobertura('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43b1'::uuid])$q$
  ] loop
    perform public.t_esperar_error(v, '42501');
  end loop;
end $$;
select 1 as seguridad_ok;
rollback;

\echo '=== D14. sistema (sin usuario) con p_props nulo ve las 3 sucursales de la organizacion declarada y solo esas ==='
begin;
set local role authenticated;
select count(distinct property_id)::int as sistema_deberia_ser_3 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-08', date '2026-03-14');
rollback;

\echo '=== D15. sistema con una sucursal de su organizacion funciona ==='
begin;
set local role authenticated;
select sum(pedidos)::int as sistema_a1_deberia_ser_6 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10');
rollback;

\echo '=== D16. RECHAZADO: rango de 401 dias -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-01-01', date '2027-02-05')$q$, '22023');
rollback;

\echo '=== D17. rango de exactamente 400 dias es valido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select count(*) >= 0 as rango400_ok from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-01-01', date '2027-02-04');
rollback;

\echo '=== D18. RECHAZADO: rango invertido, lista vacia y lista con nulos -> 22023 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-14', date '2026-03-08')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', '{}'::uuid[], date '2026-03-10', date '2026-03-10')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array[null]::uuid[], date '2026-03-10', date '2026-03-10')$q$, '22023');
select public.t_esperar_error($q$select * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, null, null)$q$, '22023');
rollback;

\echo '=== D19. RECHAZADO: authenticated no ejecuta cfo_resolver_sucursales -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select restaurantes.cfo_resolver_sucursales('00000000-0000-0000-0000-0000000e4301', null)$q$, '42501');
rollback;

\echo '=== D20. RECHAZADO: authenticated no ejecuta cfo_pedidos_base -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select * from restaurantes.cfo_pedidos_base('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid], date '2026-03-10', date '2026-03-10')$q$, '42501');
rollback;

\echo '=== D21. RECHAZADO: authenticated no ejecuta los helpers cfo_validar_rango ni cfo_renglones -> 42501 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select public.t_esperar_error($q$select restaurantes.cfo_validar_rango(date '2026-03-10', date '2026-03-10')$q$, '42501');
select public.t_esperar_error($q$select * from restaurantes.cfo_renglones('[]'::jsonb)$q$, '42501');
rollback;

\echo '=== A19. entregas: un pedido completado (autopiloto) con 40 min cuenta como entrega (A2, 3 de marzo) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select (sum(entregados) * 10000 + sum(entrega_min_suma) * 100)::int as completado_deberia_ser_14000 from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-03', date '2026-03-03');
rollback;

\echo '=== A20. detalle: el completado trae entregado_min 40 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e4311', true);
select entregado_min::int as min_deberia_ser_40 from restaurantes.cfo_pedidos_detalle('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-03-03', date '2026-03-03');
rollback;

\echo '=== A21. dia de negocio en linea == restaurantes.dia_negocio() en todos los pedidos (corte 01:00, Madrid corte 02:00 con cambio de hora, Tijuana, Auckland, sin corte) ==='
begin;
select count(*)::int as difs_deberia_ser_0 from (
  select b.order_id, b.dia_negocio from restaurantes.cfo_pedidos_base('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a1'::uuid,'00000000-0000-0000-0000-0000000e43a2'::uuid,'00000000-0000-0000-0000-0000000e43a3'::uuid], date '2026-01-01', date '2026-12-31') b
  union all
  select b.order_id, b.dia_negocio from restaurantes.cfo_pedidos_base('00000000-0000-0000-0000-0000000e4302', array['00000000-0000-0000-0000-0000000e43b1'::uuid,'00000000-0000-0000-0000-0000000e43b2'::uuid,'00000000-0000-0000-0000-0000000e43b3'::uuid], date '2026-01-01', date '2026-12-31') b) x
  join restaurantes.orders o on o.id = x.order_id
 where x.dia_negocio <> restaurantes.dia_negocio(o.property_id, coalesce(o.promovido_at, o.created_at));
rollback;

\echo '=== A22. dia de negocio de Madrid (corte 02:00): 00:30Z del 29 cae el 28; 01:30Z (ya en horario de verano, 03:30 local) y 02:30Z caen el 29; Tijuana sin corte ==='
begin;
select count(*)::int as casos_deberia_ser_5 from restaurantes.cfo_pedidos_base('00000000-0000-0000-0000-0000000e4302', array['00000000-0000-0000-0000-0000000e43b2'::uuid,'00000000-0000-0000-0000-0000000e43b3'::uuid], date '2026-03-01', date '2026-03-31') b
 join restaurantes.orders o on o.id = b.order_id
 where (o.created_at = '2026-03-29 00:30+00' and b.dia_negocio = date '2026-03-28')
    or (o.created_at = '2026-03-29 01:30+00' and b.dia_negocio = date '2026-03-29')
    or (o.created_at = '2026-03-29 02:30+00' and b.dia_negocio = date '2026-03-29')
    or (o.created_at = '2026-03-10 07:30+00' and b.dia_negocio = date '2026-03-10' and b.hora_local = 0)
    or (o.created_at = '2026-03-08 09:30+00' and b.dia_negocio = date '2026-03-08');
rollback;

\echo '=== A23. rendimiento acotado: 20000 pedidos sinteticos en 30 dias, ventas_diarias + ventas_hora en menos de 2 s (transaccion con rollback) ==='
begin;
insert into restaurantes.orders (organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at)
select '00000000-0000-0000-0000-0000000e4301', '00000000-0000-0000-0000-0000000e43a2', 'Perf', '+52 5500' || lpad((g % 9000)::text, 6, '0'), 100 + (g % 50), 'pending',
       '[{"id":"00000000-0000-0000-0000-0000000e43c1","name":"Taco","price":50,"quantity":2}]'::jsonb, 'whatsapp', timestamptz '2026-04-01 00:00+00' + (g * interval '129 seconds')
  from generate_series(1, 20000) g;
analyze restaurantes.orders;
set local role authenticated;
do $$
declare
  t0 timestamptz := clock_timestamp();
  n bigint;
begin
  select sum(pedidos) into n from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-04-01', date '2026-04-30');
  perform * from restaurantes.cfo_ventas_hora('00000000-0000-0000-0000-0000000e4301', array['00000000-0000-0000-0000-0000000e43a2'::uuid], date '2026-04-01', date '2026-04-30');
  if n < 19000 then raise exception 'pedidos inesperados %', n; end if;
  if clock_timestamp() - t0 > interval '2 seconds' then raise exception 'demasiado lento: %', clock_timestamp() - t0; end if;
end $$;
select 1 as rendimiento_ok;
rollback;

\echo '=== E1. grants: las 7 publicas solo para authenticated (anon y public sin execute); los 4 helpers cerrados a authenticated ==='
begin;
select count(*)::int as grants_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%'
  and ((p.proname in ('cfo_ventas_diarias','cfo_cortesias','cfo_ventas_hora','cfo_productos','cfo_canasta_pares','cfo_pedidos_detalle','cfo_cobertura') and (not has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')))
    or (p.proname in ('cfo_renglones','cfo_validar_rango','cfo_resolver_sucursales','cfo_pedidos_base') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))));
rollback;

\echo '=== E2. hay exactamente 11 funciones cfo_ (7 publicas + 4 helpers), sin sobrecargas ==='
begin;
select count(*)::int as funciones_deberia_ser_11 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%';
rollback;

\echo '=== E3. SECURITY DEFINER en las 9 que leen orders, search_path fijo en las 11 ==='
begin;
select count(*)::int as postura_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%'
  and ((p.proname not in ('cfo_renglones','cfo_validar_rango') and not p.prosecdef)
    or p.proconfig is null or not exists (select 1 from unnest(p.proconfig) c where c like 'search_path=restaurantes, core, pg_temp'));
rollback;

\echo '=== E4. las 7 funciones publicas son STABLE (solo lectura: no pueden escribir) ==='
begin;
select count(*)::int as volatilidad_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%' and p.proname in ('cfo_ventas_diarias','cfo_cortesias','cfo_ventas_hora','cfo_productos','cfo_canasta_pares','cfo_pedidos_detalle','cfo_cobertura') and p.provolatile <> 's';
rollback;

\echo '=== E5. indices nuevos de orders creados ==='
begin;
select count(*)::int as indices_deberia_ser_2 from pg_indexes where schemaname = 'restaurantes' and indexname in ('orders_org_prop_created_idx', 'orders_org_prop_promovido_idx');
rollback;

\echo '=== E6. idempotencia: re-ejecutar las definiciones de las 11 funciones y los indices no cambia nada (mismo md5, mismos grants) ==='
begin;
do $$
declare
  r record;
  v_antes text;
  v_despues text;
begin
  select string_agg(md5(pg_get_functiondef(p.oid)) || p.proacl::text, ',' order by p.oid::regprocedure::text) into v_antes from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%';
  for r in select p.oid from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%' order by p.oid loop
    execute pg_get_functiondef(r.oid);
  end loop;
  create index if not exists orders_org_prop_created_idx on restaurantes.orders (organization_id, property_id, created_at);
  create index if not exists orders_org_prop_promovido_idx on restaurantes.orders (organization_id, property_id, promovido_at) where promovido_at is not null;
  select string_agg(md5(pg_get_functiondef(p.oid)) || p.proacl::text, ',' order by p.oid::regprocedure::text) into v_despues from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%';
  if v_antes is distinct from v_despues then
    raise exception 'la re-ejecucion cambio las funciones o sus permisos';
  end if;
end $$;
select count(*)::int as grants_mal_deberia_ser_0 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'restaurantes' and p.proname like 'cfo\_%'
  and ((p.proname in ('cfo_ventas_diarias','cfo_cortesias','cfo_ventas_hora','cfo_productos','cfo_canasta_pares','cfo_pedidos_detalle','cfo_cobertura') and (not has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute')))
    or (p.proname in ('cfo_renglones','cfo_validar_rango','cfo_resolver_sucursales','cfo_pedidos_base') and (has_function_privilege('authenticated', p.oid, 'execute') or has_function_privilege('anon', p.oid, 'execute') or has_function_privilege('public', p.oid, 'execute'))));
rollback;

\echo '=== E7. base SIN migrar: la funcion eliminada da 42883 y la transaccion se recupera con subtransaccion ==='
begin;
drop function restaurantes.cfo_ventas_diarias(uuid, uuid[], date, date, integer);
do $$
declare
  v_state text;
begin
  begin
    perform * from restaurantes.cfo_ventas_diarias('00000000-0000-0000-0000-0000000e4301', null, date '2026-03-10', date '2026-03-10');
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
