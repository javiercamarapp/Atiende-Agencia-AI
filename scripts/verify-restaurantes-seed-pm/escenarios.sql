-- Fixtures + escenarios contra Postgres REAL del seed de "Los Taquitos de PM" (bloque plpgsql generado
-- arriba: public.seed_pm_demo()). Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el
-- seed dentro de la transaccion. `\set ON_ERROR_STOP off`: un escenario "RECHAZADO" termina en ERROR real.
--
--   A. Resultado: 7 sucursales (T1, T3 y T7 activas; T4 sin catalogo; T2 y T8 con catalogo provisional pero inactivas; T5 inactiva
--      con el suyo), 279 productos (237 + 40 fracciones de kilo + Extra Salsa y Extra Pina), 42 de alcohol no_domicilio,
--      1628 precios por sucursal (T1 278 + T2 265 + T3 265 + T5 264 + T7 278 + T8 278), TODAS con la lista T1-2026 (T5 con el
--      precio de su menu impreso), fracciones de kilo a precio proporcional (redondeo $0.50).
--   B. Reglas del modelo: politica (horario 12:00-01:00, minimo $200, propina solo tarjeta), promocion
--      2x1 del lunes y combo de cortesia del martes (nachos de pastor + 2 aguas), ambos solo recoger y en todas las sucursales, voz deshabilitada, zonas de sucursales con coordenadas, asignacion
--      por colonia con la funcion SQL real.
--   C. Idempotencia: ejecutar dos veces no duplica nada; no reactiva la voz ni reinicia usos de la
--      promocion; reparar un precio alterado; renombrar por slug estable una sucursal sembrada por la version anterior;
--      unir los alias de busqueda (PM-C4) con los que el dueño ya agrego; RECONCILIAR: lo que el plan ya no vende en una
--      sucursal se borra de branch_products sin tocar lo que el dueño agrego por su cuenta.
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

\echo '=== A5. 1628 precios por sucursal: T1 278 + T2 265 + T3 265 + T5 264 + T7 278 + T8 278 ==='
begin;
select public.seed_pm_demo();
select count(*)::int as precios_deberia_ser_1628 from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm';
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

\echo '=== A8. Taco al pastor: $42 en T1, T3 y T5 (T3 ya no lleva el $36 de la lista 2025); products.price es el de referencia T1 ==='
begin;
select public.seed_pm_demo();
select (
  (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Taco Al Pastor (individual)' and bd.slug = 'prol-montejo') = 42
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Taco Al Pastor (individual)' and bd.slug = 'pensiones') = 42
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Taco Al Pastor (individual)' and bd.slug = 'playa') = 42
  and (select pr.price from restaurantes.products pr join core.organization o on o.id = pr.organization_id where pr.name = 'Taco Al Pastor (individual)' and o.slug = 'los-taquitos-de-pm') = 42
)::int as precio_por_sucursal_correcto_deberia_ser_1;
rollback;

\echo '=== A9. Heineken Silver solo en T5; Sprite no en T5; T3 y T2 si venden Ensalada de PM (y T3 la pizza Quesobich); Extra Salsa y Extra Pina en las 6 sucursales con catalogo; fracciones de kilo proporcionales ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Heineken Silver' and bd.slug <> 'playa') = 0
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Heineken Silver' and bd.slug = 'playa') = 1
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name in ('Sprite', 'Sprite Cero') and bd.slug = 'playa') = 0
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name in ('Ensalada de PM', 'Jericallas', 'Café') and bd.slug in ('pensiones', 'fco-montejo')) = 6
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id join restaurantes.categories c on c.id = pr.category_id where c.name = 'Pizza Quesobich' and bd.slug = 'pensiones') = 8
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name in ('Extra Salsa', 'Extra Piña') and bp.price = 19) = 12
)::int as exclusiones_por_sucursal_correctas_deberia_ser_1;
select count(*)::int as fracciones_de_kilo_en_t7_deberia_ser_40
  from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id
  where bd.slug = 'garcia-lavin' and bp.is_available and (pr.name like '% — 250 g' or pr.name like '% — 500 g' or pr.name like '% — 750 g' or pr.name like '% — 1.5 kg' or pr.name like '% — 2 kg');
