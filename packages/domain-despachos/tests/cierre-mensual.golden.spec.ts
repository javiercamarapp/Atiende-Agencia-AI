// Golden-set numérico (Fase 6 despachos, OBLIGATORIO) — compara byte a byte el
// output del motor Python REAL (`b2b_ai/features/close_management/
// validation_engine.py::ValidationEngine`, capturado en tests/fixtures/
// golden-cierre-mensual-output.json vía tests/fixtures/
// golden_gen_cierre_mensual.py, corrido contra `despachos/.venv/bin/python3`)
// contra el motor TS nuevo (`src/cierre-mensual/validaciones.ts`).
import { describe, expect, it } from "vitest";
import golden from "./fixtures/golden-cierre-mensual-output.json" with { type: "json" };
import { validateBalanceCuadrada, validateIvaConciliado, validateIsrProvisionado, validateNominaCuadrada, validateBancosConciliados, validatePolizasCuadradas } from "../src/cierre-mensual/validaciones.ts";

function sinWarnings(r: ReturnType<typeof validateBalanceCuadrada>) {
  return { type: r.type, passed: r.passed, message: r.message, details: r.details };
}

describe("golden: validateBalanceCuadrada", () => {
  it.each([
    ["ok", 100000.0, 100000.5, golden.balance_cuadrada_ok],
    ["fail", 1000.0, 1500.0, golden.balance_cuadrada_fail],
    ["límite exacto (diff == tolerancia -> pasa)", 1000.0, 1001.0, golden.balance_cuadrada_limite_exacto],
  ])("%s", (_n, debe, haber, esperado) => {
    expect(sinWarnings(validateBalanceCuadrada(debe, haber))).toEqual({ type: esperado.type, passed: esperado.passed, message: esperado.message, details: esperado.details });
  });
});

describe("golden: validateIvaConciliado", () => {
  it.each([
    ["ok", 50000.0, 30000.0, 20000.0, golden.iva_conciliado_ok],
    ["fail", 50000.0, 30000.0, 15000.0, golden.iva_conciliado_fail],
  ])("%s", (_n, trasladado, acreditable, provisionado, esperado) => {
    expect(sinWarnings(validateIvaConciliado(trasladado, acreditable, provisionado))).toEqual({ type: esperado.type, passed: esperado.passed, message: esperado.message, details: esperado.details });
  });
});

describe("golden: validateIsrProvisionado", () => {
  it("sin utilidad fiscal -> pasa siempre (regla fiscal, no bug)", () => {
    expect(sinWarnings(validateIsrProvisionado(0.0, -5000.0))).toEqual({ type: golden.isr_sin_utilidad.type, passed: golden.isr_sin_utilidad.passed, message: golden.isr_sin_utilidad.message, details: golden.isr_sin_utilidad.details });
  });
  it("provisionado correctamente", () => {
    expect(sinWarnings(validateIsrProvisionado(30000.0, 100000.0))).toEqual({ type: golden.isr_ok.type, passed: golden.isr_ok.passed, message: golden.isr_ok.message, details: golden.isr_ok.details });
  });
  it("provisión insuficiente (tolerancia = max(1%, $100))", () => {
    expect(sinWarnings(validateIsrProvisionado(10000.0, 100000.0))).toEqual({ type: golden.isr_fail.type, passed: golden.isr_fail.passed, message: golden.isr_fail.message, details: golden.isr_fail.details });
  });
});

describe("golden: validateNominaCuadrada", () => {
  it("cuadrada", () => {
    const r = validateNominaCuadrada([{ sueldoBruto: 10000.0, totalDeducciones: 2000.0, sueldoNeto: 8000.0 }]);
    expect({ type: r.type, passed: r.passed, message: r.message, details: r.details }).toEqual({ type: golden.nomina_cuadrada_ok.type, passed: golden.nomina_cuadrada_ok.passed, message: golden.nomina_cuadrada_ok.message, details: golden.nomina_cuadrada_ok.details });
  });
  it("desfase — mensaje reproduce str(float) de Python incluyendo el '.0'", () => {
    const r = validateNominaCuadrada([{ sueldoBruto: 10000.0, totalDeducciones: 2000.0, sueldoNeto: 7000.0 }]);
    expect({ type: r.type, passed: r.passed, message: r.message, details: r.details }).toEqual({ type: golden.nomina_cuadrada_fail.type, passed: golden.nomina_cuadrada_fail.passed, message: golden.nomina_cuadrada_fail.message, details: golden.nomina_cuadrada_fail.details });
  });
});

describe("golden: validatePolizasCuadradas", () => {
  it("cuadradas (tolerancia 0.01 por póliza)", () => {
    const r = validatePolizasCuadradas([
      { id: "p1", totalDebe: 100.0, totalHaber: 100.0 },
      { id: "p2", totalDebe: 50.0, totalHaber: 50.005 },
    ]);
    expect({ type: r.type, passed: r.passed, message: r.message, details: r.details }).toEqual({ type: golden.polizas_cuadradas_ok.type, passed: golden.polizas_cuadradas_ok.passed, message: golden.polizas_cuadradas_ok.message, details: golden.polizas_cuadradas_ok.details });
  });
  it("con desfase", () => {
    const r = validatePolizasCuadradas([{ id: "p1", totalDebe: 100.0, totalHaber: 90.0 }]);
    expect({ type: r.type, passed: r.passed, message: r.message, details: r.details }).toEqual({ type: golden.polizas_cuadradas_fail.type, passed: golden.polizas_cuadradas_fail.passed, message: golden.polizas_cuadradas_fail.message, details: golden.polizas_cuadradas_fail.details });
  });
});

describe("golden: validateBancosConciliados", () => {
  it.each([
    ["ok (fracción 0-1)", 0.95, 100, 95, golden.bancos_ok_fraccion],
    ["fail (fracción 0-1)", 0.5, 100, 50, golden.bancos_fail_fraccion],
  ])("%s", (_n, matchRate, total, matched, esperado) => {
    expect(sinWarnings(validateBancosConciliados(matchRate, 0.8, total, matched))).toEqual({ type: esperado.type, passed: esperado.passed, message: esperado.message, details: esperado.details });
  });
});
