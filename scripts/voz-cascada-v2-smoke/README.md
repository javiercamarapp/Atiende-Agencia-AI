# voz-cascada-v2-smoke

Prueba REAL y corta de la cascada v2 en streaming (Deepgram Nova-3 `es-419` + LLM por OpenRouter + Deepgram Aura-2 `aura-2-estrella-es`), con tope de gasto
(`VOZ_SMOKE_MAX_USD`, por omisión US$0.05; el gasto esperado es menor a US$0.01). **Manual: no corre en CI ni en `test:unit`** y no usa llaves del repositorio.

```
DEEPGRAM_API_KEY=... OPENROUTER_API_KEY=... npx tsx scripts/voz-cascada-v2-smoke/smoke.ts
```

Comprueba, en orden: (1) el TTS entrega audio PCM lineal a 24 kHz y mide el tiempo al primer audio; (2) el STT transcribe ese audio y cierra el turno con su endpointing;
(3) el LLM en streaming responde y el segundo turno con el mismo system prompt **lee de la caché** (`tokensCache > 0`); (4) la cascada completa saca el primer audio **antes**
de que el LLM termine. `node --experimental-strip-types` no sirve para este script (los módulos importados usan *parameter properties*): usa `npx tsx`. El tope se revisa **antes** de cada paso y suma también la cascada completa; la sesión de STT se cierra siempre.
Imprime solo métricas y la frase sintética propia; nunca llaves ni datos de clientes.

Estado: **nadie la ha ejecutado todavía** (no había llave de Deepgram al escribirla). Si alguno de los pasos falla, el protocolo documentado en
`packages/voice-core/src/llamada/cascada-v2/deepgram-stt.ts` y `deepgram-tts.ts` necesita ajuste.