select (
  (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Bistec de Res — 750 g' and bd.slug = 'garcia-lavin') = 825
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Bistec de Res — 750 g' and bd.slug = 'pensiones') = 825
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Bistec de Res — 250 g' and bd.slug = 'pensiones') = 275
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where pr.name = 'Pastor — 250 g' and bd.slug = 'pensiones') = 225
)::int as precios_proporcionales_deberia_ser_1;
rollback;

\echo '=== A10. CR01: T2, T3, T7 y T8 venden TODO lo que tienen al MISMO precio que T1 (lista T1-2026): ninguna diferencia ==='
begin;
select public.seed_pm_demo();
select count(*)::int as precios_distintos_a_t1_en_t2_t3_t7_t8_deberia_ser_0
  from restaurantes.branch_products bp
  join restaurantes.branch_detail bd on bd.property_id = bp.property_id
  join core.organization o on o.id = bd.organization_id and o.slug = 'los-taquitos-de-pm'
  join restaurantes.branch_detail bd1 on bd1.organization_id = o.id and bd1.slug = 'prol-montejo'
  join restaurantes.branch_products t1 on t1.property_id = bd1.property_id and t1.product_id = bp.product_id
  where bd.slug in ('fco-montejo', 'pensiones', 'garcia-lavin', 'altabrisa') and bp.price <> t1.price;
select count(*)::int as productos_de_t2_t3_sin_precio_en_t1_deberia_ser_0
  from restaurantes.branch_products bp
  join restaurantes.branch_detail bd on bd.property_id = bp.property_id
  join core.organization o on o.id = bd.organization_id and o.slug = 'los-taquitos-de-pm'
  where bd.slug in ('fco-montejo', 'pensiones')
    and not exists (select 1 from restaurantes.branch_products t1 join restaurantes.branch_detail bd1 on bd1.property_id = t1.property_id where bd1.organization_id = o.id and bd1.slug = 'prol-montejo' and t1.product_id = bp.product_id);
rollback;

\echo '=== B1. Politica en las 7 sucursales: franja 12:00-01:00 todos los dias, minimo a domicilio $200, propina solo con tarjeta ==='
begin;
select public.seed_pm_demo();
select count(*)::int as politicas_correctas_deberia_ser_7
  from restaurantes.branch_policy bp join core.organization o on o.id = bp.organization_id
  where o.slug = 'los-taquitos-de-pm' and bp.pedido_minimo_domicilio = 200 and bp.pedido_minimo_recoger is null and bp.propina_politica = 'solo_tarjeta'
    and bp.horario->0->>'abre' = '12:00' and bp.horario->0->>'cierra' = '01:00' and jsonb_array_length(bp.horario->0->'dias') = 7;
rollback;

\echo '=== B1b. Directorio y domicilio (migracion 057): Galerias visible e informativa, Playa (Chicxulub) visible + solo recoger + de temporada, Pensiones sin restriccion de dias (PREGUNTA B13), el resto por omision ==='
begin;
select public.seed_pm_demo();
select count(*)::int as directorio_correcto_deberia_ser_7
  from restaurantes.branch_policy bp
  join core.organization o on o.id = bp.organization_id
  join restaurantes.branch_detail bd on bd.property_id = bp.property_id
  where o.slug = 'los-taquitos-de-pm'
    and case bd.slug
      when 'galerias' then bp.visible_en_directorio is true and bp.acepta_domicilio and bp.dias_domicilio is null and not bp.de_temporada
      when 'playa' then bp.visible_en_directorio is true and not bp.acepta_domicilio and bp.dias_domicilio is null and bp.de_temporada
      else bp.visible_en_directorio is null and bp.acepta_domicilio and bp.dias_domicilio is null and not bp.de_temporada
    end;
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

\echo '=== B2c. CR07/CR08: el 2x1 queda SIN alcance por sucursal (property_ids null = todas): la restriccion a T2, T3 y T4 era del menu impreso de 2025 ==='
begin;
select public.seed_pm_demo();
select count(*)::int as alcance_2x1_todas_las_sucursales_deberia_ser_1
  from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id
  where o.slug = 'los-taquitos-de-pm' and pm.code = 'LUNES2X1PM' and pm.property_ids is null;
rollback;

