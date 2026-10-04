# Agente en inglés (WhatsApp y voz) — R-44

El agente de restaurantes contesta en el idioma del cliente: **español (de usted) por omisión** y **inglés** cuando el cliente escribe o habla en inglés.
Sin migración: el idioma no se guarda, se deduce en cada turno.

## Cómo funciona

- `packages/domain-restaurantes/src/idioma.ts`: detector **determinista** (palabras funcionales de cada idioma; sin llamadas a un modelo).
  - El mensaje decisivo más reciente manda: el cliente puede cambiar de idioma a mitad de la charla.
  - Un mensaje ambiguo ("2", "tacos al pastor", "ok") conserva el idioma que traía la conversación; sin señales claras, español.
  - Ignora los marcadores del sistema (`[Nota de voz transcrita]`, ubicación). `ok`, `menu`, `total` y los nombres de platillos no cuentan como señal.
- WhatsApp (`whatsapp/llm-turn-handler.ts`, `whatsapp/idioma-prompt.ts`): el prompt lleva siempre las reglas `IDIOMA` y un bloque con el idioma actual de la
  conversación; el saludo por hora lo calcula el servidor en el idioma del cliente (el saludo propio del negocio, escrito en español, no se usa en inglés).
- **Guardias deterministas bilingües** (`whatsapp/guards.ts`): el clasificador de alto riesgo (alergia, cobro duplicado, ARCO, cancelación, transferencia, queja,
  urgencia, "quiero una persona") reconoce ambos idiomas y contesta en el idioma del cliente. Antes de R-44 solo conocía español: un cliente que escribía
  "I want to cancel my order" o "I'm allergic to peanuts" no se interceptaba antes del modelo. También son bilingües la pregunta pendiente, el aviso de
  "orden de 3" de los tacos de bistec y los textos fijos de falla. El total que lee el cliente sigue siendo el de `cotizar_pedido`.
- Aviso de privacidad del primer mensaje (`privacidad/aviso.ts`): versión en inglés cuando la conversación es en inglés.
- **Lo que NO se traduce**: los valores que se mandan a las herramientas (tortilla `maiz|harina|mixta`, canal `domicilio|recoger`, `payment_method`, motivos de
  `escalar_a_humano`, nombres de producto tal como los devuelve `buscar_producto`) y lo que lee el equipo (resumen de escalación, notas de cocina): siempre en español.
  Importes en pesos mexicanos. Las reglas duras (mínimo de $200, alcohol, zona, horario, cotizar antes de confirmar) son las mismas: las aplican las herramientas.
- Voz: la regla de idioma va dentro de "VOZ Y TRATO" del comportamiento compacto (tope de 8000 caracteres de `branch_voice_config.comportamiento`; se recortaron
  frases redundantes del compacto para que quepa). El comportamiento **ya sembrado** en la base no cambia al desplegar: hay que volver a sembrarlo (ver `docs/VOZ-PM.md`).

## Evals

| Qué | Dónde | Corre en CI |
| --- | --- | --- |
| Detector de idioma: 36 mensajes realistas inventados, umbral 100 % | `tests/idioma-evals.spec.ts` | sí |
| Chat: 13 casos en inglés derivados de casos dorados (agente de referencia en inglés + mundo simulado + graders `G_IDIOMA_EN`, `G_TONO_EN`, `G_ARGS_ES`, `G_REPETICION_EN`, `G_ESCALACION_EN`, ...) con pruebas de mutación | `src/evals/agente-pm/ingles/`, `tests/evals-agente-pm-ingles.spec.ts` | sí |
| Guardias y turno completo en inglés | `tests/agente-ingles.spec.ts` | sí |
| Voz: 3 guiones con llamante en inglés contra el simulador (proveedor falso) + `G_IDIOMA_EN` | `src/voz/simulador/guiones-en.ts`, `tests/voz-simulador-ingles.spec.ts` | sí |
| Voz con Gemini real en inglés (manual, con tope de gasto) | `VOZ_EVALS_REAL=1 VOZ_EVALS_IDIOMA=en GEMINI_API_KEY=... npm run evals:voz:real -w @atiende/domain-restaurantes` | no |

Los casos reutilizan los teléfonos y nombres inventados del set base: ningún dato real.

## Límites conocidos

- Solo español e inglés. Otro idioma: el agente contesta en español y ofrece ayuda en español o inglés.
- La cascada de respaldo de voz (`voice-core/src/llamada/cascada-openrouter.ts`) fija `language: "es"` en el STT y los mensajes pregrabados de la llamada
  (`voz/llamada/mensajes.ts`) son audios en español: un llamante en inglés que cae a ese respaldo oye los avisos en español. Gemini Live (primer escalón) es multilingüe.
- No hay pantalla de configuración de idiomas: el idioma lo decide el cliente, no la configuración del negocio.
- Los casos reales en inglés con un modelo de verdad (chat) no están automatizados: el modo `evals:pm:real` sigue corriendo el set en español.
