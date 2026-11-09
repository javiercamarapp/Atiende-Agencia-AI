// Tabla ROL -> MODELOS del LlmGateway (todos pasan por OpenRouter). Versionada en el repo, con
// valores por defecto SEGUROS y baratos, y sobreescribible SIN redeploy de codigo mediante la
// variable de entorno LLM_MODELS_JSON (cambiar una variable en Vercel y redeploy de configuracion).
// Ver docs/LLM-GATEWAY.md para la tabla completa, como cambiar un modelo y la privacidad.
//
// Reglas de este archivo:
//   * MODELOS POR ACTIVIDAD (6-nov-2026, decision de Omar): cada uso del LLM pertenece a una actividad (`ACTIVIDADES_LLM`) con su ruta
//     principal -> respaldo elegida por calidad/precio PARA ESA ACTIVIDAD; `ACTIVIDAD_POR_ROL` mapea cada rol del gateway a su actividad y
//     `DEFAULT_ROLE_ROUTES` se deriva de ahi (fuente unica de verdad).
//   * RETENCION CERO OBLIGATORIA, FALLA CERRADA: todas las superficies tocan datos de clientes u organizaciones, asi que todo escalon sale con
//     `provider.zdr: true`, `only` = proveedores de EE.UU. (`ALLOWED_PROVIDER_HOSTS`) que hoy sirven el endpoint ZDR del modelo
//     (`VERIFIED_MODEL_HOSTS`, verificado en https://openrouter.ai/api/v1/endpoints/zdr), `data_collection: 'deny'` y `require_parameters`.
//     Un modelo fuera del registro, sin endpoint ZDR o sin proveedor de EE.UU. se rechaza al validar (y si OpenRouter no encuentra endpoint
//     ZDR responde 404: el escalon falla, nunca se relaja la politica). Politica de PROVEEDORES, no de autores (2-oct-2026, Javier).
//   * SOLO MODELOS BARATOS (regla del dueno, 2-nov-2026): nada de Opus/Sonnet/Sol/Argon; tope de precio `PRECIO_MAXIMO_USD_POR_M`.
//   * LLM_MODELS_JSON solo puede ESTRECHAR los proveedores de un modelo del registro: nunca ampliarlos, quitarlos, apagar el ZDR ni relajar
//     la privacidad. El gateway NUNCA cae a un modelo no listado: una variable mal formada se ignora (con un error estructurado en logs).
//   * Parametros por modelo: los endpoints ZDR de GPT-6 Luna, Claude Haiku 5.5 y los Gemini 3.x NO listan `temperature` entre los parametros
//     soportados; con `require_parameters: true` mandarla deja la ruta sin endpoints, asi que se omite ('omit') en todos los defaults.
import { lookupModelPrice, type OpenRouterModelParams, type OpenRouterRouting } from "@atiende/agent-core";
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
/** Alta autoservicio: extraccion del menu (PDF o foto) a un borrador de productos/precios que el dueño revisa antes de guardar
 *  (llamador: apps/api/src/routes/verticals/restaurantes/admin-menu-importar.ts). Entrada de imagen/PDF: actividad `extraccion_menu`. */
export const RESTAURANTES_EXTRACCION_MENU_ROLE = "restaurantes:extraccion_menu";
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

/** REGISTRO UNICO de modelos (de CUALQUIER laboratorio) con los proveedores de EE.UU. que hoy sirven su endpoint de RETENCION CERO.
 *  Fuente: https://openrouter.ai/api/v1/endpoints/zdr cruzado con https://openrouter.ai/api/v1/models/<id>/endpoints, leido el
 *  2026-11-06 (antes 2026-10-01). Un modelo que NO esta aqui con `zdr: true` y `hosts` no vacio NO se puede usar en ninguna superficie
 *  (todas tocan datos de clientes u organizaciones): se rechaza al validar, falla cerrado. Ya no hay proveedores "por autor".
 *  Re-verificar con `node scripts/check-llm-us-hosts.mjs` antes de cambiar una fila. */
