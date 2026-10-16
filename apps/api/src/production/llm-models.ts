// Tabla ROL -> MODELOS del LlmGateway (todos pasan por OpenRouter). Versionada en el repo, con
// valores por defecto SEGUROS y baratos, y sobreescribible SIN redeploy de codigo mediante la
// variable de entorno LLM_MODELS_JSON (cambiar una variable en Vercel y redeploy de configuracion).
// Ver docs/LLM-GATEWAY.md para la tabla completa, como cambiar un modelo y la privacidad.
//
// Reglas de este archivo:
//   * Politica de PROVEEDORES, no de autores (2-oct-2026, decision de Javier: "si acepta DeepSeek y
//     Qwen"): un modelo de CUALQUIER laboratorio entra a produccion solo si la ruta fija
//     `provider.only` a proveedores con servidores en EE.UU. (`ALLOWED_PROVIDER_HOSTS`), siempre con
//     `data_collection: 'deny'` y `require_parameters`, y con `zdr: true` cuando el endpoint lo ofrece.
//     Los modelos de laboratorios chinos (DeepSeek, Qwen, GLM...) solo existen aqui si estan en
//     `VERIFIED_MODEL_HOSTS` (tabla verificada contra la API publica de OpenRouter, ver su comentario);
//     si para un modelo no hay proveedor EE.UU. con esas garantias, se rechaza al validar con un error claro.
//     LLM_MODELS_JSON solo puede ESTRECHAR los proveedores de un modelo, nunca ampliarlos, quitarlos ni
//     relajar la privacidad.
//   * Defaults 2-oct-2026: chat GPT-6 Luna (low) -> DeepSeek V4.1 Flash -> Gemini 2.5 Flash-Lite -> Muse
//     Spark 1.3; reintento por guardia de cifras DeepSeek V4 Pro; CFO/superadmin Claude Sonnet 5.5
//     (respaldo DeepSeek V4 Pro); reportes con etapa de analisis y de redaccion por separado.
//   * Parametros por modelo: los endpoints de GPT-6 Luna y Claude Sonnet 5.5 NO listan `temperature`
//     entre los parametros soportados en OpenRouter (verificado en /api/v1/models/<id>/endpoints el
//     2026-10-01; con Luna y Sonnet 5.5 se confirmo con una llamada real: `temperature: 0` -> 404 sin
//     endpoints). Con `require_parameters: true` mandarla deja la ruta sin endpoints, asi que se omite
//     ('omit') en todos los defaults.
//   * El gateway NUNCA cae a un modelo no listado: una variable mal formada se ignora (con un
//     error estructurado en logs) y se usan los defaults.
import type { OpenRouterModelParams, OpenRouterRouting } from "@atiende/agent-core";
import { MODELOS_AGENTE, modeloAgentePorId } from "@atiende/domain-restaurantes";

export const SUPERADMIN_COPILOTO_ROLE = "superadmin:copiloto";

// Roles nuevos (2-oct-2026). Cada uno tiene su propia ruta para que el eval decida modelo por modelo
// sin tocar codigo (LLM_MODELS_JSON). Se registran en el gateway (llm-gateway.ts). Los cuatro `reportes:*` ya tienen
// llamador (CHAT-14, data-chat/reporte-routes.ts) y por eso estan tambien en ALL_PRODUCTION_ROLES y en
// SWITCHABLE_AGENT_ROLES (interruptor de plataforma). Los cuatro `plataforma:*` tienen llamador desde MOD-12 (enrutador y compuerta en
// el motor del Copiloto, titulos y compactacion en data-chat/conversaciones.ts) y tambien estan en ambas listas.
/** Reintento unico cuando la guardia de cifras rechaza la narrativa del primer modelo. Rol real por
 *  vertical: "<vertical>:data_chat_retry" (default por sufijo, "*:data_chat_retry"). */
