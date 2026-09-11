// Proveedor determinista SOLO para pruebas: reproduce un guion fijo de pasos, sin red.
// No forma parte de la API pública del paquete (no se exporta desde src/index.ts) —
// vive en tests/ a propósito.
import { ProviderTransientError, ProviderHttpError } from "../../src/gateway/provider.ts";
import type { LlmCompleteParams, LlmCompletion, LlmProvider } from "../../src/gateway/provider.ts";

export type FakeStep =
  | { readonly kind: "final"; readonly text: string }
  | { readonly kind: "transient_error" }
  | { readonly kind: "http_error"; readonly status: number };

export class FakeProvider implements LlmProvider {
  readonly id: string;
  readonly countryOfResidence: string;
  private cursor = 0;
  private available = true;

  constructor(id: string, countryOfResidence: string, private readonly script: readonly FakeStep[]) {
    this.id = id;
    this.countryOfResidence = countryOfResidence;
  }

  setAvailable(value: boolean): void {
    this.available = value;
  }

  isAvailable(): boolean {
    return this.available;
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompletion> {
    const step = this.script[this.cursor];
    this.cursor += 1;
    if (!step) {
      return {
        modelSlug: params.modelSlug,
        text: "(fin de guión)",
        toolCalls: [],
        usage: { inputTokens: 1, outputTokens: 1 },
        truncated: false,
        stopReason: "end_turn",
      };
    }
    switch (step.kind) {
      case "transient_error":
        throw new ProviderTransientError(this.id, "error transitorio simulado");
      case "http_error":
        throw new ProviderHttpError(this.id, step.status, `error http simulado ${step.status}`);
      case "final":
        return {
          modelSlug: params.modelSlug,
          text: step.text,
          toolCalls: [],
          usage: { inputTokens: 10, outputTokens: 5 },
          truncated: false,
          stopReason: "end_turn",
        };
      default: {
        const exhaustive: never = step;
        throw new Error(`FakeStep desconocido: ${JSON.stringify(exhaustive)}`);
      }
    }
  }
}

export function makeParams(overrides: Partial<LlmCompleteParams> = {}): LlmCompleteParams {
  return {
    modelSlug: "claude-sonnet-5",
    system: "eres un asistente de prueba",
    messages: [{ role: "user", content: "hola" }],
    toolNames: [],
    temperature: 0.2,
    maxOutputTokens: 100,
    disableParallelToolUse: true,
    ...overrides,
  };
}
