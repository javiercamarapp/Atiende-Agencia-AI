// ═══════════════════════════════════════════════════════════════════════════
// Adaptador OpenRouter — implementa `LlmProvider` contra la REST API real de
// OpenRouter (https://openrouter.ai/api/v1/chat/completions).
//
// PUERTO de Likida/src/lib/llm/openrouter.ts: mismos headers
// (`HTTP-Referer`/`X-Title`), mismo `provider: { data_collection: 'deny' }`
// (no retener input — compliance de datos), mismo `usage: { include: true }`
// para pedir el costo real reportado por el proveedor en vez de estimarlo.
//
// SIN dependencia del SDK `openai` (no está en las devDependencies de la
// Fase 0 de este monorepo todavía): usa `fetch` nativo de Node ≥18, que es
// exactamente lo que el SDK hace por debajo.
//
// RESIDENCIA: OpenRouter es una empresa con sede en EE.UU., pero es un
// AGREGADOR — enruta cada request al backend de inferencia del modelo
// elegido, que puede vivir fuera de EE.UU. según el modelo/proveedor
// upstream que OpenRouter use ese día. Por eso NO se asume 'US' por
// defecto aquí (a diferencia de `AnthropicProvider`/`OpenAiProvider`, que
// son integraciones directas con jurisdicción fija y declarada): el
// residencia real depende de qué modelo se enruta, y solo el operador que
// configuró el pin de modelo/backend en OpenRouter sabe si esa ruta
// concreta cumple. Se expone como parámetro explícito del constructor —
// nunca hardcodeado — para que un despliegue que SÍ confirmó una ruta
// EE.UU. pueda declararlo, y el gate de residencia (residency.ts) lo
// respete o lo excluya según corresponda.
// ═══════════════════════════════════════════════════════════════════════════

import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider } from '../types.js';

export interface OpenRouterProviderOptions {
  apiKey: string;
  /** Modelo concreto de OpenRouter, p.ej. "anthropic/claude-sonnet-5". */
  model: string;
  /** Ver nota de RESIDENCIA arriba: por defecto 'unknown' (el gate lo
   *  excluye si está activo, salvo que el operador confirme la ruta). */
  countryOfResidence?: string;
  appUrl?: string;
  appName?: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

interface OpenRouterChatResponse {
  model?: string;
  choices?: { message?: { content?: string | null } }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number };
}

export class OpenRouterProvider implements LlmProvider {
  readonly id = 'openrouter';
  readonly countryOfResidence: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly opts: OpenRouterProviderOptions) {
    this.countryOfResidence = opts.countryOfResidence ?? 'unknown';
    this.baseUrl = opts.baseUrl ?? 'https://openrouter.ai/api/v1/chat/completions';
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const res = await this.fetchImpl(this.baseUrl, {
      method: 'POST',
      signal: request.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.opts.apiKey}`,
        'HTTP-Referer': this.opts.appUrl ?? 'https://atiende.ai',
        'X-Title': this.opts.appName ?? 'Atiende',
      },
      body: JSON.stringify({
        model: this.opts.model,
        messages: [{ role: 'system', content: request.system }, ...request.messages.filter((m) => m.role !== 'system')],
        max_tokens: request.maxOutputTokens ?? 500,
        temperature: request.temperature ?? 0.4,
        provider: { data_collection: 'deny' },
        usage: { include: true },
      }),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => '');
      const err = new Error(`OpenRouter ${res.status}: ${body.slice(0, 300)}`) as Error & { status: number };
      err.status = res.status;
      throw err;
    }

    const data = (await res.json()) as OpenRouterChatResponse;
    const tokensIn = data.usage?.prompt_tokens ?? 0;
    const tokensOut = data.usage?.completion_tokens ?? 0;
    return {
      text: (data.choices?.[0]?.message?.content ?? '').trim(),
      model: data.model ?? this.opts.model,
      tokensIn,
      tokensOut,
      // El costo REAL que reporta el proveedor si viene (ve nota `costoReal`
      // en Likida openrouter.ts: la caché de prompt hace que estimar por
      // tabla subestime o sobreestime el ahorro real).
      costUsd: typeof data.usage?.cost === 'number' ? data.usage.cost : 0,
    };
  }
}
