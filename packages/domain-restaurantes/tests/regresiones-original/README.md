# Regresiones del repo original (`atiende-restaurantes`) como pruebas con nombre

Javier considera clave todo lo que se aprendió en el original: sus pruebas, sus excepciones y los errores reales. Esta carpeta es la
**tabla de trazabilidad**: cada bug del historial de git del original y cada caso `X01`-`X58` del catálogo B.1 apunta a la prueba de
`main` que lo cubre, con su estado. La prueba `trazabilidad.spec.ts` lee este archivo y **falla si una ruta o un nombre citado ya no
existe**, o si una fila marcada `it.fails`/`it.todo` ya no lo es (así la tabla no se pudre).

Abreviaturas de ruta (se usan dentro de los códigos `ruta::nombre`): `T/` = `packages/domain-restaurantes/tests/`, `A/` = `apps/api/tests/`,
`R/` = `packages/domain-restaurantes/tests/regresiones-original/`, `S/` = `scripts/`. El `nombre` es un fragmento literal del título del `it`
(o, en scripts, del encabezado del escenario). Original: `ORIG/` = `work/orig-atiende-restaurantes` @ `13fb3bd`.

Estados: **verde** = la prueba pasa en `main` hoy. **it.fails (lote)** = el defecto sigue en `main`; la prueba está escrita como `it.fails` y se
vuelve verde cuando entra el lote que lo corrige (entonces hay que quitarle `.fails`): `B1` clasificador-handoff, `B2` guardias-reglas, `C` voz,
`D` automatización, `E` storefront-dinero, `F` panel-ui, `A` seguridad, `R1`/`R2` = briefs `rescate-orig-restaurantes-1/2`. **it.todo** = brecha ya
anotada en `main`. **N/A** = no aplica a la arquitectura nueva (con el motivo).

Este PR no arregla nada de producción salvo los eventos de observabilidad por turno (R-PM-15, ver abajo): fija la memoria.

## 1. Bugs del historial de git del original

