// Candidatos del eval del Copiloto sobre OpenRouter (ids y precios verificados en la API publica el
// 1-oct-2026; los precios solo sirven para PROYECTAR gasto: el costo reportado de cada llamada se lee
// de `usage.cost` real). Todos se llaman con preferencias de proveedor EE.UU./ZDR:
// `data_collection: deny`, `zdr: true`, `require_parameters: true` y `only` = hosts de EE.UU. que hoy
// sirven ese modelo con herramientas. Un modelo que NO tenga ruta EE.UU./ZDR responde 404 "No endpoints
// found" y el runner lo descarta ("sin ruta") en vez de relajar la politica: es la regla de Javier del
// 1-oct (modelos de laboratorios chinos SOLO desde proveedores de EE.UU. con ZDR).
import type { OpenRouterModelParams, OpenRouterRouting } from "../../gateway/providers/openrouter.js";

export type RolEval =
  | "chat_general" // primario del chat de las 6 verticales
  | "respaldo" // 2do/3er escalon de la escalera del chat
  | "reintento_guardia" // 1 reintento cuando falla la guardia de cifras
  | "cfo_superadmin" // Copiloto del CFO/superadmin (lo mas importante)
  | "calibracion" // solo piloto: punto de referencia caro, nunca candidato a produccion
  | "enrutador" // clasificador de turno / compuerta de escalamiento (no es el chat completo)
  | "juez_espanol"
  | "redactor_reporte"
  | "analista_datos";

export type FaseEval = "piloto" | "barrido" | "cfo" | "bakeoff";

export interface ModeloCandidato {
  /** Id de OpenRouter. */
  readonly id: string;
  readonly etiqueta: string;
  readonly params: OpenRouterModelParams;
  readonly routing: OpenRouterRouting;
  readonly roles: readonly RolEval[];
  readonly fases: readonly FaseEval[];
  /** USD por millon de tokens (entrada/salida), snapshot del 1-oct-2026: solo para proyectar. */
  readonly precio: { readonly entrada: number; readonly salida: number };
  /** true = el modelo tiene al menos un host de EE.UU. con herramientas (lista `only`). */
  readonly hostEeuu: boolean;
  /** Origen del candidato: el stack elegido por Javier o la lista de baratos (eval-candidatos-baratos.md). */
  readonly origen: "stack" | "baratos";
  readonly nota?: string;
}

const base = (extra: Partial<OpenRouterModelParams> = {}): OpenRouterModelParams => ({ minMaxTokens: 1500, ...extra });
const ruta = (only?: readonly string[]): OpenRouterRouting => ({ dataCollection: "deny", zdr: true, requireParameters: true, allowFallbacks: false, ...(only ? { only } : {}) });

const SOLO_PILOTO: readonly FaseEval[] = ["piloto"];
const PILOTO_BARRIDO: readonly FaseEval[] = ["piloto", "barrido"];

