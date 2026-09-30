-- Fixtures + escenarios contra Postgres REAL (RLS + GRANT por columna reales --
-- nunca el repositorio en memoria) de
-- packages/domain-restaurantes/migrations/023_modelo_pm_horarios_minimos_zonas_whatsapp_sucursal.sql:
--
--   A. restaurantes.branch_policy (horario / pedido minimo / propina por sucursal):
--      positivo (owner y admin), rol insuficiente (staff), cross-tenant (otra
--      organizacion, y organizacion declarada ajena), GRANT por columna
--      (organization_id no se puede mover), lectura (staff propio, sesion de sistema
--      sin usuario, otra organizacion 0 filas), anon, CHECKs.
--   B. restaurantes.products/categories.no_domicilio: default false, staff propio
--      marca, otra organizacion no.
--   C. restaurantes.branch_delivery_zone: positivo, zona ajena, property ajena, staff,
--      cross-tenant en DELETE, anon.
--   D. restaurantes.whatsapp_branch_channel: positivo, PK duplicada, unicidad cruzada
--      con whatsapp_channel_config en AMBOS sentidos, GRANT por columna, sistema sin
--      usuario resuelve el numero, anon.
--   E. Base SIN migrar: el SQL real que emite el repositorio falla con 42P01/42703 y
--      el SAVEPOINT/ROLLBACK TO SAVEPOINT recupera la transaccion.
--
-- Cada escenario corre en su propio `begin; ... rollback;`. `\set ON_ERROR_STOP off`:
-- un escenario "RECHAZADO" termina en ERROR real de Postgres, nunca aborta el script.
\set ON_ERROR_STOP off
\pset pager off

insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000c0001', 'restaurantes', 'PM Org A', 'pm-org-a'),
  ('00000000-0000-0000-0000-0000000c0002', 'restaurantes', 'PM Org B (ajena)', 'pm-org-b')
on conflict do nothing;

insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 'Sucursal A1'),
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001', 'Sucursal A2'),
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c0002', 'Sucursal B1')
on conflict do nothing;

insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 'a1'),
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001', 'a2'),
  ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c0002', 'b1')
on conflict do nothing;

insert into restaurantes.known_zone (id, organization_id, name, lat, lng) values
  ('00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001', 'Zona A', 20.99, -89.62),
  ('00000000-0000-0000-0000-0000000c00e2', '00000000-0000-0000-0000-0000000c0002', 'Zona B', 21.05, -89.55)
on conflict do nothing;

insert into restaurantes.categories (id, organization_id, name, slug) values
  ('00000000-0000-0000-0000-0000000c00c1', '00000000-0000-0000-0000-0000000c0001', 'Bebidas A', 'bebidas-a')
on conflict do nothing;
insert into restaurantes.products (id, organization_id, category_id, name, price) values
  ('00000000-0000-0000-0000-0000000c00d1', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00c1', 'Cerveza A', 50)
on conflict do nothing;

insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000c0011', 'owner-a@pm.example.com', 'Owner A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0012', 'admin-a@pm.example.com', 'Admin A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0013', 'staff-a@pm.example.com', 'Staff A', 'seed'),
  ('00000000-0000-0000-0000-0000000c0014', 'owner-b@pm.example.com', 'Owner B (ajeno)', 'seed')
on conflict do nothing;

insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000c0011', '00000000-0000-0000-0000-0000000c0001', null, 'owner', 'owner'),
  ('00000000-0000-0000-0000-0000000c0012', '00000000-0000-0000-0000-0000000c0001', null, 'admin', 'admin'),
  ('00000000-0000-0000-0000-0000000c0013', '00000000-0000-0000-0000-0000000c0001', null, 'member', 'staff'),
  ('00000000-0000-0000-0000-0000000c0014', '00000000-0000-0000-0000-0000000c0002', null, 'owner', 'owner')
on conflict do nothing;

-- Datos previos para lectura / unicidad cruzada (insertados como superusuario).
insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica) values
  ('00000000-0000-0000-0000-0000000c00a2', '00000000-0000-0000-0000-0000000c0001',
   '[{"dias":[0,1,2,3,4,5,6],"abre":"12:00","cierra":"01:00"}]'::jsonb, 200, null, 'solo_tarjeta')
on conflict do nothing;
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id) values
  ('00000000-0000-0000-0000-0000000c0001', 'wa-legacy-a')
