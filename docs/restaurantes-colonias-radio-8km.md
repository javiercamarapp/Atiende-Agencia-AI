# Colonias de Los Taquitos de PM: sucursal más cercana en un radio de 8 km

Generado por `scripts/seed-pm-demo/generar-colonias-8km.ts` desde `scripts/seed-pm-demo/data/pm-seed-data.json` (no se edita a mano; una prueba falla si se desincroniza).
Decisión de Javier (7-oct-2026 13:30 y 17:50; 8-oct-2026 resolvió los pendientes) y del despachador de la otra vertical.

## Regla

1. Cada colonia se asigna a la sucursal de **despacho activa más cercana**, en línea recta (Haversine, radio terrestre 6371.0088 km), desde el pin de la sucursal hasta la coordenada de la colonia, si está a **8 km o menos** (el límite es inclusivo: 8.00 km entra, 8.01 km no).
2. Despachan T1, T2, T3, T7 y T8 (las cinco activas). Galerías (T4) y Playa/Chicxulub (T5) están inactivas y **no reciben colonias**.
3. Las colonias a más de 8 km de toda sucursal de despacho quedan **fuera de cobertura** (no se asignan; se listan abajo). Las que no tienen coordenada tampoco se asignan: las coordenadas nunca se estiman a mano.
4. Empate exacto de distancia: gana la primera en el orden T1, T2, T3, T7, T8. Se marca **borde** cuando la colonia queda a 300 m o menos del límite de 8 km, o cuando la segunda sucursal (también dentro de 8 km) está a 300 m o menos de la primera.
5. Cobertura explícita del dueño: solo **Cabo Norte (T7)** y **Los Pinos (T8)**, que aparecen únicamente en los chats del dueño y no tienen coordenada, así que no hay distancia que comparar. Las cuatro colonias que antes chocaban con el dueño o los chats (Centro, Centro Histórico, Benito Juárez Norte y Real Montejo) se resuelven **por la regla**, como pidió Javier: quedan en T3, T3, T1 y T2.
6. Los homónimos con discrepancia entre Google y OSM mayor a 1 km se asignan con la coordenada elegida en colonias-v3 y quedan marcados «a revisar» en la nota.

## Pines de las sucursales de despacho

| Sucursal | Pin (lat, lng) — ficha de negocio de Google Maps, 7-oct-2026 |
|---|---|
| T1 Prolongación Montejo | 21.0093272, -89.6135974 |
| T2 Francisco de Montejo | 21.0302178, -89.6470973 |
| T3 Pensiones | 20.995212, -89.6476676 |
| T7 García Lavín (Victory Platz) | 21.0325451, -89.6026621 |
| T8 Victory Altabrisa | 21.0265048, -89.5725175 |

Son los pines propuestos de los datos (`coordenadas_propuestas`), **pendientes de confirmar por el dueño**. Las coordenadas vigentes en `branch_detail` de T1, T2, T7 y T8 siguen desviadas 1.9 a 4.4 km y T3 no tiene; esta carga **no las modifica** (ver «Lo que no cubre»).

## Resultado

- Colonias en la lista: 186. **Asignadas: 167** (165 por la regla + 2 explícitas del dueño). **Fuera de cobertura: 19** (13 a más de 8 km + 6 sin coordenada).
- Colonias marcadas borde: 26.
- Base real el 8-oct-2026: 169 filas de cobertura. Al cargar: +30 altas, -24 reemplazos (retiro por pares de la sucursal equivocada) = 175 filas. Las coberturas de 5 colonias fuera de cobertura **sobran** y no se retiran.

### Conteos por sucursal

| Sucursal | Filas hoy (base real) | Colonias asignadas por la regla | Filas después de cargar |
|---|---|---|---|
| T1 Prolongación Montejo (prol-montejo) | 51 | 44 | 46 |
| T2 Francisco de Montejo (fco-montejo) | 24 | 31 | 32 |
| T3 Pensiones (pensiones) | 33 | 37 | 39 |
| T7 García Lavín (Victory Platz) (garcia-lavin) | 29 | 23 | 24 |
| T8 Victory Altabrisa (altabrisa) | 32 | 32 | 34 |
| **Total** | **169** | **167** | **175** |

