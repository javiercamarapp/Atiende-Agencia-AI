// Modelos de TEXTO que una organizacion de restaurantes puede elegir para su agente de WhatsApp y para la cascada de voz (el respaldo de
// Gemini Live). Equivale a lo que el original dejaba elegir (modelo y temperatura) pero sobre la arquitectura vigente: el gateway LLM unico
// (OpenRouter) con su politica de proveedores de EE.UU., su presupuesto y su interruptor de plataforma.
//
// LISTA PERMITIDA (cerrada): solo estos ids. Un id fuera de la lista se rechaza al guardar y el gateway tambien lo ignora si llegara a la base
// por otra via. Agregar un modelo es un cambio de codigo revisado: requiere (1) fila en `MODEL_PRICES` (agent-core), (2) proveedores de EE.UU.
// verificados (`apps/api/src/production/llm-models.ts`) y (3) una fila aqui. Un test en la API verifica las tres cosas para cada id.
//
// `aceptaTemperatura` sale de `supported_parameters` de los endpoints ZDR PERMITIDOS de OpenRouter (/api/v1/endpoints/zdr), leido el 6-nov-2026:
// deepseek-v4.1-flash la acepta; gpt-6-luna, claude-haiku-5.5 y gemini-3.5-flash-lite NO (con `require_parameters` mandarla deja la ruta sin
// endpoints). Para esos la pantalla dice "este modelo no admite temperatura" en vez de ofrecer un control que no hace nada.
//
// MODELOS POR ACTIVIDAD (6-nov-2026): la lista solo tiene modelos BARATOS con endpoint de RETENCION CERO (ZDR) en proveedores de EE.UU.; se
// quitaron Claude Sonnet 5.5 (premium), Gemini 2.5 Flash-Lite y Muse Spark 1.3 (sin endpoint ZDR) y Gemini 3.8 Flash (gama media: solo reportes).
// La base acota los mismos ids con un CHECK (migracion 104_modelos_agente_zdr_baratos): cambiar esta lista exige una migracion nueva en el MISMO PR.
import { lookupModelPrice } from "@atiende/agent-core";

export type NivelModeloAgente = "economico" | "equilibrado" | "premium";

export interface ModeloAgente {
  /** Id de OpenRouter, "autor/modelo". */
  readonly id: string;
  readonly etiqueta: string;
  readonly nivel: NivelModeloAgente;
  readonly descripcion: string;
  readonly aceptaTemperatura: boolean;
  /** Es el primer escalon de la plataforma (lo que corre si la organizacion no elige nada). */
  readonly predeterminado: boolean;
  /** Tiene endpoint de RETENCION CERO en OpenRouter entre los proveedores de voz permitidos (Vertex, Bedrock, Azure): solo estos sirven para la voz, que se
   * enruta con `provider.zdr` (sin endpoint ZDR cada turno da 404). Leido de /api/v1/endpoints/zdr el 6-nov-2026. */
  readonly vozZdr: boolean;
}

export const MODELOS_AGENTE: readonly ModeloAgente[] = Object.freeze([
  // vozZdr (6-nov-2026, cruzado con VERIFIED_MODEL_HOSTS de apps/api y VOZ_PLATAFORMA.cascadaV2.llm.proveedoresZdr = Vertex/Bedrock/Azure): Luna (Azure),
  // Haiku 5.5 (Vertex/Bedrock) y Gemini 3.5 Flash-Lite (Vertex) si; DeepSeek V4.1 Flash NO: sus endpoints ZDR son DeepInfra/Together/Fireworks/
  // Baseten/Parasail/CoreWeave, fuera de los proveedores de voz, y cada turno daria 404 (`v2_llm_sin_zdr`). Sirve para WhatsApp, no para la voz.
  { id: "openai/gpt-6-luna", etiqueta: "GPT-6 Luna", nivel: "economico", descripcion: "El predeterminado de la plataforma: rapido y barato; sigue bien las reglas.", aceptaTemperatura: false, predeterminado: true, vozZdr: true },
  { id: "anthropic/claude-haiku-5.5", etiqueta: "Claude Haiku 5.5", nivel: "economico", descripcion: "El respaldo de Luna: buena comprension al mismo precio; con retencion cero.", aceptaTemperatura: false, predeterminado: false, vozZdr: true },
  { id: "deepseek/deepseek-v4.1-flash", etiqueta: "DeepSeek V4.1 Flash", nivel: "economico", descripcion: "Economico, servido solo desde proveedores de EE.UU. con retencion cero.", aceptaTemperatura: true, predeterminado: false, vozZdr: false },
  { id: "google/gemini-3.5-flash-lite", etiqueta: "Gemini 3.5 Flash-Lite", nivel: "economico", descripcion: "El rapido de la voz: baja latencia para turnos cortos.", aceptaTemperatura: false, predeterminado: false, vozZdr: true },
] satisfies readonly ModeloAgente[]);

/** Ids permitidos, en el mismo orden que el CHECK de la base (`restaurantes.agent_runtime_settings`, migracion 104). */
export const IDS_MODELOS_AGENTE: readonly string[] = Object.freeze(MODELOS_AGENTE.map((m) => m.id));

/** Ids que la cascada de VOZ acepta (`vozZdr`), en el mismo orden que el CHECK de `voice_cascade_model` (migracion 104). */
export const IDS_MODELOS_VOZ_AGENTE: readonly string[] = Object.freeze(MODELOS_AGENTE.filter((m) => m.vozZdr).map((m) => m.id));

