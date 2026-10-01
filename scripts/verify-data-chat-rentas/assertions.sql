-- Fixtures + assertions que verifican, contra Postgres REAL (RLS + GRANT reales, no el repositorio en
-- memoria), las consultas de SOLO LECTURA del catalogo de RENTAS VACACIONALES de "Chatea con tus datos"
-- (packages/domain-rentas/src/data-chat/sql.ts -- el texto se copia IDENTICO aqui y
-- packages/domain-rentas/tests/data-chat/sql-drift.spec.ts falla si divergen), ejecutadas como el rol
-- `authenticated` con auth.uid() real:
--   1. cross-tenant: un admin de la gestora B pidiendo la gestora A (y al reves) no ve ni una fila.
--   2. cross-propiedad: un admin con membership acotada a UNA propiedad solo ve esa -- incluso si la aplicacion
--      se equivocara y pasara `null` (todas) o el id de otra propiedad, la RLS (has_property_access,
--      can_read_finanzas) y el JOIN con core.property lo impiden: defensa en profundidad.
--   3. doble conteo: una reserva y un bloqueo de propietario que se traslapan cuentan la noche UNA vez; las
--      liquidaciones re-emitidas (v1 y v2) cuentan solo la ultima version; los pagos de canal con varias lineas no
--      repiten su monto; provisionales, canceladas y en conflicto no son noches reservadas.
--   4. moneda: solo se suma MXN; las reservas/pagos en otra moneda se cuentan aparte.
--   5. rol sin acceso a finanzas (operador): la RLS oculta todo lo financiero (la ruta ademas exige admin_gestora/contador).
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

\echo ''
\echo '=== A) propiedades visibles (resolucion de nombre de propiedad) ==='
\echo ''
\echo '--- 1. admin A ve sus 2 propiedades activas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := '';
begin
  for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'rentas' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[] loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.name::text; end loop;
  if not (n = 2 and b = 'Casas de Playa,Edificio Centro') then raise exception '%', 'esperaba filas=2, buckets=Casas de Playa,Edificio Centro; obtuve '||format('filas=%s, buckets=%s', n, b); end if;
end $do$;
rollback;
\echo '--- 2. admin de Centro con null: solo Edificio Centro (RLS de core.property) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := '';
begin
  for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'rentas' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[] loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.name::text; end loop;
  if not (n = 1 and b = 'Edificio Centro') then raise exception '%', 'esperaba filas=1, buckets=Edificio Centro; obtuve '||format('filas=%s, buckets=%s', n, b); end if;
end $do$;
rollback;
\echo '--- 3. cross-tenant: admin B pidiendo la gestora A: 0 propiedades (nunca confirma que existan) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := '';
begin
  for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'rentas' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[] loop n := n + 1; end loop;
  if not (n = 0) then raise exception '%', 'esperaba filas=0; obtuve '||format('filas=%s, buckets=%s', n, b); end if;
end $do$;
rollback;
\echo '--- 4. anon no ve propiedades ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select p.id as property_id, p.name, p.name as slug
   from core.property p
   where p.organization_id = $1 and p.vertical = 'rentas' and p.status = 'active'
     and ($2::uuid[] is null or p.id = any($2::uuid[]))
   order by p.name asc
   limit 100$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[] loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== B) ocupacion y noches por unidad ==='
\echo ''
\echo '--- 5. admin A, septiembre completo: 4 unidades; 18 noches reservadas (8+5+3+2: provisional, cancelada y en conflicto NO cuentan), 5 bloqueadas SIN reserva (2 de Playa 1 + 3 de Centro 2: el traslape reserva/bloqueo y el buffer de limpieza no cuentan doble) y 120 noches del periodo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_blocked_nights numeric := 0; s_period_nights numeric := 0; s_total_booked numeric := 0; s_total_blocked numeric := 0; s_total_period numeric := 0; s_total_units numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.unit_name::text; s_booked_nights := s_booked_nights + r.booked_nights; s_blocked_nights := s_blocked_nights + r.blocked_nights; s_period_nights := s_period_nights + r.period_nights; s_total_booked := s_total_booked + r.total_booked; s_total_blocked := s_total_blocked + r.total_blocked; s_total_period := s_total_period + r.total_period; s_total_units := s_total_units + r.total_units; end loop;
  if not (n = 4 and s_booked_nights = 18 and s_blocked_nights = 5 and s_period_nights = 120 and s_total_booked = 72 and s_total_blocked = 20 and s_total_period = 480 and s_total_units = 16 and b = 'Playa 1,Playa 2,Centro 1,Centro 2') then raise exception '%', 'esperaba filas=4, buckets=Playa 1,Playa 2,Centro 1,Centro 2, booked_nights=18, blocked_nights=5, period_nights=120, total_booked=72, total_blocked=20, total_period=480, total_units=16; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, blocked_nights=%s, period_nights=%s, total_booked=%s, total_blocked=%s, total_period=%s, total_units=%s', n, b, s_booked_nights, s_blocked_nights, s_period_nights, s_total_booked, s_total_blocked, s_total_period, s_total_units); end if;
end $do$;
rollback;
\echo '--- 6. con tope de 2 filas: solo 2 unidades, pero los totales siguen siendo los de las 4 (18 reservadas, 4 unidades) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_total_booked numeric := 0; s_total_units numeric := 0; s_total_period numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 2::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; s_total_booked := s_total_booked + r.total_booked; s_total_units := s_total_units + r.total_units; s_total_period := s_total_period + r.total_period; end loop;
  if not (n = 2 and s_booked_nights = 13 and s_total_booked = 36 and s_total_units = 8 and s_total_period = 240) then raise exception '%', 'esperaba filas=2, booked_nights=13, total_booked=36, total_units=8, total_period=240; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, total_booked=%s, total_units=%s, total_period=%s', n, b, s_booked_nights, s_total_booked, s_total_units, s_total_period); end if;
