// Puerto LLM de la cascada (escalon 2) sobre el proveedor de OpenRouter del gateway de agent-core, con la MISMA `OPENROUTER_API_KEY` del texto.
// El worker no tiene presupuesto ni kill-switch del gateway completo (corre aparte de la API y sin base): el costo real de cada turno (`usage.cost`
// de OpenRouter) sube a la sesion, que lo suma al costo de la llamada y a los topes por llamada y mensual.
import { OpenRouterProvider } from "@atiende/agent-core";
import type { LlmMessage } from "@atiende/agent-core";
import { VOZ_PLATAFORMA } from "@atiende/voice-core";
import type { PuertoLlmVoz } from "@atiende/voice-core";

/** Proveedores cuyos modelos NO listan `temperature` en OpenRouter: con `require_parameters: true` mandarla deja la ruta sin endpoints (404, docs/LLM-GATEWAY.md). */
const PREFIJOS_SIN_TEMPERATURA = ["anthropic/", "openai/"] as const;

/** `temperature` del modelo de voz: `"omit"` para Anthropic y OpenAI; para el resto, la temperatura pedida si es un numero finito (0 incluido) y, si no, no se manda. */
export function temperaturaParaModelo(modelo: string, temperatura: number | null | undefined): number | "omit" | undefined {
  if (typeof modelo === "string" && PREFIJOS_SIN_TEMPERATURA.some((p) => modelo.startsWith(p))) return "omit";
  return typeof temperatura === "number" && Number.isFinite(temperatura) ? temperatura : undefined;
}

export function crearPuertoLlmOpenRouter(apiKey: string, fetchImpl?: typeof fetch, opciones: { modelo?: string; temperatura?: number | null } = {}): PuertoLlmVoz {
  const modelo = opciones.modelo ?? VOZ_PLATAFORMA.cascada.modeloLlm;
  const temperatura = temperaturaParaModelo(modelo, "temperatura" in opciones ? opciones.temperatura : VOZ_PLATAFORMA.cascada.temperatura);
  const proveedor = new OpenRouterProvider({
    apiKey,
    model: modelo,
    appName: "atiende-voice-worker",
    params: temperatura === undefined ? {} : { temperature: temperatura },
    // Un turno de voz que tarda mas de 8 s ya perdio al cliente: mejor fallar y que la escalera/maquina decidan.
    timeoutMs: 8_000,
    maxRetries: 0,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  return {
    async completar(p) {
      const mensajes: LlmMessage[] = p.mensajes.map((m) => {
        if (m.role === "assistant") return { role: "assistant", content: m.content, ...(m.toolCalls ? { toolCalls: m.toolCalls.map((t) => ({ id: t.id, name: t.nombre, argumentsJson: t.argsJson })) } : {}) };
        if (m.role === "tool") return { role: "tool", toolCallId: m.toolCallId, content: m.content };
        return { role: "user", content: m.content };
      });
      const r = await proveedor.complete({
        system: p.system,
        messages: mensajes,
        tools: p.herramientas.map((h) => ({ name: h.name, description: h.description, parameters: h.parameters as unknown as Record<string, unknown> })),
        maxOutputTokens: 400,
        ...(p.senal ? { signal: p.senal } : {}),
      });
      return {
        texto: r.text,
        toolCalls: (r.toolCalls ?? []).map((t) => ({ id: t.id, nombre: t.name, argsJson: t.argumentsJson })),
        costoMicroUsd: Math.max(0, Math.round(r.costUsd * 1_000_000)),
      };
    },
  };
}
