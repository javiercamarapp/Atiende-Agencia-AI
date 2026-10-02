// Tabla de precios por modelo (USD por millon de tokens) -- SOLO RESPALDO.
//
// La fuente de verdad del costo es el `usage.cost` que OpenRouter devuelve con
// `usage: { include: true }` (OpenRouterProvider lo lee y lo registra tal cual). Esta tabla
// sirve para dos cosas y nada mas:
//   1. ESTIMAR antes de llamar (reserva de presupuesto: no se puede reservar sobre un costo que
//      solo se conoce despues de la respuesta).
//   2. Costear una respuesta en la que el proveedor NO devolvio costo (red de seguridad).
//
// Cada fila lleva su fecha de verificacion: los precios de los modelos 2026 cambian en semanas.
// Fuente: catalogo publico de OpenRouter (/api/v1/models/<id>/endpoints), tarifa estandar del
// proveedor directo (no Flex/Batch), leido el 2026-10-01. Un modelo SIN fila aqui no rompe nada:
// el estimador cae al tope conservador generico (sobre-reservar es seguro, sub-reservar no) y el
// costo registrado sigue siendo el real que reporta OpenRouter.

export interface ModelPrice {
  /** USD por 1M tokens de entrada. */
  readonly inPerM: number;
  /** USD por 1M tokens de salida (incluye los de razonamiento). */
  readonly outPerM: number;
  /** USD por 1M tokens de entrada leidos de cache; si falta se cobra como entrada normal. */
  readonly cachedInPerM?: number;
  /** Fecha (YYYY-MM-DD) en que se verifico la fila contra la fuente. */
  readonly verifiedAt: string;
}

export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'openai/gpt-6-luna': { inPerM: 0.1, outPerM: 0.5, cachedInPerM: 0.01, verifiedAt: '2026-10-01' },
  'openai/gpt-6-sol': { inPerM: 1, outPerM: 5, cachedInPerM: 0.1, verifiedAt: '2026-10-01' },
  'google/gemini-3.5-flash-lite': { inPerM: 0.3, outPerM: 2.5, cachedInPerM: 0.03, verifiedAt: '2026-10-01' },
  'google/gemini-3.8-flash': { inPerM: 0.75, outPerM: 3.75, cachedInPerM: 0.075, verifiedAt: '2026-10-01' },
  'anthropic/claude-sonnet-5.5': { inPerM: 2, outPerM: 10, cachedInPerM: 0.2, verifiedAt: '2026-10-01' },
  'google/gemini-2.5-flash-lite': { inPerM: 0.1, outPerM: 0.4, cachedInPerM: 0.01, verifiedAt: '2026-10-02' },
  'meta/muse-spark-1.3': { inPerM: 1.25, outPerM: 4.25, verifiedAt: '2026-10-02' },
  // Modelos de laboratorios chinos servidos SOLO por proveedores de EE.UU. (ver
  // apps/api/src/production/llm-models.ts): se reserva con el precio MAS CARO de esos proveedores (el
  // de lista de OpenRouter, $0.03/$0.5 en DeepSeek V4.1 Flash, no aplica a EE.UU.); el costo registrado
  // sigue siendo el real que devuelve OpenRouter.
  'deepseek/deepseek-v4.1-flash': { inPerM: 0.6, outPerM: 2.4, verifiedAt: '2026-10-02' },
  'deepseek/deepseek-v4-pro': { inPerM: 1.91, outPerM: 3.83, verifiedAt: '2026-10-02' },
  'qwen/qwen3-235b-a22b-2507': { inPerM: 0.25, outPerM: 1, verifiedAt: '2026-10-02' },
  // Respaldo candidato del piloto (1-oct-2026): DeepInfra 0.075/0.20 y Parasail 0.09/0.30 por 1M; se reserva con el MAS CARO.
  'mistralai/mistral-small-3.2-24b-instruct': { inPerM: 0.09, outPerM: 0.3, verifiedAt: '2026-10-01' },
};

/** Precio de lista de un modelo, o `undefined` si no esta en la tabla. Acepta el id de OpenRouter
 *  ("openai/gpt-6-luna") y tambien un id de proveedor directo con fecha ("gpt-6-luna-20260922"). */
export function lookupModelPrice(model: string | undefined): ModelPrice | undefined {
  if (!model) return undefined;
  const exact = MODEL_PRICES[model];
  if (exact) return exact;
  // Ids con sufijo de fecha/variante que devuelve el proveedor (openai/gpt-6-luna-20260922, ...:nitro).
  const base = model.split(':')[0]!;
  if (MODEL_PRICES[base]) return MODEL_PRICES[base];
  for (const key of Object.keys(MODEL_PRICES)) {
    if (base.startsWith(`${key}-`)) return MODEL_PRICES[key];
  }
  return undefined;
}

/** Costo en USD con la tabla de respaldo, o `undefined` si el modelo no tiene fila. */
export function costFromPriceTable(model: string | undefined, usage: { tokensIn: number; tokensOut: number; tokensCached?: number }): number | undefined {
  const price = lookupModelPrice(model);
  if (!price) return undefined;
  const cached = Math.min(Math.max(usage.tokensCached ?? 0, 0), usage.tokensIn);
  const fresh = usage.tokensIn - cached;
  const cachedRate = price.cachedInPerM ?? price.inPerM;
  return (fresh * price.inPerM + cached * cachedRate + usage.tokensOut * price.outPerM) / 1_000_000;
}
