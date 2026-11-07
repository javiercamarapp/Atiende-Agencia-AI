// Puerto LLM de la cascada v2 (streaming sobre OpenRouter) con `fetch` FALSO: nunca manda `temperature`, esfuerzo bajo, cache explicito del system prompt,
// streaming SSE de texto y de herramientas, modelo por peticion, uso y cache de vuelta. Ningun test llama a OpenRouter.
import { describe, expect, it } from "vitest";
import { VOZ_PLATAFORMA } from "@atiende/voice-core";
import { crearPuertoLlmVozV2 } from "../src/llm-openrouter.ts";

const BASE = { system: "Eres el agente de la taqueria.", mensajes: [{ role: "user" as const, content: "hola" }], herramientas: [] };

/** `fetch` falso que responde en SSE (OpenRouter / OpenAI) con los trozos dados y guarda los cuerpos recibidos. */
function fetchSse(chunks: unknown[]) {
  const cuerpos: Record<string, unknown>[] = [];
  const fn = (async (_url: string, init?: RequestInit) => {
    cuerpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    const texto = `: OPENROUTER PROCESSING\n\n${chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("")}data: [DONE]\n\n`;
    const enc = new TextEncoder().encode(texto);
    // Entrega el cuerpo en trozos pequenos para ejercitar el armado de lineas SSE partidas.
    const stream = new ReadableStream<Uint8Array>({
      start(c) {
        for (let i = 0; i < enc.length; i += 17) c.enqueue(enc.slice(i, i + 17));
        c.close();
      },
    });
    return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
  }) as unknown as typeof fetch;
  return { fn, cuerpos };
}

const delta = (content: string) => ({ model: "anthropic/claude-sonnet-5.5", choices: [{ delta: { content } }] });
const uso = { usage: { prompt_tokens: 1200, completion_tokens: 30, cost: 0.0042, prompt_tokens_details: { cached_tokens: 1100 } }, choices: [{ delta: {}, finish_reason: "stop" }] };

