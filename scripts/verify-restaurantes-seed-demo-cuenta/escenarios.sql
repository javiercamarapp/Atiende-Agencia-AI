-- Escenarios contra Postgres REAL del seed de la cuenta demo FICTICIA "El Tizon Norteño" (bloque plpgsql generado
-- arriba: public.seed_demo_cuenta()). Cada escenario corre en su propio `begin; ... rollback;` y ejecuta el seed
-- dentro de la transaccion. `\set ON_ERROR_STOP off`: un escenario "RECHAZADO" termina en ERROR real.
--
--   A. Resultado: 6 sucursales, 289 productos (33 de alcohol => no_domicilio), 1666 precios por sucursal.
--   B. Voz DESHABILITADA con voice_id valido (columna NOT NULL de la migracion 025), promociones y conocimiento.
--   C. Idempotencia: correrlo dos veces deja los mismos conteos; no reactiva la voz.
--   D. Aislamiento: la demo vieja (slug demo-restaurantes, "Taqueria Demo") queda intacta; un slug de otra vertical aborta.
\set ON_ERROR_STOP off
\pset pager off

-- La demo vieja (Taqueria Demo): una organizacion, una sucursal y un producto que el seed jamas debe tocar.
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0001', 'restaurantes', 'Taqueria Demo', 'demo-restaurantes')
on conflict do nothing;
insert into core.property (id, organization_id, name) values
  ('00000000-0000-0000-0000-0000000d00b1', '00000000-0000-0000-0000-0000000d0001', 'Monterrey Obispado')
on conflict do nothing;
insert into restaurantes.products (id, organization_id, name, price) values
  ('00000000-0000-0000-0000-0000000d00c1', '00000000-0000-0000-0000-0000000d0001', 'Taco Al Pastor (individual)', 999)
on conflict do nothing;

\echo '=== A1. 6 sucursales ==='
begin;
select public.seed_demo_cuenta();
select count(*)::int as sucursales_deberia_ser_6 from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'demo-cadena';
rollback;

\echo '=== A2. 289 productos ==='
begin;
select public.seed_demo_cuenta();
select count(*)::int as productos_deberia_ser_289 from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'demo-cadena';
rollback;

\echo '=== A3. 1666 precios por sucursal ==='
begin;
select public.seed_demo_cuenta();
select count(*)::int as precios_deberia_ser_1666 from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'demo-cadena';
rollback;

\echo '=== A4. 33 productos de alcohol no_domicilio ==='
begin;
select public.seed_demo_cuenta();
select count(*) filter (where pr.no_domicilio)::int as alcohol_no_domicilio_deberia_ser_33 from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'demo-cadena';
rollback;

\echo '=== B1. Voz deshabilitada en las 6 sucursales y con voice_id (Kore) ==='
begin;
select public.seed_demo_cuenta();
select count(*) filter (where not v.habilitado and v.voice_id = 'Kore')::int as voz_deshabilitada_con_voz_deberia_ser_6
  from restaurantes.branch_voice_config v join core.organization o on o.id = v.organization_id where o.slug = 'demo-cadena';
rollback;

\echo '=== B2. 5 promociones y 22 piezas de conocimiento publicadas ==='
begin;
select public.seed_demo_cuenta();
select count(*)::int as promociones_deberia_ser_5 from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id where o.slug = 'demo-cadena';
select count(*)::int as conocimiento_deberia_ser_22 from restaurantes.conocimiento_negocio c join core.organization o on o.id = c.organization_id
  where o.slug = 'demo-cadena' and c.property_id is null and c.estado = 'publicado' and c.activo;
rollback;

\echo '=== C1. Idempotencia: la segunda corrida deja EXACTAMENTE los mismos conteos (sucursales, productos, precios, politicas, voz, zonas, cobertura, promociones, conocimiento, agente, marca demo) ==='
begin;
create function pg_temp.huella_demo() returns text language sql as $f$
  select concat_ws('|',
    (select count(*) from core.property p join core.organization o on o.id = p.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from core.organization where slug = 'demo-cadena'),
    (select count(*) from restaurantes.products pr join core.organization o on o.id = pr.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.branch_products bp join core.property p on p.id = bp.property_id join core.organization o on o.id = p.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.branch_policy bp join core.organization o on o.id = bp.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.branch_voice_config v join core.organization o on o.id = v.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.known_zone z join core.organization o on o.id = z.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.branch_delivery_zone bz join restaurantes.known_zone z on z.id = bz.zone_id join core.organization o on o.id = z.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.promotions pm join core.organization o on o.id = pm.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.conocimiento_negocio c join core.organization o on o.id = c.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.whatsapp_agent_config w join core.organization o on o.id = w.organization_id where o.slug = 'demo-cadena'),
    (select count(*) from restaurantes.demo_organization d join core.organization o on o.id = d.organization_id where o.slug = 'demo-cadena'))
$f$;
select public.seed_demo_cuenta();
create temp table huella1 as select pg_temp.huella_demo() as h;
select public.seed_demo_cuenta();
select ((select h from huella1) = pg_temp.huella_demo())::int as misma_huella_deberia_ser_1;
select h as huella from huella1;
rollback;

\echo '=== C2. Re-ejecutar no reactiva la voz que el operador habilito ==='
begin;
select public.seed_demo_cuenta();
update restaurantes.branch_voice_config v set habilitado = true from core.organization o where o.id = v.organization_id and o.slug = 'demo-cadena';
select public.seed_demo_cuenta();
select count(*) filter (where v.habilitado)::int as voz_habilitada_se_conserva_deberia_ser_6
  from restaurantes.branch_voice_config v join core.organization o on o.id = v.organization_id where o.slug = 'demo-cadena';
rollback;

\echo '=== D1. La Taqueria Demo (demo-restaurantes) queda intacta: sin sucursales, productos ni precios nuevos ==='
begin;
select public.seed_demo_cuenta();
select count(*)::int as sucursales_demo_vieja_deberia_ser_1 from core.property where organization_id = '00000000-0000-0000-0000-0000000d0001';
select count(*)::int as productos_demo_vieja_deberia_ser_1 from restaurantes.products where organization_id = '00000000-0000-0000-0000-0000000d0001';
select count(*)::int as precio_demo_vieja_intacto_deberia_ser_1 from restaurantes.products where id = '00000000-0000-0000-0000-0000000d00c1' and price = 999;
select count(*)::int as precios_demo_vieja_deberia_ser_0 from restaurantes.branch_products where property_id = '00000000-0000-0000-0000-0000000d00b1';
rollback;

\echo '=== D2. RECHAZADO: el slug demo-cadena ya existe en OTRA vertical ==='
begin;
insert into core.organization (id, vertical, name, slug) values
  ('00000000-0000-0000-0000-0000000d0002', 'citas', 'Otra vertical', 'demo-cadena');
select public.seed_demo_cuenta() as should_fail;
rollback;