end $do$;
rollback;
\echo '--- 7. un solo dia traslapado (9-sep): Playa 1 esta reservada Y bloqueada por el propietario: cuenta 1 reservada y 0 bloqueadas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_blocked_nights numeric := 0; s_period_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-09'::date, '2026-09-09'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; s_blocked_nights := s_blocked_nights + r.blocked_nights; s_period_nights := s_period_nights + r.period_nights; end loop;
  if not (n = 4 and s_booked_nights = 1 and s_blocked_nights = 0 and s_period_nights = 4) then raise exception '%', 'esperaba filas=4, booked_nights=1, blocked_nights=0, period_nights=4; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, blocked_nights=%s, period_nights=%s', n, b, s_booked_nights, s_blocked_nights, s_period_nights); end if;
end $do$;
rollback;
\echo '--- 8. octubre (futuro ya reservado): la reserva de Centro 1 que llega el 28-sep ocupa 1 y 2 de octubre = 2 noches ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_blocked_nights numeric := 0; s_period_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-10-01'::date, '2026-10-31'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; s_blocked_nights := s_blocked_nights + r.blocked_nights; s_period_nights := s_period_nights + r.period_nights; end loop;
  if not (n = 4 and s_booked_nights = 2 and s_blocked_nights = 0 and s_period_nights = 124) then raise exception '%', 'esperaba filas=4, booked_nights=2, blocked_nights=0, period_nights=124; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, blocked_nights=%s, period_nights=%s', n, b, s_booked_nights, s_blocked_nights, s_period_nights); end if;
end $do$;
rollback;
\echo '--- 9. operador (sin finanzas) SI ve la ocupacion: es del calendario operativo ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000242', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_blocked_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; s_blocked_nights := s_blocked_nights + r.blocked_nights; end loop;
  if not (n = 4 and s_booked_nights = 18 and s_blocked_nights = 5) then raise exception '%', 'esperaba filas=4, booked_nights=18, blocked_nights=5; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, blocked_nights=%s', n, b, s_booked_nights, s_blocked_nights); end if;
end $do$;
rollback;
\echo '--- 10. admin de Centro con el id correcto: 2 unidades, 5 reservadas y 3 bloqueadas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_blocked_nights numeric := 0; s_period_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, array['00000000-0000-0000-0000-00000000a202']::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; s_blocked_nights := s_blocked_nights + r.blocked_nights; s_period_nights := s_period_nights + r.period_nights; end loop;
  if not (n = 2 and s_booked_nights = 5 and s_blocked_nights = 3 and s_period_nights = 60) then raise exception '%', 'esperaba filas=2, booked_nights=5, blocked_nights=3, period_nights=60; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, blocked_nights=%s, period_nights=%s', n, b, s_booked_nights, s_blocked_nights, s_period_nights); end if;
end $do$;
rollback;
\echo '--- 11. admin de Centro aunque la APP se equivocara y pasara null (todas): RLS lo acota igual ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_blocked_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; s_blocked_nights := s_blocked_nights + r.blocked_nights; end loop;
  if not (n = 2 and s_booked_nights = 5 and s_blocked_nights = 3) then raise exception '%', 'esperaba filas=2, booked_nights=5, blocked_nights=3; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, blocked_nights=%s', n, b, s_booked_nights, s_blocked_nights); end if;
end $do$;
rollback;
\echo '--- 12. admin de Centro pidiendo SOLO el id de Playa: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, array['00000000-0000-0000-0000-00000000a201']::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; end loop;
  if not (n = 0 and s_booked_nights = 0) then raise exception '%', 'esperaba filas=0, booked_nights=0; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s', n, b, s_booked_nights); end if;
end $do$;
rollback;
\echo '--- 13. cross-tenant: admin B pidiendo la gestora A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; end loop;
  if not (n = 0 and s_booked_nights = 0) then raise exception '%', 'esperaba filas=0, booked_nights=0; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s', n, b, s_booked_nights); end if;
end $do$;
rollback;
\echo '--- 14. cross-tenant (otro sentido): admin A pidiendo la gestora B: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; end loop;
  if not (n = 0 and s_booked_nights = 0) then raise exception '%', 'esperaba filas=0, booked_nights=0; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s', n, b, s_booked_nights); end if;
end $do$;
rollback;
\echo '--- 15. positivo de B: admin B ve SOLO su unidad (5 noches reservadas de 30) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_booked_nights numeric := 0; s_period_nights numeric := 0;
begin
  for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_booked_nights := s_booked_nights + r.booked_nights; s_period_nights := s_period_nights + r.period_nights; end loop;
  if not (n = 1 and s_booked_nights = 5 and s_period_nights = 30) then raise exception '%', 'esperaba filas=1, booked_nights=5, period_nights=30; obtuve '||format('filas=%s, buckets=%s, booked_nights=%s, period_nights=%s', n, b, s_booked_nights, s_period_nights); end if;
