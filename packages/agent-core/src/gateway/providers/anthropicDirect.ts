// NUEVO (no existía en ningún repo origen): llamada HTTP directa a la Messages API de
// Anthropic (https://docs.anthropic.com/en/api/messages), sin proxy — usado como
// proveedor de respaldo compatible con carriles de tolerancia cero (ver router.ts):
// countryOfResidence = "US" (Anthropic PBC), a diferencia de OpenRouterProvider que es
// estructuralmente "UNKNOWN".
//
// "Esqueleto honesto": implementa el contrato HTTP real documentado, probado contra un
// simulador local fiel a ese contrato — nunca ejercitado contra api.anthropic.com real
// en este entorno (sin credenciales). Ver `ANTHROPIC_INTEGRATION_VERIFIED_AGAINST_REAL_API`.
import { ProviderHttpError, ProviderTransientError, ProviderUnavailableError } from "../provider.ts";
import type { LlmCompleteParams, LlmCompletion, LlmMessage, LlmProvider, LlmStopReason, LlmToolCallRequest } from "../provider.ts";

export interface AnthropicDirectProviderOptions {
  readonly id?: string;
  readonly envKey?: string;
  readonly env?: Record<string, string | undefined>;
  readonly model?: string;
  readonly modelSlugOverride?: string;
  readonly baseUrl?: string;
  readonly anthropicVersion?: string;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMs?: number;
}

const DEFAULT_ENV_KEY = "ANTHROPIC_API_KEY";
const DEFAULT_BASE_URL = "https://api.anthropic.com/v1/messages";
const DEFAULT_ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_TIMEOUT_MS = 30_000;

/** `false` explícito y a propósito, mismo criterio que
 * `OPENROUTER_INTEGRATION_VERIFIED_AGAINST_REAL_API` en hoteles: solo pasa a `true`
 * en el commit que documenta una corrida real verificada a mano contra
 * `https://api.anthropic.com` con una `ANTHROPIC_API_KEY` real. */
export const ANTHROPIC_INTEGRATION_VERIFIED_AGAINST_REAL_API = false as const;

type AnthropicContentBlock =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "tool_use"; readonly id: string; readonly name: string; readonly input: unknown }
  | { readonly type: "tool_result"; readonly tool_use_id: string; readonly content: string };

interface AnthropicRequestMessage {
  role: "user" | "assistant";
  content: string | AnthropicContentBlock[];
}

/** Traduce el historial provider-agnóstico al formato de Anthropic: `system` es un
 * campo aparte (nunca un mensaje), un mensaje `role:"tool"` se convierte en un mensaje
 * `user` con un bloque `tool_result`, y — misma limitación conocida que
 * `openRouter.ts` (`toOpenAiMessages`) — se sintetiza el bloque `tool_use` que el
 * contrato exige en el mensaje `assistant` inmediatamente anterior, con `input: {}`
 * como placeholder porque el historial que reenvía el runner no retiene el input JSON
 * original de esa tool call. */
