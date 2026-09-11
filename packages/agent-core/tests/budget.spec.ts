import { describe, expect, it } from "vitest";
import { createInMemoryLaneBudgetTracker, createRunBudget } from "../src/gateway/budget.ts";
import type { AgentLane } from "../src/gateway/router.ts";
import { laneKey } from "../src/gateway/router.ts";

const LANE: AgentLane = { organizationId: "org-1", vertical: "hoteles", role: "canal" };

describe("createRunBudget", () => {
  it("agotado() es false hasta que una dimensión configurada llega a su tope", () => {
    const budget = createRunBudget({ maxTokens: 100 });
    expect(budget.agotado()).toBe(false);
    budget.registrarTokens(60, 30);
    expect(budget.agotado()).toBe(false);
    budget.registrarTokens(5, 5);
    expect(budget.agotado()).toBe(true);
  });

  it("remainingUsd/remainingTokens/remainingMs son undefined cuando esa dimensión no tiene límite configurado", () => {
    const budget = createRunBudget({});
    expect(budget.remainingUsd()).toBeUndefined();
    expect(budget.remainingTokens()).toBeUndefined();
    expect(budget.remainingMs()).toBeUndefined();
  });

  it("registrarCostoUsd descuenta de remainingUsd y nunca baja de 0", () => {
    const budget = createRunBudget({ maxUsd: 1 });
    budget.registrarCostoUsd(0.6);
    expect(budget.remainingUsd()).toBeCloseTo(0.4);
    budget.registrarCostoUsd(10);
    expect(budget.remainingUsd()).toBe(0);
    expect(budget.agotado()).toBe(true);
  });

  it("remainingMs usa el reloj inyectable, sin depender de temporizadores reales", () => {
    let now = 0;
    const budget = createRunBudget({ maxMs: 1000 }, () => now);
    expect(budget.remainingMs()).toBe(1000);
    now = 400;
    expect(budget.remainingMs()).toBe(600);
    now = 1500;
    expect(budget.remainingMs()).toBe(0);
    expect(budget.agotado()).toBe(true);
  });
});

describe("createInMemoryLaneBudgetTracker", () => {
  it("un carril sin límite configurado nunca está agotado", async () => {
    const tracker = createInMemoryLaneBudgetTracker({});
    expect(await tracker.agotado(LANE)).toBe(false);
    expect(await tracker.remainingUsd(LANE)).toBeUndefined();
  });

  it("acumula costo y se agota al alcanzar el límite del carril", async () => {
    const tracker = createInMemoryLaneBudgetTracker({ [laneKey(LANE)]: { maxUsdPerDay: 5 } });
    await tracker.registrarCostoUsd(LANE, 3);
    expect(await tracker.agotado(LANE)).toBe(false);
    expect(await tracker.remainingUsd(LANE)).toBe(2);
    await tracker.registrarCostoUsd(LANE, 2);
    expect(await tracker.agotado(LANE)).toBe(true);
    expect(await tracker.remainingUsd(LANE)).toBe(0);
  });

  it("usa el límite MÁS ESTRICTO entre maxUsdPerDay y maxUsdPerMonth", async () => {
    const tracker = createInMemoryLaneBudgetTracker({ [laneKey(LANE)]: { maxUsdPerDay: 2, maxUsdPerMonth: 50 } });
    await tracker.registrarCostoUsd(LANE, 2);
    expect(await tracker.agotado(LANE)).toBe(true);
  });

  it("dos carriles distintos (roles distintos) tienen presupuestos independientes", async () => {
    const otherLane: AgentLane = { ...LANE, role: "batch_nocturno" };
    const tracker = createInMemoryLaneBudgetTracker({ [laneKey(LANE)]: { maxUsdPerDay: 1 } });
    await tracker.registrarCostoUsd(LANE, 1);
    expect(await tracker.agotado(LANE)).toBe(true);
    expect(await tracker.agotado(otherLane)).toBe(false);
  });
});
