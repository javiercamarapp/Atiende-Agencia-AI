-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales, no el repositorio en
-- memoria), las consultas de SOLO LECTURA del catalogo de HOTELES de "Chatea con tus datos"
-- (packages/domain-hoteles/src/data-chat/sql.ts -- el texto se copia IDENTICO aqui y
-- packages/domain-hoteles/tests/data-chat/sql-drift.spec.ts falla si divergen), ejecutadas como el rol
-- `authenticated` con auth.uid() real:
--   1. cross-tenant: un owner de la Org B pidiendo la Org A (y al reves) no ve ni una fila.
--   2. cross-hotel: un gm con membership acotada a UN hotel solo ve ese -- incluso si la aplicacion se
--      equivocara y pasara `null` (todos) o el id de otro hotel, la RLS (has_property_access, can_access_money)
--      y el JOIN con core.property lo impiden: defensa en profundidad.
--   3. doble conteo: ocupacion/ADR/RevPAR agregan cargos e inventario en CTE separados (inventario con DOS tipos
--      de habitacion por dia); el cargo reversado y la propina no cuentan; llegadas y salidas son disjuntas.
--   4. zona horaria America/Merida: una cancelacion de las 20:30 locales (02:30Z del dia siguiente) cae en su dia local.
--   5. rol sin acceso a dinero/tickets de otros departamentos (housekeeping): la RLS oculta cargos y tickets ajenos.
--   6. anon no puede leer nada.
--   7. Base SIN MIGRAR (REGLA DURA): con tabla/columna eliminada DENTRO de la transaccion, el SQL real falla con
--      42P01/42703 y SAVEPOINT + ROLLBACK TO SAVEPOINT (el mismo mecanismo que runWithSavepointFallback) deja la
--      transaccion utilizable.
-- No hay migracion nueva: la bitacora (core.data_chat_query_log / core.record_data_chat_query, 0029) ya es
-- generica y se verifica en scripts/verify-data-chat.
--
-- Convenciones del gate (scripts/verify-real-postgres-ci/run-gate.mjs): `as should_fail` = debe terminar en
-- ERROR; alias `..._deberia_ser_N` = esa consulta devuelve N; un bloque DO que lanza excepcion ante una
-- discrepancia = debe completar sin error. Cada escenario va en su `begin; ... rollback;`.
\set ON_ERROR_STOP off
\pset pager off


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

\echo ''
\echo '=== A) consultas de solo lectura del catalogo de hoteles: ocupacion / ADR / RevPAR ==='
\echo ''
\echo '--- 1. owner A (todos los hoteles) 28 a 30 sep por dia: 3 dias; 105 noches disponibles (35 por dia: Centro 10+5 y Playa 20, SIN multiplicar por cargos), 23 ocupadas (el cargo reversado NO cuenta) y $21,200 de hospedaje ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.bucket::text; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 3 and s_available_nights = 105 and s_occupied_nights = 23 and s_room_revenue = 21200 and b = '2026-09-28,2026-09-29,2026-09-30') then raise exception '%', 'esperaba filas=3, buckets=2026-09-28,2026-09-29,2026-09-30, available_nights=105, occupied_nights=23, room_revenue=21200; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 2. mismo periodo agrupado por mes: UN bucket (1 sep) con los mismos totales: agrupar no duplica ni pierde noches ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'month'::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.bucket::text; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 1 and s_available_nights = 105 and s_occupied_nights = 23 and s_room_revenue = 21200 and b = '2026-09-01') then raise exception '%', 'esperaba filas=1, buckets=2026-09-01, available_nights=105, occupied_nights=23, room_revenue=21200; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 3. gm de Centro con el id correcto: 45 disponibles, 14 ocupadas, $14,000 (Playa no aparece) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, array['00000000-0000-0000-0000-00000000f101']::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 3 and s_available_nights = 45 and s_occupied_nights = 14 and s_room_revenue = 14000) then raise exception '%', 'esperaba filas=3, available_nights=45, occupied_nights=14, room_revenue=14000; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 4. gm de Centro aunque la APP se equivocara y pasara null (todos): RLS lo acota igual a Centro ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 3 and s_available_nights = 45 and s_occupied_nights = 14 and s_room_revenue = 14000) then raise exception '%', 'esperaba filas=3, available_nights=45, occupied_nights=14, room_revenue=14000; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 5. gm de Centro pidiendo SOLO el id de Playa: 0 filas (hotel fuera de su membership) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, array['00000000-0000-0000-0000-00000000f102']::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 0 and s_available_nights = 0 and s_occupied_nights = 0 and s_room_revenue = 0) then raise exception '%', 'esperaba filas=0, available_nights=0, occupied_nights=0, room_revenue=0; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 6. cross-tenant: owner B pidiendo la organizacion A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 0 and s_available_nights = 0 and s_occupied_nights = 0 and s_room_revenue = 0) then raise exception '%', 'esperaba filas=0, available_nights=0, occupied_nights=0, room_revenue=0; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 7. cross-tenant (otro sentido): owner A pidiendo la organizacion B: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d102'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 0 and s_available_nights = 0 and s_occupied_nights = 0 and s_room_revenue = 0) then raise exception '%', 'esperaba filas=0, available_nights=0, occupied_nights=0, room_revenue=0; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 8. positivo de B: owner B ve SOLO lo suyo (300 disponibles, 1 ocupada, $9,999) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d102'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 3 and s_available_nights = 300 and s_occupied_nights = 1 and s_room_revenue = 9999) then raise exception '%', 'esperaba filas=3, available_nights=300, occupied_nights=1, room_revenue=9999; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 9. housekeeping (sin acceso a dinero): la RLS de cargos oculta las noches ocupadas (0): por eso la RUTA exige owner/gm y no confia solo en este SQL ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000144', true);
do $do$
declare r record; n int := 0; b text := ''; s_available_nights numeric := 0; s_occupied_nights numeric := 0; s_room_revenue numeric := 0;
begin
  for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_available_nights := s_available_nights + r.available_nights; s_occupied_nights := s_occupied_nights + r.occupied_nights; s_room_revenue := s_room_revenue + r.room_revenue; end loop;
  if not (n = 3 and s_available_nights = 105 and s_occupied_nights = 0 and s_room_revenue = 0) then raise exception '%', 'esperaba filas=3, available_nights=105, occupied_nights=0, room_revenue=0; obtuve '||format('filas=%s, buckets=%s, available_nights=%s, occupied_nights=%s, room_revenue=%s', n, b, s_available_nights, s_occupied_nights, s_room_revenue); end if;
