-- Fixtures + assertions que verifican, contra Postgres REAL, los recorridos de
-- STAFF AUTENTICADO (sesión con `auth.uid()` real + membership real -- a
-- diferencia de scripts/verify-flujos-sistema(-2)/verify-hoteles-night-audit-sistema,
-- que cubren la sesión de SISTEMA para las mismas 6 verticales) para hoteles
-- (recepción, de punta a punta) + restaurantes + citas (los 2 siguientes en
-- prioridad -- ver README de este directorio). rentas/despachos/licitaciones
-- quedan para un segundo PR, ver README.
--
-- Cubre el fix real de este PR:
--   * packages/domain-hoteles/migrations/025_reserva_lifecycle_staff_grants.sql
-- (3 bugs en la máquina de estados de reservas de recepción -- ver el comentario
-- de cabecera de esa migración para la causa raíz completa de cada uno).
--
-- Corre vía ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI).
-- Cada escenario vive en su propio `begin; ... rollback;` -- nada de esta sección
-- persiste, salvo los fixtures de abajo (corren fuera de una transacción, como
-- superusuario, bypass RLS). IMPORTANTE: cada bloque es TOTALMENTE autocontenido
-- (no confía en que un bloque anterior haya persistido nada), mismo patrón que
-- scripts/verify-hoteles-night-audit-sistema/assertions.sql. `-- as should_fail`
-- dentro de un bloque (en vez de `as should_fail` real) marca escenarios cuya
-- sentencia objetivo (típicamente un INSERT sin RETURNING) no admite alias de
-- columna -- ver scripts/verify-real-postgres-ci/run-gate.mjs (`SHOULD_FAIL_RE`
-- matchea el texto completo del bloque, comentarios incluidos).
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS).
-- ---------------------------------------------------------------------------