export const CANDIDATOS: readonly ModeloCandidato[] = [
  // ---- stack elegido por Javier (cola-maestra: ARQUITECTURA DE MODELOS ELEGIDA + STACK CONFIRMADO) ----
  { id: "openai/gpt-6-luna", etiqueta: "GPT-6 Luna (low)", params: base({ temperature: "omit", reasoningEffort: "low", supportsStructuredOutput: true }), routing: ruta(["openai", "azure"]), roles: ["chat_general"], fases: PILOTO_BARRIDO, precio: { entrada: 0.1, salida: 0.5 }, hostEeuu: true, origen: "stack" },
  { id: "deepseek/deepseek-v4.1-flash", etiqueta: "DeepSeek V4.1 Flash", params: base(), routing: ruta(["deepinfra", "together", "fireworks", "baseten", "parasail"]), roles: ["respaldo"], fases: PILOTO_BARRIDO, precio: { entrada: 0.03, salida: 0.5 }, hostEeuu: true, origen: "stack" },
  { id: "deepseek/deepseek-v4-pro", etiqueta: "DeepSeek V4 Pro", params: base(), routing: ruta(["deepinfra", "azure", "parasail", "cloudflare", "gmicloud"]), roles: ["reintento_guardia", "cfo_superadmin", "analista_datos"], fases: PILOTO_BARRIDO, precio: { entrada: 0.2088, salida: 0.4176 }, hostEeuu: true, origen: "stack" },
  { id: "meta/muse-spark-1.3-contributor", etiqueta: "Muse Spark 1.3 (contributor)", params: base(), routing: ruta(["meta"]), roles: ["respaldo"], fases: PILOTO_BARRIDO, precio: { entrada: 0.1, salida: 0.2 }, hostEeuu: true, origen: "stack" },
  { id: "google/gemini-2.5-flash-lite", etiqueta: "Gemini 2.5 Flash-Lite", params: base(), routing: ruta(["google-vertex", "google-ai-studio"]), roles: ["respaldo"], fases: PILOTO_BARRIDO, precio: { entrada: 0.1, salida: 0.4 }, hostEeuu: true, origen: "stack" },
  { id: "openai/gpt-oss-120b", etiqueta: "gpt-oss-120b", params: base(), routing: ruta(["deepinfra", "together", "baseten", "parasail", "crusoe", "coreweave", "groq", "cerebras", "amazon-bedrock"]), roles: ["chat_general", "respaldo"], fases: PILOTO_BARRIDO, precio: { entrada: 0.037, salida: 0.17 }, hostEeuu: true, origen: "stack" },
  { id: "qwen/qwen3.7-flash", etiqueta: "Qwen 3.7 Flash", params: base({ reasoningEffort: "none" }), routing: ruta(), roles: ["enrutador", "juez_espanol", "redactor_reporte"], fases: [...PILOTO_BARRIDO, "bakeoff"], precio: { entrada: 0.03, salida: 0.13 }, hostEeuu: false, origen: "stack", nota: "Hoy solo lo sirve Alibaba (sin host de EE.UU.): con la regla de produccion no es elegible; en el eval solo ve datos sinteticos." },
  { id: "qwen/qwen3-235b-a22b-2507", etiqueta: "Qwen3-235B-A22B", params: base(), routing: ruta(["deepinfra", "parasail", "gmicloud", "google-vertex"]), roles: ["analista_datos", "respaldo"], fases: PILOTO_BARRIDO, precio: { entrada: 0.0875, salida: 0.35 }, hostEeuu: true, origen: "stack" },
  { id: "mistralai/mistral-small-3.2-24b-instruct", etiqueta: "Mistral Small 3.2", params: base(), routing: ruta(["deepinfra", "parasail"]), roles: ["respaldo"], fases: PILOTO_BARRIDO, precio: { entrada: 0.09375, salida: 0.25 }, hostEeuu: true, origen: "stack" },
  { id: "meta-llama/llama-4-maverick", etiqueta: "Llama 4 Maverick", params: base(), routing: ruta(["parasail", "google-vertex", "digitalocean"]), roles: ["respaldo"], fases: PILOTO_BARRIDO, precio: { entrada: 0.1875, salida: 0.6525 }, hostEeuu: true, origen: "stack" },
  // ---- calibracion: SOLO piloto ----
  { id: "anthropic/claude-haiku-4.5", etiqueta: "Claude Haiku 4.5", params: base(), routing: ruta(["anthropic", "amazon-bedrock", "google-vertex", "azure"]), roles: ["calibracion"], fases: SOLO_PILOTO, precio: { entrada: 1, salida: 5 }, hostEeuu: true, origen: "stack", nota: "Calibracion (referencia BFCL): nunca finalista." },
  { id: "x-ai/grok-4.3", etiqueta: "Grok 4.3", params: base(), routing: ruta(["xai"]), roles: ["calibracion"], fases: SOLO_PILOTO, precio: { entrada: 1.25, salida: 2.5 }, hostEeuu: true, origen: "stack", nota: "Calibracion: nunca finalista." },
  // ---- CFO/superadmin: solo sobre el subconjunto CFO ----
  { id: "anthropic/claude-sonnet-5.5", etiqueta: "Claude Sonnet 5.5 (medium)", params: base({ temperature: "omit", reasoningEffort: "medium", minMaxTokens: 3000 }), routing: ruta(["anthropic", "google-vertex", "amazon-bedrock"]), roles: ["cfo_superadmin", "analista_datos"], fases: ["cfo", "bakeoff"], precio: { entrada: 2, salida: 10 }, hostEeuu: true, origen: "stack", nota: "Solo subconjunto CFO/superadmin y analista del bake-off; jamas juez." },
  { id: "google/gemini-3.8-flash", etiqueta: "Gemini 3.8 Flash", params: base({ temperature: "omit", reasoningEffort: "low", minMaxTokens: 4000 }), routing: ruta(["google-ai-studio", "google-vertex"]), roles: ["redactor_reporte"], fases: ["bakeoff"], precio: { entrada: 0.75, salida: 3.75 }, hostEeuu: true, origen: "stack", nota: "Precio x2 el 1-ene-2027." },
  // ---- lista de baratos (work/eval-candidatos-baratos.md) que no estan arriba ----
  { id: "openai/gpt-5-nano", etiqueta: "GPT-5 nano", params: base({ temperature: "omit" }), routing: ruta(["openai", "azure"]), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.05, salida: 0.4 }, hostEeuu: true, origen: "baratos" },
  { id: "google/gemini-2.5-flash", etiqueta: "Gemini 2.5 Flash", params: base(), routing: ruta(["google-vertex", "google-ai-studio"]), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.3, salida: 2.5 }, hostEeuu: true, origen: "baratos" },
  { id: "google/gemma-4-31b-it", etiqueta: "Gemma 4 31B", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.09, salida: 0.34 }, hostEeuu: false, origen: "baratos", nota: "Sin lista `only` verificada: solo la politica ZDR/deny filtra el host." },
  { id: "deepseek/deepseek-v4-flash", etiqueta: "DeepSeek V4 Flash", params: base(), routing: ruta(["deepinfra", "together", "fireworks", "baseten", "parasail"]), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.04186, salida: 0.08372 }, hostEeuu: true, origen: "baratos" },
  { id: "z-ai/glm-5.3-flash", etiqueta: "GLM-5.3 Flash", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.15, salida: 0.5 }, hostEeuu: false, origen: "baratos", nota: "Sin lista `only` verificada; EVAL_CHALLENGERS pide hosts de EE.UU. (Together) y ZDR." },
  { id: "z-ai/glm-4.7-flash", etiqueta: "GLM-4.7 Flash", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.061, salida: 0.4 }, hostEeuu: false, origen: "baratos" },
  { id: "qwen/qwen3.5-flash-02-23", etiqueta: "Qwen 3.5 Flash", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.065, salida: 0.26 }, hostEeuu: false, origen: "baratos" },
  { id: "nvidia/nemotron-3-super-120b-a12b", etiqueta: "Nemotron 3 Super", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.08, salida: 0.45 }, hostEeuu: false, origen: "baratos" },
  { id: "meta-llama/llama-3.3-70b-instruct", etiqueta: "Llama 3.3 70B", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.1, salida: 0.32 }, hostEeuu: false, origen: "baratos" },
  { id: "meta-llama/llama-4-scout", etiqueta: "Llama 4 Scout", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.1, salida: 0.3 }, hostEeuu: false, origen: "baratos" },
  { id: "bytedance-seed/seed-2.0-mini", etiqueta: "Seed 2.0 mini", params: base(), routing: ruta(), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.1, salida: 0.4 }, hostEeuu: false, origen: "baratos" },
  { id: "google/gemini-3.5-flash-lite", etiqueta: "Gemini 3.5 Flash-Lite (minimal)", params: base({ temperature: "omit", reasoningEffort: "minimal" }), routing: ruta(["google-vertex", "google-ai-studio"]), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.3, salida: 2.5 }, hostEeuu: true, origen: "baratos" },
  { id: "openai/gpt-4.1-nano", etiqueta: "GPT-4.1 nano", params: base(), routing: ruta(["openai", "azure"]), roles: ["respaldo"], fases: SOLO_PILOTO, precio: { entrada: 0.1, salida: 0.4 }, hostEeuu: true, origen: "baratos" },
];