end $do$;
rollback;
\echo '--- 16. anon no puede leer unidades ni ocupaciones ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$with days as (
    select d::date as day from generate_series($3::date, $4::date, interval '1 day') d
  ), units as (
    select u.id, u.name
    from rentas.unidad u
    join core.property p on p.id = u.property_id
    where u.organization_id = $1
    and ($2::uuid[] is null or u.property_id = any($2::uuid[])) and p.status = 'active'
  ), grid as (
    select u.id, u.name, d.day,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'reserva' and o.estado = 'confirmado' and o.rango @> d.day) as booked,
      exists (select 1 from rentas.ocupacion o where o.unidad_id = u.id and o.capa = 'bloqueo' and o.razon in ('BLOQUEO_PROPIETARIO', 'MANTENIMIENTO') and o.estado <> 'cancelado' and o.rango @> d.day) as blocked
    from units u cross join days d
  )
  select g.name as unit_name,
    count(*) filter (where g.booked) as booked_nights,
    count(*) filter (where g.blocked and not g.booked) as blocked_nights,
    count(*) as period_nights,
    sum(count(*) filter (where g.booked)) over () as total_booked,
    sum(count(*) filter (where g.blocked and not g.booked)) over () as total_blocked,
    sum(count(*)) over () as total_period,
    count(*) over () as total_units
  from grid g
  group by g.id, g.name
  order by booked_nights desc, g.name
  limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== C) ingresos por canal ==='
\echo ''
\echo '--- 17. admin A, septiembre (por llegada): 3 canales; 6 reservas, 20 noches, $2,500.00 brutos (la cancelada, la provisional y la de otra moneda NO suman), comision de canal $285.00, neto $1,780.00 y 1 reserva en otra moneda aparte ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_bookings numeric := 0; s_nights numeric := 0; s_gross_cents numeric := 0; s_channel_fee_cents numeric := 0; s_net_cents numeric := 0; s_other_currency numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.channel::text; s_bookings := s_bookings + r.bookings; s_nights := s_nights + r.nights; s_gross_cents := s_gross_cents + r.gross_cents; s_channel_fee_cents := s_channel_fee_cents + r.channel_fee_cents; s_net_cents := s_net_cents + r.net_cents; s_other_currency := s_other_currency + r.other_currency; end loop;
  if not (n = 3 and s_bookings = 6 and s_nights = 20 and s_gross_cents = 250000 and s_channel_fee_cents = 28500 and s_net_cents = 178000 and s_other_currency = 1 and b = 'Airbnb,Booking.com,Reserva directa / bloqueo manual interno') then raise exception '%', 'esperaba filas=3, buckets=Airbnb,Booking.com,Reserva directa / bloqueo manual interno, bookings=6, nights=20, gross_cents=250000, channel_fee_cents=28500, net_cents=178000, other_currency=1; obtuve '||format('filas=%s, buckets=%s, bookings=%s, nights=%s, gross_cents=%s, channel_fee_cents=%s, net_cents=%s, other_currency=%s', n, b, s_bookings, s_nights, s_gross_cents, s_channel_fee_cents, s_net_cents, s_other_currency); end if;
end $do$;
rollback;
\echo '--- 18. la reserva de Centro 1 llega el 28-sep: octubre completo no la cuenta (se atribuye por llegada, una sola vez) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-10-01'::date, '2026-10-31'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 19. 28 a 30 sep: solo esa reserva directa ($500.00, 5 noches) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_bookings numeric := 0; s_nights numeric := 0; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-28'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_bookings := s_bookings + r.bookings; s_nights := s_nights + r.nights; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 1 and s_bookings = 1 and s_nights = 5 and s_gross_cents = 50000) then raise exception '%', 'esperaba filas=1, bookings=1, nights=5, gross_cents=50000; obtuve '||format('filas=%s, buckets=%s, bookings=%s, nights=%s, gross_cents=%s', n, b, s_bookings, s_nights, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 20. contador (finanzas de lectura) ve lo mismo que el admin: $2,500.00 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000243', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 3 and s_gross_cents = 250000) then raise exception '%', 'esperaba filas=3, gross_cents=250000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 21. operador (sin finanzas): la RLS de reserva_financiero oculta todo (0 filas); por eso la RUTA exige admin_gestora/contador ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000242', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 22. admin de Centro aunque la APP pasara null: solo las 2 reservas directas de Centro ($600.00) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_bookings numeric := 0; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_bookings := s_bookings + r.bookings; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 1 and s_bookings = 2 and s_gross_cents = 60000) then raise exception '%', 'esperaba filas=1, bookings=2, gross_cents=60000; obtuve '||format('filas=%s, buckets=%s, bookings=%s, gross_cents=%s', n, b, s_bookings, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 23. admin de Centro pidiendo el id de Playa: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, array['00000000-0000-0000-0000-00000000a201']::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 24. cross-tenant: admin B pidiendo la gestora A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 25. positivo de B: admin B ve solo lo suyo ($5,000.00) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 1 and s_gross_cents = 500000) then raise exception '%', 'esperaba filas=1, gross_cents=500000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 26. anon no puede leer finanzas ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== D) ingresos por propietario ==='
\echo ''
\echo '--- 27. admin A, septiembre: Propietario Uno $2,100.00 (3 reservas, 13 noches, comisiones $450.00, neto $1,500.00), Propietario Dos $300.00 (la de USD aparte) y Sin propietario $100.00; el total ($2,500.00) coincide con el de por canal ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_bookings numeric := 0; s_nights numeric := 0; s_gross_cents numeric := 0; s_fees_cents numeric := 0; s_net_cents numeric := 0; s_other_currency numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.owner_name::text; s_bookings := s_bookings + r.bookings; s_nights := s_nights + r.nights; s_gross_cents := s_gross_cents + r.gross_cents; s_fees_cents := s_fees_cents + r.fees_cents; s_net_cents := s_net_cents + r.net_cents; s_other_currency := s_other_currency + r.other_currency; end loop;
  if not (n = 3 and s_bookings = 6 and s_nights = 20 and s_gross_cents = 250000 and s_fees_cents = 53500 and s_net_cents = 178000 and s_other_currency = 1 and b = 'Propietario Uno,Propietario Dos,Sin propietario asignado') then raise exception '%', 'esperaba filas=3, buckets=Propietario Uno,Propietario Dos,Sin propietario asignado, bookings=6, nights=20, gross_cents=250000, fees_cents=53500, net_cents=178000, other_currency=1; obtuve '||format('filas=%s, buckets=%s, bookings=%s, nights=%s, gross_cents=%s, fees_cents=%s, net_cents=%s, other_currency=%s', n, b, s_bookings, s_nights, s_gross_cents, s_fees_cents, s_net_cents, s_other_currency); end if;