\echo '=== B2d. CR09: el combo del martes se carga como cortesia automatica, solo recoger, todas las sucursales: nachos de pastor (orden completa) dispara 2 aguas de Jamaica, Horchata o Te ==='
begin;
select public.seed_pm_demo();
select count(*)::int as combo_martes_correcto_deberia_ser_1
  from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id
  where o.slug = 'los-taquitos-de-pm' and pm.code = 'MARTESNACHOSPM' and pm.type = 'cortesia' and pm.value = 1 and pm.auto_apply and pm.is_active
    and pm.channels = array['recoger']::text[] and pm.days_of_week = array[2]::smallint[] and pm.property_ids is null
    and pm.courtesy_quantity = 2
    and (select array_agg(pr.name order by pr.name) from restaurantes.products pr where pr.id = any(pm.product_ids)) = array['Nachos de Pastor']::text[]
    and (select array_agg(pr.name order by pr.name) from restaurantes.products pr where pr.id = any(pm.courtesy_product_ids)) = array['Agua de Jamaica', 'Horchata', 'Té']::text[];
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

\echo '=== B5. Zonas conocidas: 4 puntos de sucursales con coordenadas reales (T3 y T4 no las tienen; las de T5 son aproximadas y no entran) + 185 colonias SIN coordenadas (186 de la lista unica menos Francisco de Montejo, que ES el punto de T2) = 189 ==='
begin;
select public.seed_pm_demo();
select count(*)::int as zonas_deberia_ser_189 from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B6. Asignacion por colonia con la funcion SQL real: "Altabrisa" empata con la zona de Victory Altabrisa, pero esa sucursal esta inactiva: se asigna UNA activa de las dos mas cercanas (T7 a 1.83 km y T1 a 1.84 km; ambas redondean a 1.8 km y la funcion ordena por el valor redondeado sin desempate, asi que cual sale de las dos NO es determinista) y nunca la inactiva ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Altabrisa') n where n.slug = 'altabrisa') = 0
  and (select count(*) from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Altabrisa') n where n.slug in ('garcia-lavin', 'prol-montejo') and n.distance_km = 1.8) = 1
  and (select count(*) from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Altabrisa')) = 1
)::int as asigna_activa_mas_cercana_y_no_la_inactiva_deberia_ser_1;
rollback;

\echo '=== B8. Colonias (migracion 056): 185 sin coordenadas (0 coordenadas inventadas: las de colonias-v3 viven en los datos del seed, no en known_zone) con su procedencia y la referencia del piloto; los 4 puntos de sucursal conservan sus coordenadas ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.lat is null and z.lng is null) = 185
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.lat is not null and z.lng is not null) = 4
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.lat is null and z.fuente in ('piloto_original_merida_colonias', 'chats_t7') and z.asignacion_fuente is not null) = 185
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.fuente = 'chats_t7' and z.ref_sucursal_slug is null) = 2
)::int as colonias_sin_coordenadas_con_procedencia_deberia_ser_1;
rollback;

\echo '=== B9. Cobertura de entrega: 170 filas (166 colonias asignadas a su sucursal de despacho mas cercana a 8 km o menos + 4 puntos de sucursal); T7 cubre su punto y 23 colonias; las 19 que quedan FUERA de cobertura (13 a mas de 8 km y 6 sin coordenada) NO cubren ninguna; Galerias y Playa no reciben cobertura ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_delivery_zone bz join core.organization o on o.id = bz.organization_id where o.slug = 'los-taquitos-de-pm') = 170
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.branch_detail bd on bd.property_id = bz.property_id where bd.slug = 'garcia-lavin' and bd.organization_id = bz.organization_id) = 24
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.lat is null and z.asignacion_fuente = 'sin_asignar'
        and not exists (select 1 from restaurantes.branch_delivery_zone bz where bz.zone_id = z.id)) = 19
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.branch_detail bd on bd.property_id = bz.property_id where bd.slug in ('galerias', 'playa')) = 0
  and (select count(*) from (select zone_id from restaurantes.branch_delivery_zone group by zone_id having count(*) > 1) d) = 0
)::int as cobertura_correcta_deberia_ser_1;
rollback;

\echo '=== B10. La funcion SQL ignora las colonias sin coordenadas (silencio: ni distancia ni sucursal inventada) y prefiere la zona de nombre EXACTO sobre la mas larga que la contiene ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Temozón Norte')) = 0
  and (select count(*) from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'Colonia que no existe xyz')) = 0
)::int as colonias_sin_coordenadas_no_asignan_por_distancia_deberia_ser_1;
-- Exacto primero: con dos zonas con coordenadas, "Centro" gana "Centro" sobre "Centro Chichi Suarez".
insert into restaurantes.known_zone (organization_id, name, lat, lng)
  select o.id, x.name, x.lat, x.lng from core.organization o, (values ('Centro Chichi Suarez', 21.0500::numeric, -89.6500::numeric), ('Centro', 21.0200::numeric, -89.6200::numeric)) as x(name, lat, lng) where o.slug = 'los-taquitos-de-pm';
