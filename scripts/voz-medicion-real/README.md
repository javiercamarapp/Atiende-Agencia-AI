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

Requiere un directorio de QA local (no se publica: lleva la configuración real de la cuenta; **debe estar dentro del repo/worktree** y fuera de git, p. ej. listado en `.git/info/exclude`) con `stack.ts` (API real + Meta simulado), `lib.ts` (cliente simulado), `llm.ts` (cuenta de gasto) e `inv-precio.ts`, y un Postgres efímero con la configuración de PM sembrada.

```
VOZ_QA_DIR=<dir de QA> OPENROUTER_API_KEY=... VOZ_REP=1 \
  [VOZ_CORTE_USD=1.5] [VOZ_FILTRO='^P0'] [VOZ_MODELO=<id>] [VOZ_SIN_COMPUERTA=1] [VOZ_RUIDO=1] \
  vite-node -c vite-node.config.ts scripts/voz-medicion-real/ejecutar.ts
python3 scripts/voz-medicion-real/analizar.py <carpeta de resultados> [etiqueta]
```

- **Guardas de aislamiento** (`guardas.ts`, con pruebas en `voz-medicion-real-guardas.spec.ts`): el arnés ABORTA antes de tocar nada si `VOZ_QA_DIR` no está dentro del repo, si `s.api` no es loopback, si la base (`s.pool`) no es local o si el Meta simulado no está activo (`stack.ts` debe exponer `metaSimulado: true`, o `metaUrl` loopback). Antes de arrancar el stack se revisa el entorno: cualquier variable `META_*`/`WHATSAPP_*`/`GRAPH_*`/`FACEBOOK_*` (`*_URL|URI|BASE|HOST|ENDPOINT|ORIGIN|DOMAIN|SERVER`) o de servicios heredados (`DATABASE_*`, `SUPABASE_*`, `STRIPE_*`, `REDIS_*`, etc.) debe apuntar a loopback. La base se valida con TODOS sus hosts (opciones y cadena de conexión). Los mensajes de aborto muestran solo el host. Los teléfonos son siempre de prueba (`521 999 555 01xx`, la convención 555-01xx de ficción de NANP; **en México no existe un rango reservado equivalente**, así que el patrón solo los marca como datos de prueba: lo que garantiza que nunca se contacta a nadie son estas guardas y que el Meta simulado nunca envía) y se eligen sin pedidos previos. El id de la organización se lee de la base efímera por slug (`VOZ_ORG_SLUG`, opcionalmente `VOZ_ORG_ID`).
- Tope de gasto por corrida (`VOZ_CORTE_USD`, 1.5 por omisión; debe ser un número finito > 0 y no pasar de 100 USD salvo declarar `VOZ_CORTE_MAX_USD`; si no, aborta), evaluado antes de cada escenario, de cada turno y de cada intento del juez, y falla cerrado (un gasto NaN corta); el gasto de una llamada cuenta aunque termine en excepción. Usa el mayor entre el delta de `/key` (que se actualiza con retraso) y la cuenta propia (costo real del agente + cliente + juez). Sale con código 3 si se cortó; volver a lanzar con el mismo `VOZ_REP` continúa donde se quedó.
- `VOZ_SIN_ZDR=1` quita la retención cero solo para modelos baratos que no tienen endpoint ZDR (control de costo). Esa corrida es **NO OFICIAL**: cada resultado lleva `modelo`, `sinZdr` y `oficial`, el resumen lo marca y `analizar.py` lo avisa. No se mezclan modelos ni enrutamientos en un mismo archivo.
- Una llamada con caída o respuesta vacía del LLM, un juez sin respuesta tras 3 intentos o una excepción del arnés quedan **INVALIDA**: no cuenta como acierto ni como fallo, se reporta aparte y se reintenta (hasta 3 veces). Si la corrida termina con menos escenarios que los esperados (tope de gasto), el resumen y `analizar.py` avisan que la tasa es INCOMPLETA y no comparable.
- El directorio de resultados (`VOZ_RES_DIR`, por omisión `<QA>/results`) debe estar **fuera del repo o ignorado por git** (`.gitignore` / `.git/info/exclude`): el arnés lo comprueba con `git check-ignore` y aborta si no. Todo texto guardado se redacta (claves, `usuario:clave@` en URLs, rutas `/Users/...`).
- Un JSON previo corrupto se respalda (`.corrupto-<ts>`) y la corrida aborta: nunca se sobrescribe.
- `analizar.py` da acierto con IC (Wilson sobre llamadas y bootstrap por escenario), por escenario, latencia por turno p50/p95 y causas de fallo.

## Límites (qué NO mide)

Audio real, STT/TTS reales, endpointing partido, finales perdidos, barge-in con audio, eco, ruido de cocina, calidad de voz, latencia de punta a punta (aquí solo texto -> respuesta del agente; faltan STT final ~0.5-2.7 s y primer byte de TTS ~0.2 s medidos en la ronda de cascada con audio), Gemini Live, y el saludo inicial del worker (no existe en el repo: el agente saluda en su primera respuesta).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