end $do$;
rollback;
\echo '--- 28. admin de Centro con null: Propietario Uno ($500.00) y Sin propietario ($100.00); no ve a Propietario Dos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.owner_name::text; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 2 and s_gross_cents = 60000 and b = 'Propietario Uno,Sin propietario asignado') then raise exception '%', 'esperaba filas=2, buckets=Propietario Uno,Sin propietario asignado, gross_cents=60000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 29. operador (sin finanzas): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000242', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 30. cross-tenant: admin B pidiendo la gestora A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 31. cross-tenant (otro sentido): admin A pidiendo la gestora B: 0 filas (nunca ve al propietario ajeno) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 32. positivo de B: su propio propietario ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.owner_name::text; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 1 and s_gross_cents = 500000 and b = 'Propietario B Ajeno') then raise exception '%', 'esperaba filas=1, buckets=Propietario B Ajeno, gross_cents=500000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 33. anon no puede leer finanzas ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select coalesce(ow.name, case when u.owner_id is null then 'Sin propietario asignado' else 'Propietario no visible' end) as owner_name,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos + rf.comision_gestor_centavos) filter (where rf.moneda = 'MXN'), 0) as fees_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join rentas.unidad u on u.id = o.unidad_id
  join core.property p on p.id = o.property_id
  left join rentas.owner ow on ow.id = u.owner_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by u.owner_id, ow.name
  order by gross_cents desc, owner_name limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== E) conflictos de calendario abiertos ==='
\echo ''
\echo '--- 34. admin A (ahora = 30-sep 12:00Z): 2 abiertos (el resuelto NO), con 10 y 2 dias abiertos, del mas antiguo al mas reciente ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_days_open numeric := 0; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where cc.organization_id = $1
    and ($2::uuid[] is null or cc.property_id = any($2::uuid[])) and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.unit_name::text; s_days_open := s_days_open + r.days_open; s_total := s_total + r.total; end loop;
  if not (n = 2 and s_days_open = 12 and s_total = 4 and b = 'Playa 1,Centro 1') then raise exception '%', 'esperaba filas=2, buckets=Playa 1,Centro 1, days_open=12, total=4; obtuve '||format('filas=%s, buckets=%s, days_open=%s, total=%s', n, b, s_days_open, s_total); end if;
end $do$;
rollback;
\echo '--- 35. admin de Centro con null: solo el de Centro 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_days_open numeric := 0; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where cc.organization_id = $1
    and ($2::uuid[] is null or cc.property_id = any($2::uuid[])) and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_days_open := s_days_open + r.days_open; s_total := s_total + r.total; end loop;
  if not (n = 1 and s_days_open = 2 and s_total = 1) then raise exception '%', 'esperaba filas=1, days_open=2, total=1; obtuve '||format('filas=%s, buckets=%s, days_open=%s, total=%s', n, b, s_days_open, s_total); end if;
end $do$;
rollback;
\echo '--- 36. operador SI ve los conflictos (calendario operativo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000242', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where cc.organization_id = $1
    and ($2::uuid[] is null or cc.property_id = any($2::uuid[])) and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 2 and s_total = 4) then raise exception '%', 'esperaba filas=2, total=4; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 37. cross-tenant: admin B pidiendo la gestora A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where cc.organization_id = $1
    and ($2::uuid[] is null or cc.property_id = any($2::uuid[])) and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 0 and s_total = 0) then raise exception '%', 'esperaba filas=0, total=0; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 38. positivo de B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where cc.organization_id = $1
    and ($2::uuid[] is null or cc.property_id = any($2::uuid[])) and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 1 and s_total = 1) then raise exception '%', 'esperaba filas=1, total=1; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 39. anon no puede leer conflictos ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where cc.organization_id = $1
    and ($2::uuid[] is null or cc.property_id = any($2::uuid[])) and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== F) tareas pendientes (limpieza y mantenimiento) ==='
