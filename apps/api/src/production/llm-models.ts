// Tabla ROL -> MODELOS del LlmGateway (todos pasan por OpenRouter). Versionada en el repo, con
// valores por defecto SEGUROS y baratos, y sobreescribible SIN redeploy de codigo mediante la
// variable de entorno LLM_MODELS_JSON (cambiar una variable en Vercel y redeploy de configuracion).
// Ver docs/LLM-GATEWAY.md para la tabla completa, como cambiar un modelo y la privacidad.
//
// Reglas de este archivo:
//   * Defaults 1-oct-2026 segun la investigacion de modelos: primario GPT-6 Luna (razonamiento
//     low), respaldo Gemini 3.5 Flash-Lite, CFO/superadmin Claude Sonnet 5.5, reportes largos
//     Gemini 3.8 Flash. Todos de laboratorios de EE.UU.
//   * NINGUN modelo de laboratorios chinos en produccion: ni en los defaults ni vía
//     LLM_MODELS_JSON (se rechazan al validar). Los retadores viven en `EVAL_CHALLENGERS`, apagados,
//     y solo los lee el arnes de evals.
//   * Parametros por modelo: los endpoints de GPT-6 Luna y Claude Sonnet 5.5 (y los de Gemini 3.5
//     Flash-Lite en Vertex) NO listan `temperature` entre los parametros soportados en OpenRouter
//     (verificado en /api/v1/models/<id>/endpoints el 2026-10-01; con Luna y Sonnet 5.5 se confirmo con
//     una llamada real: `temperature: 0` -> 404 sin endpoints). Con `require_parameters: true` mandarla
//     deja la ruta sin endpoints, asi que se omite ('omit') en todos los defaults.
//   * El gateway NUNCA cae a un modelo no listado: una variable mal formada se ignora (con un
//     error estructurado en logs) y se usan los defaults.
import type { OpenRouterModelParams, OpenRouterRouting } from "@atiende/agent-core";

export const SUPERADMIN_COPILOTO_ROLE = "superadmin:copiloto";

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

/** Laboratorios cuyos modelos NO pueden entrar a produccion (decision de datos: solo EE.UU.). */
export const BLOCKED_MODEL_AUTHORS: readonly string[] = [
  "deepseek",
  "qwen",
  "alibaba",
  "z-ai",
  "zhipu",
  "moonshotai",
  "minimax",
  "baidu",
  "tencent",
  "bytedance",
  "bytedance-seed",
  "xiaomi",
  "stepfun",
  "01-ai",
  "meituan",
  "inclusionai",
];

// Proveedores de infraestructura (slugs de OpenRouter) permitidos por laboratorio de origen.
const OPENAI_HOSTS = ["openai", "azure"] as const;
const GOOGLE_HOSTS = ["google-ai-studio", "google-vertex"] as const;
const ANTHROPIC_HOSTS = ["anthropic", "google-vertex", "amazon-bedrock"] as const;