on conflict do nothing;
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id) values
  ('wa-branch-a2', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00a2')
on conflict do nothing;

\echo '=== A1. POSITIVO: owner de A crea la politica de su sucursal (turnos con cierre pasada la medianoche, minimo a domicilio, propina solo tarjeta) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_policy (property_id, organization_id, horario, pedido_minimo_domicilio, propina_politica)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001',
          '[{"dias":[1,2,3,4,5],"abre":"12:00","cierra":"16:00"},{"dias":[1,2,3,4,5],"abre":"18:00","cierra":"01:00"}]'::jsonb, 200, 'solo_tarjeta')
  returning property_id, pedido_minimo_domicilio, propina_politica;
rollback;

\echo '=== A2. POSITIVO: admin de A actualiza (UPDATE por columna concedida) la politica ya existente de A2 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0012', true);
update restaurantes.branch_policy set pedido_minimo_recoger = 100, updated_at = now()
  where property_id = '00000000-0000-0000-0000-0000000c00a2'
  returning property_id, pedido_minimo_recoger;
rollback;

\echo '=== A3. RECHAZADO (debe fallar): staff de A (rol staff, no owner/admin) no crea politica ==='
begin;
-- as should_fail (INSERT no admite alias al final de VALUES; el runner lo detecta aqui)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
insert into restaurantes.branch_policy (property_id, organization_id, pedido_minimo_domicilio)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 1);
rollback;

\echo '=== A4. RECHAZADO (debe fallar): owner de B escribe para una property de A declarando SU organizacion (property no pertenece a la org declarada) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
insert into restaurantes.branch_policy (property_id, organization_id, pedido_minimo_domicilio)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0002', 1);
rollback;

\echo '=== A5. RECHAZADO (debe fallar): owner de B declara la organizacion A (no es miembro de A) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
insert into restaurantes.branch_policy (property_id, organization_id, pedido_minimo_domicilio)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 1);
rollback;

\echo '=== A6. CROSS-TENANT: owner de B no actualiza la politica de A2 (RLS filtra: 0 filas, nunca error ni fuga) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with actualizado as (
  update restaurantes.branch_policy set pedido_minimo_domicilio = 1 where property_id = '00000000-0000-0000-0000-0000000c00a2' returning property_id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== A7. RECHAZADO (debe fallar): GRANT por columna -- ni siquiera el owner puede mover organization_id de una fila (sin UPDATE de esa columna) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.branch_policy set organization_id = '00000000-0000-0000-0000-0000000c0002' where property_id = '00000000-0000-0000-0000-0000000c00a2' returning 1 as should_fail;
rollback;

\echo '=== A8. LECTURA: staff propio ve la politica de su sucursal ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
select count(*)::int as filas_visibles_staff_propio_deberia_ser_1 from restaurantes.branch_policy where property_id = '00000000-0000-0000-0000-0000000c00a2';
rollback;

\echo '=== A9. LECTURA: sesion de SISTEMA (authenticated sin usuario, como el agente de WhatsApp) lee la politica ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as filas_visibles_sistema_deberia_ser_1 from restaurantes.branch_policy where property_id = '00000000-0000-0000-0000-0000000c00a2';
rollback;

\echo '=== A10. CROSS-TENANT LECTURA: owner de B ve 0 filas de la politica de A ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
select count(*)::int as filas_visibles_cross_tenant_deberia_ser_0 from restaurantes.branch_policy where property_id = '00000000-0000-0000-0000-0000000c00a2';
rollback;

\echo '=== A11. RECHAZADO (debe fallar): anon no lee branch_policy ==='
begin;
set local role anon;
select * from restaurantes.branch_policy as should_fail;
rollback;

\echo '=== A12. RECHAZADO (debe fallar): anon no escribe branch_policy ==='
begin;
-- as should_fail (INSERT sin alias)
set local role anon;
insert into restaurantes.branch_policy (property_id, organization_id, pedido_minimo_domicilio)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 1);
rollback;

\echo '=== A13. RECHAZADO (debe fallar): CHECK de propina_politica fuera del catalogo ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_policy (property_id, organization_id, propina_politica)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', 'siempre_y_mas');
rollback;

\echo '=== A14. RECHAZADO (debe fallar): CHECK de pedido minimo negativo ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_policy (property_id, organization_id, pedido_minimo_domicilio)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', -5);
rollback;

\echo '=== A15. RECHAZADO (debe fallar): CHECK de horario que no es un arreglo JSON ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_policy (property_id, organization_id, horario)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c0001', '{"abre":"12:00"}'::jsonb);
rollback;

\echo '=== B1. no_domicilio nace en false para todo el catalogo previo ==='
begin;
select count(*)::int as productos_no_domicilio_por_default_deberia_ser_0
  from restaurantes.products where no_domicilio;
rollback;

\echo '=== B2. POSITIVO: staff de A marca su categoria como no_domicilio ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
update restaurantes.categories set no_domicilio = true where id = '00000000-0000-0000-0000-0000000c00c1' returning id, no_domicilio;
rollback;

