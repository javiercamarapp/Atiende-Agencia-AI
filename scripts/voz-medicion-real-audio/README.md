# Arnés de voz con AUDIO REAL (sin red telefónica)

Sustituye el atajo de `../voz-medicion-real/ejecutar.ts`, donde el cliente "hablaba" entregando texto como si fuera el final del STT (`turnoFinal`). Aquí el audio recorre el motor de punta a punta:

```
texto del cliente (cliente-LLM + guion de escenarios.ts, SIN modificarlo)
  -> TTS de Deepgram, voz aura-2-javier-es (la del agente es aura-2-estrella-es), PCM16 16 kHz
  -> [VOZA_RUIDO>0] linea telefonica: banda 300-3400 Hz, mu-law 8 kHz ida y vuelta, ruido de fondo
  -> streaming en tiempo real (trozos de 20 ms) por ses.enviarAudio -> STT REAL del motor (Nova-3 es-419, endpointing 400 ms, keyterms del menu, 16 kHz)
  -> transcripcion final = lo que ve el agente -> controlador/sesion v2/LLM/herramientas reales -> TTS REAL Aura-2 (24 kHz) -> primer audio
```

El cliente espera a que el agente termine de "sonar" (reloj de reproducción con la duración real del audio) + 350 ms antes de hablar; en los eventos `interrumpe` habla a media frase del agente (barge-in con la lógica real del motor). Los eventos `ruido`, `no_entendido`, `silencio` y `cuelga` entran por el controlador igual que antes. `cortada` sintetiza la frase truncada.

## Archivos
`ejecutar-audio.ts` (arnés; derivado de `ejecutar.ts`: mismo contexto, controlador, LLM, herramientas, juez y checks) · `adaptadores.ts` (envoltorios de medición del STT/TTS reales, TTS del cliente, vocabulario del menú) · `wer.ts` (normalizador, WER, errores de cifras, términos del menú y direcciones) · `telefonia.ts` (banda, mu-law G.711, ruido) · `gasto.ts` (topes) · `pcm.ts`, `metricas.ts` · `analizar-audio.py` · `correr-audio.sh` · `tests/` (+ `vitest.config.ts` propio: el raíz no incluye `scripts/`).
Depende de `../voz-medicion-real/` (`escenarios.ts`, `ruido-stt.ts`; directorio sin seguimiento de git en la rama base) y del directorio de QA (`stack.ts`, `lib.ts`, `llm.ts`, `inv-precio.ts`).

## Cómo correrlo
Postgres efímero del puerto 55497 ya arriba (el mismo de `voz-ejec/qa`; este arnés NO lo levanta). Llave de Deepgram en `~/.atiende-secrets/DEEPGRAM_API_KEY.txt` (o `VOZA_LLAVE_ARCHIVO`); nunca se imprime ni se guarda en resultados.
```
bash scripts/voz-medicion-real-audio/correr-audio.sh <rep> [regex de id] [etiqueta]
# ej. un escenario:   VOZA_TOPE_USD=0.1 bash scripts/voz-medicion-real-audio/correr-audio.sh 1 '^P01$' humo
# ej. los 46 limpios: VOZA_TOPE_USD=4 VOZA_TOPE_AUDIO_S=3600 bash scripts/voz-medicion-real-audio/correr-audio.sh 1 '' audio-limpio
# ej. los 46 con linea telefonica y ruido: VOZA_RUIDO=2 ... correr-audio.sh 1 '' audio-linea
```
Resultados en `$VOZ_RES_DIR` (por omisión `<QA>/results`): `voz-audio-<etiqueta>-rep<rep>.json` (+ `.gasto.jsonl`). Volver a lanzar con el mismo `<rep>` y etiqueta continúa donde se quedó. Sale con código 3 si un tope cortó la corrida.

| Variable | Por omisión | Qué hace |
|---|---|---|
| `VOZA_RUIDO` | 0 | 0 limpio · 1 línea telefónica (banda + mu-law) · 2 línea + ruido SNR 20 dB · 3 línea + ruido SNR 10 dB (el escenario con `sinRuido` queda limpio) |
| `VOZA_TOPE_USD` | 1 | tope del gasto de Deepgram de la corrida (STT + keyterms + TTS agente y cliente) |
| `VOZA_TOPE_AUDIO_S` / `VOZA_TOPE_LLAMADA_S` | 1800 / 240 | tope de segundos de audio al STT por corrida / por llamada |
| `VOZ_CORTE_USD` | 1.5 | tope de OpenRouter (igual que el arnés de texto) |
| `VOZA_SIN_KEYTERMS` | 0 | 1 = no mandar vocabulario (control) |
| `VOZA_COLA_MS` / `VOZA_REACCION_MS` / `VOZA_VOZ_CLIENTE` | 1200 / 350 / aura-2-javier-es | silencio tras la voz, pausa humana, voz del cliente |