end $do$;
rollback;
\echo '--- 10. anon no puede leer cargos ni inventario ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$with ocupadas as (
    select c.stay_date as day, count(*) as room_nights, coalesce(sum(c.amount), 0) as revenue
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and c.concept = 'hospedaje' and c.reversed_by is null
      and c.stay_date between $3::date and $4::date
    group by c.stay_date
  ), disponibles as (
    select a.date as day, coalesce(sum(a.total_rooms), 0) as available
    from hoteles.availability a
    join core.property p on p.id = a.property_id
    where a.organization_id = $1
    and ($2::uuid[] is null or a.property_id = any($2::uuid[]))
      and a.date between $3::date and $4::date
    group by a.date
  )
  select to_char(date_trunc($5::text, coalesce(o.day, d.day)::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.available), 0) as available_nights,
    coalesce(sum(o.room_nights), 0) as occupied_nights,
    coalesce(sum(o.revenue), 0) as room_revenue
  from ocupadas o
  full join disponibles d on d.day = o.day
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== B) ingresos por periodo ==='
\echo ''
\echo '--- 11. owner A, SOLO Centro, 28 a 30 sep: habitaciones 13,800 (6,000 + 8,000 + 1,000 reversado - 1,000 reverso - 200 descuento), A&B 500, otros 300; la propina NO es ingreso ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_rooms numeric := 0; s_food_beverage numeric := 0; s_other numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.amount) filter (where d.dept = 'habitaciones'), 0) as rooms,
    coalesce(sum(d.amount) filter (where d.dept = 'ab'), 0) as food_beverage,
    coalesce(sum(d.amount) filter (where d.dept = 'otros'), 0) as other
  from (
    select coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) as day, c.amount,
      case coalesce(orig.concept, c.concept)
        when 'hospedaje' then 'habitaciones'
        when 'ajuste' then 'habitaciones'
        when 'descuento' then 'habitaciones'
        when 'ab' then 'ab'
        when 'extras' then 'otros'
        when 'otro' then 'otros'
        else null
      end as dept
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    left join hoteles.charge orig on orig.id = c.reverses_charge_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) between $3::date and $4::date
      and coalesce(orig.concept, c.concept) <> 'propina'
  ) d
  where d.dept is not null
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, array['00000000-0000-0000-0000-00000000f101']::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.bucket::text; s_rooms := s_rooms + r.rooms; s_food_beverage := s_food_beverage + r.food_beverage; s_other := s_other + r.other; end loop;
  if not (n = 2 and s_rooms = 13800 and s_food_beverage = 500 and s_other = 300 and b = '2026-09-28,2026-09-29') then raise exception '%', 'esperaba filas=2, buckets=2026-09-28,2026-09-29, rooms=13800, food_beverage=500, other=300; obtuve '||format('filas=%s, buckets=%s, rooms=%s, food_beverage=%s, other=%s', n, b, s_rooms, s_food_beverage, s_other); end if;