-- Hoteles: organización A (ejercitada de punta a punta) + organización B (control
-- cross-tenant), cada una con su property y staff owner real, más un staff de A
-- SIN acceso a la property A1 (membership real, property_ids acotado a otra
-- property que no existe en los fixtures -- "caso negativo con un rol sin
-- permiso").
insert into core.organization (id, vertical, name, slug, status) values
  ('80000000-0000-0000-0000-000000000001', 'hoteles', 'Hotel Flujos Staff A', 'flujos-staff-hotel-a', 'active'),
  ('80000000-0000-0000-0000-000000000002', 'hoteles', 'Hotel Flujos Staff B', 'flujos-staff-hotel-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-000000000001', 'hoteles', 'Property A1', 'active'),
  ('80000000-0000-0000-0000-0000000000b1', '80000000-0000-0000-0000-000000000002', 'hoteles', 'Property B1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('80000000-0000-0000-0000-0000000f0a01', 'owner-a@flujos-staff-hoteles.example.test', 'Owner A', 'seed'),
  ('80000000-0000-0000-0000-0000000f0b01', 'owner-b@flujos-staff-hoteles.example.test', 'Owner B', 'seed'),
  ('80000000-0000-0000-0000-0000000f0c01', 'sin-acceso-a@flujos-staff-hoteles.example.test', 'Sin Acceso A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('80000000-0000-0000-0000-0000000f0a01', '80000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('80000000-0000-0000-0000-0000000f0b01', '80000000-0000-0000-0000-000000000002', null, 'owner', 'owner'),
  -- property_ids apunta SOLO a una property que no existe en estos fixtures -- este
  -- staff SÍ es miembro real de la organización A, pero `core.has_property_access`/
  -- `hoteles.can_manage_reservations` deben rechazarlo para la property A1.
  ('80000000-0000-0000-0000-0000000f0c01', '80000000-0000-0000-0000-000000000001',
   array['80000000-0000-0000-0000-0000000000c1']::uuid[], 'member', 'frontdesk')
on conflict do nothing;

insert into hoteles.room_type (id, organization_id, property_id, name) values
  ('80000000-0000-0000-0000-0000000c0a01', '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', 'Estándar')
on conflict do nothing;

-- Inventario de disponibilidad para las noches que ejercitan los escenarios de
-- abajo (siembra directa como postgres -- Fase 1 nunca expuso una ruta de alta de
-- inventario a la app, ver comentario de migrations/003_availability.sql; el
-- Bug 3 de migrations/024 es sobre el UPDATE de book_availability/
-- release_availability, no sobre esta siembra).
insert into hoteles.availability (organization_id, property_id, room_type_id, date, total_rooms, booked_rooms) values
  ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', '2026-12-01', 10, 0),
  ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', '2026-12-05', 10, 0)
on conflict do nothing;

-- Restaurantes: organización A (ejercitada de punta a punta) + organización B
-- (control cross-tenant), branch/property de A, staff owner real de A y B, un
-- repartidor real de A, y un staff_user de A SIN NINGÚN membership (0 filas en
-- core.membership) -- "caso negativo con un rol sin permiso": las policies ALL de
-- categories/products/promotions/orders de esta vertical no distinguen
-- vertical_role (cualquier miembro de la organización puede gestionar el menú),
-- así que el control negativo real aquí es "sin membership en absoluto", no un
-- rol más débil -- ver README.
insert into core.organization (id, vertical, name, slug, status) values
  ('82000000-0000-0000-0000-000000000001', 'restaurantes', 'Restaurante Flujos Staff A', 'flujos-staff-rest-a', 'active'),
  ('82000000-0000-0000-0000-000000000002', 'restaurantes', 'Restaurante Flujos Staff B', 'flujos-staff-rest-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('82000000-0000-0000-0000-0000000000a1', '82000000-0000-0000-0000-000000000001', 'restaurantes', 'Branch A1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('82000000-0000-0000-0000-0000000f0a01', 'owner-a@flujos-staff-rest.example.test', 'Owner A', 'seed'),
  ('82000000-0000-0000-0000-0000000f0b01', 'owner-b@flujos-staff-rest.example.test', 'Owner B', 'seed'),
  ('82000000-0000-0000-0000-0000000f0a02', 'repartidor-a@flujos-staff-rest.example.test', 'Repartidor A', 'seed'),
  ('82000000-0000-0000-0000-0000000f0a03', 'sin-membership-a@flujos-staff-rest.example.test', 'Sin Membership A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('82000000-0000-0000-0000-0000000f0a01', '82000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('82000000-0000-0000-0000-0000000f0b01', '82000000-0000-0000-0000-000000000002', null, 'owner', 'owner'),
  ('82000000-0000-0000-0000-0000000f0a02', '82000000-0000-0000-0000-000000000001', null, 'member', 'repartidor')
on conflict do nothing;
-- '...f0a03' (Sin Membership A) deliberadamente SIN fila en core.membership.

-- Un pedido ya "recibido" (simulando la llegada por WhatsApp/voz bajo sesión de
-- sistema vía `create_order_idempotent`, que es exclusiva de sistema -- ver
-- README) -- los escenarios de abajo ejercitan que STAFF lo avanza por sus
-- estados, no la recepción en sí (ya cubierta por scripts/verify-flujos-sistema*
-- para esta vertical).
insert into restaurantes.orders (id, customer_name, customer_phone, organization_id, branch, property_id, total, status, items, source, dedupe_fingerprint) values
  ('82000000-0000-0000-0000-0000000000e1', 'Cliente Flujos Staff', '+525500000010', '82000000-0000-0000-0000-000000000001', 'Branch A1', '82000000-0000-0000-0000-0000000000a1', 150, 'pending', '[]'::jsonb, 'whatsapp', repeat('7', 64))
on conflict do nothing;

-- Citas: organización A (ejercitada de punta a punta) + organización B (control
-- cross-tenant), property de A, staff owner real de A y B, y un staff de A SIN
-- acceso a la property A1 (mismo patrón que hoteles -- membership_covers_property
-- debe rechazarlo).
insert into core.organization (id, vertical, name, slug, status) values
  ('84000000-0000-0000-0000-000000000001', 'citas', 'Citas Flujos Staff A', 'flujos-staff-citas-a', 'active'),
  ('84000000-0000-0000-0000-000000000002', 'citas', 'Citas Flujos Staff B', 'flujos-staff-citas-b', 'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('84000000-0000-0000-0000-0000000000a1', '84000000-0000-0000-0000-000000000001', 'citas', 'Sucursal A1', 'active')
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('84000000-0000-0000-0000-0000000f0a01', 'owner-a@flujos-staff-citas.example.test', 'Owner A', 'seed'),
  ('84000000-0000-0000-0000-0000000f0b01', 'owner-b@flujos-staff-citas.example.test', 'Owner B', 'seed'),
  ('84000000-0000-0000-0000-0000000f0c01', 'sin-acceso-a@flujos-staff-citas.example.test', 'Sin Acceso A', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('84000000-0000-0000-0000-0000000f0a01', '84000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('84000000-0000-0000-0000-0000000f0b01', '84000000-0000-0000-0000-000000000002', null, 'owner', 'owner'),
  ('84000000-0000-0000-0000-0000000f0c01', '84000000-0000-0000-0000-000000000001',
   array['84000000-0000-0000-0000-0000000000c1']::uuid[], 'member', 'staff')
on conflict do nothing;

insert into citas.services (id, organization_id, name, duration_minutes, price_cents, is_active) values
  ('84000000-0000-0000-0000-0000000d0a01', '84000000-0000-0000-0000-000000000001', 'Corte', 30, 20000, true)
on conflict do nothing;

insert into citas.providers (id, organization_id, property_id, display_name, role_label, is_active) values
  ('84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1', 'Estilista A', 'Estilista', true)
on conflict do nothing;

insert into citas.provider_services (provider_id, service_id) values
  ('84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01')
on conflict do nothing;

-- =============================================================================
-- HOTELES — recepción de punta a punta (ejercita los 3 fixes de migrations/024).
-- =============================================================================

\echo '=== 1. staff con acceso crea una reserva (INSERT hoteles.reservation) -- ANTES: bloqueado siempre por el trigger AFTER sin SECURITY DEFINER (Bug 1 de migrations/024) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000)
returning (id is not null)::int as staff_crea_reserva_deberia_ser_1;
rollback;

\echo '=== 2. staff reserva disponibilidad al crear la reserva (book_availability) -- ANTES: "permission denied for table availability" (Bug 3 de migrations/024, incluso el SELECT...FOR UPDATE interno fallaba) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000);
select (booked_rooms = 1)::int as book_availability_incrementa_deberia_ser_1
  from hoteles.book_availability('80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', '2026-12-01', 1);
rollback;

\echo '=== 3. staff hace check-in (confirmada -> check_in) -- ejercita la tabla de catálogo hoteles.reservation_status_transition (Bug 2 de migrations/024, "permission denied for table reservation_status_transition") ==='
-- NOTA: el INSERT y el UPDATE van en sentencias TOP-LEVEL separadas (nunca dentro
-- de un mismo `with ... insert ... returning id) update ... where id = (select id
-- from cte)`) -- ese patrón de CTE encadenado NO ve, de forma fiable, la fila que
-- la CTE hermana acaba de insertar en la MISMA tabla (todas las CTEs de escritura
-- de una sola sentencia comparten un único snapshot; confirmado incluso como
-- `postgres`, sin RLS de por medio -- limitación real de Postgres, no un bug de
-- esta app). El patrón de 2 sentencias (con un id literal) sí ve el efecto,
-- porque cada sentencia top-level nueva incrementa el contador de comandos.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
select set_config('hoteles.actor_user_id', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000030001', '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000);
update hoteles.reservation set status = 'check_in' where id = '80000000-0000-0000-0000-000000030001'
returning (status = 'check_in')::int as staff_hace_checkin_deberia_ser_1;
rollback;

\echo '=== 4. staff asegura el folio primario de la reserva (ensurePrimaryFolio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
with nueva as (
  insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
  values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000)
  returning id
)
insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
  select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', id, 'Principal', true from nueva
returning (id is not null)::int as staff_crea_folio_primario_deberia_ser_1;
rollback;

\echo '=== 5. staff inserta un cargo manual en el folio (front desk, extras) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
with nueva as (
  insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
  values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000)
  returning id
), folio as (
  insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
    select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', id, 'Principal', true from nueva
  returning id
)
insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
  select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', id, 'Minibar', 200, 32, 'extras', '2026-12-01' from folio
returning (id is not null)::int as staff_inserta_cargo_manual_deberia_ser_1;
rollback;

\echo '=== 6. staff captura un pago en el folio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
with nueva as (
  insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
  values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000)
  returning id
), folio as (
  insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
    select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', id, 'Principal', true from nueva
  returning id
)
insert into hoteles.payment (organization_id, property_id, folio_id, amount, method, status)
  select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', id, 1232, 'efectivo', 'capturado' from folio
returning (id is not null)::int as staff_captura_pago_deberia_ser_1;
rollback;

\echo '=== 7. staff reversa un cargo (mark_charge_reversed) — el cargo original queda marcado reversed_by ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
select set_config('hoteles.actor_user_id', '80000000-0000-0000-0000-0000000f0a01', true);
with nueva as (
  insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
  values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000)
  returning id
), folio as (
  insert into hoteles.folio (organization_id, property_id, reservation_id, label, is_primary)
    select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', id, 'Principal', true from nueva
  returning id
), original as (
  insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, stay_date)
    select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', id, 'Minibar', 200, 32, 'extras', '2026-12-01' from folio
  returning id, folio_id
), reversal as (
  insert into hoteles.charge (organization_id, property_id, folio_id, description, amount, tax_amount, concept, reverses_charge_id, stay_date)
    select '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', original.folio_id, 'Reverso Minibar', -200, -32, 'reverso', original.id, '2026-12-01' from original
  returning id, (select id from original) as original_id
)
select hoteles.mark_charge_reversed(reversal.original_id, reversal.id) from reversal;
select (reversed_by is not null)::int as staff_reversa_cargo_deberia_ser_1
  from hoteles.charge where description = 'Minibar' and property_id = '80000000-0000-0000-0000-0000000000a1'
  order by created_at desc limit 1;
rollback;

\echo '=== 8. staff hace check-out completo (check_in -> en_estancia -> check_out) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
select set_config('hoteles.actor_user_id', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000080001', '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'check_in', 1000);
update hoteles.reservation set status = 'en_estancia' where id = '80000000-0000-0000-0000-000000080001';
update hoteles.reservation set status = 'check_out' where id = '80000000-0000-0000-0000-000000080001'
returning (status = 'check_out')::int as staff_hace_checkout_deberia_ser_1;
rollback;

\echo '=== 9. staff cancela una reserva y libera la disponibilidad (release_availability) -- el inventario vuelve a quedar libre ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
select set_config('hoteles.actor_user_id', '80000000-0000-0000-0000-0000000f0a01', true);
select * from hoteles.book_availability('80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', '2026-12-05', 1);
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000090001', '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-05', '2026-12-06', 'confirmada', 500);
update hoteles.reservation set status = 'cancelada', canceled_at = now(), cancellation_penalty_amount = 0
  where id = '80000000-0000-0000-0000-000000090001' and status in ('cotizada', 'confirmada');
select (booked_rooms = 0)::int as release_availability_libera_inventario_deberia_ser_1
  from hoteles.release_availability('80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', '2026-12-05', 1);
rollback;

\echo '=== 10. staff da de alta un turno de housekeeping y lo lista ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.housekeeping_shift (organization_id, property_id, staff_id, work_date, start_time, end_time)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000f0a01', '2026-12-01', '08:00', '16:00');
select count(*)::int as staff_lista_turnos_housekeeping_deberia_ser_1
  from hoteles.housekeeping_shift where property_id = '80000000-0000-0000-0000-0000000000a1' and work_date = '2026-12-01';
rollback;

\echo '=== 11. staff lee el tablero de reservas de su property (listReservations) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000);
select count(*)::int as staff_lee_tablero_deberia_ser_1
  from hoteles.reservation where property_id = '80000000-0000-0000-0000-0000000000a1' and check_in_date = '2026-12-01';
rollback;

\echo '=== 12. (rol sin permiso) staff de la organización A SIN acceso a la property A1 NO puede crear una reserva ahí (membership real, property_ids no la cubre) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0c01', true);
insert into hoteles.reservation (organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000);
rollback;

\echo '=== 13. (cross-tenant) staff real de la organización B NO ve las reservas de la property A1 de la organización A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_reservas_deberia_ser_0
  from hoteles.reservation where property_id = '80000000-0000-0000-0000-0000000000a1';
rollback;

\echo '=== 14. (cross-tenant) staff real de la organización B NO puede actualizar (cancelar) una reserva de la property A1 -- 0 filas, sin error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-0000000e0a01', '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000)
on conflict (id) do nothing;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0b01', true);
update hoteles.reservation set status = 'cancelada' where id = '80000000-0000-0000-0000-0000000e0a01' and status = 'confirmada';
-- `reset role` (vuelve a `postgres`, dueño de las tablas, bypass RLS) SOLO para
-- verificar el estado resultante dentro de la MISMA transacción que hace
-- rollback -- la policy de SELECT de staff B nunca dejaría ver esta fila (es de
-- la property A1), así que sin esto la cuenta de abajo daría 0 por invisibilidad,
-- no por confirmar que el UPDATE de staff B en verdad no tocó nada. Mismo patrón
-- que scripts/verify-hoteles-night-audit-sistema/assertions.sql.
reset role;
select count(*)::int as reserva_ajena_sigue_confirmada_deberia_ser_1
  from hoteles.reservation where id = '80000000-0000-0000-0000-0000000e0a01' and status = 'confirmada';
rollback;

\echo '=== 15. anon NO puede leer reservas (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from hoteles.reservation limit 1;
rollback;

\echo '=== 16. (límite deliberado) hoteles.reservation_status_event sigue siendo append-only -- un INSERT directo por staff real SIGUE bloqueado (el fix de migrations/024 es SECURITY DEFINER en el TRIGGER, nunca una policy de insert para staff) ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation_status_event (reservation_id, organization_id, property_id, from_status, to_status, actor_user_id)
values ('80000000-0000-0000-0000-0000000e0a01', '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', 'confirmada', 'cancelada', '80000000-0000-0000-0000-0000000f0a01');
rollback;

\echo '=== 17. staff SÍ lee la bitácora de transiciones de su property (reservation_status_event, vía el trigger -- confirma que el fix de la Parte 1 quedó realmente escribible por el camino correcto) ==='
-- Insert + lectura de la bitácora en sentencias TOP-LEVEL separadas: el trigger
-- AFTER INSERT termina de ejecutar al final del INSERT (su propia sentencia
-- completa) -- una CTE hermana leyendo reservation_status_event DENTRO de la
-- MISMA sentencia que el INSERT no vería su efecto de forma fiable (mismo
-- razonamiento que el comentario del escenario 3).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '80000000-0000-0000-0000-0000000f0a01', true);
select set_config('hoteles.actor_user_id', '80000000-0000-0000-0000-0000000f0a01', true);
insert into hoteles.reservation (id, organization_id, property_id, room_type_id, guest_id, check_in_date, check_out_date, status, total_amount)
values ('80000000-0000-0000-0000-000000170001', '80000000-0000-0000-0000-000000000001', '80000000-0000-0000-0000-0000000000a1', '80000000-0000-0000-0000-0000000c0a01', null, '2026-12-01', '2026-12-02', 'confirmada', 1000);
select count(*)::int as staff_lee_bitacora_de_su_reserva_deberia_ser_1
  from hoteles.reservation_status_event where reservation_id = '80000000-0000-0000-0000-000000170001';
