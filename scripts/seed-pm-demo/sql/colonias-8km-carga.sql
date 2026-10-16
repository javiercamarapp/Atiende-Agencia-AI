-- Cobertura de colonias de Los Taquitos de PM: sucursal de despacho ACTIVA mas cercana a 8 km o menos (Haversine desde los pines de Google de las sucursales
-- hasta la coordenada de cada colonia). GENERADO por scripts/seed-pm-demo/generar-colonias-8km.ts a partir de scripts/seed-pm-demo/data/pm-seed-data.json:
-- NO lo edite a mano (una prueba falla si se desincroniza). Documento con la tabla completa: docs/restaurantes-colonias-radio-8km.md.
--
-- Ejecutar:  supabase db query --linked -f colonias-8km-carga.sql      (desde una carpeta ligada al proyecto)
--
-- IDEMPOTENTE: la 2.a corrida no cambia nada (0 altas, 0 reemplazos, 0 metadatos). Una sola transaccion: cualquier comprobacion que falle ABORTA todo.
-- NO hace DELETE masivo: solo retira (a) las filas de cobertura de una colonia ASIGNADA que
-- apuntan a OTRA sucursal que la esperada (reemplazos; esperados en la base real del 8-oct-2026: 20) y (b) TODA la cobertura, de cualquier sucursal, de las colonias a MAS DE 8 KM de toda
-- sucursal de despacho (retiros: 3, a saber Mulchechen T1, Salvador Alvarado Sur T3, Santa Maria Chi T8); si hubiera mas de lo esperado en cualquiera de los dos, aborta.
-- Las colonias SIN coordenada (pendientes del dueño) y las explicitas del dueño no se tocan: el SELECT final lista las sin coordenada que hoy tienen cobertura.
-- Esperado sobre la base real de 169 filas: +25 altas, -20 reemplazos, -3 retiros, 171 filas al terminar.
-- Actualiza known_zone.asignacion_fuente SOLO en las zonas cuya cobertura cambia (sobrescribe su procedencia anterior: sin_asignar, ambigua_cubierta_por_dos,
-- distancia_piloto, mas_cercana_osm_v2b, reasignada_desde_galerias); NO toca ninguna etiqueta dueno_zona_centro ni chats_t7; las retiradas quedan 'sin_asignar'.
-- NO escribe lat/lng en known_zone ni toca branch_detail, estado de sucursales, whatsapp_branch_channel ni la cuenta demo.

begin;

set local lock_timeout = '15s';

create temp table _cob8 (
  zona text not null,
  sucursal_slug text not null,
  km numeric,
  regla text not null,
  primary key (zona, sucursal_slug)
) on commit drop;

