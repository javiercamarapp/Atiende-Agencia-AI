import { describe, expect, it } from "vitest";
import {
  buildWalkForwardWindows,
  evaluateWalkForwardBacktest,
  type WindowEvaluation,
} from "../src/revenue/walkForwardBacktest.ts";

function seriesFrom(startIso: string, days: number): Array<{ date: string }> {
  const start = new Date(`${startIso}T00:00:00Z`);
  return Array.from({ length: days }, (_, i) => {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    return { date: d.toISOString().slice(0, 10) };
  });
}

describe("buildWalkForwardWindows", () => {
  it("serie vacía produce cero ventanas", () => {
    expect(buildWalkForwardWindows([], { trainDays: 30, testDays: 7, stepDays: 7 })).toEqual([]);
  });

  it("cada ventana de prueba usa solo datos ANTERIORES a sí misma (sin fuga de información)", () => {
    const series = seriesFrom("2026-01-01", 60);
    const windows = buildWalkForwardWindows(series, { trainDays: 30, testDays: 7, stepDays: 7 });
    expect(windows.length).toBeGreaterThan(0);
    for (const w of windows) {
      // trainEnd es estrictamente anterior a testStart -- nunca se solapan ni el
      // entrenamiento mira hacia adelante.
      expect(w.trainEnd < w.testStart).toBe(true);
      expect(w.trainStart <= w.trainEnd).toBe(true);
      expect(w.testStart <= w.testEnd).toBe(true);
    }
  });

  it("las ventanas nunca exceden el final de la serie", () => {
    const series = seriesFrom("2026-01-01", 45);
    const windows = buildWalkForwardWindows(series, { trainDays: 30, testDays: 7, stepDays: 7 });
    const seriesEnd = series[series.length - 1]!.date;
    for (const w of windows) {
      expect(w.testEnd <= seriesEnd).toBe(true);
    }
  });

  it("avanza exactamente stepDays entre el inicio de ventanas consecutivas", () => {
    const series = seriesFrom("2026-01-01", 90);
    const windows = buildWalkForwardWindows(series, { trainDays: 30, testDays: 7, stepDays: 7 });
    expect(windows.length).toBeGreaterThanOrEqual(2);
    const first = new Date(`${windows[0]!.trainStart}T00:00:00Z`).getTime();
    const second = new Date(`${windows[1]!.trainStart}T00:00:00Z`).getTime();
    expect((second - first) / (24 * 60 * 60 * 1000)).toBe(7);
  });

  it("rechaza spec con días no positivos", () => {
    const series = seriesFrom("2026-01-01", 10);
    expect(() => buildWalkForwardWindows(series, { trainDays: 0, testDays: 7, stepDays: 7 })).toThrow(RangeError);
    expect(() => buildWalkForwardWindows(series, { trainDays: 30, testDays: -1, stepDays: 7 })).toThrow(RangeError);
  });

  it("rechaza series no ordenadas o con duplicados", () => {
    expect(() =>
      buildWalkForwardWindows([{ date: "2026-01-02" }, { date: "2026-01-01" }], { trainDays: 1, testDays: 1, stepDays: 1 }),
    ).toThrow(RangeError);
    expect(() =>
      buildWalkForwardWindows([{ date: "2026-01-01" }, { date: "2026-01-01" }], { trainDays: 1, testDays: 1, stepDays: 1 }),
    ).toThrow(RangeError);
  });
});

function evalWindow(engineRevenue: number, baselineRevenue: number): WindowEvaluation {
  return {
    window: { trainStart: "2026-01-01", trainEnd: "2026-01-30", testStart: "2026-01-31", testEnd: "2026-02-06" },
    engineRevenue,
    baselineRevenue,
  };
}

