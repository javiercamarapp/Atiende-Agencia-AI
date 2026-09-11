// Portado de `EnvProvider` (hoteles/packages/agent-core/src/provider.ts): llamada HTTP
// real al endpoint OpenAI-compatible de OpenRouter (https://openrouter.ai/docs/api-reference/chat-completion),
// nunca un SDK de un solo proveedor.
//
// INVARIANTE DE CÓDIGO (mismo patrón que AG-06 de licitaciones): countryOfResidence =
// "UNKNOWN", SIEMPRE, sin excepción de config — OpenRouter es un proxy que enruta a
// múltiples vendors en países distintos; nunca se le puede atribuir una residencia
// fija de forma honesta. Esto hace ESTRUCTURALMENTE imposible que este proveedor
// califique para un carril de tolerancia cero (ver GatewayRouter.zeroToleranceLaneRoles),
// sin depender de que nadie recuerde configurarlo bien.
//
// "Esqueleto honesto" (mismo principio que ADR-006/ADR-007 de hoteles): esta
// integración implementa el contrato HTTP real de OpenRouter y se prueba contra un
// simulador HTTP local fiel a ese contrato, pero NUNCA se ha ejercitado contra el
// servicio real de openrouter.ai en este entorno — no hay credenciales reales aquí.
import { ProviderHttpError, ProviderTransientError, ProviderUnavailableError } from "../provider.ts";
import type { LlmCompleteParams, LlmCompletion, LlmMessage, LlmProvider, LlmStopReason, LlmToolCallRequest } from "../provider.ts";

export interface OpenRouterProviderOptions {
  readonly id?: string;
  /** Orden de prioridad de variables de entorno a revisar para la credencial. Default:
   * solo `OPENROUTER_API_KEY`. */
  readonly envKeys?: readonly string[];
  readonly env?: Record<string, string | undefined>;
  /** Modelo exacto a pedirle a OpenRouter (p.ej. "anthropic/claude-sonnet-5"). Si se
   * omite: `env[modelEnvKey]`; si se omite eso también: se deriva de `modelSlug`. */
  readonly model?: string;
  readonly modelEnvKey?: string;
  readonly modelSlugOverride?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
  readonly httpReferer?: string;
  readonly appTitle?: string;
}

const DEFAULT_ENV_KEYS = ["OPENROUTER_API_KEY"] as const;
const DEFAULT_BASE_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_MODEL_ENV_KEY = "OPENROUTER_MODEL";
const DEFAULT_OPENROUTER_MODEL = "anthropic/claude-sonnet-5";
const DEFAULT_TIMEOUT_MS = 30_000;

export function mapModelSlugToOpenRouterModel(modelSlug: string): string {
  if (modelSlug.startsWith("claude-")) return `anthropic/${modelSlug}`;
  return DEFAULT_OPENROUTER_MODEL;
}

interface OpenRouterFunctionCall {
  readonly name: string;
  readonly arguments: string;
}

interface OpenRouterRequestToolCall {
  readonly id: string;
  readonly type: "function";
  readonly function: OpenRouterFunctionCall;
}

interface OpenRouterRequestMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_call_id?: string;
  tool_calls?: OpenRouterRequestToolCall[];
}