«Filas» incluye los puntos de sucursal que ya son zona conocida (T1, T7 y T8 tienen uno; el de T2 es la colonia Francisco de Montejo) y las coberturas sobrantes de abajo. «Colonias asignadas» cuenta solo colonias de la lista.

## Fuera de cobertura

Más de 8 km de toda sucursal de despacho (13):

- Chicxulub: la mas cercana es T7 García Lavín (Victory Platz) a 28.99 km
- Chicxulub Puerto: la mas cercana es T7 García Lavín (Victory Platz) a 28.99 km
- Komchen: la mas cercana es T2 Francisco de Montejo a 8.24 km
- Mulchechen: la mas cercana es T1 Prolongación Montejo a 8.42 km
- Progreso: la mas cercana es T2 Francisco de Montejo a 27.97 km
- Roble Agrícola: la mas cercana es T3 Pensiones a 9.35 km
- Salvador Alvarado Sur: la mas cercana es T1 Prolongación Montejo a 8.23 km
- San Antonio Xluch: la mas cercana es T3 Pensiones a 10.75 km
- San Aroldo: la mas cercana es T1 Prolongación Montejo a 9.72 km
- San Jose Tzal: la mas cercana es T3 Pensiones a 19.26 km
- San Pedro Noh Pat: la mas cercana es T8 Victory Altabrisa a 9.33 km
- Santa Maria Chi: la mas cercana es T8 Victory Altabrisa a 9.42 km
- Serapio Rendón: la mas cercana es T3 Pensiones a 8.09 km

Sin coordenada (6):

- Cecilio Chi
- Nueva Salvador Alvarado Sur
- Olivos
- Revolución Cordemex (la base real hoy la cubre T2: sobrante)
- San Diego Cutz
- Yucatán (la base real hoy la cubre T3: sobrante)

## Coberturas que sobran en la base real (no se retiran)

- Mulchechen: hoy T1 Prolongación Montejo (fuera de 8 km, la mas cercana T1 a 8.42 km)
- Revolución Cordemex: hoy T2 Francisco de Montejo (sin coordenada)
- Salvador Alvarado Sur: hoy T3 Pensiones (fuera de 8 km, la mas cercana T1 a 8.23 km)
- Santa Maria Chi: hoy T8 Victory Altabrisa (fuera de 8 km, la mas cercana T8 a 9.42 km)
- Yucatán: hoy T3 Pensiones (sin coordenada)

La carga no borra estas filas (no hay DELETE masivo). Si Javier decide retirarlas, es un paso aparte y explícito.

## Colonias borde

- Andalucia (T7 García Lavín (Victory Platz)): borde: empate con T2 (a 97 m de diferencia)
- Azcorra (T1 Prolongación Montejo): borde: empate con T3 (a 211 m de diferencia)
- Benito Juárez Norte (T1 Prolongación Montejo): borde: empate con T7 (a 59 m de diferencia)
- Benito Juárez Oriente (T1 Prolongación Montejo): borde: empate con T8 (a 282 m de diferencia)
- Camara de Comercio Norte (T8 Victory Altabrisa): borde: empate con T7 (a 167 m de diferencia)
- Caucel (T2 Francisco de Montejo): borde: empate con T3 (a 108 m de diferencia)
- Cerradas de Gran Santa Fe (T3 Pensiones): borde: empate con T2 (a 47 m de diferencia)
- Chablekal (T7 García Lavín (Victory Platz)): borde: empate con T8 (a 146 m de diferencia)
- Gonzalo Guerrero (T1 Prolongación Montejo): borde: empate con T7 (a 152 m de diferencia)
- Komchen (fuera de cobertura): borde: a 237 m del limite de 8 km
- La Ceiba (T2 Francisco de Montejo): borde: empate con T7 (a 65 m de diferencia)
- Lourdes (T1 Prolongación Montejo): borde: empate con T3 (a 135 m de diferencia)
- Montealban (T7 García Lavín (Victory Platz)): borde: empate con T1 (a 265 m de diferencia)
- Montebello II (T7 García Lavín (Victory Platz)): borde: empate con T8 (a 181 m de diferencia)
- Montecristo (T1 Prolongación Montejo): borde: empate con T7 (a 146 m de diferencia)
- Montevideo (T8 Victory Altabrisa): borde: empate con T1 (a 95 m de diferencia)
- Nucleo Sodzil (T2 Francisco de Montejo): borde: empate con T7 (a 289 m de diferencia)
- Nuevo Yucatan (T8 Victory Altabrisa): borde: empate con T1 (a 27 m de diferencia)
- Paraiso Santa Fe (T2 Francisco de Montejo): borde: empate con T3 (a 201 m de diferencia)
- Quinta Real (T7 García Lavín (Victory Platz)): borde: a 205 m del limite de 8 km
- Reparto Dolores Patron Peniche (T3 Pensiones): borde: empate con T1 (a 66 m de diferencia)
- Salvador Alvarado Sur (fuera de cobertura): borde: a 226 m del limite de 8 km
- San Ramon (T1 Prolongación Montejo): borde: empate con T7 (a 239 m de diferencia)
- Serapio Rendón (fuera de cobertura): borde: a 87 m del limite de 8 km
- Vicente Solis (T3 Pensiones): borde: empate con T1 (a 38 m de diferencia)
- Xcanatun (T2 Francisco de Montejo): borde: empate con T7 (a 259 m de diferencia)