| Commit | Bug real | Prueba en main | Estado |
|---|---|---|---|
| `6d07364` | Saludo fijo "Buenas tardes" a cualquier hora; "Alta Brisa" no encontraba "altabrisa" | `R/historial-busqueda-y-datos.spec.ts::X40 / 6d07364: WhatsApp a las` (09:00, 13:00, 21:00, 00:30 en `America/Merida`); `R/historial-busqueda-y-datos.spec.ts::X40 / 6d07364: el pregrabado de voz`; `R/historial-busqueda-y-datos.spec.ts::X41 / 6d07364` | verde |
| `cec17f1` | "una pizza" respondía "no disponible"; el aviso de bistec solo salía al total | `R/historial-busqueda-y-datos.spec.ts::X10 / cec17f1: 'una pizza'`; `R/historial-busqueda-y-datos.spec.ts::X10 / cec17f1: un producto que no existe`; `T/pm-bateria-agente-whatsapp.spec.ts::T-PG03 / X02` (aviso de órdenes de 3 en el mismo turno) | verde |
| `ff76358` | "cerveza Sol" y "coctel Margarita" daban 0 resultados | `R/historial-busqueda-y-datos.spec.ts::X11 / ff76358: 'cerveza Sol'`; `R/historial-busqueda-y-datos.spec.ts::X11 / ff76358: ambos se cotizan` | verde |
| `c25e70c` | Loop agotado tras crear → "se me complicó" → el cliente insiste → pedido duplicado | `R/historial-turno-y-pedidos.spec.ts::X08 / c25e70c` (crear en la vuelta 7, agotar en la 8, "¿ya quedó?" → 0 pedidos nuevos); `T/whatsapp/llm-turn-handler.spec.ts::bug real corregido: si el loop se agota` | verde |
| `abc543a` | Tools de voz con 401 por JWT | `A/pm-voz-seguridad.spec.ts::T-AB07` (credenciales de voz por llamada, sin 500) | N/A (la API propia usa token por llamada, no JWT de Supabase) |
| `0a346be` | Mensajes casi simultáneos pisaban el historial; promesa de repartidor; excusa inventada tras fallo | `R/casos-b1.spec.ts::X30 / 0a346be`; `S/verify-restaurantes-whatsapp-concurrencia/run.sh::=== 8. Tres mensajes del mismo cliente` (Postgres real, 2+ conexiones); `R/casos-b1.spec.ts::X28 / 0a346be`; `R/casos-b1.spec.ts::X29 / 0a346be: el prompt generico` | verde |
| `0a346be` (X29 en el perfil PM) | El perfil PM solo dice "reintente una vez" tras un `crear_pedido` fallido | `R/casos-b1.spec.ts::X29 / 0a346be [lote R1]` | it.fails (R1) |
| `72fd6ad` | "sin cebolla" no llegaba a cocina; Guacamole vs Extra Guacamole; volvía a pedir el nombre | `R/historial-busqueda-y-datos.spec.ts::X25 / 72fd6ad` (nota en la comanda); `R/historial-busqueda-y-datos.spec.ts::X26 / 72fd6ad`; `R/casos-b1.spec.ts::X27: el agente recibe el nombre` | verde |
| `72fd6ad` (X27 regla explícita) | Falta la regla "no vuelva a pedir el nombre" en el perfil PM | `R/casos-b1.spec.ts::X27 / 72fd6ad [lote R1]` | it.fails (R1) |
| `de885b1` | "tacos al pastor" y "500g" daban 0; "1kg", "1 kg", "1.5 kg" | `R/historial-busqueda-y-datos.spec.ts::X12 / de885b1: 'tacos al pastor'`; `R/historial-busqueda-y-datos.spec.ts::X12 / de885b1: '1kg'` | verde |
| `5d164ee` | Tarjeta en claro; carrera 23505; "no disponible" como pretexto con alcohol; nombre inventado; forma del widget con mensaje vacío | `R/historial-turno-y-pedidos.spec.ts::X22 / 5d164ee` (PAN, CVV y vencimiento redactados; en logs: `R/..observabilidad`, ver §5); `R/historial-turno-y-pedidos.spec.ts::X19 / 5d164ee`; `R/historial-turno-y-pedidos.spec.ts::X23 / 5d164ee`; `R/casos-b1.spec.ts::X54 / 5d164ee` (el widget rechaza el vacío con 400 y no gasta un turno; mismas llaves con y sin pedido); "nombre inventado" solo por prompt: `T/pm-bateria-agente-whatsapp.spec.ts::T-HO09` | verde (X54: el widget de main devuelve un 400 validado en vez de la forma `{reply, orderId}` del original); nombre inventado: it.todo |
| `da4ce92` | Teléfono vacío colapsaba clientes | `R/historial-busqueda-y-datos.spec.ts::X17 / da4ce92` ("widget-abc" y "widget-xyz" → 2 clientes); `T/phone.spec.ts::un identificador sin dígitos reales suficientes` | verde |
| `0c0bebf` | Voz sin dirección obligatoria; "(1/2 orden)"; tiempo antes de crear el pedido | `R/historial-busqueda-y-datos.spec.ts::X46 / 0c0bebf`; `R/historial-busqueda-y-datos.spec.ts::X56 / 0c0bebf`; prompt: `T/pm-bateria-agente-whatsapp.spec.ts::T-PG07 / X55` | verde |
| `0c0bebf` (grader de voz) | No existe un grader de voz que falle si se da el tiempo antes de crear | `R/casos-b1.spec.ts::0c0bebf / [lote C]` | it.fails (C) |
| `03555e2` | Teléfono sin normalizar duplicaba clientes; `branch_slug` faltante caía a Fco. Montejo | `R/historial-busqueda-y-datos.spec.ts::X16 / 03555e2`; `R/historial-busqueda-y-datos.spec.ts::X44 / 03555e2` (ausente, vacío y desconocido en `buscar_producto`, `cotizar_pedido` y `crear_pedido`) | verde |
| `3571c1c` | Búsqueda no tokenizada; prompt de respaldo desfasado | `R/historial-busqueda-y-datos.spec.ts::X10 / X14 / 3571c1c`; `R/historial-busqueda-y-datos.spec.ts::X39 / 3571c1c` | verde; el segundo: N/A (ya no hay prompt duplicado en BD, solo se prueba que el único conserva las reglas) |
| `5710a5f` | Coordenadas viejas de una colonia → sucursal equivocada | `T/pm-bateria-reglas-duras.spec.ts::T-ZS09` (reporte de colonias a menos de 1 km) | verde |
| `609c3d6` | Un cambio del prompt se revirtió en silencio con `ok:true` | `R/historial-turno-y-pedidos.spec.ts::X53 / 609c3d6: tras guardar`; `R/historial-turno-y-pedidos.spec.ts::X53 / 609c3d6: guardar con una version vieja` | verde |
| `05a9798` / `6091e17` | Cascada barato → caro | `T/pm/fallas-llm.spec.ts::T-FP06`; `R/historial-turno-y-pedidos.spec.ts::X34 / 05a9798` (fallo de sistema → rol escalado) | verde |
| `6091e17` (regla de negocio) | Un rechazo correcto de regla (mínimo, zona, horario) NO sube de rol; solo un fallo de sistema | `R/historial-turno-y-pedidos.spec.ts::X34 / 6091e17 [lote B1, agentes-26]` | verde |
| `10d3485` | Total alucinado; turno sin pregunta; frontera de capas | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG01 / X05`; `T/pm-bateria-agente-whatsapp.spec.ts::T-PG02 / X05`; `T/pm-bateria-agente-whatsapp.spec.ts::T-PG04 / X06`; `R/frontera-de-capas.spec.ts::ningun archivo de packages/domain-restaurantes/src` | verde |
| `9460a3e` | Aviso al cliente por WhatsApp en cambios de estado | `R/historial-avisos-y-despacho.spec.ts::cada estado se avisa UNA sola vez`; `R/historial-avisos-y-despacho.spec.ts::cada aviso lleva su plantilla HSM` | verde |
| `9460a3e` (usted) | Los textos de aviso hablan de usted (corregido en main) | `R/historial-avisos-y-despacho.spec.ts::P26 / 9460a3e [lote F, viaje-10]` | verde |
| `e1ccae0` | Checkout de voz y WhatsApp endurecido; vista previa sin efectos | `R/historial-turno-y-pedidos.spec.ts::X46 / e1ccae0`; `R/historial-turno-y-pedidos.spec.ts::X48 / e1ccae0` | verde |
| `cbad752` | Orden determinista y ruteo de modelos | `T/order-flow.spec.ts::crear_pedido sin cotizacion previa se rechaza` | verde |
| `c2154a5` | Replay de pedidos entrantes | `R/historial-turno-y-pedidos.spec.ts::X31 / c2154a5`; `T/pm/concurrencia.spec.ts::T-CI01`; `S/verify-restaurantes-whatsapp-concurrencia/run.sh::=== 6. Meta reenvia el MISMO message.id` (Postgres real) | verde |
| `1cd7226` | Solo se procesaba el primer mensaje del lote de Meta | `R/historial-turno-y-pedidos.spec.ts::X32 / 1cd7226: un lote con 5 mensajes`; `R/historial-turno-y-pedidos.spec.ts::X32 / 1cd7226: prueba de carga` (25,000 mensajes, `meta-batch.test.ts:25`); `T/pm/concurrencia.spec.ts::T-CI02` | verde |
| `34c2696` | Fallo parcial de envío | `R/historial-avisos-y-despacho.spec.ts::X34 / 34c2696 [lote D, automatizacion-01]` | it.fails (D) |

## 2. Casos B.1 (`X01`-`X58`)

| Caso | Qué rompía | Prueba en main | Estado |
|---|---|---|---|
| X01 | "Individual" no es máximo 1 | `T/pm-bateria-reglas-duras.spec.ts::T-RD13 / X01` | verde |
| X02 | Bistec en órdenes de 3 + aviso | `T/pm-bateria-reglas-duras.spec.ts::T-RD11b / X02`; `T/pm-bateria-agente-whatsapp.spec.ts::T-PG03 / X02` | verde |
| X03 | No múltiplo → error con opciones | `T/pm-bateria-reglas-duras.spec.ts::T-RD12 / X03` | verde |
| X04 | Tortilla por renglón, nunca en refrescos | `T/pm-bateria-reglas-duras.spec.ts::T-RD14 / X04`; `T/pm-bateria-reglas-duras.spec.ts::T-RD15 / X04` | verde |
| X05 | Total alucinado | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG01 / X05` | verde (caso base; huecos "Subtotal" y cifra sin la palabra total: lote B2) |
| X06 | "Voy a revisar" sin pregunta | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG04 / X06` | verde |
| X07 | Pagar antes de cotizar / doble confirmación | `R/casos-b1.spec.ts::X07: crear_pedido sin cotizacion previa`; `T/order-flow.spec.ts::cotizar y confirmar en el MISMO turno` | verde |
| X08 | Pedido duplicado al agotar el loop | `R/historial-turno-y-pedidos.spec.ts::X08 / c25e70c`; `T/pm-bateria-reglas-duras.spec.ts::T-CI07 / X08` | verde |
| X09 | Misma llave, contenido distinto → 409 | `T/pm-bateria-reglas-duras.spec.ts::T-CI05 / X09`; `S/verify-restaurantes-whatsapp-concurrencia/run.sh::=== 3. Misma llave pero CONTENIDO distinto` | verde |
| X10 | "una pizza" → Quesobich | `T/pm-bateria-reglas-duras.spec.ts::T-AM01 / X10` | verde |
| X11 | "cerveza Sol" | `T/pm-bateria-reglas-duras.spec.ts::T-AM03 / X11` | verde |
| X12 | Plurales y "500g" | `T/pm-bateria-reglas-duras.spec.ts::T-AM04 / X12` | verde |
| X13 | "medio kilo", "tres cuartos" | `T/pm-bateria-reglas-duras.spec.ts::T-AM04 / X12 / X13` | verde ("un cuarto de cochinita" lo borra: QA agentes-24, lote B1) |
| X14 | Números hablados como stopwords | `R/historial-busqueda-y-datos.spec.ts::X10 / X14 / 3571c1c` | verde |
| X15 | UUID mal copiado | `T/product-search.spec.ts::resuelve por nombre exacto cuando el id no vino o es inválido` | verde |
| X16 | +52/521 → mismo cliente | `T/pm-bateria-reglas-duras.spec.ts::T-ME05 / X16` | verde |
| X17 | Identificador sin dígitos no colisiona | `R/historial-busqueda-y-datos.spec.ts::X17 / da4ce92` | verde |
| X18 | 11-12 dígitos no se recortan | `T/pm-bateria-reglas-duras.spec.ts::T-AM09 / X18` | verde |
| X19 | Carrera 23505 de cliente nuevo | `R/historial-turno-y-pedidos.spec.ts::X19 / 5d164ee`; `S/verify-restaurantes-whatsapp-concurrencia/run.sh::=== 5. Llaves DISTINTAS` | verde |
| X20 | Nombre mal oído no pisa el conocido | `T/pm-bateria-reglas-duras.spec.ts::T-ME07 / X20` | verde |
| X21 | Nombre vigente tras corrección | `R/casos-b1.spec.ts::X21: el nombre corregido dos veces` | verde |
| X22 | Tarjeta en claro | `T/pm-bateria-agente-whatsapp.spec.ts::T-PA04 / X22`; `R/historial-turno-y-pedidos.spec.ts::X22 / 5d164ee` | verde |
| X23 | "No disponible" como pretexto con alcohol | `R/historial-turno-y-pedidos.spec.ts::X23 / 5d164ee` | verde (la regla P01 de alcohol a domicilio lo reemplaza) |
| X24 | 0.0 / sin alcohol no es alcohol | `R/casos-b1.spec.ts::X24: Heineken 0.0` | verde |
| X25 | Notas a cocina | `T/pm-bateria-reglas-duras.spec.ts::T-RD18 / P07 / X25`; `R/historial-busqueda-y-datos.spec.ts::X25 / 72fd6ad` | verde |
| X26 | "Guacamole" vs "Extra Guacamole" | `T/pm-bateria-reglas-duras.spec.ts::T-AM06 / X26` | verde |
| X27 | No volver a pedir el nombre | `R/casos-b1.spec.ts::X27: el agente recibe el nombre`; `R/casos-b1.spec.ts::X27 / 72fd6ad [lote R1]` | verde (contexto); regla explícita: it.fails (R1) |
| X28 | Repartidor específico | `R/casos-b1.spec.ts::X28 / 0a346be`; `T/pm-bateria-agente-whatsapp.spec.ts::T-HO12 / X28` | verde (regla en el prompt); medirla con modelo real: it.todo |
| X29 | Fallo de `crear_pedido` → re-buscar el producto | `R/casos-b1.spec.ts::X29 / 0a346be: el prompt generico`; `R/casos-b1.spec.ts::X29 / 0a346be [lote R1]` | verde (genérico); perfil PM: it.fails (R1) |
| X30 | Mensajes simultáneos se pisaban | `R/casos-b1.spec.ts::X30 / 0a346be`; `S/verify-restaurantes-whatsapp-concurrencia/run.sh::=== 8. Tres mensajes del mismo cliente` | verde |
| X31 | Meta reenvía el mismo id | `R/historial-turno-y-pedidos.spec.ts::X31 / c2154a5`; `T/pm/concurrencia.spec.ts::T-CI01` | verde |
| X32 | Lote Meta completo | `T/pm/concurrencia.spec.ts::T-CI02`; `R/historial-turno-y-pedidos.spec.ts::X32 / 1cd7226: un lote con 5 mensajes` | verde |
| X33 | Conversación ocupada → 5xx reintentable | `R/casos-b1.spec.ts::X33 / 0a346be`; `T/pm/concurrencia.spec.ts::T-CI03`; `S/verify-restaurantes-whatsapp-concurrencia/run.sh::=== 7. Tres mensajes DISTINTOS` | verde |
| X34 | Caída del proveedor → respaldo | `T/pm-bateria-agente-whatsapp.spec.ts::T-FP03 / X34`; `R/historial-turno-y-pedidos.spec.ts::X34 / 05a9798` | verde (deadline de 45 s vs función de 30 s: lotes B2/E) |
| X35 | Caída tras crear → confirma el pedido | `T/pm/fallas-llm.spec.ts::T-FP04b` | verde |
| X36 | No mutar el historial del llamador | `R/casos-b1.spec.ts::X36 / 0a346be` | verde (main reconstruye un arreglo efímero por turno; la regresión es que el arreglo congelado queda intacto) |
| X37 | Cancelación/cobro/urgencia/ARCO antes del LLM | `T/pm-bateria-agente-whatsapp.spec.ts::T-HO02 / X37`; `T/pm-bateria-agente-whatsapp.spec.ts::T-HO03 / X37`; `T/pm-bateria-agente-whatsapp.spec.ts::T-HO04 / X37`; `T/pm-bateria-agente-whatsapp.spec.ts::T-HO05 / X37` | verde (falsos positivos: lote B1; callback no idempotente: R1) |
| X38 | Prompt guardado no borra reglas | `T/pm-bateria-agente-whatsapp.spec.ts::T-AB06 / X38` (WhatsApp); `R/casos-b1.spec.ts::X38 / [lote R1]` (voz) | verde en WhatsApp; voz: it.fails (R1) |
| X39 | Prompt de respaldo desfasado | `R/historial-busqueda-y-datos.spec.ts::X39 / 3571c1c` | N/A (ya no hay prompt duplicado en BD) |
| X40 | Saludo por hora | `R/historial-busqueda-y-datos.spec.ts::X40 / 6d07364: WhatsApp a las`; `T/pm-bateria-agente-whatsapp.spec.ts::T-PC03` | verde |
| X41 | "Alta Brisa" | `T/pm-bateria-reglas-duras.spec.ts::T-ZS01 / X41`; `R/historial-busqueda-y-datos.spec.ts::X41 / 6d07364` | verde |
| X42 | Colonias con 2 sucursales a < 1 km | `T/pm-bateria-reglas-duras.spec.ts::T-ZS09 / X42` | verde |
| X43 | Sucursal por Haversine | `T/nearest-branch.spec.ts::calcula una distancia real razonable` | verde |
| X44 | `branch_slug` faltante no cae en silencio | `T/pm-bateria-reglas-duras.spec.ts::T-ZS08 / X44`; `R/historial-busqueda-y-datos.spec.ts::X44 / 03555e2` | verde |
| X45 | Tools de voz con 401 por JWT | `A/pm-voz-seguridad.spec.ts::T-AB07` | N/A (token por llamada) |
| X46 | Dirección obligatoria a domicilio | `R/historial-busqueda-y-datos.spec.ts::X46 / 0c0bebf`; `R/historial-turno-y-pedidos.spec.ts::X46 / e1ccae0` | verde |
| X47 | Placeholders de variables dinámicas | `T/pm-bateria-agente-whatsapp.spec.ts::T-FP12` | N/A (sin ElevenLabs; el saludo lo calcula el servidor) |
| X48 | Vista previa no crea pedidos reales | `R/historial-turno-y-pedidos.spec.ts::X48 / e1ccae0`; `T/voz-catalogo-y-token.spec.ts::token efimero de preview` | verde |
| X49 | "Lo de siempre" sin cancelados | `R/casos-b1.spec.ts::X49: 'lo de siempre'` | verde |
| X50 | Tier VIP usado | `R/casos-b1.spec.ts::X50: el prompt GENERICO`; `R/casos-b1.spec.ts::X50 / [lote R1]` | verde (genérico y perfil PM) |
| X51 | Un solo "¿sigue ahí?" y colgar | `R/casos-b1.spec.ts::X51 / [lote R1]` | it.fails (R1) |
| X52 | Precios solo de la tool en esta llamada | `R/casos-b1.spec.ts::X52 / [lote C, agentes-13]` | verde |
| X53 | Releer el prompt tras cada cambio | `R/historial-turno-y-pedidos.spec.ts::X53 / 609c3d6: tras guardar` | verde (runbook: `docs/runbooks/RESTAURANTES-AGENTE.md`) |
| X54 | Widget: misma forma de respuesta | `R/casos-b1.spec.ts::X54 / 5d164ee` | verde |
| X55 | Tiempo solo después de crear | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG07 / X55` | verde (falta el grader de voz: ver la fila `0c0bebf`) |
| X56 | "(1/2 orden)" | `T/pm-bateria-reglas-duras.spec.ts::T-AM07 / X56` | verde |
| X57 | Correlation id hostil / PII en logs | `A/restaurantes-http-security-original.spec.ts::X57 / original :7 [lote A, seguridad-12]`; `A/restaurantes-http-security-original.spec.ts::X57 / original :18` | verde en PII de logs; id hostil: it.fails (A) |
| X58 | `X-Forwarded-For` falsificado | `A/restaurantes-http-security-original.spec.ts::X58 / original :123`; `A/http-security-request-actor.spec.ts::usa el ÚLTIMO salto de x-forwarded-for` | verde |

