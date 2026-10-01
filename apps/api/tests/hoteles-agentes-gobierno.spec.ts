// H-03 -- gobierno del agente de WhatsApp de hoteles en el cableado de produccion: kill switch por property,
// presupuesto mensual propio y costo por agente. Gateway REAL (LlmGateway + FakeLlmProvider) y repos en memoria;
// la compatibilidad con la base sin migrar (SAVEPOINT) la cubre packages/domain-hoteles/tests/agentes/gobernanza.spec.ts.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CircuitBreaker, FakeLlmProvider, InMemoryBudgetLedgerStore, InMemoryCircuitBreakerStore, LlmGateway } from "@atiende/agent-core";
import { InMemoryAgentesRepository, InMemoryHotelesRepository } from "@atiende/domain-hoteles";
import { hoyFechaNegocio } from "@atiende/core-tenancy";
import { buildApp } from "../src/app.ts";
import { buildGovernedHotelesTurnHandler } from "../src/production/hoteles-agentes-gobierno.ts";
import { runRateRecommendationSweep } from "../src/routes/verticals/hoteles/revenue-recommendations-cron.ts";
import { buildHotelesTestContext } from "./hoteles-fixtures.ts";

const NOW = new Date("2026-10-05T12:00:00Z");

function setup(opts: { migrated?: boolean } = {}) {
  let llmCalls = 0;
  const gateway = new LlmGateway({
    breaker: new CircuitBreaker(new InMemoryCircuitBreakerStore()),
    budgetStore: new InMemoryBudgetLedgerStore(),
    budgetLimits: { maxRunUsd: 10, maxTenantDailyUsd: 100 },
  });
  gateway.registerLadder("default", [new FakeLlmProvider({ id: "p", script: () => { llmCalls += 1; return { text: "Hola, con gusto te ayudo.", model: "fake", tokensIn: 120, tokensOut: 30, costUsd: 0.0015 }; } })]);
  gateway.registerLadder("escalated", [new FakeLlmProvider({ id: "e" })]);
  const hoteles = new InMemoryHotelesRepository();
  const agentes = new InMemoryAgentesRepository(opts);
  const organizationId = randomUUID();
  const propertyId = randomUUID();
  const errors: unknown[] = [];
  const handler = buildGovernedHotelesTurnHandler({ hoteles, agentes, gateway, defaultRole: "default", escalatedRole: "escalated", now: () => NOW, onError: (e) => errors.push(e) });
  const turn = () => handler.handleInboundMessage({ organizationId, propertyId, phone: "+5219990000000", messages: [{ role: "user", content: "hola" }] });
  return { agentes, hoteles, propertyId, turn, calls: () => llmCalls, errors };
}

describe("agente de recepcion (WhatsApp) gobernado por property", () => {
  it("activo: responde con el LLM y acumula el costo por agente del mes", async () => {
    const s = setup();
    expect((await s.turn()).reply).toBe("Hola, con gusto te ayudo.");
    expect((await s.turn()).reply).toBe("Hola, con gusto te ayudo.");
    expect(s.calls()).toBe(2);
    const usage = (await s.agentes.listAgentConfig(s.propertyId, "2026-10")).usage[0]!;
    expect(usage).toMatchObject({ agentKey: "recepcion_whatsapp", tokensIn: 240, tokensOut: 60, costMicroUsd: 3000, callCount: 2 });
  });

  it("kill switch: pausado NO llama al LLM y deriva a una persona (el huesped recibe un acuse, el mensaje no se pierde)", async () => {
    const s = setup();
    await s.agentes.updateAgentConfig(s.propertyId, "recepcion_whatsapp", { enabled: false, pausedReason: "Revision de costos del mes" });
    const result = await s.turn();
    expect(s.calls()).toBe(0);
    expect(result.reply).toMatch(/Alguien del hotel/);
    expect(result.fnbOrderId).toBeNull();
    // reanudar vuelve a correr el agente
    await s.agentes.updateAgentConfig(s.propertyId, "recepcion_whatsapp", { enabled: true });
    expect((await s.turn()).reply).toBe("Hola, con gusto te ayudo.");
  });

  it("presupuesto propio agotado (gasto == tope) detiene el LLM; otro agente de la property no se afecta", async () => {
    const s = setup();
    await s.agentes.updateAgentConfig(s.propertyId, "recepcion_whatsapp", { budgetMicroUsd: 3000 });
    await s.turn();
    await s.turn(); // gasto acumulado = 3000 = tope
    expect(s.calls()).toBe(2);
    expect((await s.turn()).reply).toMatch(/Alguien del hotel/);
    expect(s.calls()).toBe(2);
    expect((await s.agentes.gate(s.propertyId, "revenue", "2026-10"))?.enabled).toBe(true);
  });

  it("base SIN migrar 035: el agente corre como siempre (comportamiento previo) y no revienta al registrar costo", async () => {
    const s = setup({ migrated: false });
    expect((await s.turn()).reply).toBe("Hola, con gusto te ayudo.");
    expect(s.calls()).toBe(1);
    expect(s.errors.length).toBeGreaterThan(0); // el registro de costo falla de forma recuperable y se reporta
  });
});

describe("agente de revenue: kill switch por property en el barrido de recomendaciones", () => {
  function addDaysIso(fechaIso: string, days: number): string {
    const d = new Date(`${fechaIso}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  it("pausado: el barrido omite la property ('agente_pausado') y NO genera recomendaciones; reanudado vuelve a calcular", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    const fecha = addDaysIso(hoyFechaNegocio(), 10);
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);

    await ctx.agentesRepo.updateAgentConfig(ctx.propertyId, "revenue", { enabled: false, pausedReason: "Pausa por auditoria de tarifas" });
    const paused = (await runRateRecommendationSweep(ctx.deps)).find((r) => r.propertyId === ctx.propertyId)!;
    expect(paused).toMatchObject({ skippedReason: "agente_pausado", insertadas: 0, error: null });
    expect(await ctx.hotelesRepo.listRateRecommendations(ctx.propertyId, { limit: 10 })).toHaveLength(0);

    await ctx.agentesRepo.updateAgentConfig(ctx.propertyId, "revenue", { enabled: true });
    const resumed = (await runRateRecommendationSweep(ctx.deps)).find((r) => r.propertyId === ctx.propertyId)!;
    expect(resumed).toMatchObject({ skippedReason: null, insertadas: 1 });
  });

  it("un fallo al leer la compuerta es fail-open: el barrido sigue calculando", async () => {
    const ctx = await buildHotelesTestContext(buildApp);
    ctx.hotelesRepo.seedRevenueGate(ctx.propertyId, ctx.organizationId, { gate: "shadow" });
    const fecha = addDaysIso(hoyFechaNegocio(), 10);
    ctx.hotelesRepo.seedNightlyRates(ctx.propertyId, ctx.roomTypeId, [{ date: fecha, price: 2000, minStay: 1, closedToArrival: false, closedToDeparture: false }]);
    ctx.agentesRepo.gate = async () => { throw new Error("lectura rota"); };
    const r = (await runRateRecommendationSweep(ctx.deps)).find((x) => x.propertyId === ctx.propertyId)!;
    expect(r).toMatchObject({ skippedReason: null, insertadas: 1, error: null });
  });
});
