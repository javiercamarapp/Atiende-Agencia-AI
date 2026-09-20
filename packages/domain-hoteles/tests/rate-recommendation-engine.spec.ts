import { describe, expect, it } from "vitest";
import { RateRecommendationEngineError, computeRateRecommendation } from "../src/revenue/rateRecommendationEngine.ts";
import { DEFAULT_PRICING_RULES } from "../src/revenue/pricingRules.ts";
import type { PricingRules } from "../src/revenue/pricingRules.ts";
import type { PickupSignalResult } from "../src/revenue/pickupSignal.ts";

const RULES_SIN_MULTIPLICADOR: PricingRules = {
  ...DEFAULT_PRICING_RULES,
  dayOfWeekMultiplier: [1, 1, 1, 1, 1, 1, 1], // neutraliza el día de la semana para aislar las señales en los tests
};

function pickupNeutro(fecha: string): PickupSignalResult {
  return {
    fecha,
    leadTimeDays: 14,
    onTheBooksRoomsNow: 10,
    basis: "sin_historia_suficiente",
    sampleSize: 0,
    hasSufficientHistory: false,
    expectedOnTheBooksRooms: null,
    onTheBooksVsExpectedPct: 0,
    expectedWasZero: false,
    recommendation: "mantener",
  };
}

function pickupConSenal(fecha: string, pct: number): PickupSignalResult {
  return {
    fecha,
    leadTimeDays: 14,
    onTheBooksRoomsNow: 10,
    basis: "mismo_dia_semana",
    sampleSize: 4,
    hasSufficientHistory: true,
    expectedOnTheBooksRooms: 8,
    onTheBooksVsExpectedPct: pct,
    expectedWasZero: false,
    recommendation: pct > 0 ? "subir_tarifa" : "mantener",
  };
}

