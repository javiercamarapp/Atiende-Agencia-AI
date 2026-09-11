// Adaptador OpenAI DIRECTO (no vía OpenRouter) — implementa `LlmProvider`
// contra https://api.openai.com/v1/chat/completions. Igual que
// `AnthropicProvider`: integración directa, `countryOfResidence` fijo a 'US'
// (jurisdicción declarada de la API pública de OpenAI), sin parámetro de
// constructor — no hay agregación upstream que la haga variar.

import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from '../types.js';
import { fromOpenAiWireToolCalls, toOpenAiWireMessages, toOpenAiWireTools, type OpenAiWireToolCall } from './openai-wire.js';

export interface OpenAiProviderOptions {
  apiKey: string;
  /** p.ej. "gpt-5.6-terra". */
  model: string;
  organization?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OpenAiChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null; tool_calls?: OpenAiWireToolCall[] } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Precio de lista [in, out] por 1M tokens — safety net cuando el proveedor
 *  no reporta costo en la respuesta. */
const FALLBACK_PRICE_PER_1M: [number, number] = [1, 6];

export class OpenAiProvider implements LlmProvider {
  readonly id = 'openai';
  readonly countryOfResidence = 'US';
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenAiProviderOptions) {
    this.baseUrl = opts.baseUrl ?? 'https://api.openai.com/v1/chat/completions';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      signal: request.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
        ...(this.opts.organization ? { 'OpenAI-Organization': this.opts.organization } : {}),
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: toOpenAiWireMessages(request.system, request.messages),
        max_tokens: request.maxOutputTokens ?? 500,
        temperature: request.temperature ?? 0.4,
        ...(toOpenAiWireTools(request.tools) ? { tools: toOpenAiWireTools(request.tools) } : {}),
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenAI ${res.status}: ${body.slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as OpenAiChatResponse;
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;
    const message = data.choices?.[0]?.message;
    return {
      text: (message?.content ?? '').trim(),
      toolCalls: fromOpenAiWireToolCalls(message?.tool_calls),
      model: data.model ?? this.opts.model,
      tokensIn,
      tokensOut,
      costUsd: (tokensIn * FALLBACK_PRICE_PER_1M[0] + tokensOut * FALLBACK_PRICE_PER_1M[1]) / 1_000_000,
    };
  }
}
