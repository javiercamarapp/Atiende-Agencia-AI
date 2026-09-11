// NUEVO (no existía en ningún repo origen): llamada HTTP directa al endpoint Chat
// Completions de OpenAI (https://api.openai.com/v1/chat/completions), sin proxy.
// countryOfResidence = "US" (OpenAI, L.L.C.), igual que AnthropicDirectProvider.
//
// El formato de request/response es el mismo contrato OpenAI-compatible que
// `OpenRouterProvider` ya implementa (OpenRouter lo expone tal cual) — la traducción
// de mensajes se duplica aquí (en vez de importarse) a propósito: cada proveedor debe
// poder evolucionar su propio contrato sin arrastrar cambios a los demás.
import { ProviderHttpError, ProviderTransientError, ProviderUnavailableError } from "../provider.ts";
import type { LlmCompleteParams, LlmCompletion, LlmMessage, LlmProvider, LlmStopReason, LlmToolCallRequest } from "../provider.ts";

export interface OpenAiDirectProviderOptions {
  readonly id?: string;
  readonly envKey?: string;
  readonly env?: Record<string, string | undefined>;
  readonly model?: string;
  readonly modelSlugOverride?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_ENV_KEY = "OPENAI_API_KEY";
const DEFAULT_BASE_URL = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 30_000;

/** `false` explícito y a propósito, mismo criterio que en `anthropicDirect.ts`. */
export const OPENAI_INTEGRATION_VERIFIED_AGAINST_REAL_API = false as const;

interface OpenAiRequestToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenAiRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenAiRequestToolCall[];
}

function toOpenAiMessages(system: string, messages: readonly LlmMessage[]): OpenAiRequestMessage[] {
  const out: OpenAiRequestMessage[] = [{ role: "system", content: system }];
  for (const message of messages) {
    if (message.role === "tool") {
      const previous = out[out.length - 1];
      const toolCallId = message.toolCallId ?? `desconocido-${out.length}`;
      if (previous && previous.role === "assistant") {
        previous.tool_calls = previous.tool_calls ?? [];
        if (!previous.tool_calls.some((call) => call.id === toolCallId)) {
          previous.tool_calls.push({
            id: toolCallId,
            type: "function",
            function: { name: message.toolName ?? "tool_desconocida", arguments: "{}" },
          });
        }
        if (previous.content === "") previous.content = null;
      }
      out.push({ role: "tool", content: message.content, tool_call_id: toolCallId });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function safeParseJsonArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { _raw: raw };
  }
}

interface OpenAiResponseToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenAiChoice {
  readonly message: { readonly content?: string | null; readonly tool_calls?: readonly OpenAiResponseToolCall[] };
  readonly finish_reason?: string | null;
}

interface OpenAiChatCompletionResponse {
  readonly choices?: readonly OpenAiChoice[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly error?: { readonly message?: string };
}

function parseOpenAiResponse(reportedModelSlug: string, body: OpenAiChatCompletionResponse): LlmCompletion {
  const choice = body.choices?.[0];
  const toolCalls: LlmToolCallRequest[] = (choice?.message.tool_calls ?? []).map((call) => ({
    id: call.id,
    name: call.function.name,
    input: safeParseJsonArguments(call.function.arguments),
  }));
  const truncated = choice?.finish_reason === "length";
  const stopReason: LlmStopReason = truncated ? "max_tokens" : toolCalls.length > 0 ? "tool_use" : "end_turn";
  return {
    modelSlug: reportedModelSlug,
    text: choice?.message.content ?? null,
    toolCalls,
    usage: {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
    },
    truncated,
    stopReason,
  };
}

export class OpenAiDirectProvider implements LlmProvider {
  readonly id: string;
  readonly countryOfResidence = "US" as const;
  private readonly envKey: string;
  private readonly env: Record<string, string | undefined>;
  private readonly modelOverride: string | undefined;
  private readonly modelSlugOverride: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: OpenAiDirectProviderOptions = {}) {
    this.id = options.id ?? "openai-direct";
    this.envKey = options.envKey ?? DEFAULT_ENV_KEY;
    this.env = options.env ?? process.env;
    this.modelOverride = options.model;
    this.modelSlugOverride = options.modelSlugOverride;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  isAvailable(): boolean {
    const value = this.env[this.envKey];
    return Boolean(value && value.trim().length > 0);
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompletion> {
    const apiKey = this.env[this.envKey];
    if (!apiKey || apiKey.trim().length === 0) {
      throw new ProviderUnavailableError(this.id, `OpenAI no configurado en este entorno: falta ${this.envKey}.`);
    }
    const model = this.modelOverride ?? DEFAULT_MODEL;

    const hasTools = params.toolNames.length > 0;
    const requestBody: Record<string, unknown> = {
      model,
      messages: toOpenAiMessages(params.system, params.messages),
      temperature: params.temperature,
      max_tokens: params.maxOutputTokens,
    };
    if (hasTools) {
      requestBody.tools = params.toolNames.map((name) => ({
        type: "function",
        function: { name, parameters: { type: "object", properties: {}, additionalProperties: true } },
      }));
      requestBody.tool_choice = "auto";
      requestBody.parallel_tool_calls = !params.disableParallelToolUse;
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderTransientError(this.id, `OpenAI no respondió en ${this.timeoutMs}ms (timeout).`);
      }
      throw new ProviderTransientError(
        this.id,
        `fallo de red hacia OpenAI: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    let json: OpenAiChatCompletionResponse | undefined;
    try {
      json = (await response.json()) as OpenAiChatCompletionResponse;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const detail = json?.error?.message ?? `HTTP ${response.status} sin cuerpo de error legible`;
      if (response.status === 429 || response.status >= 500) {
        throw new ProviderTransientError(this.id, `OpenAI respondió ${response.status}: ${detail}`);
      }
      throw new ProviderHttpError(this.id, response.status, `OpenAI respondió ${response.status}: ${detail}`);
    }

    if (!json || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new ProviderHttpError(
        this.id,
        response.status,
        "OpenAI respondió 200 sin 'choices' -- respuesta inesperada, no coincide con el contrato documentado.",
      );
    }

    return parseOpenAiResponse(this.modelSlugOverride ?? params.modelSlug, json);
  }
}