rollback;

-- =============================================================================
-- RESTAURANTES — alta de catálogo + ciclo de vida del pedido + repartidor + promo.
-- =============================================================================

\echo '=== 18. staff da de alta una categoría ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0a01', true);
insert into restaurantes.categories (organization_id, name, slug, display_order)
values ('82000000-0000-0000-0000-000000000001', 'Bebidas', 'bebidas-flujos-staff', 0)
returning (id is not null)::int as staff_crea_categoria_deberia_ser_1;
rollback;

\echo '=== 19. staff da de alta un producto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0a01', true);
insert into restaurantes.products (organization_id, name, price, is_available)
values ('82000000-0000-0000-0000-000000000001', 'Agua flujos staff', 20, true)
returning (id is not null)::int as staff_crea_producto_deberia_ser_1;
rollback;

\echo '=== 20. staff avanza un pedido ya recibido por sus estados (pending -> preparando -> en_camino -> entregado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0a01', true);
update restaurantes.orders set status = 'preparando' where id = '82000000-0000-0000-0000-0000000000e1' and organization_id = '82000000-0000-0000-0000-000000000001' and status = 'pending';
update restaurantes.orders set status = 'en_camino' where id = '82000000-0000-0000-0000-0000000000e1' and organization_id = '82000000-0000-0000-0000-000000000001' and status = 'preparando';
update restaurantes.orders set status = 'entregado', delivered_at = now() where id = '82000000-0000-0000-0000-0000000000e1' and organization_id = '82000000-0000-0000-0000-000000000001' and status = 'en_camino'
returning (status = 'entregado' and delivered_at is not null)::int as staff_avanza_pedido_hasta_entregado_deberia_ser_1;
rollback;

