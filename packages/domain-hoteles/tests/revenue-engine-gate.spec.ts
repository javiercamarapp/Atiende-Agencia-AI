import { describe, expect, it } from "vitest";
import {
  MIN_SHADOW_DAYS,
  PROPONE_VARIATION_PCT_MIN,
  PROPONE_VARIATION_PCT_MAX,
  RevenueGateError,
  daysElapsed,
  hasMetMinimumShadowPeriod,
  isPromotion,
  isDemotion,
  evaluateGateTransition,
  assertValidProponeVariationPct,
  isPriceChangeWithinProponeLimit,
  evaluateRevenueProposal,
} from "../src/revenue/revenueEngineGate.ts";
import type { WalkForwardBacktestResult } from "../src/revenue/walkForwardBacktest.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-01T00:00:00Z");

function daysAgo(days: number): Date {
  return new Date(NOW.getTime() - days * DAY_MS);
}

function passingBacktest(runAt: Date): { backtest: WalkForwardBacktestResult; backtestRanAt: Date } {
  return {
    backtest: {
      engineTotalRevenue: 1200,
      baselineTotalRevenue: 1000,
      improvementPct: 20,
      windowsEvaluated: 4,
      windowsEngineWon: 3,
      windowWinRatio: 0.75,
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      passes: true,
      failureReasons: [],
    },
    backtestRanAt: runAt,
  };
}

describe("daysElapsed / hasMetMinimumShadowPeriod", () => {
  it("nunca redondea hacia arriba: 89 días completos no son 90", () => {
    const since = daysAgo(89);
    expect(daysElapsed(since, NOW)).toBe(89);
    expect(hasMetMinimumShadowPeriod(since, NOW)).toBe(false);
  });

  it("exactamente 90 días completos sí cumple el mínimo", () => {
    const since = daysAgo(90);
    expect(daysElapsed(since, NOW)).toBe(90);
    expect(hasMetMinimumShadowPeriod(since, NOW)).toBe(true);
  });

  it("nunca es negativo aunque `since` sea posterior a `now`", () => {
    expect(daysElapsed(daysAgo(-10), NOW)).toBe(0);
  });
});

describe("isPromotion / isDemotion", () => {
  it("shadow->propone y propone->autopilot son promociones de exactamente un escalón", () => {
    expect(isPromotion("shadow", "propone")).toBe(true);
    expect(isPromotion("propone", "autopilot")).toBe(true);
  });

  it("shadow->autopilot NUNCA es una promoción válida (salto de dos escalones)", () => {
    expect(isPromotion("shadow", "autopilot")).toBe(false);
  });

  it("cualquier retroceso es una democión", () => {
    expect(isDemotion("autopilot", "shadow")).toBe(true);
    expect(isDemotion("autopilot", "propone")).toBe(true);
    expect(isDemotion("propone", "shadow")).toBe(true);
  });

  it("mismo estado no es ni promoción ni democión", () => {
    expect(isPromotion("propone", "propone")).toBe(false);
    expect(isDemotion("propone", "propone")).toBe(false);
  });
});

