// Autopiloto 2: aviso al DUEÑO (restaurantes) del presupuesto de IA al 80 % y al agotarse (100 %). Convive con el aviso de superadmin (no lo reemplaza).
// Solo organizaciones de restaurantes (la base responde si lo es); texto sin PII; una por umbral y mes; nunca altera la reserva ni lanza.
import { describe, expect, it, vi } from "vitest";
import { MonthlyBudgetExceededError } from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";
import { BanderaConTtl, ProductionOrgMonthlyBudgetStore, notificarPresupuestoIaDuenioBestEffort } from "../src/production/llm-usage-gateway-adapters.ts";
import { conEmisiones } from "./support/emisiones.ts";

type Responder = (sql: string, params: unknown[]) => { rows: unknown[] };

function motor(responder: Responder) {
  const sql: string[] = [];
  const sesion = {
    query: vi.fn(async (texto: string, params: unknown[] = []) => {
      sql.push(texto);
      return responder(texto, params);
    }),
    exec: vi.fn(async () => undefined),
  };
  const base = { engine: { withAppSession: async (_c: unknown, fn: (s: typeof sesion) => Promise<unknown>) => fn(sesion) } };
  const { deps, emisiones } = conEmisiones(base as unknown as { engine: TenancyEngine });
  return { engine: deps.engine, emisiones, sql };
}

const totales = (o: number) => ({ rows: [{ org_total_micro_usd: String(o), org_cap_micro_usd: "100", platform_total_micro_usd: "10", platform_cap_micro_usd: "1000" }] });
const esRestaurantes = (valor: boolean | Error): Responder => (sql, params) => {
  void params;
  if (/es_organizacion_restaurantes/.test(sql)) {
    if (valor instanceof Error) throw valor;
    return { rows: [{ es: valor }] };
  }
  if (/reserve_llm_monthly_budget/.test(sql)) return totales(85);
  return { rows: [] };
};
const ahora = new Date("2026-10-04T15:30:00Z");

describe("aviso al dueño: presupuesto de IA al 80 %", () => {
  it("organizacion de restaurantes: ademas del aviso de superadmin emite UNO al dueño, sin PII, severidad del catalogo, enlace relativo y clave por umbral y mes", async () => {
    const m = motor(esRestaurantes(true));
    const store = new ProductionOrgMonthlyBudgetStore(m.engine);
    await store.reserve("org-1", "r1", 5, "restaurantes:whatsapp_agent");
    await store.reserve("org-1", "r2", 5, "restaurantes:whatsapp_agent");
    const duenio = m.emisiones.filter((e) => e.evento === "restaurantes.ia.presupuesto_umbral");
    expect(duenio).toHaveLength(1);
    expect(duenio[0]).toMatchObject({
      organizationId: "org-1",
      severidad: "atencion",
      titulo: "El presupuesto de IA llegó al 80 por ciento este mes",
      enlace: "/restaurantes/{orgSlug}/configuracion",
    });
    expect(duenio[0]!.cuerpo).toContain("el agente deja de responder con IA");
    expect(`${duenio[0]!.titulo} ${duenio[0]!.cuerpo}`).not.toMatch(/@|\d{8,}/);
    expect(duenio[0]!.dedupeKey).toMatch(/^restaurantes\.ia\.presupuesto_umbral:80:\d{4}-\d{2}$/);
    // El aviso de superadmin sigue saliendo.
    expect(m.emisiones.filter((e) => e.evento === "superadmin.costo.ia_umbral")).toHaveLength(1);
  });

  it("organizacion de OTRO vertical (la base dice false): NO hay aviso al dueño de restaurantes", async () => {
    const m = motor(esRestaurantes(false));
    await new ProductionOrgMonthlyBudgetStore(m.engine).reserve("org-hotel", "r1", 5, "hoteles:data_chat");
    expect(m.emisiones.filter((e) => e.evento === "restaurantes.ia.presupuesto_umbral")).toEqual([]);
  });

  it("al 79 % no avisa", async () => {
    const m = motor((sql) => (/reserve_llm_monthly_budget/.test(sql) ? totales(79) : { rows: [{ es: true }] }));
    await new ProductionOrgMonthlyBudgetStore(m.engine).reserve("org-1", "r1", 5, "restaurantes:whatsapp_agent");
    expect(m.emisiones.filter((e) => e.evento === "restaurantes.ia.presupuesto_umbral")).toEqual([]);
  });
});