export const VERIFIED_MODEL_HOSTS: Readonly<Record<string, VerifiedModelHosts>> = {
  "openai/gpt-6-luna": {
    hosts: ["azure"],
    zdr: true,
    note: "GPT-6 Luna: el UNICO endpoint ZDR es Azure (azure, azure/us); el endpoint directo de OpenAI no tiene ZDR.",
  },
  "anthropic/claude-haiku-5.5": {
    hosts: ["google-vertex", "amazon-bedrock"],
    zdr: true,
    note: "Claude Haiku 5.5: Google Vertex (us/global) y Amazon Bedrock (us-east-1) con endpoint ZDR; el directo de Anthropic no aparece con ZDR.",
  },
  "google/gemini-3.5-flash-lite": {
    hosts: ["google-vertex"],
    zdr: true,
    note: "Gemini 3.5 Flash-Lite: Google Vertex (us/global) con endpoint ZDR; Google AI Studio no aparece con ZDR. Acepta audio, imagen y PDF.",
  },
  "google/gemini-3.1-flash-lite": {
    hosts: ["google-vertex"],
    zdr: true,
    note: "Gemini 3.1 Flash-Lite: Google Vertex (us/global) con endpoint ZDR. Acepta audio, imagen y PDF.",
  },
  "google/gemini-3.8-flash": {
    hosts: ["google-vertex"],
    zdr: true,
    note: "Gemini 3.8 Flash: Google Vertex (us/global) con endpoint ZDR; Google AI Studio no aparece con ZDR.",
  },
  "deepseek/deepseek-v4.1-flash": {
    hosts: ["deepinfra", "together", "fireworks", "baseten", "parasail", "coreweave"],
    zdr: true,
    note: "DeepSeek V4.1 Flash: 6 proveedores de EE.UU. con endpoint ZDR (DeepInfra, Together, Fireworks, Baseten, Parasail, CoreWeave); re-verificado el 6-nov-2026.",
  },
  "deepseek/deepseek-v4-pro": {
    hosts: ["deepinfra", "azure"],
    zdr: true,
    note: "DeepSeek V4 Pro: DeepInfra y Azure (azure/us) con endpoint ZDR (6-nov-2026: Parasail ya no aparece con ZDR para este modelo).",
  },
  "openai/gpt-oss-120b": {
    hosts: ["deepinfra", "baseten", "coreweave", "parasail", "groq"],
    zdr: true,
    note: "gpt-oss-120b: DeepInfra, Baseten, CoreWeave, Parasail y Groq con endpoint ZDR y herramientas (6-nov-2026). OpenAI y Azure NO lo sirven; Bedrock y Vertex no listan `tools`.",
  },
  "qwen/qwen3-235b-a22b-2507": {
    hosts: ["parasail", "deepinfra"],
    zdr: true,
    note: "Qwen3-235B-A22B-2507: Parasail y DeepInfra con endpoint ZDR (6-nov-2026: Google Vertex ya no aparece con ZDR).",
  },
  "xiaomi/mimo-v2.6-flash": {
    hosts: ["deepinfra"],
    zdr: true,
    note: "MiMo V2.6 Flash: DeepInfra con endpoint ZDR (6-nov-2026). Acepta audio e imagen.",
  },
  "anthropic/claude-sonnet-5.5": {
    hosts: [],
    zdr: false,
    note: "Claude Sonnet 5.5: tiene endpoint ZDR, pero es de gama premium y la regla del dueno es solo modelos baratos (ver `PRECIO_MAXIMO_USD_POR_M`). Rechazado.",
  },
  "google/gemini-2.5-flash-lite": {
    hosts: [],
    zdr: false,
    note: "Gemini 2.5 Flash-Lite: NINGUN endpoint con ZDR (6-nov-2026). Rechazado hasta que aparezca uno.",
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
    hosts: [],
    zdr: false,
    note: "Muse Spark 1.3: solo el endpoint de Meta (EE.UU.), SIN ZDR (6-nov-2026). Rechazado: todas las superficies tocan datos.",
  },
};

