# Menú en línea de PM por sucursal (captura del 15-oct-2026, 60 imágenes)

Fuente única: el sitio público del propio negocio, <https://www.lostaquitosdepm.com> (Wix). El menú NO es texto: cada sucursal publica una **galería de imágenes**
(9 u 8 por página, no 3: la versión estática del HTML solo trae las tres primeras; el resto sale de los datos de la galería). Se leyó cada imagen una por una.
Solo lectura: nada de esto toca la base real, Vercel ni WhatsApp. **No hay binarios en el repo**: solo datos estructurados y SHA256.

## Archivos

| Archivo | Qué es |
|---|---|
| `montejo-altabrisa-victory.json` | Página `/menu-altabrisa-montejo-victory`, 9 imágenes. La usan **Prolongación Montejo, García Lavín (Victory Platz) y Altabrisa** (los tres botones del índice `/menupm` llevan a la misma página). 226 productos, 236 renglones. Lista T1-2026. |
| `playa.json` | `/menuchicxulub`, 8 imágenes (Chicxulub / Playa). 215 productos. Lista T5-2026. |
| `fco-montejo.json` | `/menufranciscodemontejo`, 9 imágenes (la 1.ª es la promo). 211 productos. Precios = T1-2026. |
| `pensiones.json` | `/menupensiones`, 8 imágenes (la 1.ª es la promo). 200 productos. **Lista T3-2025 (más barata).** |
| `galerias.json` | `/menupmgalerias`, 9 imágenes (la 1.ª es la promo). 154 productos. Precios = T1-2026, menú reducido (sin licores, cervezas, cocktails ni postres). |
| `sitio.json` | Del PR #571: preguntas frecuentes, contacto, WhatsApp por sucursal y la página `/menu` antigua (lista vieja, no se usa para precios). Se le agregaron los **horarios por sucursal de la portada**. |
| `reglas-piezas.json` | Piezas por orden que las imágenes confirman (con la cita), las que NO dicen, el cambio al seed y la divergencia del arnés. |
| `manifiesto-pdf.json` | Los 7 PDF (5 en español, 2 en inglés): sucursal, páginas, SHA256 del PDF, URL fuente, fecha y cada imagen de origen con SHA256 e «incrustada sin recomprimir». |

Cada producto lleva imagen de origen, categoría, presentaciones con precio, `piezas_por_orden` + cita (solo si la imagen lo dice) y `seed_nombre` (a qué producto del seed corresponde).
Las páginas en inglés (`/taquitospm-english-menu` = Montejo/García Lavín/Altabrisa; `/englishmenuchicxulub` = Playa) tienen exactamente los mismos precios que su versión en español y solo aparecen en el manifiesto de PDF.

## Hallazgos