select (select recognized_zone_name from restaurantes.nearest_branch_by_colonia((select id from core.organization where slug = 'los-taquitos-de-pm'), 'centro')) as zona_exacta_deberia_ser_Centro;
rollback;

\echo '=== B11. Re-ejecutar el seed NO mueve lo que el dueño cambio: una colonia pasada de T7 a T1 sigue en T1 (no se duplica la cobertura) y una colonia nueva del dueño no se toca ==='
begin;
select public.seed_pm_demo();
update restaurantes.branch_delivery_zone bz set property_id = (select bd.property_id from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm' and bd.slug = 'prol-montejo')
  where bz.zone_id = (select z.id from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.name = 'Temozón Norte');
insert into restaurantes.known_zone (organization_id, name, lat, lng) select o.id, 'Colonia del dueño', 21.01, -89.60 from core.organization o where o.slug = 'los-taquitos-de-pm';
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id join restaurantes.branch_detail bd on bd.property_id = bz.property_id
     where z.name = 'Temozón Norte' and bd.slug = 'prol-montejo') = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id where z.name = 'Temozón Norte') = 1
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.name = 'Colonia del dueño' and z.lat = 21.01) = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join core.organization o on o.id = bz.organization_id where o.slug = 'los-taquitos-de-pm') = 170
)::int as no_pisa_decisiones_del_dueno_deberia_ser_1;
rollback;

\echo '=== B11b. Lista unica de colonias (colonias-v3): 164 a la sucursal de despacho mas cercana a 8 km o menos (zonas con procedencia mas_cercana_v3; Francisco de Montejo es el punto de T2) + 2 solo de los chats (Cabo Norte, Los Pinos: cobertura explicita del dueño) + 19 fuera de cobertura (sin cobertura); solo T1, T2, T3, T7 y T8 reciben colonias; Francisco de Montejo es el punto de T2 (una sola zona); Pensiones y Galerias son colonias (no el nombre de la sucursal) ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.asignacion_fuente = 'mas_cercana_v3') = 164
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.asignacion_fuente = 'chats_t7') = 2
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.asignacion_fuente = 'dueno_zona_centro') = 0
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.asignacion_fuente in ('mas_cercana_v3', 'chats_t7', 'dueno_zona_centro')
        and (select count(*) from restaurantes.branch_delivery_zone bz where bz.zone_id = z.id) <> 1) = 0
  and (select count(distinct bd.slug) from restaurantes.branch_delivery_zone bz join restaurantes.branch_detail bd on bd.property_id = bz.property_id) = 5
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.name = 'Francisco de Montejo') = 1
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.name in ('Pensiones', 'Galerias') and z.lat is null) = 2
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm' and z.name = 'Pensiones'
        and exists (select 1 from restaurantes.branch_delivery_zone bz join restaurantes.branch_detail bd on bd.property_id = bz.property_id where bz.zone_id = z.id and bd.slug = 'pensiones')) = 1
)::int as lista_unica_de_colonias_deberia_ser_1;
rollback;

\echo '=== B11c. Conocimiento del negocio (migracion 053): 3 entradas publicadas e importadas para toda la organizacion; re-ejecutar el seed no duplica ni pisa lo que el dueño edito ==='
begin;
select public.seed_pm_demo();
update restaurantes.conocimiento_negocio set texto = 'Texto editado por el dueño' where titulo = 'Oficina matriz';
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.conocimiento_negocio c join core.organization o on o.id = c.organization_id where o.slug = 'los-taquitos-de-pm') = 3
  and (select count(*) from restaurantes.conocimiento_negocio c join core.organization o on o.id = c.organization_id
        where o.slug = 'los-taquitos-de-pm' and c.property_id is null and c.tipo = 'faq' and c.estado = 'publicado' and c.origen = 'importado' and c.activo) = 3
  and (select count(*) from restaurantes.conocimiento_negocio where titulo = 'Oficina matriz' and texto = 'Texto editado por el dueño') = 1
)::int as conocimiento_publicado_y_sin_pisar_deberia_ser_1;
rollback;

