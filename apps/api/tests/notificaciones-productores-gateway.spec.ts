// Notificaciones in-app del gateway de LLM (superadmin.llm.modelo_caido y superadmin.costo.ia_umbral): el emisor
// compartido (`emitirNotificacion`) se ejercita con el doble `conEmisiones` (registra core.emit_notification sin base).
// Cubre texto sin PII, clave de dedupe, severidad/enlace del catalogo, throttle por instancia y que un fallo de la
// emision (p. ej. base sin migrar 42883) NUNCA rompa la llamada ni el error de presupuesto.
import { describe, expect, it, vi } from "vitest";
import { CircuitBreaker, InMemoryCircuitBreakerStore, MonthlyBudgetExceededError } from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { buildCircuitBreaker, notificarModeloCaidoBestEffort } from "../src/production/llm-gateway.ts";
import { ProductionOrgMonthlyBudgetStore, notificarTopeIaAgotadoBestEffort } from "../src/production/llm-usage-gateway-adapters.ts";
import { TEST_ENV } from "./fixtures.ts";
import { conEmisiones } from "./support/emisiones.ts";

function motor(alEmitir?: () => number) {
  const sesion = { query: vi.fn(async () => ({ rows: [] })), exec: vi.fn(async () => undefined) };
  const base = { engine: { withAppSession: async (_c: unknown, fn: (s: typeof sesion) => Promise<unknown>) => fn(sesion) } };
  const { deps, emisiones } = conEmisiones(base as unknown as { engine: TenancyEngine }, { alEmitir });
  return { engine: deps.engine, emisiones, sesion };
}

const dia = new Date("2026-10-02T15:00:00Z");

describe("superadmin.llm.modelo_caido", () => {
  it("emite UN aviso de plataforma con el id del modelo (sin PII), clave por modelo y dia, severidad critica y enlace a salud", async () => {
    const { engine, emisiones } = motor();
    await notificarModeloCaidoBestEffort(engine, "openrouter:deepseek/deepseek-v4.1-flash", dia);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "superadmin.llm.modelo_caido",
      organizationId: null,
      severidad: "critica",
      enlace: "/superadmin/salud",
      cuerpo: "Modelo: deepseek:deepseek-v4.1-flash. El gateway pasa al siguiente modelo de la escalera.",
      dedupeKey: "superadmin.llm.modelo_caido:deepseek:deepseek-v4.1-flash:2026-10-02",
    });
  });

  it("si la emision falla (base sin migrar o error de Postgres) NO lanza", async () => {
    const sesion = { query: vi.fn(async () => { throw Object.assign(new Error("function core.emit_notification does not exist"), { code: "42883" }); }), exec: vi.fn(async () => undefined) };
    const engine = { withAppSession: async (_c: unknown, fn: (s: typeof sesion) => Promise<unknown>) => fn(sesion) } as unknown as TenancyEngine;
    await expect(notificarModeloCaidoBestEffort(engine, "openrouter:openai/gpt-6-luna", dia)).resolves.toBeUndefined();
  });

  it("el breaker construido con engine avisa al abrirse (5 fallas) y NO antes; sin engine no emite", async () => {
    const { engine, emisiones } = motor();
    const env = { ...TEST_ENV, llmProviders: { openai: null, openrouter: { apiKey: "k-test", countryOfResidence: null, modelsJson: null, zdr: false, sharedBreaker: null } } };
    const breaker = buildCircuitBreaker(env, engine);
    for (let i = 0; i < 4; i += 1) await breaker.reportFailure("openrouter:qwen/qwen3-235b-a22b-2507", "503");
    expect(emisiones).toHaveLength(0);
    await breaker.reportFailure("openrouter:qwen/qwen3-235b-a22b-2507", "503");
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]!.cuerpo).toContain("qwen:qwen3-235b-a22b-2507");
  });
});

describe("CircuitBreaker.onOpen", () => {
  it("se llama una vez al abrirse con el id del proveedor; un callback que lanza no rompe el breaker", async () => {
    const llamadas: string[] = [];
    const breaker = new CircuitBreaker(new InMemoryCircuitBreakerStore(), {
      failureThreshold: 2,
      onOpen: async (id) => {
        llamadas.push(id);
        throw new Error("boom");
      },
    });
    await breaker.reportFailure("p", "x");
    expect(llamadas).toEqual([]);
    await breaker.reportFailure("p", "x");
    expect(llamadas).toEqual(["p"]);
    expect(await breaker.getBreakerState("p")).toBe("open");
  });
});

describe("superadmin.costo.ia_umbral (tope mensual agotado)", () => {
  it("emite UN aviso de plataforma con porcentaje 100, clave por mes, atencion y enlace a gasto-api", async () => {
    const { engine, emisiones } = motor();
    await notificarTopeIaAgotadoBestEffort(engine, new Set(), dia);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({
      evento: "superadmin.costo.ia_umbral",
      organizationId: null,
      severidad: "atencion",
      enlace: "/superadmin/gasto-api",
      cuerpo: "Uso: 100 por ciento del presupuesto.",
      dedupeKey: "superadmin.costo.ia_umbral:100:2026-10",
    });
  });

  it("throttle por instancia: tras emitir (o dedupe) no abre otra sesion el mismo mes; un fallo se reintenta", async () => {
    const { engine, emisiones } = motor();
    const vistos = new Set<string>();
    await notificarTopeIaAgotadoBestEffort(engine, vistos, dia);
    await notificarTopeIaAgotadoBestEffort(engine, vistos, dia);
    expect(emisiones).toHaveLength(1);
    await notificarTopeIaAgotadoBestEffort(engine, vistos, new Date("2026-11-01T10:00:00Z"));
    expect(emisiones).toHaveLength(2);

    const roto = motor(() => {
      throw Object.assign(new Error("42883"), { code: "42883" });
    });
    const v2 = new Set<string>();
    await expect(notificarTopeIaAgotadoBestEffort(roto.engine, v2, dia)).resolves.toBeUndefined();
    expect(v2.size).toBe(0);
  });

  it("ProductionOrgMonthlyBudgetStore.reserve: al agotarse el tope avisa UNA vez y SIGUE propagando MonthlyBudgetExceededError", async () => {
    const sesionTope = {
      query: vi.fn(async (sql: string) => {
        if (/core\.reserve_llm_monthly_budget/.test(sql)) throw new Error("llm_monthly_budget_exceeded:organization:org-1:500:100");
        return { rows: [] };
      }),
      exec: vi.fn(async () => undefined),
    };
    const base = { withAppSession: async (_c: unknown, fn: (s: typeof sesionTope) => Promise<unknown>) => fn(sesionTope) };
    const { deps, emisiones } = conEmisiones({ engine: base } as unknown as { engine: TenancyEngine });
    const store = new ProductionOrgMonthlyBudgetStore(deps.engine);
    await expect(store.reserve("org-1", "r1", 500)).rejects.toBeInstanceOf(MonthlyBudgetExceededError);
    await expect(store.reserve("org-1", "r2", 500)).rejects.toBeInstanceOf(MonthlyBudgetExceededError);
    expect(emisiones).toHaveLength(1);
    expect(emisiones[0]).toMatchObject({ evento: "superadmin.costo.ia_umbral", organizationId: null });
  });
});
