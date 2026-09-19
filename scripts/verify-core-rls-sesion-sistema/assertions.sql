-- Fixtures + assertions que verifican, contra Postgres REAL, el fix de
-- `packages/db/migrations/0015_core_rls_sesion_sistema.sql` (espejo
-- `supabase/migrations/20240101000136_...`): las policies de SELECT de
-- `core.organization`/`core.property` (`0001_core_schema.sql`) no tenían escape
-- hatch de sesión de sistema (`auth.uid() is null`, la sesión de TODOS los flujos
-- sin usuario: checkout público, voz, WhatsApp, crons, dispatchers — ver
-- `packages/db/src/managed-postgres-engine.ts::withAppSession`), así que CUALQUIER
-- lectura o JOIN contra esas dos tablas bajo esa sesión devolvía CERO filas SIEMPRE,
-- para las 6 verticales por igual (ver README.md de este directorio para el detalle
-- y la evidencia "antes del fix").
--
-- Corre vía ./run.sh (local) o scripts/verify-real-postgres-ci/run-gate.mjs (CI).
-- Cada escenario vive en su propio `begin; ... rollback;` -- nada de esta sección
-- persiste. Los fixtures de abajo SÍ persisten (corren fuera de una transacción,
-- como superusuario, bypass RLS).
\set ON_ERROR_STOP off
\pset pager off

-- ---------------------------------------------------------------------------
-- Fixtures (persisten — corren como postgres, bypass RLS): una organización +
-- property "A" por cada una de las 6 verticales, más una segunda organización de
-- restaurantes ("B") para el escenario cross-tenant.
-- ---------------------------------------------------------------------------
insert into core.organization (id, vertical, name, slug, status) values
  ('10000000-0000-0000-0000-000000000001', 'restaurantes',  'Taqueria Core RLS A',   'taco-core-rls-a',   'active'),
  ('10000000-0000-0000-0000-000000000002', 'restaurantes',  'Taqueria Core RLS B',   'taco-core-rls-b',   'active'),
  ('20000000-0000-0000-0000-000000000001', 'citas',         'Clinica Core RLS A',    'citas-core-rls-a',  'active'),
  ('30000000-0000-0000-0000-000000000001', 'hoteles',       'Hotel Core RLS A',      'hotel-core-rls-a',  'active'),
  ('40000000-0000-0000-0000-000000000001', 'rentas',        'Rentas Core RLS A',     'rentas-core-rls-a', 'active'),
  ('50000000-0000-0000-0000-000000000001', 'licitaciones',  'Despacho Core RLS A',   'licit-core-rls-a',  'active'),
  ('60000000-0000-0000-0000-000000000001', 'despachos',     'Despacho Core RLS A2',  'desp-core-rls-a',   'active')
on conflict do nothing;

