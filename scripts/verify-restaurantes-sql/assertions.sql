-- Fixtures + assertions que verifican, contra Postgres REAL (nunca el repositorio en
-- memoria de domain-restaurantes, que es lo único que corren los 443 tests de este
-- vertical hoy), las RPC y reglas que `packages/domain-restaurantes/src/
-- postgres-repository.ts` usa de verdad: creación idempotente de pedido
-- (migrations/003), `calc_customer_tier` (migrations/002), zonas conocidas +
-- sucursal más cercana (migrations/005 — ver el hallazgo real documentado en
-- packages/domain-restaurantes/migrations/016_known_zone_authenticated_grant.sql),
-- append atómico + rate-limit de WhatsApp (migrations/004), asignación de
-- repartidor (migrations/008), promociones (migrations/010), notificaciones de
-- pedido (migrations/009), KPIs agregados (migrations/006), y aislamiento
-- cross-tenant por RLS. Corre vía ./run.sh (local) o
-- scripts/verify-real-postgres-ci/run-gate.mjs (CI).
--
-- Cada escenario vive en su propio `begin; ... rollback;` — nada de esta sección
-- persiste. Los fixtures de abajo (organización/properties/zona conocida/staff/
-- membership/clientes/pedido/promoción base) SÍ persisten (corren fuera de una
-- transacción, como superusuario, para poblar filas que ninguna policy RLS dejaría
-- insertar a un staff normal).
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS)
-- ---------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-00000000a002', 'restaurantes', 'Taqueria A', 'taqueria-a-critico'),
  ('00000000-0000-0000-0000-00000000b002', 'restaurantes', 'Taqueria B', 'taqueria-b-critico')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name) values
  ('00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000a002', 'restaurantes', 'Taqueria A - Sucursal 1'),
  ('00000000-0000-0000-0000-0000000b2b01', '00000000-0000-0000-0000-00000000b002', 'restaurantes', 'Taqueria B - Sucursal 1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug, phone, address, lat, lng, display_order) values
  ('00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000a002', 'sucursal-1', '9990001111', 'Calle Falsa 123', 21.0129, -89.6152, 0),
  ('00000000-0000-0000-0000-0000000b2b01', '00000000-0000-0000-0000-00000000b002', 'sucursal-1', '9990002222', 'Otra Calle 456', 21.0500, -89.6000, 0)
on conflict do nothing;

-- Zona conocida de Taqueria A únicamente -- el escenario 7 verifica que Taqueria B
-- (otra organización) no puede leerla directo por SQL.
insert into restaurantes.known_zone (id, organization_id, name, lat, lng) values
  ('00000000-0000-0000-0000-00000000ea01', '00000000-0000-0000-0000-00000000a002', 'Altabrisa', 21.0145, -89.6100)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000a0b01', 'owner-a@taqueria.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000a0b02', 'staff-a-repartidor@taqueria.example.com', 'Repartidor A', 'seed'),
  ('00000000-0000-0000-0000-0000000b0b02', 'owner-b@taqueria.example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000a0b01', '00000000-0000-0000-0000-00000000a002', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000a0b02', '00000000-0000-0000-0000-00000000a002', null, 'member', 'repartidor'),
  ('00000000-0000-0000-0000-0000000b0b02', '00000000-0000-0000-0000-00000000b002', null, 'owner', 'owner')
on conflict do nothing;

-- 3 clientes de Taqueria A con gasto claramente distinto -- cust3 es el mayor
-- comprador (debe caer en BLACK, percentil 100 con n=3).
insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('00000000-0000-0000-0000-00000000ca01', '00000000-0000-0000-0000-00000000a002', '9990000001', 'Cliente Uno', 1),
  ('00000000-0000-0000-0000-00000000ca02', '00000000-0000-0000-0000-00000000a002', '9990000002', 'Cliente Dos', 1),
  ('00000000-0000-0000-0000-00000000ca03', '00000000-0000-0000-0000-00000000a002', '9990000003', 'Cliente Tres', 1)
on conflict do nothing;

insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source) values
  ('00000000-0000-0000-0000-00000000da01', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000ca01', 'Cliente Uno', '9990000001', 100, 'completado', '[]'::jsonb, 'web'),
  ('00000000-0000-0000-0000-00000000da02', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000ca02', 'Cliente Dos', '9990000002', 500, 'completado', '[]'::jsonb, 'web'),
  ('00000000-0000-0000-0000-00000000da03', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000ca03', 'Cliente Tres', '9990000003', 1000, 'completado', '[]'::jsonb, 'web')
on conflict do nothing;

-- Pedido "pending" real de Taqueria A -- usado por los escenarios de asignación de
-- repartidor / notificaciones / TOCTOU.
insert into restaurantes.orders (id, organization_id, property_id, customer_id, customer_name, customer_phone, total, status, items, source) values
  ('00000000-0000-0000-0000-00000000db01', '00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000ca01', 'Cliente Uno', '9990000001', 250, 'pending', '[{"name":"Taco","qty":2,"price":125}]'::jsonb, 'whatsapp')
on conflict do nothing;

insert into restaurantes.promotions (id, organization_id, code, name, type, value, max_uses, times_used, is_active) values
  ('00000000-0000-0000-0000-00000000dc01', '00000000-0000-0000-0000-00000000a002', 'BIENVENIDA10', '10% de bienvenida', 'percentage', 10, 2, 1, true)
on conflict do nothing;

-- =============================================================================
-- (1) restaurantes.create_order_idempotent (migrations/003, grants de authenticated
--     en migrations/013_rpc_anti_duplicado_authenticated_grants.sql)
-- =============================================================================

\echo '=== 1. Sesion de sistema SI puede crear un pedido nuevo via create_order_idempotent ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object(
    'organization_id', '00000000-0000-0000-0000-00000000a002',
    'property_id', '00000000-0000-0000-0000-0000000a2a01',
    'customer_id', '00000000-0000-0000-0000-00000000ca01',
    'customer_name', 'Cliente Uno', 'customer_phone', '9990000001',
    'customer_address', null, 'customer_email', null, 'branch', 'Sucursal 1',
    'total', 250.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Taco', 'qty', 2, 'price', 125)),
    'source', 'whatsapp', 'notes', null, 'payment_method', 'efectivo',
    'call_transcript', null, 'call_recording_url', null
  ),
  md5('scn1-fingerprint-a') || md5('scn1-fingerprint-b'),
  md5('scn1-idem-a') || md5('scn1-idem-b')
);
rollback;

\echo '=== 2. Sesion de staff REAL (auth.uid() no nulo) es RECHAZADA por create_order_idempotent (solo sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0b01', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object(
    'organization_id', '00000000-0000-0000-0000-00000000a002',
    'property_id', '00000000-0000-0000-0000-0000000a2a01',
    'customer_id', '00000000-0000-0000-0000-00000000ca01',
    'customer_name', 'Cliente Uno', 'customer_phone', '9990000001',
    'customer_address', null, 'customer_email', null, 'branch', 'Sucursal 1',
    'total', 100.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Taco', 'qty', 1, 'price', 100)),
    'source', 'admin', 'notes', null, 'payment_method', 'efectivo',
    'call_transcript', null, 'call_recording_url', null
  ),
  md5('scn2-fingerprint-a') || md5('scn2-fingerprint-b'),
  null
) as should_fail;
rollback;

\echo '=== 3. Reintento con la MISMA idempotency_key + MISMO payload devuelve el MISMO pedido, sin duplicar ==='
-- NOTA: se comparan los `id` devueltos por las DOS llamadas en vez de un SELECT de
-- verificación aparte sobre restaurantes.orders -- create_order_idempotent es
-- SECURITY DEFINER y corre bajo sesión de sistema (auth.uid() IS NULL); la policy de
-- SELECT de restaurantes.orders NO tiene escape hatch para sesión de sistema (solo
-- "staff ve pedidos de su organización" vía membership real), así que un SELECT
-- aparte fuera de la función devolvería 0 filas SIEMPRE bajo esta sesión -- no
-- probaría nada sobre duplicación, solo repetiría el mismo gap de RLS que
-- 006_kpi_aggregates.sql evita a propósito usando SECURITY INVOKER.
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with primer_intento as (
  select restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-00000000a002',
      'property_id', '00000000-0000-0000-0000-0000000a2a01',
      'customer_id', '00000000-0000-0000-0000-00000000ca02',
      'customer_name', 'Cliente Dos', 'customer_phone', '9990000002',
      'customer_address', null, 'customer_email', null, 'branch', 'Sucursal 1',
      'total', 180.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Quesadilla', 'qty', 2, 'price', 90)),
      'source', 'whatsapp', 'notes', null, 'payment_method', 'efectivo',
      'call_transcript', null, 'call_recording_url', null
    ),
    md5('scn3-fingerprint-a') || md5('scn3-fingerprint-b'),
    md5('scn3-idem-a') || md5('scn3-idem-b')
  ) as pedido
),
segundo_intento as (
  select restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', '00000000-0000-0000-0000-00000000a002',
      'property_id', '00000000-0000-0000-0000-0000000a2a01',
      'customer_id', '00000000-0000-0000-0000-00000000ca02',
      'customer_name', 'Cliente Dos', 'customer_phone', '9990000002',
      'customer_address', null, 'customer_email', null, 'branch', 'Sucursal 1',
      'total', 180.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Quesadilla', 'qty', 2, 'price', 90)),
      'source', 'whatsapp', 'notes', null, 'payment_method', 'efectivo',
      'call_transcript', null, 'call_recording_url', null
    ),
    md5('scn3-fingerprint-a') || md5('scn3-fingerprint-b'),
    md5('scn3-idem-a') || md5('scn3-idem-b')
  ) as pedido
)
select (
  (select pedido from primer_intento)->>'id' = (select pedido from segundo_intento)->>'id'
  and (select pedido from primer_intento)->>'order_number' = (select pedido from segundo_intento)->>'order_number'
)::int as mismo_pedido_sin_duplicar_deberia_ser_1;
rollback;

