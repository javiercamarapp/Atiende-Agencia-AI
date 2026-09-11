import { describe, expect, it } from "vitest";
import { AnthropicDirectProvider } from "../../src/gateway/providers/anthropicDirect.ts";
import { ProviderHttpError, ProviderTransientError, ProviderUnavailableError } from "../../src/gateway/provider.ts";
import { makeParams } from "../support/fakeProvider.ts";

type FetchArgs = Parameters<typeof fetch>;

function fakeFetch(handler: (init?: FetchArgs[1]) => Response): typeof fetch {
  return (async (_input: FetchArgs[0], init?: FetchArgs[1]) => handler(init)) as typeof fetch;
}

describe("AnthropicDirectProvider", () => {
  it("countryOfResidence es 'US' — apto para carriles de tolerancia cero", () => {
    const provider = new AnthropicDirectProvider({ env: { ANTHROPIC_API_KEY: "sk-ant-test" } });
    expect(provider.countryOfResidence).toBe("US");
  });

  it("isAvailable() es false sin ANTHROPIC_API_KEY", () => {
    expect(new AnthropicDirectProvider({ env: {} }).isAvailable()).toBe(false);
  });

  it("complete() lanza ProviderUnavailableError sin credencial, nunca simula una respuesta", async () => {
    const provider = new AnthropicDirectProvider({ env: {} });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderUnavailableError);
  });

  it("envía system como campo aparte (nunca como mensaje) y parsea texto + uso reales", async () => {
    let capturedBody: { system?: unknown; messages?: unknown } | undefined;
    const provider = new AnthropicDirectProvider({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      fetchImpl: fakeFetch((init) => {
        capturedBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            content: [{ type: "text", text: "hola desde Anthropic" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 8, output_tokens: 4 },
          }),
          { status: 200 },
        );
      }),
    });
    const result = await provider.complete(makeParams({ system: "eres un asistente de hotel" }));
    expect(result.text).toBe("hola desde Anthropic");
    expect(result.usage).toEqual({ inputTokens: 8, outputTokens: 4 });
    expect(capturedBody?.system).toBe("eres un asistente de hotel");
    expect(Array.isArray(capturedBody?.messages)).toBe(true);
  });

  it("parsea bloques tool_use y reporta stopReason:'tool_use'", async () => {
    const provider = new AnthropicDirectProvider({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              content: [{ type: "tool_use", id: "toolu_1", name: "buscar_reserva", input: { codigo: "XYZ" } }],
              stop_reason: "tool_use",
              usage: { input_tokens: 3, output_tokens: 2 },
            }),
            { status: 200 },
          ),
      ),
    });
    const result = await provider.complete(makeParams({ toolNames: ["buscar_reserva"] }));
    expect(result.stopReason).toBe("tool_use");
    expect(result.toolCalls).toEqual([{ id: "toolu_1", name: "buscar_reserva", input: { codigo: "XYZ" } }]);
  });

  it("stop_reason:'max_tokens' se reporta truncated:true", async () => {
    const provider = new AnthropicDirectProvider({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      fetchImpl: fakeFetch(
        () =>
          new Response(JSON.stringify({ content: [{ type: "text", text: "corta" }], stop_reason: "max_tokens", usage: {} }), {
            status: 200,
          }),
      ),
    });
    const result = await provider.complete(makeParams());
    expect(result.truncated).toBe(true);
  });

  it("529 (sobrecarga de Anthropic) -> ProviderTransientError", async () => {
    const provider = new AnthropicDirectProvider({
      env: { ANTHROPIC_API_KEY: "sk-ant-test" },
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: "overloaded" } }), { status: 529 })),
    });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderTransientError);
  });

  it("401 -> ProviderHttpError, nunca transitorio", async () => {
    const provider = new AnthropicDirectProvider({
      env: { ANTHROPIC_API_KEY: "sk-ant-invalida" },
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: "invalid x-api-key" } }), { status: 401 })),
    });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderHttpError);
  });
});
