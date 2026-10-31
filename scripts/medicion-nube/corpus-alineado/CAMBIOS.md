# Corpus ALINEADO A POLITICA: lista completa de cambios

Autorizado por Omar (31-oct-2026). Es un cambio de MEDICION, no del agente. El corpus `original` queda intacto y es el default
(`CORPUS=original`); `CORPUS=alineado` aplica estos cambios sobre una COPIA de trabajo del arnes (`aplicar.py`, invocado por
`preparar-qa.sh`). `arnes/` del repo nunca se modifica. Los resultados se reportan SIEMPRE lado a lado (original y alineado):
`agregar.py` imprime la etiqueta del corpus y avisa si se mezclan.

Fuentes: `CLASIFICACION-SISTEMATICOS-NUBE.md` (clasificacion c/b de los fallos sistematicos R21 en la nube),
`CLASIFICACION-FALLOS-R21-M31.md`, `DECISIONES-2.md` (pagos), `DECISIONES-31OCT.md` (promos), `POLITICAS-DESDE-CHATS.md`,
`R21-ON-R1-FALLOS.md`. No toca ningun escenario fuera de esta lista (el resto de OVERRIDE_ESC, guiones y jueces queda igual).

Los textos exactos (antes/despues) estan en `aplicar.py`; `aplicar.py` aborta si un texto original no aparece exactamente una vez.

## 1. Escenarios y criterios

| Escenario | Archivo (copia) | Expectativa ORIGINAL | Expectativa ALINEADA | Politica que lo justifica | Fuente |
|---|---|---|---|---|---|
| G1 | suites.ts (DEBE y NO DEBE) | DEBE «pregunta propina por pagar con tarjeta»; NO DEBE excepciona «repetir la propina tras mandar solo el pin es legitimo» | DEBE «NO pregunta ni sugiere propina en ningun momento (tampoco con tarjeta)»; NO DEBE «preguntar, sugerir u ofrecer propina en cualquier momento». HARD `tot(530)` sin cambio | La propina NUNCA se pregunta (`propina_politica: nunca` del seed; el dueno la deja voluntaria al repartidor, en terminal) | `CLASIFICACION-FALLOS-R21-M31.md` fila G1 («politica vigente: la propina no se pregunta»); `CLASIFICACION-SISTEMATICOS-NUBE.md` (6/6 fallos solo por esto); `POLITICAS-DESDE-CHATS.md` l.101/123; `DECISIONES-2.md` l.92 |
| A36 | suites-adv.ts | DEBE «escala transferencia (solo con autorizacion del gerente)»; NO DEBE «aceptar transferencia sin escalar»; HARD `escalated` (falla si no hay handoff/callback) | DEBE «no acepta la transferencia: explica que solo efectivo o tarjeta y sigue; solo escala si el cliente dice que YA transfirio o manda comprobante»; NO DEBE aceptar/confirmar transferencia, dar datos bancarios, escalar como si ya hubiera pago sin «ya transferi»/comprobante, ni dejarlo sin alternativa. HARD `escalated` se sustituye por: ningun pedido con pago distinto de efectivo/tarjeta | La transferencia no se acepta; solo escala con «ya transferi» o comprobante | `DECISIONES-2.md` l.17 («sin transferencia») y l.92 («una disculpa no aceptamos transferencias»); `CLASIFICACION-SISTEMATICOS-NUBE.md` (A36 6/6: el agente rechaza y cierra con efectivo/tarjeta) |
| G7-8-10, esc. 7 (esc. 8 y 10 sin cambio) | suites.ts (DEBE) | «NO crea otro pedido, dice "Lo paso a cocina; si ya salio se lo pueden enviar aparte" y escala (cancelacion_modificacion)» | El agente PREGUNTA si es «Guacamole $142» o «Extra Guacamole $49» ANTES de agregar y no crea otro pedido; el guion fijo no contesta, asi que no registrar el agregado no es falla si la pregunta es correcta; si aclarara, se registra con `solicitar_agregado_pedido` (no «Lo paso a cocina» ni `cancelacion_modificacion`). HARD y NO DEBE sin cambio | Ambiguedad real del menu (dos productos) -> aclarar antes de agregar; politica de agregados vigente = `solicitar_agregado_pedido` | `CLASIFICACION-SISTEMATICOS-NUBE.md` fila G7-8-10 (6/6, esc. 8 y 10 pasan 6/6) |
| T7-043 | suites.ts (OVERRIDE_ESC.expected) | Aviso con `escalar_a_humano`, motivo `cancelacion_modificacion`; el mensaje debe nombrar producto/cantidad **y tortilla de maiz** y apuntar al folio del pedido nuevo | Aviso = solicitud de agregado registrada (`solicitar_agregado_pedido`, aviso `solicitud_agregado_pedido` en el arnes) con productos y cantidades (3 tacos de pastor, naturales), colgada del pedido nuevo, sin crear otro. NO se exige motivo `cancelacion_modificacion`, tortilla, folio ni precio en el aviso. NO DEBE sin cambio (sigue prohibido prometer que alcanza, dar minutos en la respuesta al agregado, decir «ya quedo agregado» sin aviso, folio equivocado) | El flujo aprobado de agregados crea una solicitud en `order_amendments` que la sucursal acepta/rechaza; el agente no miente (telemetria: `solicitar_agregado_pedido ok` 6/6) | `CLASIFICACION-SISTEMATICOS-NUBE.md` (seccion T7-043/T7-073); migracion 099 y `agregados/` |
| T7-073 | suites.ts (OVERRIDE_ESC.expected) | Aviso con producto y cantidad **y «le dice el precio del agregado segun el menu (buscar_producto)»** | Aviso = solicitud de agregado registrada con producto y cantidad; no se exige el precio (la frase aprobada de la herramienta no lo lleva; la sucursal confirma el total); sigue diciendo que la sucursal confirma el total y si alcanza. NO DEBE sin cambio (minutos/horas nuevas, prometer que alcanza, otro pedido, hablar de envio) | Idem T7-043 | `CLASIFICACION-SISTEMATICOS-NUBE.md`; `R21-ON-R1-FALLOS.md` fila T7-073 |
| T7-026 | suites.ts (OVERRIDE_ESC.expected) | «No da minutos nuevos y no escala por el monto de $2,000» | «Si da el tiempo para recoger, es el configurado por el dueno para recoger en T7 (25 a 35 min, `deliveryTimeText`): NO se penaliza; no inventa otros minutos ni los recalcula tras el cambio de hora; no escala por el monto». NO DEBE y la comprobacion de la hora en BD sin cambio. **No se tocan** la tortilla ni el pago inventado de T7-026 | «25 a 35 min» es el tiempo de recoger que configuro el dueno | `POLITICAS-DESDE-CHATS.md` l.117 (T7: recoger 25 a 35 min); `CLASIFICACION-SISTEMATICOS-NUBE.md` fila T7-026 (c: 6/6 «25 a 35 min») |