\echo '=== 4. Reutilizar la MISMA idempotency_key con un payload DISTINTO es RECHAZADO (PT409) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.create_order_idempotent(
  jsonb_build_object(
    'organization_id', '00000000-0000-0000-0000-00000000a002',
    'property_id', '00000000-0000-0000-0000-0000000a2a01',
    'customer_id', '00000000-0000-0000-0000-00000000ca03',
    'customer_name', 'Cliente Tres', 'customer_phone', '9990000003',
    'customer_address', null, 'customer_email', null, 'branch', 'Sucursal 1',
    'total', 300.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Torta', 'qty', 3, 'price', 100)),
    'source', 'voice', 'notes', null, 'payment_method', 'efectivo',
    'call_transcript', null, 'call_recording_url', null
  ),
  md5('scn4-fingerprint-a') || md5('scn4-fingerprint-b'),
  md5('scn4-idem-a') || md5('scn4-idem-b')
);
select restaurantes.create_order_idempotent(
  jsonb_build_object(
    'organization_id', '00000000-0000-0000-0000-00000000a002',
    'property_id', '00000000-0000-0000-0000-0000000a2a01',
    'customer_id', '00000000-0000-0000-0000-00000000ca03',
    'customer_name', 'Cliente Tres', 'customer_phone', '9990000003',
    'customer_address', null, 'customer_email', null, 'branch', 'Sucursal 1',
    'total', 999.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Torta gigante', 'qty', 9, 'price', 111)),
    'source', 'voice', 'notes', null, 'payment_method', 'tarjeta',
    'call_transcript', null, 'call_recording_url', null
  ),
  md5('scn4-fingerprint-DISTINTO-a') || md5('scn4-fingerprint-DISTINTO-b'),
  md5('scn4-idem-a') || md5('scn4-idem-b')
) as should_fail;
rollback;