Tope: antes de cada escenario y en cada trozo enviado se revisa; al excederse la llamada se aborta (`TOPE:usd|audio|llamada`), queda como excepción reintentable y la corrida sale con código 3.

**Costo real de Deepgram.** La llave NO tiene los scopes `usage:read`/`billing:read` (HTTP 403 al probar), así que no se lee de su API: se calcula con lo realmente enviado (segundos de audio × `usdPorMinuto` [+ `usdPorMinutoKeyterms` si hay vocabulario] + caracteres sintetizados × `usdPorMilCaracteres`), tarifas de `config-plataforma.ts`. El resultado trae también la estimación del propio motor (`costoMotorDgUsd`) para cruzar.

## Analizador
```
python3 scripts/voz-medicion-real-audio/analizar-audio.py <carpeta o archivos> [--md]
```
Tabla de latencia por etapa con STT y TTS incluidos (STT fin-de-voz→final [incluye los 400 ms de endpointing], LLM final→primera frase, TTS primera frase→primer audio, TOTAL fin-de-voz→primer audio; p50/p95/max por turno y mediana por llamada), WER (S/D/I), cifras, términos del menú y direcciones mal transcritos, finales perdidos o partidos, interrupciones, acierto del juez y costo.

## Pruebas (sin red)
```
PATH=$HOME/.local/node/bin:$PATH npx vitest run -c scripts/voz-medicion-real-audio/vitest.config.ts scripts/voz-medicion-real-audio/tests/<archivo>
```

## Límites (qué sigue sin medir)
- No hay red telefónica: sin jitter, pérdida de paquetes, códecs reales de la troncal ni eco/audio de cocina real; la "línea" es una aproximación (banda + mu-law + ruido sintético). Es voz sintética limpia y sin acento ni disfluencias: el WER real de llamadas humanas será peor.
- El tiempo "a primer audio" se mide en la salida de la sesión (antes del puente SIP/RTP del worker) y el STT incluye el viaje a Deepgram desde esta Mac: la latencia de producción añade la telefonía.
- **Hallazgo:** en este commit `ControladorLlamada.abrir()` no pasa `vocabulario` a `abrirSesion`, ni el worker lo rellena en ninguna parte: en producción el STT NO recibe keyterms del menú (y no se cobra el add-on). El arnés SÍ los manda (menú de la base, sin paréntesis de presentación; el motor recorta a `keytermsMax` = 50) para medir el diseño previsto; `VOZA_SIN_KEYTERMS=1` mide lo que hoy pasa en producción.

## E2E con el worker real por LiveKit (`e2e-livekit.ts` + `corrida/`)
Worker REAL (`apps/voice-worker`, escalera de la plataforma con ElevenLabs/Deepgram/OpenRouter, Krisp) contra la API real local (`corrida/qa/stack.ts`, Postgres efímero
`pmreal` en el puerto 55497 clonado de `pmreal_base`). Un llamante sintético entra a una sala de LiveKit Cloud, habla con Aura-2 por línea telefónica y, según `VOZA_RUIDO`,
con cama de ruido (1 limpio, 4 plática de restaurante a 10 dB, 5 cocina/calle sin voces). Juez Haiku + checks deterministas contra la base.
```
# una corrida (rep 1, 6 escenarios, condición 1):
VOZA_RUIDO=1 bash scripts/voz-medicion-real-audio/corrida/correr-el.sh 1 '^(VZ01|VZ02|VZ04|VZ05|P08|P14)$' r3-c1
# matriz (espera carga <= 10, una medición a la vez, se detiene si OpenRouter < 30.6 USD o ElevenLabs < 62k créditos):
SHA_ESPERADO=$(git rev-parse --short HEAD) ETQ=r3 REPS="1 2 3 4 5" CONDS="1 4 5" bash scripts/voz-medicion-real-audio/corrida/matriz.sh
python3 scripts/voz-medicion-real-audio/corrida/resumir.py .voz-qa/results r3-c1 r3-c4 r3-c5 --fallas
```
Resultados y grabaciones de las fallas en `<repo>/.voz-qa/` (fuera de git). Cada llamada guarda todos los eventos del worker (`eventos`, sin PII) y marca `infra` si la API
local falló (`apps_api_error_interno`) o hubo excepción de LiveKit: esas llamadas se reportan aparte («sin infra»).
