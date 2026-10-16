// LLM auxiliar del banco (cliente simulado y juez): modelo INDEPENDIENTE de los evaluados, via el mismo OpenRouterProvider. Acumula su costo real.
import { OpenRouterProvider } from "../../packages/agent-core/src/index.ts";

export const MODELO_CLIENTE = process.env.VOZ_BENCH_CLIENTE ?? "meta-llama/llama-4-maverick";
export const MODELO_JUEZ = process.env.VOZ_BENCH_JUEZ ?? "mistralai/mistral-medium-3.1";

export function crearAux(apiKey: string, modelo: string, maxTokens = 200, temperatura: number | "omit" = 0.7) {
  const p = new OpenRouterProvider({ apiKey, model: modelo, appName: "atiende-voz-bench-aux", params: { temperature: temperatura }, timeoutMs: 30_000, maxRetries: 2 });
  const acum = { costoUsd: 0, llamadas: 0 };
  return {
    acum,
    async pedir(a: { sistema: string; mensajes: { role: "user" | "assistant"; content: string }[] }): Promise<string> {
      const r = await p.complete({ system: a.sistema, messages: a.mensajes, maxOutputTokens: maxTokens });
      acum.costoUsd += r.costUsd;
      acum.llamadas += 1;
      return r.text;
    },
  };
}