\echo '=== 21. staff asigna un repartidor al pedido ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0a01', true);
update restaurantes.orders set assigned_repartidor_id = '82000000-0000-0000-0000-0000000f0a02', estimated_delivery_at = now() + interval '30 min'
where id = '82000000-0000-0000-0000-0000000000e1' and organization_id = '82000000-0000-0000-0000-000000000001'
returning (assigned_repartidor_id = '82000000-0000-0000-0000-0000000f0a02')::int as staff_asigna_repartidor_deberia_ser_1;
rollback;

\echo '=== 22. staff crea una promoción (alta de catálogo -- la redención en sí es system-only, ver escenario 22b) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0a01', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, is_active)
values ('82000000-0000-0000-0000-000000000001', 'FLUJOSSTAFF10', '10 off flujos staff', 'percentage', 10, true)
returning (id is not null)::int as staff_crea_promocion_deberia_ser_1;
rollback;

\echo '=== 22b. (límite deliberado, ajeno a este PR) restaurantes.increment_promotion_uses es EXCLUSIVA de sesión de sistema desde packages/domain-restaurantes/migrations/018_restaurantes_caller_binding_fase3.sql (otro agente, prefijos ...000147-000151, "caller binding") -- el único caller real es el checkout público (createOrder, sesión de sistema); un staff real SIGUE rechazado al llamarla directo ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0a01', true);
insert into restaurantes.promotions (organization_id, code, name, type, value, is_active)
values ('82000000-0000-0000-0000-000000000001', 'FLUJOSSTAFF10B', '10 off flujos staff b', 'percentage', 10, true)
returning id \gset flujos_staff_promo_
select restaurantes.increment_promotion_uses('82000000-0000-0000-0000-000000000001', :'flujos_staff_promo_id') as should_fail;
rollback;

