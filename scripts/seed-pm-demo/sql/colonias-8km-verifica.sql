-- VERIFICACION (solo lectura) de la cobertura de colonias de Los Taquitos de PM contra la regla de 8 km. GENERADO por
-- scripts/seed-pm-demo/generar-colonias-8km.ts desde scripts/seed-pm-demo/data/pm-seed-data.json: NO lo edite a mano (una prueba falla si se desincroniza).
--
-- Ejecutar:  supabase db query --linked -f colonias-8km-verifica.sql
--
-- RECALCULA EN LA BASE la sucursal de despacho mas cercana de cada colonia (Haversine, radio terrestre 6371.0088 km, SQL puro) desde los pines de
-- las 5 sucursales de despacho y las coordenadas de las 173 colonias (Google/OSM/promedio de colonias-v3; known_zone NO guarda coordenadas a proposito)
-- y lo compara con restaurantes.branch_delivery_zone. No escribe nada.
--
-- Lectura del resultado (columnas seccion, clave, a, b, c):
--   resumen / <categoria> / n   : ok | ok_fuera_de_cobertura | explicita_dueno_ok | pendiente_sin_cobertura | pendiente_con_cobertura | DIFERENCIA | zona_inexistente
--   resumen / PASA o FALLA / n  : FALLA si hay alguna DIFERENCIA o zona_inexistente. DIFERENCIA = una colonia asignada que no tiene exactamente su sucursal, una
--                                 explicita del dueño que no tiene la suya, o una colonia a MAS DE 8 KM que todavia tiene cobertura. Las explicitas del dueño
--                                 (Centro, Centro Historico, Benito Juarez Norte, Real Montejo, Cabo Norte, Los Pinos) se comparan con SU sucursal, no con la mas cercana.
--                                 'pendiente_*' = sin coordenada o homonimo pendiente (San Jose): no se asignan; si hoy tienen cobertura se listan, no cuentan como FALLA.
--   DIFERENCIA / <colonia> / esperado / cargado / km   (idem para zona_inexistente y pendiente_con_cobertura)
--   cobertura_por_sucursal / <slug> / filas
with pines (id, slug, lat, lng) as (
  values
  ('T1', 'prol-montejo', 21.0093272, -89.6135974),
  ('T2', 'fco-montejo', 21.0302178, -89.6470973),
  ('T3', 'pensiones', 20.995212, -89.6476676),
  ('T7', 'garcia-lavin', 21.0325451, -89.6026621),
  ('T8', 'altabrisa', 21.0265048, -89.5725175)
), colonias (nombre, lat, lng, origen) as (
  values
  ('Alcala Martin', 20.9912236, -89.6198676, 'google'),
  ('Alemán', 20.991245, -89.601513, 'osm'),
  ('Algarrobos Residencial', 21.0486967, -89.594384, 'google'),
  ('Altabrisa', 21.022574, -89.585655, 'osm'),
  ('Andalucia', 21.058228, -89.625728, 'osm'),
  ('Andria', 21.0227362, -89.5386896, 'google'),
  ('Arboledas', 20.9811332, -89.6060334, 'google'),
  ('Aurea Residencial', 21.0377248, -89.6349271, 'google'),
  ('Azcorra', 20.951694, -89.6027948, 'google'),
  ('Benito Juárez Oriente', 20.9583189, -89.5692164, 'google'),
  ('Bojórquez', 20.9771327, -89.6510504, 'google'),
  ('Buenavista', 20.9994186, -89.619279, 'google'),
  ('Camara de Comercio Norte', 21.0161152, -89.5895436, 'google'),
  ('Campestre', 21.0113353, -89.6169246, 'google'),
  ('Caucel', 21.0150679, -89.7045111, 'google'),
  ('Ceiba II', 21.0986922, -89.6018023, 'google'),
  ('Centro Chichi Suarez', 21.00009, -89.547913, 'osm'),
  ('Cerrada Lombardia', 21.0236276, -89.5388408, 'google'),
  ('Cerrada Piemonte', 21.0218919, -89.5398278, 'google'),
  ('Cerrada Veneto', 21.0222415, -89.5376026, 'google'),
  ('Cerradas de Gran Santa Fe', 21.012796, -89.69151, 'osm'),
  ('Chablekal', 21.0961842, -89.5756987, 'google'),
  ('Chichi Suarez', 21.0007586, -89.5568382, 'google'),
  ('Chicxulub', 21.2930955, -89.6136226, 'google'),
  ('Chicxulub Puerto', 21.2930955, -89.6136226, 'google'),
  ('Cholul', 21.0411724, -89.5550539, 'google'),
  ('Chuburná', 21.021813, -89.634204, 'osm'),
  ('Chuminópolis', 20.9725515, -89.6004394, 'google'),
  ('Ciudad Caucel', 20.9921202, -89.6957222, 'google'),
  ('Cloverleaf', 21.0347622, -89.5484971, 'google'),
  ('Del Norte', 21.0091117, -89.6222219, 'google'),
  ('Delio Moreno Canton', 20.9413282, -89.632226, 'google'),
  ('Dolores Otero', 20.9428006, -89.6239875, 'google'),
  ('Dzitya', 21.0553576, -89.6677323, 'promedio'),
  ('Dzitya Poligono Chuburna', 21.05904, -89.6357, 'google'),
  ('El Fenix', 20.978861, -89.604514, 'osm'),
  ('Emiliano Zapata Norte', 21.0135894, -89.6101149, 'google'),
  ('Ferrocarrilera Hector Victoria Aguilar', 20.979833, -89.611103, 'osm'),
  ('Floresta Residencial', 21.0130493, -89.5553643, 'google'),
  ('Fraccionamiento Francisco de Montejo', 21.0327894, -89.6500968, 'google'),
  ('García Ginerés', 20.9890152, -89.632226, 'google'),
  ('Gonzalo Guerrero', 21.0262536, -89.6239875, 'google'),
  ('Gran Herradura Norte', 20.9852828, -89.7011576, 'google'),
  ('Gran Santa Fe', 21.0077498, -89.6857343, 'google'),
  ('Gran Santa Fe II', 21.0218221, -89.693505, 'google'),
  ('Guadalupe', 21.041812, -89.550033, 'osm'),
  ('Hacienda Xcumpich', 21.0326024, -89.6379451, 'google'),
  ('Inalambrica', 20.9815864, -89.6428159, 'google'),
  ('Itzimná', 20.9934364, -89.6098603, 'google'),
  ('Jardines de Mérida', 20.9993534, -89.5910162, 'google'),
  ('Jardines de Miraflores', 20.9606298, -89.6004394, 'google'),
  ('Jardines de Vista Alegre I', 21.009392, -89.5824745, 'google'),
  ('Jardines de Vista Alegre II', 21.010506, -89.5810016, 'google'),
  ('Jesús Carranza', 20.9844896, -89.6075053, 'google'),
  ('Juan Pablo II', 20.966754, -89.6780947, 'google'),
  ('Komchen', 21.1030877, -89.6613591, 'google'),
  ('La Castellana', 21.0414594, -89.6363974, 'google'),
  ('La Ceiba', 21.0913888, -89.6294444, 'google'),
  ('La Ciudadela', 20.996988, -89.686282, 'osm'),
  ('La Huerta', 20.983386, -89.613687, 'google'),
  ('Las Américas', 21.0725195, -89.6557551, 'google'),
  ('Las Americas II', 21.0799734, -89.6569312, 'google'),
  ('Las Americas Merida', 21.069227, -89.655764, 'osm'),
  ('Leandro Valle', 20.996315, -89.5674483, 'google'),
  ('Lomas del Sur', 20.9462017, -89.6466393, 'google'),
  ('Los Heroes', 20.9891255, -89.538319, 'google'),
  ('Los Reyes', 20.951458, -89.643627, 'osm'),
  ('Lourdes', 20.9600896, -89.6085357, 'google'),
  ('Lourdes Industrial', 20.9766666, -89.6077997, 'google'),
  ('Mallorca', 21.016872, -89.554928, 'osm'),
  ('Manzana 115', 20.9450773, -89.6434041, 'google'),
  ('Maximo Ancona', 20.9807436, -89.5986727, 'google'),
  ('Meliton Salazar', 20.944657, -89.6375888, 'google'),
  ('México', 21.002291, -89.610683, 'osm'),
  ('México Norte', 21.0142891, -89.6051502, 'google'),
  ('Mexico Oriente', 21.0001276, -89.6033837, 'google'),
  ('México Poniente', 20.957044, -89.6657507, 'google'),
  ('Miguel Hidalgo', 20.9912887, -89.6504623, 'google'),
  ('Miraflores', 20.9554455, -89.5963659, 'google'),
  ('Montealban', 21.0194954, -89.6010283, 'google'),
  ('Montebello', 21.0306572, -89.5945502, 'google'),
  ('Montebello II', 21.030655, -89.588224, 'osm'),
  ('Montecarlo', 21.0291357, -89.5815907, 'google'),
  ('Montecristo', 21.014875, -89.595858, 'osm'),
  ('Montereal', 21.0224621, -89.5951391, 'google'),
  ('Montes de Ame', 21.0307114, -89.6181018, 'google'),
  ('Montevideo', 21.0135094, -89.5904272, 'google'),
  ('Morelos Oriente', 20.9457167, -89.5957281, 'google'),
  ('Mulchechen', 20.935741, -89.59438, 'osm'),
  ('Mulsay', 20.9607426, -89.6522267, 'google'),
  ('Nucleo Sodzil', 21.055203, -89.628443, 'osm'),
  ('Nueva Alemán', 20.9870667, -89.5942557, 'google'),
  ('Nueva Reforma Agraria', 20.9511144, -89.6822085, 'google'),
  ('Nuevo Yucatan', 20.9993364, -89.5839473, 'google'),
  ('Obrera', 20.9428505, -89.6475216, 'google'),
  ('Opichen', 20.9481274, -89.6786824, 'google'),
  ('Paraiso Santa Fe', 21.0152936, -89.6854064, 'google'),
  ('Parque Central', 21.029801, -89.5414, 'osm'),
  ('Parque Industrial', 21.0657959, -89.6384993, 'google'),
  ('Parque Natura', 21.0351097, -89.5438211, 'google'),
  ('Pedregales de Circuito', 20.9414739, -89.6477425, 'google'),
  ('Pedregales las Americas', 21.0672322, -89.6627494, 'google'),
  ('Piedrasul', 21.031855, -89.637648, 'osm'),
  ('Plan de Ayala', 21.0135825, -89.6222219, 'google'),
  ('Privada del Carmen', 20.9775033, -89.6451916, 'google'),
  ('Privada las Acacias', 21.0044217, -89.5412269, 'google'),
  ('Progreso', 21.2811908, -89.6651628, 'google'),
  ('Puerta de Piedra Dzitya', 21.0461635, -89.6622834, 'google'),
  ('Punta Esmeralda', 20.9853665, -89.5490651, 'google'),
  ('Quinta Real', 21.100182, -89.622424, 'osm'),
  ('Real de Dzitya', 21.0549396, -89.6687407, 'google'),
  ('Real San Jose', 20.949109, -89.589378, 'osm'),
  ('Reparto Dolores Patron Peniche', 20.990155, -89.625312, 'osm'),
  ('Residencial Pensiones', 21.0047222, -89.6610472, 'google'),
  ('Residencial San Antonio', 21.0216595, -89.600421, 'google'),
  ('Revolucion', 21.036778, -89.628205, 'osm'),
  ('Rinconada de Chuburna', 21.0210594, -89.6339912, 'google'),
  ('Roble Agrícola', 20.9160872, -89.6780947, 'google'),
  ('Royal del Parque', 21.060636, -89.638343, 'osm'),
  ('Salvador Alvarado Sur', 20.9367811, -89.5980838, 'google'),
  ('Sambula', 20.9547722, -89.6475216, 'google'),
  ('San Angel', 20.987627, -89.558866, 'osm'),
  ('San Antonio Cinta', 21.0075734, -89.6010283, 'google'),
  ('San Antonio Cucul', 21.0224841, -89.6045613, 'google'),
  ('San Antonio Xluch', 20.8985258, -89.6503097, 'google'),
  ('San Aroldo', 20.9241021, -89.5927832, 'google'),
  ('San Esteban', 20.995632, -89.5927832, 'google'),
  ('San Jose Tzal', 20.8221658, -89.6557551, 'google'),
  ('San Jose Vergel', 20.9576215, -89.58866, 'google'),
  ('San Lorenzo', 20.9689352, -89.6504623, 'google'),
  ('San Luis', 20.9969168, -89.6258975, 'promedio'),
  ('San Pedro Cholul', 21.0246026, -89.5568382, 'google'),
  ('San Pedro Noh Pat', 20.9455992, -89.5485839, 'google'),
  ('San Ramon', 21.019799, -89.608224, 'osm'),
  ('San Ramon Norte', 21.0232361, -89.6075053, 'google'),
  ('Santa Cecilia', 20.9813366, -89.6135398, 'google'),
  ('Santa Gertrudis', 21.042389, -89.600787, 'osm'),
  ('Santa Gertrudis Copo', 21.0381057, -89.5933722, 'google'),
  ('Santa Maria Chi', 21.0319445, -89.4819444, 'google'),
  ('Santa Maria de Guadalupe', 20.949181, -89.644021, 'osm'),
  ('Santa Rosa', 20.942785, -89.6169246, 'google'),
  ('Serapio Rendón', 20.9286268, -89.6163359, 'google'),
  ('Sitpach', 21.0277294, -89.5208718, 'google'),
  ('Sodzil', 21.0441317, -89.6216334, 'google'),
  ('Sodzil Norte', 21.0441317, -89.6216334, 'google'),
  ('Sol Campestre', 21.0224759, -89.6010283, 'google'),
  ('Susula', 20.9734953, -89.6974845, 'google'),
  ('Tamarindos', 21.047411, -89.653294, 'osm'),
  ('Tecnologico', 21.0107873, -89.6217805, 'google'),
  ('Temozón Norte', 21.0635129, -89.6039584, 'promedio'),
  ('Tixcuytun', 21.0661111, -89.5700001, 'google'),
  ('Vergel', 20.958338, -89.584342, 'osm'),
  ('Vergel II', 20.9516494, -89.5839473, 'google'),
  ('Via Montejo', 21.045303, -89.631874, 'google'),
  ('Vicente Solis', 20.9509584, -89.6069165, 'google'),
  ('Villa Fontana', 20.97201, -89.6079469, 'google'),
  ('Villa Magna', 20.9548366, -89.6804455, 'google'),
  ('Villareal', 21.035739, -89.604346, 'osm'),
  ('Villas Cholul', 21.0453084, -89.5395857, 'google'),
  ('Villas del Rey', 21.0183725, -89.6170656, 'google'),
  ('Villas la Hacienda', 21.0195225, -89.6128039, 'google'),
  ('Vista Alegre', 21.0105204, -89.5868928, 'google'),
  ('Vista Alegre Norte', 21.0253941, -89.5751094, 'google'),
  ('Waspa', 20.969808, -89.60668, 'osm'),
  ('Xaman Kab', 21.0341275, -89.6033238, 'google'),
  ('Xaman Tan', 21.033774, -89.6026375, 'google'),
  ('Xcanatun', 21.077403, -89.6307013, 'google'),
  ('Xcumpich', 21.0352207, -89.6357563, 'google'),
  ('Xo Tik', 21.060153, -89.644329, 'osm'),
  ('Yucalpeten', 20.980935, -89.661193, 'osm'),
  ('Francisco de Montejo', 21.0307721, -89.6463452, 'google'),
  ('Galerias', 21.03467, -89.63442, 'osm'),
  ('Pensiones', 20.9994644, -89.6404628, 'google')
), pendientes (nombre) as (
  values
  ('Cecilio Chi'),
  ('Nueva Salvador Alvarado Sur'),
  ('Olivos'),
  ('Revolución Cordemex'),
  ('San Diego Cutz'),
  ('San Jose'),
  ('Yucatán')
), explicitas (nombre, slug) as (
  values
  ('Benito Juárez Norte', 'garcia-lavin'),
  ('Cabo Norte', 'garcia-lavin'),
  ('Centro', 'prol-montejo'),
  ('Centro Histórico', 'prol-montejo'),
  ('Los Pinos', 'altabrisa'),
  ('Real Montejo', 'garcia-lavin')
), dist as (
  select c.nombre, p.id, p.slug,
         2 * 6371.0088 * asin(least(1, sqrt(
           power(sin(radians(p.lat - c.lat) / 2), 2)
           + cos(radians(c.lat)) * cos(radians(p.lat)) * power(sin(radians(p.lng - c.lng) / 2), 2)))) as km
  from colonias c cross join pines p
), orden as (
  select d.*, row_number() over (partition by d.nombre order by round(d.km::numeric, 9), d.id) as rn from dist d
), esperado as (
  -- la mas cercana, solo si esta a 8 km o menos (limite inclusivo)
  select nombre, slug, km, (km <= 8 + 0.000000001) as dentro from orden where rn = 1
), org as (
  select id from core.organization where slug = 'los-taquitos-de-pm'
), zonas as (
  select z.id, z.name from restaurantes.known_zone z join org on z.organization_id = org.id
), cargado as (
  select zn.name, string_agg(bd.slug, ',' order by bd.slug) as slugs
  from zonas zn
  join restaurantes.branch_delivery_zone b on b.zone_id = zn.id
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  group by zn.name
), universo as (
  select e.nombre, case when e.dentro then e.slug end as esperado_slug, e.km, 'mas_cercana'::text as tipo from esperado e
  union all select s.nombre, null, null, 'pendiente' from pendientes s
  union all select x.nombre, x.slug, null, 'explicita' from explicitas x
), juicio as (
  select u.nombre, u.tipo, u.esperado_slug, u.km, c.slugs as cargado_slugs, (select count(*) from zonas z where z.name = u.nombre) as zonas_n,
         case
           when (select count(*) from zonas z where z.name = u.nombre) <> 1 then 'zona_inexistente'
           when u.tipo = 'explicita' then case when c.slugs is not distinct from u.esperado_slug then 'explicita_dueno_ok' else 'DIFERENCIA' end
           when u.tipo = 'pendiente' then case when c.slugs is null then 'pendiente_sin_cobertura' else 'pendiente_con_cobertura' end
           when u.esperado_slug is null then case when c.slugs is null then 'ok_fuera_de_cobertura' else 'DIFERENCIA' end
           when c.slugs is not distinct from u.esperado_slug then 'ok'
           else 'DIFERENCIA'
         end as categoria
  from universo u left join cargado c on c.name = u.nombre
)
select seccion, clave, a, b, c from (
  select 'resumen' as seccion, categoria as clave, count(*)::text as a, null::text as b, null::text as c, 1 as orden from juicio group by categoria
  union all
  select 'resumen', case when count(*) filter (where categoria in ('DIFERENCIA', 'zona_inexistente')) = 0 then 'PASA' else 'FALLA' end,
         count(*) filter (where categoria in ('DIFERENCIA', 'zona_inexistente'))::text, null, null, 0 from juicio
  union all
  select categoria, nombre, coalesce(esperado_slug, '-'), coalesce(cargado_slugs, '-'), round(km::numeric, 2)::text, 2
  from juicio where categoria in ('DIFERENCIA', 'zona_inexistente', 'pendiente_con_cobertura')
  union all
  select 'cobertura_por_sucursal', bd.slug, count(*)::text, null, null, 3
  from restaurantes.branch_delivery_zone b join org on b.organization_id = org.id join restaurantes.branch_detail bd on bd.property_id = b.property_id
  group by bd.slug
  union all
  select 'cobertura_total', 'filas', count(*)::text, null, null, 3
  from restaurantes.branch_delivery_zone b join org on b.organization_id = org.id
) r
order by orden, seccion, clave;