-- 166 colonias asignadas (166 pares colonia-sucursal): la mas cercana a 8 km o menos, mas las 2 coberturas explicitas del dueño sin coordenada (Cabo Norte, Los Pinos).
insert into _cob8 (zona, sucursal_slug, km, regla) values
  ('Alcala Martin', 'prol-montejo', 2.11564948, 'mas_cercana_v3'),
  ('Alemán', 'prol-montejo', 2.369899679, 'mas_cercana_v3'),
  ('Algarrobos Residencial', 'garcia-lavin', 1.990882121, 'mas_cercana_v3'),
  ('Altabrisa', 'altabrisa', 1.43191371, 'mas_cercana_v3'),
  ('Andalucia', 'garcia-lavin', 3.726340694, 'mas_cercana_v3'),
  ('Andria', 'altabrisa', 3.535998028, 'mas_cercana_v3'),
  ('Arboledas', 'prol-montejo', 3.231878932, 'mas_cercana_v3'),
  ('Aurea Residencial', 'fco-montejo', 1.514002267, 'mas_cercana_v3'),
  ('Azcorra', 'prol-montejo', 6.505930395, 'mas_cercana_v3'),
  ('Benito Juárez Norte', 'garcia-lavin', 1.610989627, 'chats_t7'),
  ('Benito Juárez Oriente', 'prol-montejo', 7.307582375, 'mas_cercana_v3'),
  ('Bojórquez', 'pensiones', 2.040775493, 'mas_cercana_v3'),
  ('Buenavista', 'prol-montejo', 1.249713819, 'mas_cercana_v3'),
  ('Cabo Norte', 'garcia-lavin', null, 'chats_t7'),
  ('Camara de Comercio Norte', 'altabrisa', 2.111330966, 'mas_cercana_v3'),
  ('Campestre', 'prol-montejo', 0.411266436, 'mas_cercana_v3'),
  ('Caucel', 'fco-montejo', 6.192727688, 'mas_cercana_v3'),
  ('Ceiba II', 'garcia-lavin', 7.355773151, 'mas_cercana_v3'),
  ('Centro', 'prol-montejo', 4.880831023, 'dueno_zona_centro'),
  ('Centro Chichi Suarez', 'altabrisa', 3.892274712, 'mas_cercana_v3'),
  ('Centro Histórico', 'prol-montejo', 4.655925428, 'dueno_zona_centro'),
  ('Cerrada Lombardia', 'altabrisa', 3.509986672, 'mas_cercana_v3'),
  ('Cerrada Piemonte', 'altabrisa', 3.431504962, 'mas_cercana_v3'),
  ('Cerrada Veneto', 'altabrisa', 3.654783073, 'mas_cercana_v3'),
  ('Cerradas de Gran Santa Fe', 'pensiones', 4.953369927, 'mas_cercana_v3'),
  ('Chablekal', 'garcia-lavin', 7.609386253, 'mas_cercana_v3'),
  ('Chichi Suarez', 'altabrisa', 3.29313089, 'mas_cercana_v3'),
  ('Cholul', 'altabrisa', 2.438261695, 'mas_cercana_v3'),
  ('Chuburná', 'fco-montejo', 1.632250892, 'mas_cercana_v3'),
  ('Chuminópolis', 'prol-montejo', 4.311399548, 'mas_cercana_v3'),
  ('Ciudad Caucel', 'pensiones', 5.000570071, 'mas_cercana_v3'),
  ('Cloverleaf', 'altabrisa', 2.656742586, 'mas_cercana_v3'),
  ('Del Norte', 'prol-montejo', 0.895570792, 'mas_cercana_v3'),
  ('Delio Moreno Canton', 'pensiones', 6.202425826, 'mas_cercana_v3'),
  ('Dolores Otero', 'pensiones', 6.325318608, 'mas_cercana_v3'),
  ('Dzitya', 'fco-montejo', 3.521418332, 'mas_cercana_v3'),
  ('Dzitya Poligono Chuburna', 'fco-montejo', 3.416182428, 'mas_cercana_v3'),
  ('El Fenix', 'prol-montejo', 3.516485056, 'mas_cercana_v3'),
  ('Emiliano Zapata Norte', 'prol-montejo', 0.596061504, 'mas_cercana_v3'),
  ('Ferrocarrilera Hector Victoria Aguilar', 'prol-montejo', 3.289817234, 'mas_cercana_v3'),
  ('Floresta Residencial', 'altabrisa', 2.325618518, 'mas_cercana_v3'),
  ('Fraccionamiento Francisco de Montejo', 'fco-montejo', 0.422707357, 'mas_cercana_v3'),
  ('García Ginerés', 'pensiones', 1.744886568, 'mas_cercana_v3'),
  ('Gonzalo Guerrero', 'prol-montejo', 2.16921756, 'mas_cercana_v3'),
  ('Gran Herradura Norte', 'pensiones', 5.6618286, 'mas_cercana_v3'),
  ('Gran Santa Fe', 'pensiones', 4.190364092, 'mas_cercana_v3'),
  ('Gran Santa Fe II', 'fco-montejo', 4.906357849, 'mas_cercana_v3'),
  ('Guadalupe', 'altabrisa', 2.888364459, 'mas_cercana_v3'),
  ('Hacienda Xcumpich', 'fco-montejo', 0.986199988, 'mas_cercana_v3'),
  ('Inalambrica', 'pensiones', 1.596631647, 'mas_cercana_v3'),
  ('Itzimná', 'prol-montejo', 1.809064356, 'mas_cercana_v3'),
  ('Jardines de Mérida', 'prol-montejo', 2.593194295, 'mas_cercana_v3'),
  ('Jardines de Miraflores', 'prol-montejo', 5.584567456, 'mas_cercana_v3'),
  ('Jardines de Vista Alegre I', 'altabrisa', 2.165412304, 'mas_cercana_v3'),
  ('Jardines de Vista Alegre II', 'altabrisa', 1.985016815, 'mas_cercana_v3'),
  ('Jesús Carranza', 'prol-montejo', 2.833304266, 'mas_cercana_v3'),
  ('Juan Pablo II', 'pensiones', 4.4713315, 'mas_cercana_v3'),
  ('La Castellana', 'fco-montejo', 1.672035652, 'mas_cercana_v3'),
  ('La Ceiba', 'fco-montejo', 7.044252922, 'mas_cercana_v3'),
  ('La Ciudadela', 'pensiones', 4.013509674, 'mas_cercana_v3'),
  ('La Huerta', 'prol-montejo', 2.884548812, 'mas_cercana_v3'),
  ('Las Américas', 'fco-montejo', 4.788778112, 'mas_cercana_v3'),
  ('Las Americas II', 'fco-montejo', 5.625903362, 'mas_cercana_v3'),
  ('Las Americas Merida', 'fco-montejo', 4.42989156, 'mas_cercana_v3'),
  ('Leandro Valle', 'altabrisa', 3.397946287, 'mas_cercana_v3'),
  ('Lomas del Sur', 'pensiones', 5.45075002, 'mas_cercana_v3'),
  ('Los Heroes', 'altabrisa', 5.466051779, 'mas_cercana_v3'),
  ('Los Pinos', 'altabrisa', null, 'chats_t7'),
  ('Los Reyes', 'pensiones', 4.883283937, 'mas_cercana_v3'),
  ('Lourdes', 'prol-montejo', 5.500140993, 'mas_cercana_v3'),
  ('Lourdes Industrial', 'prol-montejo', 3.681235664, 'mas_cercana_v3'),
  ('Mallorca', 'altabrisa', 2.116707719, 'mas_cercana_v3'),
  ('Manzana 115', 'pensiones', 5.592280639, 'mas_cercana_v3'),
  ('Maximo Ancona', 'prol-montejo', 3.535889818, 'mas_cercana_v3'),
  ('Meliton Salazar', 'pensiones', 5.71804406, 'mas_cercana_v3'),
  ('México', 'prol-montejo', 0.838844605, 'mas_cercana_v3'),
  ('México Norte', 'prol-montejo', 1.035976716, 'mas_cercana_v3'),
  ('Mexico Oriente', 'prol-montejo', 1.473278268, 'mas_cercana_v3'),
  ('México Poniente', 'pensiones', 4.64083322, 'mas_cercana_v3'),
  ('Miguel Hidalgo', 'pensiones', 0.523918632, 'mas_cercana_v3'),
  ('Miraflores', 'prol-montejo', 6.252773247, 'mas_cercana_v3'),
  ('Montealban', 'garcia-lavin', 1.460937267, 'mas_cercana_v3'),
  ('Montebello', 'garcia-lavin', 0.867691326, 'mas_cercana_v3'),
  ('Montebello II', 'garcia-lavin', 1.513161921, 'mas_cercana_v3'),
  ('Montecarlo', 'altabrisa', 0.986102228, 'mas_cercana_v3'),
  ('Montecristo', 'prol-montejo', 1.941956131, 'mas_cercana_v3'),
  ('Montereal', 'garcia-lavin', 1.366278536, 'mas_cercana_v3'),
  ('Montes de Ame', 'garcia-lavin', 1.615368556, 'mas_cercana_v3'),
  ('Montevideo', 'altabrisa', 2.354524526, 'mas_cercana_v3'),
  ('Morelos Oriente', 'prol-montejo', 7.312446576, 'mas_cercana_v3'),
  ('Mulsay', 'pensiones', 3.861945935, 'mas_cercana_v3'),
  ('Nucleo Sodzil', 'fco-montejo', 3.386212076, 'mas_cercana_v3'),
  ('Nueva Alemán', 'prol-montejo', 3.187236153, 'mas_cercana_v3'),
  ('Nueva Reforma Agraria', 'pensiones', 6.07497931, 'mas_cercana_v3'),
  ('Nuevo Yucatan', 'altabrisa', 3.245610383, 'mas_cercana_v3'),
  ('Obrera', 'pensiones', 5.822360928, 'mas_cercana_v3'),
  ('Opichen', 'pensiones', 6.146642971, 'mas_cercana_v3'),
  ('Paraiso Santa Fe', 'fco-montejo', 4.308647955, 'mas_cercana_v3'),
  ('Parque Central', 'altabrisa', 3.250414832, 'mas_cercana_v3'),
  ('Parque Industrial', 'fco-montejo', 4.055483254, 'mas_cercana_v3'),
  ('Parque Natura', 'altabrisa', 3.12826611, 'mas_cercana_v3'),
  ('Pedregales de Circuito', 'pensiones', 5.975417402, 'mas_cercana_v3'),
  ('Pedregales las Americas', 'fco-montejo', 4.42474167, 'mas_cercana_v3'),
  ('Piedrasul', 'fco-montejo', 0.997476925, 'mas_cercana_v3'),
  ('Plan de Ayala', 'prol-montejo', 1.012589344, 'mas_cercana_v3'),
  ('Privada del Carmen', 'pensiones', 1.985827932, 'mas_cercana_v3'),
  ('Privada las Acacias', 'altabrisa', 4.071690558, 'mas_cercana_v3'),
  ('Puerta de Piedra Dzitya', 'fco-montejo', 2.37229532, 'mas_cercana_v3'),
  ('Punta Esmeralda', 'altabrisa', 5.181857198, 'mas_cercana_v3'),
  ('Quinta Real', 'garcia-lavin', 7.795421204, 'mas_cercana_v3'),
  ('Real de Dzitya', 'fco-montejo', 3.549911984, 'mas_cercana_v3'),
  ('Real Montejo', 'garcia-lavin', 6.882195169, 'chats_t7'),
  ('Real San Jose', 'prol-montejo', 7.152549715, 'mas_cercana_v3'),
  ('Reparto Dolores Patron Peniche', 'pensiones', 2.387988262, 'mas_cercana_v3'),
  ('Residencial Pensiones', 'pensiones', 1.745682624, 'mas_cercana_v3'),
  ('Residencial San Antonio', 'garcia-lavin', 1.232572234, 'mas_cercana_v3'),
  ('Revolucion', 'fco-montejo', 2.092055744, 'mas_cercana_v3'),
  ('Rinconada de Chuburna', 'fco-montejo', 1.699265672, 'mas_cercana_v3'),
  ('Royal del Parque', 'fco-montejo', 3.502241807, 'mas_cercana_v3'),
  ('Sambula', 'pensiones', 4.496732356, 'mas_cercana_v3'),
  ('San Angel', 'altabrisa', 4.549356412, 'mas_cercana_v3'),
  ('San Antonio Cinta', 'prol-montejo', 1.319212421, 'mas_cercana_v3'),
  ('San Antonio Cucul', 'garcia-lavin', 1.135966941, 'mas_cercana_v3'),
  ('San Esteban', 'prol-montejo', 2.643399819, 'mas_cercana_v3'),
  ('San Jose Vergel', 'prol-montejo', 6.30546455, 'mas_cercana_v3'),
  ('San Lorenzo', 'pensiones', 2.936222132, 'mas_cercana_v3'),
  ('San Luis', 'prol-montejo', 1.880067941, 'mas_cercana_v3'),
  ('San Pedro Cholul', 'altabrisa', 1.641070304, 'mas_cercana_v3'),
  ('San Ramon', 'prol-montejo', 1.29110353, 'mas_cercana_v3'),
  ('San Ramon Norte', 'garcia-lavin', 1.150715707, 'mas_cercana_v3'),
  ('Santa Cecilia', 'prol-montejo', 3.112422757, 'mas_cercana_v3'),
  ('Santa Gertrudis', 'garcia-lavin', 1.11175773, 'mas_cercana_v3'),
  ('Santa Gertrudis Copo', 'garcia-lavin', 1.145381101, 'mas_cercana_v3'),
  ('Santa Maria de Guadalupe', 'pensiones', 5.132405454, 'mas_cercana_v3'),
  ('Santa Rosa', 'pensiones', 6.646344207, 'mas_cercana_v3'),
  ('Sitpach', 'altabrisa', 5.362071538, 'mas_cercana_v3'),
  ('Sodzil', 'garcia-lavin', 2.352967391, 'mas_cercana_v3'),
  ('Sodzil Norte', 'garcia-lavin', 2.352967391, 'mas_cercana_v3'),
  ('Sol Campestre', 'garcia-lavin', 1.132413781, 'mas_cercana_v3'),
  ('Susula', 'pensiones', 5.707969705, 'mas_cercana_v3'),
  ('Tamarindos', 'fco-montejo', 2.017068626, 'mas_cercana_v3'),
  ('Tecnologico', 'prol-montejo', 0.864803524, 'mas_cercana_v3'),
  ('Temozón Norte', 'garcia-lavin', 3.446093729, 'mas_cercana_v3'),
  ('Tixcuytun', 'altabrisa', 4.411767611, 'mas_cercana_v3'),
  ('Vergel', 'prol-montejo', 6.432056344, 'mas_cercana_v3'),
  ('Vergel II', 'prol-montejo', 7.114011356, 'mas_cercana_v3'),
  ('Via Montejo', 'fco-montejo', 2.304306838, 'mas_cercana_v3'),
  ('Vicente Solis', 'pensiones', 6.489718046, 'mas_cercana_v3'),
  ('Villa Fontana', 'prol-montejo', 4.190748573, 'mas_cercana_v3'),
  ('Villa Magna', 'pensiones', 5.633647369, 'mas_cercana_v3'),
  ('Villareal', 'garcia-lavin', 0.395817411, 'mas_cercana_v3'),
  ('Villas Cholul', 'altabrisa', 4.00664059, 'mas_cercana_v3'),
  ('Villas del Rey', 'prol-montejo', 1.068278268, 'mas_cercana_v3'),
  ('Villas la Hacienda', 'prol-montejo', 1.136655314, 'mas_cercana_v3'),
  ('Vista Alegre', 'altabrisa', 2.320665922, 'mas_cercana_v3'),
  ('Vista Alegre Norte', 'altabrisa', 0.296012783, 'mas_cercana_v3'),
  ('Waspa', 'prol-montejo', 4.452634935, 'mas_cercana_v3'),
  ('Xaman Kab', 'garcia-lavin', 0.188882264, 'mas_cercana_v3'),
  ('Xaman Tan', 'garcia-lavin', 0.136671484, 'mas_cercana_v3'),
  ('Xcanatun', 'fco-montejo', 5.515744217, 'mas_cercana_v3'),
  ('Xcumpich', 'fco-montejo', 1.301884877, 'mas_cercana_v3'),
  ('Xo Tik', 'fco-montejo', 3.341021629, 'mas_cercana_v3'),
  ('Yucalpeten', 'pensiones', 2.119427703, 'mas_cercana_v3'),
  ('Francisco de Montejo', 'fco-montejo', 0.099459366, 'mas_cercana_v3'),
  ('Galerias', 'fco-montejo', 1.405793382, 'mas_cercana_v3'),
  ('Pensiones', 'pensiones', 0.884871811, 'mas_cercana_v3');