\echo '=== 23. (rol sin permiso) staff_user de la organización A SIN NINGÚN membership NO puede dar de alta una categoría ==='
begin;
-- as should_fail (INSERT no admite `as alias` al final de VALUES(...)).
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0a03', true);
insert into restaurantes.categories (organization_id, name, slug, display_order)
values ('82000000-0000-0000-0000-000000000001', 'Sin permiso', 'sin-permiso-flujos-staff', 0);
rollback;

\echo '=== 24. (cross-tenant) staff real de la organización B NO ve el pedido de la organización A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0b01', true);
select count(*)::int as staff_ajeno_no_ve_pedido_deberia_ser_0
  from restaurantes.orders where id = '82000000-0000-0000-0000-0000000000e1';
rollback;

\echo '=== 25. (cross-tenant) staff real de la organización B NO puede actualizar el pedido de la organización A -- 0 filas, sin error ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '82000000-0000-0000-0000-0000000f0b01', true);
update restaurantes.orders set status = 'cancelado' where id = '82000000-0000-0000-0000-0000000000e1' and organization_id = '82000000-0000-0000-0000-000000000001';
-- `reset role` (bypass RLS) SOLO para verificar el estado resultante -- staff B
-- no tiene policy de SELECT que le deje ver este pedido de la organización A en
-- absoluto, así que sin esto la cuenta daría 0 por invisibilidad, no por
-- confirmar que el UPDATE de arriba en verdad no tocó nada.
reset role;
select count(*)::int as pedido_ajeno_sigue_pending_deberia_ser_1
  from restaurantes.orders where id = '82000000-0000-0000-0000-0000000000e1' and status = 'pending';
