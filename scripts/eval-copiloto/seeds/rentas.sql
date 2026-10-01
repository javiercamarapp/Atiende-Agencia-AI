-- SEMILLA del arnes de evaluacion del Copiloto (scripts/eval-copiloto). Rentas vacacionales: gestora A y B (ajena). Unidades, propietarios, ocupaciones, financiero por reserva, tareas, liquidaciones y pagos de canal.
-- Es una COPIA CONGELADA del bloque de fixtures del verify de data-chat de esa vertical (datos ficticios, sin PII real):
-- las respuestas esperadas de los casos se calculan contra ESTOS datos y se congelan en datos/*.congelado.json.
-- No editar sin volver a congelar (npm run eval:copiloto:congelar).
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000d201', 'rentas', 'Gestora A (data chat)', 'gestora-a-data-chat'),
  ('00000000-0000-0000-0000-00000000d202', 'rentas', 'Gestora B (data chat, ajena)', 'gestora-b-data-chat')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-000000000241', 'gestora-a-rentchat@example.com', 'Admin gestora A', 'seed'),
  ('00000000-0000-0000-0000-000000000242', 'operador-a-rentchat@example.com', 'Operador A (sin finanzas)', 'seed'),
  ('00000000-0000-0000-0000-000000000243', 'contador-a-rentchat@example.com', 'Contador A', 'seed'),
  ('00000000-0000-0000-0000-000000000244', 'gestora-centro-rentchat@example.com', 'Admin solo Centro', 'seed'),
  ('00000000-0000-0000-0000-000000000245', 'gestora-b-rentchat@example.com', 'Admin gestora B (ajena)', 'seed')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-00000000d201', 'rentas', 'Casas de Playa'),
  ('00000000-0000-0000-0000-00000000a202', '00000000-0000-0000-0000-00000000d201', 'rentas', 'Edificio Centro'),
  ('00000000-0000-0000-0000-00000000a203', '00000000-0000-0000-0000-00000000d202', 'rentas', 'Propiedad B Ajena')
on conflict do nothing;

-- admin A, operador A y contador A: todas las propiedades de A. admin-centro: SOLO Edificio Centro. admin B: org ajena.
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-000000000241', '00000000-0000-0000-0000-00000000d201', null, 'owner', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000242', '00000000-0000-0000-0000-00000000d201', null, 'member', 'operador:acceso_total'),
  ('00000000-0000-0000-0000-000000000243', '00000000-0000-0000-0000-00000000d201', null, 'member', 'contador'),
  ('00000000-0000-0000-0000-000000000244', '00000000-0000-0000-0000-00000000d201', array['00000000-0000-0000-0000-00000000a202']::uuid[], 'admin', 'admin_gestora'),
  ('00000000-0000-0000-0000-000000000245', '00000000-0000-0000-0000-00000000d202', null, 'owner', 'admin_gestora')
on conflict do nothing;

insert into rentas.owner (id, name, email) values
  ('00000000-0000-0000-0000-0000000f1001', 'Propietario Uno', 'uno@example.com'),
  ('00000000-0000-0000-0000-0000000f1002', 'Propietario Dos', 'dos@example.com'),
  ('00000000-0000-0000-0000-0000000f1003', 'Propietario B Ajeno', 'b@example.com')
on conflict do nothing;
insert into rentas.owner_organization (owner_id, organization_id) values
  ('00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000d201'),
  ('00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-00000000d201'),
  ('00000000-0000-0000-0000-0000000f1003', '00000000-0000-0000-0000-00000000d202')
on conflict do nothing;

-- Unidades: Playa1 (Uno) y Playa2 (Dos) en Casas de Playa; Centro1 (Uno) y Centro2 (sin propietario) en Edificio Centro; B1 (ajena).
insert into rentas.unidad (id, organization_id, property_id, owner_id, name) values
  ('00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-0000000f1001', 'Playa 1'),
  ('00000000-0000-0000-0000-0000000e2002', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-0000000f1002', 'Playa 2'),
  ('00000000-0000-0000-0000-0000000e2003', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000a202', '00000000-0000-0000-0000-0000000f1001', 'Centro 1'),
  ('00000000-0000-0000-0000-0000000e2004', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000a202', null, 'Centro 2'),
  ('00000000-0000-0000-0000-0000000e2005', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-00000000a203', '00000000-0000-0000-0000-0000000f1003', 'B 1')
on conflict do nothing;

-- Ocupaciones (calendario) de septiembre-2026. Rangos semiabiertos [llegada, salida).
--   Playa 1: R1 5->10 sep (5 noches, Airbnb) · R2 20->23 (3, Booking) · cancelada 12->14 · provisional 15->17 (ninguna cuenta)
--            bloqueo de propietario 8->12 (se TRASLAPA con R1 el 8 y 9: esas 2 noches cuentan reservadas, NO bloqueadas) ·
--            buffer de limpieza 10->11 (no es bloqueo de disponibilidad)
--   Playa 2: R3 1->4 (3, Airbnb) · R5 10->12 (2, Airbnb, en USD) · en conflicto 25->27 (no cuenta)
--   Centro 1: R4 28 sep->3 oct (5 noches, 3 dentro de septiembre; directa)
--   Centro 2: R7 15->17 (2, directa, sin propietario) · bloqueo de mantenimiento 10->13 (3 noches)
--   B 1 (otro tenant): 5->10 sep
insert into rentas.ocupacion (id, organization_id, property_id, unidad_id, rango, capa, razon, canal_origen_id, estado)
select v.id::uuid, u.organization_id, u.property_id, u.id, daterange(v.d1::date, v.d2::date, '[)'), v.capa, v.razon,
  (select c.id from rentas.canal c where c.codigo = v.canal), v.estado
from (values
  ('00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000e2001', '2026-09-05', '2026-09-10', 'reserva', 'RESERVA_CANAL', 'airbnb', 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0002', '00000000-0000-0000-0000-0000000e2001', '2026-09-20', '2026-09-23', 'reserva', 'RESERVA_CANAL', 'booking', 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0006', '00000000-0000-0000-0000-0000000e2001', '2026-09-12', '2026-09-14', 'reserva', 'RESERVA_CANAL', 'airbnb', 'cancelado'),
  ('00000000-0000-0000-0000-0000000d0008', '00000000-0000-0000-0000-0000000e2001', '2026-09-15', '2026-09-17', 'reserva', 'RESERVA_CANAL', 'airbnb', 'provisional'),
  ('00000000-0000-0000-0000-0000000d0009', '00000000-0000-0000-0000-0000000e2001', '2026-09-08', '2026-09-12', 'bloqueo', 'BLOQUEO_PROPIETARIO', null, 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0010', '00000000-0000-0000-0000-0000000e2001', '2026-09-10', '2026-09-11', 'bloqueo', 'BUFFER_LIMPIEZA', null, 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0003', '00000000-0000-0000-0000-0000000e2002', '2026-09-01', '2026-09-04', 'reserva', 'RESERVA_CANAL', 'airbnb', 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0005', '00000000-0000-0000-0000-0000000e2002', '2026-09-10', '2026-09-12', 'reserva', 'RESERVA_CANAL', 'airbnb', 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0011', '00000000-0000-0000-0000-0000000e2002', '2026-09-25', '2026-09-27', 'reserva', 'RESERVA_CANAL', 'vrbo', 'conflicto_pendiente'),
  ('00000000-0000-0000-0000-0000000d0004', '00000000-0000-0000-0000-0000000e2003', '2026-09-28', '2026-10-03', 'reserva', 'RESERVA_CANAL', 'manual', 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0007', '00000000-0000-0000-0000-0000000e2004', '2026-09-15', '2026-09-17', 'reserva', 'RESERVA_CANAL', 'manual', 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0012', '00000000-0000-0000-0000-0000000e2004', '2026-09-10', '2026-09-13', 'bloqueo', 'MANTENIMIENTO', null, 'confirmado'),
  ('00000000-0000-0000-0000-0000000d0013', '00000000-0000-0000-0000-0000000e2005', '2026-09-05', '2026-09-10', 'reserva', 'RESERVA_CANAL', 'airbnb', 'confirmado')
) v(id, unidad_id, d1, d2, capa, razon, canal, estado)
join rentas.unidad u on u.id = v.unidad_id::uuid;

-- Desglose financiero (centavos). Solo las reservas confirmadas deben contar; R5 esta en USD; la cancelada tiene fila financiera (no cuenta).
insert into rentas.reserva_financiero (organization_id, property_id, ocupacion_id, moneda, monto_bruto_centavos, comision_canal_centavos, comision_gestor_centavos, monto_recibido_centavos, neto_centavos)
select o.organization_id, o.property_id, o.id, v.moneda, v.bruto, v.canal, v.gestor, v.bruto - v.canal, v.neto
from (values
  ('00000000-0000-0000-0000-0000000d0001', 'MXN', 100000, 15000, 10000, 70000),
  ('00000000-0000-0000-0000-0000000d0002', 'MXN', 60000, 9000, 6000, 40000),
  ('00000000-0000-0000-0000-0000000d0003', 'MXN', 30000, 4500, 3000, 20000),
  ('00000000-0000-0000-0000-0000000d0005', 'USD', 10000, 1500, 1000, 7000),
  ('00000000-0000-0000-0000-0000000d0004', 'MXN', 50000, 0, 5000, 40000),
  ('00000000-0000-0000-0000-0000000d0007', 'MXN', 10000, 0, 1000, 8000),
  ('00000000-0000-0000-0000-0000000d0006', 'MXN', 99999, 0, 0, 99999),
  ('00000000-0000-0000-0000-0000000d0013', 'MXN', 500000, 0, 0, 500000)
) v(id, moneda, bruto, canal, gestor, neto)
join rentas.ocupacion o on o.id = v.id::uuid;

-- Conflictos: CC1 abierto en Playa 1 (20-sep) · CC2 abierto en Centro 1 (28-sep) · CC3 RESUELTO · CC4 de otra organizacion.
insert into rentas.conflicto_calendario (id, organization_id, property_id, unidad_id, ocupacion_a_id, ocupacion_b_id, tipo, detectado_en, resuelto_en) values
  ('00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-0000000e2001', '00000000-0000-0000-0000-0000000d0001', '00000000-0000-0000-0000-0000000d0009', 'capa_cruzada', '2026-09-20T12:00:00Z', null),
  ('00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000a202', '00000000-0000-0000-0000-0000000e2003', '00000000-0000-0000-0000-0000000d0004', null, 'overbooking_confirmado', '2026-09-28T12:00:00Z', null),
  ('00000000-0000-0000-0000-0000000c0003', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-00000000a201', '00000000-0000-0000-0000-0000000e2002', '00000000-0000-0000-0000-0000000d0003', null, 'capa_cruzada', '2026-09-02T12:00:00Z', '2026-09-03T12:00:00Z'),
  ('00000000-0000-0000-0000-0000000c0004', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-00000000a203', '00000000-0000-0000-0000-0000000e2005', '00000000-0000-0000-0000-0000000d0013', null, 'overbooking_confirmado', '2026-09-29T12:00:00Z', null)
on conflict do nothing;

-- Tareas operativas ("ahora" de los escenarios = 2026-09-30T12:00:00Z; "hoy" = 2026-09-30).
insert into rentas.tarea_operativa (organization_id, property_id, unidad_id, tipo, estado, prioridad, programada_para, sla_vence_en, completada_en)
select u.organization_id, u.property_id, u.id, v.tipo, v.estado, v.prioridad, v.d::date, v.sla::timestamptz, v.done::timestamptz
from (values
  ('00000000-0000-0000-0000-0000000e2001', 'limpieza', 'pendiente', 'alta', '2026-09-30', '2026-09-30T10:00:00Z', null),
  ('00000000-0000-0000-0000-0000000e2002', 'limpieza', 'asignada', 'media', '2026-09-29', null, null),
  ('00000000-0000-0000-0000-0000000e2003', 'limpieza', 'en_progreso', 'urgente', '2026-09-30', '2026-09-30T18:00:00Z', null),
  ('00000000-0000-0000-0000-0000000e2004', 'limpieza', 'completada', 'media', '2026-09-30', null, '2026-09-30T09:00:00Z'),
  ('00000000-0000-0000-0000-0000000e2001', 'mantenimiento', 'pendiente', 'baja', '2026-10-02', null, null),
  ('00000000-0000-0000-0000-0000000e2003', 'limpieza', 'cancelada', 'media', '2026-09-29', null, null),
  ('00000000-0000-0000-0000-0000000e2005', 'limpieza', 'pendiente', 'alta', '2026-09-30', null, null)
) v(unidad_id, tipo, estado, prioridad, d, sla, done)
join rentas.unidad u on u.id = v.unidad_id::uuid;

-- Liquidaciones a propietarios: OS1 tiene DOS versiones (la v2 corrige a la v1: solo debe contar la ultima).
insert into rentas.owner_statement (id, organization_id, owner_id, property_id, periodo_inicio, periodo_fin, version, moneda, ingresos_brutos_centavos, comision_canal_centavos, comision_gestor_centavos, gastos_centavos, impuestos_centavos, neto_centavos, hash_contenido, motivo_version, generado_en) values
  ('00000000-0000-0000-0000-0000000b0001', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000a201', '2026-09-01', '2026-09-30', 1, 'MXN', 100000, 15000, 10000, 0, 5000, 70000, 'h1', null, '2026-10-01T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b0002', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000a201', '2026-09-01', '2026-09-30', 2, 'MXN', 110000, 15000, 10000, 0, 5000, 80000, 'h2', 'correccion de comision', '2026-10-02T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b0003', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1002', '00000000-0000-0000-0000-00000000a201', '2026-08-01', '2026-08-31', 1, 'MXN', 50000, 7000, 5000, 0, 3000, 30000, 'h3', null, '2026-09-02T10:00:00Z'),
  ('00000000-0000-0000-0000-0000000b0004', '00000000-0000-0000-0000-00000000d201', '00000000-0000-0000-0000-0000000f1001', '00000000-0000-0000-0000-00000000a202', '2026-09-01', '2026-09-30', 1, 'USD', 5000, 0, 500, 0, 0, 4500, 'h4', null, '2026-10-01T11:00:00Z'),
  ('00000000-0000-0000-0000-0000000b0005', '00000000-0000-0000-0000-00000000d202', '00000000-0000-0000-0000-0000000f1003', '00000000-0000-0000-0000-00000000a203', '2026-09-01', '2026-09-30', 1, 'MXN', 999000, 0, 0, 0, 0, 999000, 'h5', null, '2026-10-01T12:00:00Z');

-- Pagos de canal y sus lineas (PO1 tiene 3 lineas: unir pago x lineas triplicaria su monto).
insert into rentas.payout_canal (id, organization_id, property_id, canal_id, moneda, monto_total_centavos, fecha_payout)
select v.id::uuid, p.organization_id, p.id, (select c.id from rentas.canal c where c.codigo = v.canal), v.moneda, v.monto, v.d::date
from (values
  ('00000000-0000-0000-0000-0000000a0001', '00000000-0000-0000-0000-00000000a201', 'airbnb', 'MXN', 200000, '2026-09-15'),
  ('00000000-0000-0000-0000-0000000a0002', '00000000-0000-0000-0000-00000000a201', 'airbnb', 'MXN', 50000, '2026-09-28'),
  ('00000000-0000-0000-0000-0000000a0003', '00000000-0000-0000-0000-00000000a202', 'booking', 'MXN', 80000, '2026-09-20'),
  ('00000000-0000-0000-0000-0000000a0004', '00000000-0000-0000-0000-00000000a201', 'vrbo', 'USD', 100000, '2026-09-21'),
  ('00000000-0000-0000-0000-0000000a0005', '00000000-0000-0000-0000-00000000a201', 'airbnb', 'MXN', 70000, '2026-08-30'),
  ('00000000-0000-0000-0000-0000000a0006', '00000000-0000-0000-0000-00000000a203', 'airbnb', 'MXN', 900000, '2026-09-16')
) v(id, prop, canal, moneda, monto, d)
join core.property p on p.id = v.prop::uuid;
insert into rentas.payout_linea (payout_id, monto_centavos, estado_conciliacion) values
  ('00000000-0000-0000-0000-0000000a0001', 100000, 'conciliado'),
  ('00000000-0000-0000-0000-0000000a0001', 60000, 'pendiente'),
  ('00000000-0000-0000-0000-0000000a0001', 40000, 'discrepancia'),
  ('00000000-0000-0000-0000-0000000a0002', 30000, 'pendiente'),
  ('00000000-0000-0000-0000-0000000a0002', 20000, 'pendiente'),
  ('00000000-0000-0000-0000-0000000a0006', 900000, 'pendiente');
