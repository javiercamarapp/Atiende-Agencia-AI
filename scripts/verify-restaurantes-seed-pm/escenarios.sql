-- Fixtures + escenarios contra Postgres REAL del seed de "Los Taquitos de PM" (bloque plpgsql generado
-- arriba: public.seed_pm_demo()). Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el
-- seed dentro de la transaccion. `\set ON_ERROR_STOP off`: un escenario "RECHAZADO" termina en ERROR real.
--
--   A. Resultado: 7 sucursales (T1, T3 y T7 activas; T4 sin catalogo; T2 y T8 con catalogo provisional pero inactivas; T5 inactiva
--      con el suyo), 279 productos (237 + 40 fracciones de kilo + Extra Salsa y Extra Pina), 42 de alcohol no_domicilio,
--      1610 precios por sucursal (T1 278 + T2 263 + T3 251 + T5 262 + T7 278 + T8 278), cada sucursal con el precio de su
--      lista, fracciones de kilo a precio proporcional (redondeo $0.50).
--   B. Reglas del modelo: politica (horario 12:00-01:00, minimo $200, propina solo tarjeta), promocion
--      2x1 del lunes solo recoger y con alcance por sucursal (T2, T3 y T4), voz deshabilitada, zonas de sucursales con coordenadas, asignacion
--      por colonia con la funcion SQL real.
--   C. Idempotencia: ejecutar dos veces no duplica nada; no reactiva la voz ni reinicia usos de la
--      promocion; reparar un precio alterado; renombrar por slug estable una sucursal sembrada por la version anterior;
--      unir los alias de busqueda (PM-C4) con los que el dueño ya agrego.
--   D. Aislamiento: otra organizacion con nombres iguales queda intacta; un slug de otra vertical
--      aborta; staff de otra organizacion y anon no leen lo sembrado.
--   E. Agente de WhatsApp (perfil taqueria_pm con los datos del dueño), carga como DEMO (marca
--      restaurantes.demo_organization) y que re-ejecutar no pise decisiones del dueño ni reactive el widget apagado.
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

\echo '=== A1. 7 sucursales registradas (T4 Galerias y T5 Playa incluidas) ==='
begin;
select public.seed_pm_demo();
select count(*)::int as sucursales_deberia_ser_7 from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A2. Solo T1, T3 y T7 activas (T7 = fase 1 del agente); T2 y T8 con catalogo provisional pero inactivas; T4 y T5 (fuera de temporada) inactivas ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where p.status = 'active')::int as activas_deberia_ser_3 from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm';
select count(*)::int as activas_distintas_de_t1_t3_t7_deberia_ser_0
  from core.property p join core.organization o on o.id = p.organization_id join restaurantes.branch_detail bd on bd.property_id = p.id
  where o.slug = 'los-taquitos-de-pm' and p.status = 'active' and bd.slug not in ('prol-montejo', 'pensiones', 'garcia-lavin');
rollback;

\echo '=== A3. T4 Galerias (sin catalogo) no recibe ningun precio ==='
begin;
select public.seed_pm_demo();
select count(*)::int as precios_de_sucursales_sin_catalogo_deberia_ser_0 from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id where bd.slug in ('galerias');
rollback;

\echo '=== A4. 279 productos ==='
begin;
select public.seed_pm_demo();
select count(*)::int as productos_deberia_ser_279 from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A5. 1610 precios por sucursal: T1 278 + T2 263 + T3 251 + T5 262 + T7 278 + T8 278 ==='
begin;
select public.seed_pm_demo();
select count(*)::int as precios_deberia_ser_1610 from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm';
select bd.slug, count(*)::int as precios from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm' group by bd.slug order by bd.slug;
rollback;

\echo '=== A6. 42 productos de alcohol marcados no_domicilio ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where pr.no_domicilio)::int as alcohol_no_domicilio_deberia_ser_42 from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== A7. Comida regional y Flautas solo en T1, T7 y T8 (menu grande); Codzitos igual ==='
begin;
select public.seed_pm_demo();
select count(*)::int as regionales_fuera_de_t1_t7_t8_deberia_ser_0
  from restaurantes.branch_products bp
  join restaurantes.branch_detail bd on bd.property_id = bp.property_id
  join restaurantes.products pr on pr.id = bp.product_id
  join restaurantes.categories c on c.id = pr.category_id
  where bd.slug not in ('prol-montejo', 'garcia-lavin', 'altabrisa') and c.name in ('Comida Regional', 'Flautas de PM');
