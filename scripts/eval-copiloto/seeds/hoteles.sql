-- SEMILLA del arnes de evaluacion del Copiloto (scripts/eval-copiloto). Hoteles: org A (Hotel Centro y Hotel Playa) y org B (ajena). Inventario 28-30 sep, folios y cargos, llegadas/salidas, tickets y housekeeping.
-- Es una COPIA CONGELADA del bloque de fixtures del verify de data-chat de esa vertical (datos ficticios, sin PII real):
-- las respuestas esperadas de los casos se calculan contra ESTOS datos y se congelan en datos/*.congelado.json.
-- No editar sin volver a congelar (npm run eval:copiloto:congelar).
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000d101', 'hoteles', 'Hoteles A (data chat)', 'hoteles-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d102', 'hoteles', 'Hoteles B (data chat, ajena)', 'hoteles-b-data-chat')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000141', 'owner-a-hotchat@example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-000000000142', 'gm-centro-hotchat@example.com', 'GM Centro', 'seed'),
  ('00000000-0000-0000-0000-000000000143', 'owner-b-hotchat@example.com', 'Owner B (ajeno)', 'seed'),
  ('00000000-0000-0000-0000-000000000144', 'hk-a-hotchat@example.com', 'Housekeeping A', 'seed')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-00000000d101', 'hoteles', 'Hotel Centro'),
  ('00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-00000000d101', 'hoteles', 'Hotel Playa'),
  ('00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-00000000d102', 'hoteles', 'Hotel B Ajeno')
on conflict do nothing;

-- owner A: todos los hoteles de A. gm: SOLO Centro. housekeeping: todos los de A pero sin acceso a dinero ni a tickets de otros departamentos.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000141', '00000000-0000-0000-0000-00000000d101', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-000000000142', '00000000-0000-0000-0000-00000000d101', array['00000000-0000-0000-0000-00000000f101']::uuid[], 'admin', 'gm'),
  ('00000000-0000-0000-0000-000000000144', '00000000-0000-0000-0000-00000000d101', null, 'member', 'housekeeping'),
  ('00000000-0000-0000-0000-000000000143', '00000000-0000-0000-0000-00000000d102', null, 'owner', 'owner')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('00000000-0000-0000-0000-0000000a1001', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', 'Doble'),
  ('00000000-0000-0000-0000-0000000a1002', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', 'Suite'),
  ('00000000-0000-0000-0000-0000000a1003', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f102', 'Doble Playa'),
  ('00000000-0000-0000-0000-0000000a1004', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000f103', 'Doble B')
on conflict do nothing;

insert into hoteles.room (id, organization_id, property_id, room_type_id, code) values
  ('00000000-0000-0000-0000-0000000b1001', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1001', '101'),
  ('00000000-0000-0000-0000-0000000b1002', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1001', '102'),
  ('00000000-0000-0000-0000-0000000b1003', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1002', '201'),
  ('00000000-0000-0000-0000-0000000b1004', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-0000000a1003', '301'),
  ('00000000-0000-0000-0000-0000000b1005', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-0000000a1004', '901')
on conflict do nothing;

-- Inventario por dia (28, 29 y 30-sep-2026). Centro: Doble 10 + Suite 5 = 15 habitaciones/dia (DOS filas por dia: un JOIN
-- cargo x inventario las duplicaria). Playa: 20. Org B: 100.
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms)
select o, p, rt, d::date, n from (values
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 10),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1002'::uuid, 5),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f102'::uuid, '00000000-0000-0000-0000-0000000a1003'::uuid, 20),
  ('00000000-0000-0000-0000-00000000d102'::uuid, '00000000-0000-0000-0000-00000000f103'::uuid, '00000000-0000-0000-0000-0000000a1004'::uuid, 100)
) v(o, p, rt, n), generate_series('2026-09-28'::date, '2026-09-30'::date, interval '1 day') d
on conflict do nothing;

-- Reservas de apoyo para los folios (fuera de las ventanas de llegadas/salidas de los escenarios: ago-2026).
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount)
select ('00000000-0000-0000-0000-0000000c' || lpad(n::text, 4, '0'))::uuid, o, p, rt, '2026-08-01', '2026-08-05', 'confirmada', 0
from (values
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 1),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 2),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 3),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 4),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 5),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 6),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 7),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 8),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f101'::uuid, '00000000-0000-0000-0000-0000000a1001'::uuid, 9),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f102'::uuid, '00000000-0000-0000-0000-0000000a1003'::uuid, 11),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f102'::uuid, '00000000-0000-0000-0000-0000000a1003'::uuid, 12),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f102'::uuid, '00000000-0000-0000-0000-0000000a1003'::uuid, 13),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f102'::uuid, '00000000-0000-0000-0000-0000000a1003'::uuid, 14),
  ('00000000-0000-0000-0000-00000000d101'::uuid, '00000000-0000-0000-0000-00000000f102'::uuid, '00000000-0000-0000-0000-0000000a1003'::uuid, 15),
  ('00000000-0000-0000-0000-00000000d102'::uuid, '00000000-0000-0000-0000-00000000f103'::uuid, '00000000-0000-0000-0000-0000000a1004'::uuid, 21)
) v(o, p, rt, n)
on conflict do nothing;

insert into hoteles.folio (organization_id, property_id, reservation_id)
select r.organization_id, r.property_id, r.id from hoteles.reservation r where r.check_in_date = '2026-08-01';

-- Cargos de hospedaje (1 noche ocupada = 1 cargo vigente):
--   Centro 28-sep: 6 noches x $1000 · 29-sep: 8 noches x $1000 + 1 cargo REVERSADO (no cuenta) · 30-sep: 0
--   Playa  28-sep: 4 noches x $800  · 29-sep: 5 noches x $800
--   Org B  29-sep: 1 noche $9999 (otro tenant)
-- Mas: A&B $500 y extras $300 y propina $100 (no es ingreso) y descuento -$200 el 29 en Centro.
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, concept, stay_date)
select f.organization_id, f.property_id, f.id, 'Noche', v.amount, 'hospedaje', v.d::date
from (
  select r.id as reservation_id, row_number() over (partition by r.property_id order by r.id) as k
  from hoteles.reservation r where r.check_in_date = '2026-08-01'
) q
join hoteles.folio f on f.reservation_id = q.reservation_id
join (values
  ('00000000-0000-0000-0000-00000000f101'::uuid, '2026-09-28', 1000, 6),
  ('00000000-0000-0000-0000-00000000f101'::uuid, '2026-09-29', 1000, 8),
  ('00000000-0000-0000-0000-00000000f102'::uuid, '2026-09-28', 800, 4),
  ('00000000-0000-0000-0000-00000000f102'::uuid, '2026-09-29', 800, 5),
  ('00000000-0000-0000-0000-00000000f103'::uuid, '2026-09-29', 9999, 1)
) v(p, d, amount, n) on v.p = f.property_id and q.k <= v.n;

-- Cargo del 9o folio de Centro (29-sep) y su reverso: el original queda con reversed_by (no es noche ocupada).
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, concept, stay_date)
select '00000000-0000-0000-0000-0000000e0001', f.organization_id, f.property_id, f.id, 'Noche reversada', 1000, 'hospedaje', '2026-09-29'
from hoteles.folio f join hoteles.reservation r on r.id = f.reservation_id
where f.property_id = '00000000-0000-0000-0000-00000000f101'
order by r.id desc limit 1;
insert into hoteles.charge (id, organization_id, property_id, folio_id, description, amount, concept, stay_date, reverses_charge_id)
select '00000000-0000-0000-0000-0000000e0002', organization_id, property_id, folio_id, 'Reverso', -1000, 'reverso', '2026-09-29', id
from hoteles.charge where id = '00000000-0000-0000-0000-0000000e0001';
update hoteles.charge set reversed_by = '00000000-0000-0000-0000-0000000e0002' where id = '00000000-0000-0000-0000-0000000e0001';

insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, concept, stay_date)
select f.organization_id, f.property_id, f.id, v.descr, v.amount, v.concept, '2026-09-29'
from (select f2.id, f2.organization_id, f2.property_id from hoteles.folio f2 where f2.property_id = '00000000-0000-0000-0000-00000000f101' order by f2.id limit 1) f
cross join (values ('A&B', 500, 'ab'), ('Extra', 300, 'extras'), ('Propina', 100, 'propina'), ('Descuento', -200, 'descuento')) v(descr, amount, concept);

-- Reservas de las ventanas de llegadas/salidas/cancelaciones (Centro: A1..A5; Playa: P1; Org B: B1).
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, check_in_date, check_out_date, status, total_amount, canceled_at, cancellation_penalty_amount) values
  ('00000000-0000-0000-0000-0000000f0101', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1001', '2026-09-29', '2026-10-01', 'confirmada', 2000, null, null),
  ('00000000-0000-0000-0000-0000000f0102', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1001', '2026-09-28', '2026-09-30', 'en_estancia', 2000, null, null),
  ('00000000-0000-0000-0000-0000000f0103', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1001', '2026-09-29', '2026-09-30', 'cancelada', 1500, '2026-09-30T02:30:00Z', 300),
  ('00000000-0000-0000-0000-0000000f0104', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1001', '2026-09-29', '2026-09-30', 'cotizada', 999, null, null),
  ('00000000-0000-0000-0000-0000000f0105', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000a1001', '2026-09-29', '2026-09-30', 'no_show', 888, null, null),
  ('00000000-0000-0000-0000-0000000f0201', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-0000000a1003', '2026-09-29', '2026-09-30', 'confirmada', 800, null, null),
  ('00000000-0000-0000-0000-0000000f0202', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-0000000a1003', '2026-09-27', '2026-09-28', 'cancelada', 700, '2026-09-28T15:00:00Z', 0),
  ('00000000-0000-0000-0000-0000000f0301', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-0000000a1004', '2026-09-29', '2026-09-30', 'confirmada', 9999, null, null),
  ('00000000-0000-0000-0000-0000000f0302', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-0000000a1004', '2026-09-29', '2026-09-30', 'cancelada', 7777, '2026-09-29T15:00:00Z', 100);

-- Tickets de huesped (el trigger fija estado 'abierto' y el SLA al insertar; luego se ajustan como superusuario).
-- "Ahora" de los escenarios = 2026-09-30T12:00:00Z.
--   Centro: T1 frontdesk/alta abierto SLA vencido · T2 housekeeping/media en_progreso vence en 1 h · T3 frontdesk/alta escalado vencido · T4 cerrado
--   Playa: T5 fnb/baja abierto lejano · Org B: T6 frontdesk/alta abierto
insert into hoteles.guest_ticket (id, organization_id, property_id, department, priority, guest_message, sla_minutes) values
  ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', 'frontdesk', 'alta', 'Ticket 1 (texto del huesped, no debe salir)', 30),
  ('00000000-0000-0000-0000-0000000aa002', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', 'housekeeping', 'media', 'Ticket 2', 120),
  ('00000000-0000-0000-0000-0000000aa003', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', 'frontdesk', 'alta', 'Ticket 3', 30),
  ('00000000-0000-0000-0000-0000000aa004', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', 'frontdesk', 'baja', 'Ticket 4', 30),
  ('00000000-0000-0000-0000-0000000aa005', '00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f102', 'fnb', 'baja', 'Ticket 5', 600),
  ('00000000-0000-0000-0000-0000000aa006', '00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000f103', 'frontdesk', 'alta', 'Ticket 6', 30);
update hoteles.guest_ticket set sla_due_at = '2026-09-30T09:00:00Z' where id in ('00000000-0000-0000-0000-0000000aa001', '00000000-0000-0000-0000-0000000aa003');
update hoteles.guest_ticket set sla_due_at = '2026-09-30T13:00:00Z', status = 'en_progreso' where id = '00000000-0000-0000-0000-0000000aa002';
update hoteles.guest_ticket set status = 'escalado' where id = '00000000-0000-0000-0000-0000000aa003';
update hoteles.guest_ticket set status = 'cerrado', resolution_note = 'ok' where id = '00000000-0000-0000-0000-0000000aa004';
update hoteles.guest_ticket set sla_due_at = '2026-10-02T00:00:00Z' where id in ('00000000-0000-0000-0000-0000000aa005', '00000000-0000-0000-0000-0000000aa006');

-- Housekeeping ("hoy" de los escenarios = 2026-09-29): ver los comentarios de cada escenario.
insert into hoteles.housekeeping_task (organization_id, property_id, room_id, task_type, status, priority, work_date, finished_at) values
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000b1001', 'salida', 'pendiente', 'alta', '2026-09-29', null),
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000b1002', 'salida', 'pendiente', 'normal', '2026-09-27', null),
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000b1003', 'estancia', 'en_progreso', 'normal', '2026-09-29', null),
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000b1003', 'salida', 'terminada', 'normal', '2026-09-29', '2026-09-29T15:00:00Z'),
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f101', '00000000-0000-0000-0000-0000000b1001', 'profunda', 'pendiente', 'normal', '2026-09-30', null),
  ('00000000-0000-0000-0000-00000000d101', '00000000-0000-0000-0000-00000000f102', '00000000-0000-0000-0000-0000000b1004', 'profunda', 'pendiente', 'normal', '2026-09-29', null),
  ('00000000-0000-0000-0000-00000000d102', '00000000-0000-0000-0000-00000000f103', '00000000-0000-0000-0000-0000000b1005', 'salida', 'pendiente', 'alta', '2026-09-29', null);