end $do$;
rollback;
\echo '--- 12. owner A, todos los hoteles, por mes: 21,000 de habitaciones (13,800 + 7,200 de Playa), 500 y 300 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_rooms numeric := 0; s_food_beverage numeric := 0; s_other numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.amount) filter (where d.dept = 'habitaciones'), 0) as rooms,
    coalesce(sum(d.amount) filter (where d.dept = 'ab'), 0) as food_beverage,
    coalesce(sum(d.amount) filter (where d.dept = 'otros'), 0) as other
  from (
    select coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) as day, c.amount,
      case coalesce(orig.concept, c.concept)
        when 'hospedaje' then 'habitaciones'
        when 'ajuste' then 'habitaciones'
        when 'descuento' then 'habitaciones'
        when 'ab' then 'ab'
        when 'extras' then 'otros'
        when 'otro' then 'otros'
        else null
      end as dept
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    left join hoteles.charge orig on orig.id = c.reverses_charge_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) between $3::date and $4::date
      and coalesce(orig.concept, c.concept) <> 'propina'
  ) d
  where d.dept is not null
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'month'::text, 'America/Merida'::text, 51::int loop n := n + 1; s_rooms := s_rooms + r.rooms; s_food_beverage := s_food_beverage + r.food_beverage; s_other := s_other + r.other; end loop;
  if not (n = 1 and s_rooms = 21000 and s_food_beverage = 500 and s_other = 300) then raise exception '%', 'esperaba filas=1, rooms=21000, food_beverage=500, other=300; obtuve '||format('filas=%s, buckets=%s, rooms=%s, food_beverage=%s, other=%s', n, b, s_rooms, s_food_beverage, s_other); end if;
end $do$;
rollback;
\echo '--- 13. cross-tenant: owner B pidiendo la organizacion A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_rooms numeric := 0; s_food_beverage numeric := 0; s_other numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.amount) filter (where d.dept = 'habitaciones'), 0) as rooms,
    coalesce(sum(d.amount) filter (where d.dept = 'ab'), 0) as food_beverage,
    coalesce(sum(d.amount) filter (where d.dept = 'otros'), 0) as other
  from (
    select coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) as day, c.amount,
      case coalesce(orig.concept, c.concept)
        when 'hospedaje' then 'habitaciones'
        when 'ajuste' then 'habitaciones'
        when 'descuento' then 'habitaciones'
        when 'ab' then 'ab'
        when 'extras' then 'otros'
        when 'otro' then 'otros'
        else null
      end as dept
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    left join hoteles.charge orig on orig.id = c.reverses_charge_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) between $3::date and $4::date
      and coalesce(orig.concept, c.concept) <> 'propina'
  ) d
  where d.dept is not null
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; s_rooms := s_rooms + r.rooms; s_food_beverage := s_food_beverage + r.food_beverage; s_other := s_other + r.other; end loop;
  if not (n = 0 and s_rooms = 0 and s_food_beverage = 0 and s_other = 0) then raise exception '%', 'esperaba filas=0, rooms=0, food_beverage=0, other=0; obtuve '||format('filas=%s, buckets=%s, rooms=%s, food_beverage=%s, other=%s', n, b, s_rooms, s_food_beverage, s_other); end if;
end $do$;
rollback;
\echo '--- 14. gm de Centro con null (app equivocada): solo Centro = 13,800 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_rooms numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.amount) filter (where d.dept = 'habitaciones'), 0) as rooms,
    coalesce(sum(d.amount) filter (where d.dept = 'ab'), 0) as food_beverage,
    coalesce(sum(d.amount) filter (where d.dept = 'otros'), 0) as other
  from (
    select coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) as day, c.amount,
      case coalesce(orig.concept, c.concept)
        when 'hospedaje' then 'habitaciones'
        when 'ajuste' then 'habitaciones'
        when 'descuento' then 'habitaciones'
        when 'ab' then 'ab'
        when 'extras' then 'otros'
        when 'otro' then 'otros'
        else null
      end as dept
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    left join hoteles.charge orig on orig.id = c.reverses_charge_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) between $3::date and $4::date
      and coalesce(orig.concept, c.concept) <> 'propina'
  ) d
  where d.dept is not null
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; s_rooms := s_rooms + r.rooms; end loop;
  if not (n = 2 and s_rooms = 13800) then raise exception '%', 'esperaba filas=2, rooms=13800; obtuve '||format('filas=%s, buckets=%s, rooms=%s', n, b, s_rooms); end if;
end $do$;
rollback;
\echo '--- 15. housekeeping: 0 filas (sin acceso a dinero) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000144', true);
do $do$
declare r record; n int := 0; b text := ''; s_rooms numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.amount) filter (where d.dept = 'habitaciones'), 0) as rooms,
    coalesce(sum(d.amount) filter (where d.dept = 'ab'), 0) as food_beverage,
    coalesce(sum(d.amount) filter (where d.dept = 'otros'), 0) as other
  from (
    select coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) as day, c.amount,
      case coalesce(orig.concept, c.concept)
        when 'hospedaje' then 'habitaciones'
        when 'ajuste' then 'habitaciones'
        when 'descuento' then 'habitaciones'
        when 'ab' then 'ab'
        when 'extras' then 'otros'
        when 'otro' then 'otros'
        else null
      end as dept
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    left join hoteles.charge orig on orig.id = c.reverses_charge_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) between $3::date and $4::date
      and coalesce(orig.concept, c.concept) <> 'propina'
  ) d
  where d.dept is not null
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; s_rooms := s_rooms + r.rooms; end loop;
  if not (n = 0 and s_rooms = 0) then raise exception '%', 'esperaba filas=0, rooms=0; obtuve '||format('filas=%s, buckets=%s, rooms=%s', n, b, s_rooms); end if;
