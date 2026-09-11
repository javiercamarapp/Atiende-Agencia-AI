// Contrato de proveedor de LLM del gateway único (fusiona el `LlmProvider` de
// hoteles/packages/agent-core/src/provider.ts con `countryOfResidence`, tomado del
// `LLMProvider` de licitaciones/packages/agents/src/llm/provider.ts). El
// `GatewayRouter` (./router.ts) nunca habla directo con un SDK de proveedor.

export interface LlmToolCallRequest {
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

export interface LlmMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  readonly toolCallId?: string;
  readonly toolName?: string;
}

export interface LlmUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export type LlmStopReason = "end_turn" | "tool_use" | "max_tokens" | "unavailable";

export interface LlmCompletion {
  readonly modelSlug: string;
  readonly text: string | null;
  readonly toolCalls: readonly LlmToolCallRequest[];
  readonly usage: LlmUsage;
  /** true si la respuesta se cortó por límite de tokens: se trata como error, nunca
   * como respuesta válida (igual que en hoteles). */
  readonly truncated: boolean;
  readonly stopReason: LlmStopReason;
}

export interface LlmCompleteParams {
  readonly modelSlug: string;
  readonly system: string;
  readonly messages: readonly LlmMessage[];
  readonly toolNames: readonly string[];
  readonly temperature: number;
  readonly maxOutputTokens: number;
  readonly disableParallelToolUse: boolean;
  readonly effort?: "low" | "medium" | "high";
}

export interface LlmProvider {
  readonly id: string;
  /**
   * ISO 3166-1 alpha-2 del PROVEEDOR REAL que procesa la llamada, o "UNKNOWN" — nunca
   * "US" por defecto/optimismo. Un proxy multi-vendor (OpenRouter) DEBE declarar
   * "UNKNOWN": nunca se le puede atribuir una residencia fija de forma honesta.
   */
  readonly countryOfResidence: string;
  isAvailable(): boolean;
  complete(params: LlmCompleteParams): Promise<LlmCompletion>;
}

/** Error transitorio (red, 5xx, rate limit, timeout) apto para fallback cross-provider
 * Y que cuenta como fallo ante un `CircuitBreaker` (ver circuitBreaker.ts). */
export class ProviderTransientError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message: string) {
    super(message);
    this.name = "ProviderTransientError";
    this.providerId = providerId;
  }
}

/** Error HTTP NO transitorio (4xx salvo 429: credencial inválida/revocada, request mal
 * formado, modelo inexistente en la cuenta, etc.). NUNCA dispara fallback ni cuenta
 * como fallo del circuit breaker — un 401/400 no se arregla reintentando con otro
 * proveedor ni esperando, necesita revisión humana de configuración. */
export class ProviderHttpError extends Error {
  readonly providerId: string;
  readonly status: number;

  constructor(providerId: string, status: number, message: string) {
    super(message);
    this.name = "ProviderHttpError";
    this.providerId = providerId;
    this.status = status;
  }
}

/** No hay credenciales configuradas para este proveedor: estado honesto, no simulado. */
export class ProviderUnavailableError extends Error {
  readonly providerId: string;

  constructor(providerId: string, message: string) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.providerId = providerId;
  }
}
