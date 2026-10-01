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

## Tabla rol -> modelos (defaults, verificados el 2026-10-01)

| Rol | Modelo 1 | Modelo 2 (respaldo) | Notas |
|---|---|---|---|
| `*:data_chat` (6 verticales), `*:whatsapp_agent(_escalated)`, extractor de requisitos, borrador de propuesta, preguntas de junta, mensajería de rentas, conciliación de despachos | `openai/gpt-6-luna` (razonamiento `low`) | `google/gemini-3.5-flash-lite` (razonamiento `minimal`) | Perfil económico: barato y rápido. |
| `superadmin:copiloto` (CFO) | `anthropic/claude-sonnet-5.5` (`medium`) | `openai/gpt-6-luna` (`high`) | Poco volumen, mayor riesgo. La ruta que lo invoque llega con SA-33..35; su interruptor de plataforma también (no está en `ALL_PRODUCTION_ROLES` a propósito). |
| `plataforma:resumen_diario` y reportes largos | `google/gemini-3.8-flash` (`low`) | `openai/gpt-6-luna` (`low`) | El precio de Gemini 3.8 Flash se duplica el 1-ene-2027 (investigación): reevaluar. |

Parámetros por modelo en los defaults:

- `temperature: "omit"`. Los endpoints de GPT-6 Luna y Claude Sonnet 5.5 (y los de Gemini 3.5 Flash-Lite en
  Vertex) **no listan `temperature`** entre los parámetros soportados de OpenRouter (verificado en
  `/api/v1/models/<id>/endpoints`; con Luna y Sonnet 5.5 se confirmó con una llamada real: `temperature: 0`
  devuelve 404 "No endpoints found that can handle the requested parameters"). Con `require_parameters: true`,
  mandarla deja la ruta sin endpoints; por eso se omite en todos los defaults.
- `minMaxTokens`: piso del tope de salida (1500 a 4000 según el rol). Los tokens de razonamiento consumen
  el tope: con 500 la respuesta podía quedar vacía.
- Preferencias de proveedor por laboratorio (`provider.only`): `openai/*` -> `openai`, `azure`;
  `google/*` -> `google-ai-studio`, `google-vertex`; `anthropic/*` -> `anthropic`, `google-vertex`,
  `amazon-bedrock`. OpenRouter solo prueba entre esos (fallback controlado).
- **Modelos de laboratorios chinos: ninguno en producción.** `LLM_MODELS_JSON` los rechaza al validar
  (`BLOCKED_MODEL_AUTHORS`). Los retadores (`EVAL_CHALLENGERS`) están apagados y solo los puede leer el arnés
  de evals. Usarlos con datos de clientes requiere una decisión explícita de Javier.

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
   (solo acepta `"deny"`: la privacidad no se puede relajar por configuración).
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
| Fallo a medio streaming | No (ya se emitió texto) | No |

- Timeout por intento: 30 s (60 s en streaming).
- **Circuit breaker por modelo** (`openrouter:<modelo>`), 5 fallas en 60 s lo abren 30 s. Es **compartido entre
  instancias** si `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` están configuradas (las mismas del rate
  limit; sin SQL). Sin Upstash, el breaker es **en memoria por instancia**: cada instancia de Vercel descubre
  por su cuenta que un modelo cayó. Si Upstash falla, el breaker es fail-open (nunca tumba una llamada).
- Los topes de presupuesto (por corrida y diario) siguen **en memoria por instancia**; el tope mensual por
  organización y el de plataforma sí son persistentes (`core.llm_org_budget`). Límite conocido, sin cambios.

## Modo sin IA

Si el modelo no puede responder (toda la escalera falla, tope de gasto agotado o interruptor de plataforma
del rol apagado), `runDataChatTurn` responde con `noAi: { reason, options }` (`provider_down`, `budget`,
`kill_switch`): el texto dice con claridad que la IA no está disponible y por qué, y `options` lista el
catálogo de consultas deterministas (nombre y descripción) para ofrecerlas como botones. Nunca incluye cifras.
El kill switch por rol sigue siendo `core.platform_switch` (`agente:<rol>`).

## Salida estructurada y streaming

- `request.responseFormat` ({ name, schema }) se manda como `response_format: json_schema` estricto solo si el
  escalón declara `supportsStructuredOutput`. El llamador valida el JSON con su propio esquema.
- `request.onTextDelta` activa `stream: true` (SSE) y entrega los trozos de texto; el resultado final incluye
  herramientas, tokens y costo real. El data-chat hoy **no** hace streaming (la narrativa se valida con el
  numbers-guard antes de mostrarse), pero el proveedor ya lo soporta.

## Costos

Precios de lista usados como respaldo y para reservar (USD por millón de tokens, tarifa estándar, fuente
catálogo de OpenRouter 2026-10-01): GPT-6 Luna 0.10 / 0.50; Gemini 3.5 Flash-Lite 0.30 / 2.50; Gemini 3.8
Flash 0.75 / 3.75; Claude Sonnet 5.5 2 / 10; GPT-6 Sol 1 / 5. La investigación
(`investigacion-modelos-copiloto`) estima ~10 centavos MXN por conversación de data-chat con Luna `low`
(estimación sin medir; se reemplaza con lo medido en evals). El costo **registrado** es el real de OpenRouter.

Pendiente: guardar `tokens_cached`/`tokens_reasoning` en `core.llm_usage_daily` requiere una migración (este
cambio no toca SQL); el proveedor ya los lee (`tokensCached`, `tokensReasoning` en el resultado).

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
