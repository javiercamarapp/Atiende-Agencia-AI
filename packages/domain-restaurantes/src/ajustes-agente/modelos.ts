// Modelos de TEXTO que una organizacion de restaurantes puede elegir para su agente de WhatsApp y para la cascada de voz (el respaldo de
// Gemini Live). Equivale a lo que el original dejaba elegir (modelo y temperatura) pero sobre la arquitectura vigente: el gateway LLM unico
// (OpenRouter) con su politica de proveedores de EE.UU., su presupuesto y su interruptor de plataforma.
//
// LISTA PERMITIDA (cerrada): solo estos ids. Un id fuera de la lista se rechaza al guardar y el gateway tambien lo ignora si llegara a la base
// por otra via. Agregar un modelo es un cambio de codigo revisado: requiere (1) fila en `MODEL_PRICES` (agent-core), (2) proveedores de EE.UU.
// verificados (`apps/api/src/production/llm-models.ts`) y (3) una fila aqui. Un test en la API verifica las tres cosas para cada id.
//
// `aceptaTemperatura` sale de `supported_parameters` de los endpoints PERMITIDOS de OpenRouter (/api/v1/models/<id>/endpoints), leido el
// 4-oct-2026: deepseek-v4.1-flash (DeepInfra, CoreWeave, BaseTen, Together, Parasail, Fireworks), gemini-2.5-flash-lite y gemini-3.8-flash
// (Google AI Studio) y muse-spark-1.3 (Meta) la aceptan; gpt-6-luna y claude-sonnet-5.5 NO (con `require_parameters` mandarla deja la ruta sin
// endpoints). Para esos dos la pantalla dice "este modelo no admite temperatura" en vez de ofrecer un control que no hace nada.
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
}

export const MODELOS_AGENTE: readonly ModeloAgente[] = Object.freeze([
  { id: "openai/gpt-6-luna", etiqueta: "GPT-6 Luna", nivel: "economico", descripcion: "El predeterminado de la plataforma: rapido y barato; sigue bien las reglas.", aceptaTemperatura: false, predeterminado: true },
  { id: "deepseek/deepseek-v4.1-flash", etiqueta: "DeepSeek V4.1 Flash", nivel: "economico", descripcion: "Economico, servido solo desde proveedores de EE.UU. con retencion cero.", aceptaTemperatura: true, predeterminado: false },
  { id: "google/gemini-2.5-flash-lite", etiqueta: "Gemini 2.5 Flash-Lite", nivel: "economico", descripcion: "El mas barato; respuestas cortas y directas.", aceptaTemperatura: true, predeterminado: false },
  { id: "meta/muse-spark-1.3", etiqueta: "Muse Spark 1.3", nivel: "equilibrado", descripcion: "Equilibrado entre costo y calidad de redaccion.", aceptaTemperatura: true, predeterminado: false },
  { id: "google/gemini-3.8-flash", etiqueta: "Gemini 3.8 Flash", nivel: "equilibrado", descripcion: "Mejor comprension de pedidos largos o ambiguos; cuesta mas que los economicos.", aceptaTemperatura: true, predeterminado: false },
  { id: "anthropic/claude-sonnet-5.5", etiqueta: "Claude Sonnet 5.5", nivel: "premium", descripcion: "El de mayor calidad y el mas caro; solo si el volumen es bajo.", aceptaTemperatura: false, predeterminado: false },
] satisfies readonly ModeloAgente[]);

export const MODELO_PREDETERMINADO_ID = "openai/gpt-6-luna";

export function modeloAgentePorId(id: string | null | undefined): ModeloAgente | null {
  if (!id) return null;
  return MODELOS_AGENTE.find((m) => m.id === id) ?? null;
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
