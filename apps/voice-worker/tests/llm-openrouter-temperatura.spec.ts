// Contrato de `temperature` del puerto LLM de la cascada: con `require_parameters: true` los modelos de Anthropic y OpenAI en OpenRouter NO la aceptan
// (404 "No endpoints found", docs/LLM-GATEWAY.md); los demas la conservan. `fetch` falso: ningun test llama a OpenRouter.
import { describe, expect, it } from "vitest";
import { crearPuertoLlmOpenRouter, temperaturaParaModelo } from "../src/llm-openrouter.ts";

const RESPUESTA = { choices: [{ message: { content: "Claro." }, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, cost: 0.000012 } };

async function cuerpoEnviado(modelo: string | undefined, temperatura?: number | null | "sin-clave"): Promise<Record<string, unknown>> {
  let cuerpo: Record<string, unknown> | null = null;
  const fetchFalso = (async (_url: string, init?: RequestInit) => {
    cuerpo = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify(RESPUESTA), { status: 200, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  const opciones: { modelo?: string; temperatura?: number | null } = {};
  if (modelo !== undefined) opciones.modelo = modelo;
  if (temperatura !== "sin-clave") opciones.temperatura = temperatura;
  const puerto = crearPuertoLlmOpenRouter("llave-de-prueba", fetchFalso, temperatura === "sin-clave" ? (modelo === undefined ? {} : { modelo }) : opciones);
  await puerto.completar({ system: "s", mensajes: [{ role: "user", content: "hola" }], herramientas: [] });
  return cuerpo!;
}

describe("temperature en la peticion a OpenRouter", () => {
  it.each(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-luna", "openai/gpt-6-sol"])("%s: NUNCA manda temperature (con 0, otro numero, null ni undefined)", async (modelo) => {
    for (const t of [0, 0.7, null, undefined, "sin-clave" as const]) {
      const cuerpo = await cuerpoEnviado(modelo, t);
      expect(cuerpo, `${modelo} con ${String(t)}`).not.toHaveProperty("temperature");
      expect(cuerpo.model).toBe(modelo);
    }
  });
  it("un modelo que SI la acepta la conserva: 0 se manda como 0 (no se confunde con ausente)", async () => {
    expect((await cuerpoEnviado("google/gemini-3.8-flash", 0)).temperature).toBe(0);
    expect((await cuerpoEnviado("google/gemini-3.8-flash", 0.3)).temperature).toBe(0.3);
  });
  it("sin temperatura (null / undefined) un modelo que la acepta tampoco la manda", async () => {
    expect(await cuerpoEnviado("google/gemini-3.8-flash", null)).not.toHaveProperty("temperature");
    expect(await cuerpoEnviado("google/gemini-3.8-flash", undefined)).not.toHaveProperty("temperature");
  });
  it("por omision usa el modelo y la temperatura de la plataforma (Gemini 3.8 Flash, 0): el comportamiento de siempre", async () => {
    const cuerpo = await cuerpoEnviado(undefined, "sin-clave");
    expect(cuerpo.model).toBe("google/gemini-3.8-flash");
    expect(cuerpo.temperature).toBe(0);
  });
  it.each([[Number.NaN], [Number.POSITIVE_INFINITY]])("una temperatura no finita (%s) no se manda", async (t) => {
    expect(await cuerpoEnviado("google/gemini-3.8-flash", t)).not.toHaveProperty("temperature");
  });
});

describe("temperaturaParaModelo", () => {
  it.each([
    ["anthropic/claude-haiku-5.5", 0, "omit"],
    ["openai/gpt-6-luna", 0, "omit"],
    ["google/gemini-3.8-flash", 0, 0],
    ["google/gemini-3.8-flash", 0.5, 0.5],
    ["google/gemini-3.8-flash", null, undefined],
    ["google/gemini-3.8-flash", undefined, undefined],
    ["", 0, 0],
  ])("%s con %s -> %s", (modelo, t, esperado) => {
    expect(temperaturaParaModelo(modelo, t as number | null | undefined)).toBe(esperado);
  });
  it.each([[null], [false], [[]], [{}], [0]])("modelo invalido %j no rompe y conserva la temperatura", (modelo) => {
    expect(temperaturaParaModelo(modelo as unknown as string, 0)).toBe(0);
  });
});
