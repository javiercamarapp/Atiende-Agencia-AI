// CHAT-07 / MOD-12: adaptadores de produccion del gateway (reserva con rol y avisos al 80 %, tope diario por rol, ventana de respaldos).
// Doble de sesion que responde las funciones SQL nuevas; `conEmisiones` registra core.emit_notification sin base. Incluye la base SIN migrar
// (42883): cada camino cae al anterior sin lanzar.
import { describe, expect, it, vi } from "vitest";
import { MonthlyBudgetExceededError, RoleDailyTurnLimitExceededError } from "@atiende/agent-core";
import type { TenancyEngine } from "@atiende/core-tenancy";
import {
  BanderaConTtl,
  FALLBACK_VENTANA_MIN_LLAMADAS,
  ProductionLlmUsageRecorder,
  ProductionOrgMonthlyBudgetStore,
  ProductionRoleDailyTurnStore,
  claveAvisoFallback,
  clavesAvisoUmbral,
  fallbackSuperaUmbral,
} from "../src/production/llm-usage-gateway-adapters.ts";
import { defaultRoleDailyTurnLimit } from "../src/production/llm-role-limits.ts";
import { conEmisiones } from "./support/emisiones.ts";

type Responder = (sql: string, params: unknown[]) => { rows: unknown[] } | Promise<{ rows: unknown[] }>;

function motor(responder: Responder) {
  const sesiones: string[] = [];
  const sesion = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      sesiones.push(sql);
      return responder(sql, params);
    }),
    exec: vi.fn(async () => undefined),
  };
  const base = { engine: { withAppSession: async (_c: unknown, fn: (s: typeof sesion) => Promise<unknown>) => fn(sesion) } };
  const { deps, emisiones } = conEmisiones(base as unknown as { engine: TenancyEngine });
  return { engine: deps.engine, emisiones, sesion, sql: sesiones };
}

const sinMigrar = () => Object.assign(new Error("function core.reserve_llm_monthly_budget(uuid, unknown, integer, unknown) does not exist"), { code: "42883" });
const ahora = new Date("2026-10-02T15:30:00Z");

describe("BanderaConTtl (base sin migrar)", () => {
  it("queda activa solo durante el TTL: despues se vuelve a intentar (las instancias calientes recuperan la 0047 sin reciclarse)", () => {
    let t = 1_000;
    const b = new BanderaConTtl(60_000, () => t);
    expect(b.activa).toBe(false);
    b.marcar();
    expect(b.activa).toBe(true);
    t += 59_999;
    expect(b.activa).toBe(true);
    t += 2;
    expect(b.activa).toBe(false);
  });
});

describe("funciones puras de avisos", () => {
  it("clavesAvisoUmbral: 80 % exacto de la organizacion y/o de la plataforma, una clave por organizacion/mes y una de plataforma/mes", () => {
    const t = (o: number, p: number) => ({ orgTotalMicroUsd: o, orgCapMicroUsd: 100, platformTotalMicroUsd: p, platformCapMicroUsd: 1000 });
    expect(clavesAvisoUmbral("org-1", t(79, 100), ahora)).toEqual([]);
    expect(clavesAvisoUmbral("org-1", t(80, 100), ahora)).toEqual(["org:org-1:80:2026-10"]);
    expect(clavesAvisoUmbral("org-1", t(10, 800), ahora)).toEqual(["plataforma:80:2026-10"]);
    expect(clavesAvisoUmbral("org-1", t(95, 900), ahora)).toEqual(["org:org-1:80:2026-10", "plataforma:80:2026-10"]);
  });

  it("fallbackSuperaUmbral: exige muestra minima y MAS del 5 %", () => {
    expect(fallbackSuperaUmbral(FALLBACK_VENTANA_MIN_LLAMADAS - 1, FALLBACK_VENTANA_MIN_LLAMADAS - 1)).toBe(false);
    expect(fallbackSuperaUmbral(100, 5)).toBe(false); // exactamente 5 %
    expect(fallbackSuperaUmbral(100, 6)).toBe(true);
    expect(claveAvisoFallback(ahora)).toBe("2026-10-02T15");
  });

  it("topes por defecto: Copiloto y roles nuevos de plataforma tienen tope; los agentes de WhatsApp no", () => {
    expect(defaultRoleDailyTurnLimit("hoteles:data_chat")).toBe(400);
    expect(defaultRoleDailyTurnLimit("hoteles:data_chat_retry")).toBe(100);
    expect(defaultRoleDailyTurnLimit("plataforma:enrutador_turno")).toBeGreaterThan(0);
    expect(defaultRoleDailyTurnLimit("reportes:analisis_general")).toBe(40);
    expect(defaultRoleDailyTurnLimit("hoteles:whatsapp_agent")).toBeUndefined();
  });
});