## Cambios contra la base real

Altas y reemplazos que hace el SQL de carga (30 altas y 24 reemplazos):

- Algarrobos Residencial: T7, T8 -> T7
- Andalucia: T2 -> T7
- Benito Juárez Norte: T7 -> T1
- Benito Juárez Oriente: sin cobertura -> T1
- Buenavista: T3 -> T1
- Camara de Comercio Norte: T1, T8 -> T8
- Caucel: T3 -> T2
- Centro: T1 -> T3
- Centro Histórico: T1 -> T3
- Chablekal: sin cobertura -> T7
- Chuminópolis: sin cobertura -> T1
- Dzitya: sin cobertura -> T2
- Guadalupe: T1 -> T8
- Jardines de Mérida: sin cobertura -> T1
- Juan Pablo II: sin cobertura -> T3
- La Ceiba: sin cobertura -> T2
- Las Américas: sin cobertura -> T2
- México Norte: sin cobertura -> T1
- México Poniente: sin cobertura -> T3
- Miguel Hidalgo: sin cobertura -> T3
- Montealban: T1, T7 -> T7
- Montecristo: T1, T7 -> T1
- Montereal: T1, T7 -> T7
- Montevideo: T1, T8 -> T8
- Nuevo Yucatan: T1, T8 -> T8
- Opichen: sin cobertura -> T3
- Paraiso Santa Fe: T3 -> T2
- Plan de Ayala: T1, T7 -> T1
- Real Montejo: T7 -> T2
- Residencial San Antonio: T1, T7 -> T7
- Revolucion: T7 -> T2
- San Antonio Cucul: T1, T7 -> T7
- San Jose: sin cobertura -> T3
- San Ramon: T1, T7 -> T1
- Santa Gertrudis Copo: sin cobertura -> T7
- Santa Maria de Guadalupe: sin cobertura -> T3
- Sitpach: sin cobertura -> T8
- Sol Campestre: T1, T7 -> T7
- Susula: sin cobertura -> T3
- Tixcuytun: sin cobertura -> T8
- Villas del Rey: T1, T7 -> T1
- Villas la Hacienda: T1, T7 -> T1
- Xcanatun: sin cobertura -> T2
- Xo Tik: sin cobertura -> T2

## Tabla colonia → sucursal

Distancia en km al pin de la sucursal asignada (en las que quedan fuera, a la más cercana). Fuente de coordenadas: Google Maps y OpenStreetMap según `colonias-v3` (nunca estimadas a mano; los pines de sucursal salen de la ficha de negocio de Google).