create temp table _sin8 (zona text primary key, motivo text not null) on commit drop;

-- 20 colonias FUERA de cobertura: 13 a mas de 8 km de toda sucursal de despacho, 6 sin coordenada (no se estiman a mano) y 1 homonimo pendiente del dueño (San Jose).
insert into _sin8 (zona, motivo) values
  ('Cecilio Chi', 'sin_coordenada'),
  ('Chicxulub', 'fuera_de_8km'),
  ('Chicxulub Puerto', 'fuera_de_8km'),
  ('Komchen', 'fuera_de_8km'),
  ('Mulchechen', 'fuera_de_8km'),
  ('Nueva Salvador Alvarado Sur', 'sin_coordenada'),
  ('Olivos', 'sin_coordenada'),
  ('Progreso', 'fuera_de_8km'),
  ('Revolución Cordemex', 'sin_coordenada'),
  ('Roble Agrícola', 'fuera_de_8km'),
  ('Salvador Alvarado Sur', 'fuera_de_8km'),
  ('San Antonio Xluch', 'fuera_de_8km'),
  ('San Aroldo', 'fuera_de_8km'),
  ('San Diego Cutz', 'sin_coordenada'),
  ('San Jose', 'homonimo_pendiente'),
  ('San Jose Tzal', 'fuera_de_8km'),
  ('San Pedro Noh Pat', 'fuera_de_8km'),
  ('Santa Maria Chi', 'fuera_de_8km'),
  ('Serapio Rendón', 'fuera_de_8km'),
  ('Yucatán', 'sin_coordenada');

