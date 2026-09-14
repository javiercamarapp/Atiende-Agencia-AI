// ═══════════════════════════════════════════════════════════════════════════
// Tipos públicos del GATEWAY LLM ÚNICO (packages/agent-core/src/gateway).
//
// Un solo punto de entrada para TODAS las verticales del monorepo fusionado
// (hoteles, restaurantes, rentas, citas, licitaciones) hacia cualquier
// proveedor de modelo. Sustituye los tres motores que existían por separado:
//   - atiende.ai: circuit breaker respaldado en Redis (src/lib/llm/circuit-breaker.ts).
//   - proyecto origen: escalera de fallback cross-provider (src/lib/llm/openrouter.ts)
//                 y presupuesto con reserva-antes-de-gastar (src/lib/llm/budget.ts).
//   - licitaciones: gate de residencia EE.UU. configurable, nunca hardcodeado
//                 a un proveedor (packages/agents/src/llm/router.ts + provider.ts).
// ═══════════════════════════════════════════════════════════════════════════

/** Carril de gasto: decide qué techo de presupuesto frena la llamada y si
 *  compite por la reserva protegida del camino interactivo. Mismo concepto
 *  que `PropositoIa` en el proyecto origen (interactivo/ocr_lote/fondo), renombrado a
 *  inglés porque este paquete es compartido entre 5 verticales, no solo la
 *  de origen. */
export type LlmLane = 'interactive' | 'batch' | 'background';

export const LLM_LANES: readonly LlmLane[] = ['interactive', 'batch', 'background'] as const;

/**
 * Una llamada a herramienta que el modelo decidió hacer — mismo shape que
 * `tool_calls[i]` en la respuesta de OpenAI/OpenRouter (`id` +
 * `function.name`/`function.arguments`, aplanado aquí a `name`/`argumentsJson`
 * porque el gateway es agnóstico de vertical y no necesita el envoltorio
 * `function`). `argumentsJson` es el JSON crudo tal como lo mandó el
 * proveedor — el llamador (turn handler de cada vertical) lo parsea, nunca el
 * gateway, para no imponer un schema de argumentos que el gateway no conoce.
 */
export interface LlmToolCall {
  id: string;
  name: string;
  argumentsJson: string;
}

/** Definición de una herramienta ofrecida al modelo — mismo shape reducido
 *  que `function` dentro de `tools[i]` en la Chat Completions API de
 *  OpenAI/OpenRouter (sin el envoltorio `{type:'function', function:{...}}}`,
 *  que los adaptadores arman internamente). `parameters` es un JSON Schema
 *  tal cual — el gateway no lo valida, solo lo reenvía al proveedor. */
export interface LlmToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export type LlmMessage =
  | { role: 'system' | 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: LlmToolCall[] }
  | { role: 'tool'; toolCallId: string; content: string };

export interface LlmCompletionRequest {
  system: string;
  messages: LlmMessage[];
  /** Herramientas ofrecidas al modelo en esta llamada — omitir cuando el rol
   *  no usa tool-calling (comportamiento idéntico al de antes de este campo). */
  tools?: LlmToolDefinition[];
  maxOutputTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

export interface LlmCompletionResult {
  /** Puede venir vacío cuando el modelo respondió ÚNICAMENTE con tool_calls
   *  (sin texto que decir todavía) — mismo contrato real de OpenAI/OpenRouter
   *  que ya asumía `whatsapp-agent-core.ts` del origen (`msg.content ?? ""`). */
  text: string;
  /** Herramientas que el modelo decidió invocar en esta respuesta, si las hay. */
  toolCalls?: LlmToolCall[];
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
 *  en proyecto-origen/budget.ts y openrouter.ts. */
export type LlmCostEstimator = (provider: LlmProvider, req: LlmCompletionRequest) => number;
