// Puerto LLM de la cascada (escalon 2) sobre el proveedor de OpenRouter del gateway de agent-core, con la MISMA `OPENROUTER_API_KEY` del texto.
// El worker no tiene presupuesto ni kill-switch del gateway completo (corre aparte de la API y sin base): el costo real de cada turno (`usage.cost`
// de OpenRouter) sube a la sesion, que lo suma al costo de la llamada y a los topes por llamada y mensual.
import { OpenRouterProvider } from "@atiende/agent-core";
import type { LlmMessage } from "@atiende/agent-core";
import { VOZ_PLATAFORMA } from "@atiende/voice-core";
import type { PuertoLlmVoz } from "@atiende/voice-core";

export function crearPuertoLlmOpenRouter(apiKey: string, fetchImpl?: typeof fetch): PuertoLlmVoz {
  const proveedor = new OpenRouterProvider({
    apiKey,
    model: VOZ_PLATAFORMA.cascada.modeloLlm,
    appName: "atiende-voice-worker",
    params: { temperature: 0 },
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
