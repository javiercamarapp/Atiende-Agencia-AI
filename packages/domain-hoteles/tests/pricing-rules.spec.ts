import { describe, expect, it } from "vitest";
import { PricingRulesError, DEFAULT_PRICING_RULES, assertValidPricingRules, applyPricingRules } from "../src/revenue/pricingRules.ts";
import type { PricingRules } from "../src/revenue/pricingRules.ts";

const RULES: PricingRules = {
  floorPrice: 1000,
  ceilingPrice: 3000,
  dayOfWeekMultiplier: [1.0, 0.9, 0.9, 0.9, 0.9, 1.2, 1.3], // dom..sab
  minStayOnHighDemand: 3,
  minStayDefault: 1,
};

describe("assertValidPricingRules", () => {
  it("acepta el default", () => {
    expect(() => assertValidPricingRules(DEFAULT_PRICING_RULES)).not.toThrow();
  });

  it("rechaza ceiling < floor", () => {
    expect(() => assertValidPricingRules({ ...RULES, ceilingPrice: 500 })).toThrow(/rango_invertido/);
  });

  it("rechaza multiplicador con menos de 7 valores", () => {
    expect(() => assertValidPricingRules({ ...RULES, dayOfWeekMultiplier: [1, 1, 1] as unknown as PricingRules["dayOfWeekMultiplier"] })).toThrow(/multiplicador_invalido/);
  });

  it("rechaza minStayOnHighDemand menor que minStayDefault", () => {
    expect(() => assertValidPricingRules({ ...RULES, minStayDefault: 3, minStayOnHighDemand: 1 })).toThrow(/min_stay_alta_demanda_invalido/);
  });
});

describe("applyPricingRules", () => {
  it("2026-06-06 es sábado: aplica multiplicador de sábado (1.3)", () => {
    const r = applyPricingRules(RULES, { fecha: "2026-06-06", rawSuggestedPrice: 1500, esAltaDemanda: false });
    expect(r.dayOfWeekMultiplierApplied).toBe(1.3);
    expect(r.afterDayOfWeekMultiplier).toBeCloseTo(1950, 5);
    expect(r.finalPrice).toBeCloseTo(1950, 5);
    expect(r.clampedByCeiling).toBe(false);
    expect(r.clampedByFloor).toBe(false);
  });

  it("acota por ceiling cuando el resultado excede el máximo del owner", () => {
    const r = applyPricingRules(RULES, { fecha: "2026-06-06", rawSuggestedPrice: 2800, esAltaDemanda: false });
    expect(r.afterDayOfWeekMultiplier).toBeGreaterThan(3000);
    expect(r.finalPrice).toBe(3000);
    expect(r.clampedByCeiling).toBe(true);
  });

  it("acota por floor cuando el resultado cae debajo del mínimo del owner", () => {
    const r = applyPricingRules(RULES, { fecha: "2026-06-08", rawSuggestedPrice: 900, esAltaDemanda: false }); // lunes, multiplicador 0.9
    expect(r.finalPrice).toBe(1000);
    expect(r.clampedByFloor).toBe(true);
  });

  it("sugiere LOS de alta demanda cuando esAltaDemanda=true", () => {
    const r = applyPricingRules(RULES, { fecha: "2026-06-06", rawSuggestedPrice: 1500, esAltaDemanda: true });
    expect(r.suggestedMinStay).toBe(3);
  });

  it("sugiere LOS default cuando esAltaDemanda=false", () => {
    const r = applyPricingRules(RULES, { fecha: "2026-06-06", rawSuggestedPrice: 1500, esAltaDemanda: false });
    expect(r.suggestedMinStay).toBe(1);
  });

  it("rechaza un precio sugerido negativo", () => {
    expect(() => applyPricingRules(RULES, { fecha: "2026-06-06", rawSuggestedPrice: -1, esAltaDemanda: false })).toThrow(PricingRulesError);
  });

  it("rechaza fecha inválida", () => {
    expect(() => applyPricingRules(RULES, { fecha: "no-es-fecha", rawSuggestedPrice: 100, esAltaDemanda: false })).toThrow(/fecha_invalida/);
  });
});