/** Tope de precio de la regla del dueno (2-nov-2026: "quiero baratos", nada de Opus/Sonnet/Argon): un modelo cuyo precio de lista
 *  (entrada + salida, USD por millon, `MODEL_PRICES` de agent-core) pase de este tope se rechaza en cualquier ruta. Tambien se rechaza un
 *  modelo SIN precio conocido (no se puede comprobar que sea barato). DeepSeek V4 Pro (1.91 + 3.83) y Gemini 3.8 Flash (0.75 + 3.75)
 *  quedan debajo; Sonnet 5.5 (2 + 10) y GPT-6 Sol (1 + 5 = 6, gama "sol") quedan fuera por precio o por gama. */
export const PRECIO_MAXIMO_USD_POR_M = 6;
/** Gamas premium prohibidas aunque su precio bajara (defensa en profundidad de la regla del dueno). */
export const GAMAS_PREMIUM = /(^|\/)(claude-(opus|sonnet)|gpt-[0-9.]+-(sol|astra|terra)|gemini-[0-9.]+-(pro|argon|ultra)|o[0-9]+-pro)/;

/** Motivo por el que un modelo no cumple la regla de "solo baratos", o `null` si la cumple. */
export function motivoNoBarato(model: string): string | null {
  if (GAMAS_PREMIUM.test(model)) return `"${model}" es de gama premium (regla del dueno: solo modelos baratos)`;
  const precio = lookupModelPrice(model);
  if (!precio) return `"${model}" no tiene precio de lista en MODEL_PRICES: no se puede comprobar que sea barato`;
  if (precio.inPerM + precio.outPerM > PRECIO_MAXIMO_USD_POR_M) return `"${model}" cuesta ${precio.inPerM} + ${precio.outPerM} USD por millon (tope ${PRECIO_MAXIMO_USD_POR_M}; regla del dueno: solo modelos baratos)`;
  return null;
}

/** Proveedores permitidos de un modelo: los de su fila verificada con ZDR. `undefined` = el modelo no esta en el registro. */
export function defaultHostsForModel(model: string): readonly string[] | undefined {
  return VERIFIED_MODEL_HOSTS[model]?.hosts;
}

/** Modelos usables hoy: fila verificada con ZDR, al menos un proveedor y precio dentro del tope. */
export function modelosZdrBaratos(): readonly string[] {
  return Object.entries(VERIFIED_MODEL_HOSTS)
    .filter(([m, v]) => v.zdr && v.hosts.length > 0 && motivoNoBarato(m) === null)
    .map(([m]) => m);
}

/** Evalua un escalon contra la politica (ZDR obligatorio + EE.UU. + solo baratos). Devuelve los proveedores efectivos o el error (en espanol). */
export function resolveRungHosts(model: string, requestedOnly: readonly string[] | undefined): { hosts: readonly string[] } | { error: string } {
  const verified = VERIFIED_MODEL_HOSTS[model];
  if (!verified) {
    return { error: `"${model}" no esta en el registro de modelos con retencion cero verificada (VERIFIED_MODEL_HOSTS): no se puede usar en produccion (todas las superficies tocan datos)` };
  }
  if (!verified.zdr || verified.hosts.length === 0) {
    return { error: `"${model}" no tiene hoy un proveedor con servidores en EE.UU. y retencion cero verificado (${verified.note}); no se puede usar en produccion` };
  }
  const caro = motivoNoBarato(model);
  if (caro) return { error: caro };
  const base = verified.hosts;
  const outsideAllowlist = (requestedOnly ?? []).filter((h) => !ALLOWED_PROVIDER_HOSTS.includes(h));
  if (outsideAllowlist.length > 0) {
    return { error: `"only" incluye proveedores fuera de la lista permitida de EE.UU.: ${outsideAllowlist.join(", ")}` };
  }
  if (!requestedOnly || requestedOnly.length === 0) return { hosts: base };
  const notVerified = requestedOnly.filter((h) => !base.includes(h));
  if (notVerified.length > 0) {
    return { error: `"only" incluye proveedores que no estan verificados para "${model}": ${notVerified.join(", ")} (verificados: ${base.join(", ")})` };
  }
  return { hosts: requestedOnly };
}