\echo '=== B3. CROSS-TENANT: owner de B no marca la categoria de A (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with actualizado as (
  update restaurantes.categories set no_domicilio = true where id = '00000000-0000-0000-0000-0000000c00c1' returning id
)
select count(*)::int as filas_actualizadas_cross_tenant_deberia_ser_0 from actualizado;
rollback;

\echo '=== C1. POSITIVO: owner de A cubre la Zona A con la sucursal A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001')
  returning property_id, zone_id;
rollback;

\echo '=== C2. RECHAZADO (debe fallar): owner de A asigna una zona de OTRA organizacion a su sucursal ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c00e2', '00000000-0000-0000-0000-0000000c0001');
rollback;

\echo '=== C3. RECHAZADO (debe fallar): owner de A asigna una zona a una sucursal de OTRA organizacion ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
  values ('00000000-0000-0000-0000-0000000c00b1', '00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001');
rollback;

\echo '=== C4. RECHAZADO (debe fallar): staff de A (no owner/admin) no agrega cobertura ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001');
rollback;

\echo '=== C5. CROSS-TENANT: owner de B no borra la cobertura de A (0 filas) ==='
begin;
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with borrado as (
  delete from restaurantes.branch_delivery_zone where property_id = '00000000-0000-0000-0000-0000000c00a1' returning property_id
)
select count(*)::int as filas_borradas_cross_tenant_deberia_ser_0 from borrado;
rollback;

\echo '=== C6. POSITIVO: owner de A quita su propia cobertura ==='
begin;
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
  values ('00000000-0000-0000-0000-0000000c00a1', '00000000-0000-0000-0000-0000000c00e1', '00000000-0000-0000-0000-0000000c0001');
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
with borrado as (
  delete from restaurantes.branch_delivery_zone where property_id = '00000000-0000-0000-0000-0000000c00a1' returning property_id
)
select count(*)::int as filas_borradas_propias_deberia_ser_1 from borrado;
rollback;

\echo '=== C7. RECHAZADO (debe fallar): anon no lee la cobertura de entrega ==='
begin;
set local role anon;
select * from restaurantes.branch_delivery_zone as should_fail;
rollback;

