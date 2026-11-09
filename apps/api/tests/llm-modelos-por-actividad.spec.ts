// Modelos por actividad (6-nov-2026): la tabla actividad -> modelos es la fuente unica de verdad, todo rol de produccion tiene actividad
// explicita y NINGUNA superficie (todas tocan datos de clientes u organizaciones) puede quedar configurada con un modelo sin retencion cero
// (ZDR) o premium. Sin red: solo arma rutas y escaleras.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { buildOpenRouterProviderPrefs } from "@atiende/agent-core";
import { IDS_MODELOS_AGENTE, IDS_MODELOS_VOZ_AGENTE, MODELOS_AGENTE, modeloAlternoParaTope } from "@atiende/domain-restaurantes";
import {
  ACTIVIDADES_LLM,
  ALLOWED_PROVIDER_HOSTS,
  DEFAULT_ROLE_ROUTES,
  DEFAULT_ROUTE,
  MODELOS_CON_IMAGEN_PDF,
  VERIFIED_MODEL_HOSTS,
  actividadDeRol,
  motivoNoBarato,
  parseLlmModelsJson,
  resolveRoleRoute,
  routingForModel,
  rungsDeModelosAgente,
  type LlmRouteConfig,
} from "../src/production/llm-models.ts";
import { ALL_PRODUCTION_ROLES, DATA_CHAT_RETRY_ROLES, buildRoleLadder } from "../src/production/llm-gateway.ts";
import { RESUMEN_DIARIO_LLM_ROLE } from "../src/resumen-diario/redaccion.ts";
import { PUBLIC_DEMO_ROLE } from "../src/demo-agents/production.ts";
import { TEST_ENV } from "./fixtures.ts";
import type { ApiEnv } from "../src/env.ts";

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const ROLES_ESCALADOS = ["restaurantes:whatsapp_agent_escalated", "hoteles:whatsapp_agent_escalated", "citas:whatsapp_agent_escalated"];
const TODOS_LOS_ROLES = [...ALL_PRODUCTION_ROLES, ...DATA_CHAT_RETRY_ROLES, ...ROLES_ESCALADOS, RESUMEN_DIARIO_LLM_ROLE, PUBLIC_DEMO_ROLE];
/** Modelos con entrada de audio (architecture.input_modalities de https://openrouter.ai/api/v1/models, 6-nov-2026). */
const ACEPTAN_AUDIO = new Set(["google/gemini-3.5-flash-lite", "google/gemini-3.1-flash-lite", "google/gemini-3.8-flash", "xiaomi/mimo-v2.6-flash"]);

/** La regla que el test hace cumplir: un escalon de una superficie de datos es valido solo si su modelo esta en el registro ZDR, es barato y la
 *  ruta efectiva manda `zdr: true` a proveedores de EE.UU. con endpoint ZDR. Devuelve los problemas (vacio = cumple). */
function problemasDeRuta(route: LlmRouteConfig): string[] {
  const out: string[] = [];
  for (const rung of route.models) {
    const v = VERIFIED_MODEL_HOSTS[rung.model];
    if (!v || !v.zdr || v.hosts.length === 0) out.push(`${rung.model}: sin endpoint ZDR verificado`);
    const caro = motivoNoBarato(rung.model);
    if (caro) out.push(caro);
    try {
      const wire = buildOpenRouterProviderPrefs(routingForModel(route, rung.model, false));
      if (wire.zdr !== true) out.push(`${rung.model}: la ruta no manda zdr=true`);
      if (wire.data_collection !== "deny") out.push(`${rung.model}: data_collection no es deny`);
      for (const h of (wire.only as string[] | undefined) ?? []) if (!ALLOWED_PROVIDER_HOSTS.includes(h) || !v?.hosts.includes(h)) out.push(`${rung.model}: proveedor ${h} fuera de los ZDR de EE.UU.`);
      if (!wire.only || (wire.only as string[]).length === 0) out.push(`${rung.model}: sin "only"`);
    } catch (e) {
      out.push(String((e as Error).message));
    }
  }
  return out;
}