\echo ''
\echo '--- 40. limpieza hasta hoy sin limite inferior (incluye rezago): 3 tareas; la completada y la cancelada NO; la de Playa 1 ya paso su SLA, la de Centro 1 aun no ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.unit_name||':'||r.sla_overdue::text; s_total := s_total + r.total; end loop;
  if not (n = 3 and s_total = 9 and b = 'Playa 2:false,Centro 1:false,Playa 1:true') then raise exception '%', 'esperaba filas=3, buckets=Playa 2:false,Centro 1:false,Playa 1:true, total=9; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 41. todos los tipos hasta hoy: las mismas 3 (el mantenimiento de Playa 1 es del 2-oct, futuro) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, null::text, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 3 and s_total = 9) then raise exception '%', 'esperaba filas=3, total=9; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 42. del 30-sep al 5-oct, todos los tipos: Centro 1 (urgente), Playa 1 (alta) y el mantenimiento programado el 2-oct; la de ayer (rezago) ya no entra con limite inferior ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30'::date, '2026-10-05'::date, '2026-09-30T12:00:00Z'::timestamptz, null::text, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.unit_name||':'||r.kind; s_total := s_total + r.total; end loop;
  if not (n = 3 and s_total = 9 and b = 'Centro 1:limpieza,Playa 1:limpieza,Playa 1:mantenimiento') then raise exception '%', 'esperaba filas=3, buckets=Centro 1:limpieza,Playa 1:limpieza,Playa 1:mantenimiento, total=9; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 43. solo mantenimiento hasta el 5-oct: 1 tarea ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-10-05'::date, '2026-09-30T12:00:00Z'::timestamptz, 'mantenimiento'::text, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 1 and s_total = 1) then raise exception '%', 'esperaba filas=1, total=1; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 44. con tope de 2 filas: 2 filas pero total = 3 (el total no depende del tope) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 2::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 2 and s_total = 6) then raise exception '%', 'esperaba filas=2, total=6; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 45. admin de Centro con null: solo la de Centro 1 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 1 and s_total = 1) then raise exception '%', 'esperaba filas=1, total=1; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 46. operador SI ve las tareas (calendario operativo) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000242', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 3 and s_total = 9) then raise exception '%', 'esperaba filas=3, total=9; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 47. cross-tenant: admin B pidiendo la gestora A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 0 and s_total = 0) then raise exception '%', 'esperaba filas=0, total=0; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 48. positivo de B: su tarea ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_total numeric := 0;
begin
  for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 51::int loop n := n + 1; s_total := s_total + r.total; end loop;
  if not (n = 1 and s_total = 1) then raise exception '%', 'esperaba filas=1, total=1; obtuve '||format('filas=%s, buckets=%s, total=%s', n, b, s_total); end if;
end $do$;
rollback;
\echo '--- 49. anon no puede leer tareas ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== G) liquidaciones a propietarios ==='
\echo ''
\echo '--- 50. admin A, septiembre: SOLO la ultima version de la liquidacion de Propietario Uno en Playa (v2 $1,100.00, NO v1 ni la suma de ambas) y la de Centro en USD (el catalogo la separa) ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0; s_net_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.owner_name||':'||r.version||':'||r.currency; s_gross_cents := s_gross_cents + r.gross_cents; s_net_cents := s_net_cents + r.net_cents; end loop;
  if not (n = 2 and s_gross_cents = 115000 and s_net_cents = 84500 and b = 'Propietario Uno:2:MXN,Propietario Uno:1:USD') then raise exception '%', 'esperaba filas=2, buckets=Propietario Uno:2:MXN,Propietario Uno:1:USD, gross_cents=115000, net_cents=84500; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s, net_cents=%s', n, b, s_gross_cents, s_net_cents); end if;
end $do$;
rollback;
\echo '--- 51. agosto: solo la de Propietario Dos ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-08-01'::date, '2026-08-31'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.owner_name::text; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 1 and s_gross_cents = 50000 and b = 'Propietario Dos') then raise exception '%', 'esperaba filas=1, buckets=Propietario Dos, gross_cents=50000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 52. un solo dia dentro del periodo (30-sep): el traslape cuenta las mismas 2 ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 2 and s_gross_cents = 115000) then raise exception '%', 'esperaba filas=2, gross_cents=115000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 53. octubre: ninguna ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-10-01'::date, '2026-10-31'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 54. contador ve lo mismo que el admin ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000243', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 2 and s_gross_cents = 115000) then raise exception '%', 'esperaba filas=2, gross_cents=115000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 55. operador (sin finanzas): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000242', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 56. admin de Centro con null: solo la liquidacion de Centro ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 1 and s_gross_cents = 5000) then raise exception '%', 'esperaba filas=1, gross_cents=5000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 57. cross-tenant: admin B pidiendo la gestora A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 0 and s_gross_cents = 0) then raise exception '%', 'esperaba filas=0, gross_cents=0; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 58. positivo de B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_gross_cents numeric := 0;
begin
  for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_gross_cents := s_gross_cents + r.gross_cents; end loop;
  if not (n = 1 and s_gross_cents = 999000) then raise exception '%', 'esperaba filas=1, gross_cents=999000; obtuve '||format('filas=%s, buckets=%s, gross_cents=%s', n, b, s_gross_cents); end if;
