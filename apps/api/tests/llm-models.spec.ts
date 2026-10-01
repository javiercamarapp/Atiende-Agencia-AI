// Tabla rol -> modelos del gateway: defaults seguros, validacion de LLM_MODELS_JSON y resolucion.
import { describe, expect, it } from "vitest";
import {
  ALLOWED_PROVIDER_HOSTS,
  DATA_CHAT_RETRY_SUFFIX,
  DEFAULT_ROLE_ROUTES,
  DEFAULT_ROUTE,
  EVAL_CHALLENGERS,
  NEW_PLATFORM_LLM_ROLES,
  SUPERADMIN_COPILOTO_ROLE,
  VERIFIED_MODEL_HOSTS,
  parseLlmModelsJson,
  resolveRoleRoute,
  resolveRungHosts,
  routingForModel,
} from "../src/production/llm-models.ts";
import { ALL_PRODUCTION_ROLES } from "../src/production/llm-gateway.ts";
import { buildOpenRouterProviderPrefs, lookupModelPrice } from "@atiende/agent-core";


const CHINESE_LABS = ["deepseek", "qwen", "alibaba", "z-ai", "zhipu", "moonshotai", "minimax", "baidu", "tencent", "bytedance", "bytedance-seed", "xiaomi", "stepfun", "01-ai", "meituan", "inclusionai"];
const isChinese = (model: string): boolean => CHINESE_LABS.includes(model.split("/")[0]!);
const allRoutes = [DEFAULT_ROUTE, ...Object.values(DEFAULT_ROLE_ROUTES)];