describe("tabla actividad -> modelos (fuente unica)", () => {
  it("todo rol de produccion (y de los gateways dedicados) tiene actividad EXPLICITA y su ruta es la de esa actividad", () => {
    for (const rol of TODOS_LOS_ROLES) {
      const actividad = actividadDeRol(rol);
      expect(actividad, `${rol} sin actividad`).toBeDefined();
      expect(resolveRoleRoute(rol, undefined), rol).toBe(ACTIVIDADES_LLM[actividad!].route);
    }
  });

  it("ninguna actividad ni el default usa un modelo sin ZDR o premium (Sonnet, Gemini 2.5 Flash-Lite, Muse Spark)", () => {
    for (const [actividad, cfg] of Object.entries(ACTIVIDADES_LLM)) expect(problemasDeRuta(cfg.route), actividad).toEqual([]);
    expect(problemasDeRuta(DEFAULT_ROUTE)).toEqual([]);
    for (const [rol, route] of Object.entries(DEFAULT_ROLE_ROUTES)) expect(problemasDeRuta(route), rol).toEqual([]);
    const usados = new Set(Object.values(ACTIVIDADES_LLM).flatMap((a) => a.route.models.map((m) => m.model)));
    for (const prohibido of ["anthropic/claude-sonnet-5.5", "google/gemini-2.5-flash-lite", "meta/muse-spark-1.3"]) expect(usados.has(prohibido), prohibido).toBe(false);
  });

  it("decisiones del dueno intactas: WhatsApp Luna -> Haiku 5.5 y escalado Luna -> Haiku 5.5", () => {
    expect(ACTIVIDADES_LLM.whatsapp_agente.route.models.map((m) => m.model)).toEqual(["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"]);
    expect(ACTIVIDADES_LLM.whatsapp_agente_escalado.route.models.map((m) => m.model)).toEqual(["openai/gpt-6-luna", "anthropic/claude-haiku-5.5"]);
    expect(ACTIVIDADES_LLM.whatsapp_agente.decision).toBe("dueno");
    for (const v of ["restaurantes", "hoteles", "citas"]) expect(resolveRoleRoute(`${v}:whatsapp_agent`, undefined)).toBe(ACTIVIDADES_LLM.whatsapp_agente.route);
  });

  it("la transcripcion solo usa modelos con entrada de audio", () => {
    expect(ACTIVIDADES_LLM.transcripcion_audio.modalidad).toBe("audio");
    for (const m of ACTIVIDADES_LLM.transcripcion_audio.route.models) expect(ACEPTAN_AUDIO.has(m.model), m.model).toBe(true);
  });

  it("la extraccion de menu (imagen/PDF) solo usa modelos con entrada de imagen y PDF, y ninguno sin ella", () => {
    expect(ACTIVIDADES_LLM.extraccion_menu.modalidad).toBe("imagen_pdf");
    for (const m of ACTIVIDADES_LLM.extraccion_menu.route.models) expect(MODELOS_CON_IMAGEN_PDF.has(m.model), m.model).toBe(true);
    expect(resolveRoleRoute("restaurantes:extraccion_menu", undefined)).toBe(ACTIVIDADES_LLM.extraccion_menu.route);
  });

  it("cada actividad tiene principal y respaldo distintos (al menos dos escalones)", () => {
    for (const [actividad, cfg] of Object.entries(ACTIVIDADES_LLM)) {
      expect(cfg.route.models.length, actividad).toBeGreaterThanOrEqual(2);
      expect(new Set(cfg.route.models.map((m) => m.model)).size, actividad).toBe(cfg.route.models.length);
    }
  });
});

