// ═══════════════════════════════════════════════════════════════════════════
// OpenRouterProvider -- proveedor PRIMARIO del LlmGateway (decision de Javier, 1-oct-2026).
//
// Habla la API de Chat Completions compatible con OpenAI de OpenRouter
// (https://openrouter.ai/api/v1/chat/completions) con `fetch` nativo, sin SDK. UN escalon de la
// escalera = UN modelo con SUS parametros: la escalera de fallback entre modelos la arma quien
// construye el gateway (apps/api/src/production/llm-models.ts), asi cada modelo conserva su
// propia configuracion (reasoning, temperature, tope de tokens) y su propio circuit breaker.
//
// Que cubre:
//   - tool calling normalizado (tools / tool_calls / role:'tool'), `tool_choice` forzado.
//   - salida estructurada (`response_format: json_schema` estricto) solo si el escalon lo declara.
//   - streaming SSE (`request.onTextDelta`), con el mismo resultado final que el modo normal.
//   - `usage: { include: true }`: lee tokens (entrada, salida, cache, razonamiento) y el COSTO REAL
//     (`usage.cost`); la tabla de precios (prices.ts) es solo respaldo si el costo no viene.
//   - parametros por modelo: `temperature` solo si el modelo la acepta ('omit' por defecto en los
//     modelos que la rechazan), `reasoning.effort`, tope de tokens con piso para que el
//     razonamiento no se coma la respuesta.
//   - preferencias de proveedor de OpenRouter (`provider`): `data_collection: 'deny'` SIEMPRE por
//     defecto, `require_parameters: true`, `allow_fallbacks` controlado, `only`/`order`/`ignore`,
//     `zdr`. Un error de configuracion nunca relaja la privacidad: `data_collection` solo cambia
//     si el operador pone 'allow' de forma explicita.
//   - timeout por llamada y reintentos con backoff exponencial SOLO en errores transitorios
//     (429, 5xx, 408, red/timeout), respetando `Retry-After` con tope.
//
// Clasificacion de errores para la escalera (campo `retryable` de GatewayError):
//   - 408/429/5xx/red/timeout -> transitorio: se reintenta aqui y, si persiste, el gateway pasa al
//     siguiente modelo.
//   - 400/404/422 -> rechazo ESPECIFICO DE ESE MODELO (parametro no soportado, sin endpoint que
//     cumpla la politica de datos): no se reintenta aqui, pero el gateway SI prueba el siguiente
//     modelo (otro modelo puede aceptarlo).
//   - 401/402/403 -> problema de cuenta o de llave (llave invalida, sin credito, bloqueo): el
//     siguiente modelo fallaria igual, se detiene la escalera.
//
// SEGURIDAD: la llave solo viaja en la cabecera Authorization; nunca se registra en mensajes de
// error (el cuerpo de error se recorta y no incluye cabeceras) ni se devuelve al llamador.
//
// RESIDENCIA: OpenRouter es un agregador; el pais real depende del proveedor upstream. Por eso
// `countryOfResidence` es 'unknown' salvo que el operador confirme una ruta (`only` a proveedores
// de EE.UU.) y lo declare.
// ═══════════════════════════════════════════════════════════════════════════

import { GatewayError } from '../errors.js';
import { costFromPriceTable } from '../prices.js';
import type { LlmCompletionRequest, LlmCompletionResult, LlmProvider, LlmToolCall } from '../types.js';
import { fromOpenAiWireToolCalls, toOpenAiWireMessages, toOpenAiWireToolChoice, toOpenAiWireTools, type OpenAiWireToolCall } from './openai-wire.js';

export const OPENROUTER_CHAT_COMPLETIONS_URL = 'https://openrouter.ai/api/v1/chat/completions';

export type OpenRouterReasoningEffort = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

