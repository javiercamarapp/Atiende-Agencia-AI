-- SEMILLA del arnes de evaluacion del Copiloto (scripts/eval-copiloto). Restaurantes: org A (Centro y Norte) y org B (ajena). Pedidos 20 y 29-sep-2026 (America/Merida), 1 cancelado, items malformados, promociones.
-- Es una COPIA CONGELADA del bloque de fixtures del verify de data-chat de esa vertical (datos ficticios, sin PII real):
-- las respuestas esperadas de los casos se calculan contra ESTOS datos y se congelan en datos/*.congelado.json.
-- No editar sin volver a congelar (npm run eval:copiloto:congelar).
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000d001', 'restaurantes', 'Org A (data chat)', 'org-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d002', 'restaurantes', 'Org B (data chat, ajena)', 'org-b-data-chat')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000041', 'owner-a-datachat@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000042', 'gerente-a-datachat@example.com', 'Gerente Centro A', 'seed'),
  ('00000000-0000-0000-0000-000000000043', 'owner-b-datachat@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000044', 'admin-a-datachat@example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-000000000045', 'member-a-datachat@example.com', 'Member A', 'seed')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000e001', '00000000-0000-0000-0000-00000000d001', 'restaurantes', 'Centro'),
  ('00000000-0000-0000-0000-00000000e002', '00000000-0000-0000-0000-00000000d001', 'restaurantes', 'Norte'),
  ('00000000-0000-0000-0000-00000000e003', '00000000-0000-0000-0000-00000000d002', 'restaurantes', 'Centro B')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, slug, organization_id, display_order) values
  ('00000000-0000-0000-0000-00000000e001', 'centro', '00000000-0000-0000-0000-00000000d001', 1),
  ('00000000-0000-0000-0000-00000000e002', 'norte', '00000000-0000-0000-0000-00000000d001', 2),
  ('00000000-0000-0000-0000-00000000e003', 'centro', '00000000-0000-0000-0000-00000000d002', 1)
on conflict do nothing;

-- owner A y admin A: todas las sucursales. gerente: SOLO Centro. member A: platform_role 'member' (no lee la bitacora).
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000041', '00000000-0000-0000-0000-00000000d001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000044', '00000000-0000-0000-0000-00000000d001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-000000000042', '00000000-0000-0000-0000-00000000d001', array['00000000-0000-0000-0000-00000000e001']::uuid[], 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000045', '00000000-0000-0000-0000-00000000d001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-000000000043', '00000000-0000-0000-0000-00000000d002', null, 'owner', 'owner')
on conflict do nothing;

-- Pedidos (ventana de los escenarios: 29-sep-2026 hora de Merida = 2026-09-29T06:00Z .. 2026-09-30T06:00Z):
--  o1 Centro  100 whatsapp 12:00 local   · o2 Centro 200 voice 20:30 local (02:30 UTC del 30!) · o3 Centro 50 CANCELADO
--  o4 Norte   300 web 14:00 local        · o5 Norte  400 whatsapp 15:00 local
--  o6 Norte    80 web, 20-sep (ANTES de la ventana; cliente ...02 vuelve a pedir el 29 => recurrente)
--  o7 Centro B 9999 (otro tenant)
insert into restaurantes.orders (id, organization_id, property_id, customer_name, customer_phone, total, status, items, source, created_at) values
  ('00000000-0000-0000-0000-0000000f0001', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e001', 'Cliente Uno', '9990000001', 100.00, 'completado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":4}]', 'whatsapp', '2026-09-29T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0002', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e001', 'Cliente Uno', '9990000001', 200.00, 'completado', '[{"id":"p2","name":"Panucho","price":20,"quantity":10},{"id":"p9","name":"Raro","price":10,"quantity":"abc"}]', 'voice', '2026-09-30T02:30:00Z'),
  ('00000000-0000-0000-0000-0000000f0003', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e001', 'Cliente Cuatro', '9990000004', 50.00, 'cancelado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":2}]', 'whatsapp', '2026-09-29T19:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0004', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e002', 'Cliente Dos', '9990000002', 300.00, 'completado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":8},{"id":"p2","name":"Panucho","price":20,"quantity":5}]', 'web', '2026-09-29T20:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0005', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e002', 'Cliente Tres', '9990000003', 400.00, 'completado', '[{"id":"p3","name":"Cochinita pibil","price":100,"quantity":4}]', 'whatsapp', '2026-09-29T21:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0006', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-00000000e002', 'Cliente Dos', '9990000002', 80.00, 'completado', '[{"id":"p1","name":"Taco de cochinita","price":25,"quantity":3}]', 'web', '2026-09-20T18:00:00Z'),
  ('00000000-0000-0000-0000-0000000f0007', '00000000-0000-0000-0000-00000000d002', '00000000-0000-0000-0000-00000000e003', 'Cliente Nueve', '9990000009', 9999.00, 'completado', '[{"id":"p7","name":"Secreto de B","price":9999,"quantity":1}]', 'whatsapp', '2026-09-29T18:00:00Z')
on conflict do nothing;

insert into restaurantes.promotions (organization_id, code, name, type, value, is_active, times_used) values
  ('00000000-0000-0000-0000-00000000d001', 'BIENVENIDA10', 'Bienvenida', 'percentage', 10, true, 33),
  ('00000000-0000-0000-0000-00000000d001', 'INACTIVA50', 'Inactiva A', 'fixed', 50, false, 4),
  ('00000000-0000-0000-0000-00000000d002', 'BIENVENIDA10', 'Bienvenida B', 'percentage', 15, true, 1)
on conflict do nothing;

-- Fila de bitacora sembrada como superusuario (la funcion exige auth.uid() no nulo).
insert into core.data_chat_query_log (id, organization_id, user_id, vertical, tool, params, outcome, row_count, duration_ms) values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000d001', '00000000-0000-0000-0000-000000000041', 'restaurantes', 'ventas_por_dia', '{"periodo":"hoy"}', 'ok', 2, 12)
on conflict do nothing;