rollback;

\echo '=== 26. anon NO puede leer pedidos (sin GRANT a anon) ==='
begin;
set local role anon;
select id as should_fail from restaurantes.orders limit 1;
rollback;

-- =============================================================================
-- CITAS — alta de servicio/profesional/horario + agendar/confirmar/completar/
-- no-show.
-- =============================================================================

\echo '=== 27. staff da de alta un servicio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
insert into citas.services (organization_id, name, duration_minutes, price_cents, is_active)
values ('84000000-0000-0000-0000-000000000001', 'Manicure flujos staff', 45, 30000, true)
returning (id is not null)::int as staff_crea_servicio_deberia_ser_1;
rollback;

\echo '=== 28. staff da de alta un profesional (provider) y lo asigna al servicio existente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
insert into citas.providers (organization_id, property_id, display_name, is_active)
values ('84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1', 'Estilista flujos staff', true)
returning id \gset flujos_staff_prov_
insert into citas.provider_services (provider_id, service_id) values (:'flujos_staff_prov_id', '84000000-0000-0000-0000-0000000d0a01')
returning 1 as staff_asigna_servicio_a_profesional_deberia_ser_1;
rollback;

\echo '=== 29. staff da de alta un horario de disponibilidad (availability_rules) para el profesional existente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
insert into citas.availability_rules (provider_id, day_of_week, start_time, end_time, is_active)
values ('84000000-0000-0000-0000-0000000c0a01', 2, '09:00', '18:00', true)
returning (id is not null)::int as staff_crea_horario_deberia_ser_1;
rollback;