end $do$;
rollback;
\echo '--- 59. anon no puede leer liquidaciones ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== H) pagos de canal ==='
\echo ''
\echo '--- 60. admin A, septiembre: Airbnb 2 pagos por $2,500.00 (el pago de 3 lineas NO se triplica), 3 lineas por conciliar y 1 con discrepancia; Booking $800.00; Vrbo en USD (0 MXN, 1 en otra moneda); el de agosto NO entra ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
do $do$
declare r record; n int := 0; b text := ''; s_payouts numeric := 0; s_total_cents numeric := 0; s_pending_lines numeric := 0; s_mismatched_lines numeric := 0; s_other_currency numeric := 0;
begin
  for r in execute $q$with pay as (
    select pc.id, pc.canal_id, pc.monto_total_centavos, pc.moneda
    from rentas.payout_canal pc
    join core.property p on p.id = pc.property_id
    where pc.organization_id = $1
    and ($2::uuid[] is null or pc.property_id = any($2::uuid[]))
      and pc.fecha_payout between $3::date and $4::date
  ), lines as (
    select pl.payout_id,
      count(*) filter (where pl.estado_conciliacion = 'pendiente') as pending_lines,
      count(*) filter (where pl.estado_conciliacion = 'discrepancia') as mismatched_lines
    from rentas.payout_linea pl
    where pl.payout_id in (select id from pay)
    group by pl.payout_id
  )
  select c.nombre as channel,
    count(*) as payouts,
    coalesce(sum(pay.monto_total_centavos) filter (where pay.moneda = 'MXN'), 0) as total_cents,
    coalesce(sum(l.pending_lines), 0) as pending_lines,
    coalesce(sum(l.mismatched_lines), 0) as mismatched_lines,
    count(*) filter (where pay.moneda <> 'MXN') as other_currency
  from pay
  join rentas.canal c on c.id = pay.canal_id
  left join lines l on l.payout_id = pay.id
  group by c.id, c.nombre
  order by total_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; b := b || case when n = 1 then '' else ',' end || r.channel::text; s_payouts := s_payouts + r.payouts; s_total_cents := s_total_cents + r.total_cents; s_pending_lines := s_pending_lines + r.pending_lines; s_mismatched_lines := s_mismatched_lines + r.mismatched_lines; s_other_currency := s_other_currency + r.other_currency; end loop;
  if not (n = 3 and s_payouts = 4 and s_total_cents = 330000 and s_pending_lines = 3 and s_mismatched_lines = 1 and s_other_currency = 1 and b = 'Airbnb,Booking.com,Vrbo') then raise exception '%', 'esperaba filas=3, buckets=Airbnb,Booking.com,Vrbo, payouts=4, total_cents=330000, pending_lines=3, mismatched_lines=1, other_currency=1; obtuve '||format('filas=%s, buckets=%s, payouts=%s, total_cents=%s, pending_lines=%s, mismatched_lines=%s, other_currency=%s', n, b, s_payouts, s_total_cents, s_pending_lines, s_mismatched_lines, s_other_currency); end if;
end $do$;
rollback;
\echo '--- 61. admin de Centro con null: solo el pago de Booking ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000244', true);
do $do$
declare r record; n int := 0; b text := ''; s_payouts numeric := 0; s_total_cents numeric := 0;
begin
  for r in execute $q$with pay as (
    select pc.id, pc.canal_id, pc.monto_total_centavos, pc.moneda
    from rentas.payout_canal pc
    join core.property p on p.id = pc.property_id
    where pc.organization_id = $1
    and ($2::uuid[] is null or pc.property_id = any($2::uuid[]))
      and pc.fecha_payout between $3::date and $4::date
  ), lines as (
    select pl.payout_id,
      count(*) filter (where pl.estado_conciliacion = 'pendiente') as pending_lines,
      count(*) filter (where pl.estado_conciliacion = 'discrepancia') as mismatched_lines
    from rentas.payout_linea pl
    where pl.payout_id in (select id from pay)
    group by pl.payout_id
  )
  select c.nombre as channel,
    count(*) as payouts,
    coalesce(sum(pay.monto_total_centavos) filter (where pay.moneda = 'MXN'), 0) as total_cents,
    coalesce(sum(l.pending_lines), 0) as pending_lines,
    coalesce(sum(l.mismatched_lines), 0) as mismatched_lines,
    count(*) filter (where pay.moneda <> 'MXN') as other_currency
  from pay
  join rentas.canal c on c.id = pay.canal_id
  left join lines l on l.payout_id = pay.id
  group by c.id, c.nombre
  order by total_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_payouts := s_payouts + r.payouts; s_total_cents := s_total_cents + r.total_cents; end loop;
  if not (n = 1 and s_payouts = 1 and s_total_cents = 80000) then raise exception '%', 'esperaba filas=1, payouts=1, total_cents=80000; obtuve '||format('filas=%s, buckets=%s, payouts=%s, total_cents=%s', n, b, s_payouts, s_total_cents); end if;
end $do$;
rollback;
\echo '--- 62. operador (sin finanzas): 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000242', true);
do $do$
declare r record; n int := 0; b text := ''; s_payouts numeric := 0;
begin
  for r in execute $q$with pay as (
    select pc.id, pc.canal_id, pc.monto_total_centavos, pc.moneda
    from rentas.payout_canal pc
    join core.property p on p.id = pc.property_id
    where pc.organization_id = $1
    and ($2::uuid[] is null or pc.property_id = any($2::uuid[]))
      and pc.fecha_payout between $3::date and $4::date
  ), lines as (
    select pl.payout_id,
      count(*) filter (where pl.estado_conciliacion = 'pendiente') as pending_lines,
      count(*) filter (where pl.estado_conciliacion = 'discrepancia') as mismatched_lines
    from rentas.payout_linea pl
    where pl.payout_id in (select id from pay)
    group by pl.payout_id
  )
  select c.nombre as channel,
    count(*) as payouts,
    coalesce(sum(pay.monto_total_centavos) filter (where pay.moneda = 'MXN'), 0) as total_cents,
    coalesce(sum(l.pending_lines), 0) as pending_lines,
    coalesce(sum(l.mismatched_lines), 0) as mismatched_lines,
    count(*) filter (where pay.moneda <> 'MXN') as other_currency
  from pay
  join rentas.canal c on c.id = pay.canal_id
  left join lines l on l.payout_id = pay.id
  group by c.id, c.nombre
  order by total_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_payouts := s_payouts + r.payouts; end loop;
  if not (n = 0 and s_payouts = 0) then raise exception '%', 'esperaba filas=0, payouts=0; obtuve '||format('filas=%s, buckets=%s, payouts=%s', n, b, s_payouts); end if;