## 3. Pruebas unitarias del original (`ORIG/supabase/functions/_shared/*.test.ts`)

### `whatsapp-agent-core.test.ts`

| Línea | Prueba del original | Equivalente en main | Estado |
|---|---|---|---|
| :18 | Bistec siempre en órdenes de 3; pastor individual sin tope | `T/pm-bateria-reglas-duras.spec.ts::T-RD11 / X02 / X03`; `T/pm-bateria-reglas-duras.spec.ts::T-RD13 / X01` | verde |
| :42 | Cotiza y crea con cantidades pedidas | `T/pm-bateria-reglas-duras.spec.ts::T-RD11b / X02` | verde |
| :83 | Complementos incluidos y a petición son metadatos gratis | `T/pm-bateria-reglas-duras.spec.ts::T-RD21 / P09` | verde |
| :102 | Toda respuesta a bistec dice "órdenes de 3" | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG03 / X02` | verde |
| :128 | Un prompt guardado no quita identidad ni reglas | `T/pm-bateria-agente-whatsapp.spec.ts::T-AB06 / X38`; `T/agente-whatsapp-editor.spec.ts::las reglas duras no cambian aunque se personalice todo` | verde |
| :197-:239 | `enforceQuotedTotal` (cifra junto a "total", en pesos, total correcto, precios unitarios, sin total conocido) | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG02 / X05` | verde |
| :320 | Un turno completo corrige el total alucinado | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG01 / X05` | verde |
| :394-:434 | `pendingQuestionForMissingData` y `enforcePendingQuestion` | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG04 / X06`; `T/pm-bateria-agente-whatsapp.spec.ts::T-PG05 / X06 / P26`; `T/pm-bateria-agente-whatsapp.spec.ts::X06 una respuesta que ya termina en pregunta` | verde |
| :442 | Respuesta que se queda esperando fuerza una pregunta concreta | `T/pm-bateria-agente-whatsapp.spec.ts::T-PG04 / X06` | verde |
| :498-:532 | `classifyHighRiskIntent` (cancelación, cobro duplicado, urgencia, ARCO, sin falsos positivos) | `T/pm-bateria-agente-whatsapp.spec.ts::T-HO02 / X37`; `T/pm-bateria-agente-whatsapp.spec.ts::T-HO03 / X37`; `T/pm-bateria-agente-whatsapp.spec.ts::T-HO04 / X37`; `T/pm-bateria-agente-whatsapp.spec.ts::T-HO05 / X37`; `T/pm-bateria-agente-whatsapp.spec.ts::un pedido normal NO se intercepta` | verde |
| :541 | Una cancelación se corta antes del modelo y registra un callback | `T/pm-bateria-agente-whatsapp.spec.ts::escala '${motivo}' sin llamar al modelo, sin crear pedido` | verde |
| :607 | La falla del proveedor nunca niega un pedido ya creado | `T/pm/fallas-llm.spec.ts::T-FP04b` | verde |
| :620 | El turno preserva el historial del llamador | `R/casos-b1.spec.ts::X36 / 0a346be` | N/A (main no muta el historial) |
| :677 | Respaldo cross-provider en el mismo turno | `T/pm/fallas-llm.spec.ts::T-FP03` | verde |