describe("ProductionOrgMonthlyBudgetStore: reserva con rol y aviso al 80 %", () => {
  const totales = (o: number, p = 10) => ({ rows: [{ org_total_micro_usd: String(o), org_cap_micro_usd: "100", platform_total_micro_usd: String(p), platform_cap_micro_usd: "1000" }] });

  it("al llegar al 80 % de la organizacion emite UN aviso (sin PII, clave por organizacion/mes/umbral); reservas posteriores no repiten", async () => {
    const m = motor((sql) => (/reserve_llm_monthly_budget/.test(sql) ? totales(85) : { rows: [] }));
    const store = new ProductionOrgMonthlyBudgetStore(m.engine);
    await store.reserve("org-1", "r1", 5, "hoteles:data_chat");
    await store.reserve("org-1", "r2", 5, "hoteles:data_chat");
    await store.reserve("org-1", "r3", 5, "hoteles:data_chat");
    expect(m.emisiones).toHaveLength(1);
    expect(m.emisiones[0]).toMatchObject({
      evento: "superadmin.costo.ia_umbral",
      organizationId: null,
      cuerpo: "Uso: 80 por ciento del presupuesto.",
      enlace: "/superadmin/consumo-ia",
    });
    expect(m.emisiones[0]!.dedupeKey).toMatch(/^superadmin\.costo\.ia_umbral:org:org-1:80:\d{4}-\d{2}$/);
    // Otra organizacion al 85 % genera su propio aviso.
    await store.reserve("org-2", "r4", 5, "hoteles:data_chat");
    expect(m.emisiones).toHaveLength(2);
  });

  it("al 79 % no avisa; el tope de plataforma al 80 % avisa por separado", async () => {
    const bajo = motor((sql) => (/reserve_llm_monthly_budget/.test(sql) ? totales(79) : { rows: [] }));
    await new ProductionOrgMonthlyBudgetStore(bajo.engine).reserve("org-1", "r1", 5, "hoteles:data_chat");
    expect(bajo.emisiones).toHaveLength(0);
    const plat = motor((sql) => (/reserve_llm_monthly_budget/.test(sql) ? totales(10, 800) : { rows: [] }));
    await new ProductionOrgMonthlyBudgetStore(plat.engine).reserve("org-1", "r1", 5, "hoteles:data_chat");
    expect(plat.emisiones).toHaveLength(1);
    expect(plat.emisiones[0]!.dedupeKey).toMatch(/^superadmin\.costo\.ia_umbral:plataforma:80:/);
  });

  it("el subtope del Copiloto lanza MonthlyBudgetExceededError(copilot) SIN el aviso de tope agotado", async () => {
    const m2 = motor((sql) => {
      if (/reserve_llm_monthly_budget/.test(sql)) throw new Error("llm_monthly_budget_exceeded:copilot:org-1:301:300");
      return { rows: [] };
    });
    await expect(new ProductionOrgMonthlyBudgetStore(m2.engine).reserve("org-1", "r1", 5, "hoteles:data_chat")).rejects.toMatchObject({ scope: "copilot", limitMicroUsd: 300 });
    expect(m2.emisiones).toHaveLength(0);
  });

  it("base SIN migrar (42883 en la reserva con rol): cae a la de 3 argumentos, sin lanzar, y no reintenta la de 4 en cada llamada", async () => {
    const m = motor((sql, params) => {
      if (/reserve_llm_monthly_budget\(\$1, \$2, \$3, \$4\)/.test(sql)) throw sinMigrar();
      void params;
      return { rows: [] };
    });
    const store = new ProductionOrgMonthlyBudgetStore(m.engine);
    await expect(store.reserve("org-1", "r1", 5, "hoteles:data_chat")).resolves.toBeUndefined();
    await expect(store.reserve("org-1", "r2", 5, "hoteles:data_chat")).resolves.toBeUndefined();
    expect(m.sql.filter((s) => /\$4\)/.test(s) && /reserve_llm/.test(s))).toHaveLength(1);
    expect(m.sql.filter((s) => /reserve_llm_monthly_budget\(\$1, \$2, \$3\)/.test(s))).toHaveLength(2);
    expect(m.emisiones).toHaveLength(0);
  });

  it("un tope de organizacion agotado sigue lanzando MonthlyBudgetExceededError(organization) con el aviso del 100 %", async () => {
    const m = motor((sql) => {
      if (/reserve_llm_monthly_budget/.test(sql)) throw new Error("llm_monthly_budget_exceeded:organization:org-1:500:100");
      return { rows: [] };
    });
    await expect(new ProductionOrgMonthlyBudgetStore(m.engine).reserve("org-1", "r1", 500, "hoteles:data_chat")).rejects.toBeInstanceOf(MonthlyBudgetExceededError);
    expect(m.emisiones).toHaveLength(1);
  });
});