end $do$;
rollback;
\echo '--- 63. cross-tenant: admin B pidiendo la gestora A: 0 filas ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_payouts numeric := 0;
begin
  for r in execute $q$with pay as (
    select pc.id, pc.canal_id, pc.monto_total_centavos, pc.moneda
    from rentas.payout_canal pc
    join core.property p on p.id = pc.property_id
    where pc.organization_id = $1
    and ($2::uuid[] is null or pc.property_id = any($2::uuid[]))
      and pc.fecha_payout between $3::date and $4::date
  ), lines as (
    select pl.payout_id,
      count(*) filter (where pl.estado_conciliacion = 'pendiente') as pending_lines,
      count(*) filter (where pl.estado_conciliacion = 'discrepancia') as mismatched_lines
    from rentas.payout_linea pl
    where pl.payout_id in (select id from pay)
    group by pl.payout_id
  )
  select c.nombre as channel,
    count(*) as payouts,
    coalesce(sum(pay.monto_total_centavos) filter (where pay.moneda = 'MXN'), 0) as total_cents,
    coalesce(sum(l.pending_lines), 0) as pending_lines,
    coalesce(sum(l.mismatched_lines), 0) as mismatched_lines,
    count(*) filter (where pay.moneda <> 'MXN') as other_currency
  from pay
  join rentas.canal c on c.id = pay.canal_id
  left join lines l on l.payout_id = pay.id
  group by c.id, c.nombre
  order by total_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_payouts := s_payouts + r.payouts; end loop;
  if not (n = 0 and s_payouts = 0) then raise exception '%', 'esperaba filas=0, payouts=0; obtuve '||format('filas=%s, buckets=%s, payouts=%s', n, b, s_payouts); end if;
end $do$;
rollback;
\echo '--- 64. positivo de B ---'
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000245', true);
do $do$
declare r record; n int := 0; b text := ''; s_payouts numeric := 0; s_total_cents numeric := 0; s_pending_lines numeric := 0;
begin
  for r in execute $q$with pay as (
    select pc.id, pc.canal_id, pc.monto_total_centavos, pc.moneda
    from rentas.payout_canal pc
    join core.property p on p.id = pc.property_id
    where pc.organization_id = $1
    and ($2::uuid[] is null or pc.property_id = any($2::uuid[]))
      and pc.fecha_payout between $3::date and $4::date
  ), lines as (
    select pl.payout_id,
      count(*) filter (where pl.estado_conciliacion = 'pendiente') as pending_lines,
      count(*) filter (where pl.estado_conciliacion = 'discrepancia') as mismatched_lines
    from rentas.payout_linea pl
    where pl.payout_id in (select id from pay)
    group by pl.payout_id
  )
  select c.nombre as channel,
    count(*) as payouts,
    coalesce(sum(pay.monto_total_centavos) filter (where pay.moneda = 'MXN'), 0) as total_cents,
    coalesce(sum(l.pending_lines), 0) as pending_lines,
    coalesce(sum(l.mismatched_lines), 0) as mismatched_lines,
    count(*) filter (where pay.moneda <> 'MXN') as other_currency
  from pay
  join rentas.canal c on c.id = pay.canal_id
  left join lines l on l.payout_id = pay.id
  group by c.id, c.nombre
  order by total_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d202'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop n := n + 1; s_payouts := s_payouts + r.payouts; s_total_cents := s_total_cents + r.total_cents; s_pending_lines := s_pending_lines + r.pending_lines; end loop;
  if not (n = 1 and s_payouts = 1 and s_total_cents = 900000 and s_pending_lines = 1) then raise exception '%', 'esperaba filas=1, payouts=1, total_cents=900000, pending_lines=1; obtuve '||format('filas=%s, buckets=%s, payouts=%s, total_cents=%s, pending_lines=%s', n, b, s_payouts, s_total_cents, s_pending_lines); end if;
end $do$;
rollback;
\echo '--- 65. anon no puede leer pagos ---'
begin;
set local role anon;
do $do$ declare r record; begin for r in execute $q$with pay as (
    select pc.id, pc.canal_id, pc.monto_total_centavos, pc.moneda
    from rentas.payout_canal pc
    join core.property p on p.id = pc.property_id
    where pc.organization_id = $1
    and ($2::uuid[] is null or pc.property_id = any($2::uuid[]))
      and pc.fecha_payout between $3::date and $4::date
  ), lines as (
    select pl.payout_id,
      count(*) filter (where pl.estado_conciliacion = 'pendiente') as pending_lines,
      count(*) filter (where pl.estado_conciliacion = 'discrepancia') as mismatched_lines
    from rentas.payout_linea pl
    where pl.payout_id in (select id from pay)
    group by pl.payout_id
  )
  select c.nombre as channel,
    count(*) as payouts,
    coalesce(sum(pay.monto_total_centavos) filter (where pay.moneda = 'MXN'), 0) as total_cents,
    coalesce(sum(l.pending_lines), 0) as pending_lines,
    coalesce(sum(l.mismatched_lines), 0) as mismatched_lines,
    count(*) filter (where pay.moneda <> 'MXN') as other_currency
  from pay
  join rentas.canal c on c.id = pay.canal_id
  left join lines l on l.payout_id = pay.id
  group by c.id, c.nombre
  order by total_cents desc, channel limit $5$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int loop null; end loop; end $do$;
