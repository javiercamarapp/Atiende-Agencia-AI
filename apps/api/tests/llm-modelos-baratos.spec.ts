// CHAT-05: modelos baratos del Copiloto por rol (barato y escalado) con LLM_MODELS_JSON validado, y la escalera actual cuando
// no hay variables. Sin red: solo arma escaleras (nunca llama a `.complete()`).
import { randomBytes } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { DATA_CHAT_RETRY_ROLES, buildRoleLadder, loadLlmModelsConfig } from "../src/production/llm-gateway.ts";
import { DATA_CHAT_RETRY_SUFFIX, ALLOWED_PROVIDER_HOSTS, VERIFIED_MODEL_HOSTS, defaultHostsForModel, parseLlmModelsJson, resolveRoleRoute, routingForModel } from "../src/production/llm-models.ts";
import { TEST_ENV } from "./fixtures.ts";
import type { ApiEnv } from "../src/env.ts";

const VERTICALES = ["restaurantes", "hoteles", "rentas", "despachos", "licitaciones", "citas"];
const OPENROUTER = { apiKey: `test-${randomBytes(8).toString("hex")}`, countryOfResidence: null, modelsJson: null as string | null, zdr: false, sharedBreaker: null };
const envConJson = (modelsJson: string | null): ApiEnv => ({ ...TEST_ENV, llmProviders: { openai: null, openrouter: { ...OPENROUTER, modelsJson } } });

/** Configuracion candidata segun el piloto del 1-oct-2026: DeepSeek V4.1 Flash y Luna como chat, Qwen3-235B y Mistral de respaldo, V4 Pro solo reintento. */
const PILOTO = {
  roles: {
    "*:data_chat": {
      models: [
        { model: "deepseek/deepseek-v4.1-flash", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500 },
        { model: "openai/gpt-6-luna", reasoningEffort: "low", temperature: "omit", minMaxTokens: 1500 },
        { model: "mistralai/mistral-small-3.2-24b-instruct", temperature: "omit" },
      ],
      routing: { allowFallbacks: true },
    },
    [`*:${DATA_CHAT_RETRY_SUFFIX}`]: { models: [{ model: "deepseek/deepseek-v4-pro", reasoningEffort: "medium", temperature: "omit", minMaxTokens: 3000 }] },
  },
};