describe("evaluateGateTransition", () => {
  it("permite quedarse en el mismo gate sin ningún contexto", () => {
    expect(evaluateGateTransition("propone", "propone")).toEqual({ allowed: true, reasons: [] });
  });

  it("SIEMPRE permite una democión, sin importar el contexto (freno de emergencia)", () => {
    expect(evaluateGateTransition("autopilot", "shadow", {})).toEqual({ allowed: true, reasons: [] });
    expect(evaluateGateTransition("propone", "shadow")).toEqual({ allowed: true, reasons: [] });
  });

  it("bloquea shadow->autopilot directo con un código de razón estable", () => {
    const result = evaluateGateTransition("shadow", "autopilot", { now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/^transicion_no_permitida:/);
  });

  it("bloquea shadow->propone sin shadowStartedAt", () => {
    const result = evaluateGateTransition("shadow", "propone", { now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/^shadow_started_at_faltante:/);
  });

  it("bloquea shadow->propone con menos de 90 días", () => {
    const result = evaluateGateTransition("shadow", "propone", { shadowStartedAt: daysAgo(89), now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/^shadow_insuficiente:/);
    expect(result.reasons[0]).toContain("89");
  });

  it("permite shadow->propone con exactamente 90 días", () => {
    const result = evaluateGateTransition("shadow", "propone", { shadowStartedAt: daysAgo(90), now: NOW });
    expect(result).toEqual({ allowed: true, reasons: [] });
  });

  it("bloquea propone->autopilot sin backtest", () => {
    const result = evaluateGateTransition("propone", "autopilot", { now: NOW, ownerApprovalGranted: true });
    expect(result.allowed).toBe(false);
    expect(result.reasons).toContain(
      "backtest_faltante: no se proporcionó un backtest walk-forward (REQ-REV-003 lo exige antes de habilitar autopilot)",
    );
  });

  it("bloquea propone->autopilot con backtest que no pasa", () => {
    const failing: WalkForwardBacktestResult = {
      engineTotalRevenue: 900,
      baselineTotalRevenue: 1000,
      improvementPct: -10,
      windowsEvaluated: 4,
      windowsEngineWon: 1,
      windowWinRatio: 0.25,
      counterfactualMethod: "tarifa_estatica_pre_motor",
      passes: false,
      failureReasons: ["no_supera_baseline: ..."],
    };
    const result = evaluateGateTransition("propone", "autopilot", { now: NOW, backtest: failing, ownerApprovalGranted: true });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/^backtest_no_supera_baseline:/);
  });

  it("bloquea propone->autopilot con backtest anterior a proponeStartedAt (obsoleto)", () => {
    const { backtest } = passingBacktest(daysAgo(50));
    const result = evaluateGateTransition("propone", "autopilot", {
      now: NOW,
      proponeStartedAt: daysAgo(10),
      backtest,
      backtestRanAt: daysAgo(50),
      ownerApprovalGranted: true,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/^backtest_obsoleto:/);
  });

  it("bloquea propone->autopilot sin aprobación de owner, aunque el backtest pase", () => {
    const { backtest, backtestRanAt } = passingBacktest(daysAgo(5));
    const result = evaluateGateTransition("propone", "autopilot", {
      now: NOW,
      proponeStartedAt: daysAgo(10),
      backtest,
      backtestRanAt,
    });
    expect(result.allowed).toBe(false);
    expect(result.reasons[0]).toMatch(/^aprobacion_owner_requerida:/);
  });

  it("permite propone->autopilot con backtest vigente que pasa + aprobación de owner", () => {
    const { backtest, backtestRanAt } = passingBacktest(daysAgo(5));
    const result = evaluateGateTransition("propone", "autopilot", {
      now: NOW,
      proponeStartedAt: daysAgo(10),
      backtest,
      backtestRanAt,
      ownerApprovalGranted: true,
    });
    expect(result).toEqual({ allowed: true, reasons: [] });
  });

  it("acumula TODAS las razones de bloqueo simultáneas, no solo la primera", () => {
    const result = evaluateGateTransition("propone", "autopilot", { now: NOW });
    expect(result.allowed).toBe(false);
    expect(result.reasons.length).toBeGreaterThanOrEqual(2);
    expect(result.reasons.some((r) => r.startsWith("backtest_faltante:"))).toBe(true);
    expect(result.reasons.some((r) => r.startsWith("aprobacion_owner_requerida:"))).toBe(true);
  });
});

describe("assertValidProponeVariationPct", () => {
  it("acepta el borde inferior y superior de la banda [10, 15]", () => {
    expect(() => assertValidProponeVariationPct(PROPONE_VARIATION_PCT_MIN)).not.toThrow();
    expect(() => assertValidProponeVariationPct(PROPONE_VARIATION_PCT_MAX)).not.toThrow();
  });

  it("rechaza 0% (eso sería 'no propone nada')", () => {
    expect(() => assertValidProponeVariationPct(0)).toThrow(RevenueGateError);
  });

  it("rechaza >15%", () => {
    expect(() => assertValidProponeVariationPct(20)).toThrow(RevenueGateError);
  });

  it("rechaza NaN/Infinity", () => {
    expect(() => assertValidProponeVariationPct(Number.NaN)).toThrow(RevenueGateError);
    expect(() => assertValidProponeVariationPct(Number.POSITIVE_INFINITY)).toThrow(RevenueGateError);
  });
});

describe("isPriceChangeWithinProponeLimit", () => {
  it("un cambio de exactamente el límite cae DENTRO (tolerancia inclusiva)", () => {
    expect(isPriceChangeWithinProponeLimit(1000, 1150, 15)).toBe(true);
  });

  it("un cambio apenas por encima del límite cae fuera", () => {
    expect(isPriceChangeWithinProponeLimit(1000, 1151, 15)).toBe(false);
  });

  it("aplica el límite simétricamente a la baja", () => {
    expect(isPriceChangeWithinProponeLimit(1000, 850, 15)).toBe(true);
    expect(isPriceChangeWithinProponeLimit(1000, 849, 15)).toBe(false);
  });

  it("rechaza baseline <= 0", () => {
    expect(() => isPriceChangeWithinProponeLimit(0, 100, 15)).toThrow(RevenueGateError);
    expect(() => isPriceChangeWithinProponeLimit(-5, 100, 15)).toThrow(RevenueGateError);
  });

  it("rechaza precio propuesto negativo", () => {
    expect(() => isPriceChangeWithinProponeLimit(1000, -1, 15)).toThrow(RevenueGateError);
  });
});

describe("evaluateRevenueProposal", () => {
  const params = { baselinePrice: 1000, proposedPrice: 1100, maxVariationPct: 15 };

  it("shadow: NUNCA ejecuta, no requiere aprobación (no hay nada que aprobar)", () => {
    const result = evaluateRevenueProposal("shadow", params);
    expect(result.allowed).toBe(false);
    expect(result.requiresApproval).toBe(false);
    expect(result.reasons[0]).toMatch(/^modo_shadow:/);
  });

  it("propone: dentro del límite -> elegible pero SIEMPRE requiere aprobación humana", () => {
    const result = evaluateRevenueProposal("propone", params);
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(true);
    expect(result.withinVariationLimit).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("propone: fuera del límite -> no elegible", () => {
    const result = evaluateRevenueProposal("propone", { baselinePrice: 1000, proposedPrice: 1200, maxVariationPct: 15 });
    expect(result.allowed).toBe(false);
    expect(result.withinVariationLimit).toBe(false);
    expect(result.reasons[0]).toMatch(/^variacion_excede_limite:/);
  });

  it("autopilot: sin límite de variación ni aprobación individual", () => {
    const result = evaluateRevenueProposal("autopilot", { baselinePrice: 1000, proposedPrice: 5000, maxVariationPct: 15 });
    expect(result.allowed).toBe(true);
    expect(result.requiresApproval).toBe(false);
    expect(result.reasons).toEqual([]);
  });
});