/** Parametros propios de UN modelo. */
export interface OpenRouterModelParams {
  /** `'omit'` = nunca mandar temperature (modelos que la rechazan: GPT-6, Claude 5.x, Gemini
   *  Flash-Lite). Un numero = valor fijo que ignora el de la peticion. `undefined` = se usa la de
   *  la peticion si la trae. */
  temperature?: number | 'omit';
  /** `reasoning.effort` de OpenRouter. `undefined` = no se manda (el modelo usa su default). */
  reasoningEffort?: OpenRouterReasoningEffort;
  /** Tope de tokens de salida fijo (ignora el de la peticion). */
  maxTokens?: number;
  /** Piso del tope de salida: en modelos con razonamiento los tokens de razonamiento consumen el
   *  tope, y un tope de 500 puede dejar la respuesta vacia. */
  minMaxTokens?: number;
  /** El modelo soporta `response_format: json_schema`. Si es false, `responseFormat` se omite. */
  supportsStructuredOutput?: boolean;
}

/** Preferencias de enrutamiento de OpenRouter (objeto `provider` de la peticion). */
export interface OpenRouterRouting {
  /** Por defecto 'deny': solo proveedores que no retienen ni entrenan con el contenido. */
  dataCollection?: 'deny' | 'allow';
  /** Restringe a endpoints con Zero Data Retention. Requiere habilitar ZDR en la cuenta. */
  zdr?: boolean;
  /** Por defecto true: no se manda un parametro que el endpoint no soporte (en vez de ignorarlo). */
  requireParameters?: boolean;
  /** Por defecto false: OpenRouter NO cambia de proveedor por su cuenta (el fallback lo controla
   *  la escalera propia). */
  allowFallbacks?: boolean;
  /** Orden de preferencia de proveedores (slugs de OpenRouter, p.ej. 'openai', 'azure'). */
  order?: readonly string[];
  /** Lista blanca de proveedores. */
  only?: readonly string[];
  /** Lista negra de proveedores. */
  ignore?: readonly string[];
}

export interface OpenRouterProviderOptions {
  apiKey: string;
  /** Id de OpenRouter, p.ej. "openai/gpt-6-luna". */
  model: string;
  /** Id del proveedor en la escalera / circuit breaker. Por defecto 'openrouter'; la escalera por
   *  rol usa `openrouter:<modelo>` para que cada modelo tenga su propio breaker. */
  id?: string;
  params?: OpenRouterModelParams;
  routing?: OpenRouterRouting;
  /** Ver nota de RESIDENCIA arriba. Por defecto 'unknown'. */
  countryOfResidence?: string;
  appUrl?: string;
  appName?: string;
  /** URL completa de chat/completions (las pruebas apuntan a un servidor local falso). */
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  /** Timeout por intento, en ms. Por defecto 30 s (60 s en streaming). */
  timeoutMs?: number;
  /** Reintentos ante errores transitorios. Por defecto 1 (2 intentos en total). */
  maxRetries?: number;
  /** Espera base del backoff, en ms. Por defecto 250 (250, 500, 1000...). Con jitter. */
  backoffBaseMs?: number;
  /** Funcion de espera (inyectable en pruebas). */
  sleep?: (ms: number) => Promise<void>;
}

/** Error de OpenRouter con el status HTTP y la clasificacion para la escalera. */
export class OpenRouterError extends GatewayError {
  /** true = vale la pena reintentar el MISMO modelo con backoff (429, 5xx, 408, red, timeout). */
  readonly transient: boolean;
  constructor(
    message: string,
    readonly status: number | undefined,
    opts: { transient: boolean; ladderRetryable: boolean; retryAfterMs?: number },
  ) {
    super(message, opts.ladderRetryable);
    this.transient = opts.transient;
    this.retryAfterMs = opts.retryAfterMs;
  }
  readonly retryAfterMs: number | undefined;
}

export function classifyOpenRouterStatus(status: number): { transient: boolean; ladderRetryable: boolean } {
  if (status === 408 || status === 429 || status >= 500) return { transient: true, ladderRetryable: true };
  if (status === 400 || status === 404 || status === 422) return { transient: false, ladderRetryable: true };
  return { transient: false, ladderRetryable: false };
}

