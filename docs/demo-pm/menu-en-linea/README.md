# Menú en línea de PM por sucursal (captura del 15-oct-2026)

Fuente: el sitio público del propio negocio, <https://www.lostaquitosdepm.com> (Wix). `robots.txt` permite todo salvo `?lightbox=` y rutas internas de galería;
se leyó una página por vez y una imagen por vez con pausa de 2 s (sin ráfagas). Solo lectura: nada de esto toca la base real, Vercel ni WhatsApp.

## Cómo está publicado el menú (hallazgo principal)

- Cada sucursal tiene su página (`/menu-altabrisa-montejo-victory`, `/menufranciscodemontejo`, `/menupensiones`, `/menupmgalerias`, `/menuchicxulub`) y **el menú es una galería de 3 imágenes**, no texto. Se transcribió leyendo cada imagen (por eso cada JSON dice «lectura visual»).
- La única página con texto es `/menu`, y es una **lista antigua** (taco al pastor $23, kilo de pastor $470): no coincide con ninguna sucursal. Se guardó en `sitio.json` (`pagina_menu_texto`) solo por su texto de tortilla, media orden y salsas; **no se usa para precios**.
- **Ninguna imagen ni página dice cuántas piezas trae una orden de flautas, alitas o crujientes.** Las flautas y los crujientes ni aparecen en las imágenes. Por eso **T7-031 NO se puede cerrar con el menú público**: el aviso de «ORDEN sin piezas» del PR #564 se queda, y las piezas siguen pendientes de PM.

## Archivos

| Archivo | Qué es |
|---|---|
| `prol-montejo.json`, `garcia-lavin.json`, `altabrisa.json` | Misma página publicada («Victory Platz / Prolongación Montejo / Altabrisa»), lista T1-2026. 91 productos. |
| `fco-montejo.json` | Promos + entradas/nachos + licores/kilos, lista T1-2026. Sin imagen de tacos. |
| `pensiones.json` | Lista **T3-2025** (más barata). Sin imagen de tacos. |
| `galerias.json` | Promo + entradas/nachos + refrescos/aguas/extras/kilos. Sin tacos ni licores. |
| `playa.json` | Chicxulub: entradas/nachos + tacos + licores/kilos, lista T1-2026. La versión en inglés no se leyó. |
| `sitio.json` | Preguntas frecuentes, contacto, WhatsApp por sucursal y la página `/menu` antigua. |
| `diferencias.json` | Comparación completa contra el seed por sucursal (precio distinto, producto sin match, pack_size distinto). |

Cada JSON lleva URL fuente, fecha de captura, categorías, productos con presentaciones (porción, media orden, kilo), precio, `piezas_por_orden`, tortilla, extras (solo Galerías los publica), promociones y excepciones.

## Diferencias contra el repo

| Sucursal (id del seed) | Precios publicados | Resultado |
|---|---|---|
| Prolongación Montejo (T1), García Lavín (T7), Altabrisa (T8), Playa (T5) | 101 renglones | **101 iguales al seed**, 0 distintos, 0 faltantes |
| Francisco de Montejo (T2) | 69 renglones | 69 iguales al seed (la imagen no trae Ensalada de PM) |
| **Pensiones (T3)** | 69 renglones | **69 distintos**: la web publica la lista 2025 (frijol con tostada $83 vs $93 del seed; nachos de pastor $278 vs $328; kilo de pastor $750 vs $900). El seed usa T1-2026 en T3 (corrección CR01/CR02 del 3-oct). **Decide el dueño; no se tocó el seed.** |
| Galerías (T4) | 64 renglones | El seed no tiene catálogo de T4 (sucursal informativa); precios = lista T1-2026. |

- Producto de la web que falte en el seed: **ninguno**. Productos del seed que no salen en las imágenes: flautas, tacos suizos, chetacos, papas, francés suizo, Boyo-hamburguesa, Quesobich, platillos, comida regional, cervezas y postres (la web no los publica en estas páginas; no significa que no se vendan).
- **pack_size**: el servidor (`extraerPackSize`) ya leía «Orden de N tacos» de la descripción del seed, así que `buscar_producto` ya devuelve gringas 2, mestizas 2 y alambre 5 (la web lo confirma: «las órdenes son de N tacos»), tacos 3 e individuales 1. **No hubo nada que cargar en el seed.** Divergencia que SÍ apareció: el menú del arnés (`menu-pm.json`) trae pack_size 1 en esos 20 productos porque solo lee el nombre. Se intentó alinearlo a 2, 2 y 5 y **rompe 9 casos** de `casos.json` (L03, L17, L22, L25, C04, C08, C09, C11, C13: piden «1 alambre» o «2 gringas» contando órdenes y sus totales salen de pack 1), así que se revirtió: quedó fijada como divergencia conocida en la prueba y alinearla exige reescribir esos casos (decisión pendiente).

## Pendientes de confirmación con PM (lo que el sitio NO dice)

1. **Piezas por orden de flautas, alitas y crujientes** (T7-031 sigue cobrando de más hasta que se carguen como «(orden de N)»).
2. **Quesadillas «orden de 3»**: el seed lo asume (menú impreso); la web no trae el número.
3. **Tacos suizos «orden de 5»**: igual; el arnés dice 1 y el servidor 5, y el sitio no lo confirma.
4. **Pensiones: ¿rige la lista 2025 o la T1-2026?** La web sigue con la de 2025.
5. **Promos**: la imagen limita el 2x1 de los lunes y los nachos del martes a Fco. de Montejo, Pensiones y Galerías, de apertura a cierre y **no a domicilio**; el seed dice «todas las sucursales, solo recoger». En Pensiones el martes cuesta $278 (en las otras, $328). Tampoco dice qué aguas entran (P13).
6. **Fracciones de kilo** (1/4, 1/2, 3/4, 1.5, 2 kg): el sitio publica solo el kilo; el seed las calcula proporcional (decisión de Javier A42).
7. **Tortilla por producto**: solo la página `/menu` antigua la menciona (tacos maíz o harina, gringas harina, mestizas maíz); las imágenes no.
8. **Horarios por producto, disponibilidad por sucursal, agotados, «solo fin de semana», mínimo de compra y costo de envío**: no aparecen en el sitio. Lo único publicado: entrega de 40 a 50 min (1 h a 1 h 20 min con lluvia), pago con tarjeta/contra entrega y salsas extra con costo.
9. Fco. de Montejo, Pensiones y Galerías **no publican página de tacos**; Galerías tampoco licores. No se asume que no los vendan.
10. Chicxulub: el sitio no habla de temporada (el seed dice Semana Santa y julio-agosto).
11. Páginas en inglés (`/englishmenuchicxulub`, `/taquitospm-english-menu`): no leídas.

## Pruebas

`packages/domain-restaurantes/tests/pm-menu-en-linea.spec.ts` (deterministas, sin LLM ni red): forma y trazabilidad de los JSON, precios web = seed, la diferencia de Pensiones fijada como hallazgo, pack_size del servidor contra la web y la divergencia del arnés fijada, flautas/alitas/crujientes **sin** pack_size, T7-031 con el catálogo real ($1,100 + $450 + $283 = **$1,833**, y la trampa de leer «4 flautas» como 4 órdenes = $1,132 solo de flautas), tacos por orden, gringas, alambre, tortilla y kilos (1 kg + 250 g = $1,125).