end $do$;
rollback;
\echo '--- 16. anon no puede leer cargos ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    coalesce(sum(d.amount) filter (where d.dept = 'habitaciones'), 0) as rooms,
    coalesce(sum(d.amount) filter (where d.dept = 'ab'), 0) as food_beverage,
    coalesce(sum(d.amount) filter (where d.dept = 'otros'), 0) as other
  from (
    select coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) as day, c.amount,
      case coalesce(orig.concept, c.concept)
        when 'hospedaje' then 'habitaciones'
        when 'ajuste' then 'habitaciones'
        when 'descuento' then 'habitaciones'
        when 'ab' then 'ab'
        when 'extras' then 'otros'
        when 'otro' then 'otros'
        else null
      end as dept
    from hoteles.charge c
    join core.property p on p.id = c.property_id
    left join hoteles.charge orig on orig.id = c.reverses_charge_id
    where c.organization_id = $1
    and ($2::uuid[] is null or c.property_id = any($2::uuid[]))
      and coalesce(c.stay_date, (c.created_at at time zone $6::text)::date) between $3::date and $4::date
      and coalesce(orig.concept, c.concept) <> 'propina'
  ) d
  where d.dept is not null
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 'America/Merida'::text, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== C) llegadas y salidas ==='
\echo ''
\echo '--- 17. owner A 28 a 30 sep por dia: 3 llegadas (28: 1; 29: 2) y 2 salidas (30: 2); cotizada, cancelada y no-show NO cuentan; la salida del 1-oct queda fuera ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_arrivals numeric := 0; s_departures numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.bucket::text; s_arrivals := s_arrivals + r.arrivals; s_departures := s_departures + r.departures; end loop;
  if not (n = 3 and s_arrivals = 3 and s_departures = 2 and b = '2026-09-28,2026-09-29,2026-09-30') then raise exception '%', 'esperaba filas=3, buckets=2026-09-28,2026-09-29,2026-09-30, arrivals=3, departures=2; obtuve '||format('filas=%s, buckets=%s, arrivals=%s, departures=%s', n, b, s_arrivals, s_departures); end if;
end $do$;
rollback;
\echo '--- 18. mismo periodo por mes: UN bucket con 3 llegadas y 2 salidas (sin doble conteo entre llegada y salida) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_arrivals numeric := 0; s_departures numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'month'::text, 51::int loop n := n + 1; s_arrivals := s_arrivals + r.arrivals; s_departures := s_departures + r.departures; end loop;
  if not (n = 1 and s_arrivals = 3 and s_departures = 2) then raise exception '%', 'esperaba filas=1, arrivals=3, departures=2; obtuve '||format('filas=%s, buckets=%s, arrivals=%s, departures=%s', n, b, s_arrivals, s_departures); end if;
end $do$;
rollback;
\echo '--- 19. solo 29 sep: 2 llegadas y 0 salidas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_arrivals numeric := 0; s_departures numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, '2026-09-29'::date, 'day'::text, 51::int loop n := n + 1; s_arrivals := s_arrivals + r.arrivals; s_departures := s_departures + r.departures; end loop;
  if not (n = 1 and s_arrivals = 2 and s_departures = 0) then raise exception '%', 'esperaba filas=1, arrivals=2, departures=0; obtuve '||format('filas=%s, buckets=%s, arrivals=%s, departures=%s', n, b, s_arrivals, s_departures); end if;
end $do$;
rollback;
\echo '--- 20. periodo FUTURO (1 a 3 oct): la salida del 1-oct si aparece ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_arrivals numeric := 0; s_departures numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-10-01'::date, '2026-10-03'::date, 'day'::text, 51::int loop n := n + 1; s_arrivals := s_arrivals + r.arrivals; s_departures := s_departures + r.departures; end loop;
  if not (n = 1 and s_arrivals = 0 and s_departures = 1) then raise exception '%', 'esperaba filas=1, arrivals=0, departures=1; obtuve '||format('filas=%s, buckets=%s, arrivals=%s, departures=%s', n, b, s_arrivals, s_departures); end if;