\echo '=== D1. POSITIVO: owner de A conecta un numero de WhatsApp a la sucursal A1 ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
  values ('wa-branch-a1', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00a1')
  returning phone_number_id, property_id;
rollback;

\echo '=== D2. RECHAZADO (debe fallar): el mismo numero ya rutea a la sucursal A2 (PRIMARY KEY, un numero una sucursal) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
  values ('wa-branch-a2', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00a1');
rollback;

\echo '=== D3. RECHAZADO (debe fallar): una sucursal no puede tener dos numeros (UNIQUE property_id) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
  values ('wa-branch-a2-otro', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00a2');
rollback;

\echo '=== D4. RECHAZADO (debe fallar): unicidad cruzada -- owner de B intenta registrar en una sucursal SUYA el numero que ya es el numero por defecto de la organizacion A ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
  values ('wa-legacy-a', '00000000-0000-0000-0000-0000000c0002', '00000000-0000-0000-0000-0000000c00b1');
rollback;

\echo '=== D5. RECHAZADO (debe fallar): unicidad cruzada en el otro sentido -- owner de B intenta fijar como numero por defecto de B el que ya es de una sucursal de A ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id)
  values ('00000000-0000-0000-0000-0000000c0002', 'wa-branch-a2');
rollback;

\echo '=== D6. POSITIVO (control de D5): owner de B SI conecta un numero distinto como numero por defecto ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
insert into restaurantes.whatsapp_channel_config (organization_id, phone_number_id)
  values ('00000000-0000-0000-0000-0000000c0002', 'wa-legacy-b') returning phone_number_id;
rollback;

\echo '=== D7. RECHAZADO (debe fallar): staff de A no conecta numeros de sucursal ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0013', true);
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
  values ('wa-branch-a1', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00a1');
rollback;

\echo '=== D8. RECHAZADO (debe fallar): owner de A declara una sucursal de B con su organizacion (property de otra org) ==='
begin;
-- as should_fail (INSERT sin alias)
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
insert into restaurantes.whatsapp_branch_channel (phone_number_id, organization_id, property_id)
  values ('wa-branch-b1', '00000000-0000-0000-0000-0000000c0001', '00000000-0000-0000-0000-0000000c00b1');
rollback;

\echo '=== D9. POSITIVO: owner de A rota el numero de A2 (UPDATE solo de phone_number_id) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.whatsapp_branch_channel set phone_number_id = 'wa-branch-a2-nuevo' where property_id = '00000000-0000-0000-0000-0000000c00a2' returning phone_number_id;
rollback;

\echo '=== D10. RECHAZADO (debe fallar): GRANT por columna -- no se puede mover el numero a otra sucursal (UPDATE de property_id) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0011', true);
update restaurantes.whatsapp_branch_channel set property_id = '00000000-0000-0000-0000-0000000c00a1' where phone_number_id = 'wa-branch-a2' returning 1 as should_fail;
rollback;

\echo '=== D11. RESOLUCION: sesion de SISTEMA (sin usuario) resuelve organizacion y sucursal desde el numero que recibe el mensaje ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '', true);
select count(*)::int as resolucion_sistema_deberia_ser_1 from restaurantes.whatsapp_branch_channel
  where phone_number_id = 'wa-branch-a2'
    and organization_id = '00000000-0000-0000-0000-0000000c0001'
    and property_id = '00000000-0000-0000-0000-0000000c00a2';
rollback;

\echo '=== D12. CROSS-TENANT: owner de B no borra el numero de A2 (0 filas) ==='
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000c0014', true);
with borrado as (
  delete from restaurantes.whatsapp_branch_channel where phone_number_id = 'wa-branch-a2' returning phone_number_id
)
select count(*)::int as filas_borradas_cross_tenant_deberia_ser_0 from borrado;
rollback;

\echo '=== D13. RECHAZADO (debe fallar): anon no lee los numeros por sucursal ==='
begin;
set local role anon;
select * from restaurantes.whatsapp_branch_channel as should_fail;
rollback;

\echo '=== D14. RECHAZADO (debe fallar): authenticated no puede ejecutar la funcion guard directamente ==='
begin;
set local role authenticated;
select restaurantes.guard_whatsapp_phone_number_id() as should_fail;
rollback;

\echo '=== E1. BASE SIN MIGRAR: con branch_policy eliminada en ESTA transaccion, la lectura real del repositorio falla con 42P01 y SAVEPOINT recupera la transaccion ==='
begin;
drop table restaurantes.branch_policy;
savepoint sp_verify_branch_policy_read;
do $$
declare
  v_state text;
begin
  begin
    perform horario, pedido_minimo_domicilio, pedido_minimo_recoger, propina_politica
      from restaurantes.branch_policy where property_id = '00000000-0000-0000-0000-0000000c00a1';
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_branch_policy_read;
release savepoint sp_verify_branch_policy_read;
select 1 as transaccion_recuperada_tras_42p01_deberia_ser_1;
rollback;

\echo '=== E2. BASE SIN MIGRAR: con la columna no_domicilio eliminada, el SELECT del catalogo del repositorio falla con 42703 y SAVEPOINT recupera la transaccion ==='
begin;
alter table restaurantes.products drop column no_domicilio;
savepoint sp_verify_catalogo_no_domicilio;
do $$
declare
  v_state text;
begin
  begin
    perform (pr.no_domicilio or coalesce(c.no_domicilio, false)) as no_domicilio
      from restaurantes.products pr left join restaurantes.categories c on c.id = pr.category_id;
    raise exception 'se esperaba SQLSTATE 42703, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42703' then
      raise exception 'se esperaba SQLSTATE 42703, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_catalogo_no_domicilio;
release savepoint sp_verify_catalogo_no_domicilio;
select count(*)::int as catalogo_anterior_sigue_leyendo_deberia_ser_1 from restaurantes.products where id = '00000000-0000-0000-0000-0000000c00d1';
rollback;

\echo '=== E3. BASE SIN MIGRAR: con whatsapp_branch_channel eliminada, resolver el numero falla con 42P01 y SAVEPOINT recupera la transaccion ==='
begin;
drop table restaurantes.whatsapp_branch_channel;
savepoint sp_verify_whatsapp_branch_channel_read;
do $$
declare
  v_state text;
begin
  begin
    perform organization_id, property_id from restaurantes.whatsapp_branch_channel where phone_number_id = 'wa-branch-a2';
    raise exception 'se esperaba SQLSTATE 42P01, pero no fallo';
  exception when others then
    get stacked diagnostics v_state = returned_sqlstate;
    if v_state <> '42P01' then
      raise exception 'se esperaba SQLSTATE 42P01, se obtuvo %', v_state;
    end if;
  end;
end $$;
rollback to savepoint sp_verify_whatsapp_branch_channel_read;
release savepoint sp_verify_whatsapp_branch_channel_read;
select count(*)::int as numero_por_defecto_sigue_resolviendo_deberia_ser_1 from restaurantes.whatsapp_channel_config where phone_number_id = 'wa-legacy-a';
rollback;
