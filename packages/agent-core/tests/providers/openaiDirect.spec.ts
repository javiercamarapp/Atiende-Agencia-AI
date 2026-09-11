import { describe, expect, it } from "vitest";
import { OpenAiDirectProvider } from "../../src/gateway/providers/openaiDirect.ts";
import { ProviderHttpError, ProviderTransientError, ProviderUnavailableError } from "../../src/gateway/provider.ts";
import { makeParams } from "../support/fakeProvider.ts";

function fakeFetch(handler: () => Response): typeof fetch {
  return (async () => handler()) as typeof fetch;
}

describe("OpenAiDirectProvider", () => {
  it("countryOfResidence es 'US' — apto para carriles de tolerancia cero", () => {
    expect(new OpenAiDirectProvider({ env: { OPENAI_API_KEY: "sk-test" } }).countryOfResidence).toBe("US");
  });

  it("isAvailable() es false sin OPENAI_API_KEY", () => {
    expect(new OpenAiDirectProvider({ env: {} }).isAvailable()).toBe(false);
  });

  it("complete() lanza ProviderUnavailableError sin credencial", async () => {
    await expect(new OpenAiDirectProvider({ env: {} }).complete(makeParams())).rejects.toBeInstanceOf(
      ProviderUnavailableError,
    );
  });

  it("parsea una respuesta 200 exitosa", async () => {
    const provider = new OpenAiDirectProvider({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(
        () =>
          new Response(
            JSON.stringify({
              choices: [{ message: { content: "hola desde OpenAI" }, finish_reason: "stop" }],
              usage: { prompt_tokens: 9, completion_tokens: 3 },
            }),
            { status: 200 },
          ),
      ),
    });
    const result = await provider.complete(makeParams());
    expect(result.text).toBe("hola desde OpenAI");
    expect(result.usage).toEqual({ inputTokens: 9, outputTokens: 3 });
  });

  it("429 -> ProviderTransientError, 401 -> ProviderHttpError", async () => {
    const rateLimited = new OpenAiDirectProvider({
      env: { OPENAI_API_KEY: "sk-test" },
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 })),
    });
    await expect(rateLimited.complete(makeParams())).rejects.toBeInstanceOf(ProviderTransientError);

    const unauthorized = new OpenAiDirectProvider({
      env: { OPENAI_API_KEY: "sk-invalida" },
      fetchImpl: fakeFetch(() => new Response(JSON.stringify({ error: { message: "invalid api key" } }), { status: 401 })),
    });
    await expect(unauthorized.complete(makeParams())).rejects.toBeInstanceOf(ProviderHttpError);
  });

  it("un timeout (AbortError) se clasifica como ProviderTransientError", async () => {
    const provider = new OpenAiDirectProvider({
      env: { OPENAI_API_KEY: "sk-test" },
      timeoutMs: 5,
      fetchImpl: (async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
        await new Promise((resolve) => setTimeout(resolve, 50));
        if (init?.signal?.aborted) {
          const err = new Error("aborted");
          err.name = "AbortError";
          throw err;
        }
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    await expect(provider.complete(makeParams())).rejects.toBeInstanceOf(ProviderTransientError);
  });
});