\echo '=== B11d. Re-ejecutar el seed sobre un estado parecido al de la cuenta real NO cambia nada de lo existente: T2 y T8 siguen ACTIVAS, la procedencia (asignacion_fuente) de zonas con cobertura no se toca, una pendiente que la base real ya cubre sigue cubierta, y solo una zona SIN cobertura recibe la suya (con su procedencia) ==='
begin;
select public.seed_pm_demo();
-- Estado "real" simulado: T2 y T8 activas (en la cuenta real lo estan; los datos las traen inactivas).
update core.property p set status = 'active' from core.organization o where o.id = p.organization_id and o.slug = 'los-taquitos-de-pm' and p.name in ('Francisco de Montejo', 'Victory Altabrisa');
-- Procedencia variada de zonas ya cubiertas.
update restaurantes.known_zone z set asignacion_fuente = 'distancia_piloto' where z.name = 'Alcala Martin';
update restaurantes.known_zone z set asignacion_fuente = 'reasignada_desde_galerias' where z.name = 'Andalucia';
-- Cobertura real distinta de la del seed: Andalucia en T2 (el seed la manda a T7).
update restaurantes.branch_delivery_zone bz set property_id = (select bd.property_id from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm' and bd.slug = 'fco-montejo')
  where bz.zone_id = (select z.id from restaurantes.known_zone z where z.name = 'Andalucia');
-- Una colonia fuera de cobertura del seed (Mulchechen, a mas de 8 km) que la base real YA cubre con T1, con su procedencia propia.
update restaurantes.known_zone z set asignacion_fuente = 'distancia_piloto' where z.name = 'Mulchechen';
insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
  select bd.property_id, z.id, z.organization_id from restaurantes.known_zone z, restaurantes.branch_detail bd
  where z.name = 'Mulchechen' and bd.slug = 'prol-montejo' and bd.organization_id = z.organization_id;
-- Una zona de la lista SIN cobertura en la base real (el seed si le agrega la suya).
delete from restaurantes.branch_delivery_zone bz where bz.zone_id = (select z.id from restaurantes.known_zone z where z.name = 'Caucel');
update restaurantes.known_zone z set asignacion_fuente = 'sin_asignar' where z.name = 'Caucel';
select public.seed_pm_demo();
select (
  (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm' and p.status = 'active' and p.name in ('Francisco de Montejo', 'Victory Altabrisa')) = 2
  and (select count(*) from restaurantes.known_zone z where z.name = 'Alcala Martin' and z.asignacion_fuente = 'distancia_piloto') = 1
  and (select count(*) from restaurantes.known_zone z where z.name = 'Andalucia' and z.asignacion_fuente = 'reasignada_desde_galerias') = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id join restaurantes.branch_detail bd on bd.property_id = bz.property_id where z.name = 'Andalucia' and bd.slug = 'fco-montejo') = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id where z.name = 'Andalucia') = 1
  and (select count(*) from restaurantes.known_zone z where z.name = 'Mulchechen' and z.asignacion_fuente = 'distancia_piloto') = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id join restaurantes.branch_detail bd on bd.property_id = bz.property_id where z.name = 'Mulchechen' and bd.slug = 'prol-montejo') = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id where z.name = 'Mulchechen') = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id join restaurantes.branch_detail bd on bd.property_id = bz.property_id where z.name = 'Caucel' and bd.slug = 'fco-montejo') = 1
  and (select count(*) from restaurantes.known_zone z where z.name = 'Caucel' and z.asignacion_fuente = 'mas_cercana_v3') = 1
  and (select count(*) from restaurantes.branch_delivery_zone bz join core.organization o on o.id = bz.organization_id where o.slug = 'los-taquitos-de-pm') = 171
)::int as reejecutar_sobre_estado_real_no_cambia_lo_existente_deberia_ser_1;
rollback;

\echo '=== B12. RECHAZADO (debe fallar): lat sin lng viola el check ambas-o-ninguna de la migracion 056 ==='
begin;
-- as should_fail (el insert de abajo viola el check y termina el escenario con ERROR)
select public.seed_pm_demo();
insert into restaurantes.known_zone (organization_id, name, lat, lng) select o.id, 'Solo lat', 21.0, null from core.organization o where o.slug = 'los-taquitos-de-pm';
rollback;