select count(*)::int as codzitos_fuera_de_t1_t7_t8_deberia_ser_0
  from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id
  where pr.name = 'Codzitos (orden de 4)' and bd.slug not in ('prol-montejo', 'garcia-lavin', 'altabrisa');
rollback;

\echo '=== A8. Taco al pastor: $42 en T1, $36 en T3 y $42 en T5 (precio de SU menu impreso); products.price es el de referencia T1 ==='
begin;
select public.seed_pm_demo();
select (
  (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Taco Al Pastor (individual)' and bd.slug = 'prol-montejo') = 42
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Taco Al Pastor (individual)' and bd.slug = 'pensiones') = 36
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Taco Al Pastor (individual)' and bd.slug = 'playa') = 42
  and (select pr.price from restaurantes.products pr join core.organization o on o.id = pr.organization_id where pr.name = 'Taco Al Pastor (individual)' and o.slug = 'los-taquitos-de-pm') = 42
)::int as precio_por_sucursal_correcto_deberia_ser_1;
rollback;

\echo '=== A9. Heineken Silver solo en T5 y T2; Sprite no en T5; Ensalada y Quesobich no en T3; fracciones de kilo proporcionales ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Heineken Silver' and bd.slug not in ('playa', 'fco-montejo')) = 0
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Heineken Silver' and bd.slug in ('playa', 'fco-montejo')) = 2
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name in ('Sprite', 'Sprite Cero') and bd.slug = 'playa') = 0
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Ensalada de PM' and bd.slug = 'pensiones') = 0
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id join restaurantes.categories c on c.id = pr.category_id where c.name = 'Pizza Quesobich' and bd.slug = 'pensiones') = 0
)::int as exclusiones_por_sucursal_correctas_deberia_ser_1;
select count(*)::int as fracciones_de_kilo_en_t7_deberia_ser_40
  from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id
  where bd.slug = 'garcia-lavin' and bp.is_available and (pr.name like '% — 250 g' or pr.name like '% — 500 g' or pr.name like '% — 750 g' or pr.name like '% — 1.5 kg' or pr.name like '% — 2 kg');
select (
  (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Bistec de Res — 750 g' and bd.slug = 'garcia-lavin') = 825
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Bistec de Res — 750 g' and bd.slug = 'pensiones') = 712.50
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Bistec de Res — 250 g' and bd.slug = 'garcia-lavin') = 275
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Extra Salsa' and bd.slug = 'garcia-lavin') = 19
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Extra Salsa' and bd.slug in ('pensiones', 'playa')) = 0
)::int as precios_proporcionales_y_extras_deberia_ser_1;
rollback;

\echo '=== B1. Politica en las 7 sucursales: franja 12:00-01:00 todos los dias, minimo a domicilio $200, propina solo con tarjeta ==='
begin;
select public.seed_pm_demo();
select count(*)::int as politicas_correctas_deberia_ser_7
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

\echo '=== B2b. La promocion se carga AUTOMATICA (auto_apply): el agente no manda codigos, asi que sin esto el descuento nunca llegaba al total ==='
begin;
select public.seed_pm_demo();
select count(*)::int as promos_auto_apply_deberia_ser_1 from restaurantes.promotions p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm' and p.code = 'LUNES2X1PM' and p.auto_apply;
rollback;

\echo '=== B2c. PM-C2: el 2x1 queda con ALCANCE por sucursal (property_ids): exactamente T2 Francisco de Montejo, T3 Pensiones y T4 Galerias; T1, T7 y T8 quedan fuera ==='
begin;
select public.seed_pm_demo();
select count(*)::int as alcance_2x1_solo_t2_t3_t4_deberia_ser_1
  from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id
  where o.slug = 'los-taquitos-de-pm' and pm.code = 'LUNES2X1PM' and cardinality(pm.property_ids) = 3
    and (select array_agg(bd.slug order by bd.slug) from restaurantes.branch_detail bd where bd.property_id = any(pm.property_ids)) = array['fco-montejo', 'galerias', 'pensiones']::text[];
rollback;

\echo '=== B3. La voz se carga DESHABILITADA (sin gasto de proveedores) en las sucursales activas ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where vc.habilitado)::int as voz_habilitada_deberia_ser_0 from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B4. Hay configuracion de voz en las 3 sucursales activas (T1, T3 y T7), con comportamiento dentro del tope ==='
begin;
select public.seed_pm_demo();
select count(*) filter (where char_length(vc.comportamiento) between 1 and 8000 and char_length(vc.mensaje_inicial) between 1 and 500)::int as voz_configurada_deberia_ser_3
  from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B5. Zonas conocidas: una por sucursal con coordenadas reales (T3 y T4 no las tienen; las de T5 son aproximadas y no entran) ==='
begin;
select public.seed_pm_demo();
select count(*)::int as zonas_deberia_ser_4 from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B6. Asignacion por colonia con la funcion SQL real: "Altabrisa" empata con la zona de Victory Altabrisa, pero esa sucursal esta inactiva: se asigna la activa mas cercana (T7, a 1.83 km; T1 queda a 1.84 km) y nunca la inactiva ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Altabrisa') n where n.slug = 'altabrisa') = 0
  and (select count(*) from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Altabrisa') n where n.slug = 'garcia-lavin' and n.distance_km > 0) = 1
)::int as asigna_activa_mas_cercana_y_no_la_inactiva_deberia_ser_1;
rollback;

\echo '=== B7. La voz sembrada sale del perfil de WhatsApp: trae FLUJO y ESCALACION, cabe en el tope de 8000 (check de la migracion 025), no promete el combo del martes y no nombra herramientas inexistentes ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm'
     and vc.comportamiento like '%# FLUJO DE TOMA DE PEDIDO%' and vc.comportamiento like '%# ESCALACIÓN A HUMANO%'
     and vc.comportamiento like '%la confirma la sucursal al recoger%' and char_length(vc.comportamiento) <= 8000) = 3
  and (select count(*) from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm'
     and (vc.comportamiento ~* '2 aguas de cortes|elige dos aguas|asignar_sucursal|crear_comanda|consultar_menu|\{\{')) = 0
)::int as voz_del_perfil_deberia_ser_1;
rollback;