end $do$;
rollback;
\echo '--- 21. gm de Centro con null: solo Centro (2 llegadas: 28 y 29; 1 salida el 30 y la del 1-oct fuera) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_arrivals numeric := 0; s_departures numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_arrivals := s_arrivals + r.arrivals; s_departures := s_departures + r.departures; end loop;
  if not (n = 3 and s_arrivals = 2 and s_departures = 1) then raise exception '%', 'esperaba filas=3, arrivals=2, departures=1; obtuve '||format('filas=%s, buckets=%s, arrivals=%s, departures=%s', n, b, s_arrivals, s_departures); end if;
end $do$;
rollback;
\echo '--- 22. cross-tenant: owner B pidiendo la organizacion A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_arrivals numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop n := n + 1; s_arrivals := s_arrivals + r.arrivals; end loop;
  if not (n = 0 and s_arrivals = 0) then raise exception '%', 'esperaba filas=0, arrivals=0; obtuve '||format('filas=%s, buckets=%s, arrivals=%s', n, b, s_arrivals); end if;
end $do$;
rollback;
\echo '--- 23. anon no puede leer reservas ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select to_char(date_trunc($5::text, d.day::timestamp)::date, 'YYYY-MM-DD') as bucket,
    count(*) filter (where d.kind = 'llegada') as arrivals,
    count(*) filter (where d.kind = 'salida') as departures
  from (
    select r.check_in_date as day, 'llegada' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_in_date between $3::date and $4::date
    union all
    select r.check_out_date as day, 'salida' as kind
    from hoteles.reservation r
    join core.property p on p.id = r.property_id
    where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
      and r.status in ('confirmada', 'check_in', 'en_estancia', 'check_out', 'cerrada')
      and r.check_out_date between $3::date and $4::date
  ) d
  group by 1 order by 1 limit $6$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 'day'::text, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== D) cancelaciones ==='
\echo ''
\echo '--- 24. owner A, dia 29-sep de Merida: 1 cancelacion (la de las 20:30 locales = 02:30Z del 30), $1,500 y $300 de penalizacion, en el bucket 2026-09-29 (NO el 30) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_cancelled numeric := 0; s_booked_value numeric := 0; s_penalties numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29T06:00:00Z'::timestamptz, '2026-09-30T06:00:00Z'::timestamptz, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.bucket::text; s_cancelled := s_cancelled + r.cancelled; s_booked_value := s_booked_value + r.booked_value; s_penalties := s_penalties + r.penalties; end loop;
  if not (n = 1 and s_cancelled = 1 and s_booked_value = 1500 and s_penalties = 300 and b = '2026-09-29') then raise exception '%', 'esperaba filas=1, buckets=2026-09-29, cancelled=1, booked_value=1500, penalties=300; obtuve '||format('filas=%s, buckets=%s, cancelled=%s, booked_value=%s, penalties=%s', n, b, s_cancelled, s_booked_value, s_penalties); end if;
end $do$;
rollback;
\echo '--- 25. 28 a 30 sep: 2 cancelaciones (28: Playa $700; 29: Centro $1,500); las de la organizacion B no aparecen ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_cancelled numeric := 0; s_booked_value numeric := 0; s_penalties numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-01T06:00:00Z'::timestamptz, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.bucket::text; s_cancelled := s_cancelled + r.cancelled; s_booked_value := s_booked_value + r.booked_value; s_penalties := s_penalties + r.penalties; end loop;
  if not (n = 2 and s_cancelled = 2 and s_booked_value = 2200 and s_penalties = 300 and b = '2026-09-28,2026-09-29') then raise exception '%', 'esperaba filas=2, buckets=2026-09-28,2026-09-29, cancelled=2, booked_value=2200, penalties=300; obtuve '||format('filas=%s, buckets=%s, cancelled=%s, booked_value=%s, penalties=%s', n, b, s_cancelled, s_booked_value, s_penalties); end if;
end $do$;
rollback;
\echo '--- 26. gm de Centro con null: solo la de Centro ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_cancelled numeric := 0; s_booked_value numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-01T06:00:00Z'::timestamptz, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; s_cancelled := s_cancelled + r.cancelled; s_booked_value := s_booked_value + r.booked_value; end loop;
  if not (n = 1 and s_cancelled = 1 and s_booked_value = 1500) then raise exception '%', 'esperaba filas=1, cancelled=1, booked_value=1500; obtuve '||format('filas=%s, buckets=%s, cancelled=%s, booked_value=%s', n, b, s_cancelled, s_booked_value); end if;
end $do$;
rollback;
\echo '--- 27. cross-tenant: owner B ve solo las suyas ($7,777) y nada de A ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_cancelled numeric := 0; s_booked_value numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d102'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-01T06:00:00Z'::timestamptz, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; s_cancelled := s_cancelled + r.cancelled; s_booked_value := s_booked_value + r.booked_value; end loop;
  if not (n = 1 and s_cancelled = 1 and s_booked_value = 7777) then raise exception '%', 'esperaba filas=1, cancelled=1, booked_value=7777; obtuve '||format('filas=%s, buckets=%s, cancelled=%s, booked_value=%s', n, b, s_cancelled, s_booked_value); end if;
