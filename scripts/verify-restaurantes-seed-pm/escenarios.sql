-- Fixtures + escenarios contra Postgres REAL del seed de "Los Taquitos de PM" (bloque plpgsql generado
-- arriba: public.seed_pm_demo()). Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el
-- seed dentro de la transaccion. `\set ON_ERROR_STOP off`: un escenario "RECHAZADO" termina en ERROR real.
--
--   A. Resultado: 6 sucursales (5 activas, T4 inactiva y sin menu), 251 productos, 42 de alcohol
--      no_domicilio, 1243 precios por sucursal, comida regional solo en sucursales de menu grande.
--   B. Reglas del modelo: politica (horario 12:00-01:00, minimo $200, propina solo tarjeta), promocion
--      2x1 del lunes solo recoger, voz deshabilitada, zonas de sucursales con coordenadas, asignacion
--      por colonia con la funcion SQL real.
--   C. Idempotencia: ejecutar dos veces no duplica nada; no reactiva la voz ni reinicia usos de la
--      promocion; reparar un precio alterado.
--   D. Aislamiento: otra organizacion con nombres iguales queda intacta; un slug de otra vertical
--      aborta; staff de otra organizacion y anon no leen lo sembrado.
\set ON_ERROR_STOP off
\pset pager off

-- Otra organizacion (B) con un producto y una sucursal de MISMO nombre que los del seed + su staff.
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000e0002', 'restaurantes', 'Otra Taqueria', 'otra-taqueria')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'Victory Altabrisa')
on conflict do nothing;
insert into restaurantes.branch_detail (property_id, organization_id, slug) values
  ('00000000-0000-0000-0000-0000000e00b1', '00000000-0000-0000-0000-0000000e0002', 'altabrisa')
on conflict do nothing;
insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-0000000e00c1', '00000000-0000-0000-0000-0000000e0002', 'Taco Al Pastor (individual)', 999)
on conflict do nothing;
insert into core.staff_user (id, email, full_name, created_via) values
  ('00000000-0000-0000-0000-0000000e0014', 'owner-otra@pm.example.com', 'Owner de la otra organizacion', 'seed')
on conflict do nothing;
insert into core.membership (user_id, organization_id, property_ids, platform_role, vertical_role) values
  ('00000000-0000-0000-0000-0000000e0014', '00000000-0000-0000-0000-0000000e0002', null, 'owner', 'owner')
on conflict do nothing;

\echo '=== A1. 6 sucursales registradas (T4 incluida) ==='
begin;
select public.seed_pm_demo();
select count(*)::int as sucursales_deberia_ser_6 from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A2. 5 sucursales activas; T4 queda inactiva ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where p.status = 'active')::int as activas_deberia_ser_5 from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A3. T4 (inactiva) no recibe ningun producto ==='
begin;
select public.seed_pm_demo();
select count(*)::int as precios_de_t4_deberia_ser_0 from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id where bd.slug = 't4-pendiente';
rollback;

\echo '=== A4. 251 productos (245 + 6 regionales) ==='
begin;
select public.seed_pm_demo();
select count(*)::int as productos_deberia_ser_251 from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A5. 1243 precios por sucursal (3 de menu grande x 251 + 2 de menu chico x 245) ==='
begin;
select public.seed_pm_demo();
select count(*)::int as precios_deberia_ser_1243 from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A6. 42 productos de alcohol marcados no_domicilio ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where pr.no_domicilio)::int as alcohol_no_domicilio_deberia_ser_42 from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A7. La comida regional no existe en las sucursales de menu chico (Fco. Montejo y Pensiones) ==='
begin;
select public.seed_pm_demo();
select count(*)::int as regionales_en_menu_chico_deberia_ser_0
  from restaurantes.branch_products bp
  join restaurantes.branch_detail bd on bd.property_id = bp.property_id
  join restaurantes.products pr on pr.id = bp.product_id
  join restaurantes.categories c on c.id = pr.category_id
  where bd.slug in ('fco-montejo', 'pensiones') and c.name = 'Comida Regional';
rollback;

\echo '=== B1. Politica en las 6 sucursales: franja 12:00-01:00 todos los dias, minimo a domicilio $200, propina solo con tarjeta ==='
begin;
select public.seed_pm_demo();
select count(*)::int as politicas_correctas_deberia_ser_6
  from restaurantes.branch_policy bp join core.organization o on o.id = bp.organization_id
  where o.slug = 'los-taquitos-de-pm' and bp.pedido_minimo_domicilio = 200 and bp.pedido_minimo_recoger is null and bp.propina_politica = 'solo_tarjeta'
    and bp.horario->0->>'abre' = '12:00' and bp.horario->0->>'cierra' = '01:00' and jsonb_array_length(bp.horario->0->'dias') = 7;
rollback;

\echo '=== B2. Promocion: 2x1 del lunes, solo recoger, sobre un unico producto elegible ==='
begin;
select public.seed_pm_demo();
select count(*)::int as promocion_2x1_correcta_deberia_ser_1
  from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id
  where o.slug = 'los-taquitos-de-pm' and pm.code = 'LUNES2X1PM' and pm.type = 'bogo' and pm.value = 1 and pm.channels = array['recoger']::text[]
    and pm.days_of_week = array[1]::smallint[] and cardinality(pm.product_ids) = 1;