describe("aviso al dueño: tope de la organizacion agotado (100 %)", () => {
  it("emite UN aviso critico al dueño con porcentaje 100 y SIGUE propagando MonthlyBudgetExceededError", async () => {
    const m = motor((sql) => {
      if (/reserve_llm_monthly_budget/.test(sql)) throw new Error("llm_monthly_budget_exceeded:organization:org-1:500:100");
      if (/es_organizacion_restaurantes/.test(sql)) return { rows: [{ es: true }] };
      return { rows: [] };
    });
    const store = new ProductionOrgMonthlyBudgetStore(m.engine);
    await expect(store.reserve("org-1", "r1", 500, "restaurantes:whatsapp_agent")).rejects.toBeInstanceOf(MonthlyBudgetExceededError);
    await expect(store.reserve("org-1", "r2", 500, "restaurantes:whatsapp_agent")).rejects.toBeInstanceOf(MonthlyBudgetExceededError);
    const duenio = m.emisiones.filter((e) => e.evento === "restaurantes.ia.presupuesto_umbral");
    expect(duenio).toHaveLength(1);
    expect(duenio[0]).toMatchObject({ organizationId: "org-1", severidad: "critica", titulo: "El presupuesto de IA llegó al 100 por ciento este mes" });
    expect(duenio[0]!.dedupeKey).toMatch(/^restaurantes\.ia\.presupuesto_umbral:100:\d{4}-\d{2}$/);
  });

  it("el tope de PLATAFORMA agotado no se le atribuye al dueño de una organizacion", async () => {
    const m = motor((sql) => {
      if (/reserve_llm_monthly_budget/.test(sql)) throw new Error("llm_monthly_budget_exceeded:platform:org-1:500:100");
      if (/es_organizacion_restaurantes/.test(sql)) return { rows: [{ es: true }] };
      return { rows: [] };
    });
    await expect(new ProductionOrgMonthlyBudgetStore(m.engine).reserve("org-1", "r1", 500, "restaurantes:whatsapp_agent")).rejects.toBeInstanceOf(MonthlyBudgetExceededError);
    expect(m.emisiones.filter((e) => e.evento === "restaurantes.ia.presupuesto_umbral")).toEqual([]);
  });
});

describe("notificarPresupuestoIaDuenioBestEffort: nunca lanza ni altera la reserva", () => {
  it("base sin la 052 (42883 en es_organizacion_restaurantes): no emite, no lanza y se reintenta en la siguiente reserva", async () => {
    const sinMigrar = Object.assign(new Error("function restaurantes.es_organizacion_restaurantes(uuid) does not exist"), { code: "42883" });
    const m = motor(esRestaurantes(sinMigrar));
    const recordado = new Set<string>();
    await expect(notificarPresupuestoIaDuenioBestEffort(m.engine, recordado, "org-1", 80, ahora)).resolves.toBeUndefined();
    expect(m.emisiones).toEqual([]);
    expect(recordado.size).toBe(0);
    await notificarPresupuestoIaDuenioBestEffort(m.engine, recordado, "org-1", 80, ahora);
    expect(m.sql.filter((s) => /es_organizacion_restaurantes/.test(s))).toHaveLength(2);
  });

  it("con la bandera con TTL: tras un no_disponible no abre mas sesiones hasta que vence el TTL", async () => {
    const sinMigrar = Object.assign(new Error("function restaurantes.es_organizacion_restaurantes(uuid) does not exist"), { code: "42883" });
    const m = motor(esRestaurantes(sinMigrar));
    let reloj = 1_000;
    const bandera = new BanderaConTtl(60_000, () => reloj);
    await notificarPresupuestoIaDuenioBestEffort(m.engine, new Set(), "org-1", 80, ahora, bandera);
    await notificarPresupuestoIaDuenioBestEffort(m.engine, new Set(), "org-1", 80, ahora, bandera);
    expect(m.sql.filter((s) => /es_organizacion_restaurantes/.test(s))).toHaveLength(1);
    reloj += 61_000;
    await notificarPresupuestoIaDuenioBestEffort(m.engine, new Set(), "org-1", 80, ahora, bandera);
    expect(m.sql.filter((s) => /es_organizacion_restaurantes/.test(s))).toHaveLength(2);
  });

  it("un error inesperado de la base tampoco lanza", async () => {
    const m = motor(esRestaurantes(Object.assign(new Error("falla interna"), { code: "XX000" })));
    await expect(notificarPresupuestoIaDuenioBestEffort(m.engine, new Set(), "org-1", 100, ahora)).resolves.toBeUndefined();
    expect(m.emisiones).toEqual([]);
  });
});