| Colonia | Sucursal asignada | km | Fuente de coordenadas | Nota |
|---|---|---|---|---|
| Alcala Martin | T1 Prolongación Montejo | 2.12 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Alemán | T1 Prolongación Montejo | 2.37 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Algarrobos Residencial | T7 García Lavín (Victory Platz) | 1.99 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T7, T8 |
| Altabrisa | T8 Victory Altabrisa | 1.43 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Andalucia | T7 García Lavín (Victory Platz) | 3.73 | OpenStreetMap/Nominatim (colonias-v3) | borde: empate con T2 (a 97 m de diferencia); cambia: hoy T2 |
| Andria | T8 Victory Altabrisa | 3.54 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Arboledas | T1 Prolongación Montejo | 3.23 | Google Maps (ficha de la colonia, colonias-v3) | homonimo: Google y OSM difieren 6.52 km; se uso la coordenada elegida en colonias-v3, a revisar |
| Aurea Residencial | T2 Francisco de Montejo | 1.51 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Azcorra | T1 Prolongación Montejo | 6.51 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T3 (a 211 m de diferencia) |
| Benito Juárez Norte | T1 Prolongación Montejo | 1.55 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T7 (a 59 m de diferencia); cambia: hoy T7 |
| Benito Juárez Oriente | T1 Prolongación Montejo | 7.31 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T8 (a 282 m de diferencia); alta nueva (hoy sin cobertura) |
| Bojórquez | T3 Pensiones | 2.04 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Buenavista | T1 Prolongación Montejo | 1.25 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T3 |
| Cabo Norte | T7 García Lavín (Victory Platz) | - | chats del dueño (sin coordenada) | explicita del dueño (solo aparece en sus chats; sin coordenada, no se mide) |
| Camara de Comercio Norte | T8 Victory Altabrisa | 2.11 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T7 (a 167 m de diferencia); cambia: hoy T1, T8 |
| Campestre | T1 Prolongación Montejo | 0.41 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Caucel | T2 Francisco de Montejo | 6.19 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T3 (a 108 m de diferencia); cambia: hoy T3 |
| Cecilio Chi | fuera de cobertura | - | sin coordenada | sin coordenada (ni Google ni OSM): no se asigna ni se estima a mano |
| Ceiba II | T7 García Lavín (Victory Platz) | 7.36 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Centro | T3 Pensiones | 3.53 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1 |
| Centro Chichi Suarez | T8 Victory Altabrisa | 3.89 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Centro Histórico | T3 Pensiones | 4.01 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1 |
| Cerrada Lombardia | T8 Victory Altabrisa | 3.51 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Cerrada Piemonte | T8 Victory Altabrisa | 3.43 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Cerrada Veneto | T8 Victory Altabrisa | 3.65 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Cerradas de Gran Santa Fe | T3 Pensiones | 4.95 | OpenStreetMap/Nominatim (colonias-v3) | borde: empate con T2 (a 47 m de diferencia) |
| Chablekal | T7 García Lavín (Victory Platz) | 7.61 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T8 (a 146 m de diferencia); alta nueva (hoy sin cobertura) |
| Chichi Suarez | T8 Victory Altabrisa | 3.29 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Chicxulub | fuera de cobertura | 28.99 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T7 a 28.99 km |
| Chicxulub Puerto | fuera de cobertura | 28.99 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T7 a 28.99 km |
| Cholul | T8 Victory Altabrisa | 2.44 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Chuburná | T2 Francisco de Montejo | 1.63 | OpenStreetMap/Nominatim (colonias-v3) | homonimo: Google y OSM difieren 2.00 km; se uso la coordenada elegida en colonias-v3, a revisar |
| Chuminópolis | T1 Prolongación Montejo | 4.31 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Ciudad Caucel | T3 Pensiones | 5.00 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Cloverleaf | T8 Victory Altabrisa | 2.66 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Del Norte | T1 Prolongación Montejo | 0.90 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Delio Moreno Canton | T3 Pensiones | 6.20 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Dolores Otero | T3 Pensiones | 6.33 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Dzitya | T2 Francisco de Montejo | 3.52 | promedio de las lecturas de Google y OSM (colonias-v3, confianza baja) | homonimo: Google y OSM difieren 2.65 km; se uso la coordenada elegida en colonias-v3, a revisar; confianza de la coordenada: baja; alta nueva (hoy sin cobertura) |
| Dzitya Poligono Chuburna | T2 Francisco de Montejo | 3.42 | Google Maps (ficha de la colonia, colonias-v3) |  |
| El Fenix | T1 Prolongación Montejo | 3.52 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Emiliano Zapata Norte | T1 Prolongación Montejo | 0.60 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Ferrocarrilera Hector Victoria Aguilar | T1 Prolongación Montejo | 3.29 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Floresta Residencial | T8 Victory Altabrisa | 2.33 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Fraccionamiento Francisco de Montejo | T2 Francisco de Montejo | 0.42 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Francisco de Montejo | T2 Francisco de Montejo | 0.10 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Galerias | T2 Francisco de Montejo | 1.41 | OpenStreetMap/Nominatim (colonias-v3) |  |
| García Ginerés | T3 Pensiones | 1.74 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Gonzalo Guerrero | T1 Prolongación Montejo | 2.17 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T7 (a 152 m de diferencia) |
| Gran Herradura Norte | T3 Pensiones | 5.66 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Gran Santa Fe | T3 Pensiones | 4.19 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Gran Santa Fe II | T2 Francisco de Montejo | 4.91 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Guadalupe | T8 Victory Altabrisa | 2.89 | OpenStreetMap/Nominatim (colonias-v3) | cambia: hoy T1 |
| Hacienda Xcumpich | T2 Francisco de Montejo | 0.99 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Inalambrica | T3 Pensiones | 1.60 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Itzimná | T1 Prolongación Montejo | 1.81 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Jardines de Mérida | T1 Prolongación Montejo | 2.59 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Jardines de Miraflores | T1 Prolongación Montejo | 5.58 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Jardines de Vista Alegre I | T8 Victory Altabrisa | 2.17 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Jardines de Vista Alegre II | T8 Victory Altabrisa | 1.99 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Jesús Carranza | T1 Prolongación Montejo | 2.83 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Juan Pablo II | T3 Pensiones | 4.47 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Komchen | fuera de cobertura | 8.24 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T2 a 8.24 km; borde: a 237 m del limite de 8 km |
| La Castellana | T2 Francisco de Montejo | 1.67 | Google Maps (ficha de la colonia, colonias-v3) |  |
| La Ceiba | T2 Francisco de Montejo | 7.04 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T7 (a 65 m de diferencia); alta nueva (hoy sin cobertura) |
| La Ciudadela | T3 Pensiones | 4.01 | OpenStreetMap/Nominatim (colonias-v3) |  |
| La Huerta | T1 Prolongación Montejo | 2.88 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Las Américas | T2 Francisco de Montejo | 4.79 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Las Americas II | T2 Francisco de Montejo | 5.63 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Las Americas Merida | T2 Francisco de Montejo | 4.43 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Leandro Valle | T8 Victory Altabrisa | 3.40 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Lomas del Sur | T3 Pensiones | 5.45 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Los Heroes | T8 Victory Altabrisa | 5.47 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Los Pinos | T8 Victory Altabrisa | - | chats del dueño (sin coordenada) | explicita del dueño (solo aparece en sus chats; sin coordenada, no se mide) |
| Los Reyes | T3 Pensiones | 4.88 | OpenStreetMap/Nominatim (colonias-v3) | homonimo: Google y OSM difieren 7.78 km; se uso la coordenada elegida en colonias-v3, a revisar |
| Lourdes | T1 Prolongación Montejo | 5.50 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T3 (a 135 m de diferencia) |
| Lourdes Industrial | T1 Prolongación Montejo | 3.68 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Mallorca | T8 Victory Altabrisa | 2.12 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Manzana 115 | T3 Pensiones | 5.59 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Maximo Ancona | T1 Prolongación Montejo | 3.54 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Meliton Salazar | T3 Pensiones | 5.72 | Google Maps (ficha de la colonia, colonias-v3) |  |
| México | T1 Prolongación Montejo | 0.84 | OpenStreetMap/Nominatim (colonias-v3) |  |
| México Norte | T1 Prolongación Montejo | 1.04 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Mexico Oriente | T1 Prolongación Montejo | 1.47 | Google Maps (ficha de la colonia, colonias-v3) |  |
| México Poniente | T3 Pensiones | 4.64 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Miguel Hidalgo | T3 Pensiones | 0.52 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Miraflores | T1 Prolongación Montejo | 6.25 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Montealban | T7 García Lavín (Victory Platz) | 1.46 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T1 (a 265 m de diferencia); cambia: hoy T1, T7 |
| Montebello | T7 García Lavín (Victory Platz) | 0.87 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Montebello II | T7 García Lavín (Victory Platz) | 1.51 | OpenStreetMap/Nominatim (colonias-v3) | borde: empate con T8 (a 181 m de diferencia) |
| Montecarlo | T8 Victory Altabrisa | 0.99 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Montecristo | T1 Prolongación Montejo | 1.94 | OpenStreetMap/Nominatim (colonias-v3) | borde: empate con T7 (a 146 m de diferencia); cambia: hoy T1, T7 |
| Montereal | T7 García Lavín (Victory Platz) | 1.37 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1, T7 |
| Montes de Ame | T7 García Lavín (Victory Platz) | 1.62 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Montevideo | T8 Victory Altabrisa | 2.35 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T1 (a 95 m de diferencia); cambia: hoy T1, T8 |
| Morelos Oriente | T1 Prolongación Montejo | 7.31 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Mulchechen | fuera de cobertura | 8.42 | OpenStreetMap/Nominatim (colonias-v3) | fuera de 8 km: la mas cercana es T1 a 8.42 km; homonimo: Google y OSM difieren 1.76 km; se uso la coordenada elegida en colonias-v3, a revisar; SOBRANTE: la base real hoy la cubre T1; no se retira |
| Mulsay | T3 Pensiones | 3.86 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Nucleo Sodzil | T2 Francisco de Montejo | 3.39 | OpenStreetMap/Nominatim (colonias-v3) | borde: empate con T7 (a 289 m de diferencia) |
| Nueva Alemán | T1 Prolongación Montejo | 3.19 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Nueva Reforma Agraria | T3 Pensiones | 6.07 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Nueva Salvador Alvarado Sur | fuera de cobertura | - | sin coordenada | sin coordenada (ni Google ni OSM): no se asigna ni se estima a mano |
| Nuevo Yucatan | T8 Victory Altabrisa | 3.25 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T1 (a 27 m de diferencia); cambia: hoy T1, T8 |
| Obrera | T3 Pensiones | 5.82 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Olivos | fuera de cobertura | - | sin coordenada | sin coordenada (ni Google ni OSM): no se asigna ni se estima a mano |
| Opichen | T3 Pensiones | 6.15 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Paraiso Santa Fe | T2 Francisco de Montejo | 4.31 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T3 (a 201 m de diferencia); cambia: hoy T3 |
| Parque Central | T8 Victory Altabrisa | 3.25 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Parque Industrial | T2 Francisco de Montejo | 4.06 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Parque Natura | T8 Victory Altabrisa | 3.13 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Pedregales de Circuito | T3 Pensiones | 5.98 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Pedregales las Americas | T2 Francisco de Montejo | 4.42 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Pensiones | T3 Pensiones | 0.88 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Piedrasul | T2 Francisco de Montejo | 1.00 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Plan de Ayala | T1 Prolongación Montejo | 1.01 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1, T7 |
| Privada del Carmen | T3 Pensiones | 1.99 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Privada las Acacias | T8 Victory Altabrisa | 4.07 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Progreso | fuera de cobertura | 27.97 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T2 a 27.97 km |
| Puerta de Piedra Dzitya | T2 Francisco de Montejo | 2.37 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Punta Esmeralda | T8 Victory Altabrisa | 5.18 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Quinta Real | T7 García Lavín (Victory Platz) | 7.80 | OpenStreetMap/Nominatim (colonias-v3) | borde: a 205 m del limite de 8 km |
| Real de Dzitya | T2 Francisco de Montejo | 3.55 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Real Montejo | T2 Francisco de Montejo | 2.41 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T7 |
| Real San Jose | T1 Prolongación Montejo | 7.15 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Reparto Dolores Patron Peniche | T3 Pensiones | 2.39 | OpenStreetMap/Nominatim (colonias-v3) | borde: empate con T1 (a 66 m de diferencia) |
| Residencial Pensiones | T3 Pensiones | 1.75 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Residencial San Antonio | T7 García Lavín (Victory Platz) | 1.23 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1, T7 |
| Revolucion | T2 Francisco de Montejo | 2.09 | OpenStreetMap/Nominatim (colonias-v3) | cambia: hoy T7 |
| Revolución Cordemex | fuera de cobertura | - | sin coordenada | sin coordenada (ni Google ni OSM): no se asigna ni se estima a mano; SOBRANTE: la base real hoy la cubre T2; no se retira |
| Rinconada de Chuburna | T2 Francisco de Montejo | 1.70 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Roble Agrícola | fuera de cobertura | 9.35 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T3 a 9.35 km |
| Royal del Parque | T2 Francisco de Montejo | 3.50 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Salvador Alvarado Sur | fuera de cobertura | 8.23 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T1 a 8.23 km; borde: a 226 m del limite de 8 km; SOBRANTE: la base real hoy la cubre T3; no se retira |
| Sambula | T3 Pensiones | 4.50 | Google Maps (ficha de la colonia, colonias-v3) |  |
| San Angel | T8 Victory Altabrisa | 4.55 | OpenStreetMap/Nominatim (colonias-v3) | homonimo: Google y OSM difieren 8.33 km; se uso la coordenada elegida en colonias-v3, a revisar |
| San Antonio Cinta | T1 Prolongación Montejo | 1.32 | Google Maps (ficha de la colonia, colonias-v3) |  |
| San Antonio Cucul | T7 García Lavín (Victory Platz) | 1.14 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1, T7 |
| San Antonio Xluch | fuera de cobertura | 10.75 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T3 a 10.75 km |
| San Aroldo | fuera de cobertura | 9.72 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T1 a 9.72 km; confianza de la coordenada: baja |
| San Diego Cutz | fuera de cobertura | - | sin coordenada | sin coordenada (ni Google ni OSM): no se asigna ni se estima a mano |
| San Esteban | T1 Prolongación Montejo | 2.64 | Google Maps (ficha de la colonia, colonias-v3) |  |
| San Jose | T3 Pensiones | 6.65 | Google Maps (ficha de la colonia, colonias-v3) | homonimo: Google y OSM difieren 11.39 km; se uso la coordenada elegida en colonias-v3, a revisar; alta nueva (hoy sin cobertura) |
| San Jose Tzal | fuera de cobertura | 19.26 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T3 a 19.26 km |
| San Jose Vergel | T1 Prolongación Montejo | 6.31 | Google Maps (ficha de la colonia, colonias-v3) |  |
| San Lorenzo | T3 Pensiones | 2.94 | Google Maps (ficha de la colonia, colonias-v3) |  |
| San Luis | T1 Prolongación Montejo | 1.88 | promedio de las lecturas de Google y OSM (colonias-v3, confianza baja) | homonimo: Google y OSM difieren 6.11 km; se uso la coordenada elegida en colonias-v3, a revisar; confianza de la coordenada: baja |
| San Pedro Cholul | T8 Victory Altabrisa | 1.64 | Google Maps (ficha de la colonia, colonias-v3) |  |
| San Pedro Noh Pat | fuera de cobertura | 9.33 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T8 a 9.33 km; confianza de la coordenada: baja |
| San Ramon | T1 Prolongación Montejo | 1.29 | OpenStreetMap/Nominatim (colonias-v3) | borde: empate con T7 (a 239 m de diferencia); cambia: hoy T1, T7 |
| San Ramon Norte | T7 García Lavín (Victory Platz) | 1.15 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Santa Cecilia | T1 Prolongación Montejo | 3.11 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Santa Gertrudis | T7 García Lavín (Victory Platz) | 1.11 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Santa Gertrudis Copo | T7 García Lavín (Victory Platz) | 1.15 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Santa Maria Chi | fuera de cobertura | 9.42 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T8 a 9.42 km; SOBRANTE: la base real hoy la cubre T8; no se retira |
| Santa Maria de Guadalupe | T3 Pensiones | 5.13 | OpenStreetMap/Nominatim (colonias-v3) | alta nueva (hoy sin cobertura) |
| Santa Rosa | T3 Pensiones | 6.65 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Serapio Rendón | fuera de cobertura | 8.09 | Google Maps (ficha de la colonia, colonias-v3) | fuera de 8 km: la mas cercana es T3 a 8.09 km; borde: a 87 m del limite de 8 km |
| Sitpach | T8 Victory Altabrisa | 5.36 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Sodzil | T7 García Lavín (Victory Platz) | 2.35 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Sodzil Norte | T7 García Lavín (Victory Platz) | 2.35 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Sol Campestre | T7 García Lavín (Victory Platz) | 1.13 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1, T7 |
| Susula | T3 Pensiones | 5.71 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Tamarindos | T2 Francisco de Montejo | 2.02 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Tecnologico | T1 Prolongación Montejo | 0.86 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Temozón Norte | T7 García Lavín (Victory Platz) | 3.45 | promedio de las lecturas de Google y OSM (colonias-v3, confianza baja) | homonimo: Google y OSM difieren 1.62 km; se uso la coordenada elegida en colonias-v3, a revisar; confianza de la coordenada: baja |
| Tixcuytun | T8 Victory Altabrisa | 4.41 | Google Maps (ficha de la colonia, colonias-v3) | alta nueva (hoy sin cobertura) |
| Vergel | T1 Prolongación Montejo | 6.43 | OpenStreetMap/Nominatim (colonias-v3) | homonimo: Google y OSM difieren 1.79 km; se uso la coordenada elegida en colonias-v3, a revisar |
| Vergel II | T1 Prolongación Montejo | 7.11 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Via Montejo | T2 Francisco de Montejo | 2.30 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Vicente Solis | T3 Pensiones | 6.49 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T1 (a 38 m de diferencia) |
| Villa Fontana | T1 Prolongación Montejo | 4.19 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Villa Magna | T3 Pensiones | 5.63 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Villareal | T7 García Lavín (Victory Platz) | 0.40 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Villas Cholul | T8 Victory Altabrisa | 4.01 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Villas del Rey | T1 Prolongación Montejo | 1.07 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1, T7 |
| Villas la Hacienda | T1 Prolongación Montejo | 1.14 | Google Maps (ficha de la colonia, colonias-v3) | cambia: hoy T1, T7 |
| Vista Alegre | T8 Victory Altabrisa | 2.32 | Google Maps (ficha de la colonia, colonias-v3) | homonimo: Google y OSM difieren 2.11 km; se uso la coordenada elegida en colonias-v3, a revisar |
| Vista Alegre Norte | T8 Victory Altabrisa | 0.30 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Waspa | T1 Prolongación Montejo | 4.45 | OpenStreetMap/Nominatim (colonias-v3) |  |
| Xaman Kab | T7 García Lavín (Victory Platz) | 0.19 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Xaman Tan | T7 García Lavín (Victory Platz) | 0.14 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Xcanatun | T2 Francisco de Montejo | 5.52 | Google Maps (ficha de la colonia, colonias-v3) | borde: empate con T7 (a 259 m de diferencia); alta nueva (hoy sin cobertura) |
| Xcumpich | T2 Francisco de Montejo | 1.30 | Google Maps (ficha de la colonia, colonias-v3) |  |
| Xo Tik | T2 Francisco de Montejo | 3.34 | OpenStreetMap/Nominatim (colonias-v3) | alta nueva (hoy sin cobertura) |
| Yucalpeten | T3 Pensiones | 2.12 | OpenStreetMap/Nominatim (colonias-v3) | homonimo: Google y OSM difieren 33.32 km; se uso la coordenada elegida en colonias-v3, a revisar |
| Yucatán | fuera de cobertura | - | sin coordenada | sin coordenada (ni Google ni OSM): no se asigna ni se estima a mano; SOBRANTE: la base real hoy la cubre T3; no se retira |

## Cómo se aplica y se comprueba

1. `scripts/seed-pm-demo/sql/colonias-8km-carga.sql`: idempotente, una transacción, con comprobaciones que abortan. `supabase db query --linked -f colonias-8km-carga.sql`. Segunda corrida: 0 cambios.
2. `scripts/seed-pm-demo/sql/colonias-8km-verifica.sql`: solo lectura; recalcula en la base la sucursal más cercana de cada colonia y la compara con lo cargado. Debe devolver `PASA` con 0 diferencias.
3. Prueba `packages/domain-restaurantes/tests/colonias-radio-8km.spec.ts`: recalcula con Haversine todo el dataset y falla si alguna asignación no es la más cercana a 8 km o menos (incluye 7.99 / 8.00 / 8.01 km y empate).

## Lo que no cubre

- No cambia `branch_detail.lat/lng` (los pines propuestos siguen pendientes de confirmar por el dueño; hasta entonces `assignBranch` por pin se mide contra coordenadas desviadas).
- No escribe coordenadas de colonias en `known_zone` (lat/lng siguen nulos), no toca `whatsapp_branch_channel` (0 filas) ni la cuenta demo.
- No decide por el dueño los homónimos ni los bordes: quedan marcados para revisión.
