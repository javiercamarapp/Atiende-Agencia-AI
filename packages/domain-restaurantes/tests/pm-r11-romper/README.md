# pm-r11-romper -- suite "romper" del agente de PM (R11)

Red team **determinista**: modelo simulado (`FakeLlmProvider` con guion) + herramientas y repositorio reales (en memoria). Sin LLM real, sin red, gratis, corre en CI.
Mide lo que **el servidor garantiza aunque el modelo falle u obedezca a un cliente hostil**. Complementos fuera de esta carpeta:

- `packages/voice-core/tests/pm-r11-romper-maquina.spec.ts` -- la maquina de la llamada de voz contra secuencias hostiles (500 llamadas con semilla fija).
- `packages/whatsapp-gateway/tests/pm-r11-romper-proveedor.spec.ts` -- el proveedor de WhatsApp (Meta) falla o contesta raro.
- `scripts/verify-restaurantes-pm-r11-romper/` -- la capa Postgres real (jsonb, RLS, RPC de solo sistema).

| Archivo | Categoria |
|---|---|
| `1-inyeccion-y-jailbreak.spec.ts` | inyeccion de prompt, jailbreaks es / en / mezclado, prompt, precios, descuentos, devoluciones de dinero, suplantacion de staff |
| `2-abuso-y-entradas-raras.spec.ts` | spam, mensajes gigantes, emojis / unicode, audios vacios, mensajes fuera de orden, repetidos |
| `3-concurrencia-e-idempotencia.spec.ts` | dos "si" simultaneos, doble clic en Confirmar, mismo telefono en dos organizaciones, carreras, reintentos del webhook |
| `4-errores-y-excepciones.spec.ts` | LLM caido / lento / mal formado, tool_call invalido, herramienta que lanza, base caida |
| `5-negocio-y-privacidad.spec.ts` | pedidos enormes, cantidades, horarios limite, fuera de zona, alcohol, alergias, privacidad, cobro y propina |
| `6-voz-herramientas.spec.ts` | las mismas herramientas con el canal de voz |
| `7-ronda-2-imposibles.spec.ts` | R12: pedidos imposibles (producto agotado o inexistente, hora pasada, sucursal cerrada hoy, feriado, programar a meses, direccion de relleno, cancelar o cambiar un pedido que ya avanzo, mezclar canales, billete menor al total) |
| `8-ronda-2-cambios-en-la-conversacion.spec.ts` | R12: cambios entre cotizar, confirmar y crear (precio, promocion, horario, sucursal), horario de verano, dia de negocio, reloj que retrocede |
| `9-ronda-2-entradas-raras.spec.ts` | R12: pie de foto, ubicaciones, contactos, ediciones, grupos, marcadores del servidor tecleados, ventana de 24 h, notas de voz, numeros en palabras, telefonos |
| `10-ronda-2-abuso-de-negocio.spec.ts` | R12: datos de otro cliente, cupones y promociones, consejo medico, juego de roles, spam al equipo |
| `11-ronda-2-fallas-de-infraestructura.spec.ts` | R12: cocina y avisos caidos, conexion perdida antes y despues de guardar, reenvios fuera de orden, dos instancias, estados de pedido en desorden |
| `12-ronda-2-formatos-y-tipos.spec.ts` | R12: horas y plazos en formatos raros, campos con el tipo equivocado, busquedas con caracteres especiales, sucursal que no reparte hoy |

Ronda 2 (R12): ademas, `packages/whatsapp-gateway/tests/pm-r12-romper-estados.spec.ts` (estados de entrega en desorden) y `scripts/verify-restaurantes-pm-r12-romper-2/`
(reclamos de mensaje y lease de conversacion contra Postgres real). Los hallazgos de la ronda 2 usan el id `R12-NN`; los corregidos llevan `corregido` en el titulo y ya son
pruebas normales; los abiertos (R12-08, 09, 12, 14) siguen como `hallazgo(...)`.

## Convencion de hallazgos abiertos

Una prueba que **falla hoy por un defecto del producto** se escribe con `hallazgo(...)` (definido en `arnes.ts`) y lleva su id `R11-NN` en el titulo. `hallazgo` es `it.fails`:
pasa mientras el defecto exista y se pone **roja el dia que alguien lo arregla** -- entonces se cambia a `it` y ya es una prueba de regresion. Ninguna se borra ni se debilita.

`R11_VER_FALLAS=1 npx vitest run packages/domain-restaurantes/tests/pm-r11-romper --maxWorkers=2` ejecuta los `hallazgo` como pruebas normales y muestra el mensaje real de cada defecto.

Cada `hallazgo` lleva primero una **afirmacion de control** (algo que SI funciona hoy), para que la falla se deba al defecto y no a un error de la propia prueba.

Los textos hostiles describen la **clase** del intento; este repo es publico y no es un manual.