describe("sin LLM_MODELS_JSON: la escalera actual", () => {
  it("el chat de las 6 verticales usa Luna -> DeepSeek V4.1 Flash -> Gemini 2.5 Flash-Lite -> Muse Spark 1.3 y el reintento DeepSeek V4 Pro", () => {
    for (const env of [envConJson(null), envConJson("")]) {
      const cfg = loadLlmModelsConfig(env);
      expect(cfg).toEqual({ roles: {} });
      for (const v of VERTICALES) {
        expect(buildRoleLadder(env, `${v}:data_chat`, cfg)!.map((p) => p.model)).toEqual(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash", "google/gemini-2.5-flash-lite", "meta/muse-spark-1.3"]);
        expect(buildRoleLadder(env, `${v}:${DATA_CHAT_RETRY_SUFFIX}`, cfg)![0]!.model).toBe("deepseek/deepseek-v4-pro");
      }
    }
  });

  it("hay un rol de reintento por cada rol de chat de datos (las 6 verticales)", () => {
    expect([...DATA_CHAT_RETRY_ROLES].sort()).toEqual(VERTICALES.map((v) => `${v}:data_chat_retry`).sort());
  });
});

describe("LLM_MODELS_JSON: rol barato y rol escalado por entorno", () => {
  const env = envConJson(JSON.stringify(PILOTO));

  it("la configuracion del piloto es valida (cero errores) y cambia SOLO los roles indicados", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = loadLlmModelsConfig(env);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    for (const v of VERTICALES) {
      expect(buildRoleLadder(env, `${v}:data_chat`, cfg)!.map((p) => p.model)).toEqual(["deepseek/deepseek-v4.1-flash", "openai/gpt-6-luna", "mistralai/mistral-small-3.2-24b-instruct"]);
      expect(buildRoleLadder(env, `${v}:${DATA_CHAT_RETRY_SUFFIX}`, cfg)!.map((p) => p.model)).toEqual(["deepseek/deepseek-v4-pro"]);
    }
    // el agente de WhatsApp y el copiloto de superadmin NO cambian
    expect(buildRoleLadder(env, "restaurantes:whatsapp_agent", cfg)![0]!.model).toBe("openai/gpt-6-luna");
    expect(buildRoleLadder(env, "superadmin:copiloto", cfg)![0]!.model).toBe("anthropic/claude-sonnet-5.5");
  });

  it("cada escalon sale por proveedores de EE.UU. permitidos, con ZDR forzado donde existe, data_collection deny y require_parameters", () => {
    const { config } = parseLlmModelsJson(JSON.stringify(PILOTO));
    for (const role of ["restaurantes:data_chat", `restaurantes:${DATA_CHAT_RETRY_SUFFIX}`]) {
      const route = resolveRoleRoute(role, config);
      for (const rung of route.models) {
        const r = routingForModel(route, rung.model, false);
        expect(r.only!.length, rung.model).toBeGreaterThan(0);
        for (const h of r.only!) expect(ALLOWED_PROVIDER_HOSTS, `${rung.model} -> ${h}`).toContain(h);
        expect(r.dataCollection).toBe("deny");
        expect(r.requireParameters).toBe(true);
        // ZDR forzado donde el endpoint lo ofrece (DeepSeek, Mistral...); Luna (OpenAI) lo recibe solo con OPENROUTER_ZDR=1.
        if (VERIFIED_MODEL_HOSTS[rung.model]?.zdr) expect(r.zdr, rung.model).toBe(true);
      }
    }
  });

  it("Mistral Small 3.2 solo puede estrecharse a sus proveedores verificados (DeepInfra, Parasail)", () => {
    const json = (only: string[]) => JSON.stringify({ roles: { "*:data_chat": { models: [{ model: "mistralai/mistral-small-3.2-24b-instruct", temperature: "omit" }], routing: { only } } } });
    expect(parseLlmModelsJson(json(["deepinfra"])).errors).toEqual([]);
    expect(parseLlmModelsJson(json(["deepinfra", "parasail"])).errors).toEqual([]);
    const mal = parseLlmModelsJson(json(["mistral"]));
    expect(mal.errors.join(" ")).toMatch(/fuera de la lista permitida/);
    expect(mal.config.roles["*:data_chat"]).toBeUndefined();
    const noVerificado = parseLlmModelsJson(json(["together"]));
    expect(noVerificado.errors.join(" ")).toMatch(/no estan verificados/);
  });

  it("gpt-oss-120b se enruta a sus proveedores reales (no a openai/azure) y solo se estrecha a ellos", () => {
    expect(defaultHostsForModel("openai/gpt-oss-120b")).toEqual(["deepinfra", "baseten", "coreweave", "amazon-bedrock", "google-vertex"]);
    const json = (only: string[]) => JSON.stringify({ roles: { "*:data_chat": { models: [{ model: "openai/gpt-oss-120b", temperature: "omit" }], routing: { only } } } });
    expect(parseLlmModelsJson(json(["deepinfra"])).errors).toEqual([]);
    expect(parseLlmModelsJson(json(["openai"])).errors.join(" ")).toMatch(/no estan verificados/);
    expect(parseLlmModelsJson(JSON.stringify({ roles: { "*:data_chat": { models: [{ model: "openai/gpt-oss-120b", temperature: "omit" }] } } })).errors).toEqual([]);
  });

  it("Qwen 3.7 Flash, Muse Spark 1.3 (contributor) y Llama 4 Maverick (sin ruta EE.UU./ZDR) se rechazan y el rol conserva la escalera actual", () => {
    for (const model of ["qwen/qwen3.7-flash", "meta/muse-spark-1.3-contributor", "meta-llama/llama-4-maverick"]) {
      const bad = envConJson(JSON.stringify({ roles: { "*:data_chat": { models: [{ model, temperature: "omit" }], routing: { only: ["meta"] } } } }));
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      const cfg = loadLlmModelsConfig(bad);
      expect(spy).toHaveBeenCalledWith(expect.stringContaining("llm_models_json_invalid"));
      spy.mockRestore();
      expect(cfg.roles["*:data_chat"], model).toBeUndefined();
      expect(buildRoleLadder(bad, "restaurantes:data_chat", cfg)![0]!.model, model).toBe("openai/gpt-6-luna");
    }
  });

  it("un JSON con un rol invalido y otro valido: el invalido cae a los defaults y el valido se aplica", () => {
    const mixto = envConJson(
      JSON.stringify({
        roles: {
          "*:data_chat": { models: [{ model: "meta-llama/llama-4-maverick" }] },
          [`*:${DATA_CHAT_RETRY_SUFFIX}`]: { models: [{ model: "deepseek/deepseek-v4-pro", temperature: "omit" }] },
        },
      }),
    );
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const cfg = loadLlmModelsConfig(mixto);
    spy.mockRestore();
    expect(buildRoleLadder(mixto, "hoteles:data_chat", cfg)![0]!.model).toBe("openai/gpt-6-luna");
    expect(buildRoleLadder(mixto, `hoteles:${DATA_CHAT_RETRY_SUFFIX}`, cfg)!.map((p) => p.model)).toEqual(["deepseek/deepseek-v4-pro"]);
  });
});