interface OpenRouterUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  cost?: number;
  prompt_tokens_details?: { cached_tokens?: number };
  completion_tokens_details?: { reasoning_tokens?: number };
}

interface OpenRouterChatResponse {
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: { message?: { content?: string | null; tool_calls?: OpenAiWireToolCall[] }; finish_reason?: string; error?: { code?: number | string; message?: string } }[];
  usage?: OpenRouterUsage;
}

interface OpenRouterStreamChunk {
  model?: string;
  error?: { code?: number | string; message?: string };
  choices?: {
    delta?: { content?: string | null; tool_calls?: { index?: number; id?: string; function?: { name?: string; arguments?: string } }[] };
    finish_reason?: string | null;
  }[];
  usage?: OpenRouterUsage;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_STREAM_TIMEOUT_MS = 60_000;
const MAX_RETRY_AFTER_MS = 2_000;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Cuerpo de la peticion `provider` de OpenRouter. Exportado para probarlo sin red. */
export function buildOpenRouterProviderPrefs(routing: OpenRouterRouting | undefined): Record<string, unknown> {
  const r = routing ?? {};
  return {
    data_collection: r.dataCollection ?? 'deny',
    require_parameters: r.requireParameters ?? true,
    allow_fallbacks: r.allowFallbacks ?? false,
    ...(r.zdr ? { zdr: true } : {}),
    ...(r.order && r.order.length > 0 ? { order: [...r.order] } : {}),
    ...(r.only && r.only.length > 0 ? { only: [...r.only] } : {}),
    ...(r.ignore && r.ignore.length > 0 ? { ignore: [...r.ignore] } : {}),
  };
}

function asNumber(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export class OpenRouterProvider implements LlmProvider {
  readonly id: string;
  readonly model: string;
  readonly countryOfResidence: string;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(private readonly opts: OpenRouterProviderOptions) {
    this.id = opts.id ?? 'openrouter';
    this.model = opts.model;
    this.countryOfResidence = opts.countryOfResidence ?? 'unknown';
    this.baseUrl = opts.baseUrl ?? OPENROUTER_CHAT_COMPLETIONS_URL;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.sleep = opts.sleep ?? defaultSleep;
  }

  /** Tope de tokens de salida que realmente se manda (incluye razonamiento): el pedido o el fijo del escalon, nunca menos
   *  que su piso `minMaxTokens`. Es lo que debe usar el estimador de costo para reservar. */
  effectiveMaxOutputTokens(request: LlmCompletionRequest): number {
    const params = this.opts.params ?? {};
    return Math.max(params.maxTokens ?? request.maxOutputTokens ?? 500, params.minMaxTokens ?? 0);
  }

  /** Cuerpo JSON de la peticion (exportado como metodo para poder probar el contrato sin red). */
  buildBody(request: LlmCompletionRequest): Record<string, unknown> {
    const params = this.opts.params ?? {};
    const tools = toOpenAiWireTools(request.tools);
    const toolChoice = toOpenAiWireToolChoice(request.tools, request.toolChoice);
    const maxTokens = this.effectiveMaxOutputTokens(request);

    const body: Record<string, unknown> = {
      model: this.model,
      messages: toOpenAiWireMessages(request.system, request.messages),
      max_tokens: maxTokens,
      provider: buildOpenRouterProviderPrefs(this.opts.routing),
      usage: { include: true },
    };
    const temperature = params.temperature === 'omit' ? undefined : (params.temperature ?? request.temperature);
    if (temperature !== undefined) body.temperature = temperature;
    if (params.reasoningEffort) body.reasoning = { effort: params.reasoningEffort };
    if (tools) body.tools = tools;
    if (toolChoice) body.tool_choice = toolChoice;
    if (request.responseFormat && params.supportsStructuredOutput) {
      body.response_format = { type: 'json_schema', json_schema: { name: request.responseFormat.name, strict: true, schema: request.responseFormat.schema } };
    }
    if (request.onTextDelta) body.stream = true;
    return body;
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletionResult> {
    const maxRetries = this.opts.maxRetries ?? 1;
    const backoffBase = this.opts.backoffBaseMs ?? 250;
    const streaming = Boolean(request.onTextDelta);
    let streamedAny = false;
    const wrapped: LlmCompletionRequest = streaming
      ? {
          ...request,
          onTextDelta: (d) => {
            streamedAny = true;
            request.onTextDelta!(d);
          },
        }
      : request;

    for (let attempt = 0; ; attempt++) {
      try {
        return await this.once(wrapped, streaming);
      } catch (err) {
        const e = err instanceof OpenRouterError ? err : null;
        // Un error de la propia peticion abortada por el llamador no se reintenta.
        if (request.signal?.aborted) throw err;
        // Si ya se emitio texto al llamador, repetir duplicaria la salida: se propaga.
        const canRetry = e?.transient === true && attempt < maxRetries && !streamedAny;
        if (!canRetry) throw err;
        const backoff = backoffBase * 2 ** attempt + Math.random() * backoffBase;
        // `Retry-After` del proveedor se respeta, pero con tope: la llamada es interactiva.
        await this.sleep(Math.max(backoff, Math.min(e!.retryAfterMs ?? 0, MAX_RETRY_AFTER_MS)));
      }
    }
  }

  private async once(request: LlmCompletionRequest, streaming: boolean): Promise<LlmCompletionResult> {
    const controller = new AbortController();
    const timeoutMs = this.opts.timeoutMs ?? (streaming ? DEFAULT_STREAM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const onCallerAbort = () => controller.abort();
    request.signal?.addEventListener('abort', onCallerAbort, { once: true });

    try {
      let res: Response;
      try {
        res = await this.fetchImpl(this.baseUrl, {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.opts.apiKey}`,
            'HTTP-Referer': this.opts.appUrl ?? 'https://atiende.ai',
            'X-Title': this.opts.appName ?? 'Atiende',
          },
          body: JSON.stringify(this.buildBody(request)),
        });
      } catch (err) {
        if (request.signal?.aborted) throw err;
        throw new OpenRouterError(`OpenRouter ${timedOut ? 'timeout' : 'network error'} (${this.model}): ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), undefined, {
          transient: true,
          ladderRetryable: true,
        });
      }

      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const cls = classifyOpenRouterStatus(res.status);
        const retryAfter = Number(res.headers.get('retry-after'));
        throw new OpenRouterError(`OpenRouter ${res.status} (${this.model}): ${text.slice(0, 300)}`, res.status, {
          ...cls,
          retryAfterMs: Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : undefined,
        });
      }

      try {
        return streaming ? await this.readStream(res, request.onTextDelta!) : this.toResult((await res.json()) as OpenRouterChatResponse);
      } catch (err) {
        if (err instanceof OpenRouterError || request.signal?.aborted) throw err;
        throw new OpenRouterError(`OpenRouter ${timedOut ? 'timeout' : 'respuesta invalida'} (${this.model}): ${err instanceof Error ? err.message : String(err)}`.slice(0, 300), undefined, {
          transient: true,
          ladderRetryable: true,
        });
      }
    } finally {
      clearTimeout(timer);
      request.signal?.removeEventListener('abort', onCallerAbort);
    }
  }

  private errorFromBody(e: { code?: number | string; message?: string }): OpenRouterError {
    const status = typeof e.code === 'number' ? e.code : Number.isFinite(Number(e.code)) ? Number(e.code) : undefined;
    // Sin codigo numerico (error del proveedor upstream a medio camino): tratarlo como transitorio.
    const cls = status ? classifyOpenRouterStatus(status) : { transient: true, ladderRetryable: true };
    return new OpenRouterError(`OpenRouter error (${this.model}): ${String(e.message ?? e.code ?? 'desconocido').slice(0, 300)}`, status, cls);
  }

  private buildResult(parts: { text: string; toolCalls: LlmToolCall[] | undefined; model: string | undefined; usage: OpenRouterUsage | undefined }): LlmCompletionResult {
    const usage = parts.usage;
    const tokensIn = asNumber(usage?.prompt_tokens) ?? 0;
    const tokensOut = asNumber(usage?.completion_tokens) ?? 0;
    const tokensCached = asNumber(usage?.prompt_tokens_details?.cached_tokens);
    const tokensReasoning = asNumber(usage?.completion_tokens_details?.reasoning_tokens);
    const model = parts.model ?? this.model;
    const reported = asNumber(usage?.cost);

    let costUsd: number;
    let costSource: NonNullable<LlmCompletionResult['costSource']>;
    if (reported !== undefined) {
      costUsd = reported;
      costSource = 'provider';
    } else {
      const fromTable = costFromPriceTable(model, { tokensIn, tokensOut, tokensCached }) ?? costFromPriceTable(this.model, { tokensIn, tokensOut, tokensCached });
      if (fromTable !== undefined) {
        costUsd = fromTable;
        costSource = 'table';
      } else {
        // Ni costo reportado ni precio conocido: tope conservador (no subcontar el gasto).
        costUsd = (tokensIn * 10 + tokensOut * 30) / 1_000_000;
        costSource = 'conservative';
      }
    }
    return {
      // Puede venir vacio cuando la respuesta es SOLO tool_calls (ver types.ts::LlmCompletionResult.text).
      text: parts.text.trim(),
      toolCalls: parts.toolCalls,
      model,
      tokensIn,
      tokensOut,
      ...(tokensCached !== undefined ? { tokensCached } : {}),
      ...(tokensReasoning !== undefined ? { tokensReasoning } : {}),
      costUsd,
      costSource,
    };
  }

  private toResult(data: OpenRouterChatResponse): LlmCompletionResult {
    // OpenRouter puede responder 200 con un error del proveedor upstream.
    if (data.error) throw this.errorFromBody(data.error);
    const choice = data.choices?.[0];
    if (choice?.error) throw this.errorFromBody(choice.error);
    if (!choice) throw this.errorFromBody({ message: 'respuesta sin choices' });
    return this.buildResult({ text: choice.message?.content ?? '', toolCalls: fromOpenAiWireToolCalls(choice.message?.tool_calls), model: data.model, usage: data.usage });
  }

  private async readStream(res: Response, onTextDelta: (delta: string) => void): Promise<LlmCompletionResult> {
    if (!res.body) throw this.errorFromBody({ message: 'streaming sin cuerpo' });
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let model: string | undefined;
    let usage: OpenRouterUsage | undefined;
    const calls = new Map<number, { id: string; name: string; args: string }>();

    const handleLine = (line: string): void => {
      // Comentarios SSE (": OPENROUTER PROCESSING") y lineas vacias se ignoran.
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (payload === '' || payload === '[DONE]') return;
      let chunk: OpenRouterStreamChunk;
      try {
        chunk = JSON.parse(payload) as OpenRouterStreamChunk;
      } catch {
        return; // trozo corrupto: se ignora, el resultado final se arma con lo valido.
      }
      if (chunk.error) throw this.errorFromBody(chunk.error);
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = chunk.usage;
      const delta = chunk.choices?.[0]?.delta;
      if (!delta) return;
      if (typeof delta.content === 'string' && delta.content.length > 0) {
        text += delta.content;
        onTextDelta(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const idx = tc.index ?? 0;
        const cur = calls.get(idx) ?? { id: '', name: '', args: '' };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        calls.set(idx, cur);
      }
    };

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        handleLine(buffer.slice(0, nl).replace(/\r$/, ''));
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.trim()) handleLine(buffer.replace(/\r$/, ''));

    const toolCalls: LlmToolCall[] | undefined =
      calls.size > 0
        ? [...calls.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([, c], i) => ({ id: c.id || `call_${i}`, name: c.name, argumentsJson: c.args }))
        : undefined;
    return this.buildResult({ text, toolCalls, model, usage });
  }
}