-- =============================================================================
-- (2) restaurantes.calc_customer_tier (migrations/002 — cortes 95/90/70)
-- =============================================================================

\echo '=== 5. El cliente con MAYOR gasto (percentil 100 con n=3) cae en tier BLACK ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0b01', true);
select (restaurantes.calc_customer_tier('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000ca03')->>'tier' = 'BLACK')::int
  as top_spender_es_black_deberia_ser_1;
rollback;

-- =============================================================================
-- (3) restaurantes.known_zone / nearest_branch_by_colonia (migrations/005 + el fix
--     real de migrations/016_known_zone_authenticated_grant.sql)
--
-- NOTA IMPORTANTE (ver README.md de este script, "Hallazgo conocido NO corregido
-- aquí"): `nearest_branch_by_colonia()` de punta a punta sigue rota bajo sesión de
-- sistema por una SEGUNDA causa, independiente del GRANT/policy de known_zone que
-- SÍ se corrige en esta rama -- `core.property` (packages/db/migrations/
-- 0001_core_schema.sql) nunca tuvo un escape hatch de sesión de sistema en su
-- policy de SELECT, así que el JOIN de la función contra `core.property` sigue
-- devolviendo 0 filas. Corregir `core.property` es una decisión de plataforma que
-- toca las 6 verticales por igual (fuera del alcance de un script de verificación
-- de restaurantes) -- documentado como hallazgo, NO disfrazado de should_fail. El
-- escenario 6 de abajo por eso verifica SOLO la parte que esta rama sí corrige
-- (que known_zone ya no bloquea con "permission denied" ni con RLS sin policy),
-- aislada del JOIN a core.property.
-- =============================================================================

\echo '=== 6. Tras el fix (GRANT+policy), la sesion de sistema SI puede resolver una zona conocida por nombre normalizado sobre known_zone (la pieza que esta rama corrige) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (z.name = 'Altabrisa')::int as resuelve_zona_conocida_deberia_ser_1
  from restaurantes.known_zone z
  where z.organization_id = '00000000-0000-0000-0000-00000000a002'
    and (
      regexp_replace(unaccent(lower('Alta Brisa')), '[^a-z0-9]', '', 'g') ilike '%' || regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') || '%'
      or regexp_replace(unaccent(lower(z.name)), '[^a-z0-9]', '', 'g') ilike '%' || regexp_replace(unaccent(lower('Alta Brisa')), '[^a-z0-9]', '', 'g') || '%'
    )
  order by length(z.name) desc
  limit 1;
rollback;

\echo '=== 7. staff de OTRA ORGANIZACION no puede leer directo la zona conocida de Taqueria A (RLS de known_zone) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b02', true);
select count(*) as ve_zona_ajena_deberia_ser_0 from restaurantes.known_zone where organization_id = '00000000-0000-0000-0000-00000000a002';
rollback;

