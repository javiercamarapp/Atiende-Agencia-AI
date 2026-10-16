// Puerto LLM de la cascada para el banco: usa el MISMO OpenRouterProvider del gateway de agent-core que usa el worker en produccion
// (streaming SSE, usage.cost real, cache, require_parameters), con el modelo y el razonamiento elegidos por el banco y SIN temperature
// para los modelos que la rechazan. Registra tiempos y tokens de cada llamada.
import { OpenRouterProvider } from "../../packages/agent-core/src/index.ts";
import type { LlmMessage } from "../../packages/agent-core/src/index.ts";
import type { PuertoLlmVoz } from "../../packages/voice-core/src/llamada/cascada-openrouter.ts";
import type { Medicion } from "./instrumento.ts";

export interface OpcionesPuerto {
  readonly apiKey: string;
  readonly modelo: string;
  readonly razonamiento?: "none" | "minimal" | "low" | "medium" | "high";
  /** Solo para reproducir el defecto de `temperature: 0` del worker actual. */
  readonly temperatura?: number | "omit";
  readonly maxTokens?: number;
  /** Variante experimental: manda `parallel_tool_calls: false` a OpenRouter (el gateway actual NO lo manda). */
  readonly sinParalelo?: boolean;
  /** Variante: marca el system prompt con cache_control (Anthropic via OpenRouter); el gateway actual NO lo hace. */
  readonly cacheAnthropic?: boolean;
  /** Piso del tope de salida (el gateway usa 1500 para modelos que razonan; el worker actual manda 400 a secas). */
  readonly minMaxTokens?: number;
}

export function crearPuertoBench(o: OpcionesPuerto, m: Medicion, ahora: () => number = () => performance.now()): PuertoLlmVoz {
  const proveedor = new OpenRouterProvider({
    apiKey: o.apiKey,
    model: o.modelo,
    appName: "atiende-voz-bench",
    params: { temperature: o.temperatura ?? "omit", minMaxTokens: o.minMaxTokens ?? 1500, ...(o.razonamiento ? { reasoningEffort: o.razonamiento } : {}) },
    timeoutMs: 30_000,
    maxRetries: 4,
    backoffBaseMs: 1500,
    ...(o.sinParalelo || o.cacheAnthropic
      ? {
          fetchImpl: ((url: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
            if (typeof init?.body !== "string") return fetch(url, init);
            const body = JSON.parse(init.body) as { messages?: { role: string; content: unknown }[]; parallel_tool_calls?: boolean };
            if (o.sinParalelo) body.parallel_tool_calls = false;
            if (o.cacheAnthropic && body.messages?.[0]?.role === "system" && typeof body.messages[0].content === "string") {
              body.messages[0] = { role: "system", content: [{ type: "text", text: body.messages[0].content, cache_control: { type: "ephemeral" } }] };
            }
            return fetch(url, { ...init, body: JSON.stringify(body) });
          }) as typeof fetch,
        }
      : {}),
  });
  return {
    async completar(p) {
      const mensajes: LlmMessage[] = p.mensajes.map((x) => {
        if (x.role === "assistant") return { role: "assistant", content: x.content, ...(x.toolCalls ? { toolCalls: x.toolCalls.map((t) => ({ id: t.id, name: t.nombre, argumentsJson: t.argsJson })) } : {}) };
        if (x.role === "tool") return { role: "tool", toolCallId: x.toolCallId, content: x.content };
        return { role: "user", content: x.content };
      });
      const tIni = ahora();
      let tPrimero: number | null = null;
      let r;
      try {
        r = await proveedor.complete({
        system: p.system,
        messages: mensajes,
        tools: p.herramientas.map((h) => ({ name: h.name, description: h.description, parameters: h.parameters as unknown as Record<string, unknown> })),
        maxOutputTokens: o.maxTokens ?? 800,
        onTextDelta: () => {
          if (tPrimero === null) tPrimero = ahora();
        },
        ...(p.senal ? { signal: p.senal } : {}),
        });
      } catch (e) {
        m.caidas.push(`llm:${(e instanceof Error ? e.message : "error").replace(/\s+/g, " ").slice(0, 160)}`);
        throw e;
      }
      m.llamadasLlm.push({
        modelo: r.model,
        tIni,
        tPrimero,
        tFin: ahora(),
        tokensIn: r.tokensIn,
        tokensOut: r.tokensOut,
        tokensCached: r.tokensCached ?? 0,
        tokensReasoning: r.tokensReasoning ?? 0,
        costoUsd: r.costUsd,
        herramientas: r.toolCalls?.length ?? 0,
        ttftMs: tPrimero === null ? null : Math.round(tPrimero - tIni),
        totalMs: Math.round(ahora() - tIni),
        detalleTools: (r.toolCalls ?? []).map((t) => `${t.name}:${(t.argumentsJson ?? "").length}`),
      });
      return {
        texto: r.text,
        toolCalls: (r.toolCalls ?? []).map((t) => ({ id: t.id, nombre: t.name, argsJson: t.argumentsJson })),
        costoMicroUsd: Math.max(0, Math.round(r.costUsd * 1_000_000)),
      };
    },
  };
}
