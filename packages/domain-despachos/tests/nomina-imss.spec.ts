// Golden-set numérico: IMSS/INFONAVIT (Fase 3 despachos) — compara contra
// `_sbc_diario_topado`/`_calcular_imss_obrero`/`_calcular_imss_patronal`/
// `_calcular_infonavit` (nomina_completa/service.py), capturado en
// tests/fixtures/golden-nomina-output.json. 21 casos: 7 escenarios de SBC
// (mínimo, UMA exacta, tope exacto, tope-0.01, tope+1000, cero, negativo) ×
// 3 valores de dias_pagados (15/30/31).
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-nomina-output.json" with { type: "json" };
import { sbcDiarioTopado, calcularImssObrero, calcularImssPatronal, calcularInfonavit, UMA_DIARIA_2026, SBC_MAX_UMA } from "../src/nomina/imss-engine.ts";

type GoldenImss = {
  entrada: { salarioDiario: number; diasPagados: number };
  resultado: { sbcDiarioTopado: number; imssObrero: number; imssPatronal: number; infonavit: number };
};

const entries = Object.entries(golden).filter(([name]) => name.startsWith("imss_")) as [string, unknown][];

describe("golden-set numérico: IMSS/INFONAVIT (TS) vs nomina_completa/service.py (Python real)", () => {
  for (const [name, raw] of entries) {
    const { entrada, resultado } = raw as GoldenImss;
    it(`${name}: salarioDiario=${entrada.salarioDiario} dias=${entrada.diasPagados}`, () => {
      expect(sbcDiarioTopado(entrada.salarioDiario)).toBe(resultado.sbcDiarioTopado);
      expect(calcularImssObrero(entrada.salarioDiario, entrada.diasPagados)).toBeCloseTo(resultado.imssObrero, 9);
      expect(calcularImssPatronal(entrada.salarioDiario, entrada.diasPagados)).toBeCloseTo(resultado.imssPatronal, 9);
      expect(calcularInfonavit(entrada.salarioDiario, entrada.diasPagados)).toBeCloseTo(resultado.infonavit, 9);
    });
  }

  it("UMA diaria 2026 = round(UMA_MENSUAL_2026/30.4, 2) = 117.31 (LSS art. 28)", () => {
    expect(UMA_DIARIA_2026).toBe(117.31);
  });

  it("tope SBC = 25 × UMA diaria = 2932.75", () => {
    expect(UMA_DIARIA_2026 * SBC_MAX_UMA).toBe(2932.75);
  });

  it("sbcDiarioTopado topa un salario diario por encima del tope a 2932.75", () => {
    expect(sbcDiarioTopado(10000)).toBe(2932.75);
  });

  it("sbcDiarioTopado NO valida negativos (fidelidad: sin ValueError, a diferencia de services/payroll.py)", () => {
    expect(sbcDiarioTopado(-100)).toBe(-100);
    expect(calcularImssObrero(-100, 30)).toBeCloseTo(-37.5, 9);
  });

  it("infonavit es 5% del SBC×días, independiente del obrero/patronal", () => {
    const salarioDiario = 500;
    const dias = 30;
    expect(calcularInfonavit(salarioDiario, dias)).toBeCloseTo(500 * 30 * 0.05, 9);
  });
});