describe("la prueba falla si una superficie de datos se configura con un modelo sin ZDR o premium", () => {
  it.each([
    ["anthropic/claude-sonnet-5.5", /premium|baratos/],
    ["google/gemini-2.5-flash-lite", /retencion cero/],
    ["meta/muse-spark-1.3", /retencion cero/],
    ["openai/gpt-6-sol", /premium/],
    ["z-ai/glm-5.3-flash", /no esta en el registro/],
  ])("%s: la regla lo detecta y routingForModel falla cerrado", (model, motivo) => {
    const route: LlmRouteConfig = { models: [{ model }], routing: { allowFallbacks: true } };
    expect(problemasDeRuta(route).join(" ")).toMatch(motivo);
    expect(() => routingForModel(route, model, true)).toThrow();
  });

  it("LLM_MODELS_JSON no puede meter un modelo sin ZDR o premium a ninguna superficie: la ruta se descarta y queda la de la actividad", () => {
    for (const model of ["anthropic/claude-sonnet-5.5", "google/gemini-2.5-flash-lite", "meta/muse-spark-1.3"]) {
      for (const rol of ["superadmin:copiloto", "*:data_chat", "restaurantes:transcripcion", "*:whatsapp_agent"]) {
        const { config, errors } = parseLlmModelsJson(JSON.stringify({ roles: { [rol]: { models: [{ model, temperature: "omit" }] } } }));
        expect(config.roles[rol], `${model} en ${rol}`).toBeUndefined();
        expect(errors.length).toBeGreaterThan(0);
      }
    }
  });

  it("LLM_MODELS_JSON no pisa la decision del dueno en WhatsApp: ni clave exacta, ni \"*:whatsapp_agent\", ni el comodin \"*\"", () => {
    const luna_ds = { models: [{ model: "openai/gpt-6-luna", temperature: "omit" }, { model: "deepseek/deepseek-v4.1-flash", temperature: "omit" }] };
    for (const key of ["*:whatsapp_agent", "restaurantes:whatsapp_agent", "*:whatsapp_agent_escalated"]) {
      const { config, errors } = parseLlmModelsJson(JSON.stringify({ roles: { [key]: luna_ds } }));
      expect(config.roles[key], key).toBeUndefined();
      expect(errors.join(" "), key).toMatch(/decision del dueno/);
    }
    const comodin = parseLlmModelsJson(JSON.stringify({ roles: { "*": luna_ds } })).config;
    for (const v of ["restaurantes", "hoteles", "citas"]) {
      expect(resolveRoleRoute(`${v}:whatsapp_agent`, comodin), v).toBe(ACTIVIDADES_LLM.whatsapp_agente.route);
      expect(resolveRoleRoute(`${v}:whatsapp_agent_escalated`, comodin), v).toBe(ACTIVIDADES_LLM.whatsapp_agente_escalado.route);
    }
    expect(resolveRoleRoute("restaurantes:data_chat", comodin).models.map((m) => m.model)).toEqual(["openai/gpt-6-luna", "deepseek/deepseek-v4.1-flash"]);
  });

  it("LLM_MODELS_JSON no manda el audio a modelos de solo texto: la clave de transcripcion se rechaza y el comodin \"*\" no la alcanza", () => {
    const soloTexto = { models: [{ model: "openai/gpt-6-luna", temperature: "omit" }] };
    const exacta = parseLlmModelsJson(JSON.stringify({ roles: { "restaurantes:transcripcion": soloTexto } }));
    expect(exacta.config.roles["restaurantes:transcripcion"]).toBeUndefined();
    expect(exacta.errors.join(" ")).toMatch(/no acepta audio/);
    const comodin = parseLlmModelsJson(JSON.stringify({ roles: { "*": soloTexto, "*:transcripcion": soloTexto } })).config;
    expect(resolveRoleRoute("restaurantes:transcripcion", comodin)).toBe(ACTIVIDADES_LLM.transcripcion_audio.route);
    const conAudio = parseLlmModelsJson(JSON.stringify({ roles: { "restaurantes:transcripcion": { models: [{ model: "google/gemini-3.5-flash-lite", temperature: "omit" }] } } }));
    expect(conAudio.errors).toEqual([]);
    expect(resolveRoleRoute("restaurantes:transcripcion", conAudio.config).models.map((m) => m.model)).toEqual(["google/gemini-3.5-flash-lite"]);
  });

  it("sin llave de OpenRouter no hay escalera (el legado directo de OpenAI no tiene ZDR): falla cerrado", () => {
    const env: ApiEnv = { ...TEST_ENV, llmProviders: { openai: { apiKey: `t-${randomBytes(6).toString("hex")}`, model: "gpt-test" }, openrouter: null } };
    for (const rol of ["restaurantes:data_chat", "superadmin:copiloto", "restaurantes:whatsapp_agent"]) expect(buildRoleLadder(env, rol, { roles: {} }), rol).toBeUndefined();
  });

  it("con OPENROUTER_ZDR apagado, cada escalon de cada rol sale igual con provider.zdr=true", () => {
    const env: ApiEnv = { ...TEST_ENV, llmProviders: { openai: null, openrouter: { apiKey: `t-${randomBytes(6).toString("hex")}`, countryOfResidence: null, modelsJson: null, zdr: false, sharedBreaker: null } } };
    for (const rol of TODOS_LOS_ROLES) {
      const ladder = buildRoleLadder(env, rol, { roles: {} })!;
      expect(ladder.length, rol).toBeGreaterThan(0);
      for (const p of ladder) expect(problemasDeRuta({ models: [{ model: p.model! }] }), `${rol} ${p.model}`).toEqual([]);
    }
  });
});

describe("panel del agente y CHECK de la base van juntos", () => {
  it("cada modelo elegible en el panel (WhatsApp y cascada de voz) cumple ZDR + barato y tiene escalon", () => {
    expect(rungsDeModelosAgente().map((r) => r.model)).toEqual(MODELOS_AGENTE.map((m) => m.id));
    for (const rung of rungsDeModelosAgente()) expect(problemasDeRuta({ models: [rung] }), rung.model).toEqual([]);
    expect(modeloAlternoParaTope("openai/gpt-6-luna")).toBe("anthropic/claude-haiku-5.5");
    expect(modeloAlternoParaTope("anthropic/claude-haiku-5.5")).toBe("openai/gpt-6-luna");
  });

  it("el CHECK de la migracion 104 lista exactamente los ids del panel (cambiar uno exige migracion nueva)", () => {
    const sql = readFileSync(path.resolve(AQUI, "../../../packages/domain-restaurantes/migrations/104_modelos_agente_zdr_baratos.sql"), "utf8");
    const ids = (col: string) => {
      const c = [...sql.matchAll(new RegExp(`check \\(${col} is null or ${col} in \\(([^)]*)\\)\\)`, "g"))];
      expect(c.length, col).toBe(1);
      return c[0]![1]!.split(",").map((s) => s.trim().replace(/'/g, ""));
    };
    expect(ids("whatsapp_model")).toEqual([...IDS_MODELOS_AGENTE]);
    // La voz solo acepta las filas con vozZdr (ZDR en Vertex/Bedrock/Azure): DeepSeek V4.1 Flash queda fuera del CHECK de voice_cascade_model.
    expect(ids("voice_cascade_model")).toEqual([...IDS_MODELOS_VOZ_AGENTE]);
    expect(IDS_MODELOS_VOZ_AGENTE).not.toContain("deepseek/deepseek-v4.1-flash");
  });
});