### `create-order-core.test.ts`

| Línea | Prueba del original | Equivalente en main | Estado |
|---|---|---|---|
| :188 | Validación estricta compartida por pedido real y vista previa, antes de tocar la base | `R/historial-turno-y-pedidos.spec.ts::X46 / e1ccae0` | verde |
| :237 | Cantidad heredada y piezas conservan tortilla y totales, sin escrituras en la vista previa | `T/pm-bateria-reglas-duras.spec.ts::T-RD14b / P08`; `R/historial-turno-y-pedidos.spec.ts::X48 / e1ccae0` | verde |
| :271 | Memoria del cliente: conteos concurrentes y dirección por defecto | `R/unitarias-original-pedidos.spec.ts::original :271` | verde |
| :282 | Errores de búsqueda/conteo/escritura de dirección impiden crear el pedido | `R/unitarias-original-pedidos.spec.ts::original :282` | verde |
| :301 | Un alta concurrente de cliente se recupera sin reiniciar `order_count` | `R/historial-turno-y-pedidos.spec.ts::X19 / 5d164ee` | verde |
| :320 | Pedidos canónicamente idénticos conservan la huella | `R/unitarias-original-pedidos.spec.ts::original :320` | verde |
| :349 | Cambios materiales alteran la huella; las llaves de reintento son estables | `R/unitarias-original-pedidos.spec.ts::original :349` | verde |
| :395 | Conflictos de idempotencia = conflicto tipado | `T/pm-bateria-reglas-duras.spec.ts::T-CI05 / X09` | verde |
| :408 | La voz exige conversación válida; un marcador vencido nunca es pedido | `T/voz-in-memory-repository.spec.ts::preview: se consume UNA sola vez, no expirada, solo con la organizacion/sucursal correctas` | verde |
| :480 | La vista previa verifica la propiedad y no pisa a otro tenant | `T/voz-in-memory-repository.spec.ts::preview: se consume UNA sola vez, no expirada, solo con la organizacion/sucursal correctas`; `T/voz-in-memory-repository.spec.ts::cerrar rechaza un pedido de otra organizacion` | verde |
| :540 | Rechaza no-objeto e identidad faltante | `R/unitarias-original-pedidos.spec.ts::original :540` | verde |
| :545 | Rechaza campos del cliente demasiado grandes | `R/unitarias-original-pedidos.spec.ts::original :545` | verde |
| :554 | Rechaza demasiados renglones o cantidades fuera de rango | `R/unitarias-original-pedidos.spec.ts::original :554`; `T/pm-bateria-reglas-duras.spec.ts::T-AM16` | verde |
| :573 | Cotización convierte piezas a unidades de menú con total exacto | `T/pm-bateria-reglas-duras.spec.ts::T-RD11b / X02` | verde |
| :636 | Cotización rechaza todo no múltiplo de 3 | `T/pm-bateria-reglas-duras.spec.ts::T-RD11 / X02 / X03` | verde |
| :666 | Cotización bloquea todo renglón de tacos sin tortilla | `T/pm-bateria-reglas-duras.spec.ts::T-RD14 / X04` | verde |
| :691 | Nunca guarda tortilla en no-tacos | `T/pm-bateria-reglas-duras.spec.ts::T-RD15 / X04` | verde |
| :714 | El modo de vista previa solo se confía a la tool autenticada | `T/voz-catalogo-y-token.spec.ts::token efimero de preview` | verde |
| :735 | Alcohol exige confirmación de edad; las bebidas 0.0 no | `R/casos-b1.spec.ts::X24: Heineken 0.0`; `T/pm-bateria-reglas-duras.spec.ts::T-RD05` | verde |
| :774 | Solo pedidos exitosos son elegibles para recomendaciones | `R/casos-b1.spec.ts::X49: 'lo de siempre'` | verde |
| :799 | La búsqueda ignora cantidades habladas y relleno de categoría | `T/pm-bateria-reglas-duras.spec.ts::T-AM03 / X11` | verde |
| :819 | Teléfonos de voz canonicalizados solo desde formatos mexicanos válidos | `T/pm-bateria-reglas-duras.spec.ts::T-AM10 / X18` | verde |
| :844 | Un nombre exacto recupera un UUID mal copiado | `T/product-search.spec.ts::resuelve por nombre exacto cuando el id no vino o es inválido` | verde |
| :869 | La recuperación rechaza un id válido con nombre distinto | `T/product-search.spec.ts::RECHAZA cuando el id y el nombre mandados no coinciden` | verde |
| :903 | Complementos: por omisión y a petición; doble porción cobrada (las 9 salsas de PM) | `T/pm-bateria-reglas-duras.spec.ts::T-RD21 / P09`; `T/pm-bateria-reglas-duras.spec.ts::T-PC06` | verde |