function toOpenAiMessages(system: string, messages: readonly LlmMessage[]): OpenRouterRequestMessage[] {
  const out: OpenRouterRequestMessage[] = [{ role: "system", content: system }];
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

interface OpenRouterResponseToolCall {
  readonly id: string;
  readonly function: { readonly name: string; readonly arguments: string };
}

interface OpenRouterChoice {
  readonly message: { readonly role?: string; readonly content?: string | null; readonly tool_calls?: readonly OpenRouterResponseToolCall[] };
  readonly finish_reason?: string | null;
}

interface OpenRouterCompletionResponse {
  readonly choices?: readonly OpenRouterChoice[];
  readonly usage?: { readonly prompt_tokens?: number; readonly completion_tokens?: number };
  readonly error?: { readonly message?: string };
}

function parseOpenRouterResponse(reportedModelSlug: string, body: OpenRouterCompletionResponse): LlmCompletion {
  const choice = body.choices?.[0];
  const toolCallsResponse = choice?.message.tool_calls ?? [];
  const toolCalls: LlmToolCallRequest[] = toolCallsResponse.map((call) => ({
    id: call.id,
    name: call.function.name,
    input: safeParseJsonArguments(call.function.arguments),
  }));
  const finishReason = choice?.finish_reason ?? null;
  const truncated = finishReason === "length";
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

export class OpenRouterProvider implements LlmProvider {
  readonly id: string;
  readonly countryOfResidence = "UNKNOWN" as const;
  private readonly envKeys: readonly string[];
  private readonly env: Record<string, string | undefined>;
  private readonly modelOverride: string | undefined;
  private readonly modelEnvKey: string;
  private readonly modelSlugOverride: string | undefined;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly httpReferer: string | undefined;
  private readonly appTitle: string | undefined;

  constructor(options: OpenRouterProviderOptions = {}) {
    this.id = options.id ?? "openrouter";
    this.envKeys = options.envKeys ?? DEFAULT_ENV_KEYS;
    this.env = options.env ?? process.env;
    this.modelOverride = options.model;
    this.modelEnvKey = options.modelEnvKey ?? DEFAULT_MODEL_ENV_KEY;
    this.modelSlugOverride = options.modelSlugOverride;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.httpReferer = options.httpReferer;
    this.appTitle = options.appTitle;
  }

  private credentialKey(): string | undefined {
    return this.envKeys.find((key) => Boolean(this.env[key] && this.env[key]!.trim().length > 0));
  }

  isAvailable(): boolean {
    return this.credentialKey() !== undefined;
  }

  private resolveModel(params: LlmCompleteParams): string {
    if (this.modelOverride && this.modelOverride.trim().length > 0) return this.modelOverride;
    const fromEnv = this.env[this.modelEnvKey];
    if (fromEnv && fromEnv.trim().length > 0) return fromEnv.trim();
    return mapModelSlugToOpenRouterModel(params.modelSlug);
  }

  async complete(params: LlmCompleteParams): Promise<LlmCompletion> {
    const key = this.credentialKey();
    if (!key) {
      throw new ProviderUnavailableError(
        this.id,
        `OpenRouter no configurado en este entorno: falta una de [${this.envKeys.join(", ")}].`,
      );
    }
    const apiKey = this.env[key]!;
    const model = this.resolveModel(params);

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
    if (params.effort) {
      requestBody.reasoning = { effort: params.effort };
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          ...(this.httpReferer ? { "HTTP-Referer": this.httpReferer } : {}),
          ...(this.appTitle ? { "X-Title": this.appTitle } : {}),
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderTransientError(this.id, `OpenRouter no respondió en ${this.timeoutMs}ms (timeout).`);
      }
      throw new ProviderTransientError(
        this.id,
        `fallo de red hacia OpenRouter: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    let json: OpenRouterCompletionResponse | undefined;
    try {
      json = (await response.json()) as OpenRouterCompletionResponse;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const detail = json?.error?.message ?? `HTTP ${response.status} sin cuerpo de error legible`;
      if (response.status === 429 || response.status >= 500) {
        throw new ProviderTransientError(this.id, `OpenRouter respondió ${response.status}: ${detail}`);
      }
      throw new ProviderHttpError(this.id, response.status, `OpenRouter respondió ${response.status}: ${detail}`);
    }

    if (!json || !Array.isArray(json.choices) || json.choices.length === 0) {
      throw new ProviderHttpError(
        this.id,
        response.status,
        "OpenRouter respondió 200 sin 'choices' -- respuesta inesperada, no coincide con el contrato documentado.",
      );
    }

    return parseOpenRouterResponse(this.modelSlugOverride ?? params.modelSlug, json);
  }
}
