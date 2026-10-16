# Cierre del pedido como máquina de estados (R11, arquitectura B)

Código: `packages/domain-restaurantes/src/agent-tools/cierre-maquina.ts`, con enganches en `registry.ts` (`cotizar_pedido`, `confirmar_resumen`, `crear_pedido`) y `whatsapp/llm-turn-handler.ts`.
Pruebas: `packages/domain-restaurantes/tests/pm-r11-cierre-maquina.spec.ts` y `pm-r11-cierre-endurecido.spec.ts` (deterministas, modelo guionado, sin red ni gasto de LLM).

## Qué hace

El tramo crítico `resumen -> «sí» explícito al resumen vigente -> crear_pedido` lo decide el **servidor**, no el modelo:

```
borrador --cotizar_pedido--> cotizado --(el asistente MUESTRA el resumen)--> resumen_mostrado
resumen_mostrado --(su última pregunta es de confirmación)--> esperando_confirmacion
esperando_confirmacion --(último mensaje del cliente = «sí» explícito)--> confirmado --crear_pedido--> creado
```

`resumen_mostrado` y `esperando_confirmacion` no se guardan: se derivan del historial (`estadoDeCierre`), así no hay un estado que pueda quedar desincronizado con lo que el cliente vio.

Reglas (solo WhatsApp con historial; la voz no pasa por aquí):

- El texto del resumen lo arma el servidor (`resumen_canonico`: renglones, entrega, pago, propina y **total**). Si el modelo pide confirmar sin el total, el cliente recibe el resumen del servidor.
- `confirmar_resumen` procede solo si el **último** mensaje del asistente es el resumen vigente (trae el total cotizado y su última pregunta es de confirmación) y el último del cliente es un «sí» explícito.
- No confirman: «No», «nop», «nada», pago o propina («efectivo», «con 600», «sin propina», «No gracias. Pago con $1,000»), preguntas, titubeos («sí, creo»), cambios de cantidad, de producto, de dirección o de pago. Los datos de pago/propina se **adoptan** en el servidor y se rearma el resumen; el cliente debe decir «sí» al resumen nuevo.
- «ok», «ok gracias», «No gracias» y «no, así está bien» **contestados al resumen** (que pregunta si está correcto) sí son el visto bueno; contestados a una pregunta de propina o de pago, no.
- `crear_pedido` exige que pago, efectivo y propina coincidan con los de la confirmación; si cambian, el servidor vuelve a `cotizado`, rearma el resumen y pide otro «sí». Si en el turno de crear el cliente rechazó o cambió algo, tampoco crea.
- Doble «sí» o llamadas concurrentes: un solo pedido (el reclamo `creando` usa compare-and-swap). Un reclamo viejo (proceso muerto) se retoma sin pedir otro «sí».

### Salidas seguras (no se traba)

| Situación | Salida |
|---|---|
| El texto no reconoce el resumen como mostrado (total en letras, pregunta final rara, fuera de la ventana de historial) | Se rechaza **una** vez y se guarda el turno (`cierreNoVistoTurn`); en un turno posterior un «sí» claro ya se acepta. |
| Mensaje ambiguo e inocuo («mmm», «a ver») | Se rechaza una vez (`cierreAmbiguoTurn`); en un turno posterior, tras volver a mostrar el resumen, pasa. |
| Pregunta, duda, negación, dato o cambio | **Nunca** pasa por la salida segura: el cliente sigue hablando con el asistente (o se escala a una persona por las vías normales). |

Límite honesto: el servidor no oye al cliente, clasifica texto. La clasificación es conservadora: ante la duda no confirma y pide un «sí».

## Cómo activarla y desactivarla

Variable de entorno `RESTAURANTES_CIERRE_MAQUINA_ESTADOS` en el servicio de API que atiende el webhook de WhatsApp (se lee en cada turno; no hace falta reconstruir).

| Valor | Efecto |
|---|---|
| sin definir, vacío, `0` o cualquier otro | **Apagada** (por omisión). Comportamiento idéntico a `main` (guarda de #566). |
| `1`, `true`, `on` o `si` | **Encendida**. |

- Activar: definir la variable con `1` en el entorno (Vercel, variables de entorno del proyecto de la API) y redesplegar para que el entorno nuevo llegue a las funciones. Hacerlo con OK de Javier; no la toca ninguna migración.
- Desactivar (reversa inmediata): quitar la variable o ponerla en `0` y redesplegar. No hay datos que migrar: los campos extra del contexto del flujo (`resumenCanonico`, `confirmedFirma`, `cierreAmbiguoTurn`, `cierreNoVistoTurn`, propina cotizada) son opcionales y se ignoran con la bandera apagada. Un pedido que estaba a medias en `confirmado` sin firma cae a la guarda de #566.
- Sin migración SQL: el contexto del flujo es JSON y los campos nuevos son opcionales.

## Convivencia con la guarda de #566

- **Bandera apagada**: la máquina no corre; `crear_pedido` aplica la guarda de #566 exactamente como en `main`.
- **Bandera encendida**: para una confirmación hecha por la máquina (lleva `confirmedFirma`), `crear_pedido` aplica la verificación de la máquina (firma de pago/efectivo/propina y rechazo/cambio posterior) y **no** la guarda de #566; para una confirmación sin firma (flujo ya confirmado antes de encender la bandera) aplica la guarda de #566. Nunca corren las dos sobre la misma confirmación, y la máquina es más estricta que la guarda.
- Prueba de no contradicción: `pm-r11-cierre-endurecido.spec.ts` recorre una matriz de preguntas del asistente por mensajes del cliente y afirma que, si la máquina encendida crea el pedido, la guarda de #566 (bandera apagada) también lo habría creado.

## Qué no cubre

La efectividad con un modelo real (que pegue el resumen canónico y no insista) solo se mide en una ronda A/B con LLM real; estas pruebas cubren el servidor.