end $do$;
rollback;
\echo '--- 28. cross-tenant (otro sentido): owner B pidiendo la organizacion A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_cancelled numeric := 0;
begin
  for r in execute $q$select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-01T06:00:00Z'::timestamptz, 'day'::text, 'America/Merida'::text, 51::int loop n := n + 1; s_cancelled := s_cancelled + r.cancelled; end loop;
  if not (n = 0 and s_cancelled = 0) then raise exception '%', 'esperaba filas=0, cancelled=0; obtuve '||format('filas=%s, buckets=%s, cancelled=%s', n, b, s_cancelled); end if;
end $do$;
rollback;
\echo '--- 29. anon no puede leer reservas ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-01T06:00:00Z'::timestamptz, 'day'::text, 'America/Merida'::text, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== E) tickets abiertos por SLA ==='
\echo ''
\echo '--- 30. owner A (ahora = 30-sep 12:00Z): 4 abiertos (los 2 de recepcion alta, housekeeping y fnb; el cerrado NO), 2 con SLA vencido, 1 vence en 2 h, 1 escalado ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_open_tickets numeric := 0; s_overdue numeric := 0; s_due_soon numeric := 0; s_escalated numeric := 0;
begin
  for r in execute $q$select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_open_tickets := s_open_tickets + r.open_tickets; s_overdue := s_overdue + r.overdue; s_due_soon := s_due_soon + r.due_soon; s_escalated := s_escalated + r.escalated; end loop;
  if not (n = 3 and s_open_tickets = 4 and s_overdue = 2 and s_due_soon = 1 and s_escalated = 1) then raise exception '%', 'esperaba filas=3, open_tickets=4, overdue=2, due_soon=1, escalated=1; obtuve '||format('filas=%s, buckets=%s, open_tickets=%s, overdue=%s, due_soon=%s, escalated=%s', n, b, s_open_tickets, s_overdue, s_due_soon, s_escalated); end if;
end $do$;
rollback;
\echo '--- 31. gm de Centro con null: 3 abiertos (el de Playa queda fuera) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_open_tickets numeric := 0; s_overdue numeric := 0;
begin
  for r in execute $q$select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_open_tickets := s_open_tickets + r.open_tickets; s_overdue := s_overdue + r.overdue; end loop;
  if not (n = 2 and s_open_tickets = 3 and s_overdue = 2) then raise exception '%', 'esperaba filas=2, open_tickets=3, overdue=2; obtuve '||format('filas=%s, buckets=%s, open_tickets=%s, overdue=%s', n, b, s_open_tickets, s_overdue); end if;
end $do$;
rollback;
\echo '--- 32. housekeeping: la RLS por departamento solo le deja los tickets de housekeeping (1 abierto) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000144', true);
do $do$
declare r record; n int := 0; b text := ''; s_open_tickets numeric := 0; s_overdue numeric := 0; s_due_soon numeric := 0;
begin
  for r in execute $q$select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_open_tickets := s_open_tickets + r.open_tickets; s_overdue := s_overdue + r.overdue; s_due_soon := s_due_soon + r.due_soon; end loop;
  if not (n = 1 and s_open_tickets = 1 and s_overdue = 0 and s_due_soon = 1) then raise exception '%', 'esperaba filas=1, open_tickets=1, overdue=0, due_soon=1; obtuve '||format('filas=%s, buckets=%s, open_tickets=%s, overdue=%s, due_soon=%s', n, b, s_open_tickets, s_overdue, s_due_soon); end if;
end $do$;
rollback;
\echo '--- 33. cross-tenant: owner B pidiendo la organizacion A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_open_tickets numeric := 0;
begin
  for r in execute $q$select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_open_tickets := s_open_tickets + r.open_tickets; end loop;
  if not (n = 0 and s_open_tickets = 0) then raise exception '%', 'esperaba filas=0, open_tickets=0; obtuve '||format('filas=%s, buckets=%s, open_tickets=%s', n, b, s_open_tickets); end if;
end $do$;
rollback;
\echo '--- 34. positivo de B: owner B ve su unico ticket ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_open_tickets numeric := 0;
begin
  for r in execute $q$select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4$q$ using '00000000-0000-0000-0000-00000000d102'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_open_tickets := s_open_tickets + r.open_tickets; end loop;
  if not (n = 1 and s_open_tickets = 1) then raise exception '%', 'esperaba filas=1, open_tickets=1; obtuve '||format('filas=%s, buckets=%s, open_tickets=%s', n, b, s_open_tickets); end if;