function toAnthropicMessages(messages: readonly LlmMessage[]): AnthropicRequestMessage[] {
  const out: AnthropicRequestMessage[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      const toolCallId = message.toolCallId ?? `desconocido-${out.length}`;
      const previous = out[out.length - 1];
      if (previous && previous.role === "assistant") {
        const blocks: AnthropicContentBlock[] = Array.isArray(previous.content)
          ? previous.content
          : previous.content
            ? [{ type: "text", text: previous.content }]
            : [];
        if (!blocks.some((b) => b.type === "tool_use" && b.id === toolCallId)) {
          blocks.push({ type: "tool_use", id: toolCallId, name: message.toolName ?? "tool_desconocida", input: {} });
        }
        previous.content = blocks;
      }
      out.push({ role: "user", content: [{ type: "tool_result", tool_use_id: toolCallId, content: message.content }] });
      continue;
    }
    if (message.role === "system") {
      // El campo `system` de Anthropic viaja aparte (ver `params.system` en
      // `complete()`); un mensaje "system" suelto dentro del historial no tiene lugar
      // válido en el array `messages` de este proveedor, se ignora aquí.
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

interface AnthropicResponseBlock {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly name?: string;
  readonly input?: unknown;
}

interface AnthropicMessagesResponse {
  readonly content?: readonly AnthropicResponseBlock[];
  readonly stop_reason?: string | null;
  readonly usage?: { readonly input_tokens?: number; readonly output_tokens?: number };
  readonly error?: { readonly message?: string; readonly type?: string };
}

function parseAnthropicResponse(reportedModelSlug: string, body: AnthropicMessagesResponse): LlmCompletion {
  const blocks = body.content ?? [];
  const textBlocks = blocks.filter((b) => b.type === "text" && typeof b.text === "string");
  const text = textBlocks.length > 0 ? textBlocks.map((b) => b.text).join("") : null;
  const toolCalls: LlmToolCallRequest[] = blocks
    .filter((b) => b.type === "tool_use")
    .map((b) => ({ id: b.id ?? "sin-id", name: b.name ?? "tool_desconocida", input: b.input ?? {} }));

  const truncated = body.stop_reason === "max_tokens";
  const stopReason: LlmStopReason = truncated ? "max_tokens" : toolCalls.length > 0 ? "tool_use" : "end_turn";

  return {
    modelSlug: reportedModelSlug,
    text,
    toolCalls,
    usage: {
      inputTokens: body.usage?.input_tokens ?? 0,
      outputTokens: body.usage?.output_tokens ?? 0,
    },
    truncated,
    stopReason,
  };
}

export class AnthropicDirectProvider implements LlmProvider {
  readonly id: string;
  readonly countryOfResidence = "US" as const;
  private readonly envKey: string;
  private readonly env: Record<string, string | undefined>;
  private readonly modelOverride: string | undefined;
  private readonly modelSlugOverride: string | undefined;
  private readonly baseUrl: string;
  private readonly anthropicVersion: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: AnthropicDirectProviderOptions = {}) {
    this.id = options.id ?? "anthropic-direct";
    this.envKey = options.envKey ?? DEFAULT_ENV_KEY;
    this.env = options.env ?? process.env;
    this.modelOverride = options.model;
    this.modelSlugOverride = options.modelSlugOverride;
    this.baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.anthropicVersion = options.anthropicVersion ?? DEFAULT_ANTHROPIC_VERSION;
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
      throw new ProviderUnavailableError(this.id, `Anthropic no configurado en este entorno: falta ${this.envKey}.`);
    }
    const model = this.modelOverride ?? params.modelSlug;

    const requestBody: Record<string, unknown> = {
      model,
      system: params.system,
      messages: toAnthropicMessages(params.messages),
      max_tokens: params.maxOutputTokens,
      temperature: params.temperature,
    };
    if (params.toolNames.length > 0) {
      requestBody.tools = params.toolNames.map((name) => ({
        name,
        description: "",
        input_schema: { type: "object", properties: {}, additionalProperties: true },
      }));
      // Anthropic: `disable_parallel_tool_use` vive dentro de `tool_choice`.
      requestBody.tool_choice = { type: "auto", disable_parallel_tool_use: params.disableParallelToolUse };
    }

    const controller = new AbortController();
    const timeoutHandle = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.baseUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
          "anthropic-version": this.anthropicVersion,
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new ProviderTransientError(this.id, `Anthropic no respondió en ${this.timeoutMs}ms (timeout).`);
      }
      throw new ProviderTransientError(
        this.id,
        `fallo de red hacia Anthropic: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      clearTimeout(timeoutHandle);
    }

    let json: AnthropicMessagesResponse | undefined;
    try {
      json = (await response.json()) as AnthropicMessagesResponse;
    } catch {
      json = undefined;
    }

    if (!response.ok) {
      const detail = json?.error?.message ?? `HTTP ${response.status} sin cuerpo de error legible`;
      if (response.status === 429 || response.status >= 500) {
        throw new ProviderTransientError(this.id, `Anthropic respondió ${response.status}: ${detail}`);
      }
      throw new ProviderHttpError(this.id, response.status, `Anthropic respondió ${response.status}: ${detail}`);
    }

    if (!json) {
      throw new ProviderHttpError(this.id, response.status, "Anthropic respondió 200 sin cuerpo JSON parseable.");
    }

    return parseAnthropicResponse(this.modelSlugOverride ?? params.modelSlug, json);
  }
}
