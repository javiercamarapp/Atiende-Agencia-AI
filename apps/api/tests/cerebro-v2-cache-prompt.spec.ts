// Cerebro v2 (latencia y costo): ~250-280k tokens de entrada por conversacion, casi todo el MISMO prefijo (herramientas + system). Anthropic (Haiku 5.5, el respaldo de Luna)
// solo cachea con `cache_control` explicito; Luna (OpenAI por Azure) cachea sola el prefijo comun. El escalon de Haiku de la escalera ZDR lleva el punto de cache.
import { describe, expect, it } from "vitest";
import { paramsDeEscalonCerebroV2 } from "../src/production/llm-gateway.ts";

describe("paramsDeEscalonCerebroV2", () => {
  it("Haiku 5.5 (anthropic/*) lleva cacheSystemPrompt; Luna lleva su esfuerzo y no el punto de cache", () => {
    expect(paramsDeEscalonCerebroV2({ model: "anthropic/claude-haiku-5.5" }, "low")).toMatchObject({ model: "anthropic/claude-haiku-5.5", cacheSystemPrompt: true });
    const luna = paramsDeEscalonCerebroV2({ model: "openai/gpt-6-luna" }, "low");
    expect(luna).toMatchObject({ model: "openai/gpt-6-luna", reasoningEffort: "low" });
    expect(luna.cacheSystemPrompt).toBeUndefined();
  });
  it("esfuerzo none quita reasoningEffort de Luna (como antes)", () => {
    expect(paramsDeEscalonCerebroV2({ model: "openai/gpt-6-luna", reasoningEffort: "low" }, "none").reasoningEffort).toBeUndefined();
  });
});