export const MODELO_PREDETERMINADO_ID = "openai/gpt-6-luna";

/** El modelo sirve para la cascada de VOZ (lista permitida + endpoint ZDR). Se valida al guardar y otra vez al armar el contexto de la llamada (un valor viejo de la base no llega al worker). */
export function esModeloVozZdr(id: unknown): id is string {
  return typeof id === "string" && MODELOS_AGENTE.some((m) => m.id === id && m.vozZdr);
}

export function modeloAgentePorId(id: string | null | undefined): ModeloAgente | null {
  if (!id) return null;
  return MODELOS_AGENTE.find((m) => m.id === id) ?? null;
}

/**
 * Modelo ALTERNO para el reintento de una llamada que agoto su tope de tiempo (fallback de proveedor del turno de WhatsApp). Decision del dueno
 * (6-nov-2026): Luna principal y Claude Haiku 5.5 de respaldo, ambos con retencion cero. El alterno nunca es el mismo modelo que se atasco:
 * cualquier modelo -> Haiku 5.5; Haiku 5.5 -> Luna.
 */
export const MODELO_ALTERNO_TOPE_ID = "anthropic/claude-haiku-5.5";
export const MODELO_ALTERNO_SEGUNDO_TOPE_ID = "openai/gpt-6-luna";

export function modeloAlternoParaTope(primarioId: string | null | undefined): string {
  return primarioId === MODELO_ALTERNO_TOPE_ID ? MODELO_ALTERNO_SEGUNDO_TOPE_ID : MODELO_ALTERNO_TOPE_ID;
}

/**
 * El respaldo por tope de tiempo solo se activa cuando el modelo que se atasco es un modelo ECONOMICO de la lista (hoy todos lo son): el tope del primer
 * intento (>= 9 s) se calibro con su latencia (p99 ~8.3 s por llamada). Un modelo de otro nivel que se agregue a la lista tardaria mas de forma normal y un
 * tope de 11 s degradaria en silencio turnos que terminan bien a 11-18 s. Sin eleccion = el predeterminado.
 */
export function modeloAdmiteRespaldoPorTope(modeloId: string | null | undefined): boolean {
  if (!modeloId) return true;
  return modeloAgentePorId(modeloId)?.nivel === "economico";
}

/** Reduce lo que reporta el gateway (modelo del resultado o `providerId`, p.ej. "openrouter:openai/gpt-6-luna") a un id de la lista cerrada `MODELOS_AGENTE`, o "otro". Para telemetria sin PII. */
export function idModeloDeListaCerrada(...candidatos: ReadonlyArray<string | null | undefined>): string {
  for (const c of candidatos) {
    if (!c) continue;
    const limpio = c.startsWith("openrouter:") ? c.slice("openrouter:".length) : c;
    if (modeloAgentePorId(limpio)) return limpio;
  }
  return "otro";
}

export function esModeloAgentePermitido(id: unknown): id is string {
  return typeof id === "string" && modeloAgentePorId(id) !== null;
}

/** Uso al que se le estima el costo: un mensaje de WhatsApp (varias llamadas al modelo con herramientas) o un minuto de llamada en cascada. */
export type UsoCostoAgente = "whatsapp_mensaje" | "voz_cascada_minuto";

/**
 * SUPUESTOS de la estimacion (se muestran en la pantalla; no es una factura):
 *  - un mensaje de WhatsApp: ~2 llamadas al modelo con el prompt, el historial y las herramientas -> 6,000 tokens de entrada y 400 de salida;
 *  - un minuto de cascada de voz: ~4 turnos de ~3,000 tokens de entrada -> 12,000 de entrada y 500 de salida.
 * El costo real lo reporta OpenRouter por llamada y queda en el registro de uso; esto solo ayuda a comparar modelos.
 */
export const PERFIL_COSTO_AGENTE: Readonly<Record<UsoCostoAgente, { readonly tokensEntrada: number; readonly tokensSalida: number }>> = Object.freeze({
  whatsapp_mensaje: Object.freeze({ tokensEntrada: 6_000, tokensSalida: 400 }),
  voz_cascada_minuto: Object.freeze({ tokensEntrada: 12_000, tokensSalida: 500 }),
});

export interface CostoEstimadoModelo {
  readonly modeloId: string;
  readonly uso: UsoCostoAgente;
  /** Micro-USD (entero, redondeado hacia arriba: nunca subestima) por unidad de uso. null si el modelo no tiene precio de lista conocido. */
  readonly microUsdPorUnidad: number | null;
  /** Micro-USD por 1,000 unidades (mensajes o minutos). */
  readonly microUsdPorMil: number | null;
  readonly verificadoEn: string | null;
}

export function costoEstimadoModelo(modeloId: string, uso: UsoCostoAgente): CostoEstimadoModelo {
  const precio = lookupModelPrice(modeloId);
  if (!precio) return { modeloId, uso, microUsdPorUnidad: null, microUsdPorMil: null, verificadoEn: null };
  const perfil = PERFIL_COSTO_AGENTE[uso];
  // USD por millon de tokens == micro-USD por token.
  const porUnidad = Math.ceil(perfil.tokensEntrada * precio.inPerM + perfil.tokensSalida * precio.outPerM);
  return { modeloId, uso, microUsdPorUnidad: porUnidad, microUsdPorMil: porUnidad * 1000, verificadoEn: precio.verifiedAt };
}
