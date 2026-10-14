# Voz «restaurante humano»: ambiente, tecleo y naturalidad

Orden de Javier (13-oct-2026): que en la llamada haya sonido de restaurante atrás, que cuando el agente «teclea» se escuche teclear, y la mejor configuración para restaurantes, sonando humano,
con voz **femenina** y acento **mexicano**. Este documento dice qué se construyó, de dónde sale cada valor y, sobre todo, **qué no se pudo comprobar** (quien lo construyó no puede oír).

## Qué hay

| Pieza | Dónde | Notas |
|---|---|---|
| Ambiente sintetizado | `packages/voice-core/src/ambiente-restaurante.ts` | Tres presets. Murmullo de voces lejanas en banda formante, cubiertos/platos/vasos esporádicos, cocina lejana (sartén, extractor, ollas), tráfico en `calle-ocupada`. Determinista por semilla, sin bucle, pensado para la banda telefónica (300-3400 Hz). Volumen = pico máximo (0-20 %, saturación suave `tanh`). Ducking de 7 dB bajo la voz del agente y la del cliente. |
| Tecleo | `packages/voice-core/src/tecleo.ts` | Clics de teclado/POS sintetizados. Orquestador dirigido por el reloj de muestras: suena solo con una herramienta en vuelo, ráfagas de 0.9-2.5 s (mínimo 500 ms), pausas 0.35-1.1 s, fades, silencio mientras habla el agente, corte en ~25 ms por barge-in, tope 8 s por espera y 30 s por llamada, «pip» de POS al terminar bien. |
| Mezclador | `packages/voice-core/src/mezclador-salida.ts` | Voz + ambiente + tecleo en una secuencia; `cortarAgente()` para el barge-in. |
| Sincronía con las herramientas | `packages/voice-core/src/llamada/ejecutor-con-tecleo.ts` | Envuelve el ejecutor: inicio/fin de cada herramienta, en los dos motores. |
| Worker | `apps/voice-worker/src/llamada.ts`, `puente-audio.ts`, `audio/bombeo-salida.ts`, `telefonia/livekit.ts` | Ver `docs/AJUSTES-AGENTE-RESTAURANTES.md`. |
| Preset | `packages/voice-core/src/preset-restaurante-humano.ts` | Datos, validación y bloques de instrucción. |
| Panel | Ajustes del agente → «Preset restaurante humano», «Sonido de fondo», «Tecleo y naturalidad» | Componentes de `@atiende/ui`; sin la migración 087 dice «No disponible aún». |
| Muestras de escucha | `scripts/voz-muestras-ambiente/` | WAV fuera del repo, con medidas objetivas. |

## El preset `restaurante-humano` (valores y por qué)