describe("ProductionRoleDailyTurnStore", () => {
  it("permitido: no lanza; rechazado: RoleDailyTurnLimitExceededError con lo usado y el tope", async () => {
    let permitido = true;
    const m = motor((sql, params) => {
      expect(sql).toMatch(/consume_llm_role_turn/);
      expect(params).toEqual(["org-1", "hoteles:data_chat", 400]);
      return { rows: [{ allowed: permitido, used: permitido ? 7 : 30, max_turnos: permitido ? 400 : 30 }] };
    });
    const store = new ProductionRoleDailyTurnStore(m.engine);
    await expect(store.consume("org-1", "hoteles:data_chat")).resolves.toBeUndefined();
    permitido = false;
    const err = await store.consume("org-1", "hoteles:data_chat").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(RoleDailyTurnLimitExceededError);
    expect(err).toMatchObject({ used: 30, maxTurns: 30, role: "hoteles:data_chat", organizationId: "org-1" });
  });

  it("un rol sin tope por defecto no toca la base", async () => {
    const m = motor(() => ({ rows: [] }));
    await new ProductionRoleDailyTurnStore(m.engine).consume("org-1", "hoteles:whatsapp_agent");
    expect(m.sesion.query).not.toHaveBeenCalled();
  });

  it("base SIN migrar (42883) o caida: FAIL-OPEN (no lanza); la sin migrar no se reintenta en cada llamada", async () => {
    const m = motor(() => {
      throw sinMigrar();
    });
    const store = new ProductionRoleDailyTurnStore(m.engine);
    await expect(store.consume("org-1", "hoteles:data_chat")).resolves.toBeUndefined();
    await expect(store.consume("org-1", "hoteles:data_chat")).resolves.toBeUndefined();
    expect(m.sesion.query).toHaveBeenCalledTimes(1);
    const caida = motor(() => {
      throw new Error("ECONNRESET");
    });
    const spy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(new ProductionRoleDailyTurnStore(caida.engine).consume("org-1", "hoteles:data_chat")).resolves.toBeUndefined();
    spy.mockRestore();
  });
});

describe("ProductionLlmUsageRecorder: ventana horaria de respaldos", () => {
  const evento = (fallbackUsed: boolean) => ({
    organizationId: "org-1",
    vertical: "hoteles",
    role: "hoteles:data_chat",
    lane: "interactive" as const,
    providerId: "openrouter:a",
    model: "a",
    tokensIn: 1,
    tokensOut: 1,
    costMicroUsd: 1,
    fallbackUsed,
    occurredAt: ahora.toISOString(),
  });

  it("avisa UNA vez por hora cuando mas del 5 % cayo a respaldo (con muestra minima); sin avisar por debajo del umbral", async () => {
    let calls = 0;
    let fb = 0;
    const m = motor((sql, params) => {
      if (/record_llm_hour_window/.test(sql)) {
        calls += 1;
        if (params[0] === true) fb += 1;
        return { rows: [{ calls, fallbacks: fb }] };
      }
      return { rows: [] };
    });
    const rec = new ProductionLlmUsageRecorder(m.engine);
    for (let i = 0; i < 30; i += 1) await rec.record(evento(i === 0)); // 1 de 30 = 3,3 %
    expect(m.emisiones).toHaveLength(0);
    for (let i = 0; i < 5; i += 1) await rec.record(evento(true)); // 6 de 35 = 17 %
    expect(m.emisiones).toHaveLength(1);
    expect(m.emisiones[0]).toMatchObject({ evento: "superadmin.llm.fallback_alto", organizationId: null, enlace: "/superadmin/consumo-ia" });
    expect(m.emisiones[0]!.cuerpo).toMatch(/^En la última hora, \d+ por ciento/);
    for (let i = 0; i < 5; i += 1) await rec.record(evento(true));
    expect(m.emisiones).toHaveLength(1);
  });

  it("base SIN migrar: el registro de uso sigue funcionando y la ventana se deja de intentar", async () => {
    const m = motor((sql) => {
      if (/record_llm_hour_window/.test(sql)) throw sinMigrar();
      return { rows: [] };
    });
    const rec = new ProductionLlmUsageRecorder(m.engine);
    await rec.record(evento(false));
    await rec.record(evento(true));
    expect(m.sql.filter((s) => /record_llm_hour_window/.test(s))).toHaveLength(1);
    expect(m.sql.filter((s) => /record_llm_usage/.test(s)).length).toBeGreaterThanOrEqual(2);
    expect(m.emisiones).toHaveLength(0);
  });
});
