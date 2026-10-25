# Arnés de voz con modelo real (cliente por texto)

Mide el acierto del agente de voz de la taquería PM con un **modelo real** pero **sin audio ni telefonía**: el cliente "habla" por texto y un ruido de STT sintético degrada lo que el agente recibe. Es el equivalente, para voz, del arnés de WhatsApp.

## Qué es real y qué es simulado

| Real | Simulado |
|---|---|
| Instrucción de la llamada, armada por el servidor (`POST /internal/restaurantes/voz/llamada/contexto`, la que recibe el worker) | Cliente: LLM barato con guion por escenario |
| `ControladorLlamada` y su máquina de estados | STT: `ruido-stt.ts` (cifras, confusiones de nombres/platillos, muletillas, repeticiones, palabras comidas, mensajes cortados). El texto entra por `turnoFinal`, el mismo camino que el audio real |
| Sesión de la cascada v2 (`crearProveedorCascadaV2`): bucle modelo -> herramienta -> modelo, regla confirmar -> crear, frases | TTS: silencio proporcional (no se mide primer audio) |
| Puerto LLM del worker (`crearPuertoLlmVozV2`): Sonnet 5.5, esfuerzo bajo, retención cero por OpenRouter | Telefonía SIP, barge-in con audio, eco, endpointing |
| Las mismas herramientas por HTTP contra la API real local y un Postgres efímero | |
| Juez: `claude-haiku-5.5` con criterios por escenario + checks deterministas contra la base | |

**Equivalente de Gemini Live.** El escalón 1 de producción (Gemini Live) no se usa: es audio-a-audio. La cascada (escalón 2) con el mismo prompt y las mismas herramientas es lo más cercano que se puede medir por texto. Diferencia importante: Gemini Live puede emitir `confirmar_resumen` y `crear_pedido` en la misma respuesta; en la cascada con OpenRouter la compuerta `confirmacionAntesDeCrear` (la que usa `apps/voice-worker/src/main.ts`) lo impide. Por eso el ejecutor corre en dos configuraciones: con compuerta (cascada tal como está en producción) y `VOZ_SIN_COMPUERTA=1` (aproxima a Gemini Live).

## Escenarios

`escenarios.ts`: 46. P01-P16 (paridad con WhatsApp, #663), VZ* (casos de llamada de las rondas de QA de voz) y W01-W06 (principales de WhatsApp: fuera de cobertura, último pedido por sucursal/hora, dirección dictada con corrección, mezcla de órdenes 2 y 5, preguntas de horario). Cada uno lleva `debe`/`noDebe` para el juez y `checks` deterministas (pedidos en la base, totales, canal, escalaciones, texto prohibido). Todo ficticio.

## Cómo correrlo

Requiere un directorio de QA local (no se publica: lleva la configuración real de la cuenta) con `stack.ts` (API real + Meta simulado), `lib.ts` (cliente simulado), `llm.ts` (cuenta de gasto) e `inv-precio.ts`, y un Postgres efímero con la configuración de PM sembrada.

```
VOZ_QA_DIR=<dir de QA> OPENROUTER_API_KEY=... VOZ_REP=1 \
  [VOZ_CORTE_USD=1.5] [VOZ_FILTRO='^P0'] [VOZ_MODELO=<id>] [VOZ_SIN_COMPUERTA=1] [VOZ_RUIDO=1] \
  vite-node -c vite-node.config.ts scripts/voz-medicion-real/ejecutar.ts
python3 scripts/voz-medicion-real/analizar.py <carpeta de resultados> [etiqueta]
```

- Tope de gasto por corrida (`VOZ_CORTE_USD`, 1.5 por omisión): usa el mayor entre el delta de `/key` (que se actualiza con retraso) y la cuenta propia (costo real del agente + cliente + juez). Sale con código 3 si se cortó; volver a lanzar con el mismo `VOZ_REP` continúa donde se quedó.
- `VOZ_SIN_ZDR=1` quita la retención cero solo para modelos baratos que no tienen endpoint ZDR (control de costo; no es la medición oficial).
- `analizar.py` da acierto con IC (Wilson sobre llamadas y bootstrap por escenario), por escenario, latencia por turno p50/p95 y causas de fallo.

## Límites (qué NO mide)

Audio real, STT/TTS reales, endpointing partido, finales perdidos, barge-in con audio, eco, ruido de cocina, calidad de voz, latencia de punta a punta (aquí solo texto -> respuesta del agente; faltan STT final ~0.5-2.7 s y primer byte de TTS ~0.2 s medidos en la ronda de cascada con audio), Gemini Live, y el saludo inicial del worker (no existe en el repo: el agente saluda en su primera respuesta).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