### Seguridad HTTP, firma, lote, timeout, observabilidad y frontera de capas

| Original | Equivalente en main | Estado |
|---|---|---|
| `http-security.test.ts:16` secretos | `A/restaurantes-http-security-original.spec.ts::original :16` | verde |
| `http-security.test.ts:22` origen exacto | `A/restaurantes-http-security-original.spec.ts::original :22` | verde |
| `http-security.test.ts:35`, `:56`, `:68` CORS y preflight | `A/origin-guard.spec.ts::Origin ajeno, 'null' o malformado: rechaza` | verde (guardia de origen propia de la API) |
| `http-security.test.ts:82`, `:96` JSON acotado | `A/restaurantes-http-security-original.spec.ts::original :82`; `A/restaurantes-http-security-original.spec.ts::original :96` | verde |
| `http-security.test.ts:114` hash del actor | `A/restaurantes-http-security-original.spec.ts::original :114` | verde |
| `http-security.test.ts:123` prefijos de `X-Forwarded-For` | `A/restaurantes-http-security-original.spec.ts::X58 / original :123` | verde |
| `meta-signature.test.ts` | `T/whatsapp-meta-signature.spec.ts::acepta una firma real calculada`; `T/whatsapp-meta-signature.spec.ts::rechaza si el body fue alterado` | verde |
| `meta-batch.test.ts:7`, `:25` | `R/historial-turno-y-pedidos.spec.ts::X32 / 1cd7226: el lote descarta`; `R/historial-turno-y-pedidos.spec.ts::X32 / 1cd7226: prueba de carga` | verde |
| `fetch-timeout.test.ts:7`, `:17` | `packages/agent-core/tests/gateway/openrouter-provider.spec.ts` (`un timeout se reporta como error transitorio`); el tope por llamada del gateway sigue abierto: `T/pm-bateria-agente-whatsapp.spec.ts::T-FP05b` | verde (proveedor); gateway: it.todo (lotes B2/E) |
| `observability.test.ts:7` correlation id | `A/restaurantes-http-security-original.spec.ts::X57 / original :7 [lote A, seguridad-12]` | it.fails (A) |
| `observability.test.ts:18` metadatos sin PII | `A/restaurantes-http-security-original.spec.ts::X57 / original :18`; `A/logger-scrub-pii.spec.ts::redacta telefonos, correos, tarjetas, tokens y JWT` | verde |
| `layer-boundary.test.ts:60`, `:79`, `:98` | `R/frontera-de-capas.spec.ts::ningun archivo de packages/domain-restaurantes/src`; `R/frontera-de-capas.spec.ts::ancla`; `R/frontera-de-capas.spec.ts::control positivo` | verde |

