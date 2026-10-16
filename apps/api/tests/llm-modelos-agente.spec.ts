// Modelos que una organizacion puede elegir para su agente: cada uno de la lista permitida cumple la politica de proveedores de EE.UU., tiene precio de
// lista y un escalon coherente con su soporte de temperatura; el gateway de produccion los registra como alternativas del rol de WhatsApp (no de la escalera).
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { LlmGateway, lookupModelPrice } from "@atiende/agent-core";
import { InMemoryTenancyEngine } from "@atiende/db";
import { MODELOS_AGENTE, costoEstimadoModelo } from "@atiende/domain-restaurantes";
import { ALLOWED_PROVIDER_HOSTS, DEFAULT_ROUTE, routingForModel, rungParaModeloAgente, rungsDeModelosAgente } from "../src/production/llm-models.ts";
import { RESTAURANTES_WHATSAPP_AGENT_ROLE, buildAgentModelAlternatives, buildProductionLlmGateway, buildRoleLadder } from "../src/production/llm-gateway.ts";
import { TEST_ENV } from "./fixtures.ts";
import type { ApiEnv } from "../src/env.ts";

const OPENROUTER = { apiKey: `test-${randomBytes(8).toString("hex")}`, countryOfResidence: null, modelsJson: null, zdr: false, sharedBreaker: null };
const env = (llmProviders: ApiEnv["llmProviders"]): ApiEnv => ({ ...TEST_ENV, llmProviders });

describe("lista permitida de modelos del agente vs politica de la plataforma", () => {
  it("cada modelo de la lista tiene escalon, precio de lista y una ruta que respeta la politica de proveedores de EE.UU.", () => {
    expect(rungsDeModelosAgente()).toHaveLength(MODELOS_AGENTE.length);
    for (const m of MODELOS_AGENTE) {
      const rung = rungParaModeloAgente(m.id);
      expect(rung, `escalon de ${m.id}`).toBeDefined();
      expect(lookupModelPrice(m.id), `precio de ${m.id}`).toBeDefined();
      expect(costoEstimadoModelo(m.id, "whatsapp_mensaje").microUsdPorUnidad, m.id).toBeGreaterThan(0);
      const routing = routingForModel(DEFAULT_ROUTE, m.id, false);
      expect(routing.dataCollection).toBe("deny");
      expect(routing.requireParameters).toBe(true);
      expect(routing.only?.length, `proveedores de ${m.id}`).toBeGreaterThan(0);
      for (const host of routing.only ?? []) expect(ALLOWED_PROVIDER_HOSTS, `${m.id} via ${host}`).toContain(host);
    }
  });

  it("la temperatura del escalon coincide con el soporte declarado: habilitada solo donde el modelo la admite, 'omit' donde no", () => {
    for (const m of MODELOS_AGENTE) {
      const rung = rungParaModeloAgente(m.id)!;
      if (m.aceptaTemperatura) expect(rung.temperature, m.id).toBeUndefined();
      else expect(rung.temperature, m.id).toBe("omit");
    }
  });

  it("un id fuera de la lista no tiene escalon", () => {
    expect(rungParaModeloAgente("evil/modelo")).toBeUndefined();
  });
});

describe("registro en el gateway de produccion", () => {
  it("las alternativas del rol de WhatsApp son TODOS los modelos de la lista, con el mismo id de escalon que la escalera (comparten breaker)", () => {
    const alternativas = buildAgentModelAlternatives(env({ openai: null, openrouter: OPENROUTER }), RESTAURANTES_WHATSAPP_AGENT_ROLE, { roles: {} });
    expect(alternativas.map((p) => p.id)).toEqual(MODELOS_AGENTE.map((m) => `openrouter:${m.id}`));
    expect(alternativas.map((p) => p.model)).toEqual(MODELOS_AGENTE.map((m) => m.id));
  });

  it("sin llave de OpenRouter (legado de OpenAI) no hay alternativas: no se puede elegir modelo", () => {
    expect(buildAgentModelAlternatives(env({ openai: { apiKey: "k", model: "gpt-test" }, openrouter: null }), RESTAURANTES_WHATSAPP_AGENT_ROLE, { roles: {} })).toEqual([]);
  });

  it("la escalera por defecto del rol NO cambia (las alternativas no entran a ella) y el gateway se construye", () => {
    const e = env({ openai: null, openrouter: OPENROUTER });
    expect(buildRoleLadder(e, RESTAURANTES_WHATSAPP_AGENT_ROLE, { roles: {} })!.map((p) => p.id)).toEqual([
      "openrouter:openai/gpt-6-luna",
      "openrouter:deepseek/deepseek-v4.1-flash",
      "openrouter:google/gemini-2.5-flash-lite",
      "openrouter:meta/muse-spark-1.3",
    ]);
    expect(buildProductionLlmGateway(e, new InMemoryTenancyEngine())).toBeInstanceOf(LlmGateway);
  });
});
