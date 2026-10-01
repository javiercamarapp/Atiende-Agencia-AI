// buildProductionLlmGateway — verifica el criterio FAIL-CLOSED explícito (ver
// apps/api/src/production/llm-gateway.ts): sin ninguna API key de proveedor
// configurada, `undefined`; con al menos una, un `LlmGateway` real. Esta prueba
// NUNCA invoca `.complete()` sobre el gateway resultante -- eso dispararía una
// llamada de red real contra OpenAI/OpenRouter con credenciales de
// mentira, exactamente lo que este cambio tiene prohibido hacer en pruebas (ver
// los turn-handler specs de cada vertical para la cobertura real de
// tool-calling, que usan `FakeLlmProvider`, nunca los adaptadores reales).
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { InMemoryCircuitBreakerStore, LlmGateway, RedisCircuitBreakerStore } from "@atiende/agent-core";
import { InMemoryTenancyEngine } from "@atiende/db";
import { ALL_PRODUCTION_ROLES, RESTAURANTES_DATA_CHAT_ROLE, buildBreakerStore, buildProductionLlmGateway, buildRoleLadder, loadLlmModelsConfig } from "../src/production/llm-gateway.ts";
import { TEST_ENV } from "./fixtures.ts";
import type { ApiEnv } from "../src/env.ts";

// Llaves generadas en tiempo de ejecucion: ningun literal con forma de credencial.
const fakeKey = (): string => `test-${randomBytes(8).toString("hex")}`;
const OPENROUTER = { apiKey: fakeKey(), countryOfResidence: null, modelsJson: null, zdr: false, sharedBreaker: null };

function envWith(llmProviders: ApiEnv["llmProviders"]): ApiEnv {
  return { ...TEST_ENV, llmProviders };
}

// `engine` solo alimenta el registro de uso/tope mensual (ver
// ./llm-usage-gateway-adapters.ts) -- ninguna prueba de este archivo invoca
// `.complete()`, así que un `InMemoryTenancyEngine` vacío basta: nunca se abre
// una sesión real.
function fakeEngine(): InMemoryTenancyEngine {
  return new InMemoryTenancyEngine();
}

describe("buildProductionLlmGateway", () => {
  it("sin NINGUNA API key de proveedor configurada, devuelve undefined -- nunca finge un gateway funcional", () => {
    const gateway = buildProductionLlmGateway(envWith({ openai: null, openrouter: null }), fakeEngine());
    expect(gateway).toBeUndefined();
  });

  it("con SOLO OPENROUTER_API_KEY (sin modelo: los modelos salen de la tabla por rol), construye un LlmGateway real", () => {
    const gateway = buildProductionLlmGateway(envWith({ openai: null, openrouter: OPENROUTER }), fakeEngine());
    expect(gateway).toBeInstanceOf(LlmGateway);
  });

  it("con solo el proveedor LEGADO de OpenAI (API key + modelo) construye un LlmGateway real", () => {
    const gateway = buildProductionLlmGateway(envWith({ openai: { apiKey: fakeKey(), model: "gpt-5.6-test" }, openrouter: null }), fakeEngine());
    expect(gateway).toBeInstanceOf(LlmGateway);
  });

  it("con OpenRouter Y OpenAI legado, la escalera usa SOLO OpenRouter (proveedor unico por defecto)", () => {
    const env = envWith({ openai: { apiKey: fakeKey(), model: "gpt-5.6-test" }, openrouter: OPENROUTER });
    const ladder = buildRoleLadder(env, "restaurantes:data_chat", { roles: {} })!;
    expect(ladder.map((p) => p.id)).toEqual([
      "openrouter:openai/gpt-6-luna",
      "openrouter:deepseek/deepseek-v4.1-flash",
      "openrouter:google/gemini-2.5-flash-lite",
      "openrouter:meta/muse-spark-1.3",
    ]);
  });

  it("cada rol de produccion recibe su escalera; el copiloto de superadmin usa Claude Sonnet 5.5 primero y los reportes Gemini 3.8 Flash", () => {
    const env = envWith({ openai: null, openrouter: OPENROUTER });
    for (const role of ALL_PRODUCTION_ROLES) expect(buildRoleLadder(env, role, { roles: {} })!.length).toBeGreaterThan(0);
    expect(buildRoleLadder(env, "superadmin:copiloto", { roles: {} })![0]!.model).toBe("anthropic/claude-sonnet-5.5");
    expect(buildRoleLadder(env, "plataforma:resumen_diario", { roles: {} })![0]!.model).toBe("google/gemini-3.8-flash");
  });

  it("LLM_MODELS_JSON cambia el modelo de un rol sin tocar codigo; un JSON invalido se ignora con error estructurado", () => {
    const json = JSON.stringify({ roles: { "*:data_chat": { models: [{ model: "google/gemini-3.8-flash", temperature: "omit" }] } } });
    const env = envWith({ openai: null, openrouter: { ...OPENROUTER, modelsJson: json } });
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const ladder = buildRoleLadder(env, RESTAURANTES_DATA_CHAT_ROLE, loadLlmModelsConfig(env))!;
    expect(ladder.map((p) => p.model)).toEqual(["google/gemini-3.8-flash"]);
    expect(spy).not.toHaveBeenCalled();

    const bad = envWith({ openai: null, openrouter: { ...OPENROUTER, modelsJson: "{no es json" } });
    const ladderBad = buildRoleLadder(bad, RESTAURANTES_DATA_CHAT_ROLE, loadLlmModelsConfig(bad))!;
    expect(ladderBad[0]!.model).toBe("openai/gpt-6-luna");
    expect(spy).toHaveBeenCalledWith(expect.stringContaining("llm_models_json_invalid"));
    spy.mockRestore();
  });

  it("sin Upstash el breaker es en memoria; con Upstash es el Redis compartido", () => {
    expect(buildBreakerStore(envWith({ openai: null, openrouter: OPENROUTER }))).toBeInstanceOf(InMemoryCircuitBreakerStore);
    const shared = { url: "http://localhost:0", token: fakeKey() };
    expect(buildBreakerStore(envWith({ openai: null, openrouter: { ...OPENROUTER, sharedBreaker: shared } }))).toBeInstanceOf(RedisCircuitBreakerStore);
  });
});
