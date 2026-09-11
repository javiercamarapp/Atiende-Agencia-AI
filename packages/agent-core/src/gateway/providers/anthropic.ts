// Adaptador Anthropic DIRECTO (no vía OpenRouter) — implementa `LlmProvider`
// contra https://api.anthropic.com/v1/messages. Integración directa: la
// jurisdicción de procesamiento es la que Anthropic declara para su API
// pública (EE.UU.), así que `countryOfResidence` es fijo a 'US' y NO es
// parámetro del constructor — a diferencia de `OpenRouterProvider`, aquí no
// hay agregación upstream que pueda variar la ruta.
//
// Sin dependencia del SDK `@anthropic-ai/sdk`: `fetch` nativo, mismo criterio
// que providers/openrouter.ts.

import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from '../types.js';

export interface AnthropicProviderOptions {
  apiKey: string;
  /** p.ej. "claude-sonnet-5-20260101". */
  model: string;
  apiVersion?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface AnthropicMessagesResponse {
  model?: string;
  content?: { type: string; text?: string }[];
  usage?: { input_tokens?: number; output_tokens?: number };
}

/** Precio de lista [in, out] por 1M tokens — safety net cuando el proveedor
 *  no reporta costo (la API de Anthropic no devuelve `cost` en la respuesta,
 *  a diferencia de OpenRouter). Ajustar si el modelo configurado cambia de
 *  tarifa. */
const FALLBACK_PRICE_PER_1M: [number, number] = [3, 15];

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic';
  readonly countryOfResidence = 'US';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: AnthropicProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.anthropic.com/v1/messages';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      signal: request.signal,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': this.opts.apiKey,
        'anthropic-version': this.opts.apiVersion ?? '2023-06-01',
      },
      body: JSON.stringify({
        model: this.opts.model,
        system: request.system,
        messages: request.messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({ role: m.role, content: m.content })),
        max_tokens: request.maxOutputTokens ?? 500,
        temperature: request.temperature ?? 0.4,
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`Anthropic ${res.status}: ${body.slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as AnthropicMessagesResponse;
    const tokensIn = data.usage?.input_tokens ?? 0;
    const tokensOut = data.usage?.output_tokens ?? 0;
    const text = (data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text ?? '').join('');
    return {
      text,
      model: data.model ?? this.opts.model,
      tokensIn,
      tokensOut,
      costUsd: (tokensIn * FALLBACK_PRICE_PER_1M[0] + tokensOut * FALLBACK_PRICE_PER_1M[1]) / 1_000_000,
    };
  }
}