end $do$;
rollback;
\echo '--- 35. anon no puede leer tickets ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== F) housekeeping pendiente ==='
\echo ''
\echo '--- 36. owner A, hoy = 29-sep: 3 tipos; pendientes 3 (2 de salida y 1 profunda de Playa), 1 en progreso, 1 de rezago (27-sep), 1 de prioridad alta; la terminada y la de manana NO cuentan ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := ''; s_pending numeric := 0; s_in_progress numeric := 0; s_backlog numeric := 0; s_high_priority numeric := 0;
begin
  for r in execute $q$select t.task_type,
    count(*) filter (where t.status = 'pendiente') as pending,
    count(*) filter (where t.status = 'en_progreso') as in_progress,
    count(*) filter (where t.work_date < $3::date) as backlog,
    count(*) filter (where t.priority = 'alta') as high_priority
  from hoteles.housekeeping_task t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('pendiente', 'en_progreso') and t.work_date <= $3::date
  group by t.task_type order by t.task_type limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int loop n := n + 1; s_pending := s_pending + r.pending; s_in_progress := s_in_progress + r.in_progress; s_backlog := s_backlog + r.backlog; s_high_priority := s_high_priority + r.high_priority; end loop;
  if not (n = 3 and s_pending = 3 and s_in_progress = 1 and s_backlog = 1 and s_high_priority = 1) then raise exception '%', 'esperaba filas=3, pending=3, in_progress=1, backlog=1, high_priority=1; obtuve '||format('filas=%s, buckets=%s, pending=%s, in_progress=%s, backlog=%s, high_priority=%s', n, b, s_pending, s_in_progress, s_backlog, s_high_priority); end if;
end $do$;
rollback;
\echo '--- 37. gm de Centro con null: sin la tarea de Playa (2 tipos, 2 pendientes) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := ''; s_pending numeric := 0; s_in_progress numeric := 0;
begin
  for r in execute $q$select t.task_type,
    count(*) filter (where t.status = 'pendiente') as pending,
    count(*) filter (where t.status = 'en_progreso') as in_progress,
    count(*) filter (where t.work_date < $3::date) as backlog,
    count(*) filter (where t.priority = 'alta') as high_priority
  from hoteles.housekeeping_task t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('pendiente', 'en_progreso') and t.work_date <= $3::date
  group by t.task_type order by t.task_type limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int loop n := n + 1; s_pending := s_pending + r.pending; s_in_progress := s_in_progress + r.in_progress; end loop;
  if not (n = 2 and s_pending = 2 and s_in_progress = 1) then raise exception '%', 'esperaba filas=2, pending=2, in_progress=1; obtuve '||format('filas=%s, buckets=%s, pending=%s, in_progress=%s', n, b, s_pending, s_in_progress); end if;
end $do$;
rollback;
\echo '--- 38. cross-tenant: owner B pidiendo la organizacion A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_pending numeric := 0;
begin
  for r in execute $q$select t.task_type,
    count(*) filter (where t.status = 'pendiente') as pending,
    count(*) filter (where t.status = 'en_progreso') as in_progress,
    count(*) filter (where t.work_date < $3::date) as backlog,
    count(*) filter (where t.priority = 'alta') as high_priority
  from hoteles.housekeeping_task t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('pendiente', 'en_progreso') and t.work_date <= $3::date
  group by t.task_type order by t.task_type limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int loop n := n + 1; s_pending := s_pending + r.pending; end loop;
  if not (n = 0 and s_pending = 0) then raise exception '%', 'esperaba filas=0, pending=0; obtuve '||format('filas=%s, buckets=%s, pending=%s', n, b, s_pending); end if;
end $do$;
rollback;
\echo '--- 39. positivo de B: 1 tarea pendiente de prioridad alta ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := ''; s_pending numeric := 0; s_high_priority numeric := 0;
begin
  for r in execute $q$select t.task_type,
    count(*) filter (where t.status = 'pendiente') as pending,
    count(*) filter (where t.status = 'en_progreso') as in_progress,
    count(*) filter (where t.work_date < $3::date) as backlog,
    count(*) filter (where t.priority = 'alta') as high_priority
  from hoteles.housekeeping_task t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('pendiente', 'en_progreso') and t.work_date <= $3::date
  group by t.task_type order by t.task_type limit $4$q$ using '00000000-0000-0000-0000-00000000d102'::uuid, null::uuid[], '2026-09-29'::date, 51::int loop n := n + 1; s_pending := s_pending + r.pending; s_high_priority := s_high_priority + r.high_priority; end loop;
  if not (n = 1 and s_pending = 1 and s_high_priority = 1) then raise exception '%', 'esperaba filas=1, pending=1, high_priority=1; obtuve '||format('filas=%s, buckets=%s, pending=%s, high_priority=%s', n, b, s_pending, s_high_priority); end if;
end $do$;
rollback;
\echo '--- 40. anon no puede leer housekeeping ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select t.task_type,
    count(*) filter (where t.status = 'pendiente') as pending,
    count(*) filter (where t.status = 'en_progreso') as in_progress,
    count(*) filter (where t.work_date < $3::date) as backlog,
    count(*) filter (where t.priority = 'alta') as high_priority
  from hoteles.housekeeping_task t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('pendiente', 'en_progreso') and t.work_date <= $3::date
  group by t.task_type order by t.task_type limit $4$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== G) hoteles visibles (resolucion de nombre de hotel) ==='