### Pruebas SQL del original en Postgres real

| Original | Equivalente en main | Estado |
|---|---|---|
| `order_idempotency.sql` | `S/verify-restaurantes-sql/assertions.sql::=== 3. Reintento con la MISMA idempotency_key` | verde (una conexión) |
| `order_idempotency_concurrency.sh` (dos conexiones) | `S/verify-restaurantes-whatsapp-concurrencia/run.sh::=== 1. Misma llave y misma huella` | verde (nuevo en este PR; job `restaurantes-whatsapp-concurrencia-gate` de `postgres-real-gate.yml`) |
| `whatsapp_delivery.sql` | `S/verify-restaurantes-sql/assertions.sql::=== 11. claim_whatsapp_message` | verde (el despacho "uno por uno" lo arregla el lote D) |
| `voice_preview_sessions.sql` | `S/verify-restaurantes-voz/assertions.sql::restaurantes.voice_preview_sessions` | verde |
| `notification_reads.sql` | `S/verify-restaurantes-sql/assertions.sql::=== 18. enqueue_staff_order_notification` | verde |
| outbox, privacidad, roles, rate limit | lotes D y A (`messaging_outbox_concurrency.sh`, `privacy_dsar.sql`, `tenant_role_matrix.sql`, `api_rate_limits.sql`) | no se portan aquí |

## 4. Huecos conocidos que este PR documenta con `it.fails` (se cierran en otro PR)

`B1`: rechazo de regla escala de rol (agentes-26). `R1`: regla "no pedir el nombre", re-buscar tras fallo, nota VIP en el perfil PM, un solo "¿sigue ahí?", reglas duras anexadas a la
instrucción de voz. `C`: grader de precios y de tiempo antes de crear en voz. `A`: correlation id hostil. `D`: fallo parcial del lote de envío. `F`: avisos de estado en usted.

## 5. Observabilidad por turno de WhatsApp (R-PM-15)

`packages/domain-restaurantes/src/whatsapp/observabilidad-turno.ts` y `llm-turn-handler.ts` emiten un evento `whatsapp_turno` por turno y uno `whatsapp_tool` por
herramienta. Pruebas: `T/whatsapp/observabilidad-turno.spec.ts` y `A/restaurantes-observabilidad-turno.spec.ts`. Runbook: `docs/runbooks/RESTAURANTES-AGENTE.md`.