insert into core.property (id, organization_id, vertical, name, status) values
  ('10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'restaurantes', 'Sucursal Core RLS A', 'active'),
  ('10000000-0000-0000-0000-0000000000b1', '10000000-0000-0000-0000-000000000002', 'restaurantes', 'Sucursal Core RLS B', 'active'),
  ('20000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-000000000001', 'citas',        'Sede Core RLS A',     'active'),
  ('30000000-0000-0000-0000-0000000000a1', '30000000-0000-0000-0000-000000000001', 'hoteles',      'Propiedad Core RLS A','active'),
  ('40000000-0000-0000-0000-0000000000a1', '40000000-0000-0000-0000-000000000001', 'rentas',       'Unidad Core RLS A',   'active'),
  ('60000000-0000-0000-0000-0000000000a1', '60000000-0000-0000-0000-000000000001', 'despachos',    'Sede Core RLS A',     'active')
on conflict do nothing;

-- restaurantes.branch_detail para poder ejercitar el recorrido COMPLETO del
-- checkout público (findOrganizationBySlug -> findBranch -> create_order_idempotent)
-- de la organización A, mismo shape que scripts/verify-restaurantes-sql/assertions.sql.
insert into restaurantes.branch_detail (property_id, organization_id, slug, phone, address, lat, lng, display_order) values
  ('10000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-000000000001', 'sucursal-core-rls', '9991110000', 'Calle Core RLS 1', 21.0, -89.6, 0)
on conflict do nothing;

insert into restaurantes.customers (id, organization_id, phone, name, order_count) values
  ('10000000-0000-0000-0000-0000000000c1', '10000000-0000-0000-0000-000000000001', '9991110001', 'Cliente Core RLS', 0)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('10000000-0000-0000-0000-0000000f0a01', 'owner-a@core-rls.example.com', 'Owner A', 'seed'),
  ('10000000-0000-0000-0000-0000000f0b01', 'owner-b@core-rls.example.com', 'Owner B', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('10000000-0000-0000-0000-0000000f0a01', '10000000-0000-0000-0000-000000000001', null, 'owner', 'owner'),
  ('10000000-0000-0000-0000-0000000f0b01', '10000000-0000-0000-0000-000000000002', null, 'owner', 'owner')
on conflict do nothing;

-- =============================================================================
-- (A) CADA vertical que estaba rota: la sesión de sistema SÍ resuelve
--     organización + property por slug tras el fix (antes: 0 filas siempre,
--     ver README.md "Verificado ANTES del fix").
-- =============================================================================

\echo '=== 1. restaurantes: sesion de sistema resuelve organizacion + property por slug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelve_restaurantes_deberia_ser_1
  from core.organization o join core.property p on p.organization_id = o.id
  where o.slug = 'taco-core-rls-a' and o.vertical = 'restaurantes';
rollback;

\echo '=== 2. citas: sesion de sistema resuelve organizacion + property por slug (findOrganizationBySlug/listPropertiesForOrganization) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelve_citas_deberia_ser_1
  from core.organization o join core.property p on p.organization_id = o.id
  where o.slug = 'citas-core-rls-a' and o.vertical = 'citas';
rollback;

\echo '=== 3. hoteles: sesion de sistema resuelve organizacion + property por slug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelve_hoteles_deberia_ser_1
  from core.organization o join core.property p on p.organization_id = o.id
  where o.slug = 'hotel-core-rls-a' and o.vertical = 'hoteles';
rollback;

\echo '=== 4. rentas: sesion de sistema resuelve organizacion + property por slug (findOcupacionParaCorreo hace el mismo JOIN contra core.organization) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelve_rentas_deberia_ser_1
  from core.organization o join core.property p on p.organization_id = o.id
  where o.slug = 'rentas-core-rls-a' and o.vertical = 'rentas';
rollback;

\echo '=== 5. licitaciones: sesion de sistema enumera organizaciones activas (listActiveOrganizations — antes: 0 organizaciones SIEMPRE, ok:true silencioso) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as enumera_licitaciones_deberia_ser_1
  from core.organization where vertical = 'licitaciones' and status = 'active' and slug = 'licit-core-rls-a';
rollback;

\echo '=== 6. despachos: sesion de sistema resuelve organizacion + property por slug ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as resuelve_despachos_deberia_ser_1
  from core.organization o join core.property p on p.organization_id = o.id
  where o.slug = 'desp-core-rls-a' and o.vertical = 'despachos';
rollback;

-- =============================================================================
-- (B) Recorrido SQL COMPLETO del checkout público de restaurantes bajo sesión de
--     sistema: buscar organización por slug -> resolver sucursal (core.property
--     JOIN restaurantes.branch_detail, el JOIN que rompía findBranch()) -> crear
--     pedido idempotente. Esto es justo lo que hoy está roto de punta a punta
--     (ver README.md de este directorio y de scripts/verify-restaurantes-sql/).
-- =============================================================================

\echo '=== 7. Checkout publico restaurantes de punta a punta: org por slug + sucursal + create_order_idempotent, TODO bajo sesion de sistema ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with org as (
  select id from core.organization where slug = 'taco-core-rls-a' and vertical = 'restaurantes'
),
branch as (
  select p.id as property_id
  from core.property p
  join restaurantes.branch_detail bd on bd.property_id = p.id
  where p.organization_id = (select id from org) and bd.slug = 'sucursal-core-rls'
)
select (
  (
    restaurantes.create_order_idempotent(
      jsonb_build_object(
        'organization_id', (select id from org),
        'property_id', (select property_id from branch),
        'customer_id', '10000000-0000-0000-0000-0000000000c1',
        'customer_name', 'Cliente Core RLS', 'customer_phone', '9991110001',
        'customer_address', null, 'customer_email', null, 'branch', 'Sucursal Core RLS A',
        'total', 150.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Taco', 'qty', 2, 'price', 75)),
        'source', 'web', 'notes', null, 'payment_method', 'efectivo',
        'call_transcript', null, 'call_recording_url', null
      ),
      md5('core-rls-fingerprint-a') || md5('core-rls-fingerprint-b'),
      md5('core-rls-idem-a') || md5('core-rls-idem-b')
    ) ->> 'id'
  ) is not null
)::int as pedido_creado_de_punta_a_punta_deberia_ser_1;
rollback;

\echo '=== 8. El mismo recorrido, repetido con la MISMA idempotency_key, devuelve el MISMO pedido (no un 404 de organizacion/sucursal, ni un pedido duplicado) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
with org as (
  select id from core.organization where slug = 'taco-core-rls-a' and vertical = 'restaurantes'
),
branch as (
  select p.id as property_id
  from core.property p
  join restaurantes.branch_detail bd on bd.property_id = p.id
  where p.organization_id = (select id from org) and bd.slug = 'sucursal-core-rls'
),
primer_intento as (
  select restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', (select id from org), 'property_id', (select property_id from branch),
      'customer_id', '10000000-0000-0000-0000-0000000000c1',
      'customer_name', 'Cliente Core RLS', 'customer_phone', '9991110001',
      'customer_address', null, 'customer_email', null, 'branch', 'Sucursal Core RLS A',
      'total', 90.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Quesadilla', 'qty', 1, 'price', 90)),
      'source', 'web', 'notes', null, 'payment_method', 'efectivo',
      'call_transcript', null, 'call_recording_url', null
    ),
    md5('core-rls-repeat-fp-a') || md5('core-rls-repeat-fp-b'),
    md5('core-rls-repeat-idem-a') || md5('core-rls-repeat-idem-b')
  ) ->> 'id' as pedido_id
),
segundo_intento as (
  select restaurantes.create_order_idempotent(
    jsonb_build_object(
      'organization_id', (select id from org), 'property_id', (select property_id from branch),
      'customer_id', '10000000-0000-0000-0000-0000000000c1',
      'customer_name', 'Cliente Core RLS', 'customer_phone', '9991110001',
      'customer_address', null, 'customer_email', null, 'branch', 'Sucursal Core RLS A',
      'total', 90.00, 'items', jsonb_build_array(jsonb_build_object('name', 'Quesadilla', 'qty', 1, 'price', 90)),
      'source', 'web', 'notes', null, 'payment_method', 'efectivo',
      'call_transcript', null, 'call_recording_url', null
    ),
    md5('core-rls-repeat-fp-a') || md5('core-rls-repeat-fp-b'),
    md5('core-rls-repeat-idem-a') || md5('core-rls-repeat-idem-b')
  ) ->> 'id' as pedido_id
)
select ((select pedido_id from primer_intento) = (select pedido_id from segundo_intento))::int
  as mismo_pedido_sin_duplicar_de_punta_a_punta_deberia_ser_1;