// ---- Escalones (un modelo con sus parametros) ----
// Temperatura 'omit' en todos: Luna, Haiku 5.5 y los Gemini 3.x no listan `temperature` en sus endpoints ZDR y, con `require_parameters`,
// mandarla deja la ruta sin endpoints.
const LUNA_LOW: LlmRungConfig = { model: "openai/gpt-6-luna", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const LUNA_HIGH: LlmRungConfig = { ...LUNA_LOW, reasoningEffort: "high", minMaxTokens: 3000 };
const HAIKU_55: LlmRungConfig = { model: "anthropic/claude-haiku-5.5", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const DEEPSEEK_FLASH: LlmRungConfig = { model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500, supportsStructuredOutput: true };
const GEMINI_38_FLASH: LlmRungConfig = { model: "google/gemini-3.8-flash", reasoningEffort: "low", temperature: "omit", minMaxTokens: 4000, supportsStructuredOutput: true };
const FLASH_LITE_35: LlmRungConfig = { model: "google/gemini-3.5-flash-lite", temperature: "omit", minMaxTokens: 1000, supportsStructuredOutput: true };
const FLASH_LITE_31: LlmRungConfig = { model: "google/gemini-3.1-flash-lite", temperature: "omit", minMaxTokens: 1000, supportsStructuredOutput: true };

/** Escalon para un modelo ELEGIDO por una organizacion de restaurantes (lista permitida `MODELOS_AGENTE` de domain-restaurantes): los mismos
 *  parametros de razonamiento/tokens que el escalon por defecto del modelo, pero con la temperatura HABILITADA solo si el modelo la admite
 *  (`aceptaTemperatura`) y 'omit' si no (con `require_parameters` mandarla a Luna o Haiku deja la ruta sin endpoints). Sin `temperature` el
 *  escalon usa la de la peticion. `undefined` = el id no esta en la lista. */
const BASE_RUNG_MODELO_AGENTE: Readonly<Record<string, LlmRungConfig>> = {
  [LUNA_LOW.model]: LUNA_LOW,
  [HAIKU_55.model]: HAIKU_55,
  [DEEPSEEK_FLASH.model]: DEEPSEEK_FLASH,
  [FLASH_LITE_35.model]: FLASH_LITE_35,
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

// ---- Modelos por ACTIVIDAD (fuente unica de verdad) ----
// Cada uso del LLM pertenece a una actividad; cada actividad tiene UNA ruta (principal -> respaldo) elegida por calidad/precio para esa
// actividad, medida en el bake-off del 6-nov-2026 (MODELOS-POR-ACTIVIDAD-NOV.md fuera del repo; resumen en docs/LLM-GATEWAY.md). Todas
// las actividades tocan datos de clientes u organizaciones: todos los escalones son modelos del registro ZDR y baratos (un test lo exige).
// Los roles del gateway se mapean a su actividad en `ACTIVIDAD_POR_ROL`; `DEFAULT_ROLE_ROUTES` se DERIVA de aqui.

export type ActividadLlm =
  | "whatsapp_agente"
  | "whatsapp_agente_escalado"
  | "datos_preguntas"
  | "datos_reintento_cifras"
  | "copiloto_superadmin"
  | "reporte_analisis_financiero"
  | "reporte_analisis_general"
  | "reporte_redaccion"
  | "resumen_diario"
  | "tareas_cortas"
  | "transcripcion_audio"
  | "extraccion_documentos"
  | "extraccion_menu"
  | "borradores"
  | "conciliacion"
  | "demo_publica";

export type ModalidadLlm = "texto" | "texto_herramientas" | "audio" | "imagen_pdf";

export interface ActividadLlmConfig {
  readonly descripcion: string;
  readonly modalidad: ModalidadLlm;
  /** Quien decidio la ruta: "dueno" = decision explicita de Omar (no la cambia un eval), "medicion" = bake-off, "precio" = sin eval propio. */
  readonly decision: "dueno" | "medicion" | "precio";
  readonly route: LlmRouteConfig;
}

const ruta = (...models: LlmRungConfig[]): LlmRouteConfig => ({ models, routing: { allowFallbacks: true } });

export const ACTIVIDADES_LLM: Readonly<Record<ActividadLlm, ActividadLlmConfig>> = {
  whatsapp_agente: { descripcion: "Agente de WhatsApp (pedidos, reservas, citas): conversacion con herramientas", modalidad: "texto_herramientas", decision: "dueno", route: ruta(LUNA_LOW, HAIKU_55) },
  whatsapp_agente_escalado: { descripcion: "Agente de WhatsApp tras una falla de herramienta (escalado)", modalidad: "texto_herramientas", decision: "dueno", route: ruta(LUNA_LOW, HAIKU_55) },
  // Bake-off 6-nov (30 preguntas del arnes del Copiloto, 6 verticales): Luna 76.7 % a US$0.00019/pregunta, Gemini 3.5 Flash-Lite 83.3 % (p95 2.4 s),
  // Haiku 5.5 70 %; DeepSeek V4.1 Flash 73.3 % con p95 9 s y DeepSeek V4 Pro 62.1 % con 7 cifras inventadas a 13x el costo de Luna.
  datos_preguntas: { descripcion: "Preguntale a tus datos (6 verticales): elegir consulta del catalogo y narrar cifras", modalidad: "texto_herramientas", decision: "medicion", route: ruta(LUNA_LOW, FLASH_LITE_35, HAIKU_55) },
  // El reintento usa OTRO modelo que el primario (Luna): el mas exacto del bake-off. DeepSeek V4 Pro salio el peor (62 %, 7 cifras inventadas).
  datos_reintento_cifras: { descripcion: "Reintento unico cuando la guardia de cifras rechaza la narrativa", modalidad: "texto_herramientas", decision: "medicion", route: ruta({ ...FLASH_LITE_35, minMaxTokens: 3000 }, { ...HAIKU_55, minMaxTokens: 3000 }) },
  // Antes Sonnet 5.5 -> DeepSeek V4 Pro (premium y el peor en cifras). Mismo motor que el chat de datos: misma ruta medida, con mas piso de tokens.
  copiloto_superadmin: { descripcion: "Copiloto de superadmin/CFO (multi-organizacion): preguntas de datos, resumenes y reportes", modalidad: "texto_herramientas", decision: "medicion", route: ruta({ ...LUNA_LOW, minMaxTokens: 3000 }, { ...FLASH_LITE_35, minMaxTokens: 3000 }, { ...HAIKU_55, minMaxTokens: 3000 }) },
  reporte_analisis_financiero: { descripcion: "Reportes: etapa de analisis de datos financieros", modalidad: "texto", decision: "precio", route: ruta(LUNA_HIGH, { ...FLASH_LITE_35, minMaxTokens: 3000 }) },
  reporte_analisis_general: { descripcion: "Reportes: etapa de analisis de datos no financieros", modalidad: "texto", decision: "precio", route: ruta({ ...LUNA_LOW, minMaxTokens: 3000 }, { ...FLASH_LITE_35, minMaxTokens: 3000 }) },
  reporte_redaccion: { descripcion: "Reportes: etapa de redaccion", modalidad: "texto", decision: "precio", route: ruta(GEMINI_38_FLASH, { ...LUNA_LOW, minMaxTokens: 4000 }) },
  resumen_diario: { descripcion: "Resumen diario de operacion para superadmin", modalidad: "texto", decision: "precio", route: ruta(GEMINI_38_FLASH, { ...LUNA_LOW, minMaxTokens: 4000 }) },
  tareas_cortas: { descripcion: "Clasificacion y tareas cortas: enrutador de turno, compuerta de escalamiento, titulos, compactacion", modalidad: "texto", decision: "precio", route: ruta(LUNA_LOW, FLASH_LITE_35) },
  // Bake-off 6-nov (10 notas sinteticas es-MX en m4a): Gemini 3.1 Flash-Lite WER 7.1 % (mediana 0), Gemini 3.5 Flash-Lite 10.0 %, ambos ~US$0.00017
  // por nota y p50 ~1.8-2.0 s; MiMo V2.6 Flash (DeepInfra) rechaza `input_audio` (422). Antes: Gemini 2.5 Flash-Lite, que NO tiene endpoint ZDR.
  transcripcion_audio: { descripcion: "Notas de voz de WhatsApp a texto", modalidad: "audio", decision: "medicion", route: ruta({ ...FLASH_LITE_31, minMaxTokens: 800 }, FLASH_LITE_35) },
  extraccion_documentos: { descripcion: "Extraccion de requisitos de bases de licitacion (texto extraido por pagina)", modalidad: "texto", decision: "precio", route: ruta(LUNA_LOW, DEEPSEEK_FLASH) },
  // Sin bake-off propio (decision "precio"): los dos modelos baratos con ZDR que aceptan imagen y PDF (`MODELOS_CON_IMAGEN_PDF`); salida
  // estructurada (json_schema) y piso de tokens alto porque un menu de 150 productos rebasa los 4 mil tokens de salida.
  extraccion_menu: { descripcion: "Alta de restaurante: menu en PDF o foto a borrador de productos y precios (lo revisa el dueño)", modalidad: "imagen_pdf", decision: "precio", route: ruta({ ...FLASH_LITE_35, minMaxTokens: 12000 }, { ...GEMINI_38_FLASH, minMaxTokens: 12000 }) },
  borradores: { descripcion: "Borradores (preguntas de junta, propuesta tecnica, mensajes de rentas)", modalidad: "texto_herramientas", decision: "precio", route: ruta(LUNA_LOW, HAIKU_55) },
  conciliacion: { descripcion: "Conciliacion bancaria de despachos: sugerir coincidencias", modalidad: "texto_herramientas", decision: "precio", route: ruta(LUNA_LOW, HAIKU_55) },
  demo_publica: { descripcion: "Demo publica del sitio (chat sin herramientas)", modalidad: "texto", decision: "precio", route: ruta(LUNA_LOW, HAIKU_55) },
};

/** Rol del gateway -> actividad. Clave exacta o "*:sufijo". Un test exige que TODOS los roles de produccion (y los de gateways dedicados)
 *  tengan actividad explicita: ninguno cae a un default implicito. */
export const ACTIVIDAD_POR_ROL: Readonly<Record<string, ActividadLlm>> = {
  "*:whatsapp_agent": "whatsapp_agente",
  "*:whatsapp_agent_escalated": "whatsapp_agente_escalado",
  "*:data_chat": "datos_preguntas",
  [`*:${DATA_CHAT_RETRY_SUFFIX}`]: "datos_reintento_cifras",
  [SUPERADMIN_COPILOTO_ROLE]: "copiloto_superadmin",
  [REPORTE_ANALISIS_FINANCIERO_ROLE]: "reporte_analisis_financiero",
  [REPORTE_ANALISIS_GENERAL_ROLE]: "reporte_analisis_general",
  [REPORTE_REDACCION_FINANCIERO_ROLE]: "reporte_redaccion",
  [REPORTE_REDACCION_GENERAL_ROLE]: "reporte_redaccion",
  "plataforma:resumen_diario": "resumen_diario",
  // CFO de la plataforma: el modelo solo explica y prioriza hechos ya calculados (apps/api/src/cfo/recomendaciones.ts).
  "plataforma:recomendaciones_cfo": "reporte_analisis_financiero",
  [ENRUTADOR_TURNO_ROLE]: "tareas_cortas",
  [COMPUERTA_ESCALAMIENTO_ROLE]: "tareas_cortas",
  [TITULOS_RESUMENES_ROLE]: "tareas_cortas",
  [COMPACTACION_HISTORIAL_ROLE]: "tareas_cortas",
  [RESTAURANTES_TRANSCRIPCION_ROLE]: "transcripcion_audio",
  [RESTAURANTES_EXTRACCION_MENU_ROLE]: "extraccion_menu",
  "licitaciones:requirement_extractor": "extraccion_documentos",
  "licitaciones:junta_question_agent": "borradores",
  "licitaciones:proposal_draft_agent": "borradores",
  "rentas:mensajeria_agent": "borradores",
  "despachos:conciliacion_llm_agent": "conciliacion",
  "plataforma:demo_publica": "demo_publica",
};

/** Modelos con entrada de AUDIO verificada (`architecture.input_modalities` de OpenRouter, 6-nov-2026) y que la aceptan por la API de chat
 *  (`input_audio`): una actividad de modalidad "audio" solo puede usar estos. MiMo V2.6 Flash lista audio pero DeepInfra rechaza `input_audio` (422). */
export const MODELOS_CON_AUDIO: ReadonlySet<string> = new Set(["google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite", "google/gemini-3.8-flash"]);

/** Modelos con entrada de IMAGEN y PDF verificada (`architecture.input_modalities` de OpenRouter, notas de `VERIFIED_MODEL_HOSTS`): una
 *  actividad de modalidad "imagen_pdf" solo puede usar estos. MiMo V2.6 Flash acepta imagen pero no PDF: fuera. */
export const MODELOS_CON_IMAGEN_PDF: ReadonlySet<string> = new Set(["google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite", "google/gemini-3.8-flash"]);

/** Actividad de un rol: clave exacta > "*:sufijo". `undefined` = rol sin actividad declarada (usa `DEFAULT_ROUTE`). */
export function actividadDeRol(role: string): ActividadLlm | undefined {
  const suffix = role.includes(":") ? role.slice(role.indexOf(":") + 1) : role;
  return ACTIVIDAD_POR_ROL[role] ?? ACTIVIDAD_POR_ROL[`*:${suffix}`];
}

/** Perfil por rol, DERIVADO de `ACTIVIDAD_POR_ROL` + `ACTIVIDADES_LLM`. */
export const DEFAULT_ROLE_ROUTES: Readonly<Record<string, LlmRouteConfig>> = Object.fromEntries(
  Object.entries(ACTIVIDAD_POR_ROL).map(([rol, actividad]) => [rol, ACTIVIDADES_LLM[actividad].route]),
);

/** Rol sin actividad declarada (no deberia existir; un test lo impide para los roles de produccion): la ruta de chat barata. */
export const DEFAULT_ROUTE: LlmRouteConfig = ruta(LUNA_LOW, FLASH_LITE_35, HAIKU_55);

/** Retadores SOLO para el arnes de evals (MOD-07/08). Apagados: nada en produccion los lee. */
export const EVAL_CHALLENGERS: readonly (LlmRungConfig & { readonly enabled: false; readonly note: string })[] = [
  { model: "z-ai/glm-5.3-flash", enabled: false, note: "Retador de evals; no esta en el registro ZDR de `VERIFIED_MODEL_HOSTS`: no se puede usar en produccion." },
  { model: "qwen/qwen3.7-flash", enabled: false, note: "Candidato a enrutador/redactor; hoy solo lo sirve Alibaba (sin EE.UU./ZDR), rechazado en produccion hasta que cambie." },
];

/** Enrutamiento efectivo de un escalon: la politica SIEMPRE se aplica y FALLA CERRADA: `only` = proveedores de EE.UU. con endpoint ZDR del
 *  registro, `data_collection: 'deny'`, `require_parameters` y `zdr: true` en TODAS las rutas (todas las superficies tocan datos), sin importar
 *  `OPENROUTER_ZDR` ni lo que traiga la ruta. Si OpenRouter no tiene un endpoint ZDR disponible responde 404 y el escalon falla (no se relaja).
 *  Lanza si el escalon no cumple la politica (los defaults los cubre un test; LLM_MODELS_JSON se valida antes). `_globalZdr` se conserva por
 *  compatibilidad de firma: ya no puede apagar el ZDR. */
export function routingForModel(route: LlmRouteConfig, model: string, _globalZdr: boolean): OpenRouterRouting {
  const base = route.routing ?? {};
  const resolved = resolveRungHosts(model, base.only);
  if ("error" in resolved) throw new Error(`routing invalido para ${model}: ${resolved.error}`);
  const order = base.order?.filter((h) => resolved.hosts.includes(h));
  return {
    ...base,
    only: resolved.hosts,
    order: order && order.length > 0 ? order : undefined,
    dataCollection: "deny",
    requireParameters: true,
    zdr: true,
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
  if (raw.zdr !== undefined) {
    // Retencion cero obligatoria en todas las superficies: no se puede apagar por configuracion.
    if (raw.zdr === true) out.zdr = true;
    else errors.push(`${where}: "zdr" solo puede ser true (retencion cero obligatoria: todas las superficies tocan datos)`);
  }
  if (raw.allowFallbacks !== undefined) {
    if (typeof raw.allowFallbacks === "boolean") out.allowFallbacks = raw.allowFallbacks;
    else errors.push(`${where}: "allowFallbacks" debe ser booleano`);
  }
  if (raw.sort !== undefined) {
    if (raw.sort === "price" || raw.sort === "latency" || raw.sort === "throughput") out.sort = raw.sort;
    else errors.push(`${where}: "sort" debe ser "price", "latency" o "throughput" (solo reordena los proveedores permitidos; no los amplia)`);
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
    // Decisiones del dueno (WhatsApp): no se sobreescriben por variable de entorno, ni con clave exacta ni con "*:sufijo".
    const actividad = actividadDeRol(key);
    if (actividad && ACTIVIDADES_LLM[actividad].decision === "dueno") {
      errors.push(`${where}: la actividad "${actividad}" es decision del dueno (${ACTIVIDADES_LLM[actividad].route.models.map((m) => m.model).join(" -> ")}); LLM_MODELS_JSON no la cambia`);
    }
    // Una actividad de audio solo acepta modelos con entrada de audio.
    if (actividad && ACTIVIDADES_LLM[actividad].modalidad === "audio") {
      models.forEach((m, i) => {
        if (m && !MODELOS_CON_AUDIO.has(m.model)) errors.push(`${where}.models[${i}]: "${m.model}" no acepta audio (actividad "${actividad}")`);
      });
    }
    if (errors.length > before || models.some((m) => m === null)) continue;
    roles[key] = { models: models as LlmRungConfig[], ...(routing ? { routing } : {}) };
  }
  return { config: { roles }, errors };
}

/** Resuelve la ruta de un rol: clave exacta > "*:sufijo" > "*" (de LLM_MODELS_JSON) > defaults versionados
 *  (clave exacta > "*:sufijo") > perfil economico. Dos candados sobre LLM_MODELS_JSON (incluido el comodin "*"):
 *  - una actividad con `decision: "dueno"` (WhatsApp) NUNCA toma una ruta de la variable;
 *  - una actividad de audio solo toma una ruta de la variable si TODOS sus modelos aceptan audio (`MODELOS_CON_AUDIO`). */
export function resolveRoleRoute(role: string, overrides: LlmModelsConfig | undefined): LlmRouteConfig {
  const o = overrides?.roles ?? {};
  const suffix = role.includes(":") ? role.slice(role.indexOf(":") + 1) : role;
  const actividad = actividadDeRol(role);
  const cfg = actividad ? ACTIVIDADES_LLM[actividad] : undefined;
  const candidatos = cfg?.decision === "dueno" ? [] : [o[role], o[`*:${suffix}`], o["*"]];
  const override = candidatos.find((r): r is LlmRouteConfig => r !== undefined && (cfg?.modalidad !== "audio" || r.models.every((m) => MODELOS_CON_AUDIO.has(m.model))));
  return override ?? DEFAULT_ROLE_ROUTES[role] ?? DEFAULT_ROLE_ROUTES[`*:${suffix}`] ?? DEFAULT_ROUTE;
}