describe("computeRateRecommendation", () => {
  it("sin ninguna señal disponible: signalsStatus='sin_senales', explanation=null, precio = BAR + solo reglas", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-02-17", // martes ordinario, sin festivo/temporada
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupNeutro("2026-02-17"),
      localEvents: [],
      competitorRates: [],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    expect(r.signalsStatus).toBe("sin_senales");
    expect(r.explanation).toBeNull();
    expect(r.recommendedPrice).toBe(2000);
    expect(r.desglose.ajustes.totalPct).toBe(0);
  });

  it("señal de pickup fuerte por encima del histórico sube la tarifa recomendada", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-02-17",
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupConSenal("2026-02-17", 30), // +30% vs esperado
      localEvents: [],
      competitorRates: [],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    expect(r.signalsStatus).toBe("con_senales");
    expect(r.explanation).not.toBeNull();
    // ajustePickupPct = clamp(30 * 0.3, 15) = 9
    expect(r.desglose.ajustes.pickupPct).toBeCloseTo(9, 5);
    expect(r.recommendedPrice).toBeGreaterThan(2000);
    expect(r.explanation!.direction).toBe("sube");
  });

  it("clampea el ajuste de pickup al máximo configurado aunque la desviación sea enorme", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-02-17",
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupConSenal("2026-02-17", 500), // desviación absurda
      localEvents: [],
      competitorRates: [],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    expect(r.desglose.ajustes.pickupPct).toBe(15); // maxPickupAdjPct default
  });

  it("un festivo federal real (25-dic) dispara la señal de evento sin necesidad de evento local", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-12-25",
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupNeutro("2026-12-25"),
      localEvents: [],
      competitorRates: [],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    expect(r.desglose.evento).not.toBeNull();
    expect(r.desglose.evento!.fuente).toBe("federal_o_temporada");
    expect(r.desglose.ajustes.eventoPct).toBeGreaterThan(0);
    expect(r.suggestedMinStay).toBe(DEFAULT_PRICING_RULES.minStayOnHighDemand);
  });

  it("un evento local del staff con más magnitud que el federal gana (v1: no se suman)", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-12-25",
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupNeutro("2026-12-25"),
      localEvents: [{ nombre: "Congreso médico regional", fechaInicio: "2026-12-24", fechaFin: "2026-12-26", impacto: "alza_demanda", magnitudPct: 90 }],
      competitorRates: [],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    expect(r.desglose.evento!.nombre).toBe("Congreso médico regional");
    expect(r.desglose.evento!.fuente).toBe("local");
  });

  it("un evento local de baja demanda baja la tarifa", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-02-17",
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupNeutro("2026-02-17"),
      localEvents: [{ nombre: "Cierre de carretera de acceso", fechaInicio: "2026-02-17", fechaFin: "2026-02-17", impacto: "baja_demanda", magnitudPct: 20 }],
      competitorRates: [],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    expect(r.desglose.ajustes.eventoPct).toBeLessThan(0);
    expect(r.recommendedPrice).toBeLessThan(2000);
  });

  it("compset: jala la tarifa hacia la mediana de competidores capturados", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-02-17",
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupNeutro("2026-02-17"),
      localEvents: [],
      competitorRates: [
        { competidor: "Hotel A", tarifa: 2600 },
        { competidor: "Hotel B", tarifa: 2400 },
        { competidor: "Hotel C", tarifa: 2500 },
      ],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    // mediana = 2500, (2500-2000)/2000*100 = 25, * pullFactor 0.5 = 12.5
    expect(r.desglose.compset!.medianaCompetidores).toBe(2500);
    expect(r.desglose.ajustes.compsetPct).toBeCloseTo(12.5, 5);
    expect(r.recommendedPrice).toBeGreaterThan(2000);
  });

  it("sin captura de competidores no arma ningún factor de compset", () => {
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-02-17",
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupConSenal("2026-02-17", 20),
      localEvents: [],
      competitorRates: [],
      pricingRules: RULES_SIN_MULTIPLICADOR,
    });
    expect(r.desglose.compset).toBeNull();
    expect(r.explanation!.factors.some((f) => f.kind === "compset")).toBe(false);
  });

  it("respeta floor/ceiling del owner aunque las señales combinadas empujen más allá", () => {
    const rules: PricingRules = { ...RULES_SIN_MULTIPLICADOR, floorPrice: 0, ceilingPrice: 2100 };
    const r = computeRateRecommendation({
      propertyId: "p1",
      roomTypeId: "rt1",
      fecha: "2026-12-25", // festivo, +señal de evento
      currency: "MXN",
      currentBarPrice: 2000,
      pickup: pickupConSenal("2026-12-25", 40),
      localEvents: [],
      competitorRates: [{ competidor: "Hotel A", tarifa: 4000 }],
      pricingRules: rules,
    });
    expect(r.recommendedPrice).toBe(2100);
    expect(r.desglose.reglaAplicada.clampedByCeiling).toBe(true);
  });

  it("rechaza una tarifa BAR actual inválida", () => {
    expect(() =>
      computeRateRecommendation({
        propertyId: "p1",
        roomTypeId: "rt1",
        fecha: "2026-02-17",
        currency: "MXN",
        currentBarPrice: 0,
        pickup: pickupNeutro("2026-02-17"),
        localEvents: [],
        competitorRates: [],
        pricingRules: RULES_SIN_MULTIPLICADOR,
      }),
    ).toThrow(RateRecommendationEngineError);
  });

  it("rechaza una tarifa de competidor inválida", () => {
    expect(() =>
      computeRateRecommendation({
        propertyId: "p1",
        roomTypeId: "rt1",
        fecha: "2026-02-17",
        currency: "MXN",
        currentBarPrice: 2000,
        pickup: pickupNeutro("2026-02-17"),
        localEvents: [],
        competitorRates: [{ competidor: "Hotel X", tarifa: -1 }],
        pricingRules: RULES_SIN_MULTIPLICADOR,
      }),
    ).toThrow(/tarifa_competidor_invalida/);
  });
});
