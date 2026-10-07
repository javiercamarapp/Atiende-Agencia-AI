# Gateway LLM: OpenRouter como proveedor primario

Decisión de Javier (1-oct-2026): **OpenRouter es el proveedor ÚNICO por defecto de modelos**. Una sola
llave (`OPENROUTER_API_KEY`), API compatible con OpenAI, modelos intercambiables por configuración y
fallback entre laboratorios.

## Arquitectura

```
rol (p.ej. restaurantes:data_chat)
  └─ LlmGateway.complete()                         packages/agent-core/src/gateway/gateway.ts
       1. kill switch por rol (core.platform_switch)  -> KillSwitchEngagedError
       2. gate de residencia (apagado por defecto)
       3. por cada escalón (modelo) de la escalera del rol:
            circuit breaker del escalón  (id: openrouter:<modelo>)
            tope mensual por organización (core.llm_org_budget) + tope diario/por corrida
            OpenRouterProvider.complete()          providers/openrouter.ts
       4. error transitorio -> siguiente modelo; todo agotado -> AllProvidersFailedError
  └─ data-chat: ante cualquier fallo/tope/interruptor -> MODO SIN IA (catálogo de consultas, lo dice)
```

- **Un escalón = un modelo con sus parámetros** (`OpenRouterProvider`). La escalera de fallback es propia
  (no el campo `models` de OpenRouter) para que cada modelo conserve sus parámetros (`reasoning`,
  `temperature`, tope de tokens) y su propio circuit breaker.
- **Tabla rol -> modelos**: `apps/api/src/production/llm-models.ts` (versionada) + sobreescritura por la
  variable `LLM_MODELS_JSON` sin redeploy de código.
- **Costo real**: el proveedor pide `usage: { include: true }` y registra el `usage.cost` real que devuelve
  OpenRouter en `core.llm_usage_daily`. La tabla de precios (`packages/agent-core/src/gateway/prices.ts`)
  solo se usa para estimar antes de llamar (reserva de presupuesto) y como respaldo si no llega costo.
  Un modelo sin fila en la tabla no rompe nada: la reserva usa un tope conservador y el costo registrado
  sigue siendo el real.
- **Archivos**: `providers/openrouter.ts` (proveedor), `prices.ts`, `upstash-rest-client.ts` (breaker
  compartido), `apps/api/src/production/llm-gateway.ts` (armado), `llm-models.ts` (tabla).

## Tabla rol -> modelos (defaults, verificados el 2026-10-02)

| Rol | Escalera (en orden) | Notas |
|---|---|---|
| `*:data_chat` (6 verticales), `*:whatsapp_agent(_escalated)`, extractor de requisitos, borrador de propuesta, preguntas de junta, mensajería de rentas, conciliación de despachos | `openai/gpt-6-luna` (`low`) -> `deepseek/deepseek-v4.1-flash` (`low`, EE.UU.) -> `google/gemini-2.5-flash-lite` (`minimal`) -> `meta/muse-spark-1.3` (`low`) -> modo sin IA | Perfil económico. El modo sin IA lo decide el llamador (data-chat). |
| `*:data_chat_retry` (reintento por guardia de cifras) | `deepseek/deepseek-v4-pro` (`medium`, EE.UU.) -> `openai/gpt-6-luna` (`high`) | Rol y ruta listos; ver "Huecos" para el cableado en el motor. |
| `superadmin:copiloto` (CFO) | `anthropic/claude-sonnet-5.5` (`medium`) -> `deepseek/deepseek-v4-pro` (`medium`, EE.UU.) | Poco volumen, mayor riesgo. Lo invoca `POST /superadmin/copiloto` (CHAT-16, ver `docs/SUPERADMIN_COPILOTO.md`) con un gateway **dedicado** (gasto de plataforma, no de una organización); su interruptor de plataforma es `agente superadmin:copiloto`. |
| `reportes:analisis_financiero` | `anthropic/claude-sonnet-5.5` -> `deepseek/deepseek-v4-pro` | Etapa de análisis de datos de reportes financieros. |
| `reportes:analisis_general` | `qwen/qwen3-235b-a22b-2507` (EE.UU.) -> `deepseek/deepseek-v4.1-flash` -> `openai/gpt-6-luna` | Etapa de análisis de reportes no financieros. |
| `reportes:redaccion_financiero`, `reportes:redaccion_general` | `google/gemini-3.8-flash` (`low`) -> `openai/gpt-6-luna` | Rutas separadas por tipo para que el eval decida (Qwen 3.7 Flash como candidato cuando tenga proveedor de EE.UU.). |
| `restaurantes:transcripcion` (R-32, notas de voz de WhatsApp) | `google/gemini-2.5-flash-lite` (`minimal`) -> `google/gemini-3.5-flash-lite` | Únicos modelos baratos con entrada de audio y proveedor permitido (Google AI Studio / Vertex), verificado en `architecture.input_modalities` de OpenRouter el 2026-10-03. Interruptor de plataforma `agente restaurantes:transcripcion`; costo real en `core.llm_usage_daily` como el resto. Sin modelo que acepte la petición, el flujo pide al cliente que escriba. |
| `plataforma:resumen_diario` | `google/gemini-3.8-flash` (`low`) -> `openai/gpt-6-luna` (`low`) | El precio de Gemini 3.8 Flash se duplica el 1-ene-2027 (investigación): reevaluar. |
| `plataforma:enrutador_turno`, `plataforma:compuerta_escalamiento`, `plataforma:titulos_resumenes`, `plataforma:compactacion_historial` | `openai/gpt-6-luna` (`low`) -> `deepseek/deepseek-v4.1-flash` | Roles pensados para Qwen 3.7 Flash; hoy NO se puede usar (ver política de proveedores). Tienen llamador real desde MOD-12 (ver "Presupuesto del Copiloto y roles auxiliares"). |