export const DATA_CHAT_RETRY_SUFFIX = "data_chat_retry";
export const REPORTE_ANALISIS_FINANCIERO_ROLE = "reportes:analisis_financiero";
export const REPORTE_ANALISIS_GENERAL_ROLE = "reportes:analisis_general";
export const REPORTE_REDACCION_FINANCIERO_ROLE = "reportes:redaccion_financiero";
export const REPORTE_REDACCION_GENERAL_ROLE = "reportes:redaccion_general";
/** Roles de Qwen 3.7 Flash segun la decision de Javier (enrutador/clasificador de turno, compuerta de
 *  escalamiento, titulos y resumenes de side chats, compactacion de historial). Hoy sirven con el
 *  respaldo de EE.UU. (ver `VERIFIED_MODEL_HOSTS["qwen/qwen3.7-flash"]`). */
export const ENRUTADOR_TURNO_ROLE = "plataforma:enrutador_turno";
export const COMPUERTA_ESCALAMIENTO_ROLE = "plataforma:compuerta_escalamiento";
export const TITULOS_RESUMENES_ROLE = "plataforma:titulos_resumenes";
export const COMPACTACION_HISTORIAL_ROLE = "plataforma:compactacion_historial";
/** R-32: transcripcion de notas de voz de WhatsApp de restaurantes (entrada de audio). Ruta propia para que el eval cambie el modelo
 *  sin tocar codigo. Hoy: Gemini 2.5 Flash-Lite (acepta audio, el mas barato) -> Gemini 3.5 Flash-Lite; ambos alojados por Google AI
 *  Studio / Vertex (`GOOGLE_HOSTS`, en la lista permitida). Si ningun escalon acepta la peticion, el llamador conserva el comportamiento de
 *  "pedir al cliente que escriba". */
export const RESTAURANTES_TRANSCRIPCION_ROLE = "restaurantes:transcripcion";
export const NEW_PLATFORM_LLM_ROLES: readonly string[] = [
  REPORTE_ANALISIS_FINANCIERO_ROLE,
  REPORTE_ANALISIS_GENERAL_ROLE,
  REPORTE_REDACCION_FINANCIERO_ROLE,
  REPORTE_REDACCION_GENERAL_ROLE,
  ENRUTADOR_TURNO_ROLE,
  COMPUERTA_ESCALAMIENTO_ROLE,
  TITULOS_RESUMENES_ROLE,
  COMPACTACION_HISTORIAL_ROLE,
];

/** Un escalon de la escalera: un modelo con sus parametros. */
export interface LlmRungConfig extends OpenRouterModelParams {
  /** Id de OpenRouter, "autor/modelo". */
  readonly model: string;
}

export interface LlmRouteConfig {
  /** En orden de preferencia; cada uno es un escalon de la escalera (con su propio circuit breaker). */
  readonly models: readonly LlmRungConfig[];
  readonly routing?: OpenRouterRouting;
}

// ---- Politica de proveedores (allowlist) ----

/** Proveedores de infraestructura (slugs de OpenRouter) con servidores en EE.UU. o laboratorios de EE.UU.
 *  que pueden recibir datos de clientes. Es la UNICA lista de la politica: un modelo (de cualquier
 *  laboratorio) entra solo si todos sus proveedores estan aqui. Decision de producto: agregar un
 *  proveedor es un cambio de codigo revisado, nunca una variable de entorno. */
export const ALLOWED_PROVIDER_HOSTS: readonly string[] = [
  "openai",
  "azure",
  "google-ai-studio",
  "google-vertex",
  "anthropic",
  "amazon-bedrock",
  "meta",
  "deepinfra",
  "together",
  "fireworks",
  "baseten",
  "parasail",
  "coreweave",
  "groq",
];