\echo ''
\echo '--- 41. owner A ve 2 hoteles activos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
do $do$
declare r record; n int := 0; b text := '';
begin
  for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'hoteles' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[] loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.name::text; end loop;
  if not (n = 2 and b = 'Hotel Centro,Hotel Playa') then raise exception '%', 'esperaba filas=2, buckets=Hotel Centro,Hotel Playa; obtuve '||format('filas=%s, buckets=%s', n, b); end if;
end $do$;
rollback;
\echo '--- 42. gm de Centro con null: solo Hotel Centro (RLS de core.property) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000142', true);
do $do$
declare r record; n int := 0; b text := '';
begin
  for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'hoteles' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[] loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.name::text; end loop;
  if not (n = 1 and b = 'Hotel Centro') then raise exception '%', 'esperaba filas=1, buckets=Hotel Centro; obtuve '||format('filas=%s, buckets=%s', n, b); end if;
end $do$;
rollback;
\echo '--- 43. cross-tenant: owner B pidiendo la organizacion A: 0 hoteles (nunca confirma que existan) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000143', true);
do $do$
declare r record; n int := 0; b text := '';
begin
  for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'hoteles' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[] loop n := n + 1; end loop;
  if not (n = 0) then raise exception '%', 'esperaba filas=0; obtuve '||format('filas=%s, buckets=%s', n, b); end if;
end $do$;
rollback;
\echo '--- 44. anon no ve hoteles ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'hoteles' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[] loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== H) base SIN migrar (REGLA DURA): SQLSTATE real + SAVEPOINT, mismo mecanismo que runWithSavepointFallback ==='
\echo ''
\echo '--- 45. tickets con hoteles.guest_ticket ELIMINADA (migracion 034 pendiente): 42P01 y la transaccion se recupera (nunca 25P02) ---'
begin;
drop table hoteles.guest_ticket cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
savepoint sp_verify_hot_tickets;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select t.department, t.priority, count(*) as open_tickets,
    count(*) filter (where t.sla_due_at < $3) as overdue,
    count(*) filter (where t.sla_due_at >= $3 and t.sla_due_at < $3 + interval '2 hours') as due_soon,
    count(*) filter (where t.status = 'escalado') as escalated
  from hoteles.guest_ticket t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('abierto', 'en_progreso', 'escalado')
  group by t.department, t.priority
  order by overdue desc, open_tickets desc, t.department, t.priority limit $4) q$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_hot_tickets;
release savepoint sp_verify_hot_tickets;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 46. housekeeping con hoteles.housekeeping_task ELIMINADA (migracion 033 pendiente): 42P01 ---'
begin;
drop table hoteles.housekeeping_task cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
savepoint sp_verify_hot_hk;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select t.task_type,
    count(*) filter (where t.status = 'pendiente') as pending,
    count(*) filter (where t.status = 'en_progreso') as in_progress,
    count(*) filter (where t.work_date < $3::date) as backlog,
    count(*) filter (where t.priority = 'alta') as high_priority
  from hoteles.housekeeping_task t
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.status in ('pendiente', 'en_progreso') and t.work_date <= $3::date
  group by t.task_type order by t.task_type limit $4) q$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-29'::date, 51::int;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_hot_hk;
release savepoint sp_verify_hot_hk;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 47. cancelaciones con hoteles.reservation.canceled_at ELIMINADA (migracion 005 pendiente): 42703 ---'
begin;
alter table hoteles.reservation drop column canceled_at cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000141', true);
savepoint sp_verify_hot_canc;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select to_char(date_trunc($5::text, (r.canceled_at at time zone $6::text))::date, 'YYYY-MM-DD') as bucket,
    count(*) as cancelled, coalesce(sum(r.total_amount), 0) as booked_value,
    coalesce(sum(r.cancellation_penalty_amount), 0) as penalties
  from hoteles.reservation r
  join core.property p on p.id = r.property_id
  where r.organization_id = $1
    and ($2::uuid[] is null or r.property_id = any($2::uuid[]))
    and r.status = 'cancelada' and r.canceled_at >= $3 and r.canceled_at < $4
  group by 1 order by 1 limit $7) q$q$ using '00000000-0000-0000-0000-00000000d101'::uuid, null::uuid[], '2026-09-28T06:00:00Z'::timestamptz, '2026-10-01T06:00:00Z'::timestamptz, 'day'::text, 'America/Merida'::text, 51::int;
    raise exception 'se esperaba SQLSTATE 42703 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42703' then raise exception 'se esperaba 42703, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_hot_canc;
release savepoint sp_verify_hot_canc;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo ''
\echo '==> los escenarios marcados should_fail deben terminar en ERROR; los deberia_ser_N en N; los bloques DO sin error = OK (una discrepancia lanza excepcion).'