create temp table _cambiadas (zone_id uuid primary key, regla text not null) on commit drop;

do $carga$
declare
  v_org uuid;
  v_n integer;
  v_altas integer;
  v_reemplazos integer;
  v_meta integer;
  v_total integer;
  c_max_reemplazos constant integer := 20;
  c_max_retiros constant integer := 3;
  v_retiros integer;
begin
  select o.id into v_org from core.organization o where o.slug = 'los-taquitos-de-pm';
  if v_org is null then
    raise exception 'colonias 8 km: no existe la organizacion los-taquitos-de-pm';
  end if;

  -- 1. Las 5 sucursales de despacho existen y estan ACTIVAS (T2 y T8 incluidas).
  select count(*) into v_n
  from core.property p join restaurantes.branch_detail bd on bd.property_id = p.id
  where p.organization_id = v_org and p.status = 'active' and bd.slug in ('prol-montejo', 'fco-montejo', 'pensiones', 'garcia-lavin', 'altabrisa');
  if v_n <> 5 then
    raise exception 'colonias 8 km: se esperaban 5 sucursales de despacho activas y hay %', v_n;
  end if;

  -- 2. Cada colonia de la lista existe EXACTAMENTE una vez en known_zone (no se crean zonas ni se adivinan nombres).
  select count(*) into v_n
  from (select zona from _cob8 union select zona from _sin8) l
  where (select count(*) from restaurantes.known_zone z where z.organization_id = v_org and z.name = l.zona) <> 1;
  if v_n <> 0 then
    raise exception 'colonias 8 km: % colonias de la lista no existen una sola vez en known_zone', v_n;
  end if;

  -- 3. Antes: ninguna cobertura en sucursales sin reparto (Galerias, Playa).
  select count(*) into v_n
  from restaurantes.branch_delivery_zone b join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where b.organization_id = v_org and bd.slug in ('galerias', 'playa');
  if v_n <> 0 then
    raise exception 'colonias 8 km: hay % coberturas en sucursales que no reparten (Galerias/Playa)', v_n;
  end if;

  -- 4. Reemplazos: filas de colonias asignadas que apuntan a una sucursal distinta de la esperada. Tope exacto de la base real conocida.
  select count(*) into v_reemplazos
  from restaurantes.branch_delivery_zone b
  join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where b.organization_id = v_org
    and exists (select 1 from _cob8 c where c.zona = z.name)
    and not exists (select 1 from _cob8 c where c.zona = z.name and c.sucursal_slug = bd.slug);
  if v_reemplazos > c_max_reemplazos then
    raise exception 'colonias 8 km: % reemplazos superan el tope de % (la base cambio; revise antes de seguir)', v_reemplazos, c_max_reemplazos;
  end if;

  with sobra as (
    select b.property_id, b.zone_id
    from restaurantes.branch_delivery_zone b
    join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
    join restaurantes.branch_detail bd on bd.property_id = b.property_id
    where b.organization_id = v_org
      and exists (select 1 from _cob8 c where c.zona = z.name)
      and not exists (select 1 from _cob8 c where c.zona = z.name and c.sucursal_slug = bd.slug)
  ), borradas as (
    delete from restaurantes.branch_delivery_zone b using sobra s
    where b.property_id = s.property_id and b.zone_id = s.zone_id and b.organization_id = v_org
    returning b.zone_id
  )
  insert into _cambiadas (zone_id, regla)
  select distinct b.zone_id, 'mas_cercana_v3' from borradas b
  on conflict (zone_id) do nothing;

  -- 4b. Retiros: la cobertura de colonias a mas de 8 km de toda sucursal de despacho (orden de Javier: fuera de cobertura). Tope exacto.
  select count(*) into v_retiros
  from restaurantes.branch_delivery_zone b
  join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
  where b.organization_id = v_org and exists (select 1 from _sin8 s where s.zona = z.name and s.motivo = 'fuera_de_8km');
  if v_retiros > c_max_retiros then
    raise exception 'colonias 8 km: % retiros superan el tope de % (la base cambio; revise antes de seguir)', v_retiros, c_max_retiros;
  end if;

  with retiradas as (
    delete from restaurantes.branch_delivery_zone b using restaurantes.known_zone z
    where z.id = b.zone_id and z.organization_id = v_org and b.organization_id = v_org
      and exists (select 1 from _sin8 s where s.zona = z.name and s.motivo = 'fuera_de_8km')
    returning b.zone_id
  )
  insert into _cambiadas (zone_id, regla)
  select distinct r.zone_id, 'sin_asignar' from retiradas r
  on conflict (zone_id) do nothing;

  -- 5. Altas: una fila por (colonia, sucursal esperada) que falte. Idempotente (on conflict do nothing).
  with nuevas as (
    insert into restaurantes.branch_delivery_zone (property_id, zone_id, organization_id)
    select bd.property_id, z.id, v_org
    from _cob8 c
    join restaurantes.known_zone z on z.organization_id = v_org and z.name = c.zona
    join restaurantes.branch_detail bd on bd.organization_id = v_org and bd.slug = c.sucursal_slug
    on conflict (property_id, zone_id) do nothing
    returning zone_id
  )
  insert into _cambiadas (zone_id, regla)
  select distinct n.zone_id, 'mas_cercana_v3' from nuevas n
  on conflict (zone_id) do nothing;

  select count(*) into v_altas from _cambiadas;

  -- 6. Procedencia (solo lectura para el reporte de colonias ambiguas): unicamente las zonas cuya cobertura cambio en esta corrida.
  update restaurantes.known_zone z
     set asignacion_fuente = coalesce((select max(c.regla) from _cob8 c where c.zona = z.name), k.regla)
    from _cambiadas k
   where z.id = k.zone_id and z.organization_id = v_org
     and z.asignacion_fuente is distinct from coalesce((select max(c.regla) from _cob8 c where c.zona = z.name), k.regla);
  get diagnostics v_meta = row_count;

  -- 7. Despues: cada colonia asignada tiene EXACTAMENTE sus sucursales esperadas (ni una mas, ni una menos).
  select count(*) into v_n
  from (select distinct zona from _cob8) l
  where (select coalesce(string_agg(bd.slug, ',' order by bd.slug), '')
           from restaurantes.branch_delivery_zone b
           join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org and z.name = l.zona
           join restaurantes.branch_detail bd on bd.property_id = b.property_id
          where b.organization_id = v_org)
        <> (select string_agg(c.sucursal_slug, ',' order by c.sucursal_slug) from _cob8 c where c.zona = l.zona);
  if v_n <> 0 then
    raise exception 'colonias 8 km: % colonias no quedaron con la cobertura esperada; se aborta y se deshace todo', v_n;
  end if;

  select count(*) into v_n
  from restaurantes.branch_delivery_zone b join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where b.organization_id = v_org and bd.slug in ('galerias', 'playa');
  if v_n <> 0 then
    raise exception 'colonias 8 km: Galerias o Playa quedaron con cobertura (%)', v_n;
  end if;

  -- 8. Ninguna colonia a mas de 8 km conserva cobertura.
  select count(*) into v_n
  from restaurantes.branch_delivery_zone b join restaurantes.known_zone z on z.id = b.zone_id and z.organization_id = v_org
  where b.organization_id = v_org and exists (select 1 from _sin8 s where s.zona = z.name and s.motivo = 'fuera_de_8km');
  if v_n <> 0 then
    raise exception 'colonias 8 km: % coberturas de colonias a mas de 8 km no se retiraron', v_n;
  end if;

  select count(*) into v_total from restaurantes.branch_delivery_zone b where b.organization_id = v_org;
  raise notice 'colonias 8 km: zonas con cobertura cambiada=% (reemplazos retirados=%, retiros fuera de 8 km=%), metadatos de procedencia actualizados=%, filas de cobertura totales=%', v_altas, v_reemplazos, v_retiros, v_meta, v_total;
