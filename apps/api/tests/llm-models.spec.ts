// Tabla rol -> modelos del gateway: defaults seguros, validacion de LLM_MODELS_JSON y resolucion.
import { describe, expect, it } from "vitest";
import {
  BLOCKED_MODEL_AUTHORS,
  DEFAULT_ROLE_ROUTES,
  DEFAULT_ROUTE,
  EVAL_CHALLENGERS,
  SUPERADMIN_COPILOTO_ROLE,
  isBlockedModel,
  parseLlmModelsJson,
  resolveRoleRoute,
  routingForModel,
} from "../src/production/llm-models.ts";
import { ALL_PRODUCTION_ROLES } from "../src/production/llm-gateway.ts";
import { lookupModelPrice } from "@atiende/agent-core";

const allDefaultRoutes = [DEFAULT_ROUTE, ...Object.values(DEFAULT_ROLE_ROUTES)];

describe("defaults versionados de rol -> modelos", () => {
  it("ningun modelo por defecto es de un laboratorio chino y todos tienen precio de respaldo", () => {
    for (const route of allDefaultRoutes) {
      for (const rung of route.models) {
        expect(isBlockedModel(rung.model), rung.model).toBe(false);
        expect(lookupModelPrice(rung.model), `sin precio: ${rung.model}`).toBeDefined();
      }
    }
  });

  it("primario GPT-6 Luna (razonamiento low) con respaldo Gemini 3.5 Flash-Lite; CFO Claude Sonnet 5.5; reportes Gemini 3.8 Flash", () => {
    expect(DEFAULT_ROUTE.models.map((m) => m.model)).toEqual(["openai/gpt-6-luna", "google/gemini-3.5-flash-lite"]);
    expect(DEFAULT_ROUTE.models[0]).toMatchObject({ reasoningEffort: "low" });
    expect(DEFAULT_ROLE_ROUTES[SUPERADMIN_COPILOTO_ROLE]!.models[0]!.model).toBe("anthropic/claude-sonnet-5.5");
    expect(DEFAULT_ROLE_ROUTES["plataforma:resumen_diario"]!.models[0]!.model).toBe("google/gemini-3.8-flash");
  });

  it("los modelos que no listan `temperature` en OpenRouter NUNCA la reciben (omit): con require_parameters dejaria la ruta sin endpoints", () => {
    for (const route of allDefaultRoutes) for (const rung of route.models) expect(rung.temperature, rung.model).toBe("omit");
  });

  it("los retadores de evals estan apagados y ninguna ruta de produccion los usa", () => {
    const prod = new Set(allDefaultRoutes.flatMap((r) => r.models.map((m) => m.model)));
    for (const c of EVAL_CHALLENGERS) {
      expect(c.enabled).toBe(false);
      expect(prod.has(c.model)).toBe(false);
    }
  });

  it("cada rol de produccion resuelve a una ruta con al menos un modelo", () => {
    for (const role of ALL_PRODUCTION_ROLES) expect(resolveRoleRoute(role, undefined).models.length).toBeGreaterThan(0);
  });

  it("routingForModel restringe a la infraestructura del laboratorio y aplica ZDR global solo si se pide", () => {
    expect(routingForModel(DEFAULT_ROUTE, "openai/gpt-6-luna", false)).toMatchObject({ only: ["openai", "azure"], zdr: undefined });
    expect(routingForModel(DEFAULT_ROUTE, "google/gemini-3.5-flash-lite", true)).toMatchObject({ only: ["google-ai-studio", "google-vertex"], zdr: true });
    expect(routingForModel({ models: [], routing: { only: ["azure"] } }, "openai/gpt-6-luna", false).only).toEqual(["azure"]);
  });
});

describe("parseLlmModelsJson", () => {
  const ok = { roles: { "*:data_chat": { models: [{ model: "openai/gpt-6-sol", reasoningEffort: "medium", temperature: "omit", maxTokens: 2000 }], routing: { zdr: true, only: ["openai"] } } } };

  it("vacio o ausente: sin sobreescrituras y sin errores", () => {
    expect(parseLlmModelsJson(undefined)).toEqual({ config: { roles: {} }, errors: [] });
    expect(parseLlmModelsJson("  ")).toEqual({ config: { roles: {} }, errors: [] });
  });

  it("acepta una ruta valida y la resuelve: clave exacta > *:sufijo > * > defaults", () => {
    const { config, errors } = parseLlmModelsJson(JSON.stringify(ok));
    expect(errors).toEqual([]);
    expect(resolveRoleRoute("restaurantes:data_chat", config).models[0]!.model).toBe("openai/gpt-6-sol");
    expect(resolveRoleRoute("hoteles:data_chat", config).routing).toEqual({ zdr: true, only: ["openai"] });
    expect(resolveRoleRoute("hoteles:whatsapp_agent", config)).toBe(DEFAULT_ROUTE);
    const exact = parseLlmModelsJson(JSON.stringify({ roles: { ...ok.roles, "restaurantes:data_chat": { models: [{ model: "google/gemini-3.8-flash" }] }, "*": { models: [{ model: "openai/gpt-6-luna" }] } } })).config;
    expect(resolveRoleRoute("restaurantes:data_chat", exact).models[0]!.model).toBe("google/gemini-3.8-flash");
    expect(resolveRoleRoute("hoteles:whatsapp_agent", exact).models[0]!.model).toBe("openai/gpt-6-luna");
  });

  it("rechaza modelos de laboratorios chinos (por cualquier via de configuracion)", () => {
    for (const author of BLOCKED_MODEL_AUTHORS) {
      const { config, errors } = parseLlmModelsJson(JSON.stringify({ roles: { "*": { models: [{ model: `${author}/algun-modelo` }] } } }));
      expect(config.roles["*"], author).toBeUndefined();
      expect(errors.join(" "), author).toMatch(/no permitido/);
    }
  });

  it("no permite relajar la privacidad: dataCollection solo acepta deny", () => {
    const bad = parseLlmModelsJson(JSON.stringify({ roles: { "*": { models: [{ model: "openai/gpt-6-luna" }], routing: { dataCollection: "allow" } } } }));
    expect(bad.config.roles["*"]).toBeUndefined();
    expect(bad.errors.join(" ")).toMatch(/dataCollection/);
    const good = parseLlmModelsJson(JSON.stringify({ roles: { "*": { models: [{ model: "openai/gpt-6-luna" }], routing: { dataCollection: "deny" } } } }));
    expect(good.errors).toEqual([]);
  });

  it("una ruta invalida se descarta completa sin afectar a las validas; nunca lanza", () => {
    const raw = JSON.stringify({
      roles: {
        "*:data_chat": ok.roles["*:data_chat"],
        "*:otro": { models: [{ model: "no-es-un-id" }] },
        "Rol Invalido": { models: [{ model: "openai/gpt-6-luna" }] },
        "*:vacio": { models: [] },
        "*:esfuerzo": { models: [{ model: "openai/gpt-6-luna", reasoningEffort: "ultra" }] },
      },
    });
    const { config, errors } = parseLlmModelsJson(raw);
    expect(Object.keys(config.roles)).toEqual(["*:data_chat"]);
    expect(errors.length).toBe(4);
    expect(parseLlmModelsJson("{mal").errors).toEqual(["LLM_MODELS_JSON no es JSON valido"]);
    expect(parseLlmModelsJson("[]").errors.length).toBe(1);
  });
});
