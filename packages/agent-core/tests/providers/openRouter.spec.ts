import { describe, expect, it } from "vitest";
import { OpenRouterProvider, mapModelSlugToOpenRouterModel } from "../../src/gateway/providers/openRouter.ts";
import { ProviderHttpError, ProviderTransientError, ProviderUnavailableError } from "../../src/gateway/provider.ts";
import { makeParams } from "../support/fakeProvider.ts";

type FetchArgs = Parameters<typeof fetch>;

function fakeFetch(handler: (input: FetchArgs[0], init?: FetchArgs[1]) => Promise<Response> | Response): typeof fetch {
  return (async (input: FetchArgs[0], init?: FetchArgs[1]) => handler(input, init)) as typeof fetch;
}

describe("OpenRouterProvider", () => {
  it("countryOfResidence es SIEMPRE UNKNOWN — invariante de código, no configurable", () => {
    const provider = new OpenRouterProvider({ env: { OPENROUTER_API_KEY: "sk-test" } });
    expect(provider.countryOfResidence).toBe("UNKNOWN");
  });

  it("isAvailable() es false sin OPENROUTER_API_KEY en el entorno inyectado", () => {
    const provider = new OpenRouterProvider({ env: {} });
    expect(provider.isAvailable()).toBe(false);
  });

  it("complete() lanza ProviderUnavailableError (nunca simula una respuesta) sin credencial", async () => {
    const provider = new OpenRouterProvider({ env: {} });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("hace un POST real (contrato OpenAI-compatible) y parsea una respuesta 200 exitosa", async () => {
    let capturedBody: unknown;
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: "sk-test" },
      fetchImpl: fakeFetch((_url, init) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: "hola desde el simulador" }, finish_reason: "stop" }],
            usage: { prompt_tokens: 12, completion_tokens: 7 },
          }),
          { status: 200 },
        );
      }),
    });
    const result = await provider.complete(makeParams());
    expect(result.text).toBe("hola desde el simulador");
    expect(result.usage).toEqual({ inputTokens: 12, outputTokens: 7 });
    expect(result.truncated).toBe(false);
    expect(capturedBody).toMatchObject({ model: "anthropic/claude-sonnet-5" });
  });

  it("finish_reason:'length' se reporta como truncated:true (nunca respuesta válida)", async () => {
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "corta" }, finish_reason: "length" }], usage: {} }),
            { status: 200 },
          ),
      ),
    });
    const result = await provider.complete(makeParams());
    expect(result.truncated).toBe(true);
    expect(result.stopReason).toBe("max_tokens");
  });

  it("parsea tool_calls con arguments JSON válidos", async () => {
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              choices: [
                {
                  message: {
                    content: null,
                    tool_calls: [{ id: "call-1", function: { name: "buscar_reserva", arguments: '{"codigo":"ABC123"}' } }],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 5, completion_tokens: 5 },
            }),
            { status: 200 },
          ),
      ),
    });
    const result = await provider.complete(makeParams({ toolNames: ["buscar_reserva"] }));
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "call-1", name: "buscar_reserva", input: { codigo: "ABC123" } }]);
  });

  it("429 -> ProviderTransientError (apto para fallback)", async () => {
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })),
    });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderTransientError);
  });

  it("500 -> ProviderTransientError (apto para fallback)", async () => {
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: "boom" } }), { status: 500 })),
    });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderTransientError);
  });

  it("401 -> ProviderHttpError (NUNCA transitorio: es un problema de credencial/config)", async () => {
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: "sk-test-invalida" },
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })),
    });
    const err = await provider.complete(makeParams()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ProviderHttpError);
    expect((err as ProviderHttpError).status).toBe(401);
  });

  it("un fallo de red (fetch que rechaza) es ProviderTransientError", async () => {
    const provider = new OpenRouterProvider({
      env: { OPENROUTER_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(() => {
        throw new Error("ECONNRESET");
      }),
    });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderTransientError);
  });
});

describe("mapModelSlugToOpenRouterModel", () => {
  it("prefija claude-* con 'anthropic/'", () => {
    expect(mapModelSlugToOpenRouterModel("claude-sonnet-5")).toBe("anthropic/claude-sonnet-5");
  });

  it("cae al default documentado para un slug no reconocible", () => {
    expect(mapModelSlugToOpenRouterModel("gpt-4o")).toBe("anthropic/claude-sonnet-5");
  });
});