export interface VerifiedModelHosts {
  /** Proveedores de `ALLOWED_PROVIDER_HOSTS` que hoy alojan el modelo. Vacio = no hay proveedor de EE.UU.
   *  verificado: el modelo se rechaza al validar. */
  readonly hosts: readonly string[];
  /** Hay al menos un endpoint ZDR en esos proveedores: se fuerza `provider.zdr: true`. */
  readonly zdr: boolean;
  readonly note: string;
}

/** Modelos cuyo origen no basta para inferir proveedores seguros (laboratorios chinos y Meta), con los
 *  proveedores EE.UU. verificados el 2026-10-01 en https://openrouter.ai/api/v1/models/<id>/endpoints
 *  cruzado con https://openrouter.ai/api/v1/endpoints/zdr (lista publica de endpoints con retencion cero).
 *  Re-verificar con `node scripts/check-llm-us-hosts.mjs` antes de cambiar una fila. */
export const VERIFIED_MODEL_HOSTS: Readonly<Record<string, VerifiedModelHosts>> = {
  "deepseek/deepseek-v4.1-flash": {
    hosts: ["deepinfra", "together", "fireworks", "baseten", "parasail", "coreweave"],
    zdr: true,
    note: "DeepSeek V4.1 Flash: 6 proveedores de EE.UU. con endpoint ZDR (DeepInfra, Together, Fireworks, Baseten, Parasail, CoreWeave).",
  },
  "deepseek/deepseek-v4-pro": {
    hosts: ["deepinfra", "parasail", "azure"],
    zdr: true,
    note: "DeepSeek V4 Pro: DeepInfra, Parasail y Azure (azure/us) con endpoint ZDR.",
  },
  "openai/gpt-oss-120b": {
    hosts: ["deepinfra", "baseten", "coreweave", "amazon-bedrock", "google-vertex"],
    zdr: true,
    note: "gpt-oss-120b: DeepInfra, Baseten, CoreWeave, Amazon Bedrock y Google Vertex con endpoint ZDR (1-oct-2026). OpenAI y Azure NO lo sirven, por eso no vale el default por autor.",
  },
  "qwen/qwen3-235b-a22b-2507": {
    hosts: ["google-vertex", "parasail", "deepinfra"],
    zdr: true,
    note: "Qwen3-235B-A22B-2507: Google Vertex (us-south1), Parasail y DeepInfra con endpoint ZDR.",
  },
  "mistralai/mistral-small-3.2-24b-instruct": {
    hosts: ["deepinfra", "parasail"],
    zdr: true,
    note: "Mistral Small 3.2 24B: DeepInfra y Parasail con endpoint ZDR (1-oct-2026). Con herramientas solo DeepInfra: Parasail no lista `tools`, y `require_parameters` lo excluye del chat.",
  },
  "meta-llama/llama-4-maverick": {
    hosts: [],
    zdr: false,
    note: "Llama 4 Maverick: en el piloto del 1-oct-2026 OpenRouter respondio 404 (\"Every candidate endpoint was removed during routing\") con la politica de EE.UU. y ZDR; sin ruta verificada. Rechazado hasta que aparezca un proveedor de EE.UU. con ZDR.",
  },
  "meta/muse-spark-1.3-contributor": {
    hosts: [],
    zdr: false,
    note: "Muse Spark 1.3 (contributor): en el piloto del 1-oct-2026 OpenRouter respondio 404 (\"No endpoints found matching your data policy (Paid model training)\"); sin ruta verificada. Rechazado (la variante sin sufijo, `meta/muse-spark-1.3`, es otra fila).",
  },
  "qwen/qwen3.7-flash": {
    hosts: [],
    zdr: false,
    note: "Qwen 3.7 Flash: hoy SOLO lo sirve Alibaba (sin endpoint ZDR ni servidores de EE.UU. verificados). Rechazado hasta que aparezca un proveedor de EE.UU. con ZDR.",
  },
  "meta/muse-spark-1.3": {
    hosts: ["meta"],
    zdr: false,
    note: "Muse Spark 1.3: solo el endpoint de Meta (EE.UU.), sin ZDR.",
  },
};