Parámetros por modelo en los defaults:

- `temperature: "omit"`. Los endpoints de GPT-6 Luna y Claude Sonnet 5.5 **no listan `temperature`** entre los
  parámetros soportados de OpenRouter (verificado en `/api/v1/models/<id>/endpoints`; con Luna y Sonnet 5.5 se
  confirmó con una llamada real: `temperature: 0` devuelve 404 "No endpoints found that can handle the requested
  parameters"). Con `require_parameters: true`, mandarla deja la ruta sin endpoints; por eso se omite en todos
  los defaults.
- `minMaxTokens`: piso del tope de salida (1500 a 4000 según el rol). Los tokens de razonamiento consumen
  el tope: con 500 la respuesta podía quedar vacía.

## Política de proveedores (allowlist) y laboratorios chinos

Decisión de Javier (1-oct-2026, "sí acepta DeepSeek y Qwen"): la política ya **no es una lista negra de autores**
sino una **lista blanca de proveedores** (`ALLOWED_PROVIDER_HOSTS` en `llm-models.ts`): un modelo de cualquier
laboratorio entra a producción solo si TODOS sus proveedores son servidores en EE.UU. de esa lista (OpenAI,
Azure, Google AI Studio/Vertex, Anthropic, Amazon Bedrock, Meta, DeepInfra, Together, Fireworks, Baseten,
Parasail, CoreWeave, Groq).

- Cada petición lleva `provider.only` (siempre con al menos un proveedor), `data_collection: "deny"` y
  `require_parameters: true`. Para los modelos con endpoint ZDR en esos proveedores, además `zdr: true` (forzado).
  `routingForModel` fija estos valores AUNQUE el objeto de configuración diga otra cosa.
- Los modelos de laboratorios chinos y Meta están en `VERIFIED_MODEL_HOSTS` con los proveedores EE.UU.
  verificados el 2026-10-02 contra la API pública de OpenRouter (`/api/v1/models/<id>/endpoints` cruzada con
  `/api/v1/endpoints/zdr`, la lista pública de endpoints con retención cero):

| Modelo | Proveedores de EE.UU. con ZDR | Nota de precio |
|---|---|---|
| `deepseek/deepseek-v4.1-flash` | DeepInfra, Together, Fireworks, Baseten, Parasail, CoreWeave | En EE.UU. cuesta 0.14-0.60 / 0.42-2.40 USD por 1M (no el 0.03 / 0.50 de lista). |
| `deepseek/deepseek-v4-pro` | DeepInfra, Parasail, Azure (`azure/us`) | 1.30-1.91 / 2.60-3.83 USD por 1M en esos proveedores. |
| `qwen/qwen3-235b-a22b-2507` | Google Vertex (`us-south1`), Parasail, DeepInfra | 0.09-0.25 / 0.55-1.00 USD por 1M. |
| `qwen/qwen3.7-flash` | **ninguno**: hoy solo lo sirve Alibaba, sin ZDR | **Rechazado** al validar y en `routingForModel` con un error claro. |
| `meta/muse-spark-1.3` | Meta (sin ZDR) | 1.25 / 4.25 USD por 1M. |

- `LLM_MODELS_JSON` solo puede **estrechar** los proveedores de un modelo: un `only` con un proveedor fuera de la
  lista, no verificado para ese modelo o vacío invalida la ruta completa (queda el default y un error
  `llm_models_json_invalid`). Tampoco acepta `requireParameters: false` ni `dataCollection: "allow"`. Un modelo
  sin fila verificada ni laboratorio de EE.UU. conocido (p. ej. `z-ai/*`) exige `only` explícito dentro de la
  lista, y se le fuerza `zdr: true`.
- Antes de cambiar una fila de `VERIFIED_MODEL_HOSTS`, re-verifica con `node scripts/check-llm-us-hosts.mjs`
  (usa la API pública, sin llave, no corre en CI).
- **Qwen 3.7 Flash**: sus cuatro roles (`enrutador_turno`, `compuerta_escalamiento`, `titulos_resumenes`,
  `compactacion_historial`) quedan con Luna -> DeepSeek V4.1 Flash. Cuando OpenRouter liste un proveedor de EE.UU.
  con ZDR para `qwen/qwen3.7-flash`, basta cambiar su fila de `VERIFIED_MODEL_HOSTS` y poner el modelo primero
  en esas rutas (o hacerlo por `LLM_MODELS_JSON` tras actualizar la tabla).

## Presupuesto del Copiloto y roles auxiliares (CHAT-07, MOD-12)

**Tope diario de turnos por rol.** Un turno es una llamada al gateway. `core.consume_llm_role_turn` cuenta por organización, rol y día de forma
atómica (el turno N+1 se rechaza sin consumir). Defaults en `apps/api/src/production/llm-role-limits.ts` (Copiloto 400 llamadas/día, su reintento
100, reportes 40 por rol, enrutador 600, compuerta 300, títulos 300, compactación 150); los agentes de WhatsApp no tienen tope diario. El superadmin
puede dar un tope propio por organización y rol en Gasto de API (`PUT /superadmin/gasto-api/organizaciones/:id/topes-rol`, con step-up). Al agotarse, el
Copiloto responde en modo sin IA (consultas directas). Un fallo de infraestructura al contar es *fail-open*: el tope mensual (fail-closed) sigue protegiendo el dinero.

**Subtope del Copiloto.** Los roles `*:data_chat` y `*:data_chat_retry` no pasan del 30 % del tope mensual de su organización
(`core.copiloto_subtope_pct()`), reservado antes de gastar bajo el mismo candado que los topes de organización y plataforma
(`reserve_llm_monthly_budget` de 4 argumentos). Agotado el subtope, el Copiloto cae a modo sin IA; el resto del tope sigue disponible para los demás roles.

**Costo por turno.** El motor escribe una fila de resumen del turno en `core.data_chat_query_log` con `costo_micro_usd` (suma exacta de lo que reportó
el proveedor), `modelo`, `rol` y `route` (`llm`, `escalado`, `sin_ia`). El reporte de Gasto API por organización/rol/mes sale de `core.llm_usage_daily`
(`GET /superadmin/gasto-api/por-rol`, con step-up).

**Avisos al superadmin.** Al llegar al 80 % del tope mensual de una organización o de la plataforma (`superadmin.costo.ia_umbral`, una por
organización/mes y una de plataforma/mes) y cuando más del 5 % de las llamadas de la última hora (mínimo 20) cayó a un modelo de respaldo
(`superadmin.llm.fallback_alto`, una por hora).

**Roles auxiliares (`plataforma:*`, todos apagables en Interruptores; apagado = comportamiento anterior).**

- `enrutador_turno`: antes de la primera llamada clasifica la pregunta (BASE o ESCALAR); ESCALAR corre el turno directo en el modelo de reintento.
- `compuerta_escalamiento`: tras rechazar la guardia de cifras, decide si vale la pena la llamada escalada o se muestra el texto determinista.
- `titulos_resumenes`: titula una conversación nueva DESPUÉS de entregar la respuesta (nunca la bloquea; respaldo determinista; sin PII).
- `compactacion_historial`: resume (sin cifras) la parte vieja de una conversación que pasa de ~1200 tokens; el resumen no se guarda.

Todos reciben solo texto ya redactado (`redactPii`) y, ante cualquier fallo o respuesta ambigua, el flujo es el de siempre.

## Modelo elegido por una organización (restaurantes)

`LlmGateway.complete({ preferredModel })` pone un modelo registrado al frente de la escalera del MISMO rol y deja el resto como respaldo; `registerAlternatives(role, providers)`
registra modelos elegibles que no entran a la escalera por defecto. Hoy lo usa el agente de WhatsApp de restaurantes con la lista cerrada `MODELOS_AGENTE`
(`docs/AJUSTES-AGENTE-RESTAURANTES.md`). Un modelo no registrado se ignora; el interruptor, el tope y el registro de uso son los del rol.

## Cómo cambiar un modelo (sin tocar código)

1. En Vercel (proyecto de la API), variable `LLM_MODELS_JSON`, JSON con la forma:

```json
{
  "roles": {
    "*:data_chat": {
      "models": [
        { "model": "openai/gpt-6-luna", "reasoningEffort": "low", "temperature": "omit", "minMaxTokens": 1500 },
        { "model": "google/gemini-3.8-flash", "reasoningEffort": "low", "temperature": "omit" }
      ],
      "routing": { "zdr": true, "only": ["openai", "azure"] }
    },
    "superadmin:copiloto": { "models": [{ "model": "anthropic/claude-sonnet-5.5", "reasoningEffort": "high" }] }
  }
}
```

2. Claves de rol: exacta (`restaurantes:data_chat`) > por sufijo (`*:data_chat`) > `*` > defaults del código.
3. Redeploy de la configuración (cambiar una variable en Vercel redespliega; no hay cambio de código).
4. Un JSON mal formado **no tumba la API**: la ruta inválida se ignora, queda un error estructurado
   `llm_models_json_invalid` en los logs y siguen vigentes los defaults de ese rol.
5. Campos por modelo: `model` (id de OpenRouter), `reasoningEffort` (`none|minimal|low|medium|high|xhigh`),
   `temperature` (`"omit"` o 0-2), `maxTokens`, `minMaxTokens`, `supportsStructuredOutput`. Campos de
   `routing`: `zdr`, `requireParameters`, `allowFallbacks`, `order`, `only`, `ignore` y `dataCollection`
   (solo acepta `"deny"`: la privacidad no se puede relajar por configuración). Ver "Política de proveedores".
6. Antes de cambiar el primario de un rol, corre el eval propio (sección Evals) y una llamada de humo.

Otras variables: `OPENROUTER_ZDR=1` activa `provider.zdr` en todas las rutas, `OPENROUTER_API_KEY` (llave),
`OPENROUTER_COUNTRY_OF_RESIDENCE` (opcional, solo si confirmaste la ruta; alimenta el gate de residencia).
`OPENROUTER_MODEL` **ya no se lee** y `ANTHROPIC_API_KEY`/`ANTHROPIC_MODEL` se retiraron.

## Privacidad

- Todas las peticiones llevan `provider.data_collection: "deny"` (solo proveedores que no retienen ni
  entrenan con el contenido) y `require_parameters: true`.
- **ZDR (Zero Data Retention)**: `provider.zdr: true` restringe a endpoints con retención cero. Requiere
  habilitar ZDR en la cuenta de OpenRouter; **no está activo por defecto** porque si el modelo no tiene un
  endpoint ZDR la ruta queda sin proveedores y el chat cae a modo sin IA. Actívalo con `OPENROUTER_ZDR=1`
  (global) o `routing.zdr` por rol, después de habilitarlo en la cuenta y de una llamada de humo.
- Los mensajes que viajan ya pasan por la redacción de PII del motor del data-chat.
- La llave solo viaja en la cabecera `Authorization`; los errores recortan el cuerpo de respuesta y nunca
  incluyen cabeceras. No se registra la llave en logs, tests ni docs.
- Cabeceras de atribución: `HTTP-Referer` = `APP_BASE_URL` (default `https://app.atiende.ai`), `X-Title` = `Atiende`.

## Errores, reintentos y circuit breaker

| Condición | Reintento en el mismo modelo | Siguiente modelo de la escalera |
|---|---|---|
| 408, 429, 5xx, red, timeout, 200 con error del proveedor | Sí, 1 reintento con backoff exponencial + jitter (respeta `Retry-After` hasta 2 s) | Sí |
| 400, 404, 422 (rechazo específico del modelo: parámetro no soportado, sin endpoint que cumpla la política) | No | Sí |
| 401, 402, 403 (llave inválida, sin crédito, bloqueo) | No | No (se detiene: el siguiente modelo fallaría igual) |
| Fallo a medio streaming | No (ya se emitió texto) | No: el gateway detiene la escalera si el escalón ya entregó texto al llamador (`onTextDelta`), para no mezclar dos respuestas. Un fallo ANTES del primer trozo sí pasa al siguiente modelo. |

- Timeout por intento: 30 s (60 s en streaming).
- **Circuit breaker por modelo** (`openrouter:<modelo>`), 5 fallas en 60 s lo abren 30 s. Es **compartido entre
  instancias** si `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` están configuradas (las mismas del rate
  limit; sin SQL). Sin Upstash, el breaker es **en memoria por instancia**: cada instancia de Vercel descubre
  por su cuenta que un modelo cayó. Si Upstash falla, el breaker es fail-open (nunca tumba una llamada). Las claves
  llevan el entorno (`cb:<entorno>:openrouter:<modelo>`, con `VERCEL_ENV` o `NODE_ENV`): preview y desarrollo no abren
  el breaker de producción cuando comparten el mismo Redis. Al desplegar, los contadores anteriores (`cb:<modelo>`) se
  abandonan y caducan solos.
- Los topes de presupuesto (por corrida y diario) siguen **en memoria por instancia**; el tope mensual por
  organización y el de plataforma sí son persistentes (`core.llm_org_budget`). Límite conocido, sin cambios.

## Modo sin IA

Si el modelo no puede responder (toda la escalera falla, tope de gasto agotado o interruptor de plataforma
del rol apagado), `runDataChatTurn` responde con `noAi: { reason, options }` (`provider_down`, `budget`,
`kill_switch`): el texto dice con claridad que la IA no está disponible y por qué, y `options` lista el
catálogo de consultas deterministas (nombre y descripción). Nunca incluye cifras. El kill switch por rol sigue
siendo `core.platform_switch` (`agente:<rol>`).

Los clientes web (restaurantes, hoteles/rentas y la conexión genérica de despachos/licitaciones/citas) muestran
`options` como botones. Cada botón llama al MISMO endpoint del chat con `{ "tool": "<nombre>" }` en lugar de
`{ "question": ... }` (no ambos): el motor ejecuta esa herramienta del catálogo sin llamar al modelo, con su periodo
por defecto (`ultimos_30_dias` o el primero disponible; el periodo resuelto aparece siempre en la fuente), con el
mismo alcance, límites, tiempo máximo, rate limit y bitácora que un turno normal. Una herramienta con parámetros
obligatorios que no sean de periodo responde `clarify`. Un nombre que no está en el catálogo responde
`invalid_input` sin ejecutar nada.

## Reintento por guardia de cifras

La narrativa del modelo solo se muestra si todas sus cifras existen en los resultados de las consultas. Si no, el
motor hace UN reintento con el rol `<vertical>:data_chat_retry` (por defecto DeepSeek V4 Pro, EE.UU., luego Luna
`high`) y, si tampoco pasa la guardia o el reintento falla, muestra el resumen determinista. El interruptor de
plataforma del rol base (`agente:<vertical>:data_chat`) también detiene el rol de reintento.

## Salida estructurada y streaming

- `request.responseFormat` ({ name, schema }) se manda como `response_format: json_schema` estricto solo si el
  escalón declara `supportsStructuredOutput`. El llamador valida el JSON con su propio esquema.
- `request.onTextDelta` activa `stream: true` (SSE) y entrega los trozos de texto; el resultado final incluye
  herramientas, tokens y costo real. El data-chat hoy **no** hace streaming (la narrativa se valida con el
  numbers-guard antes de mostrarse), pero el proveedor ya lo soporta.

## Costos

Precios de lista usados como respaldo y para reservar (USD por millón de tokens, tarifa estándar, fuente
catálogo de OpenRouter 2026-10-01/02): GPT-6 Luna 0.10 / 0.50; Gemini 2.5 Flash-Lite 0.10 / 0.40; Gemini 3.5
Flash-Lite 0.30 / 2.50; Gemini 3.8 Flash 0.75 / 3.75; Claude Sonnet 5.5 2 / 10; GPT-6 Sol 1 / 5; Muse Spark 1.3
1.25 / 4.25; DeepSeek V4.1 Flash 0.60 / 2.40, DeepSeek V4 Pro 1.91 / 3.83 y Qwen3-235B 0.25 / 1 (estos tres con el
precio MÁS CARO de sus proveedores de EE.UU., para no sub-reservar). La investigación
(`investigacion-modelos-copiloto`) estima ~10 centavos MXN por conversación de data-chat con Luna `low`
(estimación sin medir; se reemplaza con lo medido en evals). El costo **registrado** es el real de OpenRouter.

`tokens_cached` y `tokens_reasoning` se guardan en `core.llm_usage_daily` (migración `0040`, espejo
`20240101000260`; `core.record_llm_usage` pasa a 12 parámetros con `default 0`). Contra una base sin migrar,
`recordUsage` cae a la función de 10 argumentos dentro de un SAVEPOINT (SQLSTATE 42883). La misma migración amplía
el CHECK de `vertical` con `superadmin`, `plataforma` y `reportes` (roles `superadmin:copiloto`, `plataforma:*` y
`reportes:*`).

## Evals en modo real

El arnés de PM (`packages/domain-restaurantes/src/evals/agente-pm/real.ts`) usa el mismo `OpenRouterProvider`:

```
PM_EVALS_REAL=1 OPENROUTER_API_KEY="$(cat ~/.atiende-secrets/OPENROUTER_API_KEY.txt)" \
PM_EVALS_MODEL=openai/gpt-6-luna PM_EVALS_MAX_USD=2 PM_EVALS_K=1 \
npm run evals:pm:real -w @atiende/domain-restaurantes
```

Tope de gasto en USD reales (`PM_EVALS_MAX_USD`), nunca corre en CI. Con una sola llave se barre cualquier
modelo (`PM_EVALS_MODEL`), opcionalmente `PM_EVALS_REASONING` y `PM_EVALS_TEMPERATURE`.

## Credenciales

- `OPENROUTER_API_KEY`: variable sensible de producción en Vercel. Para evals locales,
  `~/.atiende-secrets/OPENROUTER_API_KEY.txt` (permisos 600). **Nunca** se imprime ni se commitea.
- Pendiente de Javier: límite de gasto mensual y política de datos (sin entrenamiento/retención, ZDR) en el
  panel de OpenRouter, y rotar la llave que se compartió por chat.
- Los tests usan un servidor HTTP falso en loopback y llaves generadas en tiempo de ejecución: ninguna prueba
  toca la red real ni la llave.

## Retiro del proveedor directo de Anthropic

`AnthropicProvider` se retiró: ignoraba `tools`/`toolChoice`, perdía los `toolCalls` del assistant y mandaba
mensajes `role:tool` que la Messages API no acepta, y mandaba siempre `temperature` (Claude 4.7+ la rechaza con
400). Los modelos Anthropic pasan ahora por OpenRouter (`anthropic/claude-sonnet-5.5`). Si algún día se
necesita Anthropic directo, debe implementarse con tool-use real y pruebas de contrato antes de entrar a una
escalera. `OpenAiProvider` directo queda solo como **legado**: se usa únicamente si no hay llave de OpenRouter.