1. **Montejo/García Lavín/Altabrisa, Francisco de Montejo y Galerías = lista T1-2026** (el seed ya la tiene): todos los precios publicados coinciden con el seed (T1, T7, T8, T2). Playa = T5-2026, con una sola diferencia: **Agua Mineral Cristal 300 ml sale a $50** (el impreso T5 y el seed dicen $53).
2. **Pensiones sigue publicando la lista 2025** (idéntica a `menus-impresos/T3-2025.json`): ningún precio coincide con el T3 del seed (lista T1-2026, corrección CR01/CR02 del 3-oct) y todos son menores (frijol con tostada $83 vs $93, nachos de pastor $278 vs $328, kilo de pastor $750 vs $900). **Decide el dueño; no se tocó el precio del seed.**
3. **Piezas por orden confirmadas por las imágenes**: tacos individuales 1, tacos 3, gringas 2, mestizas 2, alambre 5, **tacos suizos 5** (encabezado «las órdenes son de 5 tacos»), papadzules 5, codzitos 4, tacos de cochinita 4. El seed ya las traía salvo el alambre suizo y los dos «tacos suizos de chile poblano»: **se les puso «Orden de 5 tacos»** y el servidor ya devuelve `pack_size` 5 (antes `null`). Efecto: pedir «1 orden de alambre suizo» ahora va como 5 piezas, igual que el alambre normal (T7-052 se actualizó a 5 piezas con el mismo total, $948).
4. **Flautas: ninguna imagen imprime cuántas trae la orden, pero Javier lo confirmó (16-oct-2026): «una orden de flautas es UNA flauta grande» (`pack_size` 1).** Solo salen en la página Montejo/García Lavín/Altabrisa (7 sabores; el seed solo las vende en T1, T7 y T8: coincide). El seed lo carga con la descripción «Orden de 1 flauta grande» (igual que «Orden de 5 tacos») y `buscar_producto` explica la unidad. El JSON de las imágenes conserva `piezas_por_orden: null` porque la imagen no lo imprime; la fuente es la decisión de Javier. **Alitas ($204), crujientes ($329) y quesadillas (solo «de maíz o harina») siguen sin número confirmado por PM**: no se inventó ninguno. T7-031 con «1 orden de flautas»: $1,100 + $450 + $283 = **$1,833**; «4 flautas» son 4 órdenes ($1,132 solo las flautas; con los kilos, $2,682).
5. **Promociones** (solo en las imágenes de Francisco de Montejo, Pensiones y Galerías): lunes 2x1 en tacos al pastor; martes nachos al pastor + 2 aguas frescas **$328** (Pensiones **$278**). La leyenda las limita a esas tres sucursales, de apertura a cierre y **«no válido en servicio a domicilio»**; el seed las carga en todas las sucursales y solo para recoger. La imagen no dice qué aguas entran.
6. **Qué se vende dónde** (según las imágenes): flautas y comida regional solo en la página de Montejo/García Lavín/Altabrisa (Galerías también trae comida regional, sin codzitos); Playa no tiene Sprite; Heineken Silver solo sale en Playa ($90) y Francisco de Montejo ($90; **el seed solo la carga en T5**).
7. **Divergencia con el seed (pregunta P10 del dueño)**: Ensalada de PM, Jericallas y Café tienen precio en T2 y T3 del seed, pero **no salen** en las imágenes de Francisco de Montejo ni de Pensiones; Pensiones tampoco trae pizzas Quesobich ni Heineken 0.0. No se tocó el seed.
8. **Horarios, envío y mínimo**: ninguna imagen los trae. El sitio sí publica horario **por sucursal** en la portada y las preguntas frecuentes (entrega de 40 a 50 min, con lluvia 1 h a 1 h 20; tarjeta o contra entrega; salsas extra con costo); los horarios por sucursal quedaron en `sitio.json` (`horarios_por_sucursal_portada`). Horario por producto, agotados, «solo fin de semana», límites de cantidad, pedido mínimo y costo de envío: **no aparecen** (`null` en cada JSON).

## Divergencia conocida del arnés (no corregida a propósito)

`packages/domain-restaurantes/src/evals/agente-pm/menu-pm.json` trae `pack_size` 1 en gringas, mestizas, alambre y los 17 suizos; las imágenes dicen 2, 2, 5 y 5.
Se probó alinearlos y **rompe 5 pruebas en cada intento** (gringas/mestizas/alambre: los 68 casos, totales de comanda, contrato actual, y dos pruebas de graders; suizos: C29 y los agregados), porque los casos L03, L17, L22, L25, C04, C08, C09, C11 y C13 piden esos platillos contando órdenes. No se cambió el arnés ni se debilitó ninguna prueba: alinearlo exige reescribir esos casos (decisión pendiente). Una prueba fija la divergencia.

## Pruebas

`packages/domain-restaurantes/tests/pm-menu-9-fotos.spec.ts` (deterministas, sin LLM, sin red, sin base): forma y trazabilidad de los JSON, manifiesto de PDF contra las imágenes de cada página, precios web = seed por sucursal, Pensiones = lista 2025, qué se vende dónde, promociones, piezas por orden (JSON = lo que el servidor deriva del seed), alambre suizo con `pack_size` 5, alitas/crujientes sin `pack_size` y flautas con `pack_size` 1, divergencia del arnés y T7-031 ($1,833).

## Relación con el PR #571

Este directorio reemplaza los JSON de #571 (que solo habían leído 3 imágenes por sucursal): se retiraron `altabrisa.json`, `garcia-lavin.json`, `prol-montejo.json` (las tres plazas comparten `montejo-altabrisa-victory.json`) y `diferencias.json` (la comparación ahora vive en este README y en las pruebas). `pm-menu-en-linea.spec.ts` se adaptó a los nuevos archivos conservando sus aserciones de piezas, T7-031, tacos, kilos y tortilla; las de forma, promos y precios web = seed las cubre `pm-menu-9-fotos.spec.ts` con más datos. Una afirmación de #571 resultó falsa con las 9 imágenes (que las flautas «ni aparecen»): salen en la página Montejo/García Lavín/Altabrisa, imagen 4, sin número de piezas.

## Regenerar

Los JSON y el manifiesto se generan con `generar-docs-repo.py` y los PDF con el script de `work/pm-menus-pdf` (fuera del repo; ver su `LEEME-MENUS.md`). Después de regenerar, compara los SHA256 con `manifiesto-pdf.json`.