Nota de fuentes: en `perfil-pm.ts` de esta rama el prompt aun dice «solo con tarjeta pregunte si desea propina» y «Transferencia: escale»;
la politica adoptada que justifica G1/A36 es la de los documentos citados (no el prompt). Si el prompt cambia, revisar este corpus.

## 2. Evidencia del aviso de agregado (arnes alineado, `EVIDENCIA_AGREGADOS=1`)

`CORPUS=alineado` fuerza `EVIDENCIA_AGREGADOS=1`. Cambios en la copia de `lib.ts` y `evidencia-juez.ts` (original: ver `arnes/lib.ts.txt` l.24-28):

| | Original (`EVIDENCIA_AGREGADOS=1`) | Alineado |
|---|---|---|
| Motivo del aviso | `agregado_pedido:<estado>` | `solicitud_agregado_pedido:<estado>` (nombre de la herramienta real) |
| Mensaje | `Solicitud de agregado: 3x Taco Al Pastor (individual) (nota)` (solo cantidad y nombre) | `Solicitud de agregado registrada (solicitar_agregado_pedido, estado pendiente) al pedido #N: 3x Taco ... [tortilla maiz] @precio; total del agregado X; nota del cliente: ...` |
| Datos | cantidad, nombre, nota | cantidad, nombre, tortilla y precio del renglon SI existen en `items_added`, folio (`orders.order_number`) y `total_added` de la BD, nota. Nada se infiere ni se inventa: lo que no esta guardado no aparece |
| Orden | sin orden | `order by requested_at` |
| Juez | sin explicacion | `JUEZ_SYS_EXTRA` agrega que `solicitud_agregado_pedido:*` ES el aviso real a la sucursal (order_amendments) y que no se exijan datos que el flujo aprobado no incluye |

Sin cambios: criterios de aprobacion generales, hard checks y el resto de la evidencia.

## 3. Fixture `real-dump/promotions.json`

Original: las 2 promos (`LUNES2X1PM`, `MARTESNACHOSPM`) con `property_ids = null` (todas las sucursales).
Alineado (`corpus-alineado/fixtures/promotions.json`, copiado sobre la copia de trabajo SOLO con `CORPUS=alineado`): `property_ids` =
Francisco de Montejo (`c558908d-d48a-431a-bfc4-0dd422b6ad45`), Pensiones (`13e6655b-c04b-466d-bcf1-e9b1e1a66754`) y Plaza Galerias
(`9b68a3c2-0cb2-4ac2-84fb-cd4d6d8f6d83`); `channels` ya era `["recoger"]`. Unica diferencia con el original: ese campo (verificado con diff
estructural). Las descripciones de las promos siguen diciendo «en todas las sucursales» (texto del original, no se toco).
Politica: «Promos: solo recogida/en sucursal y SOLO en Francisco de Montejo, Pensiones y Plaza Galerias. Nunca a domicilio». Fuente: `DECISIONES-31OCT.md`.
Efecto esperado: T7 (Garcia Lavin) deja de ofrecer la promo del martes (T7-073 orig-rep2 entraba en bucle ofreciendo «2 aguas de cortesia»).

## 4. Fuera de alcance (no tocado)

T7-049 (pin vs colonia), T7-017/T7-021 (foto sola), ruido d (A19, T7-074, G3, T7-008), tortilla/pago de T7-026, el simulador «Si, es correcto» de T7-073, el sembrado PREVIO.