-- =============================================================================
-- (4) Append atómico y rate-limit de WhatsApp (migrations/004)
-- =============================================================================

\echo '=== 8. whatsapp_append_turn (sistema) SI acumula 2 turnos en la MISMA conversacion (append atomico real) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-00000000a002', '9995551111', jsonb_build_array(jsonb_build_object('role', 'user', 'text', 'Hola')));
select jsonb_array_length(restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-00000000a002', '9995551111', jsonb_build_array(jsonb_build_object('role', 'assistant', 'text', 'Hola, en que te ayudo?'))))
  as dos_turnos_acumulados_deberia_ser_2;
rollback;

\echo '=== 9. whatsapp_append_turn: sesion de staff REAL es RECHAZADA (solo sistema) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0b01', true);
select restaurantes.whatsapp_append_turn('00000000-0000-0000-0000-00000000a002', '9995551111', jsonb_build_array(jsonb_build_object('role', 'user', 'text', 'Intento ajeno'))) as should_fail;
rollback;

\echo '=== 10. claim_whatsapp_message: el PRIMER claim de un message_id SI procede ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-00000000a002', 'wamid-scn10', md5('scn10-phone-a') || md5('scn10-phone-b'))::int
  as primer_claim_deberia_ser_1;
rollback;

\echo '=== 11. claim_whatsapp_message: un SEGUNDO claim inmediato del MISMO message_id (aun "processing", sin vencer) es RECHAZADO (dedupe at-least-once real) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-00000000a002', 'wamid-scn11', md5('scn11-phone-a') || md5('scn11-phone-b'));
select restaurantes.claim_whatsapp_message('00000000-0000-0000-0000-00000000a002', 'wamid-scn11', md5('scn11-phone-a') || md5('scn11-phone-b'))::int
  as segundo_claim_deberia_ser_0;
rollback;

\echo '=== 12. consume_api_rate_limit: RECHAZA la peticion que rebasa max_requests dentro de la ventana ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.consume_api_rate_limit('scn12-scope', md5('scn12-actor-a') || md5('scn12-actor-b'), 2, 300);
select restaurantes.consume_api_rate_limit('scn12-scope', md5('scn12-actor-a') || md5('scn12-actor-b'), 2, 300);
select restaurantes.consume_api_rate_limit('scn12-scope', md5('scn12-actor-a') || md5('scn12-actor-b'), 2, 300)::int
  as tercera_peticion_rechazada_deberia_ser_0;
rollback;

-- =============================================================================
-- (5) Asignación de repartidor (migrations/008) + guarda TOCTOU de estado
-- =============================================================================

\echo '=== 13. staff de Taqueria A SI puede asignar un repartidor real a un pedido de su organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0b01', true);
update restaurantes.orders set assigned_repartidor_id = '00000000-0000-0000-0000-0000000a0b02'
  where id = '00000000-0000-0000-0000-00000000db01' and organization_id = '00000000-0000-0000-0000-00000000a002'
  returning id;
rollback;