\echo '=== C1. IDEMPOTENCIA: ejecutar el seed dos veces deja exactamente los mismos conteos ==='
begin;
select public.seed_pm_demo();
select public.seed_pm_demo();
select (
  (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from restaurantes.categories c join core.organization o on o.id = c.organization_id where o.slug = 'los-taquitos-de-pm') = 25
  and (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm') = 279
  and (select count(*) from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm') = 1610
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm') = 4
  and (select count(*) from restaurantes.branch_policy bp join core.organization o on o.id = bp.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm') = 3
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
  (select count(*) from restaurantes.branch_voice_config where habilitado) = 3
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

\echo '=== C4. PM-C2: re-ejecutar el seed sobre una base con la version ANTERIOR (T4 "t4-pendiente", T7 con el nombre viejo) la renombra por slug estable: sin choque de unique(slug) ni sucursales duplicadas ==='
begin;
select public.seed_pm_demo();
update core.property set name = 'T4 (pendiente de datos)' where name = 'Galerías' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
update restaurantes.branch_detail set slug = 't4-pendiente' where slug = 'galerias' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
update core.property set name = 'Victory Platz (García Lavín)' where name = 'García Lavín (Victory Platz)' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
update restaurantes.promotions set property_ids = null where code = 'LUNES2X1PM' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
select public.seed_pm_demo();
select (
  (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm' and p.name in ('Galerías', 'García Lavín (Victory Platz)')) = 2
  and (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm' and p.name in ('T4 (pendiente de datos)', 'Victory Platz (García Lavín)')) = 0
  and (select count(*) from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm' and bd.slug in ('t4-pendiente')) = 0
  and (select cardinality(property_ids) from restaurantes.promotions where code = 'LUNES2X1PM' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm')) = 3
)::int as seed_renombra_por_slug_y_repara_alcance_deberia_ser_1;
rollback;

\echo '=== C5. PM-C4: los alias de busqueda quedan en products.search_keywords; re-ejecutar los UNE con los que el dueño ya agrego (no los borra), sin duplicar, y no toca los productos de otra organizacion ==='
begin;
select public.seed_pm_demo();
update restaurantes.products set search_keywords = array['alias-del-dueno', 'bitek'] where name = 'Tacos de Bistec de Res (orden de 3)' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
select public.seed_pm_demo();
select (
  -- comparacion como CONJUNTO (el orden de un array depende del collation de la base: C local vs en_US en CI)
  (select search_keywords @> array['alias-del-dueno', 'bistek', 'bisté', 'bitek']::text[] and array['alias-del-dueno', 'bistek', 'bisté', 'bitek']::text[] @> search_keywords and cardinality(search_keywords) = 4 from restaurantes.products where name = 'Tacos de Bistec de Res (orden de 3)' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm'))
  and (select search_keywords from restaurantes.products where name = 'Taco Al Pastor (individual)' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm')) = array['trompo']::text[]
  and (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm' and 'chela' = any(pr.search_keywords)) = (select count(*) from restaurantes.products pr join restaurantes.categories c on c.id = pr.category_id join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm' and c.name = 'Cervezas')
  and (select search_keywords from restaurantes.products where id = '00000000-0000-0000-0000-0000000e00c1') = '{}'::text[]
)::int as alias_unidos_sin_pisar_al_dueno_ni_a_otra_org_deberia_ser_1;
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

\echo '=== E1. El agente de WhatsApp queda configurado: perfil taqueria_pm, tono formal, sin nombre inventado, sin promesa del combo del martes ==='
begin;
select public.seed_pm_demo();
select (
  select count(*) from restaurantes.whatsapp_agent_config c join core.organization o on o.id = c.organization_id
  where o.slug = 'los-taquitos-de-pm' and c.property_id is null and c.perfil = 'taqueria_pm' and c.tone_style = 'formal_directo'
    and c.business_name = 'Los Taquitos de PM' and c.agent_name is null and c.enabled
    and c.escalation_reasons_off = '{}' and c.delivery_time_text like 'a domicilio de 60 a 75 min%'
    and c.promos_text not ilike '%martes%' and c.promos_text ilike '%lunes 2x1%' and c.salsas_text ilike '%guacamolera%'
)::int as config_agente_deberia_ser_1;
rollback;

\echo '=== E2. Re-ejecutar el seed NO pisa lo que el dueño cambio en el editor del agente ==='
begin;
select public.seed_pm_demo();
update restaurantes.whatsapp_agent_config set tone_style = 'calido_cercano', agent_name = 'Lupita' where perfil = 'taqueria_pm';
select public.seed_pm_demo();
select count(*)::int as decision_del_dueno_intacta_deberia_ser_1 from restaurantes.whatsapp_agent_config where tone_style = 'calido_cercano' and agent_name = 'Lupita';
rollback;

\echo '=== E3. Cargar como DEMO crea la organizacion -demo con su marca y su propia configuracion de agente ==='
begin;
select public.seed_pm_demo_marcado();
select (
  select count(*) from restaurantes.demo_organization d join core.organization o on o.id = d.organization_id
  where o.slug = 'los-taquitos-de-pm-demo' and o.name = 'Los Taquitos de PM (demo)' and d.activo and d.seed_version = '2026-10-01'
)::int as organizacion_demo_marcada_deberia_ser_1;
rollback;

\echo '=== E4. La carga normal (sin --demo) NUNCA marca la organizacion como demo ==='
begin;
select public.seed_pm_demo();
select count(*)::int as marcas_de_la_cuenta_real_deberia_ser_0 from restaurantes.demo_organization d join core.organization o on o.id = d.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== E5. Re-ejecutar la carga demo NO reactiva un widget que el operador apago ==='
begin;
select public.seed_pm_demo_marcado();
update restaurantes.demo_organization set activo = false;
select public.seed_pm_demo_marcado();
select count(*)::int as widget_sigue_apagado_deberia_ser_1 from restaurantes.demo_organization where not activo;
rollback;

\echo '=== E6. Cuenta real y cuenta demo conviven sin mezclarse: 279 productos en cada una y una sola marca ==='
begin;
select public.seed_pm_demo();
select public.seed_pm_demo_marcado();
select (
  (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm') = 279
  and (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'los-taquitos-de-pm-demo') = 279
  and (select count(*) from restaurantes.demo_organization) = 1
)::int as conviven_sin_mezclarse_deberia_ser_1;
rollback;

\echo '=== E7. CROSS-TENANT: el staff de la otra organizacion no lee la configuracion del agente sembrada (RLS: 0 filas) ==='
begin;
select public.seed_pm_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select count(*)::int as configs_visibles_para_otro_staff_deberia_ser_0 from restaurantes.whatsapp_agent_config c where c.organization_id <> '00000000-0000-0000-0000-0000000e0002';
rollback;

\echo '=== E8. RECHAZADO (debe fallar): anon no lee la marca demo ==='
begin;
-- as should_fail (la consulta usa el alias en la columna)
select public.seed_pm_demo_marcado();
set local role anon;
select count(*)::int as should_fail from restaurantes.demo_organization;
rollback;
