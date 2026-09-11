// ═══════════════════════════════════════════════════════════════════════════
// Tipos públicos del GATEWAY LLM ÚNICO (packages/agent-core/src/gateway).
//
// Un solo punto de entrada para TODAS las verticales del monorepo fusionado
// (hoteles, restaurantes, rentas, citas, licitaciones) hacia cualquier
// proveedor de modelo. Sustituye los tres motores que existían por separado:
//   - atiende.ai: circuit breaker respaldado en Redis (src/lib/llm/circuit-breaker.ts).
//   - Likida:     escalera de fallback cross-provider (src/lib/llm/openrouter.ts)
//                 y presupuesto con reserva-antes-de-gastar (src/lib/llm/budget.ts).
//   - licitaciones: gate de residencia EE.UU. configurable, nunca hardcodeado
//                 a un proveedor (packages/agents/src/llm/router.ts + provider.ts).
// ═══════════════════════════════════════════════════════════════════════════

/** Carril de gasto: decide qué techo de presupuesto frena la llamada y si
 *  compite por la reserva protegida del camino interactivo. Mismo concepto
 *  que `PropositoIa` en Likida (interactivo/ocr_lote/fondo), renombrado a
 *  inglés porque este paquete es compartido entre 5 verticales, no solo la
 *  de origen. */
export type LlmLane = 'interactive' | 'batch' | 'background';

export const LLM_LANES: readonly LlmLane[] = ['interactive', 'batch', 'background'] as const;

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LlmCompletionRequest {
  system: string;
  messages: LlmMessage[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmCompletionResult {
  text: string;
  /** Modelo concreto que respondió (puede diferir del solicitado si el
   *  proveedor hace su propio ruteo interno). */
  model: string;
  tokensIn: number;
  tokensOut: number;
  costUsd: number;
}

/**
 * Un proveedor plegable: cualquier backend de modelo (OpenRouter, Anthropic
 * directo, OpenAI directo, o uno nuevo mañana) implementa esta interfaz para
 * entrar a la escalera de fallback del gateway. "Plegable" = se agrega o se
 * quita de la configuración sin tocar el motor del gateway.
 *
 * `countryOfResidence` es lo que el gate de residencia (residency.ts) lee
 * para decidir si un proveedor puede atender tráfico cuando el gate está
 * activo — mismo campo que `LLMProvider.countryOfResidence` en
 * licitaciones/packages/agents/src/llm/provider.ts.
 */
export interface LlmProvider {
  readonly id: string;
  /** ISO 3166-1 alpha-2, p.ej. 'US', 'DE', 'FR'. */
  readonly countryOfResidence: string;
  complete(req: LlmCompletionRequest): Promise<LlmCompletionResult>;
}

/** Estimador de costo previo a la llamada, para poder RESERVAR antes de
 *  gastar (no se puede reservar sobre un costo que solo se conoce después
 *  de que el proveedor responde). Mismo rol que `calcCost` + `cotaEntradaEnTokens`
 *  en Likida budget.ts/openrouter.ts. */
export type LlmCostEstimator = (provider: LlmProvider, req: LlmCompletionRequest) => number;