describe("defaults versionados de rol -> modelos", () => {
  it("todos los modelos por defecto tienen precio de respaldo y proveedores permitidos de EE.UU.", () => {
    for (const route of allRoutes) {
      for (const rung of route.models) {
        expect(lookupModelPrice(rung.model), `sin precio: ${rung.model}`).toBeDefined();
        const r = routingForModel(route, rung.model, false);
        expect(r.only!.length, rung.model).toBeGreaterThan(0);
        for (const host of r.only!) expect(ALLOWED_PROVIDER_HOSTS, `${rung.model} -> ${host}`).toContain(host);
      }
    }
  });

  it("chat de las 6 verticales: Luna (low) -> DeepSeek V4.1 Flash -> Gemini 2.5 Flash-Lite -> Muse Spark 1.3", () => {
    expect(DEFAULT_ROUTE.models.map((m) => m.model)).toEqual(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash", "google/gemini-2.5-flash-lite", "meta/muse-spark-1.3"]);
    expect(DEFAULT_ROUTE.models[0]).toMatchObject({ reasoningEffort: "low" });
  });

  it("reintento por guardia de cifras = DeepSeek V4 Pro; CFO/superadmin = Sonnet 5.5 con respaldo DeepSeek V4 Pro", () => {
    expect(resolveRoleRoute(`restaurantes:${DATA_CHAT_RETRY_SUFFIX}`, undefined).models[0]!.model).toBe("deepseek/deepseek-v4-pro");
    expect(resolveRoleRoute(`citas:${DATA_CHAT_RETRY_SUFFIX}`, undefined).models[0]!.model).toBe("deepseek/deepseek-v4-pro");
    expect(DEFAULT_ROLE_ROUTES[SUPERADMIN_COPILOTO_ROLE]!.models.map((m) => m.model)).toEqual(["anthropic/claude-sonnet-5.5", "deepseek/deepseek-v4-pro"]);
  });

  it("reportes: analisis financiero con Sonnet 5.5, no financiero con Qwen3-235B; redaccion separada por tipo con Gemini 3.8 Flash", () => {
    expect(resolveRoleRoute("reportes:analisis_financiero", undefined).models[0]!.model).toBe("anthropic/claude-sonnet-5.5");
    expect(resolveRoleRoute("reportes:analisis_general", undefined).models[0]!.model).toBe("qwen/qwen3-235b-a22b-2507");
    expect(resolveRoleRoute("reportes:redaccion_financiero", undefined).models[0]!.model).toBe("google/gemini-3.8-flash");
    expect(resolveRoleRoute("reportes:redaccion_general", undefined).models[0]!.model).toBe("google/gemini-3.8-flash");
    expect(DEFAULT_ROLE_ROUTES["plataforma:resumen_diario"]!.models[0]!.model).toBe("google/gemini-3.8-flash");
    for (const role of NEW_PLATFORM_LLM_ROLES) expect(DEFAULT_ROLE_ROUTES[role], role).toBeDefined();
  });

  it("los modelos que no listan `temperature` en OpenRouter NUNCA la reciben (omit): con require_parameters dejaria la ruta sin endpoints", () => {
    for (const route of allRoutes) for (const rung of route.models) expect(rung.temperature, rung.model).toBe("omit");
  });

  it("los modelos de laboratorios chinos de los defaults salen SOLO por proveedores de EE.UU. con ZDR, data_collection deny y require_parameters", () => {
    const chinese = new Set(allRoutes.flatMap((r) => r.models.map((m) => m.model)).filter(isChinese));
    expect([...chinese].sort()).toEqual(["deepseek/deepseek-v4-pro", "deepseek/deepseek-v4.1-flash", "qwen/qwen3-235b-a22b-2507"]);
    for (const model of chinese) {
      const wire = buildOpenRouterProviderPrefs(routingForModel(DEFAULT_ROUTE, model, false));
      expect(wire, model).toMatchObject({ data_collection: "deny", require_parameters: true, zdr: true });
      expect((wire.only as string[]).length, model).toBeGreaterThan(0);
      for (const host of wire.only as string[]) expect(ALLOWED_PROVIDER_HOSTS).toContain(host);
      expect(wire.only, model).toEqual([...VERIFIED_MODEL_HOSTS[model]!.hosts]);
    }
    expect(buildOpenRouterProviderPrefs(routingForModel(DEFAULT_ROUTE, "deepseek/deepseek-v4.1-flash", false)).only).not.toContain("deepseek");
  });

  it("ningun default usa Qwen 3.7 Flash ni un modelo sin proveedor de EE.UU. verificado (hoy solo Alibaba lo sirve)", () => {
    const prod = new Set(allRoutes.flatMap((r) => r.models.map((m) => m.model)));
    expect(prod.has("qwen/qwen3.7-flash")).toBe(false);
    expect(VERIFIED_MODEL_HOSTS["qwen/qwen3.7-flash"]!.hosts).toEqual([]);
    for (const c of EVAL_CHALLENGERS) {
      expect(c.enabled).toBe(false);
      expect(prod.has(c.model)).toBe(false);
    }
  });

  it("cada rol de produccion resuelve a una ruta con al menos un modelo", () => {
    for (const role of ALL_PRODUCTION_ROLES) expect(resolveRoleRoute(role, undefined).models.length).toBeGreaterThan(0);
  });

  it("routingForModel restringe a la infraestructura del laboratorio y aplica ZDR global solo si se pide", () => {
    expect(routingForModel(DEFAULT_ROUTE, "openai/gpt-6-luna", false)).toMatchObject({ only: ["openai", "azure"], zdr: undefined, dataCollection: "deny", requireParameters: true });
    expect(routingForModel(DEFAULT_ROUTE, "google/gemini-2.5-flash-lite", true)).toMatchObject({ only: ["google-ai-studio", "google-vertex"], zdr: true });
    expect(routingForModel({ models: [], routing: { only: ["azure"] } }, "openai/gpt-6-luna", false).only).toEqual(["azure"]);
  });

  it("routingForModel no relaja la politica ni con un routing construido a mano (ni data_collection, ni require_parameters, ni zdr, ni only)", () => {
    const hostile = { models: [], routing: { dataCollection: "allow", requireParameters: false, zdr: false, only: [] } } as const;
    expect(() => routingForModel(hostile as never, "deepseek/deepseek-v4.1-flash", false)).not.toThrow();
    const r = routingForModel(hostile as never, "deepseek/deepseek-v4.1-flash", false);
    expect(r).toMatchObject({ dataCollection: "deny", requireParameters: true, zdr: true });
    expect(r.only).toEqual([...VERIFIED_MODEL_HOSTS["deepseek/deepseek-v4.1-flash"]!.hosts]);
    expect(() => routingForModel(DEFAULT_ROUTE, "qwen/qwen3.7-flash", false)).toThrow(/no tiene hoy un proveedor/);
  });
});

describe("politica de proveedores (allowlist)", () => {
  it("resolveRungHosts: sin proveedor de EE.UU. verificado rechaza con un error claro", () => {
    const r = resolveRungHosts("qwen/qwen3.7-flash", undefined);
    expect(r).toMatchObject({ error: expect.stringMatching(/Alibaba/) });
  });

  it("un modelo sin laboratorio conocido exige `only` explicito dentro de la lista permitida", () => {
    expect(resolveRungHosts("mistralai/mistral-small-3.2", undefined)).toMatchObject({ error: expect.stringMatching(/debe fijar "only"/) });
    expect(resolveRungHosts("mistralai/mistral-small-3.2", ["deepinfra"])).toEqual({ hosts: ["deepinfra"] });
    expect(resolveRungHosts("mistralai/mistral-small-3.2", ["mistral"])).toMatchObject({ error: expect.stringMatching(/fuera de la lista permitida/) });
  });

  it("un modelo verificado solo puede ESTRECHAR sus proveedores", () => {
    expect(resolveRungHosts("deepseek/deepseek-v4.1-flash", ["together"])).toEqual({ hosts: ["together"] });
    expect(resolveRungHosts("deepseek/deepseek-v4.1-flash", ["azure"])).toMatchObject({ error: expect.stringMatching(/no estan verificados/) });
    expect(resolveRungHosts("deepseek/deepseek-v4.1-flash", ["deepseek"])).toMatchObject({ error: expect.stringMatching(/fuera de la lista permitida/) });
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

  const route = (routing: unknown, model = "deepseek/deepseek-v4.1-flash") => JSON.stringify({ roles: { "*:data_chat": { models: [{ model, temperature: "omit" }], ...(routing ? { routing } : {}) } } });

  it("acepta un modelo chino SOLO con proveedores de EE.UU. verificados (por defecto y estrechando)", () => {
    expect(parseLlmModelsJson(route(undefined)).errors).toEqual([]);
    expect(parseLlmModelsJson(route({ only: ["deepinfra", "together"] })).errors).toEqual([]);
    expect(parseLlmModelsJson(route(undefined, "qwen/qwen3-235b-a22b-2507")).errors).toEqual([]);
    expect(parseLlmModelsJson(route(undefined, "deepseek/deepseek-v4-pro")).errors).toEqual([]);
  });

  it("rechaza un modelo sin proveedor de EE.UU. verificado (Qwen 3.7 Flash) con un error claro, y la ruta cae a los defaults", () => {
    const { config, errors } = parseLlmModelsJson(route(undefined, "qwen/qwen3.7-flash"));
    expect(config.roles["*:data_chat"]).toBeUndefined();
    expect(errors.join(" ")).toMatch(/qwen\/qwen3\.7-flash.*no tiene hoy un proveedor con servidores en EE\.UU\./);
    expect(resolveRoleRoute("restaurantes:data_chat", config)).toBe(DEFAULT_ROUTE);
  });

  it("rechaza proveedores de laboratorios chinos o fuera de la lista en `only` (DeepSeek directo, Alibaba, Novita...)", () => {
    for (const host of ["deepseek", "alibaba", "novita", "siliconflow", "baidu"]) {
      const { config, errors } = parseLlmModelsJson(route({ only: [host] }));
      expect(config.roles["*:data_chat"], host).toBeUndefined();
      expect(errors.join(" "), host).toMatch(/fuera de la lista permitida/);
    }
    const mixed = parseLlmModelsJson(route({ only: ["deepinfra", "alibaba"] }));
    expect(mixed.config.roles["*:data_chat"]).toBeUndefined();
  });

  it("no se puede quitar `only` (lista vacia) ni mandar a un proveedor no verificado para ese modelo", () => {
    const empty = parseLlmModelsJson(route({ only: [] }));
    expect(empty.config.roles["*:data_chat"]).toBeUndefined();
    expect(empty.errors.join(" ")).toMatch(/"only" no puede quedar vacio/);
    const wrongHost = parseLlmModelsJson(route({ only: ["azure"] }));
    expect(wrongHost.errors.join(" ")).toMatch(/no estan verificados/);
  });

  it("un modelo de un laboratorio desconocido exige `only` permitido: sin el, se rechaza", () => {
    const { errors } = parseLlmModelsJson(route(undefined, "z-ai/glm-5.3-flash"));
    expect(errors.join(" ")).toMatch(/debe fijar "only"/);
    expect(parseLlmModelsJson(route({ only: ["together"] }, "z-ai/glm-5.3-flash")).errors).toEqual([]);
    const effective = routingForModel({ models: [], routing: { only: ["together"] } }, "z-ai/glm-5.3-flash", false);
    expect(effective).toMatchObject({ only: ["together"], zdr: true, dataCollection: "deny" });
  });

  it("no se puede desactivar `requireParameters`", () => {
    const { config, errors } = parseLlmModelsJson(route({ requireParameters: false }, "openai/gpt-6-luna"));
    expect(config.roles["*:data_chat"]).toBeUndefined();
    expect(errors.join(" ")).toMatch(/requireParameters/);
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