\echo '=== 14. staff de OTRA ORGANIZACION NO puede asignar un repartidor a un pedido de Taqueria A (RLS) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b02', true);
with upd as (
  update restaurantes.orders set assigned_repartidor_id = '00000000-0000-0000-0000-0000000a0b02'
    where id = '00000000-0000-0000-0000-00000000db01'
    returning id
)
select count(*) as asignacion_ajena_deberia_ser_0 from upd;
rollback;

\echo '=== 15. updateOrderStatus con un fromStatus YA obsoleto (TOCTOU) actualiza CERO filas, nunca ciego ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0b01', true);
with upd as (
  update restaurantes.orders set status = 'preparando'
    where id = '00000000-0000-0000-0000-00000000db01' and organization_id = '00000000-0000-0000-0000-00000000a002' and status = 'entregado'
    returning id
)
select count(*) as toctou_guard_deberia_ser_0 from upd;
rollback;

-- =============================================================================
-- (6) Promociones (migrations/010) — increment_promotion_uses no supera max_uses
-- =============================================================================

\echo '=== 16. increment_promotion_uses DEBAJO del tope SI incrementa (1 de 2 usos aun disponibles) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select (restaurantes.increment_promotion_uses('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000dc01') is not null)::int
  as incremento_bajo_tope_deberia_ser_1;
rollback;

\echo '=== 17. increment_promotion_uses YA EN el tope (concurrencia simulada: dos intentos casi-simultaneos) NUNCA lo rebasa ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select restaurantes.increment_promotion_uses('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000dc01');
select (restaurantes.increment_promotion_uses('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-00000000dc01') is null)::int
  as segundo_intento_bloqueado_deberia_ser_1;
select times_used as deberia_ser_2 from restaurantes.promotions where id = '00000000-0000-0000-0000-00000000dc01';
rollback;

-- =============================================================================
-- (7) Notificaciones de pedido (migrations/009) — idempotencia real
-- =============================================================================

\echo '=== 18. enqueue_staff_order_notification NO duplica la MISMA notificacion de un pedido (idempotente por evento) ==='
-- Misma razón que el escenario 3: se comparan los `id` devueltos por las dos
-- llamadas (la función es SECURITY DEFINER y su SELECT final bypassea RLS al
-- correr como el owner de la tabla) en vez de un SELECT aparte sobre
-- staff_order_notification bajo esta sesión -- esa tabla tampoco tiene escape
-- hatch de sesión de sistema en su policy de SELECT (solo "staff ve
-- notificaciones... " vía membership real).
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with primero as (
  select id from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000db01', 'order.created', 'Pedido nuevo')
),
segundo as (
  select id from restaurantes.enqueue_staff_order_notification('00000000-0000-0000-0000-00000000a002', '00000000-0000-0000-0000-0000000a2a01', '00000000-0000-0000-0000-00000000db01', 'order.created', 'Pedido nuevo (reintento)')
)
select ((select id from primero) = (select id from segundo))::int as misma_notificacion_sin_duplicar_deberia_ser_1;
rollback;

-- =============================================================================
-- (8) KPIs agregados (migrations/006, SECURITY INVOKER) + aislamiento cross-tenant
-- =============================================================================

\echo '=== 19. orders_channel_stats: staff de Taqueria A SI ve el total real de SU organizacion ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000a0b01', true);
select (total_orders >= 3)::int as ve_kpis_reales_deberia_ser_1 from restaurantes.orders_channel_stats('00000000-0000-0000-0000-00000000a002', null);
rollback;

\echo '=== 20. orders_channel_stats: staff de OTRA ORGANIZACION pasando el organization_id de Taqueria A obtiene CERO (RLS de la tabla base, no el parametro) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b02', true);
select total_orders as deberia_ser_0 from restaurantes.orders_channel_stats('00000000-0000-0000-0000-00000000a002', null);
rollback;

-- =============================================================================
-- (9) Aislamiento cross-tenant básico adicional (RLS directa de orders/customers)
-- =============================================================================

\echo '=== 21. staff de OTRA ORGANIZACION no ve NINGUN pedido de Taqueria A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b02', true);
select count(*) as ve_pedidos_ajenos_deberia_ser_0 from restaurantes.orders where organization_id = '00000000-0000-0000-0000-00000000a002';
rollback;

\echo '=== 22. staff de OTRA ORGANIZACION no ve NINGUN cliente de Taqueria A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000b0b02', true);
select count(*) as ve_clientes_ajenos_deberia_ser_0 from restaurantes.customers where organization_id = '00000000-0000-0000-0000-00000000a002';
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver una fila real. ==='