rollback;

\echo '=== B3. La voz se carga DESHABILITADA (sin gasto de proveedores) en las 5 sucursales activas ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where vc.habilitado)::int as voz_habilitada_deberia_ser_0 from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B4. Hay configuracion de voz en las 5 sucursales activas, con comportamiento dentro del tope ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where char_length(vc.comportamiento) between 1 and 8000 and char_length(vc.mensaje_inicial) between 1 and 500)::int as voz_configurada_deberia_ser_5
  from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B5. Zonas conocidas: una por sucursal con coordenadas (T3 y T4 no las tienen) ==='
begin;
select public.seed_pm_demo();
select count(*)::int as zonas_deberia_ser_4 from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B6. Asignacion por colonia con la funcion SQL real: "Altabrisa" empata con la zona de Victory Altabrisa y devuelve esa sucursal ==='
begin;
select public.seed_pm_demo();
select count(*)::int as sucursal_asignada_altabrisa_deberia_ser_1
  from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Altabrisa') n where n.slug = 'altabrisa' and n.distance_km = 0;
rollback;

\echo '=== C1. IDEMPOTENCIA: ejecutar el seed dos veces deja exactamente los mismos conteos ==='
begin;
select public.seed_pm_demo();
select public.seed_pm_demo();
select (
  (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm') = 6
  and (select count(*) from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm') = 6
  and (select count(*) from restaurantes.categories c join core.organization o on o.id = c.organization_id where o.slug = 'los-taquitos-de-pm') = 24
  and (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm') = 251
  and (select count(*) from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm') = 1243
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm') = 4
  and (select count(*) from restaurantes.branch_policy bp join core.organization o on o.id = bp.organization_id where o.slug = 'los-taquitos-de-pm') = 6
  and (select count(*) from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm') = 5
  and (select count(*) from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id where o.slug = 'los-taquitos-de-pm') = 1
  and (select count(*) from core.organization where slug = 'los-taquitos-de-pm') = 1
)::int as conteos_estables_tras_dos_corridas_deberia_ser_1;
rollback;

\echo '=== C2. Re-ejecutar NO vuelve a deshabilitar la voz que el dueño habilito ni reinicia los usos de la promocion ==='
begin;
select public.seed_pm_demo();
update restaurantes.branch_voice_config set habilitado = true where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
update restaurantes.promotions set times_used = 7, is_active = false where code = 'LUNES2X1PM';
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_voice_config where habilitado) = 5
  and (select times_used from restaurantes.promotions where code = 'LUNES2X1PM') = 7
  and (select is_active from restaurantes.promotions where code = 'LUNES2X1PM') = false
)::int as decisiones_del_dueno_intactas_deberia_ser_1;
rollback;

\echo '=== C3. Re-ejecutar REPARA lo que el seed controla (precio alterado y alcohol desmarcado) ==='
begin;
select public.seed_pm_demo();
update restaurantes.products set price = 1 where name = 'Taco Al Pastor (individual)' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
update restaurantes.products set no_domicilio = false where name = 'Heineken' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
select public.seed_pm_demo();
select (
  (select price from restaurantes.products where name = 'Taco Al Pastor (individual)' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm')) = 42
  and (select no_domicilio from restaurantes.products where name = 'Heineken' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm'))
)::int as seed_repara_deberia_ser_1;
rollback;

\echo '=== D1. AISLAMIENTO: la otra organizacion (mismo nombre de producto y de sucursal) queda intacta ==='
begin;
select public.seed_pm_demo();
select (
  (select price from restaurantes.products where id = '00000000-0000-0000-0000-0000000e00c1') = 999
  and (select count(*) from restaurantes.products where organization_id = '00000000-0000-0000-0000-0000000e0002') = 1
  and (select count(*) from core.property where organization_id = '00000000-0000-0000-0000-0000000e0002') = 1
  and (select count(*) from restaurantes.branch_products where property_id = '00000000-0000-0000-0000-0000000e00b1') = 0
  and (select count(*) from restaurantes.promotions where organization_id = '00000000-0000-0000-0000-0000000e0002') = 0
)::int as otra_organizacion_intacta_deberia_ser_1;
rollback;

\echo '=== D2. RECHAZADO (debe fallar): el slug ya existe en OTRA vertical; el seed aborta y no toca esa organizacion ==='
begin;
-- as should_fail (la excepcion del seed termina el escenario con ERROR)
insert into core.organization (vertical, name, slug) values ('hoteles', 'Hotel con slug ajeno', 'los-taquitos-de-pm');
select public.seed_pm_demo() as should_fail;
rollback;

\echo '=== D3. CROSS-TENANT: el staff de la otra organizacion no lee la politica sembrada (RLS: 0 filas) ==='
begin;
select public.seed_pm_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as politicas_visibles_para_otro_staff_deberia_ser_0 from restaurantes.branch_policy bp where bp.organization_id <> '00000000-0000-0000-0000-0000000e0002';
rollback;

\echo '=== D4. RECHAZADO (debe fallar): anon no lee lo sembrado ==='
begin;
-- as should_fail (la consulta usa el alias en la columna)
select public.seed_pm_demo();
set local role anon;
select count(*)::int as should_fail from restaurantes.branch_policy;
rollback;