\echo '=== 30. staff agenda una cita desde el panel (create_appointment_from_panel) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
select (citas.create_appointment_from_panel(
  '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1',
  '84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01',
  'Cliente flujos staff', '+525500000020', null,
  '2026-12-10 10:00:00-06', '2026-12-10 10:30:00-06', null
)->>'id' is not null)::int as staff_agenda_cita_deberia_ser_1;
rollback;

\echo '=== 31. staff confirma la cita agendada (confirm_appointment_from_panel) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
with cita as (
  select citas.create_appointment_from_panel(
    '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1',
    '84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01',
    'Cliente flujos staff', '+525500000021', null,
    '2026-12-10 11:00:00-06', '2026-12-10 11:30:00-06', null
  ) as appt
)
select (citas.confirm_appointment_from_panel('84000000-0000-0000-0000-000000000001', (cita.appt->>'id')::uuid)->>'status' = 'confirmed')::int
  as staff_confirma_cita_deberia_ser_1
  from cita;
rollback;

\echo '=== 32. staff completa la cita ya confirmada (complete_appointment_from_panel) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
with cita as (
  select citas.create_appointment_from_panel(
    '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1',
    '84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01',
    'Cliente flujos staff', '+525500000022', null,
    '2026-12-10 12:00:00-06', '2026-12-10 12:30:00-06', null
  ) as appt
), confirmada as (
  select citas.confirm_appointment_from_panel('84000000-0000-0000-0000-000000000001', (cita.appt->>'id')::uuid) as appt from cita
)
select (citas.complete_appointment_from_panel('84000000-0000-0000-0000-000000000001', (confirmada.appt->>'id')::uuid)->>'status' = 'completed')::int
  as staff_completa_cita_deberia_ser_1
  from confirmada;