// Proveedores de infraestructura por laboratorio de EE.UU. cuando el modelo no esta en la tabla.
const OPENAI_HOSTS = ["openai", "azure"] as const;
const GOOGLE_HOSTS = ["google-ai-studio", "google-vertex"] as const;
const ANTHROPIC_HOSTS = ["anthropic", "google-vertex", "amazon-bedrock"] as const;

/** Proveedores permitidos de un modelo: la fila verificada o, para openai/google/anthropic, los de su
 *  propia infraestructura. `undefined` = modelo sin proveedores verificados (exige `only` explicito). */
export function defaultHostsForModel(model: string): readonly string[] | undefined {
  const verified = VERIFIED_MODEL_HOSTS[model];
  if (verified) return verified.hosts;
  const author = model.split("/")[0];
  if (author === "openai") return OPENAI_HOSTS;
  if (author === "google") return GOOGLE_HOSTS;
  if (author === "anthropic") return ANTHROPIC_HOSTS;
  return undefined;
}

/** Evalua un escalon contra la politica. Devuelve los proveedores efectivos o el error (en espanol). */
export function resolveRungHosts(model: string, requestedOnly: readonly string[] | undefined): { hosts: readonly string[] } | { error: string } {
  const verified = VERIFIED_MODEL_HOSTS[model];
  if (verified && verified.hosts.length === 0) {
    return { error: `"${model}" no tiene hoy un proveedor con servidores en EE.UU. y retencion cero verificado (${verified.note}); no se puede usar en produccion` };
  }
  const base = defaultHostsForModel(model);
  const outsideAllowlist = (requestedOnly ?? []).filter((h) => !ALLOWED_PROVIDER_HOSTS.includes(h));
  if (outsideAllowlist.length > 0) {
    return { error: `"only" incluye proveedores fuera de la lista permitida de EE.UU.: ${outsideAllowlist.join(", ")}` };
  }
  if (!base) {
    if (!requestedOnly || requestedOnly.length === 0) {
      return { error: `"${model}" no tiene proveedores de EE.UU. verificados: la ruta debe fijar "only" a proveedores permitidos (${ALLOWED_PROVIDER_HOSTS.join(", ")})` };
    }
    return { hosts: requestedOnly };
  }
  if (!requestedOnly || requestedOnly.length === 0) return { hosts: base };
  const notVerified = requestedOnly.filter((h) => !base.includes(h));
  if (notVerified.length > 0) {
    return { error: `"only" incluye proveedores que no estan verificados para "${model}": ${notVerified.join(", ")} (verificados: ${base.join(", ")})` };
  }
  return { hosts: requestedOnly };
}

