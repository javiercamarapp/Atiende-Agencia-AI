// Proveedor determinista para pruebas — nunca toca la red. Mismo rol que
// `FakeProvider` en licitaciones/packages/agents/src/llm/fake-provider.ts,
// adaptado a la interfaz `LlmProvider` de este gateway (más simple: solo
// `complete`, sin streaming — el gateway no lo requiere hoy).
//
// IMPORTANTE: pasar los tests con `FakeLlmProvider` no certifica la
// integración real con OpenRouter/Anthropic/OpenAI — ver providers/openrouter.ts
// y providers/README de esta carpeta para el adaptador real.

import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from '../types.js';

export type FakeProviderScript = (request: LlmCompletionRequest) => LlmCompletionResult | Promise<LlmCompletionResult>;

export interface FakeLlmProviderOptions {
  id: string;
  countryOfResidence?: string;
  /** Si se da, `complete` LANZA este error en vez de responder — para
   *  simular un proveedor caído en pruebas de fallback/breaker. */
  failWith?: () => Error;
  script?: FakeProviderScript;
}

export class FakeLlmProvider implements LlmProvider {
  readonly id: string;
  readonly countryOfResidence: string;
  /** Número de veces que `complete` fue invocado — para que las pruebas
   *  verifiquen que un proveedor bloqueado por el gate de residencia o por
   *  el circuit breaker NUNCA fue llamado. */
  callCount = 0;

  constructor(private readonly opts: FakeLlmProviderOptions) {
    this.id = opts.id;
    this.countryOfResidence = opts.countryOfResidence ?? 'US';
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    this.callCount += 1;
    if (this.opts.failWith) throw this.opts.failWith();
    if (this.opts.script) return this.opts.script(request);
    const tokensIn = Math.max(1, Math.ceil((request.system.length + request.messages.reduce((n, m) => n + m.content.length, 0)) / 4));
    const tokensOut = 8;
    return {
      text: `[fake:${this.id}] respuesta determinista`,
      model: `${this.id}/fake-model`,
      tokensIn,
      tokensOut,
      costUsd: (tokensIn * 1 + tokensOut * 5) / 1_000_000,
    };
  }
}