select 1 as should_fail;
rollback;
\echo ''
\echo '=== I) base SIN migrar (REGLA DURA): SQLSTATE real + SAVEPOINT, mismo mecanismo que runWithSavepointFallback ==='
\echo ''
\echo '--- 66. conflictos con rentas.conflicto_calendario ELIMINADA: 42P01 y la transaccion se recupera (nunca 25P02) ---'
begin;
drop table rentas.conflicto_calendario cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
savepoint sp_verify_rent_conf;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select u.name as unit_name, cc.tipo as kind,
    floor(extract(epoch from ($3::timestamptz - cc.detectado_en)) / 86400)::int as days_open,
    count(*) over () as total
  from rentas.conflicto_calendario cc
  join rentas.unidad u on u.id = cc.unidad_id
  join core.property p on p.id = cc.property_id
  where cc.organization_id = $1
    and ($2::uuid[] is null or cc.property_id = any($2::uuid[])) and cc.resuelto_en is null
  order by cc.detectado_en, u.name limit $4) q$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-30T12:00:00Z'::timestamptz, 51::int;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_rent_conf;
release savepoint sp_verify_rent_conf;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 67. tareas con rentas.tarea_operativa.sla_vence_en ELIMINADA (migracion 010 pendiente): 42703 ---'
begin;
alter table rentas.tarea_operativa drop column sla_vence_en cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
savepoint sp_verify_rent_tasks;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select u.name as unit_name, t.tipo as kind, t.estado as status, t.prioridad as priority,
    t.programada_para::text as scheduled,
    (t.sla_vence_en is not null and t.sla_vence_en < $5::timestamptz) as sla_overdue,
    count(*) over () as total
  from rentas.tarea_operativa t
  join rentas.unidad u on u.id = t.unidad_id
  join core.property p on p.id = t.property_id
  where t.organization_id = $1
    and ($2::uuid[] is null or t.property_id = any($2::uuid[]))
    and t.estado in ('pendiente', 'asignada', 'en_progreso', 'bloqueada')
    and ($3::date is null or t.programada_para >= $3::date) and t.programada_para <= $4::date
    and ($6::text is null or t.tipo = $6::text)
  order by t.programada_para, case t.prioridad when 'urgente' then 0 when 'alta' then 1 when 'media' then 2 else 3 end, u.name
  limit $7) q$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], null::date, '2026-09-30'::date, '2026-09-30T12:00:00Z'::timestamptz, 'limpieza'::text, 51::int;
    raise exception 'se esperaba SQLSTATE 42703 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42703' then raise exception 'se esperaba 42703, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_rent_tasks;
release savepoint sp_verify_rent_tasks;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 68. liquidaciones con rentas.owner_statement ELIMINADA (migracion 005 pendiente): 42P01 ---'
begin;
drop table rentas.owner_statement cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
savepoint sp_verify_rent_stm;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select coalesce(ow.name, 'Propietario no visible') as owner_name,
    s.periodo_inicio::text as period_start, s.periodo_fin::text as period_end, s.version, s.moneda as currency,
    s.ingresos_brutos_centavos as gross_cents, s.neto_centavos as net_cents, s.generado_en::date::text as generated_on
  from (
    select distinct on (os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin) os.*
    from rentas.owner_statement os
    join core.property p on p.id = os.property_id
    where os.organization_id = $1
    and ($2::uuid[] is null or os.property_id = any($2::uuid[]))
      and os.periodo_inicio <= $4::date and os.periodo_fin >= $3::date
    order by os.owner_id, os.property_id, os.periodo_inicio, os.periodo_fin, os.version desc
  ) s
  left join rentas.owner ow on ow.id = s.owner_id
  order by s.periodo_inicio desc, owner_name, s.moneda, s.property_id limit $5) q$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_rent_stm;
release savepoint sp_verify_rent_stm;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo '--- 69. ingresos con rentas.reserva_financiero ELIMINADA (migracion 003 pendiente): 42P01 ---'
begin;
drop table rentas.reserva_financiero cascade;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-000000000241', true);
savepoint sp_verify_rent_fin;
do $do$
declare v_state text; v_msg text;
begin
  begin
    execute $q$select count(*) from (select coalesce(c.nombre, 'Sin canal registrado') as channel,
    count(*) as bookings,
    coalesce(sum(upper(o.rango) - lower(o.rango)), 0) as nights,
    coalesce(sum(rf.monto_bruto_centavos) filter (where rf.moneda = 'MXN'), 0) as gross_cents,
    coalesce(sum(rf.comision_canal_centavos) filter (where rf.moneda = 'MXN'), 0) as channel_fee_cents,
    coalesce(sum(rf.neto_centavos) filter (where rf.moneda = 'MXN'), 0) as net_cents,
    count(*) filter (where rf.moneda <> 'MXN') as other_currency
  from rentas.reserva_financiero rf
  join rentas.ocupacion o on o.id = rf.ocupacion_id
  join core.property p on p.id = o.property_id
  left join rentas.canal c on c.id = o.canal_origen_id
  where o.organization_id = $1
    and ($2::uuid[] is null or o.property_id = any($2::uuid[]))
    and o.capa = 'reserva' and o.estado = 'confirmado'
    and lower(o.rango) between $3::date and $4::date
  group by c.id, c.nombre
  order by gross_cents desc, channel limit $5) q$q$ using '00000000-0000-0000-0000-00000000d201'::uuid, null::uuid[], '2026-09-01'::date, '2026-09-30'::date, 51::int;
    raise exception 'se esperaba SQLSTATE 42P01 pero la consulta no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate, v_msg = message_text;
    if v_state <> '42P01' then raise exception 'se esperaba 42P01, se obtuvo % (%)', v_state, v_msg; end if;
  end;
end $do$;
rollback to savepoint sp_verify_rent_fin;
release savepoint sp_verify_rent_fin;
select 1 as transaccion_recuperada_deberia_ser_1;
rollback;
\echo ''
\echo '==> los escenarios marcados should_fail deben terminar en ERROR; los deberia_ser_N en N; los bloques DO sin error = OK (una discrepancia lanza excepcion).'