\echo '=== B7. La voz sembrada sale del perfil de WhatsApp: trae FLUJO y ESCALACION, cabe en el tope de 8000 (check de la migracion 025), dice que el combo del martes lo aplica cotizar_pedido (ya cargado) y no nombra herramientas inexistentes ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm'
     and vc.comportamiento like '%# FLUJO DE TOMA DE PEDIDO%' and vc.comportamiento like '%# ESCALACIÓN A HUMANO%'
     and vc.comportamiento like '%Combo del martes%lo aplica cotizar_pedido%' and char_length(vc.comportamiento) <= 8000) = 3
  and (select count(*) from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm'
     and (vc.comportamiento ~* 'la confirma la sucursal al recoger|no lo prometa ni lo aplique|asignar_sucursal|crear_comanda|consultar_menu|\{\{')) = 0
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
  and (select count(*) from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm') = 1628
  and (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'los-taquitos-de-pm') = 189
  and (select count(*) from restaurantes.branch_delivery_zone bz join core.organization o on o.id = bz.organization_id where o.slug = 'los-taquitos-de-pm') = 170
  and (select count(*) from restaurantes.branch_policy bp join core.organization o on o.id = bp.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from restaurantes.branch_voice_config vc join core.organization o on o.id = vc.organization_id where o.slug = 'los-taquitos-de-pm') = 3
  and (select count(*) from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id where o.slug = 'los-taquitos-de-pm') = 2
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
-- version anterior del seed: el 2x1 con alcance a T2, T3 y T4 (migracion 038); el seed actual lo deja sin alcance (todas las sucursales).
update restaurantes.promotions set property_ids = (select array_agg(bd.property_id) from restaurantes.branch_detail bd where bd.slug in ('fco-montejo', 'pensiones', 'galerias') and bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm')) where code = 'LUNES2X1PM' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm');
select public.seed_pm_demo();
select (
  (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm') = 7
  and (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm' and p.name in ('Galerías', 'García Lavín (Victory Platz)')) = 2
  and (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'los-taquitos-de-pm' and p.name in ('T4 (pendiente de datos)', 'Victory Platz (García Lavín)')) = 0
  and (select count(*) from restaurantes.branch_detail bd join core.organization o on o.id = bd.organization_id where o.slug = 'los-taquitos-de-pm' and bd.slug in ('t4-pendiente')) = 0
  and (select property_ids is null from restaurantes.promotions where code = 'LUNES2X1PM' and organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm'))
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

\echo '=== C6. CR reconciliacion: re-aplicar el seed BORRA de branch_products lo que el plan ya no vende en una sucursal (Heineken Silver en T2 de la version anterior), repara el precio de lo que si vende y NO toca lo que el dueño agrego ni otra organizacion ==='
begin;
select public.seed_pm_demo();
-- Version anterior del seed: T2 vendia Heineken Silver y T3 el taco al pastor a $36 (lista 2025).
insert into restaurantes.branch_products (property_id, product_id, price, is_available)
  select bd.property_id, pr.id, 90, true
  from restaurantes.branch_detail bd join restaurantes.products pr on pr.organization_id = bd.organization_id
  where bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'fco-montejo' and pr.name = 'Heineken Silver';
update restaurantes.branch_products bp set price = 36
  from restaurantes.branch_detail bd, restaurantes.products pr
  where bd.property_id = bp.property_id and pr.id = bp.product_id and bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'pensiones' and pr.name = 'Taco Al Pastor (individual)';
-- Lo que el dueño agrego por su cuenta: un producto que el seed NO conoce, con fila en T2 y en T3.
insert into restaurantes.products (id, organization_id, name, price) values ('00000000-0000-0000-0000-0000000e00d1', (select id from core.organization where slug = 'los-taquitos-de-pm'), 'Producto agregado por el dueno', 55);
insert into restaurantes.branch_products (property_id, product_id, price, is_available)
  select bd.property_id, '00000000-0000-0000-0000-0000000e00d1', 55, true from restaurantes.branch_detail bd where bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug in ('fco-montejo', 'pensiones');
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'fco-montejo' and pr.name = 'Heineken Silver') = 0
  and (select bp.price from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id where bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'pensiones' and pr.name = 'Taco Al Pastor (individual)') = 42
  and (select count(*) from restaurantes.branch_products where product_id = '00000000-0000-0000-0000-0000000e00d1') = 2
  and (select count(*) from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id where bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'fco-montejo' and bp.product_id <> '00000000-0000-0000-0000-0000000e00d1') = 265
  and (select count(*) from restaurantes.branch_products where property_id = '00000000-0000-0000-0000-0000000e00b1') = 0
)::int as reconciliacion_acotada_deberia_ser_1;
rollback;

\echo '=== C7. Reconciliacion: un producto que vuelve al plan despues de haberse quitado se reinserta DISPONIBLE (no queda una fila apagada que nadie vuelve a prender) ==='
begin;
select public.seed_pm_demo();
delete from restaurantes.branch_products bp using restaurantes.branch_detail bd, restaurantes.products pr
  where bd.property_id = bp.property_id and pr.id = bp.product_id and bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'pensiones' and pr.name = 'Ensalada de PM';
select public.seed_pm_demo();
select count(*)::int as producto_reinsertado_disponible_deberia_ser_1
  from restaurantes.branch_products bp join restaurantes.branch_detail bd on bd.property_id = bp.property_id join restaurantes.products pr on pr.id = bp.product_id
  where bd.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'pensiones' and pr.name = 'Ensalada de PM' and bp.is_available and bp.price = 206;
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

\echo '=== D5. CROSS-TENANT: el staff de la otra organizacion no ve las colonias ni la cobertura sembradas (RLS: 0 filas) ==='
begin;
select public.seed_pm_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
select (
  (select count(*) from restaurantes.known_zone z where z.organization_id <> '00000000-0000-0000-0000-0000000e0002')
  + (select count(*) from restaurantes.branch_delivery_zone bz where bz.organization_id <> '00000000-0000-0000-0000-0000000e0002')
)::int as zonas_y_cobertura_ajenas_visibles_deberia_ser_0;
rollback;

\echo '=== D6. RECHAZADO (debe fallar): anon no lee las colonias ==='
begin;
select public.seed_pm_demo();
set local role anon;
select count(*)::int as should_fail from restaurantes.known_zone;
rollback;

\echo '=== D7. RECHAZADO (debe fallar): el owner de otra organizacion no puede escribir las columnas de procedencia (GRANT por columna de la 056) ==='
begin;
-- as should_fail (sin GRANT de insert sobre la columna fuente, el insert de abajo termina con ERROR)
select public.seed_pm_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
insert into restaurantes.known_zone (organization_id, name, lat, lng, fuente) values ('00000000-0000-0000-0000-0000000e0002', 'Zona con fuente', 21.0, -89.6, 'inventada');
rollback;

\echo '=== D8. POSITIVO: el owner de su organizacion si da de alta una zona (organization_id, name, lat, lng) con el grant por columna ==='
begin;
select public.seed_pm_demo();
set local role authenticated;
select set_config('request.jwt.claim.sub', '00000000-0000-0000-0000-0000000e0014', true);
insert into restaurantes.known_zone (organization_id, name, lat, lng) values ('00000000-0000-0000-0000-0000000e0002', 'Zona del owner', 21.0, -89.6) returning name as zona_creada;
rollback;

\echo '=== E1. El agente de WhatsApp queda configurado: perfil taqueria_pm, tono formal, sin nombre inventado, promociones cargadas (lunes y martes), tiempo de entrega del dueño y espera de rafagas de 6 s ==='
begin;
select public.seed_pm_demo();
select (
  select count(*) from restaurantes.whatsapp_agent_config c join core.organization o on o.id = c.organization_id
  where o.slug = 'los-taquitos-de-pm' and c.property_id is null and c.perfil = 'taqueria_pm' and c.tone_style = 'formal_directo'
    and c.business_name = 'Los Taquitos de PM' and c.agent_name is null and c.enabled
    and c.escalation_reasons_off = '{}' and c.delivery_time_text = 'de 40 a 50 minutos para recoger y a domicilio; más en hora pico'
    and c.promos_text ilike '%lunes 2x1%' and c.promos_text ilike '%martes nachos de pastor con 2 aguas%' and c.promos_text ilike '%todas las sucursales%'
    and c.salsas_text ilike '%guacamolera%' and c.reply_debounce_seconds = 6
)::int as config_agente_deberia_ser_1;
rollback;

\echo '=== E2. Re-ejecutar el seed NO pisa lo que el dueño cambio en el editor del agente ==='
begin;
select public.seed_pm_demo();
update restaurantes.whatsapp_agent_config set tone_style = 'calido_cercano', agent_name = 'Lupita' where perfil = 'taqueria_pm' and property_id is null;
select public.seed_pm_demo();
select count(*)::int as decision_del_dueno_intacta_deberia_ser_1 from restaurantes.whatsapp_agent_config where tone_style = 'calido_cercano' and agent_name = 'Lupita';
rollback;

\echo '=== E3. Cargar como DEMO crea la organizacion -demo con su marca y su propia configuracion de agente ==='
begin;
select public.seed_pm_demo_marcado();
select (
  select count(*) from restaurantes.demo_organization d join core.organization o on o.id = d.organization_id
  where o.slug = 'los-taquitos-de-pm-demo' and o.name = 'Los Taquitos de PM (demo)' and d.activo and d.seed_version = '2026-10-03'
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

\echo '=== E9. CR14/CR15: T7 tiene su fila propia de agente con los tiempos medidos en sus chats (copia de la fila de la organizacion salvo delivery_time_text) y la organizacion lleva el dato del dueño ==='
begin;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.whatsapp_agent_config c where c.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and c.property_id is not null) = 1
  and (select count(*) from restaurantes.whatsapp_agent_config c join restaurantes.branch_detail bd on bd.property_id = c.property_id
       join restaurantes.whatsapp_agent_config o on o.organization_id = c.organization_id and o.property_id is null
       where c.organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and bd.slug = 'garcia-lavin' and c.perfil = 'taqueria_pm' and c.enabled
         and c.delivery_time_text = 'a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)'
         and c.promos_text = o.promos_text and c.salsas_text = o.salsas_text and c.tone_style = o.tone_style and c.business_name = o.business_name
         and c.reply_debounce_seconds = 6) = 1
)::int as fila_propia_de_t7_deberia_ser_1;
rollback;

\echo '=== E10. Re-ejecutar NO pisa lo que el dueño edito en NINGUNA de las dos filas (tiempo de entrega, promociones, espera de rafagas, tiempo propio de T7) ==='
begin;
select public.seed_pm_demo();
update restaurantes.whatsapp_agent_config set delivery_time_text = 'texto del dueno', promos_text = 'promo del dueno', reply_debounce_seconds = 3 where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is null;
update restaurantes.whatsapp_agent_config set delivery_time_text = 'tiempo de T7 del dueno' where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is not null;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.whatsapp_agent_config where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is null and delivery_time_text = 'texto del dueno' and promos_text = 'promo del dueno' and reply_debounce_seconds = 3) = 1
  and (select count(*) from restaurantes.whatsapp_agent_config where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is not null and delivery_time_text = 'tiempo de T7 del dueno') = 1
  and (select count(*) from restaurantes.whatsapp_agent_config where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm')) = 2
)::int as ediciones_del_dueno_intactas_deberia_ser_1;
rollback;

\echo '=== E11. La cuenta real YA sembrada por la version anterior recibe la correccion: si la fila conserva EXACTAMENTE los textos que sembro el seed viejo (y no tiene espera de rafagas), se actualizan; el resto de la fila no cambia ==='
begin;
select public.seed_pm_demo();
update restaurantes.whatsapp_agent_config
  set delivery_time_text = 'a domicilio de 60 a 75 min (pico: 75 a 90); para recoger de 25 a 35 min (pico: 45 a 60)',
      promos_text = 'lunes 2x1 en tacos al pastor, solo para recoger, en Francisco de Montejo, Pensiones y Galerías',
      reply_debounce_seconds = null, agent_name = 'Lupita'
  where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is null;
delete from restaurantes.whatsapp_agent_config where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is not null;
select public.seed_pm_demo();
select (
  (select count(*) from restaurantes.whatsapp_agent_config where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is null
     and delivery_time_text = 'de 40 a 50 minutos para recoger y a domicilio; más en hora pico'
     and promos_text like 'lunes 2x1 en tacos al pastor y martes nachos de pastor con 2 aguas%' and reply_debounce_seconds = 6 and agent_name = 'Lupita') = 1
  and (select count(*) from restaurantes.whatsapp_agent_config where organization_id = (select id from core.organization where slug = 'los-taquitos-de-pm') and property_id is not null) = 1
)::int as correccion_aplicada_sin_pisar_el_resto_deberia_ser_1;
rollback;