export function candidatoPorId(id: string): ModeloCandidato | undefined {
  return CANDIDATOS.find((c) => c.id === id);
}

export function candidatosDeFase(fase: FaseEval): readonly ModeloCandidato[] {
  return CANDIDATOS.filter((c) => c.fases.includes(fase));
}

/** Tokens por caso con los que se proyecta el gasto (mismo supuesto de work/eval-candidatos-baratos.md). */
export const TOKENS_ENTRADA_POR_CASO = 8_000;
export const TOKENS_SALIDA_POR_CASO = 900;

/** Proyeccion de gasto en USD de correr `casos` x `k` con un modelo (solo planeacion; el gasto real sale de usage.cost). */
export function proyectarCostoUsd(m: Pick<ModeloCandidato, "precio">, casos: number, k: number): number {
  const porCaso = (TOKENS_ENTRADA_POR_CASO * m.precio.entrada + TOKENS_SALIDA_POR_CASO * m.precio.salida) / 1_000_000;
  return Math.round(porCaso * casos * k * 1000) / 1000;
}

/** Cadena del juez de espanol barato (Qwen 3.7 Flash). NUNCA Sonnet. Se prueba en orden y gana la primera ruta
 *  que responda: (1) Qwen con la politica estricta EE.UU./ZDR; (2) Qwen sin ZDR/solo-EE.UU. (hoy lo sirve solo un
 *  host fuera de EE.UU.): SOLO porque el juez lee texto de respuestas sobre datos SINTETICOS del eval, nunca datos
 *  de un cliente; (3) Gemini 2.5 Flash-Lite estricto (EE.UU.). El reporte dice cual ruta uso. */
export const JUEZ_ESPANOL_CADENA: readonly { readonly id: string; readonly etiqueta: string; readonly params: OpenRouterModelParams; readonly routing: OpenRouterRouting }[] = [
  { id: "qwen/qwen3.7-flash", etiqueta: "Qwen 3.7 Flash (estricto EE.UU./ZDR)", params: base({ reasoningEffort: "none" }), routing: ruta() },
  { id: "qwen/qwen3.7-flash", etiqueta: "Qwen 3.7 Flash (solo datos sinteticos)", params: base({ reasoningEffort: "none" }), routing: { dataCollection: "deny", requireParameters: true, allowFallbacks: false } },
  { id: "google/gemini-2.5-flash-lite", etiqueta: "Gemini 2.5 Flash-Lite (estricto EE.UU./ZDR)", params: base(), routing: ruta(["google-vertex", "google-ai-studio"]) },
];
