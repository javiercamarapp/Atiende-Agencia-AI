// Tests unitarios del motor ISR (Fase 2) — complementan el golden-set
// (declaraciones.golden.spec.ts) con casos de contrato de API, defaults y edge cases
// que no requieren el intérprete Python (comportamiento ya cubierto ahí).
import { describe, expect, it } from "vitest";
import { calcularIsrPf, calcularIsrPm, calcularIsrPmResico, aplicarTablaIsr } from "../src/declaraciones/isr-engine.ts";
import { ISR_MENSUAL_2026, ISR_PM_TASA } from "../src/declaraciones/isr-tablas.ts";

describe("aplicarTablaIsr", () => {
  it("devuelve 0 para base gravable = 0 sin tocar la tabla", () => {
    expect(aplicarTablaIsr(0, ISR_MENSUAL_2026)).toBe(0);
  });

  it("devuelve 0 para base gravable negativa (nunca ISR negativo)", () => {
    expect(aplicarTablaIsr(-100, ISR_MENSUAL_2026)).toBe(0);
  });

  it("clasifica por el límite inferior del tramo SIGUIENTE, no por el límite superior propio", () => {
    // Un valor igual al límite inferior de tramo 1 (844.60) debe caer en tramo 1, no
    // en tramo 0, aunque esté "cerca" del límite superior de tramo 0 (844.59).
    const r = aplicarTablaIsr(844.6, ISR_MENSUAL_2026);
    expect(r).toBe(16.22); // cuota fija exacta de tramo 1, excedente = 0
  });

  it("el excedente se calcula sobre el límite inferior de la tabla, nunca sobre el monto total", () => {
    // tramo 1: (844.60, ..., 16.22, 0.064). En 1000: excedente = 1000 - 844.60 = 155.40
    const r = aplicarTablaIsr(1000, ISR_MENSUAL_2026);
    expect(r).toBeCloseTo(16.22 + 155.4 * 0.064, 2);
    // Si el bug fuera "tasa marginal sobre el monto total", daría 1000*0.064=64, muy
    // distinto del resultado correcto (~26.17) — este assert falla si alguien
    // reintroduce ese bug.
    expect(r).not.toBeCloseTo(1000 * 0.064, 2);
  });

  it("el último tramo no tiene techo (sin `upper` que lo limite)", () => {
    const r = aplicarTablaIsr(50_000_000, ISR_MENSUAL_2026);
    expect(r).toBeGreaterThan(0);
    expect(Number.isFinite(r)).toBe(true);
  });
});

describe("calcularIsrPf", () => {
  it("default es tabla mensual (annual=false)", () => {
    const r = calcularIsrPf(10000);
    expect(r.tablaAplicada).toBe("monthly");
  });

  it("usa tabla anual cuando annual=true", () => {
    const r = calcularIsrPf(10000, { annual: true });
    expect(r.tablaAplicada).toBe("annual");
  });

  it("acepta una tabla explícita distinta al default (para no hardcodear el año fiscal a ciegas)", () => {
    const tablaCustom = [[0, Infinity, 0, 0.5]] as const;
    const r = calcularIsrPf(1000, { tabla: tablaCustom });
    expect(r.isrBruto).toBe(500);
  });

  it("isrNeto nunca es negativo pese a pagosProvisionales mayores al ISR bruto", () => {
    const r = calcularIsrPf(1000, { pagosProvisionales: 999999 });
    expect(r.isrNeto).toBe(0);
  });

  it("tasaEfectiva es 0 cuando la base gravable es 0", () => {
    const r = calcularIsrPf(0);
    expect(r.tasaEfectiva).toBe(0);
  });

  it("tipoContribuyente siempre es PF", () => {
    expect(calcularIsrPf(1000).tipoContribuyente).toBe("PF");
  });
});

describe("calcularIsrPm", () => {
  it("aplica la tasa fija del 30% (Art. 9 LISR)", () => {
    const r = calcularIsrPm(100000);
    expect(r.isrBruto).toBe(100000 * ISR_PM_TASA);
    expect(r.tasaEfectiva).toBe(ISR_PM_TASA);
    expect(r.tablaAplicada).toBe("pm_30%");
  });

  it("utilidad negativa produce ISR 0, no negativo", () => {
    const r = calcularIsrPm(-50000);
    expect(r.baseGravable).toBe(0);
    expect(r.isrBruto).toBe(0);
    expect(r.tasaEfectiva).toBe(0);
  });

  it("isrNeto = max(0, isrBruto - pagosProvisionales)", () => {
    const r = calcularIsrPm(100000, 10000);
    expect(r.isrNeto).toBe(20000);
  });

  it("tipoContribuyente siempre es PM", () => {
    expect(calcularIsrPm(1000).tipoContribuyente).toBe("PM");
  });
});

describe("calcularIsrPmResico", () => {
  it("aplica tasa PLANA de 30% sobre flujo de efectivo, NUNCA una tabla progresiva (hallazgo CRÍTICO #2)", () => {
    const r = calcularIsrPmResico(30000);
    expect(r.tablaAplicada).toBe("pm_resico");
    expect(r.isrBruto).toBe(9000); // 30000 * 0.30, no una tarifa por tramos
    expect(r.tasaEfectiva).toBe(0.3);
  });

  it("resta las deducciones autorizadas pagadas antes de aplicar la tasa (flujo de efectivo, Art. 208 LISR)", () => {
    const r = calcularIsrPmResico(100000, { deduccionesAutorizadas: 40000 });
    expect(r.baseGravable).toBe(60000);
    expect(r.isrBruto).toBe(18000); // (100000 - 40000) * 0.30
  });

  it("deducciones mayores al ingreso -> flujo de efectivo 0, ISR 0 (nunca negativo)", () => {
    const r = calcularIsrPmResico(10000, { deduccionesAutorizadas: 50000 });
    expect(r.baseGravable).toBe(0);
    expect(r.isrBruto).toBe(0);
  });

  it("ingreso negativo produce ISR 0", () => {
    const r = calcularIsrPmResico(-1000);
    expect(r.baseGravable).toBe(0);
    expect(r.isrBruto).toBe(0);
  });

  it("isrNeto = max(0, isrBruto - pagosProvisionales)", () => {
    const r = calcularIsrPmResico(100000, { pagosProvisionales: 20000 });
    expect(r.isrBruto).toBe(30000); // 100000 * 0.30
    expect(r.isrNeto).toBe(10000); // 30000 - 20000
  });
});