describe("evaluateWalkForwardBacktest", () => {
  it("pasa cuando hay suficientes ventanas, mejora agregada y mayoría de ventanas ganadas", () => {
    const result = evaluateWalkForwardBacktest({
      evaluations: [evalWindow(1100, 1000), evalWindow(1200, 1000), evalWindow(1300, 1000), evalWindow(900, 1000)],
      counterfactualMethod: "misma_tarifa_periodo_anterior",
    });
    expect(result.passes).toBe(true);
    expect(result.failureReasons).toEqual([]);
    expect(result.windowsEvaluated).toBe(4);
    expect(result.windowsEngineWon).toBe(3);
    expect(result.windowWinRatio).toBeCloseTo(0.75);
    expect(result.improvementPct).toBeCloseTo(12.5);
  });

  it("falla por ventanas insuficientes (default mínimo 3)", () => {
    const result = evaluateWalkForwardBacktest({
      evaluations: [evalWindow(1100, 1000), evalWindow(1200, 1000)],
      counterfactualMethod: "misma_tarifa_periodo_anterior",
    });
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("ventanas_insuficientes:"))).toBe(true);
  });

  it("falla por no superar baseline (mejora negativa)", () => {
    const result = evaluateWalkForwardBacktest({
      evaluations: [evalWindow(800, 1000), evalWindow(900, 1000), evalWindow(950, 1000)],
      counterfactualMethod: "tarifa_estatica_pre_motor",
    });
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("no_supera_baseline:"))).toBe(true);
  });

  it("falla por baseline agregado <= 0 (no se puede medir una mejora)", () => {
    const result = evaluateWalkForwardBacktest({
      evaluations: [evalWindow(100, 0), evalWindow(100, 0), evalWindow(100, 0)],
      counterfactualMethod: "modelo_elasticidad_declarado",
    });
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("baseline_invalido:"))).toBe(true);
  });

  it("falla si la mayoría de ventanas individuales no gana, aunque el agregado mejore (outlier oculto)", () => {
    // Un solo outlier grande (5000 vs 1000) domina el agregado, pero el motor pierde
    // en 3 de 4 ventanas -- REQ-REV-003 exige que la mejora no sea un espejismo.
    const result = evaluateWalkForwardBacktest({
      evaluations: [evalWindow(5000, 1000), evalWindow(900, 1000), evalWindow(900, 1000), evalWindow(900, 1000)],
      counterfactualMethod: "misma_tarifa_periodo_anterior",
    });
    expect(result.improvementPct).toBeGreaterThan(0);
    expect(result.passes).toBe(false);
    expect(result.failureReasons.some((r) => r.startsWith("mayoria_de_ventanas_no_mejora:"))).toBe(true);
  });

  it("empate (engineRevenue === baselineRevenue) cuenta como ventana ganada", () => {
    const result = evaluateWalkForwardBacktest({
      evaluations: [evalWindow(1000, 1000), evalWindow(1000, 1000), evalWindow(1000, 1000)],
      counterfactualMethod: "misma_tarifa_periodo_anterior",
    });
    expect(result.windowsEngineWon).toBe(3);
    expect(result.windowWinRatio).toBe(1);
  });

  it("respeta minWindows/minImprovementPct/minWindowWinRatio configurables", () => {
    const result = evaluateWalkForwardBacktest({
      evaluations: [evalWindow(1000, 1000), evalWindow(1000, 1000)],
      counterfactualMethod: "misma_tarifa_periodo_anterior",
      minWindows: 2,
      minImprovementPct: 0,
      minWindowWinRatio: 1,
    });
    expect(result.passes).toBe(true);
  });

  it("es determinista: la misma entrada siempre produce la misma salida", () => {
    const input = {
      evaluations: [evalWindow(1100, 1000), evalWindow(1200, 1000), evalWindow(1300, 1000)],
      counterfactualMethod: "misma_tarifa_periodo_anterior" as const,
    };
    expect(evaluateWalkForwardBacktest(input)).toEqual(evaluateWalkForwardBacktest(input));
  });
});