end
$carga$;

commit;

-- Resultado (una sola consulta; solo lectura): cobertura por sucursal y las colonias SIN coordenada que hoy tienen cobertura (pendientes del dueño; no se tocan).
select seccion, clave, valor
from (
  select 'cobertura_por_sucursal' as seccion, bd.slug as clave, count(*)::text as valor
  from restaurantes.branch_delivery_zone b
  join core.organization o on o.id = b.organization_id and o.slug = 'los-taquitos-de-pm'
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  group by bd.slug
  union all
  select 'cobertura_total', 'filas', count(*)::text
  from restaurantes.branch_delivery_zone b join core.organization o on o.id = b.organization_id and o.slug = 'los-taquitos-de-pm'
  union all
  select 'pendiente_sin_coordenada_con_cobertura', z.name, string_agg(bd.slug, ',' order by bd.slug)
  from restaurantes.known_zone z
  join core.organization o on o.id = z.organization_id and o.slug = 'los-taquitos-de-pm'
  join restaurantes.branch_delivery_zone b on b.zone_id = z.id
  join restaurantes.branch_detail bd on bd.property_id = b.property_id
  where z.name in ('Cecilio Chi', 'Nueva Salvador Alvarado Sur', 'Olivos', 'Revolución Cordemex', 'San Diego Cutz', 'San Jose', 'Yucatán')
  group by z.name
) x
order by seccion, clave;