| Ajuste | Valor | Justificación |
|---|---|---|
| Voz por motor | **Gemini Live: Sulafat** (alternativas **Callirrhoe**, **Aoede**); **cascada: Deepgram Aura-2 `aura-2-estrella-es`** (alternativa `aura-2-olivia-es`). Son proveedores distintos; `vozParaMotor(preset, motor)` devuelve la de cada uno. La de la cascada es decisión de Javier tras escuchar las muestras de Aura-2 (14-oct-2026); la cascada v2 aún no está integrada, así que hoy solo queda registrada. Sobre Gemini: | Los modelos Live de audio nativo aceptan las 30 voces de Gemini TTS ([live-guide](https://ai.google.dev/gemini-api/docs/live-guide), «Change voice and language»). Google las describe con un adjetivo, no publica género ni acento por voz ([speech-generation](https://ai.google.dev/gemini-api/docs/speech-generation), «Prebuilt voices»): Sulafat = *Warm*, Callirrhoe = *Easy-going*, Aoede = *Breezy*. El género percibido (femenino) viene de la tabla de voces Chirp 3 HD de Cloud TTS (mismos nombres); es una referencia, no una garantía del modelo Live. **Es una propuesta; la decisión final es de Javier, que las oye en «Voz y saludo».** |
| Ritmo / estilo | Normal / Cálido | El ritmo ágil atropella números y precios; el pausado alarga la llamada. Cálido es el estilo de anfitriona. Gemini Live no tiene control numérico de velocidad: se pide por instrucción. |
| Temperatura | 0.4 | **Juicio de ingeniería, sin medición.** 0 repite frases idénticas y suena a grabación; 1 improvisa. Precios y totales salen de las herramientas, no del modelo. Ahora sí llega a las llamadas reales (apertura de la sesión). |
| Naturalidad | activada | Frases cortas, muletillas escasas, confirmaciones cortas, sin listas largas, sin repetir el nombre del cliente, español de México con usted, manejo de interrupciones, y «déjeme anotarlo» **antes** de cotizar/confirmar/crear pedido. |
| Ambiente | `cocina-taqueria` al 8 % | En las muestras queda ~23 dB bajo la voz mientras habla y se oye en las pausas. **Punto de partida calculado, no de oído**: ajustar con los archivos `comparar-volumen-*`. |
| Tecleo | 12 % | Sobre el ambiente (8 %), muy por debajo de la voz. |

### Verbalización de la espera (límite honesto)

La instrucción pide una frase corta antes de las herramientas que tardan (cotizar, confirmar, crear pedido, 1-4 s) y nada antes de las lecturas rápidas. **No hay un umbral en milisegundos**: el modelo no mide
tiempo y no se inventó un temporizador que hable por encima del modelo. El tecleo cubre el resto de la espera y el pregrabado `tool_timeout` sigue como red cuando el modelo se queda callado tras el resultado.

### Acento mexicano: qué depende del proveedor

- En la Gemini API los modelos de audio nativo **eligen el idioma solos y no admiten `languageCode`** (live-guide; la tabla de idiomas solo trae `es`). Por eso el acento se pide en la instrucción
  (`BLOQUE_ACENTO_MEXICANO` + la línea fija de `VOZ_PLATAFORMA.gemini.instruccionIdioma`).
- Vertex AI sí tiene `languageCode` (`idiomaVertex`, hoy `es-US`, «por confirmar con la primera llamada real»): no se cambió sin probarlo.
- **No se puede garantizar** que la voz prediseñada conserve el acento mexicano en todos los turnos; es del proveedor. Se valida escuchando (vista previa del panel o llamada de prueba).

### TTS femenino es-MX para la cascada v2 (anotado, sin integrar)

Fuente: `~/atiende-loop/pm/arquitectura-agentes-modelos-2026.md`. Azure MAI-Voice-2.1-Flash `es-MX-Valeria` / `es-MX-Harper` (preview, sin SLA; respaldo `es-MX-Ximena:DragonHDLatestNeural` o `es-MX-DaliaNeural`);
Deepgram Aura-2 `aura-2-estrella-es` / `aura-2-olivia-es` (muestras sin cuenta); ElevenLabs solo con una voz clonada de una locutora mexicana (con su consentimiento); respaldo Gemini TTS (mismas voces del catálogo).
**HeyGen Voice no sirve para teléfono** (30 solicitudes/min fijas, WAV 44.1 kHz). Constante: `CANDIDATAS_TTS_CASCADA_V2`.

## Qué NO está verificado

- **Nada se ha oído.** Las pruebas miden nivel, pico, espectro (≥ 80 % de la energía del ambiente en 300-3400 Hz), ausencia de bucle en 60 s, relación voz/ambiente, sincronía del tecleo con las herramientas y el barge-in. Que suene a restaurante y a teclado real, y que no cansen, solo se sabe escuchando las muestras (`~/atiende-loop/pm/audio-ambiente/`).
- El bombeo continuo hacia LiveKit (`captureFrame` cada 20 ms, `clearQueue` en el barge-in) está probado con reloj y destino falsos, **no contra LiveKit real**; la latencia añadida de la cola (~200 ms de adelanto) no se midió.
- La **vista previa del panel no reproduce el ambiente ni el tecleo** (la pantalla dice «No disponible aún»); sí aplica la naturalidad, el ritmo, el estilo y la temperatura. Hacerlo requiere un reproductor WebAudio con el mismo mezclador y los eventos de herramienta de la sesión de vista previa.
- Los ajustes viven **por organización** (`restaurantes.agent_runtime_settings`), no por sucursal: es donde ya vivían ritmo, estilo y fondo. La voz sí es por sucursal.
- La migración 087 no se aplicó a ninguna base; su verificación contra Postgres real está en `scripts/verify-restaurantes-voz-ambiente-tecleo/`.