describe("puerto LLM de voz v2", () => {
  it("manda el modelo de la plataforma (Sonnet 5.5) con esfuerzo BAJO, tope de salida corto, streaming y SIN temperature", async () => {
    const { fn, cuerpos } = fetchSse([delta("Claro."), uso]);
    await crearPuertoLlmVozV2("llave-de-prueba", fn).completar({ ...BASE, onTextDelta: () => undefined });
    const c = cuerpos[0]!;
    expect(c.model).toBe("anthropic/claude-sonnet-5.5");
    expect(c.reasoning).toEqual({ effort: "low" });
    expect(c.max_tokens).toBe(VOZ_PLATAFORMA.cascadaV2.llm.topeSalidaTokens);
    expect(c.stream).toBe(true);
    expect(c.usage).toEqual({ include: true });
    expect(c).not.toHaveProperty("temperature");
  });

  it.each(["anthropic/claude-haiku-5.5", "anthropic/claude-sonnet-5.5", "openai/gpt-6-luna", "google/gemini-3.8-flash", "deepseek/deepseek-v4.1-flash"])("%s: nunca manda temperature (ni con la de la sucursal en la peticion)", async (modelo) => {
    const { fn, cuerpos } = fetchSse([delta("ok"), uso]);
    await crearPuertoLlmVozV2("k", fn).completar({ ...BASE, modeloPreferido: modelo, temperatura: 0.4, onTextDelta: () => undefined });
    expect(cuerpos[0]).not.toHaveProperty("temperature");
    expect(cuerpos[0]!.model).toBe(modelo);
  });

  it("el esfuerzo de razonamiento solo se manda a modelos Anthropic (a otros, con require_parameters, dejaria la ruta sin endpoints)", async () => {
    const { fn, cuerpos } = fetchSse([delta("ok"), uso]);
    const puerto = crearPuertoLlmVozV2("k", fn);
    await puerto.completar({ ...BASE, modeloPreferido: "google/gemini-3.8-flash", onTextDelta: () => undefined });
    await puerto.completar({ ...BASE, modeloPreferido: "anthropic/claude-haiku-5.5", esfuerzo: "medium", onTextDelta: () => undefined });
    expect(cuerpos[0]).not.toHaveProperty("reasoning");
    expect(cuerpos[1]!.reasoning).toEqual({ effort: "medium" });
  });

  it("marca el system prompt con un punto de cache explicito (solo Anthropic) y deja el resto igual", async () => {
    const { fn, cuerpos } = fetchSse([delta("ok"), uso]);
    const puerto = crearPuertoLlmVozV2("k", fn);
    await puerto.completar({ ...BASE, onTextDelta: () => undefined });
    await puerto.completar({ ...BASE, modeloPreferido: "google/gemini-3.8-flash", onTextDelta: () => undefined });
    const m0 = cuerpos[0]!.messages as { role: string; content: unknown }[];
    expect(m0[0]).toEqual({ role: "system", content: [{ type: "text", text: BASE.system, cache_control: { type: "ephemeral" } }] });
    expect(m0[1]).toEqual({ role: "user", content: "hola" });
    expect((cuerpos[1]!.messages as { content: unknown }[])[0]!.content).toBe(BASE.system);
  });

  it("entrega el texto por trozos conforme llega y devuelve el texto completo, el costo REAL de OpenRouter, el modelo y la lectura de cache", async () => {
    const trozos: string[] = [];
    const { fn } = fetchSse([delta("Claro, "), delta("con gusto."), uso]);
    const r = await crearPuertoLlmVozV2("k", fn).completar({ ...BASE, onTextDelta: (d) => trozos.push(d) });
    expect(trozos).toEqual(["Claro, ", "con gusto."]);
    expect(r).toMatchObject({ texto: "Claro, con gusto.", toolCalls: [], costoMicroUsd: 4200, costoReal: true, modelo: "anthropic/claude-sonnet-5.5", tokensEntrada: 1200, tokensSalida: 30, tokensCache: 1100 });
  });

  it("devuelve el motivo de fin (finish_reason) y usa el piso de 1 500 tokens de salida: con razonamiento, un tope chico deja el contenido vacio", async () => {
    const { fn, cuerpos } = fetchSse([delta("Hola"), { choices: [{ delta: {}, finish_reason: "length" }], usage: { prompt_tokens: 10, completion_tokens: 1500 } }]);
    const r = await crearPuertoLlmVozV2("k", fn).completar({ ...BASE, onTextDelta: () => undefined });
    expect(r.finishReason).toBe("length");
    expect(cuerpos[0]!.max_tokens).toBe(1500);
    const fnVacio = (async () => new Response(JSON.stringify({ choices: [{ message: { content: "" }, finish_reason: "length" }], usage: { prompt_tokens: 3, completion_tokens: 1500 } }), { status: 200 })) as unknown as typeof fetch;
    const vacia = await crearPuertoLlmVozV2("k", fnVacio).completar(BASE);
    expect(vacia).toMatchObject({ texto: "", finishReason: "length" });
  });

  it("sin costo reportado el costo no se marca como real; sin lectura de cache no inventa tokensCache", async () => {
    const { fn } = fetchSse([delta("ok"), { usage: { prompt_tokens: 100, completion_tokens: 5 }, choices: [{ delta: {}, finish_reason: "stop" }] }]);
    const r = await crearPuertoLlmVozV2("k", fn).completar({ ...BASE, onTextDelta: () => undefined });
    expect(r.costoReal).toBe(false);
    expect(r).not.toHaveProperty("tokensCache");
  });

  it("arma las herramientas pedidas por streaming (fragmentos de argumentos) y las devuelve en orden", async () => {
    const { fn, cuerpos } = fetchSse([
      { choices: [{ delta: { content: "Un momento. " } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, id: "t0", function: { name: "buscar_cliente", arguments: "{\"tel" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: "efono\":\"1\"}" } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 1, id: "t1", function: { name: "cotizar", arguments: "{}" } }] } }] },
      uso,
    ]);
    const r = await crearPuertoLlmVozV2("k", fn).completar({
      ...BASE,
      herramientas: [{ name: "buscar_cliente", description: "Busca.", parameters: { type: "object", properties: {} } }],
      onTextDelta: () => undefined,
    });
    expect(r.toolCalls).toEqual([{ id: "t0", nombre: "buscar_cliente", argsJson: "{\"telefono\":\"1\"}" }, { id: "t1", nombre: "cotizar", argsJson: "{}" }]);
    expect((cuerpos[0]!.tools as unknown[]).length).toBe(1);
  });

  it("RETENCION CERO: toda peticion pide endpoints ZDR solo de Vertex y Bedrock, con data_collection deny y sin salirse de esa lista", async () => {
    const { fn, cuerpos } = fetchSse([delta("ok"), uso]);
    const puerto = crearPuertoLlmVozV2("k", fn);
    await puerto.completar({ ...BASE, onTextDelta: () => undefined });
    await puerto.completar({ ...BASE, modeloPreferido: "anthropic/claude-haiku-5.5", onTextDelta: () => undefined });
    for (const c of cuerpos) {
      expect(c.provider).toMatchObject({ zdr: true, only: ["google-vertex", "amazon-bedrock"], allow_fallbacks: true, data_collection: "deny", require_parameters: true });
      expect(JSON.stringify(c.provider)).not.toContain("anthropic\"");
    }
  });

  it("un 404 cuyo cuerpo habla de la politica de datos / retencion cero sube con motivo sin_zdr; cualquier otro 404 conserva solo su estado", async () => {
    const con = (cuerpo: string) => (async () => new Response(cuerpo, { status: 404 })) as unknown as typeof fetch;
    const zdr = await crearPuertoLlmVozV2("k", con("No endpoints found matching your data policy (Zero Data Retention)")).completar({ ...BASE, onTextDelta: () => undefined }).catch((e: unknown) => e as { status?: number; motivo?: string });
    expect(zdr).toMatchObject({ status: 404, motivo: "sin_zdr" });
    const otro = await crearPuertoLlmVozV2("k", con("No endpoints found that support the requested parameter")).completar({ ...BASE, onTextDelta: () => undefined }).catch((e: unknown) => e as { status?: number; motivo?: string });
    expect(otro).toMatchObject({ status: 404 });
    expect(otro).not.toHaveProperty("motivo");
  });

  it("los proveedores ZDR permitidos se pueden sobreescribir (residencia: decision pendiente de Javier)", async () => {
    const { fn, cuerpos } = fetchSse([delta("ok"), uso]);
    await crearPuertoLlmVozV2("k", fn, { proveedoresZdr: ["google-vertex/us"] }).completar({ ...BASE, onTextDelta: () => undefined });
    expect((cuerpos[0]!.provider as { only: string[] }).only).toEqual(["google-vertex/us"]);
  });

  it("sin onTextDelta responde sin streaming (la forma de siempre) y tambien sin temperature", async () => {
    const cuerpos: Record<string, unknown>[] = [];
    const fn = (async (_u: string, init?: RequestInit) => {
      cuerpos.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ choices: [{ message: { content: "Hola." }, finish_reason: "stop" }], usage: { prompt_tokens: 3, completion_tokens: 1, cost: 0.000001 } }), { status: 200 });
    }) as unknown as typeof fetch;
    const r = await crearPuertoLlmVozV2("k", fn).completar(BASE);
    expect(r.texto).toBe("Hola.");
    expect(cuerpos[0]).not.toHaveProperty("stream");
    expect(cuerpos[0]).not.toHaveProperty("temperature");
  });

  it("un error HTTP sube con su estado (el nucleo lo vuelve `v2_llm_<estado>`) y la llave nunca aparece en el mensaje", async () => {
    const fn = (async () => new Response("rate limit", { status: 429 })) as unknown as typeof fetch;
    const err = await crearPuertoLlmVozV2("llave-secreta-123", fn).completar({ ...BASE, onTextDelta: () => undefined }).catch((e: unknown) => e as { status?: number; message: string });
    expect(err).toMatchObject({ status: 429 });
    expect((err as Error).message).not.toContain("llave-secreta-123");
  });

  it("abortar la peticion corta el streaming", async () => {
    const ctl = new AbortController();
    const fn = (async (_u: string, init?: RequestInit) => {
      const stream = new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta("Hola"))}\n\n`));
          init?.signal?.addEventListener("abort", () => c.error(new DOMException("abortado", "AbortError")));
        },
      });
      return new Response(stream, { status: 200 });
    }) as unknown as typeof fetch;
    const p = crearPuertoLlmVozV2("k", fn).completar({ ...BASE, senal: ctl.signal, onTextDelta: () => ctl.abort() });
    await expect(p).rejects.toBeDefined();
  });

  it("herramientaForzada llega al gateway como tool_choice; sin ella no se manda", async () => {
    const herramientas = [{ name: "crear_pedido", description: "x", parameters: { type: "object" as const, properties: {} } }];
    const a = fetchSse([delta("ok"), uso]);
    await crearPuertoLlmVozV2("k", a.fn).completar({ ...BASE, herramientas, herramientaForzada: "crear_pedido", onTextDelta: () => undefined });
    expect(a.cuerpos[0]!.tool_choice).toEqual({ type: "function", function: { name: "crear_pedido" } });
    const b = fetchSse([delta("ok"), uso]);
    await crearPuertoLlmVozV2("k", b.fn).completar({ ...BASE, herramientas, onTextDelta: () => undefined });
    expect(b.cuerpos[0]).not.toHaveProperty("tool_choice");
  });
});
