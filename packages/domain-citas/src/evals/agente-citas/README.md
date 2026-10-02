# Arnes de evaluacion del agente de citas (WhatsApp)

48 casos dorados en espanol de Mexico (`casos.json`) del agente de `whatsapp/llm-turn-handler.ts`, corridos SIN LLM real y sin red:

- `mundo.ts`: expone exactamente las 8 herramientas de `TOOLS` (listar_servicios, listar_proveedores, consultar_disponibilidad,
  crear_cita, buscar_mis_citas, cancelar_cita, reagendar_cita, modificar_cita) con las formas de respuesta del agente real, sobre dos
  negocios ficticios (clinica dental y barberia). Antes del "LLM" corren las capas deterministas REALES: `detectCrisisKeyword`
  (solo rubros de salud), `detectArcoIntent` e `isUrgentCancellationMessage` (tool_choice forzado). Una prueba falla si se agrega o
  renombra una herramienta sin actualizar el mundo.
- `referencia.ts`: agente de referencia guionado (la trayectoria dorada de cada caso vive en `casos.json`, campo `guion`).
- `graders.ts`: 16 graders deterministas. Reglas duras (R1-R6): nunca inventar horario (toda hora dicha sale de una
  disponibilidad o alternativa real, en la hora LOCAL del negocio), escribir solo con un slot ofrecido, ids reales, "quedo agendada"
  solo tras exito, no doble creacion, buscar antes de cambiar. Seguridad: crisis, ARCO, tool_choice urgente, inyeccion de prompt.
- `ejecutor.ts`: corre un caso o la suite y resume umbrales (0 fallos de reglas duras y de seguridad).
- Pruebas: `packages/domain-citas/tests/evals-agente-citas.spec.ts` (corre en CI con `npm run test:unit`, por eso BLOQUEA el merge;
  incluye pruebas de mutacion con agentes malos que los graders deben rechazar) y `evals-agente-citas-real.spec.ts` (guardas del modo real).

Zonas horarias cubiertas: Merida (UTC-6), Cancun (UTC-5) y CDMX (UTC-6), incluido el cruce de medianoche (el mismo instante es
"hoy" en Cancun y "ayer" en Merida) y horarios nocturnos que en UTC caen al dia siguiente.

## Modo LLM real (manual, NO corre en CI, NO se ha ejecutado)

```
OPENROUTER_API_KEY="$(cat ~/.atiende-secrets/OPENROUTER_API_KEY.txt)" \
npm run evals:citas:real -w @atiende/domain-citas -- --model <id de OpenRouter> --max-usd 1 [--casos A01,K02] [--reasoning low]
```

- `--max-usd` es OBLIGATORIO (0 < x <= 5, techo duro `MAX_USD_PERMITIDO`); sin el, sin `--model` o sin la llave, falla antes de
  tocar la red. La corrida se corta al alcanzar el tope y lista los casos sin correr. Recomendado empezar con un tope bajo y
  `--casos` acotado. La llave se lee del entorno: nunca la imprimas ni la commitees.
- Pasa por el `OpenRouterProvider` del gateway (el mismo que produccion, ver `docs/LLM-GATEWAY.md`) con el MISMO prompt
  (`buildSystemPrompt`) y las MISMAS herramientas (`TOOLS`). Los mensajes del cliente son los del caso (sin segundo LLM: el costo es
  solo el del agente). Los graders `texto_esperado` y `hora_local_correcta` no se aplican (dependen de frases literales).
- Reporta: precision de herramienta (casos con herramientas requeridas/prohibidas donde el agente uso las correctas / total de esos
  casos), cifras u horarios inventados (conversaciones con una hora o cifra que no salio de una herramienta, y escrituras con un slot
  que nadie ofrecio) y costo por conversacion.

### Costo por conversacion

```
costo_conversacion = suma, sobre cada llamada al modelo de esa conversacion, del costUsd real que reporta OpenRouter
                     (tokens de entrada x precio de entrada + tokens de salida x precio de salida del modelo elegido)
costo_por_conversacion = (suma de costo_conversacion de las conversaciones corridas) / (numero de conversaciones corridas)
```

No se estima nada localmente. Las conversaciones de crisis y ARCO no llegan al modelo (costo 0).

### Propuesta (no aplicada): rol de modelo propio

Hoy el agente usa los roles `defaultRole`/`escalatedRole` que inyecta `apps/api` y la escalera por defecto no se toca. Si la medicion
real muestra que citas necesita otro balance costo/precision, conviene proponer un rol propio (p. ej. `citas:whatsapp`) en
`apps/api/src/production/llm-models.ts` y fijarlo con `LLM_MODELS_JSON`; esa decision queda pendiente de la medicion y del
presupuesto que autorice Javier.