rollback;

\echo '=== 33. staff marca una cita como no-show (mark_appointment_no_show_from_panel) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
with cita as (
  select citas.create_appointment_from_panel(
    '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1',
    '84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01',
    'Cliente flujos staff', '+525500000023', null,
    '2026-12-10 13:00:00-06', '2026-12-10 13:30:00-06', null
  ) as appt
)
select (citas.mark_appointment_no_show_from_panel('84000000-0000-0000-0000-000000000001', (cita.appt->>'id')::uuid)->>'status' = 'no_show')::int
  as staff_marca_no_show_deberia_ser_1
  from cita;
rollback;

\echo '=== 34. (límite deliberado) reagendar (reschedule_appointment_idempotent) sigue siendo EXCLUSIVO del agente/sistema -- el panel de staff no tiene ese botón por diseño (ver apps/api/src/routes/verticals/citas/appointments-lifecycle.ts), un staff real SIGUE rechazado ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
select citas.reschedule_appointment_idempotent(
  '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000e0a01',
  '2026-12-10 14:00:00-06', '2026-12-10 14:30:00-06', 'panel', null
) as should_fail;
rollback;

\echo '=== 35. (rol sin permiso) staff de la organización A SIN acceso a la property A1 NO puede agendar una cita ahí (membership_covers_property lo rechaza) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0c01', true);
select citas.create_appointment_from_panel(
  '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1',
  '84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01',
  'Cliente sin permiso', '+525500000024', null,
  '2026-12-10 15:00:00-06', '2026-12-10 15:30:00-06', null
) as should_fail;
rollback;

\echo '=== 36. (cross-tenant) staff real de la organización B NO puede confirmar una cita de la organización A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0a01', true);
select (citas.create_appointment_from_panel(
  '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1',
  '84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01',
  'Cliente cross tenant', '+525500000025', null,
  '2026-12-10 16:00:00-06', '2026-12-10 16:30:00-06', null
)->>'id')::uuid as appt_id \gset flujos_staff_
set local role authenticated;
select set_config('request.jwt.claim.sub', '84000000-0000-0000-0000-0000000f0b01', true);
select citas.confirm_appointment_from_panel('84000000-0000-0000-0000-000000000001', :'flujos_staff_appt_id'::uuid) as should_fail;
rollback;

\echo '=== 37. anon NO puede agendar una cita (create_appointment_from_panel sin GRANT a anon) ==='
begin;
set local role anon;
select citas.create_appointment_from_panel(
  '84000000-0000-0000-0000-000000000001', '84000000-0000-0000-0000-0000000000a1',
  '84000000-0000-0000-0000-0000000c0a01', '84000000-0000-0000-0000-0000000d0a01',
  'Cliente anon', '+525500000026', null,
  '2026-12-10 17:00:00-06', '2026-12-10 17:30:00-06', null
) as should_fail;
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver filas/RETURNING reales. ==='