const LUNA_LOW: LlmRungConfig = { model: "openai/gpt-6-luna", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const FLASH_LITE: LlmRungConfig = { model: "google/gemini-3.5-flash-lite", reasoningEffort: "minimal", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };

/** Perfil por defecto (data-chat de las 6 verticales, agentes de WhatsApp, extractores, borradores,
 *  conciliacion): barato y rapido. */
const ECONOMICO: LlmRouteConfig = {
  models: [LUNA_LOW, FLASH_LITE],
  // `only` por escalon se resuelve en `routingForModel`; aqui las preferencias comunes.
  routing: { allowFallbacks: true },
};

/** CFO / copiloto de superadmin: poco volumen, mayor riesgo. */
const PREMIUM: LlmRouteConfig = {
  models: [
    { model: "anthropic/claude-sonnet-5.5", reasoningEffort: "medium", temperature: "omit", minMaxTokens: 3000, supportsStructuredOutput: true },
    { model: "openai/gpt-6-luna", reasoningEffort: "high", temperature: "omit", minMaxTokens: 3000, supportsStructuredOutput: true },
  ],
  routing: { allowFallbacks: true },
};

/** Reportes largos (resumen mensual, informes): carril no interactivo. */
const REPORTES: LlmRouteConfig = {
  models: [
    { model: "google/gemini-3.8-flash", reasoningEffort: "low", temperature: "omit", minMaxTokens: 4000, supportsStructuredOutput: true },
    { model: "openai/gpt-6-luna", reasoningEffort: "low", temperature: "omit", minMaxTokens: 4000, supportsStructuredOutput: true },
  ],
  routing: { allowFallbacks: true },
};

/** Perfil por rol. Todo rol no listado usa ECONOMICO. */
export const DEFAULT_ROLE_ROUTES: Readonly<Record<string, LlmRouteConfig>> = {
  [SUPERADMIN_COPILOTO_ROLE]: PREMIUM,
  "plataforma:resumen_diario": REPORTES,
};

export const DEFAULT_ROUTE: LlmRouteConfig = ECONOMICO;

/** Retadores SOLO para el arnes de evals (MOD-07/08). Apagados: nada en produccion los lee. Entrar a
 *  produccion requiere una decision explicita de Javier (datos de clientes en pesos de laboratorios
 *  chinos servidos en EE.UU.). */
export const EVAL_CHALLENGERS: readonly (LlmRungConfig & { readonly enabled: false; readonly note: string })[] = [
  { model: "deepseek/deepseek-v4.1-flash", enabled: false, note: "Retador de evals; exigir `only` a hosts de EE.UU. (DeepInfra/Together) y ZDR. No usar en produccion." },
  { model: "z-ai/glm-5.3-flash", enabled: false, note: "Retador de evals; exigir `only` a hosts de EE.UU. y ZDR. No usar en produccion." },
];

/** Preferencias de proveedor por laboratorio de origen del modelo: restringe a la infraestructura del
 *  propio laboratorio (o a sus nubes de EE.UU.) y deja que OpenRouter pruebe SOLO entre esas. */
export function defaultHostsForModel(model: string): readonly string[] | undefined {
  const author = model.split("/")[0];
  if (author === "openai") return OPENAI_HOSTS;
  if (author === "google") return GOOGLE_HOSTS;
  if (author === "anthropic") return ANTHROPIC_HOSTS;
  return undefined;
}

export function routingForModel(route: LlmRouteConfig, model: string, globalZdr: boolean): OpenRouterRouting {
  const base = route.routing ?? {};
  const only = base.only ?? defaultHostsForModel(model);
  return {
    ...base,
    ...(only ? { only } : {}),
    zdr: base.zdr ?? (globalZdr ? true : undefined),
  };
}

// ---- Parseo y validacion de LLM_MODELS_JSON ----

export interface LlmModelsConfig {
  /** Rutas por rol: clave exacta ("restaurantes:data_chat"), "*:sufijo" ("*:data_chat") o "*". */
  readonly roles: Readonly<Record<string, LlmRouteConfig>>;
}

const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;
const EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);

export function isBlockedModel(model: string): boolean {
  const author = model.split("/")[0]?.toLowerCase() ?? "";
  return BLOCKED_MODEL_AUTHORS.includes(author);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseRung(raw: unknown, where: string, errors: string[]): LlmRungConfig | null {
  if (!isRecord(raw) || typeof raw.model !== "string" || !MODEL_ID_RE.test(raw.model)) {
    errors.push(`${where}: "model" debe ser un id de OpenRouter "autor/modelo"`);
    return null;
  }
  if (isBlockedModel(raw.model)) {
    errors.push(`${where}: el modelo "${raw.model}" es de un laboratorio no permitido en produccion`);
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
  for (const key of ["zdr", "requireParameters", "allowFallbacks"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v === "boolean") out[key] = v;
    else errors.push(`${where}: "${key}" debe ser booleano`);
  }
  for (const key of ["order", "only", "ignore"] as const) {
    const v = raw[key];
    if (v === undefined) continue;
    if (Array.isArray(v) && v.every((x) => typeof x === "string" && /^[a-z0-9][a-z0-9._/-]*$/i.test(x))) out[key] = v as string[];
    else errors.push(`${where}: "${key}" debe ser una lista de slugs de proveedor`);
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
    if (errors.length > before || models.some((m) => m === null)) continue;
    roles[key] = { models: models as LlmRungConfig[], ...(routing ? { routing } : {}) };
  }
  return { config: { roles }, errors };
}

/** Resuelve la ruta de un rol: clave exacta > "*:sufijo" > "*" (de LLM_MODELS_JSON) > defaults versionados. */
export function resolveRoleRoute(role: string, overrides: LlmModelsConfig | undefined): LlmRouteConfig {
  const o = overrides?.roles ?? {};
  const suffix = role.includes(":") ? role.slice(role.indexOf(":") + 1) : role;
  return o[role] ?? o[`*:${suffix}`] ?? o["*"] ?? DEFAULT_ROLE_ROUTES[role] ?? DEFAULT_ROUTE;
}