const LUNA_LOW: LlmRungConfig = { model: "openai/gpt-6-luna", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const DEEPSEEK_FLASH: LlmRungConfig = { model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const DEEPSEEK_PRO: LlmRungConfig = { model: "deepseek/deepseek-v4-pro", reasoningEffort: "medium", temperature: "omit", minMaxTokens: 3000, supportsStructuredOutput: true };
const FLASH_LITE_25: LlmRungConfig = { model: "google/gemini-2.5-flash-lite", reasoningEffort: "minimal", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const MUSE_SPARK: LlmRungConfig = { model: "meta/muse-spark-1.3", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const SONNET_MEDIUM: LlmRungConfig = { model: "anthropic/claude-sonnet-5.5", reasoningEffort: "medium", temperature: "omit", minMaxTokens: 3000, supportsStructuredOutput: true };
const QWEN_235B: LlmRungConfig = { model: "qwen/qwen3-235b-a22b-2507", temperature: "omit", minMaxTokens: 3000, supportsStructuredOutput: true };
const GEMINI_38_FLASH: LlmRungConfig = { model: "google/gemini-3.8-flash", reasoningEffort: "low", temperature: "omit", minMaxTokens: 4000, supportsStructuredOutput: true };

/** Escalon para un modelo ELEGIDO por una organizacion de restaurantes (lista permitida `MODELOS_AGENTE` de domain-restaurantes): los mismos
 *  parametros de razonamiento/tokens que el escalon por defecto del modelo, pero con la temperatura HABILITADA solo si el modelo la admite
 *  (`aceptaTemperatura`: verificado en los endpoints permitidos de OpenRouter el 2026-10-04) y 'omit' si no (con `require_parameters` mandarla a
 *  Luna o Sonnet deja la ruta sin endpoints). Sin `temperature` el escalon usa la de la peticion. `undefined` = el id no esta en la lista. */
const BASE_RUNG_MODELO_AGENTE: Readonly<Record<string, LlmRungConfig>> = {
  [LUNA_LOW.model]: LUNA_LOW,
  [DEEPSEEK_FLASH.model]: DEEPSEEK_FLASH,
  [FLASH_LITE_25.model]: FLASH_LITE_25,
  [MUSE_SPARK.model]: MUSE_SPARK,
  [GEMINI_38_FLASH.model]: GEMINI_38_FLASH,
  [SONNET_MEDIUM.model]: SONNET_MEDIUM,
};

export function rungParaModeloAgente(modeloId: string): LlmRungConfig | undefined {
  const modelo = modeloAgentePorId(modeloId);
  const base = BASE_RUNG_MODELO_AGENTE[modeloId];
  if (!modelo || !base) return undefined;
  const { temperature: _omitida, ...resto } = base;
  return modelo.aceptaTemperatura ? resto : { ...resto, temperature: "omit" };
}

/** Todos los modelos elegibles por una organizacion, con su escalon (la lista de domain-restaurantes manda; un test exige que cada uno tenga escalon). */
export function rungsDeModelosAgente(): readonly LlmRungConfig[] {
  return MODELOS_AGENTE.map((m) => rungParaModeloAgente(m.id)).filter((r): r is LlmRungConfig => r !== undefined);
}

/** Perfil por defecto (data-chat de las 6 verticales, agentes de WhatsApp, extractores, borradores,
 *  conciliacion): barato y rapido. Luna -> DeepSeek V4.1 Flash -> Gemini 2.5 Flash-Lite -> Muse Spark 1.3;
 *  despues, modo sin IA (lo decide el llamador). */
const ECONOMICO: LlmRouteConfig = {
  models: [LUNA_LOW, DEEPSEEK_FLASH, FLASH_LITE_25, MUSE_SPARK],
  // `only` por escalon se resuelve en `routingForModel`; aqui las preferencias comunes.
  routing: { allowFallbacks: true },
};

/** CFO / copiloto de superadmin: poco volumen, mayor riesgo. */
const PREMIUM: LlmRouteConfig = {
  models: [SONNET_MEDIUM, DEEPSEEK_PRO],
  routing: { allowFallbacks: true },
};

/** Reintento por guardia de cifras: un solo modelo mas fuerte que el primario del chat. */
const REINTENTO_CIFRAS: LlmRouteConfig = {
  models: [DEEPSEEK_PRO, { ...LUNA_LOW, reasoningEffort: "high", minMaxTokens: 3000 }],
  routing: { allowFallbacks: true },
};

/** Reportes largos (resumen mensual, informes): carril no interactivo. */
const REPORTES: LlmRouteConfig = {
  models: [GEMINI_38_FLASH, { ...LUNA_LOW, minMaxTokens: 4000 }],
  routing: { allowFallbacks: true },
};

/** Analisis de datos de reportes financieros: Sonnet 5.5 (mueve dinero); respaldo DeepSeek V4 Pro. */
const ANALISIS_FINANCIERO: LlmRouteConfig = { models: [SONNET_MEDIUM, DEEPSEEK_PRO], routing: { allowFallbacks: true } };
/** Analisis de datos de reportes no financieros: Qwen3-235B-A22B-2507 (EE.UU., ZDR). */
const ANALISIS_GENERAL: LlmRouteConfig = { models: [QWEN_235B, DEEPSEEK_FLASH, { ...LUNA_LOW, minMaxTokens: 3000 }], routing: { allowFallbacks: true } };
/** Redaccion de reportes (rutas separadas por tipo para que el eval decida: Gemini 3.8 Flash hoy; Qwen 3.7
 *  Flash cuando tenga proveedor de EE.UU. con ZDR). */
const REDACCION: LlmRouteConfig = { models: [GEMINI_38_FLASH, { ...LUNA_LOW, minMaxTokens: 4000 }], routing: { allowFallbacks: true } };
/** Tareas cortas y baratas (enrutador de turno, compuerta de escalamiento, titulos y resumenes,
 *  compactacion de historial). */
const TAREAS_CORTAS: LlmRouteConfig = { models: [LUNA_LOW, DEEPSEEK_FLASH], routing: { allowFallbacks: true } };

/** Transcripcion de audio (R-32): solo modelos con entrada de audio verificada en `architecture.input_modalities` de OpenRouter
 *  (2026-10-03). Salida corta (una nota de voz de <= 60 s son ~200 palabras): piso de tokens bajo. */
const TRANSCRIPCION: LlmRouteConfig = {
  models: [
    { model: "google/gemini-2.5-flash-lite", reasoningEffort: "minimal", temperature: "omit", minMaxTokens: 800 },
    { model: "google/gemini-3.5-flash-lite", temperature: "omit", minMaxTokens: 1000 },
  ],
  routing: { allowFallbacks: true },
};

/** Perfil por rol. Clave exacta ("superadmin:copiloto") o "*:sufijo" (ej. "*:data_chat_retry"). Todo
 *  rol no listado usa ECONOMICO. */
export const DEFAULT_ROLE_ROUTES: Readonly<Record<string, LlmRouteConfig>> = {
  [SUPERADMIN_COPILOTO_ROLE]: PREMIUM,
  "plataforma:resumen_diario": REPORTES,
  [`*:${DATA_CHAT_RETRY_SUFFIX}`]: REINTENTO_CIFRAS,
  [REPORTE_ANALISIS_FINANCIERO_ROLE]: ANALISIS_FINANCIERO,
  [REPORTE_ANALISIS_GENERAL_ROLE]: ANALISIS_GENERAL,
  [REPORTE_REDACCION_FINANCIERO_ROLE]: REDACCION,
  [REPORTE_REDACCION_GENERAL_ROLE]: REDACCION,
  [RESTAURANTES_TRANSCRIPCION_ROLE]: TRANSCRIPCION,
  [ENRUTADOR_TURNO_ROLE]: TAREAS_CORTAS,
  [COMPUERTA_ESCALAMIENTO_ROLE]: TAREAS_CORTAS,
  [TITULOS_RESUMENES_ROLE]: TAREAS_CORTAS,
  [COMPACTACION_HISTORIAL_ROLE]: TAREAS_CORTAS,
};

export const DEFAULT_ROUTE: LlmRouteConfig = ECONOMICO;

/** Retadores SOLO para el arnes de evals (MOD-07/08). Apagados: nada en produccion los lee. */
export const EVAL_CHALLENGERS: readonly (LlmRungConfig & { readonly enabled: false; readonly note: string })[] = [
  { model: "z-ai/glm-5.3-flash", enabled: false, note: "Retador de evals; sin proveedores de EE.UU. verificados en `VERIFIED_MODEL_HOSTS`: no se puede usar en produccion." },
  { model: "qwen/qwen3.7-flash", enabled: false, note: "Candidato a enrutador/redactor; hoy solo lo sirve Alibaba (sin EE.UU./ZDR), rechazado en produccion hasta que cambie." },
];

/** Enrutamiento efectivo de un escalon: la politica de proveedores SIEMPRE se aplica (`only` nunca vacio,
 *  `data_collection: 'deny'`, `require_parameters`, `zdr` forzado cuando el endpoint lo ofrece). Lanza si el
 *  escalon no cumple la politica (los defaults los cubre un test; LLM_MODELS_JSON se valida antes). */
export function routingForModel(route: LlmRouteConfig, model: string, globalZdr: boolean): OpenRouterRouting {
  const base = route.routing ?? {};
  const resolved = resolveRungHosts(model, base.only);
  if ("error" in resolved) throw new Error(`routing invalido para ${model}: ${resolved.error}`);
  const verified = VERIFIED_MODEL_HOSTS[model];
  // Un modelo sin fila verificada y sin laboratorio conocido exige ZDR (no se puede comprobar el endpoint).
  const unknownLab = verified === undefined && defaultHostsForModel(model) === undefined;
  const forceZdr = verified?.zdr === true || unknownLab;
  const order = base.order?.filter((h) => resolved.hosts.includes(h));
  return {
    ...base,
    only: resolved.hosts,
    order: order && order.length > 0 ? order : undefined,
    dataCollection: "deny",
    requireParameters: true,
    zdr: forceZdr ? true : (base.zdr ?? (globalZdr ? true : undefined)),
  };
}

// ---- Parseo y validacion de LLM_MODELS_JSON ----

export interface LlmModelsConfig {
  /** Rutas por rol: clave exacta ("restaurantes:data_chat"), "*:sufijo" ("*:data_chat") o "*". */
  readonly roles: Readonly<Record<string, LlmRouteConfig>>;
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRung(raw: unknown, where: string, errors: string[]): LlmRungConfig | null {
  if (!isRecord(raw) || typeof raw.model !== "string" || !MODEL_ID_RE.test(raw.model)) {
    errors.push(`${where}: "model" debe ser un id de OpenRouter "autor/modelo"`);
    return null;
  }
  const rung: { -readonly [K in keyof LlmRungConfig]: LlmRungConfig[K] } = { model: raw.model };
  if (raw.temperature !== undefined) {
    if (raw.temperature === "omit" || (typeof raw.temperature === "number" && raw.temperature >= 0 && raw.temperature <= 2)) rung.temperature = raw.temperature;
    else errors.push(`${where}: "temperature" debe ser "omit" o un numero entre 0 y 2`);
  }
  if (raw.reasoningEffort !== undefined) {
    if (typeof raw.reasoningEffort === "string" && EFFORTS.has(raw.reasoningEffort)) rung.reasoningEffort = raw.reasoningEffort as LlmRungConfig["reasoningEffort"];
    else errors.push(`${where}: "reasoningEffort" invalido`);
  }
  for (const key of ["maxTokens", "minMaxTokens"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "number" && Number.isInteger(v) && v >= 1 && v <= 128_000) rung[key] = v;
    else errors.push(`${where}: "${key}" debe ser un entero entre 1 y 128000`);
  }
  if (raw.supportsStructuredOutput !== undefined) {
    if (typeof raw.supportsStructuredOutput === "boolean") rung.supportsStructuredOutput = raw.supportsStructuredOutput;
    else errors.push(`${where}: "supportsStructuredOutput" debe ser booleano`);
  }
  return rung;
}

function parseRouting(raw: unknown, where: string, errors: string[]): OpenRouterRouting | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw)) {
    errors.push(`${where}: "routing" debe ser un objeto`);
    return undefined;
  }
  const out: { -readonly [K in keyof OpenRouterRouting]: OpenRouterRouting[K] } = {};
  if (raw.dataCollection !== undefined) {
    // Relajar la privacidad NO se permite por esta via: solo 'deny'.
    if (raw.dataCollection === "deny") out.dataCollection = "deny";
    else errors.push(`${where}: "dataCollection" solo puede ser "deny" (no se permite relajar la privacidad por configuracion)`);
  }
  if (raw.requireParameters !== undefined) {
    if (raw.requireParameters === true) out.requireParameters = true;
    else errors.push(`${where}: "requireParameters" solo puede ser true (no se permite mandar parametros que el proveedor no soporte)`);
  }
  for (const key of ["zdr", "allowFallbacks"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "boolean") out[key] = v;
    else errors.push(`${where}: "${key}" debe ser booleano`);
  }
  for (const key of ["order", "only", "ignore"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (Array.isArray(v) && v.every((x) => typeof x === "string" && /^[a-z0-9][a-z0-9._/-]*$/i.test(x))) {
      if (key === "only" && v.length === 0) errors.push(`${where}: "only" no puede quedar vacio (quitar la lista de proveedores no esta permitido)`);
      else out[key] = v as string[];
    } else errors.push(`${where}: "${key}" debe ser una lista de slugs de proveedor`);
  }
  return out;
}

/** Valida `LLM_MODELS_JSON`. Nunca lanza: devuelve la configuracion valida y la lista de errores.
 *  Una ruta con CUALQUIER error se descarta completa (los defaults siguen vigentes para ese rol). */
export function parseLlmModelsJson(raw: string | null | undefined): { config: LlmModelsConfig; errors: string[] } {
  const errors: string[] = [];
  const roles: Record<string, LlmRouteConfig> = {};
  if (!raw || raw.trim() === "") return { config: { roles }, errors };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { config: { roles }, errors: ["LLM_MODELS_JSON no es JSON valido"] };
  }
  if (!isRecord(parsed) || !isRecord(parsed.roles)) return { config: { roles }, errors: ['LLM_MODELS_JSON debe tener la forma {"roles": {...}}'] };
  for (const [key, value] of Object.entries(parsed.roles)) {
    const where = `roles["${key}"]`;
    if (!/^(\*|\*:[a-z0-9_]+|[a-z0-9_]+:[a-z0-9_]+)$/.test(key)) {
      errors.push(`${where}: clave de rol invalida (use "vertical:rol", "*:rol" o "*")`);
      continue;
    }
    if (!isRecord(value) || !Array.isArray(value.models) || value.models.length === 0 || value.models.length > 5) {
      errors.push(`${where}: "models" debe ser una lista de 1 a 5 modelos`);
      continue;
    }
    const before = errors.length;
    const models = value.models.map((m, i) => parseRung(m, `${where}.models[${i}]`, errors));
    const routing = parseRouting(value.routing, `${where}.routing`, errors);
    if (errors.length === before) {
      // Politica de proveedores: cada escalon debe resolver a proveedores permitidos de EE.UU.
      models.forEach((m, i) => {
        if (!m) return;
        const resolved = resolveRungHosts(m.model, routing?.only);
        if ("error" in resolved) errors.push(`${where}.models[${i}]: ${resolved.error}`);
      });
    }
    if (errors.length > before || models.some((m) => m === null)) continue;
    roles[key] = { models: models as LlmRungConfig[], ...(routing ? { routing } : {}) };
  }
  return { config: { roles }, errors };
}

/** Resuelve la ruta de un rol: clave exacta > "*:sufijo" > "*" (de LLM_MODELS_JSON) > defaults versionados
 *  (clave exacta > "*:sufijo") > perfil economico. */
export function resolveRoleRoute(role: string, overrides: LlmModelsConfig | undefined): LlmRouteConfig {
  const o = overrides?.roles ?? {};
  const suffix = role.includes(":") ? role.slice(role.indexOf(":") + 1) : role;
  return o[role] ?? o[`*:${suffix}`] ?? o["*"] ?? DEFAULT_ROLE_ROUTES[role] ?? DEFAULT_ROLE_ROUTES[`*:${suffix}`] ?? DEFAULT_ROUTE;
}
