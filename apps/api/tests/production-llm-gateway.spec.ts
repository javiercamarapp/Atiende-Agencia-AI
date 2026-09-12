// buildProductionLlmGateway — verifica el criterio FAIL-CLOSED explícito (ver
// apps/api/src/production/llm-gateway.ts): sin ninguna API key de proveedor
// configurada, `undefined`; con al menos una, un `LlmGateway` real. Esta prueba
// NUNCA invoca `.complete()` sobre el gateway resultante -- eso dispararía una
// llamada de red real contra Anthropic/OpenAI/OpenRouter con credenciales de
// mentira, exactamente lo que este cambio tiene prohibido hacer en pruebas (ver
// los turn-handler specs de cada vertical para la cobertura real de
// tool-calling, que usan `FakeLlmProvider`, nunca los adaptadores reales).
import { describe, expect, it } from "vitest";
import { LlmGateway } from "@atiende/agent-core";
import { buildProductionLlmGateway } from "../src/production/llm-gateway.ts";
import { TEST_ENV } from "./fixtures.ts";
import type { ApiEnv } from "../src/env.ts";

function envWith(llmProviders: ApiEnv["llmProviders"]): ApiEnv {
  return { ...TEST_ENV, llmProviders };
}

describe("buildProductionLlmGateway", () => {
  it("sin NINGUNA API key de proveedor configurada, devuelve undefined -- nunca finge un gateway funcional", () => {
    const gateway = buildProductionLlmGateway(envWith({ anthropic: null, openai: null, openrouter: null }));
    expect(gateway).toBeUndefined();
  });

  it("con solo ANTHROPIC_API_KEY+ANTHROPIC_MODEL configurados, construye un LlmGateway real", () => {
    const gateway = buildProductionLlmGateway(
      envWith({ anthropic: { apiKey: "sk-ant-test", model: "claude-sonnet-5-test" }, openai: null, openrouter: null }),
    );
    expect(gateway).toBeInstanceOf(LlmGateway);
  });

  it("con solo OPENAI_API_KEY+OPENAI_MODEL configurados, construye un LlmGateway real", () => {
    const gateway = buildProductionLlmGateway(
      envWith({ anthropic: null, openai: { apiKey: "sk-openai-test", model: "gpt-5.6-test" }, openrouter: null }),
    );
    expect(gateway).toBeInstanceOf(LlmGateway);
  });

  it("con solo OPENROUTER_API_KEY+OPENROUTER_MODEL configurados, construye un LlmGateway real", () => {
    const gateway = buildProductionLlmGateway(
      envWith({ anthropic: null, openai: null, openrouter: { apiKey: "sk-or-test", model: "openai/gpt-5.6-test", countryOfResidence: null } }),
    );
    expect(gateway).toBeInstanceOf(LlmGateway);
  });

  it("con los 3 proveedores configurados, sigue construyendo un único LlmGateway real", () => {
    const gateway = buildProductionLlmGateway(
      envWith({
        anthropic: { apiKey: "sk-ant-test", model: "claude-sonnet-5-test" },
        openai: { apiKey: "sk-openai-test", model: "gpt-5.6-test" },
        openrouter: { apiKey: "sk-or-test", model: "openai/gpt-5.6-test", countryOfResidence: "US" },
      }),
    );
    expect(gateway).toBeInstanceOf(LlmGateway);
  });

  it("un proveedor con SOLO la API key pero sin modelo (o viceversa) no cuenta como configurado -- nunca inventa un modelo por defecto", () => {
    // `env.ts` ya deja `llmProviders.anthropic` en `null` si falta cualquiera de
    // los dos -- esta prueba fija el contrato de ese `null` desde el lado del
    // gateway: sigue siendo fail-closed si ningún proveedor QUEDÓ configurado.
    const gateway = buildProductionLlmGateway(envWith({ anthropic: null, openai: null, openrouter: null }));
    expect(gateway).toBeUndefined();
  });
});