rollback;

-- =============================================================================
-- (C) Aislamiento cross-tenant: staff autenticado de la organización B sigue SIN
--     ver organización/properties de la organización A (el fix es un OR con
--     "auth.uid() is null", nunca "using (true)" — la regla original sigue
--     aplicando tal cual para cualquier auth.uid() real).
-- =============================================================================

\echo '=== 9. staff de la organizacion B NO ve la organizacion A en core.organization ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000f0b01', true);
select count(*) as ve_organizacion_ajena_deberia_ser_0
  from core.organization where slug = 'taco-core-rls-a';
rollback;

\echo '=== 10. staff de la organizacion B NO ve la property de la organizacion A en core.property ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000f0b01', true);
select count(*) as ve_property_ajena_deberia_ser_0
  from core.property where organization_id = '10000000-0000-0000-0000-000000000001';
rollback;

\echo '=== 11. (control positivo) staff de la organizacion A SI sigue viendo su PROPIA organizacion/property — el fix no rompio el acceso normal ya existente ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '10000000-0000-0000-0000-0000000f0a01', true);
select count(*) as ve_su_propia_organizacion_y_property_deberia_ser_1
  from core.organization o join core.property p on p.organization_id = o.id
  where o.slug = 'taco-core-rls-a';
rollback;

-- =============================================================================
-- (D) `anon` sigue sin acceso (sin GRANT — sin cambios en este fix).
-- =============================================================================

\echo '=== 12. anon sigue sin poder leer core.organization (permission denied, sin GRANT) ==='
begin;
set local role anon;
select count(*) from core.organization as should_fail;
rollback;

\echo '=== 13. anon sigue sin poder leer core.property (permission denied, sin GRANT) ==='
begin;
set local role anon;
select count(*) from core.property as should_fail;
rollback;

-- =============================================================================
-- (E) Límite deliberado de este fix: `core.membership`/`core.staff_user` NO
--     reciben escape hatch (demasiado sensibles — membership expone estructura
--     organizacional completa, staff_user expone email+password_hash de TODO
--     staff). Sesión de sistema sigue sin poder leerlas directo, exactamente
--     igual que antes de este fix (nunca "de vuelta a como era" — así se
--     diseñó desde el principio). Cualquier necesidad real de sistema pasa por
--     las funciones `security definer` ya existentes (`core.find_staff_by_email`/
--     `find_staff_by_id`/`find_memberships_by_user_id`), no por esta migración.
-- =============================================================================

\echo '=== 14. sesion de sistema SIGUE sin poder leer core.staff_user directo (alcance deliberado, sin cambio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_no_ve_staff_user_directo_deberia_ser_0 from core.staff_user;
rollback;

\echo '=== 15. sesion de sistema SIGUE sin poder leer core.membership directo (alcance deliberado, sin cambio) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*) as sistema_no_ve_membership_directo_deberia_ser_0 from core.membership;
rollback;

\echo '=== FIN — revisa arriba: los escenarios marcados should_fail/deberia_ser_N deben terminar en ERROR o el valor N indicado; el resto debe devolver filas/RETURNING reales. ==='
